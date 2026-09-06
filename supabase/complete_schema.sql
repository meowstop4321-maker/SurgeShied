-- SurgeShield core schema
-- Overbooking is prevented at the DB layer via row-locked partition counters,
-- never by an app-level read-then-write check.

create extension if not exists "pgcrypto";

-- 1. Profiles (extends Supabase auth.users)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('organizer', 'attendee')) default 'attendee',
  full_name text,
  created_at timestamptz not null default now()
);

-- 2. Events
create table events (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  description text,
  capacity integer not null check (capacity > 0),
  lane_count integer not null default 4 check (lane_count between 1 and 16),
  starts_at timestamptz not null,
  location text,
  created_at timestamptz not null default now()
);

-- 3. Seat partitions — one row per (event, lane). This row is the lock target.
create table seat_partitions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  lane_index integer not null,
  capacity integer not null check (capacity >= 0),
  seats_taken integer not null default 0 check (seats_taken >= 0),
  unique (event_id, lane_index),
  constraint seats_within_capacity check (seats_taken <= capacity)
);

-- 4. Registrations
create table registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  lane_index integer not null,
  status text not null check (status in ('pending', 'confirmed', 'cancelled', 'expired')) default 'pending',
  seat_passport_token text unique,
  seat_passport_expires_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index registrations_event_status_idx on registrations(event_id, status);
create index registrations_expiry_idx on registrations(seat_passport_expires_at) where status = 'pending';

-- 5. Idempotency keys — dedupe registration requests from double-clicks/retries
create table idempotency_keys (
  key text primary key,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now()
);

-- 6. Notification jobs — self-healing notification pipeline state
create table notification_jobs (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  job_type text not null default 'confirmation_email',
  status text not null check (status in ('queued', 'sent', 'failed', 'dead_letter')) default 'queued',
  attempts integer not null default 0,
  next_retry_at timestamptz,
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 7. Audit log
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id),
  action text not null,
  entity text not null,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Core overbooking-safe seat allocation.
-- Call inside a transaction. Locks the target partition row, so concurrent
-- callers for the same lane serialize; different lanes proceed in parallel.
create or replace function allocate_seat(
  p_event_id uuid,
  p_lane_index integer,
  p_user_id uuid,
  p_idempotency_key text
) returns registrations
language plpgsql
as $$
declare
  v_partition seat_partitions%rowtype;
  v_registration registrations%rowtype;
begin
  select * into v_partition
  from seat_partitions
  where event_id = p_event_id and lane_index = p_lane_index
  for update;

  if not found then
    raise exception 'lane % not found for event %', p_lane_index, p_event_id;
  end if;

  if v_partition.seats_taken >= v_partition.capacity then
    raise exception 'lane_full' using errcode = 'P0001';
  end if;

  update seat_partitions
  set seats_taken = seats_taken + 1
  where id = v_partition.id;

  insert into registrations (event_id, user_id, lane_index, status, idempotency_key)
  values (p_event_id, p_user_id, p_lane_index, 'pending', p_idempotency_key)
  returning * into v_registration;

  return v_registration;
end;
$$;

-- Ghost Seat Recovery: release expired pending reservations back to their lane.
-- Intended to run on a schedule (pg_cron or worker sweep).
create or replace function release_expired_seats() returns integer
language plpgsql
as $$
declare
  v_count integer := 0;
  v_row registrations%rowtype;
begin
  for v_row in
    select * from registrations
    where status = 'pending' and seat_passport_expires_at < now()
    for update skip locked
  loop
    update seat_partitions
    set seats_taken = seats_taken - 1
    where event_id = v_row.event_id and lane_index = v_row.lane_index;

    update registrations
    set status = 'expired'
    where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
-- Row Level Security. Default posture: deny all, then open narrow reads.
-- Writes to registrations/seat_partitions/notification_jobs/idempotency_keys/
-- audit_logs/queue_entries go ONLY through the service-role Edge Function
-- (Surge Router), never directly from the client. This is what makes the
-- allocate_seat() row-lock guarantee actually hold — a client can't bypass
-- it with a raw insert.

