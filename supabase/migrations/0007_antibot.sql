-- supabase/migrations/0007_antibot.sql
-- Anti-Bot & Rate Limiting protection: IP/User request rate tracking, double-click protection & cooldowns

CREATE TABLE IF NOT EXISTS public.rate_limit_records (
  key TEXT PRIMARY KEY,               -- e.g. "ip:1.2.3.4" or "user:uuid"
  request_count INT NOT NULL DEFAULT 1,
  first_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooldown_until TIMESTAMPTZ
);

ALTER TABLE public.rate_limit_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on rate_limit_records"
  ON public.rate_limit_records FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Anti-bot validation RPC: checks sliding rate limits & cooldowns
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_requests INT DEFAULT 10,
  p_window_seconds INT DEFAULT 60,
  p_cooldown_seconds INT DEFAULT 15
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec public.rate_limit_records%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_allowed BOOLEAN := true;
  v_retry_after INT := 0;
BEGIN
  SELECT * INTO v_rec FROM public.rate_limit_records WHERE key = p_key FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.rate_limit_records (key, request_count, first_request_at, last_request_at)
    VALUES (p_key, 1, v_now, v_now);
    RETURN jsonb_build_object('allowed', true, 'remaining', p_max_requests - 1);
  END IF;

  -- Check active cooldown
  IF v_rec.cooldown_until IS NOT NULL AND v_rec.cooldown_until > v_now THEN
    v_retry_after := EXTRACT(EPOCH FROM (v_rec.cooldown_until - v_now))::INT;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown_active',
      'retry_after', v_retry_after
    );
  END IF;

  -- Check if rate window has rolled over
  IF v_now - v_rec.first_request_at > (p_window_seconds || ' seconds')::INTERVAL THEN
    UPDATE public.rate_limit_records
    SET request_count = 1,
        first_request_at = v_now,
        last_request_at = v_now,
        cooldown_until = NULL
    WHERE key = p_key;
    RETURN jsonb_build_object('allowed', true, 'remaining', p_max_requests - 1);
  END IF;

  -- Check request threshold violation
  IF v_rec.request_count >= p_max_requests THEN
    UPDATE public.rate_limit_records
    SET cooldown_until = v_now + (p_cooldown_seconds || ' seconds')::INTERVAL,
        last_request_at = v_now
    WHERE key = p_key;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limit_exceeded',
      'retry_after', p_cooldown_seconds
    );
  END IF;

  -- Increment count
  UPDATE public.rate_limit_records
  SET request_count = request_count + 1,
      last_request_at = v_now
  WHERE key = p_key;

  RETURN jsonb_build_object(
    'allowed', true,
    'remaining', p_max_requests - (v_rec.request_count + 1)
  );
END;
$$;
