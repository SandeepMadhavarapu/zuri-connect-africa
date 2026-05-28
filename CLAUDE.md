# Zuri Connect Africa — engineering rules for Claude Code

## Project location
Always run from latest-best-version-60-main (the inner folder).

## Hard rules (NEVER violate)
- All money/payment logic lives in supabase/functions/. Never in src/.
- No VITE_* secrets. Server secrets via `npx supabase secrets set` only.
- Role = auth.users.app_metadata.role. Never read user_metadata for privilege.
- Ledger writes only via post_double_entry RPC, service_role only.
- Edge Function callbacks: IP allowlist + HMAC + nonces + idempotency required.
- Money is integer/decimal KES, never floats; client-supplied amounts are 
  always recomputed server-side.

## After every change
Run: `npm run lint && npm run build && npm run test:ci`
Before saying "done": run `npm run prepitch` and paste the output.

## Deployment commands
- Migrations: `npx supabase db push`
- Functions: `npx supabase functions deploy <name>`
- ai-router + send-otp: deploy with `--no-verify-jwt`
- Gemini model env: `GEMINI_MODEL=gemini-2.0-flash-lite` (rate-limit workaround)
- Local dev URL: http://localhost:5173/
- Test phone normalization: 0143305099 → +254143305099

## Deprecated (do not extend; will be deleted in Phase 5)
- src/backend/* (client-side localStorage fake backend)
- src/server/domain/* (same)
- src/lib/auditLogger.js, src/lib/settlementEngine.js, src/lib/queue.js,
  src/lib/observability/* — when used as data sources for admin UIs

## Reference docs
See AUDIT.md at repo root for the full audit, organized by section number.
When I say "implement §24.1" I mean the section in AUDIT.md.
