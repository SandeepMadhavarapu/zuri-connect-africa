import { securityConfig } from '@/config/securityConfig.js';

const TRACE_KEY = '__zuri_trace_id__';

export function getCorrelationId() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    let id = sessionStorage.getItem(TRACE_KEY);
    if (!id && typeof crypto !== 'undefined' && crypto.randomUUID) {
      id = crypto.randomUUID();
      sessionStorage.setItem(TRACE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export function setCorrelationId(id) {
  if (typeof sessionStorage === 'undefined' || !id) return;
  try {
    sessionStorage.setItem(TRACE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function mergeTraceHeaders(headers = {}) {
  const next = { ...headers };
  const key = securityConfig.correlationIdHeader;
  if (!next[key]) {
    const cid = getCorrelationId();
    if (cid) next[key] = cid;
  }
  return next;
}
