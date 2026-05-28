import { ledgerEntryDedupeKey } from '@/lib/localLedgerStore.js';

/**
 * @param {object} e
 * @returns {number}
 */
function entryTimeMs(e) {
  return Date.parse(String(e.created_date ?? e.created_at ?? '')) || 0;
}

/**
 * Prefer newest created_at; on tie prefer local. Optionally record when remote loses to newer merged row.
 * @param {object[]} localArr
 * @param {object[]} remoteArr
 * @param {{ onStaleRemote?: () => void } | null} telemetry
 * @returns {object[]}
 */
export function mergeLedgerArrays(localArr, remoteArr, telemetry) {
  const map = new Map();
  const put = (e, source) => {
    if (!e || typeof e !== 'object') return;
    const k = ledgerEntryDedupeKey(e);
    if (!k || k === '\0') return;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, e);
      return;
    }
    const tp = entryTimeMs(prev);
    const tn = entryTimeMs(e);
    if (tn > tp) {
      map.set(k, e);
      return;
    }
    if (tn < tp) {
      if (source === 'remote') {
        try {
          telemetry?.onStaleRemote?.();
        } catch {
          /* non-fatal */
        }
      }
      return;
    }
    if (source === 'local') {
      map.set(k, e);
    }
  };
  (localArr || []).forEach((x) => put(x, 'local'));
  (remoteArr || []).forEach((x) => put(x, 'remote'));
  return Array.from(map.values());
}
