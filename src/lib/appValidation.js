/**
 * App validation utilities
 * Validates critical app state and data integrity
 */

export function validateAppState() {
  const issues = [];
  
  // Check auth — Supabase stores session under sb-*-auth-token keys
  try {
    const hasSupabaseSession = Object.keys(localStorage).some(
      k => k.includes('-auth-token') || k.startsWith('sb-')
    );

    if (!hasSupabaseSession) {
      issues.push({
        type: 'info',
        msg: 'No active session — user not logged in',
      });
    }
  } catch (e) {
    issues.push({ type: 'error', msg: 'Storage access failed' });
  }
  
  // Check critical storage
  const criticalKeys = ['ledger_entries', 'budgetLimits', 'transactions'];
  criticalKeys.forEach(key => {
    try {
      const val = localStorage.getItem(key);
      if (!val) {
        issues.push({ type: 'info', msg: `${key} not yet initialized` });
      } else {
        // Try to parse
        try {
          JSON.parse(val);
        } catch {
          issues.push({ type: 'error', msg: `${key} is corrupted` });
        }
      }
    } catch (e) {
      issues.push({ type: 'error', msg: `Cannot access ${key}` });
    }
  });
  
  // Check network
  if (!navigator.onLine) {
    issues.push({ type: 'warning', msg: 'App is offline' });
  }
  
  return {
    timestamp: new Date().toISOString(),
    healthy: issues.filter(i => i.type === 'error').length === 0,
    errorCount: issues.filter(i => i.type === 'error').length,
    warningCount: issues.filter(i => i.type === 'warning').length,
    issues,
  };
}

export function validateNumberField(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (isNaN(num)) return { valid: false, error: 'Not a number' };
  if (num < min) return { valid: false, error: `Must be >= ${min}` };
  if (num > max) return { valid: false, error: `Must be <= ${max}` };
  return { valid: true, value: num };
}

export function validateArrayField(value) {
  if (!Array.isArray(value)) return { valid: false, error: 'Not an array' };
  if (value.length === 0) return { valid: true, value: [], empty: true };
  return { valid: true, value };
}

export function validateObjectField(value) {
  if (!value || typeof value !== 'object') return { valid: false, error: 'Not an object' };
  return { valid: true, value };
}

export function safeStringify(obj, fallback = '{}') {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    console.warn('[Safe Stringify] Failed:', e);
    return fallback;
  }
}

export function safeParseJSON(str, fallback = {}) {
  try {
    return JSON.parse(str);
  } catch (e) {
    console.warn('[Safe Parse] Failed:', e);
    return fallback;
  }
}

if (import.meta.env.MODE === 'development') {
  window.__validation = {
    validateAppState,
    issues: () => validateAppState().issues,
  };
}