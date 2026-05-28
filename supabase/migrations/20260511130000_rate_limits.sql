-- Distributed rate limiting table
-- Survives edge function restarts and works across instances
-- Tracks request counts per bucket key with sliding window

CREATE TABLE IF NOT EXISTS public.rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_key TEXT NOT NULL,
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('ip', 'phone', 'user', 'global')),
  endpoint TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_seconds INTEGER NOT NULL,
  max_requests INTEGER NOT NULL,
  blocked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(bucket_key, bucket_type, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_key_type_endpoint 
  ON public.rate_limits(bucket_key, bucket_type, endpoint);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start 
  ON public.rate_limits(window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_blocked_until 
  ON public.rate_limits(blocked_until) WHERE blocked_until IS NOT NULL;

-- Service-role only access (edge functions use service_role)
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage rate limits" ON public.rate_limits;
CREATE POLICY "Service role can manage rate limits"
  ON public.rate_limits FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Atomic rate-limit check function
-- Returns: { allowed: bool, remaining: int, retry_after_seconds: int, blocked: bool }
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_bucket_key TEXT,
  p_bucket_type TEXT,
  p_endpoint TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER,
  p_block_duration_seconds INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_record public.rate_limits%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_window_expired BOOLEAN;
  v_remaining INTEGER;
  v_retry_after INTEGER;
BEGIN
  -- Try to find existing bucket
  SELECT * INTO v_record
  FROM public.rate_limits
  WHERE bucket_key = p_bucket_key
    AND bucket_type = p_bucket_type
    AND endpoint = p_endpoint
  FOR UPDATE;

  -- Check if blocked
  IF v_record.blocked_until IS NOT NULL AND v_record.blocked_until > v_now THEN
    v_retry_after := EXTRACT(EPOCH FROM (v_record.blocked_until - v_now))::INTEGER;
    RETURN jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds', v_retry_after,
      'blocked', true,
      'reason', 'blocked_until_expired'
    );
  END IF;

  -- No existing bucket — create one
  IF NOT FOUND THEN
    INSERT INTO public.rate_limits (
      bucket_key, bucket_type, endpoint, request_count,
      window_start, window_seconds, max_requests
    ) VALUES (
      p_bucket_key, p_bucket_type, p_endpoint, 1,
      v_now, p_window_seconds, p_max_requests
    );
    RETURN jsonb_build_object(
      'allowed', true,
      'remaining', p_max_requests - 1,
      'retry_after_seconds', 0,
      'blocked', false
    );
  END IF;

  -- Check if window expired — reset counter
  v_window_expired := (v_record.window_start + (p_window_seconds || ' seconds')::INTERVAL) < v_now;

  IF v_window_expired THEN
    UPDATE public.rate_limits
    SET request_count = 1,
        window_start = v_now,
        window_seconds = p_window_seconds,
        max_requests = p_max_requests,
        blocked_until = NULL,
        updated_at = v_now
    WHERE id = v_record.id;
    RETURN jsonb_build_object(
      'allowed', true,
      'remaining', p_max_requests - 1,
      'retry_after_seconds', 0,
      'blocked', false
    );
  END IF;

  -- Window active — check count
  IF v_record.request_count >= p_max_requests THEN
    -- Limit exceeded — optionally block
    IF p_block_duration_seconds > 0 THEN
      UPDATE public.rate_limits
      SET blocked_until = v_now + (p_block_duration_seconds || ' seconds')::INTERVAL,
          updated_at = v_now
      WHERE id = v_record.id;
      v_retry_after := p_block_duration_seconds;
    ELSE
      v_retry_after := EXTRACT(EPOCH FROM (
        (v_record.window_start + (p_window_seconds || ' seconds')::INTERVAL) - v_now
      ))::INTEGER;
    END IF;

    RETURN jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds', v_retry_after,
      'blocked', p_block_duration_seconds > 0
    );
  END IF;

  -- Allowed — increment counter
  UPDATE public.rate_limits
  SET request_count = request_count + 1,
      updated_at = v_now
  WHERE id = v_record.id;

  v_remaining := p_max_requests - (v_record.request_count + 1);

  RETURN jsonb_build_object(
    'allowed', true,
    'remaining', GREATEST(v_remaining, 0),
    'retry_after_seconds', 0,
    'blocked', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup function for expired rate limit records
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.rate_limits
  WHERE window_start < NOW() - INTERVAL '1 hour'
    AND (blocked_until IS NULL OR blocked_until < NOW());
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.rate_limits IS 'Distributed rate limiting. Survives restarts and syncs across edge function instances.';
