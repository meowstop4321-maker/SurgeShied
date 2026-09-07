-- Migration 0014: give simulate_surge_load the same "log what actually
-- happened" treatment 0013 gave allocate_seat. Previously it only
-- returned aggregate numbers; the caller (api.ts fallbackSimulate) had to
-- guess at lane assignment and always reported "confirmed", so queuing
-- never appeared in the log stream during a simulated burst even when
-- v_queued was correctly non-zero internally.

CREATE OR REPLACE FUNCTION public.simulate_surge_load(p_event_id uuid, p_count integer default 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lane RECORD;
  v_headroom integer;
  v_allocated integer := 0;
  v_queued integer := 0;
  v_to_allocate integer;
  v_total_capacity integer := 0;
  v_total_taken integer := 0;
  v_saturation numeric;
  v_least_loaded_lane integer;
BEGIN
  FOR v_lane IN
    SELECT id, lane_index, capacity, seats_taken
    FROM public.seat_partitions
    WHERE event_id = p_event_id
    ORDER BY (capacity - seats_taken) DESC
  LOOP
    v_total_capacity := v_total_capacity + v_lane.capacity;
    v_headroom := GREATEST(0, v_lane.capacity - v_lane.seats_taken);
    v_to_allocate := LEAST(v_headroom, p_count - v_allocated);

    IF v_to_allocate > 0 THEN
      UPDATE public.seat_partitions
      SET seats_taken = seats_taken + v_to_allocate
      WHERE id = v_lane.id;
      v_allocated := v_allocated + v_to_allocate;

      -- One line per lane actually touched, with the real post-update
      -- numbers — this is what LiveLogConsole's "registration_confirmed"
      -- case renders as "[Lane X] CONFIRMED ... (N/capacity in lane)".
      PERFORM public.append_audit_log(
        NULL, 'registration_confirmed', 'event', p_event_id,
        jsonb_build_object(
          'user_tag', 'sim_burst',
          'lane_index', v_lane.lane_index,
          'seats_taken', v_lane.seats_taken + v_to_allocate,
          'capacity', v_lane.capacity,
          'count', v_to_allocate
        )
      );
    END IF;

    v_total_taken := v_total_taken + v_lane.seats_taken + v_to_allocate;
  END LOOP;

  v_queued := GREATEST(0, p_count - v_allocated);

  IF v_queued > 0 THEN
    -- No per-user queue_entries rows for synthetic load (there's no real
    -- user_id to attach one to), but the outcome is real and belongs in
    -- the log — tagged against whichever lane has the least headroom,
    -- since that's the one the overflow would have hit first.
    SELECT lane_index INTO v_least_loaded_lane
    FROM public.seat_partitions
    WHERE event_id = p_event_id
    ORDER BY (capacity - seats_taken) ASC
    LIMIT 1;

    PERFORM public.append_audit_log(
      NULL, 'queue_join', 'event', p_event_id,
      jsonb_build_object(
        'user_tag', 'sim_burst',
        'lane_index', v_least_loaded_lane,
        'count', v_queued,
        'reason', 'simulated burst exceeded lane capacity'
      )
    );
  END IF;

  v_saturation := CASE WHEN v_total_capacity > 0 THEN v_total_taken::numeric / v_total_capacity::numeric ELSE 1.0 END;

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
    'saturation', v_saturation
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.simulate_surge_load(uuid, integer) TO postgres, authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';
