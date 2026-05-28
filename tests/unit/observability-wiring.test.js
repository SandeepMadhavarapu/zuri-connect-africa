import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mergeTraceHeaders } from '@/lib/observability/traceContext.js';
import { securityConfig } from '@/config/securityConfig.js';
import { obs, METRICS } from '@/lib/observability/index.js';
import { resetMetrics } from '@/lib/observability/metrics.js';

describe('observability wiring', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetMetrics();
    vi.restoreAllMocks();
  });

  it('mergeTraceHeaders preserves caller headers and adds correlation id', () => {
    sessionStorage.setItem('__zuri_trace_id__', 'corr-test-1');
    const h = mergeTraceHeaders({ 'content-type': 'application/json' });
    expect(h['content-type']).toBe('application/json');
    expect(h[securityConfig.correlationIdHeader]).toBe('corr-test-1');
  });

  it('obs.track records metric samples', () => {
    obs.track(METRICS.AUTH_FAILURE_COUNT, 1, { reason: 'unit' });
    const metrics = obs.getMetrics();
    const sample = metrics[METRICS.AUTH_FAILURE_COUNT];
    expect(sample).toBeTruthy();
    expect(sample.count).toBeGreaterThanOrEqual(1);
  });
});
