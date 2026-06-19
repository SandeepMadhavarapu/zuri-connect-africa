/**
 * Hesabu — chama treasury visual identity.
 *
 * Single source of truth for the Hesabu theme constants (the dark, ledger-first
 * identity used on the /chama subtree). This sits alongside [[aiBrand]] as part
 * of the existing branding seam. The colour values here MIRROR the CSS variables
 * defined under `.hesabu-theme` in src/index.css — keep the two in sync.
 *
 * Importing from here keeps copy + palette consistent across the chama surfaces
 * and gives non-Tailwind contexts (charts, canvas, inline styles) typed access
 * to the same tokens the utilities use.
 */

export const HESABU_BRAND = Object.freeze({
  /** Product wordmark for the chama experience. */
  name: 'Hesabu',
  /** Primary tagline shown under the wordmark. */
  tagline: 'The chama treasury you can audit.',
});

/**
 * Hesabu palette. Mirrors the `--hesabu-*` CSS vars in src/index.css.
 * Prefer the Tailwind `hesabu.*` utilities in components; use these constants
 * only where utilities don't reach (canvas, charts, inline SVG fills).
 */
export const HESABU_COLORS = Object.freeze({
  ink: '#0C1410',          // app background — warm green-black
  surface: '#1E3127',      // cards / raised
  surface2: '#2A4033',     // hover / nested
  paper: '#E8E4D8',        // primary text — warm off-white
  muted: '#8A9690',        // secondary text
  emerald: '#1F9D6B',      // primary action, money, trust
  emeraldDim: '#137A51',   // pressed / hover
  brass: '#C9A227',        // settled / confirmed states ONLY, sparing
  line: '#2F4A3C',         // hairline borders — ledger rules
  danger: '#D9534F',       // overdue / failed
});

/** Font stacks used by the Hesabu identity. */
export const HESABU_FONTS = Object.freeze({
  display: "'Space Grotesk', sans-serif", // headings, balances
  body: "'Inter', sans-serif",            // body copy
  mono: "'JetBrains Mono', ui-monospace, monospace", // money + ledger entries
});

/**
 * Format an integer amount in cents to a KES display string.
 *
 *   formatKesFromCents(123456)        → "KES 1,234.56"
 *   formatKesFromCents(50000)         → "KES 500.00"
 *   formatKesFromCents(123456, {      → "1,234.56"
 *     withSymbol: false })
 *   formatKesFromCents(null)          → "KES —"
 *
 * Money is integer cents here (matching the chama settlement RPCs); the value is
 * never a float in storage. No shared cents→KES formatter exists in the repo
 * today (Zuri stores integer KES and formats inline), so this is intentionally
 * self-contained rather than duplicating an existing helper.
 *
 * @param {number | string | null | undefined} cents
 * @param {{ withSymbol?: boolean }} [opts]
 * @returns {string}
 */
export function formatKesFromCents(cents, { withSymbol = true } = {}) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return withSymbol ? 'KES —' : '—';

  const formatted = (n / 100).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return withSymbol ? `KES ${formatted}` : formatted;
}

/**
 * Count-aware noun for display strings.
 *
 *   pluralize(1, 'member')          → "1 member"
 *   pluralize(3, 'member')          → "3 members"
 *   pluralize(1, 'chama', 'chamas') → "1 chama"
 *
 * Defaults the plural to `${singular}s`; pass an explicit plural for irregulars.
 * Returns the count alongside the noun so call sites don't re-interpolate.
 *
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
