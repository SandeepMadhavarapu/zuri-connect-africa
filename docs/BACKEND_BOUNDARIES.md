# Backend authority boundaries — Zuri Connect Africa

This SPA intentionally separates **experience** (browser) from **trust** (Supabase Postgres + Edge Functions).

## Source of financial truth

| Concern | Authoritative layer | Notes |
|--------|---------------------|--------|
| Ledger postings | Postgres `ledger_entries` + application double-entry rules | Balances must be **derived** from entries, not cached wallet fields for reconciliation views. |
| Client ledger API | `ledgerService` via Supabase client | Inserts are **scoped by RLS** so rows must carry `owner_id = auth.uid()` on authenticated sessions. |
| Webhook authenticity | Edge Function `webhook-handler` | Validates optional **HMAC**, **timestamp skew**, **idempotency**, stores rows with **service role** (bypasses RLS). |
| Fraud scoring (authoritative) | `_shared/risk-engine.ts` called from `initiate-payment` | Persists `fraud_logs` / `risk_events` with **service role**. Single source of truth. |
| OTP / settlement recovery | Other Edge Functions | Must use **service role** only; never expose secrets to the browser. |

## Row-Level Security

Migration `20250510140000_fintech_rls_hardening.sql` replaces demo-wide-open ledger policies with:

- No **anon** reads/writes on `ledger_entries`.
- Authenticated users **insert** ledger rows only when `owner_id` matches `auth.uid()`.
- **Admin / fraud_analyst** roles (via `profiles.role`) can read the full ledger for ops dashboards.
- `webhook_events` visible only to **service role** (ingress pipeline).

Apply migrations after backing up any demo data you care about; tightening RLS may hide legacy rows without `owner_id` unless viewed by ops roles.

## Operational checklist

1. Set `WEBHOOK_HMAC_SECRET` for `webhook-handler`.
2. Deploy Edge Functions: `supabase functions deploy`.
3. Rotate secrets on a schedule; never embed **service role** keys in the SPA bundle.
4. Risk scoring is handled server-side by `_shared/risk-engine.ts` within `initiate-payment`; no separate fraud-analysis invocation is needed.
