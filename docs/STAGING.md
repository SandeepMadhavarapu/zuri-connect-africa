# Staging environment (Zuri Connect Africa)

For production-style deployment checks (Vercel, CI, RLS), see [DEPLOYMENT_READINESS.md](./DEPLOYMENT_READINESS.md).

This document describes how to run a **telecom-fintech–realistic** Supabase staging project alongside the web app, without changing product UX or routing.

## 1. Supabase project

1. Create a dedicated Supabase project (staging).
2. Apply migrations in `supabase/migrations/` in timestamp order (CLI or Dashboard).
3. In **Authentication → Users**, create at least one password user for integration tests (e.g. `staging-qa@example.com`).
4. Ensure `public.profiles` has a row for that user (`id` = `auth.users.id`, `role` = `customer` or `admin` as needed).

## 2. Seed demo data

Run `supabase/seed/staging_demo.sql` in the **SQL Editor** as `postgres`. It inserts reconciliation anomalies, fraud logs, and risk events. Uncomment and edit the ledger / notification sections after you know the staging user UUID (`auth.users.id`).

## 3. GitHub Actions (live RLS checks)

Add repository **secrets**:

| Secret | Purpose |
|--------|---------|
| `SUPABASE_STAGING_URL` | Project URL (`https://….supabase.co`) |
| `SUPABASE_STAGING_ANON_KEY` | Anon (public) key |
| `SUPABASE_STAGING_TEST_EMAIL` | Password user for tests |
| `SUPABASE_STAGING_TEST_PASSWORD` | Password for that user |

Vitest file `tests/integration/supabase-staging.test.js` runs **only** when all four are present; otherwise it skips and the suite still passes locally/CI.

## 4. Frontend environment

Point the Vite app at staging with your usual `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (or copy from `.env.staging.example` if present in the repo). Never commit service-role keys or production secrets.

**Playwright:** local `.env.local` can override mode-specific env files. The Playwright web server forces safe placeholder `VITE_*` values when it runs `vite build --mode e2e` so E2E stays deterministic; use `.env.e2e` for defaults when building manually.

## 5. Operational checks

- **RLS:** Anonymous clients must see zero `ledger_entries` rows; authenticated users see only `owner_id = auth.uid()::text` unless `admin` / `fraud_analyst`.
- **Idempotency:** Client retries use the same idempotency key; stress coverage lives under `tests/stress/`.
- **Webhooks:** Signature + payload-hash verification tests are under `tests/security/`.
