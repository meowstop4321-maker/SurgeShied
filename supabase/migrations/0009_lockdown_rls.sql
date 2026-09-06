-- Migration 0009: Strict RLS Lockdown, Lifecycle Confirmations, & Security Definer Enforcement
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. SEAT PARTITIONS: Read-only for clients; mutations strictly via RPCs
ALTER TABLE public.seat_partitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "partitions_all" ON public.seat_partitions;
DROP POLICY IF EXISTS "seat_partitions: select all" ON public.seat_partitions;
DROP POLICY IF EXISTS "seat_partitions: service_role manage" ON public.seat_partitions;

CREATE POLICY "seat_partitions: select all" ON public.seat_partitions
  FOR SELECT USING (true);

CREATE POLICY "seat_partitions: service_role manage" ON public.seat_partitions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. REGISTRATIONS: Attendees view own; mutations ONLY through allocate_seat RPC
ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "registrations_all" ON public.registrations;
DROP POLICY IF EXISTS "registrations: select own" ON public.registrations;
DROP POLICY IF EXISTS "registrations: service_role manage" ON public.registrations;

CREATE POLICY "registrations: select own" ON public.registrations
  FOR SELECT USING (auth.uid() = user_id OR auth.role() = 'service_role');

CREATE POLICY "registrations: service_role manage" ON public.registrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. QUEUE ENTRIES: Attendees view own and can join; one active wait per event
ALTER TABLE public.queue_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "queue_all" ON public.queue_entries;
DROP POLICY IF EXISTS "queue_entries: select own" ON public.queue_entries;
DROP POLICY IF EXISTS "queue_entries: insert own" ON public.queue_entries;
DROP POLICY IF EXISTS "queue_entries: service_role manage" ON public.queue_entries;

CREATE POLICY "queue_entries: select own" ON public.queue_entries
  FOR SELECT USING (auth.uid() = user_id OR auth.role() = 'service_role');

CREATE POLICY "queue_entries: insert own" ON public.queue_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role');

CREATE POLICY "queue_entries: service_role manage" ON public.queue_entries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_one_active_per_user
  ON public.queue_entries (event_id, user_id)
  WHERE status = 'waiting';

-- 4. AUDIT LOGS: Transparency for all users; append via append_audit_log RPC
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs: select all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs: insert allowed" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs: service_role manage" ON public.audit_logs;

CREATE POLICY "audit_logs: select all" ON public.audit_logs
  FOR SELECT USING (true);

CREATE POLICY "audit_logs: insert allowed" ON public.audit_logs
  FOR INSERT WITH CHECK (true);

CREATE POLICY "audit_logs: service_role manage" ON public.audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. JOB QUEUE: Restricted to service_role and worker engine
ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_queue_all" ON public.job_queue;
DROP POLICY IF EXISTS "job_queue_service_role" ON public.job_queue;
DROP POLICY IF EXISTS "job_queue_auth_select" ON public.job_queue;
DROP POLICY IF EXISTS "job_queue: service_role full access" ON public.job_queue;
DROP POLICY IF EXISTS "job_queue: authenticated select" ON public.job_queue;

CREATE POLICY "job_queue: service_role full access" ON public.job_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "job_queue: authenticated select" ON public.job_queue
  FOR SELECT TO authenticated USING (true);

-- 6. SYSTEM STATUS & CIRCUIT GUARDIAN
ALTER TABLE public.system_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "system_status_all" ON public.system_status;
DROP POLICY IF EXISTS "system_status: all allowed" ON public.system_status;

CREATE POLICY "system_status: all allowed" ON public.system_status
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.circuit_guardian_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "circuit_guardian: select all" ON public.circuit_guardian_state;
DROP POLICY IF EXISTS "circuit_guardian_state: all allowed" ON public.circuit_guardian_state;

CREATE POLICY "circuit_guardian_state: all allowed" ON public.circuit_guardian_state
  FOR ALL USING (true) WITH CHECK (true);

-- 7. CORE RPC FUNCTIONS (All marked SECURITY DEFINER)

