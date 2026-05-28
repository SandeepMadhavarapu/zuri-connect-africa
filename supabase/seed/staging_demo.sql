-- Replace DEMO-USER-UUID with real auth.users.id after creating demo account in Supabase Auth
-- Run this only in staging/demo environments, never in production

-- Zuri Connect Africa — staging realism seed (telecom-fintech demo corpus)
-- Run in Supabase SQL Editor as postgres (or any role that bypasses RLS).
-- After running: create matching Auth users in Authentication UI and replace placeholders below.

-- ── Reconciliation anomaly (visible to authenticated clients per RLS) ─────────
INSERT INTO public.reconciliation_logs (run_date, total_debits, total_credits, difference, status, entries_checked)
VALUES
  (CURRENT_DATE - 2, 18420050.00, 18419875.25, 174.75, 'investigating', 42880),
  (CURRENT_DATE - 1, 9200100.50, 9200100.50, 0, 'balanced', 21402);

-- ── Fraud & risk signals (NULL user_id rows visible to ops roles per policies) ─
INSERT INTO public.fraud_logs (user_id, reference, severity, payload)
VALUES
  (NULL, 'STG-SIM-001', 'critical', '{"type":"sim_swap","corridor":"Nairobi–Mombasa","msisdn_masked":"+2547******21"}'::jsonb),
  (NULL, 'STG-AML-002', 'medium', '{"type":"structuring","threshold_kes":50000,"window_minutes":15}'::jsonb);

INSERT INTO public.risk_events (user_id, score, signals)
VALUES
  (NULL, 0.91, '["velocity_spike","device_change","geo_jump"]'::jsonb),
  (NULL, 0.44, '["off_hours_txn"]'::jsonb);

-- ── AI session history (correlation with Edge ai-router; NULL user until bound) ─
INSERT INTO public.ai_sessions (user_id, model, correlation_id, tokens_in, tokens_out)
VALUES
  (NULL, 'gpt-4o-mini', 'stg-ai-corr-001', 420, 180),
  (NULL, 'gpt-4o-mini', 'stg-ai-corr-002', 210, 95);

-- ── Transaction metadata spine (service seed; clients read-only per RLS) ─────
INSERT INTO public.transactions (external_ref, ledger_tx_ref, amount, status, metadata)
VALUES
  ('STG-META-001', 'STG-LED-REF-001', 2500.0000, 'settled', '{"product":"p2p","corridor":"NBO"}'::jsonb),
  ('STG-META-002', 'STG-LED-REF-002', 500.0000, 'pending', '{"product":"airtime"}'::jsonb);

-- ── Device / session telemetry samples (no PII in fingerprint) ────────────────
INSERT INTO public.device_sessions (user_id, device_fingerprint, ip_hash, metadata)
VALUES
  (NULL, 'fp_staging_terminal_a', encode(digest('192.0.2.1', 'sha256'), 'hex'), '{"demo":true}'::jsonb),
  (NULL, 'fp_staging_terminal_b', encode(digest('192.0.2.2', 'sha256'), 'hex'), '{"demo":true}'::jsonb);

-- ── Demo ledger legs (single-account view, +254712345678) — replace DEMO-USER-UUID ──
INSERT INTO public.ledger_entries (
  transaction_ref, entry_type, amount, balance_before, balance_after,
  account_phone, description, hash, owner_id, created_at
) VALUES
  ('TXN-DEMO-001', 'credit', 52000.0000, 0, 52000.0000, '+254712345678', 'Salary — Andela Kenya Ltd', encode(digest('TXN-DEMO-001-credit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-10 08:15:00+03'),
  ('TXN-DEMO-002', 'debit', 18500.0000, 52000.0000, 33500.0000, '+254712345678', 'Rent — Westlands apartment', encode(digest('TXN-DEMO-002-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-11 09:30:00+03'),
  ('TXN-DEMO-003', 'debit', 3200.0000, 33500.0000, 30300.0000, '+254712345678', 'Naivas Supermarket — Westlands', encode(digest('TXN-DEMO-003-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-12 12:45:00+03'),
  ('TXN-DEMO-004', 'debit', 1500.0000, 30300.0000, 28800.0000, '+254712345678', 'Safaricom airtime top-up', encode(digest('TXN-DEMO-004-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-13 07:20:00+03'),
  ('TXN-DEMO-005', 'debit', 800.0000, 28800.0000, 28000.0000, '+254712345678', '3GB data bundle — Safaricom', encode(digest('TXN-DEMO-005-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-14 10:00:00+03'),
  ('TXN-DEMO-006', 'debit', 2500.0000, 28000.0000, 25500.0000, '+254712345678', 'KPLC electricity token 0100298771', encode(digest('TXN-DEMO-006-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-15 18:30:00+03'),
  ('TXN-DEMO-007', 'debit', 650.0000, 25500.0000, 24850.0000, '+254712345678', 'Bolt — Westlands to CBD', encode(digest('TXN-DEMO-007-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-16 07:55:00+03'),
  ('TXN-DEMO-008', 'debit', 5000.0000, 24850.0000, 19850.0000, '+254712345678', 'Family transfer — Kisumu', encode(digest('TXN-DEMO-008-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-18 16:10:00+03'),
  ('TXN-DEMO-009', 'debit', 2000.0000, 19850.0000, 17850.0000, '+254712345678', 'Harambee contribution', encode(digest('TXN-DEMO-009-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-19 11:40:00+03'),
  ('TXN-DEMO-010', 'debit', 3000.0000, 17850.0000, 14850.0000, '+254712345678', 'Fuliza overdraft repayment', encode(digest('TXN-DEMO-010-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-21 08:05:00+03'),
  ('TXN-DEMO-011', 'debit', 1850.0000, 14850.0000, 13000.0000, '+254712345678', 'DStv Paybill payment', encode(digest('TXN-DEMO-011-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-22 19:25:00+03'),
  ('TXN-DEMO-012', 'credit', 8000.0000, 13000.0000, 21000.0000, '+254712345678', 'M-PESA reversal received', encode(digest('TXN-DEMO-012-credit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-25 14:00:00+03'),
  ('TXN-DEMO-013', 'credit', 15000.0000, 21000.0000, 36000.0000, '+254712345678', 'Freelance payment — Safaricom Digital', encode(digest('TXN-DEMO-013-credit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-04-28 09:50:00+03'),
  ('TXN-DEMO-014', 'debit', 1200.0000, 36000.0000, 34800.0000, '+254712345678', 'Java House — Westlands', encode(digest('TXN-DEMO-014-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-05-02 13:15:00+03'),
  ('TXN-DEMO-015', 'debit', 4500.0000, 34800.0000, 30300.0000, '+254712345678', 'Equity Bank Paybill', encode(digest('TXN-DEMO-015-debit', 'sha256'), 'hex'), 'DEMO-USER-UUID', TIMESTAMPTZ '2026-05-09 17:00:00+03');

-- ── Notifications: require user_id = existing auth user — insert after user exists ─
-- INSERT INTO public.notifications (user_id, channel, body, status)
-- VALUES ('YOUR-USER-UUID-HERE', 'push', '{"title":"Float low","body":"Top up staging wallet"}'::jsonb, 'delivered');
