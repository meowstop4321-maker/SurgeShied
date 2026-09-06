-- Migration 0012: Close the audit-trail gaps that made queue movement and
-- retry/DLQ transitions invisible.
--
-- Three real events were happening in the database with zero corresponding
-- audit_logs row, which is exactly why the frontend's Live Audit Log table
-- already ships an actionBadges entry for "queue_promoted" that nothing
-- ever produced, and why a drained queue looked like it "just disappeared"
-- with no explanation anywhere: promote_from_queue() never logged a
-- promotion, fail_job() never logged a retry-vs-DLQ transition, and
-- nothing ever explained why a queue went from N waiting to 0.

-- promote_from_queue: now logs the promotion itself, and — the direct fix
-- for "queue appears to disappear" — logs an explicit, human-readable
-- reason the moment a lane's waiting queue empties out.
create or replace function public.promote_from_queue(p_event_id uuid, p_lane_index integer)
returns public.registrations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.queue_entries%rowtype;
  v_registration public.registrations%rowtype;
  v_remaining integer;
begin
  select * into v_entry
  from public.queue_entries
  where event_id = p_event_id and lane_index = p_lane_index and status = 'waiting'
  order by created_at asc
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  begin
    v_registration := public.allocate_seat(p_event_id, p_lane_index, v_entry.user_id, gen_random_uuid()::text, true);
  exception when others then
    return null;
  end;

  update public.queue_entries
  set status = 'promoted', promoted_at = now()
  where id = v_entry.id;

  perform public.append_audit_log(v_entry.user_id, 'queue_promoted', 'registration', v_registration.id,
    jsonb_build_object('event_id', p_event_id, 'lane_index', p_lane_index));

  select count(*) into v_remaining
  from public.queue_entries where event_id = p_event_id and status = 'waiting';
  if v_remaining = 0 then
    perform public.append_audit_log(null, 'queue_drained', 'event', p_event_id,
      jsonb_build_object('reason', 'last waiting attendee was promoted', 'lane_index', p_lane_index));
  end if;

  return v_registration;
end;
$$;

-- fail_job: now logs which of the two outcomes happened — a scheduled
-- retry (visible as an orange "Retry" line) or a final move to the Dead
-- Letter Queue (visible as a red "Error" line) — instead of both being a
-- silent UPDATE only ever visible by polling job_queue directly.
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
  v_job_type text;
begin
  select attempts, max_attempts, job_type into v_attempts, v_max_attempts, v_job_type
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

    perform public.append_audit_log(null, 'job_dead_lettered', 'job_queue', p_job_id,
      jsonb_build_object('job_type', v_job_type, 'attempts', v_attempts, 'error', p_error));
  else
    update public.job_queue
    set status = 'pending',
        last_error = p_error,
        locked_by = null,
        locked_at = null,
        scheduled_at = now() + (p_retry_delay_seconds || ' seconds')::interval,
        updated_at = now()
    where id = p_job_id;

    perform public.append_audit_log(null, 'job_retry_scheduled', 'job_queue', p_job_id,
      jsonb_build_object('job_type', v_job_type, 'attempt', v_attempts + 1, 'max_attempts', v_max_attempts,
        'retry_in_seconds', p_retry_delay_seconds, 'error', p_error));
  end if;
end;
$$;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