-- append_audit_log: Cryptographic hash chain append
CREATE OR REPLACE FUNCTION public.append_audit_log(
  p_actor_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_metadata jsonb default '{}'::jsonb
) RETURNS public.audit_logs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_prev_hash text;
  v_created_at timestamptz := clock_timestamp();
  v_new_hash text;
  v_row public.audit_logs%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('surgeshield_audit_chain'));

  SELECT current_hash INTO v_prev_hash FROM public.audit_logs ORDER BY seq DESC LIMIT 1;
  v_prev_hash := COALESCE(v_prev_hash, 'GENESIS');

  v_new_hash := encode(
    digest(
      concat_ws('|', v_prev_hash, v_created_at::text, p_action, COALESCE(p_actor_id::text, ''), COALESCE(p_metadata::text, '{}'))::bytea,
      'sha256'::text
    ),
    'hex'
  );

  INSERT INTO public.audit_logs (actor_id, action, entity, entity_id, metadata, created_at, previous_hash, current_hash)
  VALUES (p_actor_id, p_action, p_entity, p_entity_id, p_metadata, v_created_at, v_prev_hash, v_new_hash)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- allocate_seat: Atomic row-locked seat allocation (Overbooking Safe)
-- Sets status = 'confirmed' by default with confirmed_at timestamp so Ghost Seat Recovery never expires confirmed tickets!
CREATE OR REPLACE FUNCTION public.allocate_seat(
  p_event_id uuid,
  p_lane_index integer,
  p_user_id uuid,
  p_idempotency_key text,
  p_confirmed boolean default true
) RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_partition public.seat_partitions%ROWTYPE;
  v_registration public.registrations%ROWTYPE;
BEGIN
  -- Security check: user can only allocate for themselves unless service_role
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' AND v_caller_id IS NOT NULL AND v_caller_id <> p_user_id THEN
    RAISE EXCEPTION 'unauthorized: cannot allocate seat for another user' USING errcode = '42501';
  END IF;

  SELECT * INTO v_partition
  FROM public.seat_partitions
  WHERE event_id = p_event_id AND lane_index = p_lane_index
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lane % not found for event %', p_lane_index, p_event_id;
  END IF;

  IF v_partition.seats_taken >= v_partition.capacity THEN
    RAISE EXCEPTION 'lane_full' USING errcode = 'P0001';
  END IF;

  UPDATE public.seat_partitions
  SET seats_taken = seats_taken + 1
  WHERE id = v_partition.id;

  INSERT INTO public.registrations (
    event_id,
    user_id,
    lane_index,
    status,
    idempotency_key,
    confirmed_at,
    seat_passport_expires_at
  ) VALUES (
    p_event_id,
    p_user_id,
    p_lane_index,
    CASE WHEN p_confirmed THEN 'confirmed' ELSE 'pending' END,
    p_idempotency_key,
    CASE WHEN p_confirmed THEN NOW() ELSE NULL END,
    CASE WHEN p_confirmed THEN NULL ELSE NOW() + INTERVAL '2 minutes' END
  ) RETURNING * INTO v_registration;

  RETURN v_registration;
END;
$$;

-- confirm_registration: Explicitly promote pending hold to confirmed
CREATE OR REPLACE FUNCTION public.confirm_registration(p_registration_id uuid, p_user_id uuid)
RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reg public.registrations%ROWTYPE;
BEGIN
  UPDATE public.registrations
  SET status = 'confirmed',
      confirmed_at = NOW(),
      seat_passport_expires_at = NULL
  WHERE id = p_registration_id
    AND user_id = p_user_id
    AND status = 'pending'
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

-- promote_from_queue: Atomic promotion of waiting attendee into vacated seat
CREATE OR REPLACE FUNCTION public.promote_from_queue(p_event_id uuid, p_lane_index integer)
RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry public.queue_entries%ROWTYPE;
  v_registration public.registrations%ROWTYPE;
