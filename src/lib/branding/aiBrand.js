/**
 * Zuri Connect Africa — AI brand strings.
 *
 * Single source of truth for the assistant's user-facing name and copy.
 * Importing from here keeps the Account/Profile, Home, Budget, and AI page
 * surfaces consistent so the product never ships with a mixed brand voice
 * (e.g. "Safi AI", "Zuri AI advisor", "Financial Advisor").
 *
 * Product brand:    Zuri Connect Africa   (company / app name — UNCHANGED)
 * Assistant brand:  Duke AI               (the AI assistant the user talks to)
 *
 * Use AI_BRAND.* anywhere you would otherwise hard-code an assistant label
 * or unavailable-state message.
 */

export const AI_BRAND = Object.freeze({
  /** Assistant short name — shown in chat bubbles, badges, nav. */
  name: 'Duke AI',

  /** Chat header label on the /ai page. */
  copilotHeader: 'Duke AI Copilot',

  /** Budget page deep-analysis card title. */
  budgetIntelligence: 'Duke AI Budget Intelligence',

  /** Section / tab label inside Budget & Insights. */
  insightsTab: 'Duke AI Insights',

  /** Top bar route title for /ai. */
  routeTitle: 'Duke AI Copilot',

  /** BottomNav compact label for /ai. */
  navLabel: 'Duke AI',

  /** Quick action label for /ai. */
  quickActionLabel: 'Duke AI',

  /** Thinking indicator copy. */
  thinkingLabel: 'Duke AI is thinking',

  /** Generic "ask the assistant" CTA. */
  askCta: 'Ask Duke AI',

  /** Voice intent fallback label. */
  voiceFallbackLabel: 'Duke AI',
});

/**
 * Polished, pitch-safe fallback strings shown when AI providers are
 * unavailable or returning empty/invalid responses. NEVER show raw
 * "AI service" / "AI systems" copy in production — it implies the app
 * is broken.
 *
 * Behaviour is preserved (retry buttons stay; we do not fake responses).
 */
export const AI_FALLBACK = Object.freeze({
  /** Default polite message when the chat assistant is unreachable. */
  chatUnavailable:
    'Duke AI is reconnecting. Please try again in a moment.',

  /** Budget page: keep the static spending alerts visible underneath. */
  budgetUnavailable:
    'Duke AI is preparing your latest budget insight. Your spending alerts are still available below.',

  /** Empty / invalid AI response — same friendly framing. */
  budgetEmpty:
    'Duke AI is preparing your latest budget insight. Your spending alerts are still available below.',

  /** Configuration missing (e.g. no Supabase URL) — surface a polite note. */
  budgetConfigMissing:
    'Duke AI insights need a live connection. Your spending alerts are still available below.',

  /** Generic retry CTA copy. */
  retryCta: 'Try again',
});
