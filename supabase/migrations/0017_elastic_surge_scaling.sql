-- Migration 0017: Real-Time Dynamic Elastic Lane Scaling

-- 1. Upgrade suggest_lane_count with responsive scaling thresholds
CREATE OR REPLACE FUNCTION public.suggest_lane_count(p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lane_count integer;
  v_min integer;
  v_max integer;
  v_avg_saturation numeric;
  v_queue_len integer;
  v_target integer;
BEGIN
  SELECT lane_count, coalesce(min_lane_count, 4), coalesce(max_lane_count, 16)
  INTO v_lane_count, v_min, v_max
  FROM public.events WHERE id = p_event_id;

  IF v_lane_count IS NULL THEN
    RETURN 4;
  END IF;

  SELECT coalesce(avg(seats_taken::numeric / nullif(capacity, 0)), 0)
  INTO v_avg_saturation
  FROM public.seat_partitions WHERE event_id = p_event_id;

  SELECT count(*) INTO v_queue_len
  FROM public.queue_entries WHERE event_id = p_event_id AND status = 'waiting';

  v_target := v_lane_count;

  -- Scale UP under surge pressure
  IF v_avg_saturation >= 0.65 OR v_queue_len > 0 THEN
    v_target := v_lane_count + ceil(v_queue_len::numeric / 10);
    IF v_avg_saturation >= 0.65 THEN
      v_target := v_target + 1;
    END IF;
    IF v_avg_saturation >= 0.85 THEN
      v_target := v_target + 2;
    END IF;
  ELSIF v_avg_saturation < 0.35 AND v_queue_len = 0 THEN
    -- Consolidate only when load is genuinely low, down to min_lane_count (4)
    v_target := v_lane_count - 1;
  END IF;

  RETURN greatest(v_min, least(v_max, v_target));
END;
$$;

-- 2. Update simulate_surge_load to actively trigger lane rebalancing during surge benchmarks
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
BEGIN
  -- 1. Determine total lane count and capacity for balanced distribution
  SELECT count(*), coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_lane_count, v_total_capacity, v_total_taken
  FROM public.seat_partitions
  WHERE event_id = p_event_id;

  IF v_lane_count = 0 THEN
    RETURN jsonb_build_object('error', 'no lanes configured for event');
  END IF;

  v_base_per_lane := p_count / v_lane_count;
  v_remainder := p_count % v_lane_count;

  -- 2. Striped multi-lane allocation (balanced across all lanes)
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

    -- Handle overflow queuing for this lane
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

  -- 3. Dynamic Scaling: Trigger adaptive lane splitting under surge load
  IF v_saturation >= 0.65 OR v_queued > 0 THEN
    PERFORM public.rebalance_lanes(p_event_id);
  END IF;

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
    'total_seated', v_total_taken
  );
END;
$$;

-- 3. Ensure events table min_lane_count is set to 4 for balanced baseline
UPDATE public.events
SET min_lane_count = 4
WHERE min_lane_count < 4;

-- 4. Rebuild partitions to clean 4 base lanes if previously merged down to 3
DO $$
DECLARE
  v_ev RECORD;
  v_cur_lanes integer;
  v_cap integer;
  v_per_lane integer;
  v_rem integer;
  v_i integer;
BEGIN
  FOR v_ev IN SELECT id, capacity FROM public.events LOOP
    SELECT count(*) INTO v_cur_lanes FROM public.seat_partitions WHERE event_id = v_ev.id;
    IF v_cur_lanes < 4 THEN
      -- Cleanly reset partitions to 4 balanced lanes
      DELETE FROM public.seat_partitions WHERE event_id = v_ev.id;
      v_per_lane := v_ev.capacity / 4;
      v_rem := v_ev.capacity % 4;
      FOR v_i IN 0..3 LOOP
        INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
        VALUES (v_ev.id, v_i, v_per_lane + (CASE WHEN v_i < v_rem THEN 1 ELSE 0 END), 0);
      END LOOP;
      UPDATE public.events SET lane_count = 4 WHERE id = v_ev.id;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.suggest_lane_count(uuid) TO postgres, authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.simulate_surge_load(uuid, integer) TO postgres, authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';