alter table profiles enable row level security;
alter table events enable row level security;
alter table seat_partitions enable row level security;
alter table registrations enable row level security;
alter table idempotency_keys enable row level security;
alter table notification_jobs enable row level security;
alter table audit_logs enable row level security;

create or replace function is_organizer(p_user_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from profiles where id = p_user_id and role = 'organizer');
$$;

-- profiles
create policy "profiles: select own" on profiles for select using (auth.uid() = id);
create policy "profiles: update own" on profiles for update using (auth.uid() = id);
create policy "profiles: insert own" on profiles for insert with check (auth.uid() = id);

-- events: anyone authenticated can read; only the owning organizer writes
create policy "events: select all" on events for select using (auth.role() = 'authenticated');
create policy "events: insert own" on events for insert with check (auth.uid() = organizer_id and is_organizer(auth.uid()));
create policy "events: update own" on events for update using (auth.uid() = organizer_id);
create policy "events: delete own" on events for delete using (auth.uid() = organizer_id);

-- seat_partitions: public read (live seat counter), no client writes at all
create policy "seat_partitions: select all" on seat_partitions for select using (auth.role() = 'authenticated');

-- registrations: users see their own; organizers see registrations for their events. No client insert/update.
create policy "registrations: select own" on registrations for select using (auth.uid() = user_id);
create policy "registrations: select organizer" on registrations for select using (
  exists (select 1 from events e where e.id = registrations.event_id and e.organizer_id = auth.uid())
);

-- idempotency_keys, notification_jobs, audit_logs: service role only (no policies = no client access)

-- audit_logs: organizers can read logs tied to their own events
create policy "audit_logs: select organizer" on audit_logs for select using (
  exists (
    select 1 from events e
    where e.id = audit_logs.entity_id and e.organizer_id = auth.uid() and audit_logs.entity = 'event'
  )
);
-- Parallel Waiting Queue: one FIFO per lane. A queue entry only exists while
-- its lane is full. When release_expired_seats() frees a seat, it promotes
-- the oldest waiting entry in that lane.

create table queue_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  lane_index integer not null,
  status text not null check (status in ('waiting', 'promoted', 'expired', 'cancelled')) default 'waiting',
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  unique (event_id, lane_index, user_id, status) deferrable initially immediate
);
create index queue_wait_order_idx on queue_entries(event_id, lane_index, created_at) where status = 'waiting';

alter table queue_entries enable row level security;
create policy "queue: select own" on queue_entries for select using (auth.uid() = user_id);

-- Position within a lane's FIFO (1 = next to be promoted).
create or replace function queue_position(p_event_id uuid, p_lane_index integer, p_user_id uuid)
returns integer language sql stable as $$
  select count(*)::integer + 1
  from queue_entries q
  where q.event_id = p_event_id
    and q.lane_index = p_lane_index
    and q.status = 'waiting'
    and q.created_at < (
      select created_at from queue_entries
      where event_id = p_event_id and lane_index = p_lane_index and user_id = p_user_id and status = 'waiting'
      order by created_at desc limit 1
    );
$$;

