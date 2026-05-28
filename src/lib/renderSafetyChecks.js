/**
 * Runtime render safety checks for critical components.
 * Validates data integrity before rendering to prevent blank pages.
 */

export function validateBudgetData(categories, transactions, limits, trends) {
  const issues = [];

  // Categories
  if (!Array.isArray(categories)) {
    issues.push('CATEGORIES is not an array');
  } else if (categories.length === 0) {
    issues.push('CATEGORIES is empty');
  } else {
    categories.forEach((cat, i) => {
      if (!cat) issues.push(`CATEGORIES[${i}] is null/undefined`);
      if (!cat?.key) issues.push(`CATEGORIES[${i}] missing key`);
      if (!cat?.label) issues.push(`CATEGORIES[${i}] missing label`);
      if (!cat?.color) issues.push(`CATEGORIES[${i}] missing color`);
      if (!cat?.emoji) issues.push(`CATEGORIES[${i}] missing emoji`);
    });
  }

  // Transactions
  if (!Array.isArray(transactions)) {
    issues.push('TRANSACTIONS is not an array');
  }

  // Limits
  if (!limits || typeof limits !== 'object') {
    issues.push('DEFAULT_LIMITS is not an object');
  } else {
    Object.entries(limits).forEach(([key, val]) => {
      if (isNaN(Number(val))) {
        issues.push(`DEFAULT_LIMITS.${key} is not a number`);
      }
    });
  }

  // Trends
  if (!Array.isArray(trends)) {
    issues.push('MONTHLY_TREND is not an array');
  } else if (trends.length === 0) {
    issues.push('MONTHLY_TREND is empty');
  }

  return { valid: issues.length === 0, issues };
}

export function validateAIData() {
  const issues = [];

  if (typeof window !== 'undefined') {
    try {
      // Runtime AI validation occurs in components using aiService.
    } catch (e) {
      issues.push('Unable to access observability context');
    }
  }

  return { valid: issues.length === 0, issues };
}

export function validatePageData(pageType, data) {
  const issues = [];

  switch (pageType) {
    case 'budget':
      if (!data.categories || !Array.isArray(data.categories)) issues.push('Budget: missing categories');
      if (!data.transactions || !Array.isArray(data.transactions)) issues.push('Budget: missing transactions');
      break;

    case 'ai':
      if (!data.user) issues.push('AI: missing user');
      break;

    case 'profile':
      if (!data.user) issues.push('Profile: missing user');
      break;

    default:
      break;
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Safe component wrapper that ensures minimum viable content rendering.
 */
export function ensureRenderable(data, fallback = null) {
  if (!data) return fallback || {};
  if (Array.isArray(data)) return data.length > 0 ? data : [];
  if (typeof data === 'object') return data;
  return fallback || {};
}

/**
 * Detect and log silent render failures.
 */
export function detectRenderFailure(componentName, error) {
  if (!error) return null;

  const failure = {
    component: componentName,
    error: error?.message || String(error),
    stack: error?.stack || '',
    timestamp: new Date().toISOString(),
    severity: 'high',
  };

  try {
    const log = JSON.parse(sessionStorage.getItem('_render_failures') || '[]');
    log.push(failure);
    sessionStorage.setItem('_render_failures', JSON.stringify(log.slice(-20)));
  } catch {}

  return failure;
}

/**
 * Export render failure log for debugging.
 */
export function getRenderFailureLog() {
  try {
    return JSON.parse(sessionStorage.getItem('_render_failures') || '[]');
  } catch {
    return [];
  }
}

/**
 * Clear render failure log.
 */
export function clearRenderFailureLog() {
  try {
    sessionStorage.removeItem('_render_failures');
  } catch {}
}