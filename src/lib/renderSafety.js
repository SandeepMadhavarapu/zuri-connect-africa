/**
 * Zuri Connect Africa — Render Safety Utilities
 * Defensive guards for common render crash scenarios
 */

export function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

export function safeObject(val) {
  return val && typeof val === 'object' ? val : {};
}

export function safeString(val) {
  return typeof val === 'string' ? val : '';
}

export function safeNumber(val, defaultVal = 0) {
  const n = Number(val);
  return isFinite(n) ? n : defaultVal;
}

export function safeReduce(arr, fn, initial = 0) {
  return safeArray(arr).reduce(fn, initial);
}

export function safeMap(arr, fn) {
  return safeArray(arr).map(fn).filter(Boolean);
}

export function safeFilter(arr, fn) {
  return safeArray(arr).filter(fn);
}

export function safeAsync(promise, fallback = null) {
  return Promise.resolve(promise).catch(e => {
    console.warn('[RenderSafety] Async error:', e);
    return fallback;
  });
}

export function safeCall(fn, args = [], fallback = null) {
  try {
    return typeof fn === 'function' ? fn(...safeArray(args)) : fallback;
  } catch (e) {
    console.warn('[RenderSafety] Call error:', e);
    return fallback;
  }
}

export async function safeAwait(promise, fallback = null, timeout = 5000) {
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
    ]);
  } catch (e) {
    console.warn('[RenderSafety] Await error:', e);
    return fallback;
  }
}

/**
 * Safe balance calculations with guard rails
 */
export function calculateBalance(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const latest = entries[entries.length - 1];
  return safeNumber(latest?.balanceAfter, 0);
}

/**
 * Safe spending aggregation
 */
export function aggregateSpending(transactions = []) {
  return safeArray(transactions).reduce((acc, tx) => {
    if (!tx || typeof tx.amount !== 'number') return acc;
    const key = tx.category || 'other';
    acc[key] = safeNumber(acc[key], 0) + Math.abs(tx.amount);
    return acc;
  }, {});
}

/**
 * Safe percentage calculation
 */
export function calculatePercentage(part = 0, total = 0) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((safeNumber(part, 0) / safeNumber(total, 1)) * 100));
}

/**
 * Safe array access
 */
export function safeGet(obj, path, defaultVal = null) {
  try {
    return path.split('.').reduce((v, k) => v?.[k], obj) ?? defaultVal;
  } catch {
    return defaultVal;
  }
}