-- Pop the oldest waiting entry for a lane and try to seat them.
-- Safe to call whenever a seat in that lane frees up. No-op if queue is empty
-- or the seat gets taken by a concurrent caller first (allocate_seat's own
-- lock handles that race; this function just doesn't error on lane_full).
create or replace function promote_from_queue(p_event_id uuid, p_lane_index integer)
returns registrations
language plpgsql as $$
declare
  v_entry queue_entries%rowtype;
  v_registration registrations%rowtype;
begin
  select * into v_entry
  from queue_entries
  where event_id = p_event_id and lane_index = p_lane_index and status = 'waiting'
  order by created_at asc
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  begin
    v_registration := allocate_seat(p_event_id, p_lane_index, v_entry.user_id, gen_random_uuid()::text);
  exception when others then
    -- lane filled again before we got to it; leave entry as 'waiting' for the next trigger
    return null;
  end;

  update queue_entries set status = 'promoted', promoted_at = now() where id = v_entry.id;
  return v_registration;
end;
$$;

-- release_expired_seats() now also promotes the queue for every lane it frees.
create or replace function release_expired_seats() returns integer
language plpgsql as $$
declare
  v_count integer := 0;
  v_row registrations%rowtype;
begin
  for v_row in
    select * from registrations
    where status = 'pending' and seat_passport_expires_at < now()
    for update skip locked
  loop
    update seat_partitions
    set seats_taken = seats_taken - 1
    where event_id = v_row.event_id and lane_index = v_row.lane_index;

    update registrations set status = 'expired' where id = v_row.id;

    perform promote_from_queue(v_row.event_id, v_row.lane_index);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
alter table events add column registration_open boolean not null default true;

-- Global-ish system status, keyed by event, that the frontend subscribes to
-- via Supabase Realtime to render the Lite Mode banner instantly.
create table system_status (
  event_id uuid primary key references events(id) on delete cascade,
  lite_mode boolean not null default false,
  reason text,
  surge_score numeric,
  updated_at timestamptz not null default now()
);
alter table system_status enable row level security;
create policy "system_status: select all" on system_status for select using (auth.role() = 'authenticated');

create or replace function set_system_status(p_event_id uuid, p_lite_mode boolean, p_reason text, p_surge_score numeric)
returns void language sql as $$
  insert into system_status (event_id, lite_mode, reason, surge_score, updated_at)
  values (p_event_id, p_lite_mode, p_reason, p_surge_score, now())
  on conflict (event_id) do update
    set lite_mode = excluded.lite_mode,
        reason = excluded.reason,
        surge_score = excluded.surge_score,
        updated_at = now();
$$;
-- Tamper-Evident Audit Chain. Reuses audit_logs — no new table, no
-- blockchain, no consensus. Each row's current_hash commits to the
-- previous row's hash plus its own content, so altering any past row
-- breaks every hash after it. verify_audit_chain() walks the chain and
-- says exactly where it broke, if anywhere.

alter table audit_logs
  add column seq bigserial,
  add column previous_hash text,
  add column current_hash text;
alter table audit_logs add constraint audit_logs_seq_unique unique (seq);

-- Single entry point for every chained write. One global advisory lock
-- serializes appends across concurrent registrations so previous_hash
-- always refers to the row actually before it — no race window.
create or replace function append_audit_log(
  p_actor_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_metadata jsonb default '{}'::jsonb
) returns audit_logs
language plpgsql as $$
declare
  v_prev_hash text;
  v_created_at timestamptz := clock_timestamp();
  v_new_hash text;
  v_row audit_logs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('surgeshield_audit_chain'));

  select current_hash into v_prev_hash from audit_logs order by seq desc limit 1;
  v_prev_hash := coalesce(v_prev_hash, 'GENESIS');

  v_new_hash := encode(
    digest(
      concat_ws('|', v_prev_hash, v_created_at::text, p_action, coalesce(p_actor_id::text, ''), coalesce(p_metadata::text, '{}')),
      'sha256'
    ),
    'hex'
  );

  insert into audit_logs (actor_id, action, entity, entity_id, metadata, created_at, previous_hash, current_hash)
  values (p_actor_id, p_action, p_entity, p_entity_id, p_metadata, v_created_at, v_prev_hash, v_new_hash)
  returning * into v_row;

  return v_row;
end;
$$;

-- Walks the chain in insertion order, recomputing each hash and checking
-- linkage. Stops at the first mismatch.
create or replace function verify_audit_chain()
returns table(valid boolean, verified_entries integer, first_broken_entry uuid)
language plpgsql as $$
declare
  v_row record;
  v_prev_hash text := 'GENESIS';
  v_expected text;
  v_count integer := 0;
