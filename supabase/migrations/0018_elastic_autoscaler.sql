-- Migration 0018: True Elastic Autoscaling Surge Partitions
--
-- Start with 1 lane (minimal resource usage).
-- Dynamically scale out under occupancy, queue pressure, or throughput surges.
-- Smoothly scale in back to 1 lane after 30s idle cooldown without flapping.

-- 1. Update events bounds: minimum 1 lane baseline
ALTER TABLE public.events
  ALTER COLUMN min_lane_count SET DEFAULT 1;

UPDATE public.events
SET min_lane_count = 1
WHERE min_lane_count > 1;

-- 2. suggest_lane_count: Multi-trigger OR Elastic Decision Tree
CREATE OR REPLACE FUNCTION public.suggest_lane_count(p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capacity integer;
  v_seats_taken integer;
  v_min integer;
  v_max integer;
  v_occupancy numeric;
  v_queue_pressure integer;
  v_throughput numeric := 0;
  v_target integer;
BEGIN
  SELECT capacity, coalesce(min_lane_count, 1), coalesce(max_lane_count, 16)
  INTO v_capacity, v_min, v_max
  FROM public.events WHERE id = p_event_id;

  IF v_capacity IS NULL OR v_capacity = 0 THEN
    RETURN 1;
  END IF;

  SELECT coalesce(sum(seats_taken), 0)
  INTO v_seats_taken
  FROM public.seat_partitions WHERE event_id = p_event_id;

  SELECT count(*) INTO v_queue_pressure
  FROM public.queue_entries WHERE event_id = p_event_id AND status = 'waiting';

  -- Real-time throughput estimate from recent audit logs (last 10s)
  SELECT coalesce(count(*)::numeric / 10.0, 0)
  INTO v_throughput
  FROM public.audit_logs
  WHERE entity_id = p_event_id
    AND created_at >= NOW() - INTERVAL '10 seconds'
    AND action IN ('registration_confirmed', 'lane_assignment', 'sim_burst');

  v_occupancy := v_seats_taken::numeric / v_capacity::numeric;

  -- True Elastic Autoscaling Decision Tree (OR Triggers)
  IF v_occupancy > 0.90 OR v_queue_pressure > 200 THEN
    -- Keep expanding (5, 6, 7, 8...) up to max_lane_count
    v_target := greatest(5, 4 + ceil((greatest(v_queue_pressure, (v_occupancy * 250)::integer) - 100)::numeric / 50.0)::integer);
  ELSIF v_occupancy > 0.75 OR v_queue_pressure > 100 OR v_throughput > 100 THEN
    v_target := 4;
  ELSIF v_occupancy > 0.50 OR v_queue_pressure > 50 OR v_throughput > 50 THEN
    v_target := 3;
  ELSIF v_occupancy > 0.25 OR v_queue_pressure > 20 OR v_throughput > 20 THEN
    v_target := 2;
  ELSE
    v_target := 1;
  END IF;

  RETURN greatest(v_min, least(v_max, v_target));
END;
$$;

-- 3. split_lane: Splits spare headroom into a new partition lane
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
  v_new_row public.seat_partitions%ROWTYPE;
BEGIN
  SELECT * INTO v_lane
  FROM public.seat_partitions
  WHERE event_id = p_event_id AND lane_index = p_lane_index
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_move_capacity := (v_lane.capacity - v_lane.seats_taken) / 2;
  IF v_move_capacity < 1 THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(MAX(lane_index), -1) + 1 INTO v_new_lane_index
  FROM public.seat_partitions WHERE event_id = p_event_id;

  UPDATE public.seat_partitions
  SET capacity = capacity - v_move_capacity
  WHERE id = v_lane.id;

  INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
  VALUES (p_event_id, v_new_lane_index, v_move_capacity, 0)
  RETURNING * INTO v_new_row;

  UPDATE public.events
  SET lane_count = (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id),
      last_lane_scale_at = NOW()
  WHERE id = p_event_id;

  PERFORM public.append_audit_log(
    NULL, 'lane_split', 'event', p_event_id,
    jsonb_build_object(
      'lane_index', v_new_lane_index,
      'from_lane', p_lane_index,
      'capacity_moved', v_move_capacity,
      'new_lane_count', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id)
    )
  );

  RETURN v_new_row;
END;
$$;

-- 4. merge_lanes: Consolidates two lanes back into one with zero seat loss
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
    NULL, 'lane_merge', 'event', p_event_id,
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

