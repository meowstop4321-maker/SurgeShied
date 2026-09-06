-- Migration 0011: Real observability — request latency/outcome tracking,
-- worker process telemetry, alerting, and a Dead Letter Queue reprocess path.
--
-- Design constraint driving every choice below: the frontend has no way to
-- reach the worker process directly (no VITE_WORKER_URL ever existed, no
-- CORS on the worker's Express app, and the worker may not even be
-- deployed for a given demo). So every metric on the Operations Dashboard
-- is read from Postgres — the worker PUSHES its own telemetry into a table
-- on its existing 20s heartbeat instead of the browser pulling it over a
-- second, separate, possibly-unreachable origin. This also means the
-- dashboard degrades honestly (fields go null / "no data") rather than
-- silently failing when the worker isn't running, exactly like
-- worker_status already does.

-- 1. Per-request outcome + latency, written by surge-router on every call.
create table if not exists public.request_metrics (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  user_id uuid,
  outcome text not null, -- confirmed | queued | already_registered | rate_limited | closed | error
  status_code integer not null,
  latency_ms integer not null,
  created_at timestamptz not null default now()
);
create index if not exists request_metrics_event_time_idx on public.request_metrics (event_id, created_at desc);
create index if not exists request_metrics_time_idx on public.request_metrics (created_at desc);

alter table public.request_metrics enable row level security;
drop policy if exists "request_metrics: select all" on public.request_metrics;
create policy "request_metrics: select all" on public.request_metrics for select using (auth.role() = 'authenticated');
drop policy if exists "request_metrics: service_role manage" on public.request_metrics;
create policy "request_metrics: service_role manage" on public.request_metrics for all to service_role using (true) with check (true);

create or replace function public.log_request_metric(
  p_event_id uuid,
  p_user_id uuid,
  p_outcome text,
  p_status_code integer,
  p_latency_ms integer
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.request_metrics (event_id, user_id, outcome, status_code, latency_ms)
  values (p_event_id, p_user_id, p_outcome, p_status_code, p_latency_ms);
$$;

-- Keep this table from growing unbounded across a long demo session.
create or replace function public.prune_request_metrics(p_older_than_minutes integer default 60)
returns integer
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.request_metrics
    where created_at < now() - (p_older_than_minutes || ' minutes')::interval
    returning 1
  )
  select count(*)::integer from deleted;
$$;

-- 2. Worker process telemetry (real: process.cpuUsage()/memoryUsage() from
-- worker/index.js's own Node process — not a stand-in for cluster-wide
-- infrastructure metrics, which don't exist because no real Cloud
-- Run/AWS deployment has been run yet — see PROJECT_STATE.md).
alter table public.worker_heartbeats
  add column if not exists cpu_percent numeric,
  add column if not exists memory_used_mb numeric,
  add column if not exists memory_total_mb numeric,
  add column if not exists active_workers integer,
  add column if not exists min_workers integer,
  add column if not exists max_workers integer;

