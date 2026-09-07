-- Migration 0020: Proportional Split Autoscaling with Invariant Verification and Greedy Headroom Distribution

CREATE OR REPLACE FUNCTION public.split_lane(p_event_id uuid, p_lane_index integer)
RETURNS public.seat_partitions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lane public.seat_partitions%ROWTYPE;
  v_new_lane_index integer;
  v_move_capacity integer;
  v_move_seats integer;
  v_new_row public.seat_partitions%ROWTYPE;
  v_queue_count integer;
  v_queue_to_move integer;
BEGIN
  SELECT * INTO v_lane
  FROM public.seat_partitions
  WHERE event_id = p_event_id AND lane_index = p_lane_index
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Proportional split: half capacity and half occupied seats
  v_move_capacity := floor(v_lane.capacity / 2);
  v_move_seats := floor(v_lane.seats_taken / 2);

  IF v_move_capacity < 1 THEN
    RETURN NULL; -- Lane cannot be split further
  END IF;

  SELECT COALESCE(MAX(lane_index), -1) + 1 INTO v_new_lane_index
  FROM public.seat_partitions WHERE event_id = p_event_id;

  -- Update source lane
  UPDATE public.seat_partitions
  SET capacity = v_lane.capacity - v_move_capacity,
      seats_taken = v_lane.seats_taken - v_move_seats
  WHERE id = v_lane.id;

  -- Insert new lane
  INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
  VALUES (p_event_id, v_new_lane_index, v_move_capacity, v_move_seats)
  RETURNING * INTO v_new_row;

  -- Rebalance half the waiting queue entries from old lane to new lane
  SELECT count(*) INTO v_queue_count
  FROM public.queue_entries
  WHERE event_id = p_event_id AND lane_index = p_lane_index AND status = 'waiting';

  IF v_queue_count > 1 THEN
    v_queue_to_move := floor(v_queue_count / 2);
    UPDATE public.queue_entries
    SET lane_index = v_new_lane_index
    WHERE id IN (
      SELECT id FROM public.queue_entries
      WHERE event_id = p_event_id AND lane_index = p_lane_index AND status = 'waiting'
      ORDER BY created_at ASC
      LIMIT v_queue_to_move
    );
  END IF;

  UPDATE public.events
  SET lane_count = (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id),
      last_lane_scale_at = NOW()
  WHERE id = p_event_id;

  -- Contextual Infrastructure Scaling Log
  PERFORM public.append_audit_log(
    NULL, 'scaling_out_triggered', 'event', p_event_id,
    jsonb_build_object(
      'lane_index', v_new_lane_index,
      'from_lane', p_lane_index,
      'capacity_redistributed', format('%s -> %s / %s', v_lane.capacity, v_lane.capacity - v_move_capacity, v_move_capacity),
      'occupancy_redistributed', format('%s -> %s / %s', v_lane.seats_taken, v_lane.seats_taken - v_move_seats, v_move_seats),
      'new_lane_count', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id)
    )
  );

  RETURN v_new_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_lanes(p_event_id uuid, p_lane_a integer, p_lane_b integer)
RETURNS public.seat_partitions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a public.seat_partitions%ROWTYPE;
  v_b public.seat_partitions%ROWTYPE;
  v_lo integer := LEAST(p_lane_a, p_lane_b);
  v_hi integer := GREATEST(p_lane_a, p_lane_b);
  v_result public.seat_partitions%ROWTYPE;