-- 5. rebalance_lanes: Elastic autoscaling controller
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
BEGIN
  v_got_lock := pg_try_advisory_xact_lock(hashtext('surgeshield_lane_rebalance'), hashtext(p_event_id::text));
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object('rebalanced', false, 'reason', 'already rebalancing');
  END IF;

  SELECT count(*) INTO v_current FROM public.seat_partitions WHERE event_id = p_event_id;
  SELECT last_lane_scale_at INTO v_last_scale_at FROM public.events WHERE id = p_event_id;
  IF v_current IS NULL OR v_current = 0 THEN
    RETURN jsonb_build_object('rebalanced', false, 'reason', 'event partitions not found');
  END IF;

  v_target := public.suggest_lane_count(p_event_id);
  IF v_target IS NULL OR v_target = v_current THEN
    RETURN jsonb_build_object('rebalanced', false, 'current_lanes', v_current, 'target_lanes', v_target);
  END IF;

  -- SCALE OUT: Expand lanes to meet target
  IF v_target > v_current THEN
    WHILE v_current < v_target LOOP
      SELECT lane_index INTO v_split_from
      FROM public.seat_partitions
      WHERE event_id = p_event_id
      ORDER BY (capacity - seats_taken) DESC
      LIMIT 1;

      IF v_split_from IS NULL THEN
        EXIT;
      END IF;

      v_split_res := public.split_lane(p_event_id, v_split_from);
      IF v_split_res.id IS NULL THEN
        EXIT; -- Cannot split further (insufficient headroom)
      END IF;

      v_current := v_current + 1;
      v_splits_done := v_splits_done + 1;
    END LOOP;

    RETURN jsonb_build_object(
      'rebalanced', v_splits_done > 0,
      'action', 'scale_out',
      'splits_done', v_splits_done,
      'current_lanes', v_current,
      'target_lanes', v_target
    );
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
    RETURN jsonb_build_object(
      'rebalanced', true,
      'action', 'scale_in',
      'current_lanes', v_current - 1,
      'target_lanes', v_target
    );
  END IF;
END;
$$;

