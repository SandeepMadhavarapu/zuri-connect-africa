-- Zuri Connect Africa — core telecom/fintech schema (Supabase Postgres)

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Profiles & wallets ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  phone TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'KES',
  balance_cached NUMERIC(18, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user ON public.wallets (user_id);

-- ── Immutable ledger (append-only via application rules) ─────────────────────
CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_ref TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit')),
  amount NUMERIC(18, 4) NOT NULL,
  balance_before NUMERIC(18, 4) NOT NULL,
  balance_after NUMERIC(18, 4) NOT NULL,
  account_phone TEXT NOT NULL,
  description TEXT DEFAULT '',
  hash TEXT NOT NULL,
  owner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_tx ON public.ledger_entries (transaction_ref);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON public.ledger_entries (account_phone);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON public.ledger_entries (created_at DESC);

-- ── Reconciliation ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reconciliation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date DATE NOT NULL,
  total_debits NUMERIC(24, 4) NOT NULL,
  total_credits NUMERIC(24, 4) NOT NULL,
  difference NUMERIC(24, 4) NOT NULL,
  status TEXT NOT NULL,
  entries_checked INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recon_created ON public.reconciliation_logs (created_at DESC);

-- ── OTP (Edge Functions only — no client access) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.otp_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expiry BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON public.otp_records (phone);

-- ── Fraud, notifications, sessions, events (foundation) ─────────────────────
CREATE TABLE IF NOT EXISTS public.fraud_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  reference TEXT,
  severity TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  channel TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  ledger_tx_ref TEXT,
  amount NUMERIC(18, 4),
  status TEXT NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.device_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  device_fingerprint TEXT,
  ip_hash TEXT,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON public.device_sessions (user_id);

CREATE TABLE IF NOT EXISTS public.risk_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  score NUMERIC(8, 4),
  signals JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  idempotency_key TEXT,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_idempo ON public.webhook_events (source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ai_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  model TEXT,
  correlation_id TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Row Level Security ─────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_sessions ENABLE ROW LEVEL SECURITY;

-- Demo-grade permissive policies for authenticated + anon clients on ledger paths
-- Tighten owner-scoped policies before production launch.
CREATE POLICY "ledger_rw_demo" ON public.ledger_entries
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "recon_read_demo" ON public.reconciliation_logs
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "recon_insert_demo" ON public.reconciliation_logs
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "profiles_self" ON public.profiles
  FOR ALL TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY "wallets_self" ON public.wallets
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "otp_deny" ON public.otp_records FOR ALL TO anon, authenticated USING (false);

CREATE POLICY "fraud_service" ON public.fraud_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "notif_self" ON public.notifications FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "txn_service" ON public.transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "device_self" ON public.device_sessions FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "risk_service" ON public.risk_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "webhook_service" ON public.webhook_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "ai_session_self" ON public.ai_sessions FOR ALL TO authenticated USING (user_id IS NULL OR user_id = auth.uid()) WITH CHECK (user_id IS NULL OR user_id = auth.uid());