begin
  for v_row in select * from audit_logs order by seq asc loop
    if v_row.previous_hash is distinct from v_prev_hash then
      return query select false, v_count, v_row.id;
      return;
    end if;

    v_expected := encode(
      digest(
        concat_ws('|', v_row.previous_hash, v_row.created_at::text, v_row.action, coalesce(v_row.actor_id::text, ''), coalesce(v_row.metadata::text, '{}')),
        'sha256'
      ),
      'hex'
    );

    if v_expected is distinct from v_row.current_hash then
      return query select false, v_count, v_row.id;
      return;
    end if;

    v_prev_hash := v_row.current_hash;
    v_count := v_count + 1;
  end loop;

  return query select true, v_count, null::uuid;
end;
$$;

-- Critical event: Event Created. Fires regardless of insert path.
create or replace function trg_log_event_created() returns trigger
language plpgsql as $$
begin
  perform append_audit_log(new.organizer_id, 'event_created', 'event', new.id,
    jsonb_build_object('title', new.title, 'capacity', new.capacity));
  return new;
end;
$$;
create trigger events_audit_created after insert on events
  for each row execute function trg_log_event_created();

-- Critical event: Seat Allocated. Same allocation logic as 0001, plus one audit call.
create or replace function allocate_seat(
  p_event_id uuid, p_lane_index integer, p_user_id uuid, p_idempotency_key text
) returns registrations
language plpgsql as $$
declare
  v_partition seat_partitions%rowtype;
  v_registration registrations%rowtype;
begin
  select * into v_partition from seat_partitions
  where event_id = p_event_id and lane_index = p_lane_index for update;

  if not found then
    raise exception 'lane % not found for event %', p_lane_index, p_event_id;
  end if;
  if v_partition.seats_taken >= v_partition.capacity then
    raise exception 'lane_full' using errcode = 'P0001';
  end if;

  update seat_partitions set seats_taken = seats_taken + 1 where id = v_partition.id;

  insert into registrations (event_id, user_id, lane_index, status, idempotency_key)
  values (p_event_id, p_user_id, p_lane_index, 'pending', p_idempotency_key)
  returning * into v_registration;

  perform append_audit_log(p_user_id, 'seat_allocated', 'registration', v_registration.id,
    jsonb_build_object('event_id', p_event_id, 'lane_index', p_lane_index));

  return v_registration;
end;
$$;

-- Critical event: Seat Released (Ghost Seat Recovery). Same sweep logic as 0003, plus audit call.
create or replace function release_expired_seats() returns integer
language plpgsql as $$
declare
  v_count integer := 0;
  v_row registrations%rowtype;
begin
  for v_row in
    select * from registrations
    where status = 'pending' and seat_passport_expires_at < now()
    for update skip locked
  loop
    update seat_partitions set seats_taken = seats_taken - 1
    where event_id = v_row.event_id and lane_index = v_row.lane_index;

    update registrations set status = 'expired' where id = v_row.id;

    perform append_audit_log(v_row.user_id, 'seat_released', 'registration', v_row.id,
      jsonb_build_object('event_id', v_row.event_id, 'lane_index', v_row.lane_index, 'reason', 'ghost_seat_recovery'));

    perform promote_from_queue(v_row.event_id, v_row.lane_index);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Critical event: Lite Mode Activated/Deactivated. Only logs on actual transitions.
create or replace function set_system_status(p_event_id uuid, p_lite_mode boolean, p_reason text, p_surge_score numeric)
returns void language plpgsql as $$
declare
  v_prev boolean;
