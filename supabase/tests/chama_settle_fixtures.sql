-- =============================================================================
-- CHAMA SETTLE TEST FIXTURES
-- Prompt 3.3a (Part C) — seeds deterministic rows so settle_chama_contribution
-- can be exercised in integration tests without live M-PESA.
--
-- Idempotent: safe to run more than once. All INSERTs use ON CONFLICT DO NOTHING
-- or existence-guarded DO blocks.
--
-- Deterministic UUIDs
--   Test user:    cccc0001-0000-0000-0000-000000000001
--   chama_group:  cccc0002-0000-0000-0000-000000000001
--   chama_member: cccc0003-0000-0000-0000-000000000001
--   cycle:        cccc0004-0000-0000-0000-000000000001
--   obligation:   cccc0005-0000-0000-0000-000000000001
--   tx_ref:       CHAMA-TEST-TX-001  (text, not UUID)
--
-- Run as postgres/service_role in the Supabase SQL editor or psql.
-- =============================================================================

BEGIN;

-- ── 0. Test user in auth.users ────────────────────────────────────────────────
--    System-only test user. No password; cannot log in. Created solely as the
--    FK target for pending_payments.user_id and chama_members.user_id.

INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) VALUES (
  'cccc0001-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'chama-test-user@zuriconnect.internal',
  NULL,
  now(),
  '{"provider":"system","providers":["system"],"role":"test_fixture"}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── 1. chama_group ────────────────────────────────────────────────────────────

INSERT INTO public.chama_groups (
  id,
  name,
  description,
  currency,
  status,
  created_by,
  created_at,
  updated_at
) VALUES (
  'cccc0002-0000-0000-0000-000000000001',
  'Zuri Test Chama',
  'Fixture chama group for settle_chama_contribution tests',
  'KES',
  'active',
  'cccc0001-0000-0000-0000-000000000001',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── 2. chama_member ───────────────────────────────────────────────────────────

INSERT INTO public.chama_members (
  id,
  group_id,
  user_id,
  role,
  status,
  joined_at,
  created_at
) VALUES (
  'cccc0003-0000-0000-0000-000000000001',
  'cccc0002-0000-0000-0000-000000000001',
  'cccc0001-0000-0000-0000-000000000001',
  'member',
  'active',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── 3. chama_contribution_cycle ───────────────────────────────────────────────
--    amount_cents = 50000 → KES 500. Status 'open' so obligations can be paid.

INSERT INTO public.chama_contribution_cycles (
  id,
  group_id,
  name,
  amount_cents,
  currency,
  due_at,
  grace_days,
  status,
  created_by,
  created_at
) VALUES (
  'cccc0004-0000-0000-0000-000000000001',
  'cccc0002-0000-0000-0000-000000000001',
  'June 2026 Round',
  50000,
  'KES',
  now() + INTERVAL '7 days',
  3,
  'open',
  'cccc0001-0000-0000-0000-000000000001',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── 4. chama_obligation ───────────────────────────────────────────────────────
--    status = 'pending_payment' with a known tx_ref so the RPC can be called
--    directly without running the chama-contribute Edge Function.

INSERT INTO public.chama_obligations (
  id,
  cycle_id,
  group_id,
  member_id,
  amount_due_cents,
  status,
  payment_tx_ref,
  settled_receipt,
  settled_at,
  ledger_tx_ref,
  created_at
) VALUES (
  'cccc0005-0000-0000-0000-000000000001',
  'cccc0004-0000-0000-0000-000000000001',
  'cccc0002-0000-0000-0000-000000000001',
  'cccc0003-0000-0000-0000-000000000001',
  50000,
  'pending_payment',
  'CHAMA-TEST-TX-001',
  NULL,
  NULL,
  NULL,
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── 5. pending_payments row ───────────────────────────────────────────────────
--    amount = 500.00 KES (= 50000 cents) — matches obligation.
--    from_phone = '254712345678' — the debit ledger leg.
--    payment_type = 'chama_contribution' — routes webhook to settle RPC.
--    status = 'waiting_for_mpesa' — pre-callback state.

INSERT INTO public.pending_payments (
  id,
  tx_ref,
  amount,
  from_phone,
  to_phone,
  status,
  payment_type,
  user_id,
  idempotency_key,
  created_at,
  updated_at
) VALUES (
  'cccc0006-0000-0000-0000-000000000001',
  'CHAMA-TEST-TX-001',
  500.00,
  '254712345678',
  'CHAMA:cccc0002-0000-0000-0000-000000000001',
  'waiting_for_mpesa',
  'chama_contribution',
  'cccc0001-0000-0000-0000-000000000001',
  'chama_contrib_cccc0005-0000-0000-0000-000000000001',
  now(),
  now()
)
ON CONFLICT (tx_ref) DO NOTHING;

COMMIT;

-- =============================================================================
-- VERIFICATION QUERIES (run manually after applying fixtures):
--
--   SELECT id, status, payment_tx_ref, amount_due_cents
--   FROM chama_obligations WHERE id = 'cccc0005-0000-0000-0000-000000000001';
--
--   SELECT id, tx_ref, amount, payment_type, status
--   FROM pending_payments WHERE tx_ref = 'CHAMA-TEST-TX-001';
--
-- HAPPY-PATH RPC CALL (run as service_role):
--
--   SELECT settle_chama_contribution(
--     'CHAMA-TEST-TX-001',
--     'RJW3XTEST001',
--     now(),
--     'abc123payloadhash'
--   );
--
-- Expected: {"ok":true,"duplicate":false,"obligation_id":"cccc0005-...","ledger_tx_ref":"CHAMA-TEST-TX-001","obligation_settled":true}
-- =============================================================================
