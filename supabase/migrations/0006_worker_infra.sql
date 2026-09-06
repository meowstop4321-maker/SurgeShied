-- Worker + Ops Dashboard infrastructure.

-- Previously nothing populated `profiles` automatically — real signups and
-- the seed script both need this.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name)
  values (new.id, 'attendee', new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- One active registration per user per event (needed for simulation to be
-- meaningful, and a correctness gap in the original schema).
create unique index registrations_one_active_per_user
  on registrations (event_id, user_id) where status in ('pending', 'confirmed');

alter table notification_jobs add column last_error text;

-- Circuit Guardian: singleton row, flips on/off around Resend failures.
create table circuit_guardian_state (
  id integer primary key default 1 check (id = 1),
  state text not null check (state in ('closed', 'open', 'half_open')) default 'closed',
  reason text,
  opened_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into circuit_guardian_state (id) values (1);
alter table circuit_guardian_state enable row level security;
create policy "circuit_guardian: select all" on circuit_guardian_state for select using (auth.role() = 'authenticated');

create or replace function set_circuit_guardian_state(p_state text, p_reason text) returns void
language plpgsql as $$
declare
  v_prev text;
begin
  select state into v_prev from circuit_guardian_state where id = 1;
  update circuit_guardian_state
  set state = p_state, reason = p_reason, updated_at = now(),
      opened_at = case when p_state = 'open' then now() else opened_at end
  where id = 1;

  if v_prev is distinct from p_state then
    perform append_audit_log(null,
      case when p_state = 'open' then 'circuit_guardian_open' else 'circuit_guardian_close' end,
      'system', null, jsonb_build_object('reason', p_reason));
  end if;
end;
$$;

-- Worker health. Cloud Run can run multiple instances; any recent beat counts.
create table worker_heartbeats (
  worker_id text primary key,
  status text not null default 'healthy',
  last_beat_at timestamptz not null default now()
);
alter table worker_heartbeats enable row level security;
create policy "worker_heartbeats: select all" on worker_heartbeats for select using (auth.role() = 'authenticated');

create or replace function upsert_worker_heartbeat(p_worker_id text, p_status text) returns void
language sql as $$
  insert into worker_heartbeats (worker_id, status, last_beat_at)
  values (p_worker_id, p_status, now())
  on conflict (worker_id) do update set status = excluded.status, last_beat_at = now();
$$;

-- Demo flags for the Simulation Panel — lets "Trigger email failure" be
-- deterministic in a demo instead of depending on Resend actually failing.
create table demo_flags (
  id integer primary key default 1 check (id = 1),
  force_email_failure boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into demo_flags (id) values (1);
alter table demo_flags enable row level security;
create policy "demo_flags: select all" on demo_flags for select using (auth.role() = 'authenticated');

-- One aggregate call for the Operations Dashboard, refreshed on a timer.
-- security definer: this is read-only aggregate counts, not raw rows, so
-- bypassing per-row RLS here is an intentional, narrow tradeoff (documented
-- in PROJECT_STATE.md) rather than an oversight.
create or replace function get_ops_metrics(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'requests_per_sec', (select round(count(*)::numeric / 5, 2) from audit_logs where action = 'registration_attempt' and created_at > now() - interval '5 seconds'),
    'queue_length', (select count(*) from queue_entries where event_id = p_event_id and status = 'waiting'),
    'active_lanes', (select count(*) from seat_partitions where event_id = p_event_id and seats_taken > 0),
    'total_lanes', (select count(*) from seat_partitions where event_id = p_event_id),
    'surge_score', (select surge_score from system_status where event_id = p_event_id),
    'lite_mode', (select coalesce(lite_mode, false) from system_status where event_id = p_event_id),
    'notification_queued', (select count(*) from notification_jobs where status = 'queued'),
    'notification_retries', (select coalesce(sum(attempts), 0) from notification_jobs where status in ('queued', 'failed')),
    'dead_letter_count', (select count(*) from notification_jobs where status = 'dead_letter'),
    'circuit_state', (select state from circuit_guardian_state where id = 1),
    'worker_status', (select case when max(last_beat_at) > now() - interval '90 seconds' then 'healthy' else 'down' end from worker_heartbeats),
    'active_worker_count', (select count(*) from worker_heartbeats where last_beat_at > now() - interval '90 seconds')
  )::jsonb;
$$;
revoke all on function get_ops_metrics(uuid) from public;
grant execute on function get_ops_metrics(uuid) to authenticated;
