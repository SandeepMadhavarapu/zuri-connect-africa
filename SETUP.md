# ZuriConnect Africa - Local Setup

## Prerequisites
- Node.js 20+
- A Supabase project

## Setup Steps

1. Copy the local environment template:
   `cp .env.local.example .env.local`

2. Open `.env.local` and set only browser-safe Vite values:
   - `VITE_SUPABASE_URL`: Supabase dashboard, Project Settings, API
   - `VITE_SUPABASE_ANON_KEY`: Supabase dashboard, Project Settings, API
   - `VITE_APP_ENV`: `local`, `development`, `staging`, or `production`

   Never put service-role keys, Daraja credentials, AI provider keys, OTP secrets, or webhook signing secrets in `.env.local`. Browser builds expose `VITE_` values.

3. Install dependencies:
   `npm install`

4. Run the app:
   `npm run dev`

5. Optional: scan for accidentally committed secrets:
   `npm run check:secrets`

## Supabase Edge Function Secrets

Server-only secrets belong in Supabase, not browser env files:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
supabase secrets set DARAJA_CONSUMER_KEY=...
supabase secrets set DARAJA_CONSUMER_SECRET=...
supabase secrets set DARAJA_PASSKEY=...
supabase secrets set OPENAI_API_KEY=...
supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set GEMINI_API_KEY=...
```

AI calls must go through the `ai-router` Supabase Edge Function. Browser CSP blocks direct OpenAI, Anthropic, and Gemini API connections.

## Security Notes
- Never commit `.env`, `.env.local`, `.env.*.local`, or `supabase/.temp`
- Rotate your Supabase anon key immediately if it is ever exposed publicly
- Run `npm run check:secrets` before every commit

## Pre-pitch / Pre-deployment checklist

Run before every production / staging deployment or executive demo:

```bash
npm run prepitch          # lint + build + tests + env/security checks
```

`prepitch` will fail closed if any of these are wrong, so it is safe to
gate CI / release pipelines on it.

### Packaging — do NOT ship these
- `.env`, `.env.local`, `.env.*.local` (these contain real secrets — `.gitignore` already excludes them; double-check before zipping or sharing).
- `node_modules/` — never bundle into release archives; install on the target.
- `dist/` — only ship when you are deploying a pre-built static bundle; otherwise let the host build from source.
- `supabase/.temp/`, `supabase/.branches/` — local Supabase CLI state.
- Service-role keys, Daraja credentials, `OTP_PEPPER`, `PIN_PEPPER`, AI provider API keys, `MPESA_WEBHOOK_SECRET`, Africa's Talking API keys — none of these belong in any file checked into git or shipped to the browser.

### Production environment must have
- `VITE_APP_ENV=production` (or `staging`).
- `VITE_STRICT_ENV=true`.
- `VITE_ALLOW_CLIENT_DEMO_CONTROLS` unset or `false`.
- `VITE_SUPABASE_URL` set to your real `https://*.supabase.co` URL.
- `VITE_SUPABASE_ANON_KEY` (or `VITE_SUPABASE_PUBLISHABLE_KEY`) set.
- `APP_ORIGIN`, `APP_ENV`, `DARAJA_ENV`, `OTP_PEPPER`, `PIN_PEPPER`,
  `AT_USERNAME`, `AT_API_KEY`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`,
  `DARAJA_*`, and at least one AI provider key configured as
  **Supabase Edge Function secrets** (never as VITE_*).
- `WEBHOOK_SKIP_SIGNATURE` and `WEBHOOK_SKIP_IP_CHECK` unset (or anything
  other than `true`). The webhook handler refuses them in production.
- Webhook callback authenticity — exactly ONE of:
  - `MPESA_WEBHOOK_SECRET` set (a fronting gateway signs callbacks; HMAC
    verified), OR
  - `WEBHOOK_TRUSTED_SIGNING_PROXY=true` (an out-of-band gateway already
    authenticates every callback before it reaches the function).
  With neither set, the webhook handler fails closed at init (`503`) rather than
  `401`-ing every genuine Daraja callback.
- `WEBHOOK_TRUSTED_PROXY_DEPTH` — the number of trusted proxy hops that front
  the webhook function. The client IP is read as the Nth entry from the right of
  `X-Forwarded-For` (never the spoofable leftmost). Required in production; the
  handler fails closed at init (`503`) if it is unset.

### What `prepitch` checks
- `npm run lint` — code quality.
- `npm run build` — production build succeeds.
- `npm run test:ci` — full unit + integration test suite.
- `node scripts/validate-env.mjs --strict` — production env shape.
- `node scripts/check-prepitch.mjs` — VITE_* secret leakage scan, wildcard
  CORS scan on sensitive Edge Functions, packaging-checklist validation.
