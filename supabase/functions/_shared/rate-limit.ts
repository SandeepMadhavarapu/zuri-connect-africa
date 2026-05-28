export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  blocked: boolean;
};

export async function checkRateLimit(
  supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> },
  bucketKey: string,
  bucketType: 'ip' | 'phone' | 'user' | 'global',
  endpoint: string,
  maxRequests: number,
  windowSeconds: number,
  blockDurationSeconds = 0
): Promise<RateLimitResult> {
  try {
    const { data, error } = await supabaseAdmin.rpc('check_rate_limit', {
      p_bucket_key: bucketKey,
      p_bucket_type: bucketType,
      p_endpoint: endpoint,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
      p_block_duration_seconds: blockDurationSeconds,
    });
    if (error) {
      console.error('[rate_limit] RPC failed, blocking request:', error.message);
      return { allowed: false, remaining: 0, retryAfterSeconds: 60, blocked: true };
    }
    const row = data as Record<string, unknown>;
    return {
      allowed: Boolean(row.allowed),
      remaining: Number(row.remaining ?? 0),
      retryAfterSeconds: Number(row.retry_after_seconds ?? 60),
      blocked: Boolean(row.blocked),
    };
  } catch (e) {
    console.error('[rate_limit] Exception, blocking request:', (e as Error).message);
    return { allowed: false, remaining: 0, retryAfterSeconds: 60, blocked: true };
  }
}
