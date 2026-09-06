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