begin
  select lite_mode into v_prev from system_status where event_id = p_event_id;

  insert into system_status (event_id, lite_mode, reason, surge_score, updated_at)
  values (p_event_id, p_lite_mode, p_reason, p_surge_score, now())
  on conflict (event_id) do update
    set lite_mode = excluded.lite_mode, reason = excluded.reason,
        surge_score = excluded.surge_score, updated_at = now();

  if v_prev is distinct from p_lite_mode then
    perform append_audit_log(null,
      case when p_lite_mode then 'lite_mode_activated' else 'lite_mode_deactivated' end,
      'event', p_event_id, jsonb_build_object('reason', p_reason, 'surge_score', p_surge_score));
  end if;
end;
$$;

-- Registration Attempt and Lane Assignment are logged from the Surge Router
-- edge function itself (they're routing decisions made in application code,
-- not row mutations) — see supabase/functions/surge-router/index.ts.
-- Circuit Guardian Open/Close will call append_audit_log the same way once
-- the worker exists (not built yet).
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
-- supabase/migrations/0007_antibot.sql
-- Anti-Bot & Rate Limiting protection: IP/User request rate tracking, double-click protection & cooldowns

CREATE TABLE IF NOT EXISTS public.rate_limit_records (
  key TEXT PRIMARY KEY,               -- e.g. "ip:1.2.3.4" or "user:uuid"
  request_count INT NOT NULL DEFAULT 1,
  first_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooldown_until TIMESTAMPTZ
);

ALTER TABLE public.rate_limit_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on rate_limit_records"
  ON public.rate_limit_records FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Anti-bot validation RPC: checks sliding rate limits & cooldowns
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_requests INT DEFAULT 10,
  p_window_seconds INT DEFAULT 60,
  p_cooldown_seconds INT DEFAULT 15
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec public.rate_limit_records%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_allowed BOOLEAN := true;
  v_retry_after INT := 0;
BEGIN
  SELECT * INTO v_rec FROM public.rate_limit_records WHERE key = p_key FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.rate_limit_records (key, request_count, first_request_at, last_request_at)
    VALUES (p_key, 1, v_now, v_now);
    RETURN jsonb_build_object('allowed', true, 'remaining', p_max_requests - 1);
  END IF;

  -- Check active cooldown
  IF v_rec.cooldown_until IS NOT NULL AND v_rec.cooldown_until > v_now THEN
    v_retry_after := EXTRACT(EPOCH FROM (v_rec.cooldown_until - v_now))::INT;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown_active',
      'retry_after', v_retry_after
    );
  END IF;

  -- Check if rate window has rolled over
  IF v_now - v_rec.first_request_at > (p_window_seconds || ' seconds')::INTERVAL THEN
    UPDATE public.rate_limit_records
    SET request_count = 1,
        first_request_at = v_now,
        last_request_at = v_now,
        cooldown_until = NULL
    WHERE key = p_key;
    RETURN jsonb_build_object('allowed', true, 'remaining', p_max_requests - 1);
  END IF;

  -- Check request threshold violation
  IF v_rec.request_count >= p_max_requests THEN
    UPDATE public.rate_limit_records
    SET cooldown_until = v_now + (p_cooldown_seconds || ' seconds')::INTERVAL,
        last_request_at = v_now
    WHERE key = p_key;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limit_exceeded',
      'retry_after', p_cooldown_seconds
    );
  END IF;

  -- Increment count
  UPDATE public.rate_limit_records
  SET request_count = request_count + 1,
      last_request_at = v_now
  WHERE key = p_key;

  RETURN jsonb_build_object(
    'allowed', true,
    'remaining', p_max_requests - (v_rec.request_count + 1)
  );
END;
$$;

-- =========================================================================
-- Migration 0008: Priority Job Queue & Worker Infrastructure
-- =========================================================================

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

create policy "job_queue: select all" on public.job_queue
  for select using (true);

create policy "job_queue: insert all" on public.job_queue
  for insert with check (true);

create policy "job_queue: update all" on public.job_queue
  for update using (true);

create policy "job_queue: delete all" on public.job_queue
  for delete using (true);

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

