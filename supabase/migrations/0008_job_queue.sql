-- Migration 0008: Priority Job Queue & Worker Infrastructure
-- Implements job_queue with priority scheduling, atomic locking (SKIP LOCKED), and dead-letter queue.

create table if not exists public.job_queue (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  payload jsonb not null default '{}'::jsonb,
  priority integer not null default 5 check (priority between 1 and 10), -- 1=low, 5=normal, 8=high, 10=critical
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  locked_by text,
  locked_at timestamptz,
  scheduled_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Performance indices for priority queue fetching and worker scaling
create index if not exists idx_job_queue_fetch
  on public.job_queue (status, priority desc, scheduled_at asc)
  where status in ('pending', 'processing');

create index if not exists idx_job_queue_locked
  on public.job_queue (locked_by)
  where status = 'processing';

create index if not exists idx_job_queue_type_status
  on public.job_queue (job_type, status);

-- Enable RLS
alter table public.job_queue enable row level security;

create policy "job_queue: service_role full access" on public.job_queue
  for all to service_role using (true) with check (true);

create policy "job_queue: authenticated select" on public.job_queue
  for select to authenticated using (true);

-- Atomic job claiming using Postgres FOR UPDATE SKIP LOCKED
create or replace function public.claim_job_batch(
  p_worker_id text,
  p_batch_size integer default 1,
  p_job_types text[] default null,
  p_lock_duration_seconds integer default 60
) returns setof public.job_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_ids uuid[];
begin
  -- 1. Unlock stale processing jobs whose lock expired
  update public.job_queue
  set status = 'pending',
      locked_by = null,
      locked_at = null
  where status = 'processing'
    and locked_at < now() - (p_lock_duration_seconds || ' seconds')::interval;

  -- 2. Select and lock next highest priority pending jobs
  select array_agg(q.id) into v_job_ids
  from (
    select id
    from public.job_queue
    where status = 'pending'
      and scheduled_at <= now()
      and (p_job_types is null or job_type = any(p_job_types))
    order by priority desc, scheduled_at asc, created_at asc
    limit p_batch_size
    for update skip locked
  ) q;

  if v_job_ids is null or array_length(v_job_ids, 1) is null then
    return;
  end if;

  -- 3. Mark selected jobs as processing
  return query
  update public.job_queue
  set status = 'processing',
      locked_by = p_worker_id,
      locked_at = now(),
      attempts = attempts + 1,
      updated_at = now()
  where id = any(v_job_ids)
  returning *;
end;
$$;

-- Enqueue helper
create or replace function public.enqueue_job(
  p_job_type text,
  p_payload jsonb default '{}'::jsonb,
  p_priority integer default 5,
  p_scheduled_at timestamptz default now(),
  p_max_attempts integer default 5
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  insert into public.job_queue (
    job_type,
    payload,
    priority,
    scheduled_at,
    max_attempts
  ) values (
    p_job_type,
    p_payload,
    least(greatest(coalesce(p_priority, 5), 1), 10),
    coalesce(p_scheduled_at, now()),
    coalesce(p_max_attempts, 5)
  ) returning id into v_job_id;

  return v_job_id;
end;
$$;

-- Complete job helper
create or replace function public.complete_job(
  p_job_id uuid,
  p_result jsonb default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.job_queue
  set status = 'completed',
      locked_by = null,
      locked_at = null,
      completed_at = now(),
      updated_at = now(),
      payload = case when p_result is not null then payload || jsonb_build_object('result', p_result) else payload end
  where id = p_job_id;
end;
$$;

-- Fail job helper with exponential backoff & dead-letter transition
create or replace function public.fail_job(
  p_job_id uuid,
  p_error text,
  p_retry_delay_seconds integer default 10
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
begin
  select attempts, max_attempts into v_attempts, v_max_attempts
  from public.job_queue
  where id = p_job_id;

  if v_attempts >= v_max_attempts then
    update public.job_queue
    set status = 'dead_letter',
        last_error = p_error,
        locked_by = null,
        locked_at = null,
        updated_at = now()
    where id = p_job_id;
  else
    update public.job_queue
    set status = 'pending',
        last_error = p_error,
        locked_by = null,
        locked_at = null,
        scheduled_at = now() + (p_retry_delay_seconds || ' seconds')::interval,
        updated_at = now()
    where id = p_job_id;
  end if;
end;
$$;

-- Queue depth and metrics function for autoscaling
create or replace function public.get_job_queue_depth() returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'total_pending', (select count(*) from public.job_queue where status = 'pending' and scheduled_at <= now()),
    'total_processing', (select count(*) from public.job_queue where status = 'processing'),
    'critical_pending', (select count(*) from public.job_queue where status = 'pending' and priority >= 8 and scheduled_at <= now()),
    'normal_pending', (select count(*) from public.job_queue where status = 'pending' and priority between 4 and 7 and scheduled_at <= now()),
    'low_pending', (select count(*) from public.job_queue where status = 'pending' and priority < 4 and scheduled_at <= now()),
    'completed_count', (select count(*) from public.job_queue where status = 'completed'),
    'failed_count', (select count(*) from public.job_queue where status = 'failed'),
    'dead_letter_count', (select count(*) from public.job_queue where status = 'dead_letter'),
    'oldest_pending_age_seconds', coalesce((
      select extract(epoch from (now() - created_at))::integer
      from public.job_queue
      where status = 'pending'
      order by created_at asc
      limit 1
    ), 0)
  )::jsonb;
$$;

-- Permissions
grant all on public.job_queue to postgres, anon, authenticated, service_role;
grant execute on function public.claim_job_batch(text, integer, text[], integer) to postgres, anon, authenticated, service_role;
grant execute on function public.enqueue_job(text, jsonb, integer, timestamptz, integer) to postgres, anon, authenticated, service_role;
grant execute on function public.complete_job(uuid, jsonb) to postgres, anon, authenticated, service_role;
grant execute on function public.fail_job(uuid, text, integer) to postgres, anon, authenticated, service_role;
grant execute on function public.get_job_queue_depth() to postgres, anon, authenticated, service_role;