-- 6. simulate_surge_load: Adaptive surge simulation with dynamic auto-splitting
CREATE OR REPLACE FUNCTION public.simulate_surge_load(p_event_id uuid, p_count integer default 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lanes RECORD;
  v_lane_count integer := 0;
  v_base_per_lane integer;
  v_remainder integer;
  v_lane_target integer;
  v_allocated integer := 0;
  v_queued integer := 0;
  v_total_capacity integer := 0;
  v_total_taken integer := 0;
  v_headroom integer;
  v_to_allocate integer;
  v_to_queue integer;
  v_saturation numeric;
  v_queue_user uuid;
  v_queued_rows integer := 0;
  v_inserted integer := 0;
  v_idx integer := 0;
  v_target_lanes integer;
BEGIN
  -- 1. Pre-scale out if incoming traffic burst warrants more lanes
  SELECT coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_total_capacity, v_total_taken
  FROM public.seat_partitions
  WHERE event_id = p_event_id;

  IF v_total_capacity = 0 THEN
    RETURN jsonb_build_object('error', 'no capacity configured for event');
  END IF;

  -- Prospective target lanes under incoming surge
  v_saturation := (v_total_taken + p_count)::numeric / v_total_capacity::numeric;
  IF v_saturation > 0.90 OR p_count > 200 THEN
    v_target_lanes := greatest(5, 4 + ceil((p_count - 100)::numeric / 50.0)::integer);
  ELSIF v_saturation > 0.75 OR p_count > 100 THEN
    v_target_lanes := 4;
  ELSIF v_saturation > 0.50 OR p_count > 50 THEN
    v_target_lanes := 3;
  ELSIF v_saturation > 0.25 OR p_count > 20 THEN
    v_target_lanes := 2;
  ELSE
    v_target_lanes := 1;
  END IF;

  -- Dynamically trigger lane scaling out
  PERFORM public.rebalance_lanes(p_event_id);

  SELECT count(*), coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_lane_count, v_total_capacity, v_total_taken
  FROM public.seat_partitions
  WHERE event_id = p_event_id;

  IF v_lane_count = 0 THEN
    RETURN jsonb_build_object('error', 'no lanes available');
  END IF;

  v_base_per_lane := p_count / v_lane_count;
  v_remainder := p_count % v_lane_count;

  -- 2. Striped multi-lane allocation across all scaled lanes
  FOR v_lanes IN
    SELECT id, lane_index, capacity, seats_taken
    FROM public.seat_partitions
    WHERE event_id = p_event_id
    ORDER BY lane_index ASC
  LOOP
    v_lane_target := v_base_per_lane + (CASE WHEN v_idx < v_remainder THEN 1 ELSE 0 END);
    v_idx := v_idx + 1;

    v_headroom := GREATEST(0, v_lanes.capacity - v_lanes.seats_taken);
    v_to_allocate := LEAST(v_headroom, v_lane_target);
    v_to_queue := GREATEST(0, v_lane_target - v_to_allocate);

    IF v_to_allocate > 0 THEN
      UPDATE public.seat_partitions
      SET seats_taken = seats_taken + v_to_allocate
      WHERE id = v_lanes.id;

      v_allocated := v_allocated + v_to_allocate;

      PERFORM public.append_audit_log(
        NULL, 'registration_confirmed', 'event', p_event_id,
        jsonb_build_object(
          'user_tag', 'sim_burst',
          'lane_index', v_lanes.lane_index,
          'seats_taken', v_lanes.seats_taken + v_to_allocate,
          'capacity', v_lanes.capacity,
          'count', v_to_allocate,
          'total_booked', v_total_taken + v_allocated
        )
      );
    END IF;

    -- Handle overflow queue entries
    IF v_to_queue > 0 THEN
      v_queued := v_queued + v_to_queue;

      FOR v_queue_user IN
        SELECT p.id FROM public.profiles p
        WHERE p.role = 'attendee'
          AND NOT EXISTS (
            SELECT 1 FROM public.queue_entries qe
            WHERE qe.event_id = p_event_id AND qe.user_id = p.id AND qe.status = 'waiting'
          )
        LIMIT v_to_queue
      LOOP
        INSERT INTO public.queue_entries (event_id, user_id, lane_index, status)
        VALUES (p_event_id, v_queue_user, v_lanes.lane_index, 'waiting')
        ON CONFLICT (event_id, user_id) WHERE status = 'waiting' DO NOTHING;

        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        v_queued_rows := v_queued_rows + v_inserted;
      END LOOP;

      PERFORM public.append_audit_log(
        NULL, 'queue_join', 'event', p_event_id,
        jsonb_build_object(
          'user_tag', 'sim_burst',
          'lane_index', v_lanes.lane_index,
          'count', v_to_queue,
          'reason', 'lane capacity reached during balanced burst'
        )
      );
    END IF;
  END LOOP;

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

-- 7. create_event_with_partitions: Starts new events with exactly 1 lane
CREATE OR REPLACE FUNCTION public.create_event_with_partitions(
  p_title text,
  p_description text,
  p_capacity integer,
  p_lane_count integer,
  p_starts_at timestamptz
) RETURNS public.events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_event public.events%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  END IF;

  INSERT INTO public.events (organizer_id, title, description, capacity, lane_count, starts_at, registration_open, min_lane_count, max_lane_count)
  VALUES (v_user_id, p_title, p_description, p_capacity, 1, p_starts_at, true, 1, 16)
  RETURNING * INTO v_event;

  -- Initial state: 1 active lane (Lane 0) holding 100% of event capacity
  INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
  VALUES (v_event.id, 0, p_capacity, 0);

  PERFORM public.append_audit_log(
    v_user_id, 'event_created', 'event', v_event.id,
    jsonb_build_object('title', p_title, 'capacity', p_capacity, 'lane_count', 1, 'autoscaling', true)
  );

  RETURN v_event;
END;
$$;

-- 8. reset_event_partitions: Resets event to 1 lane with full headroom
CREATE OR REPLACE FUNCTION public.reset_event_partitions(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap integer;
BEGIN
  SELECT capacity INTO v_cap FROM public.events WHERE id = p_event_id;
  IF v_cap IS NULL THEN
    v_cap := 1000;
  END IF;

  DELETE FROM public.seat_partitions WHERE event_id = p_event_id;

  -- Reset to 1 baseline lane
  INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
  VALUES (p_event_id, 0, v_cap, 0);

  UPDATE public.events
  SET lane_count = 1, min_lane_count = 1, last_lane_scale_at = NOW()
  WHERE id = p_event_id;

  DELETE FROM public.queue_entries WHERE event_id = p_event_id;

  PERFORM public.append_audit_log(
    NULL, 'event_partitions_reset', 'event', p_event_id,
    jsonb_build_object('lane_count', 1, 'capacity', v_cap, 'status', 'reset_to_minimal_baseline')
  );

  PERFORM public.set_system_status(p_event_id, false, 'System recovered to minimal baseline (1 lane)', 0.0);
END;
$$;

-- 9. Cleanly consolidate all existing events with 0 active seats to 1 baseline lane
DO $$
DECLARE
  v_ev RECORD;
  v_seats_taken integer;
BEGIN
  FOR v_ev IN SELECT id, capacity FROM public.events LOOP
    SELECT coalesce(sum(seats_taken), 0) INTO v_seats_taken
    FROM public.seat_partitions WHERE event_id = v_ev.id;

    IF v_seats_taken = 0 THEN
      DELETE FROM public.seat_partitions WHERE event_id = v_ev.id;
      INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
      VALUES (v_ev.id, 0, v_ev.capacity, 0);
      UPDATE public.events SET lane_count = 1, min_lane_count = 1, last_lane_scale_at = NOW() WHERE id = v_ev.id;
    END IF;
  END LOOP;
END;
$$;

-- Grant execution rights
GRANT EXECUTE ON FUNCTION public.suggest_lane_count(uuid) TO postgres, authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.split_lane(uuid, integer) TO postgres, service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_lanes(uuid, integer, integer) TO postgres, service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebalance_lanes(uuid) TO postgres, service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.simulate_surge_load(uuid, integer) TO postgres, authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.reset_event_partitions(uuid) TO postgres, authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';
