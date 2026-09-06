-- Migration 0010: Dynamic (Elastic) Surge Partitions
--
-- Until now, an event's lane *count* was fixed forever at creation time by
-- create_event_with_partitions() (0009) — "Adaptive Surge Partitions" only
-- ever meant adaptive ROUTING across a fixed number of lanes, never an
-- adaptive number of lanes. This migration adds real elasticity: the
-- number of parallel lanes grows while a surge is active and shrinks back
-- down once demand drops.
--
-- The invariant that must never break: sum(seat_partitions.capacity) for
-- an event always equals events.capacity. Every function below only moves
-- *unallocated* headroom between lane rows inside a single locked
-- transaction — it never creates or destroys a seat, and it never touches
-- seats_taken except by summing two lanes' existing counts together on a
-- merge. Zero-overbooking is therefore preserved by construction, the same
-- way allocate_seat()'s row lock preserves it.

alter table events
  add column if not exists min_lane_count integer not null default 1 check (min_lane_count >= 1),
  add column if not exists max_lane_count integer not null default 16 check (max_lane_count between 1 and 64),
  add column if not exists last_lane_scale_at timestamptz;

alter table events drop constraint if exists events_lane_bounds;
alter table events add constraint events_lane_bounds check (min_lane_count <= max_lane_count);

-- Recreated from 0009 to seed min_lane_count with the organizer's original
-- lane_count, so auto-scaling only ever adds capacity above that baseline
-- and later returns to it — it never fragments a planned event below what
-- the organizer configured. max_lane_count keeps the existing default (16)
-- unless raised explicitly afterwards.
create or replace function public.create_event_with_partitions(
  p_title text,
  p_description text,
  p_capacity integer,
  p_lane_count integer,
  p_starts_at timestamptz
) returns public.events
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_base_cap integer;
  v_remainder integer;
  v_lane_cap integer;
  v_i integer;
begin
  if v_user_id is null then
    select id into v_user_id from public.profiles limit 1;
  end if;

  insert into public.events (organizer_id, title, description, capacity, lane_count, starts_at, registration_open, min_lane_count)
  values (v_user_id, p_title, p_description, p_capacity, p_lane_count, p_starts_at, true, p_lane_count)
  returning * into v_event;

  v_base_cap := floor(p_capacity / p_lane_count);
  v_remainder := p_capacity % p_lane_count;

  for v_i in 0..(p_lane_count - 1) loop
    v_lane_cap := v_base_cap + (case when v_i < v_remainder then 1 else 0 end);
    insert into public.seat_partitions (event_id, lane_index, capacity, seats_taken)
    values (v_event.id, v_i, v_lane_cap, 0);
  end loop;

  perform public.append_audit_log(
    v_user_id, 'event_created', 'event', v_event.id,
    jsonb_build_object('title', p_title, 'capacity', p_capacity, 'lane_count', p_lane_count)
  );

  return v_event;
end;
$$;