BEGIN
  IF p_lane_a = p_lane_b THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.seat_partitions
  WHERE event_id = p_event_id AND lane_index IN (v_lo, v_hi)
  ORDER BY lane_index FOR UPDATE;

  SELECT * INTO v_a FROM public.seat_partitions WHERE event_id = p_event_id AND lane_index = p_lane_a;
  SELECT * INTO v_b FROM public.seat_partitions WHERE event_id = p_event_id AND lane_index = p_lane_b;
  IF v_a.id IS NULL OR v_b.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.seat_partitions
  SET capacity = v_a.capacity + v_b.capacity,
      seats_taken = v_a.seats_taken + v_b.seats_taken
  WHERE id = v_a.id
  RETURNING * INTO v_result;

  UPDATE public.queue_entries
  SET lane_index = p_lane_a
  WHERE event_id = p_event_id AND lane_index = p_lane_b AND status = 'waiting';

  DELETE FROM public.seat_partitions WHERE id = v_b.id;

  UPDATE public.events
  SET lane_count = (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id),
      last_lane_scale_at = NOW()
  WHERE id = p_event_id;

  PERFORM public.append_audit_log(
    NULL, 'scaling_in_triggered', 'event', p_event_id,
    jsonb_build_object(
      'lane_index', p_lane_a,
      'removed_lane', p_lane_b,
      'combined_capacity', v_result.capacity,
      'combined_seats_taken', v_result.seats_taken,
      'new_lane_count', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id)
    )
  );

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rebalance_lanes(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_got_lock boolean;
  v_current integer;
  v_last_scale_at timestamptz;
  v_target integer;
  v_split_from integer;
  v_merge_a integer;
  v_merge_b integer;
  v_splits_done integer := 0;
  v_queue_len integer;
  v_processing_count integer;
  v_split_res public.seat_partitions%ROWTYPE;
  v_sum_cap integer;
  v_sum_seats integer;
  v_ev_cap integer;
BEGIN
  v_got_lock := pg_try_advisory_xact_lock(hashtext('surgeshield_lane_rebalance'), hashtext(p_event_id::text));
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object('rebalanced', false, 'reason', 'already rebalancing');
  END IF;

  SELECT count(*) INTO v_current FROM public.seat_partitions WHERE event_id = p_event_id;
  SELECT last_lane_scale_at, capacity INTO v_last_scale_at, v_ev_cap FROM public.events WHERE id = p_event_id;
  IF v_current IS NULL OR v_current = 0 THEN
    RETURN jsonb_build_object('rebalanced', false, 'reason', 'event partitions not found');
  END IF;

  v_target := public.suggest_lane_count(p_event_id);
  IF v_target IS NULL OR v_target = v_current THEN
    RETURN jsonb_build_object('rebalanced', false, 'current_lanes', v_current, 'target_lanes', v_target);
  END IF;

  -- SCALE OUT: Expand lanes up to target
  IF v_target > v_current THEN
    WHILE v_current < v_target LOOP
      SELECT lane_index INTO v_split_from
      FROM public.seat_partitions
      WHERE event_id = p_event_id
      ORDER BY capacity DESC, (capacity - seats_taken) DESC
      LIMIT 1;

      IF v_split_from IS NULL THEN
        EXIT;
      END IF;

      v_split_res := public.split_lane(p_event_id, v_split_from);
      IF v_split_res.id IS NULL THEN
        EXIT;
      END IF;

      v_current := v_current + 1;
      v_splits_done := v_splits_done + 1;
    END LOOP;
  ELSE
    -- SCALE IN: Requires 30-second sustained idle cooldown & 0 queue/in-flight
    SELECT count(*) INTO v_queue_len
    FROM public.queue_entries WHERE event_id = p_event_id AND status = 'waiting';

    SELECT count(*) INTO v_processing_count
    FROM public.registrations WHERE event_id = p_event_id AND status = 'pending';

    IF v_queue_len > 0 OR v_processing_count > 0 THEN
      RETURN jsonb_build_object('rebalanced', false, 'reason', 'active queue or in-flight processing', 'current_lanes', v_current, 'target_lanes', v_target);
    END IF;

    IF v_last_scale_at IS NOT NULL AND NOW() - v_last_scale_at < INTERVAL '30 seconds' THEN
      RETURN jsonb_build_object('rebalanced', false, 'reason', 'scale-in cooldown active (30s)', 'current_lanes', v_current, 'target_lanes', v_target);
    END IF;

    -- Consolidate the two lowest-loaded lanes one step at a time
    SELECT lane_index INTO v_merge_a
    FROM public.seat_partitions
    WHERE event_id = p_event_id
    ORDER BY (capacity - seats_taken) DESC, lane_index ASC
    LIMIT 1;

    SELECT lane_index INTO v_merge_b
    FROM public.seat_partitions
    WHERE event_id = p_event_id AND lane_index <> v_merge_a
    ORDER BY (capacity - seats_taken) DESC, lane_index ASC
    LIMIT 1;

    IF v_merge_a IS NULL OR v_merge_b IS NULL THEN
      RETURN jsonb_build_object('rebalanced', false, 'reason', 'fewer than 2 lanes');
    END IF;

    PERFORM public.merge_lanes(p_event_id, v_merge_a, v_merge_b);
    v_current := v_current - 1;
  END IF;

  -- Safety Invariant 1: Capacity Invariant
  SELECT coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_sum_cap, v_sum_seats
  FROM public.seat_partitions
  WHERE event_id = p_event_id;

  IF v_sum_cap <> v_ev_cap THEN
    RAISE EXCEPTION 'Safety Invariant Violation: sum(capacity) % != events.capacity %', v_sum_cap, v_ev_cap;
  END IF;

  -- Safety Invariant 2: No Lane Overbooking
  PERFORM 1 FROM public.seat_partitions
  WHERE event_id = p_event_id AND seats_taken > capacity;
  IF FOUND THEN
    RAISE EXCEPTION 'Safety Invariant Violation: lane has seats_taken > capacity';
  END IF;

  RETURN jsonb_build_object(
    'rebalanced', true,
    'action', CASE WHEN v_target > v_current THEN 'scale_out' ELSE 'scale_in' END,
    'splits_done', v_splits_done,
    'current_lanes', v_current,
    'target_lanes', v_target,
    'total_capacity', v_sum_cap,
    'total_seated', v_sum_seats
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.simulate_surge_load(p_event_id uuid, p_count integer default 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_capacity integer := 0;
  v_total_taken integer := 0;
  v_remaining_to_allocate integer;
  v_allocated integer := 0;
  v_queued integer := 0;
  v_saturation numeric;
  v_best_lane RECORD;
  v_chunk integer;
  v_avail_lanes_count integer;
  v_queue_user uuid;
  v_queued_rows integer := 0;
  v_inserted integer := 0;
BEGIN
  SELECT coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_total_capacity, v_total_taken
  FROM public.seat_partitions
  WHERE event_id = p_event_id;

  IF v_total_capacity = 0 THEN
    RETURN jsonb_build_object('error', 'no capacity configured for event');
  END IF;

  -- 1. Pre-scale out if incoming surge warrants extra lanes
  v_saturation := (v_total_taken + p_count)::numeric / v_total_capacity::numeric;
  IF v_saturation > 0.25 OR p_count > 20 THEN
    PERFORM public.rebalance_lanes(p_event_id);
  END IF;

  SELECT coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_total_capacity, v_total_taken
  FROM public.seat_partitions
  WHERE event_id = p_event_id;

  v_remaining_to_allocate := p_count;

  -- 2. Balanced greedy allocation across all lanes with headroom
  WHILE v_remaining_to_allocate > 0 LOOP
    SELECT count(*) INTO v_avail_lanes_count
    FROM public.seat_partitions
    WHERE event_id = p_event_id AND capacity > seats_taken;

    IF v_avail_lanes_count = 0 THEN
      -- Saturated across all lanes -> remainder goes to queue
      v_queued := v_queued + v_remaining_to_allocate;
      EXIT;
    END IF;

    -- Pick the lane with the most headroom
    SELECT id, lane_index, capacity, seats_taken, (capacity - seats_taken) AS headroom
    INTO v_best_lane
    FROM public.seat_partitions
    WHERE event_id = p_event_id AND capacity > seats_taken
    ORDER BY (capacity - seats_taken) DESC, lane_index ASC
    LIMIT 1;

    v_chunk := LEAST(v_best_lane.headroom, CEIL(v_remaining_to_allocate::numeric / v_avail_lanes_count::numeric)::integer);
    IF v_chunk < 1 THEN
      v_chunk := 1;
    END IF;

    UPDATE public.seat_partitions
    SET seats_taken = seats_taken + v_chunk
    WHERE id = v_best_lane.id;

    v_allocated := v_allocated + v_chunk;
    v_remaining_to_allocate := v_remaining_to_allocate - v_chunk;

    PERFORM public.append_audit_log(
      NULL, 'registration_confirmed', 'event', p_event_id,
      jsonb_build_object(
        'user_tag', 'sim_burst',
        'lane_index', v_best_lane.lane_index,
        'seats_taken', v_best_lane.seats_taken + v_chunk,
        'capacity', v_best_lane.capacity,
        'count', v_chunk,
        'total_booked', v_total_taken + v_allocated
      )
    );
  END LOOP;

  -- Handle queue entries for overflow
  IF v_queued > 0 THEN
    FOR v_queue_user IN
      SELECT p.id FROM public.profiles p
      WHERE p.role = 'attendee'
        AND NOT EXISTS (
          SELECT 1 FROM public.queue_entries qe
          WHERE qe.event_id = p_event_id AND qe.user_id = p.id AND qe.status = 'waiting'
        )
      LIMIT v_queued
    LOOP
      INSERT INTO public.queue_entries (event_id, user_id, lane_index, status)
      VALUES (p_event_id, v_queue_user, 0, 'waiting')
      ON CONFLICT (event_id, user_id) WHERE status = 'waiting' DO NOTHING;

      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      v_queued_rows := v_queued_rows + v_inserted;
    END LOOP;

    PERFORM public.append_audit_log(
      NULL, 'queue_join', 'event', p_event_id,
      jsonb_build_object(
        'user_tag', 'sim_burst',
        'count', v_queued,
        'reason', 'event capacity reached during surge burst'
      )
    );
  END IF;

  v_total_taken := v_total_taken + v_allocated;
  v_saturation := CASE WHEN v_total_capacity > 0 THEN v_total_taken::numeric / v_total_capacity::numeric ELSE 1.0 END;

  -- 3. Post-allocation elastic rebalance check
  PERFORM public.rebalance_lanes(p_event_id);

  PERFORM public.set_system_status(
    p_event_id,
    v_saturation > 0.85 OR v_queued > 10,
    CASE WHEN v_saturation > 0.85 THEN 'Surge: ' || ROUND(v_saturation * 100) || '% saturation' ELSE NULL END,
    v_saturation
  );

  RETURN jsonb_build_object(
    'attempted', p_count,
    'confirmed', v_allocated,
    'queued', v_queued,
    'queued_rows_created', v_queued_rows,
    'saturation', v_saturation,
    'total_seated', v_total_taken,
    'active_lanes', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.split_lane(uuid, integer) TO postgres, service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_lanes(uuid, integer, integer) TO postgres, service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebalance_lanes(uuid) TO postgres, service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.simulate_surge_load(uuid, integer) TO postgres, authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';
