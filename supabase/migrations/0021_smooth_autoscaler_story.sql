-- Migration 0021: Smooth Incremental Scaling Ladder & Storytelling Observability Telemetry

-- 1. suggest_lane_count: Smooth 1-by-1 Incremental Scaling Ladder
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

  SELECT coalesce(count(*)::numeric / 10.0, 0)
  INTO v_throughput
  FROM public.audit_logs
  WHERE entity_id = p_event_id
    AND created_at >= NOW() - INTERVAL '10 seconds'
    AND action IN ('registration_confirmed', 'lane_assignment', 'sim_burst');

  v_occupancy := v_seats_taken::numeric / v_capacity::numeric;

  -- Smooth Incremental Autoscaling Ladder (OR Triggers)
  IF v_occupancy > 0.98 OR v_queue_pressure > 400 THEN
    v_target := 7;
  ELSIF v_occupancy > 0.95 OR v_queue_pressure > 300 THEN
    v_target := 6;
  ELSIF v_occupancy > 0.90 OR v_queue_pressure > 200 THEN
    v_target := 5;
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

-- 2. split_lane: Rich Storytelling Audit Log with Trigger Reasons
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
  v_reason text;
  v_total_cap integer;
  v_total_taken integer;
  v_occ_pct integer;
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

  SELECT coalesce(sum(capacity), 0), coalesce(sum(seats_taken), 0)
  INTO v_total_cap, v_total_taken
  FROM public.seat_partitions WHERE event_id = p_event_id;

  v_occ_pct := CASE WHEN v_total_cap > 0 THEN round((v_total_taken::numeric / v_total_cap::numeric) * 100) ELSE 0 END;

  IF v_queue_count > 0 THEN
    v_reason := format('Queue reached %s users (%s%% occupancy)', v_queue_count, v_occ_pct);
  ELSE
    v_reason := format('Occupancy reached %s%% (%s/%s seats)', v_occ_pct, v_total_taken, v_total_cap);
  END IF;

  -- Storytelling Scale-Out Audit Log
  PERFORM public.append_audit_log(
    NULL, 'scaling_out_triggered', 'event', p_event_id,
    jsonb_build_object(
      'lane_index', v_new_lane_index,
      'from_lane', p_lane_index,
      'trigger_reason', v_reason,
      'capacity_redistributed', format('%s -> %s / %s', v_lane.capacity, v_lane.capacity - v_move_capacity, v_move_capacity),
      'occupancy_redistributed', format('%s -> %s / %s', v_lane.seats_taken, v_lane.seats_taken - v_move_seats, v_move_seats),
      'new_lane_count', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id),
      'total_capacity', v_total_cap,
      'total_seated', v_total_taken
    )
  );

  RETURN v_new_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.suggest_lane_count(uuid) TO postgres, authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.split_lane(uuid, integer) TO postgres, service_role, anon, authenticated;

NOTIFY pgrst, 'reload schema';