create or replace function public.upsert_worker_heartbeat(
  p_worker_id text,
  p_status text,
  p_cpu_percent numeric default null,
  p_memory_used_mb numeric default null,
  p_memory_total_mb numeric default null,
  p_active_workers integer default null,
  p_min_workers integer default null,
  p_max_workers integer default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.worker_heartbeats (
    worker_id, status, last_beat_at, cpu_percent, memory_used_mb, memory_total_mb,
    active_workers, min_workers, max_workers
  )
  values (
    p_worker_id, p_status, now(), p_cpu_percent, p_memory_used_mb, p_memory_total_mb,
    p_active_workers, p_min_workers, p_max_workers
  )
  on conflict (worker_id) do update
    set status = excluded.status,
        last_beat_at = now(),
        cpu_percent = coalesce(excluded.cpu_percent, public.worker_heartbeats.cpu_percent),
        memory_used_mb = coalesce(excluded.memory_used_mb, public.worker_heartbeats.memory_used_mb),
        memory_total_mb = coalesce(excluded.memory_total_mb, public.worker_heartbeats.memory_total_mb),
        active_workers = coalesce(excluded.active_workers, public.worker_heartbeats.active_workers),
        min_workers = coalesce(excluded.min_workers, public.worker_heartbeats.min_workers),
        max_workers = coalesce(excluded.max_workers, public.worker_heartbeats.max_workers);
$$;

-- 3. get_ops_metrics: extended, additive-only (every field the dashboard
-- already reads keeps working; new fields are added alongside).
create or replace function public.get_ops_metrics(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
  v_avg_latency numeric;
  v_p95_latency numeric;
  v_p99_latency numeric;
  v_active_users integer;
  v_successful_registrations integer;
  v_failed_registrations integer;
  v_queue_processing_rate numeric;
  v_seats_remaining integer;
  v_hb record;
  v_last_scale record;
  v_autoscaling_status text;
begin
  select
    coalesce(avg(latency_ms), 0),
    coalesce(percentile_cont(0.95) within group (order by latency_ms), 0),
    coalesce(percentile_cont(0.99) within group (order by latency_ms), 0)
    into v_avg_latency, v_p95_latency, v_p99_latency
  from public.request_metrics
  where event_id = p_event_id and created_at > now() - interval '5 minutes';

  select count(distinct user_id) into v_active_users
  from public.request_metrics
  where event_id = p_event_id and user_id is not null and created_at > now() - interval '60 seconds';

  select count(*) into v_successful_registrations
  from public.registrations where event_id = p_event_id and status = 'confirmed';

  select count(*) into v_failed_registrations
  from public.request_metrics
  where event_id = p_event_id and outcome in ('error', 'rate_limited');

  select count(*)::numeric into v_queue_processing_rate
  from public.queue_entries
  where event_id = p_event_id and status = 'promoted' and promoted_at > now() - interval '60 seconds';

  select coalesce(sum(capacity), 0) - coalesce(sum(seats_taken), 0) into v_seats_remaining
  from public.seat_partitions where event_id = p_event_id;

  select * into v_hb from public.worker_heartbeats
  where last_beat_at > now() - interval '90 seconds'
  order by last_beat_at desc limit 1;

  select action, created_at into v_last_scale
  from public.audit_logs
  where action in ('worker_scaled_up', 'worker_scaled_down', 'lane_split', 'lane_merge')
  order by created_at desc limit 1;

  v_autoscaling_status := case
    when v_last_scale.action is null then 'stable'
    when v_last_scale.created_at < now() - interval '20 seconds' then 'stable'
    when v_last_scale.action in ('worker_scaled_up', 'lane_split') then 'scaling_up'
    else 'scaling_down'
  end;

  v_result := json_build_object(
    'requests_per_sec', (select round(count(*)::numeric / 5, 2) from public.audit_logs where action = 'registration_attempt' and created_at > now() - interval '5 seconds'),
    'queue_length', (select count(*) from public.queue_entries where event_id = p_event_id and status = 'waiting'),
    'active_lanes', (select count(*) from public.seat_partitions where event_id = p_event_id and seats_taken > 0),
    'total_lanes', (select count(*) from public.seat_partitions where event_id = p_event_id),
    'surge_score', (select surge_score from public.system_status where event_id = p_event_id),
    'lite_mode', (select coalesce(lite_mode, false) from public.system_status where event_id = p_event_id),
    'notification_queued', (select count(*) from public.notification_jobs where status = 'queued'),
    'notification_retries', (select coalesce(sum(attempts), 0) from public.notification_jobs where status in ('queued', 'failed')),
    'dead_letter_count', (select count(*) from public.job_queue where status = 'dead_letter'),
    'circuit_state', (select state from public.circuit_guardian_state where id = 1),
    'worker_status', (select case when max(last_beat_at) > now() - interval '90 seconds' then 'healthy' else 'down' end from public.worker_heartbeats),
    'active_worker_count', (select count(*) from public.worker_heartbeats where last_beat_at > now() - interval '90 seconds'),

    -- newly added, real, for the dashboard's full metric-card set:
    'active_users', coalesce(v_active_users, 0),
    'successful_registrations', coalesce(v_successful_registrations, 0),
    'failed_registrations', coalesce(v_failed_registrations, 0),
    'queue_processing_rate_per_min', coalesce(v_queue_processing_rate, 0),
    'pending_jobs', (select coalesce((public.get_job_queue_depth()->>'total_pending')::integer, 0)),
    'retry_count', (select count(*) from public.job_queue where attempts > 1),
    'avg_response_time_ms', round(v_avg_latency, 1),
    'p95_latency_ms', round(v_p95_latency, 1),
    'p99_latency_ms', round(v_p99_latency, 1),
    'seats_remaining', coalesce(v_seats_remaining, 0),
    'cpu_percent', v_hb.cpu_percent,
    'memory_used_mb', v_hb.memory_used_mb,
    'memory_total_mb', v_hb.memory_total_mb,
    'active_instances', v_hb.active_workers,
    'min_instances', v_hb.min_workers,
    'max_instances', v_hb.max_workers,
    'autoscaling_status', v_autoscaling_status,
    'autoscaling_note', 'active_instances is WorkerManager''s in-process async worker pool (real), not a cloud provider''s container count — no live Cloud Run/AWS deployment exists for this project yet.'
  );

  return v_result;
end;
$$;
revoke all on function public.get_ops_metrics(uuid) from public;
grant execute on function public.get_ops_metrics(uuid) to authenticated;
grant execute on function public.log_request_metric(uuid, uuid, text, integer, integer) to postgres, authenticated, service_role;
grant execute on function public.prune_request_metrics(integer) to postgres, service_role;
grant execute on function public.upsert_worker_heartbeat(text, text, numeric, numeric, numeric, integer, integer, integer) to postgres, service_role;

-- 4. Real alert evaluation, server-side, so the dashboard's alert banners
-- are backed by actual thresholds against actual data, not client-side
-- guesswork duplicated per component.
create or replace function public.get_active_alerts(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_alerts jsonb := '[]'::jsonb;
  v_p95 numeric;
  v_queue_len integer;
  v_error_rate numeric;
  v_total_recent integer;
  v_error_recent integer;
  v_worker_status text;
  v_dlq_count integer;
  v_dlq_growth integer;
  v_cpu numeric;
begin
  select coalesce(percentile_cont(0.95) within group (order by latency_ms), 0) into v_p95
  from public.request_metrics where event_id = p_event_id and created_at > now() - interval '2 minutes';
  if v_p95 > 3000 then
    v_alerts := v_alerts || jsonb_build_object('severity', 'warning', 'code', 'high_latency',
      'message', format('P95 latency is %s ms over the last 2 minutes (threshold 3000ms)', round(v_p95)));
  end if;

  select count(*) into v_queue_len from public.queue_entries where event_id = p_event_id and status = 'waiting';
  if v_queue_len > 20 then
    v_alerts := v_alerts || jsonb_build_object('severity', 'warning', 'code', 'queue_too_long',
      'message', format('%s attendees are waiting in queue', v_queue_len));
  end if;

  select count(*) into v_total_recent from public.request_metrics where event_id = p_event_id and created_at > now() - interval '2 minutes';
  select count(*) into v_error_recent from public.request_metrics where event_id = p_event_id and outcome = 'error' and created_at > now() - interval '2 minutes';
  v_error_rate := case when v_total_recent > 0 then v_error_recent::numeric / v_total_recent else 0 end;
  if v_total_recent >= 10 and v_error_rate > 0.05 then
    v_alerts := v_alerts || jsonb_build_object('severity', 'critical', 'code', 'high_error_rate',
      'message', format('Error rate is %s%% over the last 2 minutes (%s of %s requests)', round(v_error_rate * 100), v_error_recent, v_total_recent));
  end if;

  select case when max(last_beat_at) > now() - interval '90 seconds' then 'healthy' else 'down' end into v_worker_status
  from public.worker_heartbeats;
  if v_worker_status = 'down' or v_worker_status is null then
    v_alerts := v_alerts || jsonb_build_object('severity', 'critical', 'code', 'worker_offline',
      'message', 'No worker heartbeat in the last 90 seconds — notifications and Ghost Seat Recovery are not running');
  end if;

  select count(*) into v_dlq_count from public.job_queue where status = 'dead_letter';
  select count(*) into v_dlq_growth from public.job_queue where status = 'dead_letter' and updated_at > now() - interval '2 minutes';
  if v_dlq_growth >= 3 then
    v_alerts := v_alerts || jsonb_build_object('severity', 'warning', 'code', 'dlq_growing',
      'message', format('%s jobs moved to the Dead Letter Queue in the last 2 minutes (%s total)', v_dlq_growth, v_dlq_count));
  end if;

  select cpu_percent into v_cpu from public.worker_heartbeats
  where last_beat_at > now() - interval '90 seconds' order by last_beat_at desc limit 1;
  if v_cpu is not null and v_cpu > 85 then
    v_alerts := v_alerts || jsonb_build_object('severity', 'warning', 'code', 'high_cpu',
      'message', format('Worker process CPU at %s%%', round(v_cpu)));
  end if;

  return v_alerts;
end;
$$;
grant execute on function public.get_active_alerts(uuid) to postgres, authenticated, service_role;

-- 5. Dead Letter Queue: list + manual reprocess.
create or replace function public.get_dead_letter_jobs(p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(j)), '[]'::jsonb) from (
    select id, job_type, payload, priority, attempts, max_attempts, last_error, created_at, updated_at
    from public.job_queue
    where status = 'dead_letter'
    order by updated_at desc
    limit p_limit
  ) j;
$$;
grant execute on function public.get_dead_letter_jobs(integer) to postgres, authenticated, service_role;

-- Puts a dead-lettered job back to pending with a fresh attempt budget.
-- Logged to the audit chain so a manual reprocess is itself a visible,
-- traceable operator action, not a silent database edit.
create or replace function public.reprocess_dead_letter_job(p_job_id uuid) returns public.job_queue
language plpgsql security definer set search_path = public as $$
declare
  v_job public.job_queue%rowtype;
begin
  update public.job_queue
  set status = 'pending',
      attempts = 0,
      last_error = null,
      locked_by = null,
      locked_at = null,
      scheduled_at = now(),
      updated_at = now()
  where id = p_job_id and status = 'dead_letter'
  returning * into v_job;

  if v_job.id is not null then
    perform public.append_audit_log(auth.uid(), 'dlq_reprocessed', 'job_queue', v_job.id,
      jsonb_build_object('job_type', v_job.job_type));
  end if;

  return v_job;
end;
$$;
grant execute on function public.reprocess_dead_letter_job(uuid) to postgres, authenticated, service_role;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
