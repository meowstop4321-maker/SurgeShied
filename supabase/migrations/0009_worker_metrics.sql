-- Migration 0009: deterministic retry policy and worker metrics.
-- The job_queue is the worker execution source of truth. notification_jobs
-- remains the registration-facing notification record.

-- Three retries are allowed; the fourth failed attempt is terminal. Existing jobs are brought onto
-- the same policy without deleting their payload or failure history.
update public.job_queue
set max_attempts = 4
where max_attempts <> 4;

alter table public.job_queue
  alter column max_attempts set default 4;

create or replace function public.fail_job(
  p_job_id uuid,
  p_error text,
  p_retry_delay_seconds integer default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_delay_seconds integer;
begin
  select attempts, max_attempts into v_attempts, v_max_attempts
  from public.job_queue
  where id = p_job_id
  for update;

  if not found then
    return;
  end if;

  if v_attempts >= least(v_max_attempts, 4) then
    update public.job_queue
    set status = 'dead_letter',
        last_error = p_error,
        locked_by = null,
        locked_at = null,
        updated_at = now()
    where id = p_job_id;
    return;
  end if;

  -- First retry is immediate, then five and thirty seconds. The fourth
  -- failed attempt is moved to DLQ, preserving payload and failure reason.
  v_delay_seconds := case v_attempts
    when 1 then 0
    when 2 then 5
    else 30
  end;

  update public.job_queue
  set status = 'pending',
      last_error = p_error,
      locked_by = null,
      locked_at = null,
      scheduled_at = now() + (v_delay_seconds || ' seconds')::interval,
      updated_at = now()
  where id = p_job_id;
end;
$$;

create or replace function public.get_worker_metrics()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'queue_length', (select count(*) from public.job_queue where status = 'pending' and scheduled_at <= now()),
    'processing_rate', (select round(count(*)::numeric / 60, 2) from public.job_queue where status = 'completed' and completed_at > now() - interval '60 seconds'),
    'avg_latency_ms', coalesce((select round(avg(extract(epoch from (completed_at - created_at)) * 1000), 2) from public.job_queue where status = 'completed' and completed_at is not null and completed_at > now() - interval '60 minutes'), 0),
    'failed_jobs', (select count(*) from public.job_queue where status = 'dead_letter')
  )::jsonb;
$$;

grant execute on function public.get_worker_metrics() to service_role, authenticated;
