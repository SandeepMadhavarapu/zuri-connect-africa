# Active migrations (Zuri Connect Africa + Supabase Auth)

Supabase CLI applies SQL files in this directory in **lexicographic filename order**.

## Production path (this repository)

Use **only** these migrations against a Supabase project that uses `auth.users` and `public.profiles`:

| Order | File | Purpose |
|-------|------|---------|
| 1 | `20250509000000_init_zuri_schema.sql` | Core schema: profiles, wallets, ledger, fraud, notifications, RLS baseline |
| 2 | `20250509120000_rls_profiles_trigger.sql` | Profile/wallet bootstrap triggers, JWT helpers, tightened policies |
| 3 | `20250510140000_fintech_rls_hardening.sql` | Finance RLS hardening: scoped ledger, fraud, webhooks, reconciliation |

This sequence is **deterministic** and **idempotent-friendly** (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` where appropriate).

## Legacy alternate schema (not combined with the path above)

The files under `../migrations_legacy/` describe a **standalone** `users` table model (not `auth.users`). **Do not** apply them to the same database as the `20250509*` chain — table and RLS models conflict.

For new environments, rely on the three timestamped migrations only.

## Fresh project checklist

1. Create Supabase project → note URL and anon key.
2. Link CLI (`supabase link`) or paste SQL in Dashboard in order above.
3. Confirm RLS enabled on finance tables (`ledger_entries`, `wallets`, `fraud_logs`, etc.).
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel (or host) and redeploy.
