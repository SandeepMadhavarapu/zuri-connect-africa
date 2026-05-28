# Deployment readiness — Vercel, Supabase, GitHub Actions

Operational checklist before treating an environment as production-grade.

## Content Security Policy (CSP)

- **Source of truth**: `index.html` includes a single `Content-Security-Policy` meta tag (Stripe and Base44 removed; Supabase https + wss; OpenAI, Anthropic, Gemini, Africa’s Talking sandbox in `connect-src`; `script-src` allows `cdnjs.cloudflare.com` per policy).
- **Vercel**: `vercel.json` repeats the **same** policy as an HTTP header, plus `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` (WebAuthn). Keep meta and header identical when editing.
- **Vite dev**: `vite.config.js` sets `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy` on the dev server only.
- **Violations**: the app records `csp_violation` client metrics on `securitypolicyviolation` events (no UI change).
- **Google Fonts**: `index.css` uses `@import` from `fonts.googleapis.com`; that origin is **not** in `style-src`. Browsers may block the stylesheet and fall back to system fonts unless you self-host fonts or extend CSP (outside current locked policy).

## Supabase

- [ ] Project created; **Settings → API** documents `URL` and `anon` `public` key.
- [ ] Migrations applied in order (see `supabase/migrations/README.md`).
- [ ] **Auth** providers configured as needed (email, phone, etc.).
- [ ] **RLS** verified: anon cannot read `ledger_entries` / `fraud_logs`; authenticated users scoped by `owner_id` / `user_id` per `20250510140000_fintech_rls_hardening.sql`.
- [ ] Edge Functions deployed if used (`supabase/functions/*`).
- [ ] No `service_role` key in frontend env (browser only gets `anon`).
- [ ] AI keys (`OPENAI_API_KEY`, etc.) only in **Edge secrets**, never `VITE_*`. Browser `connect-src` allows direct calls to AI APIs only if you move keys client-side (not recommended); production path is Edge `ai-router` → `https://*.supabase.co` only.

## Demo fallback (local / misconfigured non-strict)

- When `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are not valid **and** startup does not block the app, `src/lib/demoMode/` activates: idempotency keys use a `zuri_idmp_demo_` prefix and `demo_fallback_boot` telemetry fires.
- Set `VITE_DEMO_FALLBACK=false` to disable demo behaviors even without Supabase.
- Production deployments with missing secrets still show the structured startup screen from `validateEnv.js` (no React mount).

## Vercel (or static host)

- [ ] Framework preset: **Vite** (build command `npm run build`, output `dist`).
- [ ] Environment variables set for **Production** (and Preview if needed):
  - `VITE_SUPABASE_URL` — `https://<ref>.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` — project anon key (length typically ≥ 100 chars; app requires ≥ 20)
  - Optional: `VITE_APP_ENV=production`, `VITE_STRICT_ENV=true` for stricter client checks
  - Optional: `VITE_API_BASE_URL` — if set in staging/production, must be `https://...`
- [ ] SPA routing: `vercel.json` rewrites to `index.html`.
- [ ] Redeploy after changing env vars.

## GitHub Actions

- [ ] Repository secrets for optional live tests: `SUPABASE_STAGING_*` (see `docs/STAGING.md`).
- [ ] CI runs: lint, typecheck, `npm audit`, Vitest, Playwright, `scan:secrets`, build.

## Application startup

- [ ] Missing or invalid Supabase env in **production** or **`VITE_STRICT_ENV=true`**: structured startup message (no blank screen). See `src/config/validateEnv.js`.
- [ ] Auth bootstrap: timeouts and failsafe in `AuthContext` (no infinite loading).
- [ ] Telemetry: `startup_config_failure`, `supabase_session_failure`, `supabase_realtime_failure`, `supabase_client_init_ms`, `csp_violation`, `demo_fallback_boot`.

## Validation commands (local)

```bash
npm run validate:env:strict
npm run scan:secrets
npm run build
npm run test:ci
```

## Rollback

- Revert deployment in Vercel; database migrations are forward-only — plan manual downgrades only with DBA review.
