-- Migration 0016: Balanced Multi-Lane Striping and Accurate Metric Aggregation

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

-- 3. Update get_ops_metrics so successful_registrations tracks actual seated count
CREATE OR REPLACE FUNCTION public.get_ops_metrics(p_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
  v_avg_latency numeric;
  v_p95_latency numeric;
  v_p99_latency numeric;
  v_active_users integer;
  v_successful_registrations integer;
  v_failed_registrations integer;
  v_queue_processing_rate numeric;
  v_seats_remaining integer;
  v_hb record;
  v_last_scale record;
  v_autoscaling_status text;
BEGIN
  SELECT
    coalesce(avg(latency_ms), 0),
    coalesce(percentile_cont(0.95) within group (order by latency_ms), 0),
    coalesce(percentile_cont(0.99) within group (order by latency_ms), 0)
    INTO v_avg_latency, v_p95_latency, v_p99_latency
  FROM public.request_metrics
  WHERE event_id = p_event_id AND created_at > now() - interval '5 minutes';

  SELECT count(distinct user_id) INTO v_active_users
  FROM public.request_metrics
  WHERE event_id = p_event_id AND user_id IS NOT NULL AND created_at > now() - interval '60 seconds';

  -- Compute successful registrations as greatest of registrations table and sum of seat_partitions
  SELECT GREATEST(
    (SELECT count(*) FROM public.registrations WHERE event_id = p_event_id AND status = 'confirmed'),
    (SELECT coalesce(sum(seats_taken), 0) FROM public.seat_partitions WHERE event_id = p_event_id)
  ) INTO v_successful_registrations;

  SELECT count(*) INTO v_failed_registrations
  FROM public.request_metrics
  WHERE event_id = p_event_id AND outcome IN ('error', 'rate_limited');

  SELECT count(*)::numeric INTO v_queue_processing_rate
  FROM public.queue_entries
  WHERE event_id = p_event_id AND status = 'promoted' AND promoted_at > now() - interval '60 seconds';

  SELECT coalesce(sum(capacity), 0) - coalesce(sum(seats_taken), 0) INTO v_seats_remaining
  FROM public.seat_partitions WHERE event_id = p_event_id;

  SELECT * INTO v_hb FROM public.worker_heartbeats
  WHERE last_beat_at > now() - interval '90 seconds'
  ORDER BY last_beat_at DESC LIMIT 1;

  SELECT action, created_at INTO v_last_scale
  FROM public.audit_logs
  WHERE action IN ('worker_scaled_up', 'worker_scaled_down', 'lane_split', 'lane_merge')
  ORDER BY created_at DESC LIMIT 1;

  v_autoscaling_status := CASE
    WHEN v_last_scale.action IS NULL THEN 'stable'
    WHEN v_last_scale.created_at < now() - interval '20 seconds' THEN 'stable'
    WHEN v_last_scale.action IN ('worker_scaled_up', 'lane_split') THEN 'scaling_up'
    ELSE 'scaling_down'
  END;

  v_result := json_build_object(
    'requests_per_sec', (SELECT round(count(*)::numeric / 5, 2) FROM public.audit_logs WHERE action IN ('registration_attempt', 'registration_confirmed') AND created_at > now() - interval '5 seconds'),
    'queue_length', (SELECT count(*) FROM public.queue_entries WHERE event_id = p_event_id AND status = 'waiting'),
    'active_lanes', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id AND seats_taken > 0),
    'total_lanes', (SELECT count(*) FROM public.seat_partitions WHERE event_id = p_event_id),
    'surge_score', (SELECT surge_score FROM public.system_status WHERE event_id = p_event_id),
    'lite_mode', (SELECT coalesce(lite_mode, false) FROM public.system_status WHERE event_id = p_event_id),
    'notification_queued', (SELECT count(*) FROM public.notification_jobs WHERE status = 'queued'),
    'notification_retries', (SELECT coalesce(sum(attempts), 0) FROM public.notification_jobs WHERE status IN ('queued', 'failed')),
    'dead_letter_count', (SELECT count(*) FROM public.job_queue WHERE status = 'dead_letter'),
    'circuit_state', (SELECT state FROM public.circuit_guardian_state WHERE id = 1),
    'worker_status', (SELECT CASE WHEN max(last_beat_at) > now() - interval '90 seconds' THEN 'healthy' ELSE 'down' END FROM public.worker_heartbeats),
    'active_worker_count', (SELECT coalesce(count(*), 1) FROM public.worker_heartbeats WHERE last_beat_at > now() - interval '90 seconds'),
    'active_users', v_active_users,
    'successful_registrations', v_successful_registrations,
    'failed_registrations', v_failed_registrations,
    'queue_processing_rate_per_min', round(v_queue_processing_rate * 60, 1),
    'pending_jobs', (SELECT count(*) FROM public.job_queue WHERE status = 'pending'),
    'retry_count', (SELECT coalesce(sum(attempts), 0) FROM public.job_queue WHERE attempts > 0),
    'avg_response_time_ms', round(v_avg_latency, 1),
    'p95_latency_ms', round(v_p95_latency, 1),
    'p99_latency_ms', round(v_p99_latency, 1),
    'seats_remaining', v_seats_remaining,
    'cpu_percent', (SELECT cpu_percent FROM public.worker_heartbeats ORDER BY last_beat_at DESC LIMIT 1),
    'memory_used_mb', (SELECT memory_used_mb FROM public.worker_heartbeats ORDER BY last_beat_at DESC LIMIT 1),
    'memory_total_mb', (SELECT memory_total_mb FROM public.worker_heartbeats ORDER BY last_beat_at DESC LIMIT 1),
    'active_instances', (SELECT active_workers FROM public.worker_heartbeats ORDER BY last_beat_at DESC LIMIT 1),
    'min_instances', 1,
    'max_instances', 12,
    'autoscaling_status', v_autoscaling_status,
    'autoscaling_note', 'Dynamically balancing striped partitions across worker pool'
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.simulate_surge_load(uuid, integer) TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ops_metrics(uuid) TO postgres, authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';
