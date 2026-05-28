/**
 * Shared user-display formatters used across Account/Profile, Home greeting,
 * and any other surface that renders the signed-in user's name or phone.
 *
 * These are pure, side-effect-free helpers — safe to call from any component.
 * They are deliberately tolerant: missing/invalid input never throws, and
 * non-Kenyan phone strings are preserved unchanged so we don't mangle legit
 * international numbers if any are ever introduced.
 *
 * NOTE: These are display-only formatters. They MUST NOT be used as keys for
 * the ledger, payments, OTP, biometric, or any other server lookups — those
 * paths still resolve identity via `src/lib/userIdentity.js`.
 */

export const PHONE_NOT_LINKED_FALLBACK = 'Phone not linked';
export const DISPLAY_NAME_FALLBACK = 'Zuri Member';
export const GREETING_NAME_FALLBACK = 'there';

// ── Phone ──────────────────────────────────────────────────────────────────

/**
 * Format a Kenyan mobile number for display.
 *
 *   "254712345678"   → "+254 712 345 678"
 *   "+254712345678"  → "+254 712 345 678"
 *   "0712345678"     → "+254 712 345 678"
 *   "712345678"      → "+254 712 345 678"
 *   "+254 712 345 678" → "+254 712 345 678" (idempotent)
 *   null / undefined / ""  → PHONE_NOT_LINKED_FALLBACK
 *   "+15550100" (non-KE) → "+15550100" (preserved safely)
 *
 * @param {string | null | undefined} input
 * @returns {string}
 */
export function formatKenyanPhone(input) {
  if (input === null || input === undefined) return PHONE_NOT_LINKED_FALLBACK;
  const raw = String(input).trim();
  if (!raw) return PHONE_NOT_LINKED_FALLBACK;

  // Strip everything except digits and a leading '+'.
  const cleaned = raw.replace(/[^\d+]/g, '');

  // Reduce to the 9-digit local subscriber number (drop country code/prefix).
  let local9 = cleaned;
  if (local9.startsWith('+254')) local9 = local9.slice(4);
  else if (local9.startsWith('254')) local9 = local9.slice(3);
  else if (local9.startsWith('0')) local9 = local9.slice(1);

  // Kenyan mobile MSISDNs start with 7 or 1 and are exactly 9 digits.
  if (/^[71]\d{8}$/.test(local9)) {
    return `+254 ${local9.slice(0, 3)} ${local9.slice(3, 6)} ${local9.slice(6)}`;
  }

  // Not a recognizable Kenyan mobile — preserve the original safely.
  return raw;
}

// ── Display name ───────────────────────────────────────────────────────────

const NAME_BREAKPOINT_RE = /([-'.])/;
const NAME_WHITESPACE_RE = /(\s+)/;

function isEmailLike(value) {
  return /\S+@\S+/.test(value);
}

function isPhoneLike(value) {
  // Anything that's mostly digits (with optional +, spaces, dashes, parens)
  // should pass through untouched.
  const digits = (value.match(/\d/g) || []).length;
  return digits >= 4 && /^[+\d\s\-()]+$/.test(value);
}

function titleCaseSegment(seg) {
  if (!seg) return seg;
  return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
}

function titleCaseToken(token) {
  if (!token) return token;
  const isAllLower = token === token.toLowerCase();
  const isAllUpper = token === token.toUpperCase();
  // Preserve mixed-case tokens (e.g., "McDonald", "DeLong") as the user typed.
  if (!(isAllLower || isAllUpper)) return token;

  return token
    .split(NAME_BREAKPOINT_RE)
    .map(seg => (NAME_BREAKPOINT_RE.test(seg) && seg.length === 1 ? seg : titleCaseSegment(seg)))
    .join('');
}

/**
 * Format a user-display name.
 *
 *   "madhavarapu sandeep" → "Madhavarapu Sandeep"
 *   "MARY-JANE WATSON"    → "Mary-Jane Watson"
 *   "McDonald"            → "McDonald"            (preserved)
 *   "user@example.com"    → "user@example.com"    (email passthrough)
 *   "+254712345678"       → "+254712345678"       (phone passthrough)
 *   ""  / null / undefined → DISPLAY_NAME_FALLBACK
 *
 * @param {string | null | undefined} input
 * @returns {string}
 */
export function formatDisplayName(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DISPLAY_NAME_FALLBACK;
  if (isEmailLike(raw)) return raw;
  if (isPhoneLike(raw)) return raw;

  return raw
    .split(NAME_WHITESPACE_RE)
    .map(token => (/^\s+$/.test(token) ? ' ' : titleCaseToken(token)))
    .join('')
    .trim();
}

/**
 * Resolve the first name used in greetings ("Good morning, X").
 * Falls back to GREETING_NAME_FALLBACK so the greeting never says
 * "Good morning, Zuri Member" or "Good morning, undefined".
 *
 * @param {string | null | undefined} input
 * @returns {string}
 */
export function getFirstNameForGreeting(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return GREETING_NAME_FALLBACK;

  if (isEmailLike(raw)) {
    const local = raw.split('@')[0] || '';
    const cleaned = local.replace(/[._-]+/g, ' ').trim();
    if (!cleaned) return GREETING_NAME_FALLBACK;
    const first = cleaned.split(/\s+/)[0];
    return titleCaseToken(first) || GREETING_NAME_FALLBACK;
  }

  if (isPhoneLike(raw)) return GREETING_NAME_FALLBACK;

  const formatted = formatDisplayName(raw);
  if (!formatted || formatted === DISPLAY_NAME_FALLBACK) return GREETING_NAME_FALLBACK;
  const first = formatted.split(/\s+/)[0];
  return first || GREETING_NAME_FALLBACK;
}

/**
 * Build avatar initials (1–2 chars) from a name, with a stable fallback.
 *
 *   "madhavarapu sandeep" → "MS"
 *   "Mary-Jane Watson"    → "MW"
 *   "user@example.com"    → "U"
 *   null / "" → "U"
 */
export function getAvatarInitials(input, fallback = 'U') {
  const raw = String(input ?? '').trim();
  if (!raw) return fallback;
  const source = isEmailLike(raw) ? raw.split('@')[0] : raw;
  // Split only on whitespace and email-style separators (._+).
  // Keep hyphens intact so "Mary-Jane Watson" yields "MW", not "MJ".
  const tokens = source
    .replace(/[._+]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return fallback;
  const initials = tokens.map(t => t.charAt(0)).join('').slice(0, 2).toUpperCase();
  return initials || fallback;
}