-- How many lanes the CURRENT load actually justifies. Read-only / stable —
-- callers decide whether and when to act on its answer. Mirrors the shape
-- of worker/workerManager.js's calculateTargetWorkers(): a proportional
-- target computed fresh from present queue depth each time, not a
-- cumulative counter.
create or replace function public.suggest_lane_count(p_event_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lane_count integer;
  v_min integer;
  v_max integer;
  v_avg_saturation numeric;
  v_queue_len integer;
  v_target integer;
begin
  select lane_count, min_lane_count, max_lane_count
    into v_lane_count, v_min, v_max
  from public.events where id = p_event_id;

  if v_lane_count is null then
    return null;
  end if;

  select coalesce(avg(seats_taken::numeric / nullif(capacity, 0)), 0)
    into v_avg_saturation
  from public.seat_partitions where event_id = p_event_id;

  select count(*) into v_queue_len
  from public.queue_entries where event_id = p_event_id and status = 'waiting';

  v_target := v_lane_count;

  if v_avg_saturation >= 0.9 or v_queue_len > 0 then
    -- Roughly one extra lane per 15 people currently waiting, plus one more
    -- immediately if the existing lanes are themselves nearly full (so a
    -- surge with an empty queue but red-lined lanes still gets relief
    -- before anyone actually has to wait).
    v_target := v_lane_count + ceil(v_queue_len::numeric / 15);
    if v_avg_saturation >= 0.9 then
      v_target := v_target + 1;
    end if;
  elsif v_avg_saturation < 0.4 and v_queue_len = 0 then
    -- Sustained low load: consolidate one lane at a time so a momentary
    -- lull can never cliff-edge the lane count back down.
    v_target := v_lane_count - 1;
  end if;

  return greatest(v_min, least(v_max, v_target));
end;
$$;

-- Splits ONE lane's spare headroom into a brand-new sibling lane.
--
-- CPR (registerForEvent in _shared/register.ts) always ranks lanes by
-- headroom RATIO and routes each new arrival to whichever lane ranks
-- first — so during a burst, the lane with the MOST headroom is the one
-- attracting the most concurrent row-lock attempts, not the fullest one.
-- Splitting that lane in two is what actually relieves contention;
-- splitting an already-saturated lane would find nothing to move.
create or replace function public.split_lane(p_event_id uuid, p_lane_index integer)
returns public.seat_partitions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lane public.seat_partitions%rowtype;
  v_new_lane_index integer;
  v_move_capacity integer;
  v_new_row public.seat_partitions%rowtype;
begin
  select * into v_lane
  from public.seat_partitions
  where event_id = p_event_id and lane_index = p_lane_index
  for update;

  if not found then
    return null;
  end if;

  v_move_capacity := (v_lane.capacity - v_lane.seats_taken) / 2;
  if v_move_capacity < 1 then
    return null; -- not enough spare headroom for a second lane to be worth it
  end if;

  select coalesce(max(lane_index), -1) + 1 into v_new_lane_index
  from public.seat_partitions where event_id = p_event_id;

  update public.seat_partitions
  set capacity = capacity - v_move_capacity
  where id = v_lane.id;

  insert into public.seat_partitions (event_id, lane_index, capacity, seats_taken)
  values (p_event_id, v_new_lane_index, v_move_capacity, 0)
  returning * into v_new_row;

  update public.events set lane_count = lane_count + 1, last_lane_scale_at = now()
  where id = p_event_id;

  perform public.append_audit_log(null, 'lane_split', 'event', p_event_id,
    jsonb_build_object('lane_index', v_new_lane_index, 'from_lane', p_lane_index, 'capacity_moved', v_move_capacity));

  return v_new_row;
end;
$$;

-- Folds lane_b's capacity and seats_taken into lane_a, and reassigns
-- lane_b's still-waiting queue entries to lane_a. created_at (and
-- therefore each attendee's FIFO position) is left untouched, so nobody
-- loses their place by being merged. Locks both rows in a fixed
-- (lowest-lane-index-first) order regardless of argument order, so two
-- concurrent merges can never deadlock on each other.
create or replace function public.merge_lanes(p_event_id uuid, p_lane_a integer, p_lane_b integer)
returns public.seat_partitions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a public.seat_partitions%rowtype;
  v_b public.seat_partitions%rowtype;
  v_lo integer := least(p_lane_a, p_lane_b);
  v_hi integer := greatest(p_lane_a, p_lane_b);
  v_result public.seat_partitions%rowtype;
begin
  if p_lane_a = p_lane_b then
    return null;
  end if;

  perform 1 from public.seat_partitions
  where event_id = p_event_id and lane_index in (v_lo, v_hi)
  order by lane_index for update;

  select * into v_a from public.seat_partitions where event_id = p_event_id and lane_index = p_lane_a;
  select * into v_b from public.seat_partitions where event_id = p_event_id and lane_index = p_lane_b;
  if v_a.id is null or v_b.id is null then
    return null;
  end if;

  update public.seat_partitions
  set capacity = v_a.capacity + v_b.capacity,
      seats_taken = v_a.seats_taken + v_b.seats_taken
  where id = v_a.id
  returning * into v_result;

  update public.queue_entries
  set lane_index = p_lane_a
  where event_id = p_event_id and lane_index = p_lane_b and status = 'waiting';

  delete from public.seat_partitions where id = v_b.id;

  update public.events set lane_count = lane_count - 1, last_lane_scale_at = now()
  where id = p_event_id;

  perform public.append_audit_log(null, 'lane_merge', 'event', p_event_id,
    jsonb_build_object('lane_index', p_lane_a, 'removed_lane', p_lane_b,
      'combined_capacity', v_result.capacity, 'combined_seats_taken', v_result.seats_taken));

  return v_result;
end;
$$;

-- Single entry point. Moves the event toward suggest_lane_count() by at
-- most one split or one merge per call — cheap enough to call from the hot
-- registration path. A per-event advisory lock means that when a whole
-- burst of concurrent registrations all notice the same surge at once,
-- exactly one of them performs the rebalance and the rest return
-- immediately (no stampede of concurrent splits fighting over the same
-- lane row). Scale-down additionally waits out a cooldown after the last
-- scaling event, so a momentary lull can't immediately undo a split that a
-- following burst will just need again.
create or replace function public.rebalance_lanes(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_got_lock boolean;
  v_current integer;
  v_last_scale_at timestamptz;
  v_target integer;
  v_split_from integer;
  v_merge_a integer;
  v_merge_b integer;
begin
  v_got_lock := pg_try_advisory_xact_lock(hashtext('surgeshield_lane_rebalance'), hashtext(p_event_id::text));
  if not v_got_lock then
    return jsonb_build_object('rebalanced', false, 'reason', 'already rebalancing');
  end if;

  select lane_count, last_lane_scale_at into v_current, v_last_scale_at
  from public.events where id = p_event_id;
  if v_current is null then
    return jsonb_build_object('rebalanced', false, 'reason', 'event not found');
  end if;

  v_target := public.suggest_lane_count(p_event_id);
  if v_target is null or v_target = v_current then
    return jsonb_build_object('rebalanced', false, 'current_lanes', v_current, 'target_lanes', v_target);
  end if;

  if v_target > v_current then
    select lane_index into v_split_from
    from public.seat_partitions
    where event_id = p_event_id
    order by (capacity - seats_taken) desc
    limit 1;

    if v_split_from is null then
      return jsonb_build_object('rebalanced', false, 'reason', 'no lanes to split');
    end if;

    perform public.split_lane(p_event_id, v_split_from);
    return jsonb_build_object('rebalanced', true, 'action', 'split', 'current_lanes', v_current, 'target_lanes', v_target);
  else
    if v_last_scale_at is not null and now() - v_last_scale_at < interval '45 seconds' then
      return jsonb_build_object('rebalanced', false, 'reason', 'scale-down cooldown', 'current_lanes', v_current, 'target_lanes', v_target);
    end if;

    -- Consolidate the two LEAST-loaded lanes, so the busiest lanes (and
    -- anyone actually waiting on them) are left completely undisturbed.
    select lane_index into v_merge_a
    from public.seat_partitions
    where event_id = p_event_id
    order by (capacity - seats_taken) desc, lane_index asc
    limit 1;

    select lane_index into v_merge_b
    from public.seat_partitions
    where event_id = p_event_id and lane_index <> v_merge_a
    order by (capacity - seats_taken) desc, lane_index asc
    limit 1;

    if v_merge_a is null or v_merge_b is null then
      return jsonb_build_object('rebalanced', false, 'reason', 'fewer than 2 lanes');
    end if;

    perform public.merge_lanes(p_event_id, v_merge_a, v_merge_b);
    return jsonb_build_object('rebalanced', true, 'action', 'merge', 'current_lanes', v_current, 'target_lanes', v_target);
  end if;
end;
$$;

-- Batched per-lane waiting-queue length lookup. Replaces the
-- N-lanes-in-parallel count query that _shared/register.ts's enqueueUser()
-- previously issued on every request that needed to join the queue (an
-- N+1 pattern that gets worse, not better, exactly when a lane count is
-- growing under surge) with a single round trip.
create or replace function public.get_queue_lengths(p_event_id uuid)
returns table(lane_index integer, waiting_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select sp.lane_index, count(qe.id)::integer as waiting_count
  from public.seat_partitions sp
  left join public.queue_entries qe
    on qe.event_id = sp.event_id and qe.lane_index = sp.lane_index and qe.status = 'waiting'
  where sp.event_id = p_event_id
  group by sp.lane_index;
$$;

grant execute on function public.create_event_with_partitions(text, text, integer, integer, timestamptz) to postgres, authenticated, service_role;
-- suggest_lane_count is read-only telemetry (safe for a future dashboard
-- "suggested lanes" readout); the three functions that actually mutate
-- lane topology are service_role only — called from register.ts / the
-- worker sweep with the admin client, never directly by a browser client.
grant execute on function public.suggest_lane_count(uuid) to postgres, authenticated, service_role;
grant execute on function public.get_queue_lengths(uuid) to postgres, authenticated, service_role;

revoke execute on function public.rebalance_lanes(uuid) from anon, authenticated, public;
revoke execute on function public.split_lane(uuid, integer) from anon, authenticated, public;
revoke execute on function public.merge_lanes(uuid, integer, integer) from anon, authenticated, public;
grant execute on function public.rebalance_lanes(uuid) to postgres, service_role;
grant execute on function public.split_lane(uuid, integer) to postgres, service_role;
grant execute on function public.merge_lanes(uuid, integer, integer) to postgres, service_role;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
