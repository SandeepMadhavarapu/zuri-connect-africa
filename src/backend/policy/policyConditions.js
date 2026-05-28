/**
 * Policy Engine — Condition evaluation.
 *
 * Supports:
 *   - All 12 comparison operators
 *   - AND / OR / NOT condition groups (arbitrarily nested)
 *   - Dot-notation field paths  (e.g. "metadata.source")
 *   - Condition trace output for audit / debugging
 *   - Fail-safe: any evaluation error returns false (no crash)
 */

// ── Operator evaluators ────────────────────────────────────────────────────────

const EVALUATORS = {
  '==':         (a, b) => a === b || String(a) === String(b),
  '!=':         (a, b) => a !== b && String(a) !== String(b),
  '>':          (a, b) => Number(a) > Number(b),
  '>=':         (a, b) => Number(a) >= Number(b),
  '<':          (a, b) => Number(a) < Number(b),
  '<=':         (a, b) => Number(a) <= Number(b),
  'in':         (a, b) => Array.isArray(b) ? b.includes(a) : false,
  'not_in':     (a, b) => Array.isArray(b) ? !b.includes(a) : true,
  'contains':   (a, b) => typeof a === 'string' && a.toLowerCase().includes(String(b).toLowerCase()),
  'matches':    (a, b) => { try { return new RegExp(b).test(String(a)); } catch { return false; } },
  'exists':     (a)    => a !== undefined && a !== null && a !== '',
  'not_exists': (a)    => a === undefined || a === null || a === '',
};

// ── Field resolver ─────────────────────────────────────────────────────────────

function resolveField(context, field) {
  if (!field || typeof field !== 'string') return undefined;
  const parts = field.split('.');
  let val = context;
  for (const part of parts) {
    if (val === null || val === undefined) return undefined;
    val = val[part];
  }
  return val;
}

// ── Single rule evaluation ─────────────────────────────────────────────────────

function evalRule(rule, context) {
  const { field, operator, value } = rule;
  const fieldValue = resolveField(context, field);
  const evaluator  = EVALUATORS[operator];

  if (!evaluator) {
    console.warn(`[PolicyConditions] Unknown operator "${operator}" in rule for field "${field}"`);
    return false;
  }

  try {
    return Boolean(evaluator(fieldValue, value));
  } catch {
    return false;
  }
}

// ── Condition group evaluation (AND / OR / NOT) ────────────────────────────────

function evalGroup(group, context) {
  const { operator, rules } = group;

  if (!Array.isArray(rules) || rules.length === 0) return true;

  switch (operator) {
    case 'AND':
      return rules.every(r => ('rules' in r ? evalGroup(r, context) : evalRule(r, context)));

    case 'OR':
      return rules.some(r => ('rules' in r ? evalGroup(r, context) : evalRule(r, context)));

    case 'NOT':
      // NOT is true only when none of the child rules are true
      return !rules.some(r => ('rules' in r ? evalGroup(r, context) : evalRule(r, context)));

    default:
      console.warn(`[PolicyConditions] Unknown group operator "${operator}"`);
      return false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a policy's conditions against a context object.
 *
 * Accepts:
 *   - Array of flat rules  (all must pass — implicit AND)
 *   - { operator, rules }  condition group (AND / OR / NOT, nestable)
 *   - null / undefined     → always true (unconditional policy)
 *
 * Returns boolean. Never throws.
 */
export function evaluateConditions(conditions, context) {
  try {
    if (!conditions) return true;

    if (Array.isArray(conditions)) {
      return conditions.every(r => evalRule(r, context));
    }

    if (typeof conditions === 'object' && conditions.operator) {
      return evalGroup(conditions, context);
    }

    return true;
  } catch (err) {
    console.warn('[PolicyConditions] Evaluation error (safe fallback):', err.message);
    return false; // fail safe — don't trigger on error
  }
}

/**
 * Produce a human-readable trace of condition evaluation.
 * Useful for audit logs, policy debugger, and simulator UI.
 *
 * Returns an array of trace nodes, each describing:
 *   { type, field, operator, expected, actual, passed, depth }
 */
export function getConditionTrace(conditions, context) {
  function traceNode(node, depth = 0) {
    // Condition group
    if (node && typeof node === 'object' && 'rules' in node) {
      const children = (node.rules || []).map(r => traceNode(r, depth + 1));

      let passed;
      switch (node.operator) {
        case 'AND': passed = children.every(c => c.passed); break;
        case 'OR':  passed = children.some(c => c.passed);  break;
        case 'NOT': passed = !children.some(c => c.passed); break;
        default:    passed = false;
      }

      return { type: 'group', operator: node.operator, passed, depth, children };
    }

    // Leaf rule
    const { field, operator, value } = node || {};
    const fieldValue = resolveField(context, field);
    const evaluator  = EVALUATORS[operator];
    let passed = false;
    try { if (evaluator) passed = Boolean(evaluator(fieldValue, value)); } catch {}

    return {
      type:     'rule',
      field,
      operator,
      expected: value,
      actual:   fieldValue,
      passed,
      depth,
    };
  }

  try {
    if (!conditions) return [];
    if (Array.isArray(conditions)) return conditions.map(r => traceNode(r, 0));
    return [traceNode(conditions, 0)];
  } catch {
    return [];
  }
}

/**
 * Count how many rules exist within a condition definition (for complexity scoring).
 */
export function countConditionRules(conditions) {
  if (!conditions) return 0;

  function countNode(node) {
    if (!node) return 0;
    if ('rules' in node) return (node.rules || []).reduce((s, r) => s + countNode(r), 0);
    return 1;
  }

  if (Array.isArray(conditions)) return conditions.length;
  return countNode(conditions);
}
