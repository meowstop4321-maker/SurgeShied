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