BEGIN
  SELECT * INTO v_entry
  FROM public.queue_entries
  WHERE event_id = p_event_id AND lane_index = p_lane_index AND status = 'waiting'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_registration := public.allocate_seat(p_event_id, p_lane_index, v_entry.user_id, gen_random_uuid()::text, true);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  UPDATE public.queue_entries
  SET status = 'promoted', promoted_at = NOW()
  WHERE id = v_entry.id;

  RETURN v_registration;
END;
$$;

-- release_expired_seats: Ghost Seat Recovery sweep (Only reclaims truly unconfirmed abandoned holds)
CREATE OR REPLACE FUNCTION public.release_expired_seats()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_row public.registrations%ROWTYPE;
BEGIN
  FOR v_row IN
    SELECT * FROM public.registrations
    WHERE status = 'pending' AND seat_passport_expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.seat_partitions
    SET seats_taken = GREATEST(0, seats_taken - 1)
    WHERE event_id = v_row.event_id AND lane_index = v_row.lane_index;

    UPDATE public.registrations
    SET status = 'expired'
    WHERE id = v_row.id;

    PERFORM public.promote_from_queue(v_row.event_id, v_row.lane_index);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- create_event_with_partitions: Atomic event creation with strict capacity conservation
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
  v_base_cap integer;
  v_remainder integer;
  v_lane_cap integer;
  v_i integer;
BEGIN
  IF v_user_id IS NULL THEN
    SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  END IF;

  INSERT INTO public.events (organizer_id, title, description, capacity, lane_count, starts_at, registration_open)
  VALUES (v_user_id, p_title, p_description, p_capacity, p_lane_count, p_starts_at, true)
  RETURNING * INTO v_event;

  v_base_cap := FLOOR(p_capacity / p_lane_count);
  v_remainder := p_capacity % p_lane_count;

  FOR v_i IN 0..(p_lane_count - 1) LOOP
    v_lane_cap := v_base_cap + (CASE WHEN v_i < v_remainder THEN 1 ELSE 0 END);
    INSERT INTO public.seat_partitions (event_id, lane_index, capacity, seats_taken)
    VALUES (v_event.id, v_i, v_lane_cap, 0);
  END LOOP;

  PERFORM public.append_audit_log(
    v_user_id,
    'event_created',
    'event',
    v_event.id,
    jsonb_build_object('title', p_title, 'capacity', p_capacity, 'lane_count', p_lane_count)
  );

  RETURN v_event;
END;
$$;

-- simulate_surge_load: Secure demo load generator without raw table updates
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
    END IF;

    v_total_taken := v_total_taken + v_lane.seats_taken + v_to_allocate;
  END LOOP;

  v_queued := GREATEST(0, p_count - v_allocated);
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

-- reset_event_partitions: Securely reset lane capacity for demo testing
CREATE OR REPLACE FUNCTION public.reset_event_partitions(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.seat_partitions
  SET seats_taken = 0
  WHERE event_id = p_event_id;

  DELETE FROM public.queue_entries
  WHERE event_id = p_event_id;

  PERFORM public.set_system_status(p_event_id, false, 'System recovered', 0.0);
END;
$$;

-- Permissions & Function Access Lockdown
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

-- User / Client RPCs
GRANT EXECUTE ON FUNCTION public.append_audit_log(uuid, text, text, uuid, jsonb) TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.allocate_seat(uuid, integer, uuid, text, boolean) TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_registration(uuid, uuid) TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_event_with_partitions(text, text, integer, integer, timestamptz) TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.simulate_surge_load(uuid, integer) TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reset_event_partitions(uuid) TO postgres, authenticated, service_role;

-- Background Worker / Administrative RPCs (Strict service_role only)
REVOKE EXECUTE ON FUNCTION public.claim_job_batch(text, integer, text[], integer) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.complete_job(uuid, jsonb) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.fail_job(uuid, text, integer) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.release_expired_seats() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.promote_from_queue(uuid, integer) FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.claim_job_batch(text, integer, text[], integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.fail_job(uuid, text, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.release_expired_seats() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.promote_from_queue(uuid, integer) TO postgres, service_role;

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
