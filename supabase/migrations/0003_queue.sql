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
