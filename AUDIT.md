Tests required: enrollment workflow; reject unverified shortcode; render placeholder until verified; admin verification logs evidence + audit; rate-limit wrong-number reports.

## 11. Dispute / reversal audit

State: MISSING. No tables, no functions, no UI, no Daraja Reversal API integration. The reconciliation pipeline correctly refuses to auto-reverse a late-failure callback (payment-lifecycle.ts lines 345-363), but no human-driven reversal path.

### Required design (minimum viable)

Tables:
- disputes (id, pending_payment_id FK, reporter_user_id FK, reason wrong_amount/wrong_recipient/duplicate_charge/unauthorized/provider_not_received/other, status open/investigating/reversal_requested/resolved_refund/resolved_no_action/rejected, description, evidence_refs text[], assigned_to, opened_at, resolved_at)
- reversal_requests (id, dispute_id FK, daraja_originator_conversation_id, daraja_conversation_id, status queued/sent_to_daraja/accepted/reversed/failed, raw_provider_response jsonb, initiated_by, initiated_at, finalized_at, UNIQUE PARTIAL on dispute_id WHERE status IN (queued, sent_to_daraja, accepted))

Edge Functions:
- open-dispute — authenticated; user reports; rate-limited (≤3 open per user)
- admin-investigate-dispute — admin/auditor; updates status, attaches evidence
- admin-request-reversal — admin only; calls Daraja Reversal API (B2C credentials, initiator security cert); writes reversal_requests
- reversal-callback — Daraja's reversal callback; mirrors STK Push handler pattern; on success posts reversal ledger pair (REV-TXN ref)

UI: "Report this transaction" button on History.jsx; "Disputes" tab in ReconciliationCommandCenter.

Why this matters: No serious M-PESA reviewer believes a fintech is launchable without reversals. P0.

## 12. Merchant / business readiness

Compared to M-PESA for Business, Zuri has NONE of:
- Till collections backend (no C2B Confirmation/Validation URLs)
- Money in/out analytics
- Full statements
- Settlement batches (settlementEngine.js is localStorage only)
- Staff roles / per-merchant RBAC
- Maker-checker
- Bulk disbursements / payroll (no B2C code path)
- Merchant refunds (covered under disputes — missing)
- Dispute queues
- QR/till management
- Business profile onboarding

Build order:
1. merchants + merchant_payment_methods schema with KYB status
2. C2B Confirmation/Validation Edge Functions for till payments
3. merchant-statement Edge Function generating signed PDF/CSV
4. Maker-checker queue for bulk disbursements
5. B2C dispatcher Edge Function
6. Per-merchant RBAC via RLS

Until #1-#3 exist, DO NOT pitch the business side. Position as consumer-first, merchant v2.

## 13. AI / Duke AI audit

Strong:
- Server-routed (ai-router/index.ts, 475 lines)
- Action policy classification (_shared/ai-action-policy.ts, 320 lines): informational/low_risk_action/sensitive_action/financial_action/forbidden_action
- Prompt injection patterns (lines 32-41)
- Forbidden patterns: reveal OTP/PIN, reveal secrets, disable security, ledger mutation, payment success override, risk override, direct execution of initiate-payment or post_double_entry
- Audit log in ai_sessions + security_events
- Rate limit 30/hour
- Gemini model failover
- Prompt redaction in audit summary
- validateModelActionResponse — model can't trigger actions, only propose

To stand out vs normal chatbots:
1. Duke proposes payment but never executes — biometric/PIN/OTP always required.
2. Add explainability for risk decisions — route risk-engine.ts reasons[] through Duke for plain language.
3. Proactive scam-shield prompts — Duke explains why scamShield flagged a recipient.
4. Server-side hallucination check on balance/transaction claims.
5. Don't ship "AI Timeline" without server-derived data source.

## 14. Testing / CI / prepitch audit

Strong:
- 52 unit test files; server-authoritative-payments, server-side-risk-engine, payment-step-up-flow, pin-server-hardening, otp-hardening, client-ledger-hardening, idempotency, ledger-concurrency, ai-action-policy, ai-provider-routing, daraja-query, prepitch-readiness, platform-readiness, button-audit
- tests/security/auth-and-webhook.test.js
- Stress: concurrent-post, idempotency-storm
- Perf: operational-budgets
- prepitch script chains lint + build + vitest + secret scan + readiness

Weak / missing:
- E2E (Playwright) is SHALLOW. tests/e2e/smoke.spec.js is 14 lines — "shell renders" and "auth route responds". No payment flow E2E.
- No integration test against real Daraja sandbox.
- NO RLS test suite. Critical gap.
- Integration tests are config validation, not flow tests.

Tests Safaricom engineers will expect:
1. Daraja sandbox E2E: real STK push → real callback → ledger posted
2. Duplicate callback test: same callback twice → one ledger entry, recon event
3. Late-conflicting callback: success then late failure → no auto-reversal, review entry
4. RLS deny test: authenticated cannot insert ledger_entries, read another user's pending_payments, escalate role
5. Webhook IP-denial test
6. Webhook signature mismatch test
7. STK timeout test: state stays processing not failed; reconciliation resolves
8. Risk fail-closed test

## 15. Deployment & production-readiness audit

Have: Dockerfile, nginx.conf, docker-compose.yml, vercel.json; .env.*.example for each tier; scripts/validate-env.mjs --strict; scan-secrets, check-secrets, check-prepitch, audit-buttons, ai-router-smoke; 33 migrations chronological.

Missing: no CI workflow file visible; no staging URL evidenced; no Sentry/Datadog wired; no rollback/DR doc; no documented secret rotation policy; no documented --no-verify-jwt per-function policy in repo.

CSP IS GOOD (corrected from initial finding): nginx.conf and vercel.json both ship default-src 'self', no script-src 'unsafe-inline', no unsafe-eval, frame-ancestors 'none', connect-src pinned to Supabase, COOP/CORP same-origin, Permissions-Policy correctly opens publickey-credentials for WebAuthn. nginx adds limit_req 80r/s burst 120.

Staging demo checklist:
- Real Supabase project + all 33 migrations applied
- All Edge Functions deployed (initiate-payment, webhook-handler, reconciliation-job, admin-reconciliation, complete-step-up, verify-biometric, send-otp, verify-otp, set-pin, ai-router, security-devices, notification-dispatcher, settlement-recovery, fraud-analysis)
- Edge Function secrets: DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, DARAJA_SHORTCODE, DARAJA_PASSKEY, DARAJA_CALLBACK_URL, DARAJA_ENV=sandbox, MPESA_WEBHOOK_SECRET, APP_ORIGIN, APP_ENV=staging, OTP_PEPPER, PIN_PEPPER, GEMINI_API_KEY
- VITE_STRICT_ENV=true, VITE_ALLOW_CLIENT_DEMO_CONTROLS=false
- Demo seed user with verified phone via Africa's Talking sandbox
- Reconciliation cron set up (every 5 min)
- Hide non-real admin pages from nav
- Smoke STK push end-to-end against sandbox

Production launch checklist:
- Go-live cert from Safaricom for Daraja
- B2C initiator credentials + security cert
- Real KPLC/NHIF/water utility verified entries
- Dispute/reversal backend live
- BCP/DR doc + tested
- AML/KYC policy + tiered limits
- Kenya DPA compliance
- Sentry/Datadog/PagerDuty alerting
- On-call rota

NEVER claim live yet: "Bonga rewards integration", "live SIM-swap detection", "verified provider directory", "merchant collections", "bulk disbursements", "live customer support".

## 16. Architecture upgrade plan (priority order)

1. Provider directory backend (§10). P0. 5-7 days.
2. Dispute/reversal backend (§11). P0. 5-10 days.
3. Replace src/backend/* and src/server/domain/* with real Edge Functions or delete them. Convert SecurityOperationsCenter.jsx and AdminSecurityDashboard.jsx to read from audit_events, payment_reconciliation_events, webhook_events. P0. 3-5 days.
4. Notification dispatcher: real worker draining notifications.status='queued' via Africa's Talking SMS / FCM push / email. P1. 2 days.
5. Rewards redemption backend. rewards_points ledger + redeem-rewards Edge Function. P1. 3 days.
6. Standing orders / scheduled payments. P1. 3 days.
7. Merchant/business backend (§12). P1 for business pitch. 2-3 weeks.
8. Real E2E test suite. P1. 1 week.
9. Staging deployment. P0 for pitch credibility. 2 days.
10. Observability: Sentry/Datadog. P1. 1-2 days.
11. RLS test pack. P0. 1-2 days.
12. Compliance hardening. P1. ongoing.

## 17. UI upgrade plan

- Hide or rebuild Bonga.jsx.
- Hide SecurityOperationsCenter.jsx and AdminSecurityDashboard.jsx from demo until real, or rename as "Local Diagnostics Preview".
- Highlight ReconciliationCommandCenter.jsx with "Live Backend" badge.
- Add "How this works" overlay showing payment state machine in real time.
- Paybill.jsx: drop hardcoded popularBillers, call provider-search Edge Function.
- Send.jsx: surface risk reasons in step-up modal in plain language.
- Security Centre: split into "Server-Backed" and "Local Preferences" sections.
- Platform Readiness: call real /health Edge Function.
- Add "Sandbox demo — no real funds move" footer chip.
- Accessibility: tap targets ≥44px, WCAG AA contrast, screen-reader labels.
- Offline: keep for read-only; never queue payments offline.

## 18. Top 25 risks

| # | Sev | Area | Finding |
|---|---|---|---|
| 1 | Critical | Admin UI | SOC + Admin Security read from localStorage |
| 2 | Critical | Disputes | No reversal/dispute backend |
| 3 | Critical | Provider directory | No verified backend; numbers in bundle |
| 4 | High | Notifications | Stub — no SMS/push/email |
| 5 | High | Settlement | Stub |
| 6 | High | Tests | E2E only renders root element |
| 7 | High | RLS | No published RLS test output |
| 8 | High | Paybill claim | False statement in code comment |
| 9 | High | SIM-swap | Client-side only |
| 10 | High | B2C | No bulk/payroll |
| 11 | High | Staging | No live URL |
| 12 | High | Observability | No Sentry/Datadog |
| 13 | Medium | .env.local | In zip artifact |
| 14 | Medium | Idempotency key | Client-supplied |
| 15 | Medium | clientLedgerGuard | Env-flag dependent only |
| 16 | Medium | Webhook secret | Optional config |
| 17 | Medium | Cron | No schedule in repo |
| 18 | Medium | Bonga.jsx | 5-line placeholder |
| 19 | Medium | demoMode duplicates | Two modules |
| 20 | Medium | biometricAuthDemo.js | Demo module shipped |
| 21 | Medium | Local ledger | localStorage tamperable for display |
| 22 | Medium | DeviceTrustPanel | Uses localStorage despite real backend |
| 23 | Low | Rate limit | 5/hour aggressive |
| 24 | Low | CSP | (resolved — actually good per §23.1) |
| 25 | Low | DR/rollback doc | Missing |

## 19. Top 25 strengths

1. webhook-handler 486 lines: IP allowlist, HMAC, nonces, idempotency
2. Ledger lockdown migration 20260518090000
3. Real reconciliation dashboard + Edge Function
4. Risk engine fail-closed
5. WebAuthn step-up bound to specific pending payment
6. Server-managed PIN with pepper
7. OTP peppered hash + provider diagnostics
8. Hash chain ledger (20260519100000)
9. Three-layer idempotency
10. AI policy refuses financial actions, blocks injection
11. Gemini failover
12. Premium glass-card UI
13. Provider directory ships unverified-by-default (honesty)
14. clientLedgerGuard.js exists (honesty)
15. 52 unit test files
16. Stress tests (concurrent-post, idempotency-storm)
17. Env validation strict-mode
18. Secret scan pre-pitch hook
19. Button audit custom script
20. Webhook nonces UNIQUE replay defense
21. Device trust server + deny-list enforced in initiate
22. Risk decisions table persisted
23. Centralized security_events
24. Separate audit_events with correlation_id
25. prepitch script chains everything

## 20. What to build next

### A. Next 24 hours
1. Hide SecurityOperationsCenter.jsx, AdminSecurityDashboard.jsx, Bonga.jsx from nav. (2h)
2. Strip .env.local from shareable artifacts. (5 min)
3. Add "Sandbox" banner. (30 min)
4. Run full prepitch chain, capture output. (30 min)
5. Deploy backend to real Supabase. (1-2h)
6. Deploy all Edge Functions. (1h)
7. Sandbox-cert Daraja, sandbox STK push end-to-end. (1-2h)
8. Write one E2E test for Send flow. (2-3h)
9. Add Architecture page. (1-2h)

### B. Next 7 days
1. Provider directory backend MVP (§10). 3 days.
2. Reversal/dispute backend MVP (§11). 2 days.
3. Replace SecurityOperationsCenter data sources. 1 day.
4. Notification worker via Africa's Talking. 1 day.
5. RLS test pack. 1 day.
6. Real E2E test against sandbox Daraja. 1 day.
7. Wire Sentry. ½ day.

### C. Next 30 days
1. Go-live Daraja certification
2. B2C initiator credentials
3. Production callback gateway signing Daraja's unsigned callbacks
4. Real verified provider entries (KPLC, NHIF, water utility)
5. Merchant backend MVP (§12 #1-#3)
6. Standing orders + rewards redemption
7. Cron-driven reconciliation every 5 min
8. PagerDuty / on-call
9. Kenya DPA registration + privacy policy + DSAR
10. AML/KYC tiered limits
11. Full E2E pack
12. BCP/DR doc with quarterly drill
13. Independent pen-test
14. Beta with 50 real users

## 21. Questions Safaricom engineers will ask (with honest answers)

Is this live? — No. Daraja sandbox today. Production cert is next milestone.

Where are provider numbers verified? — Not yet. Seed is 'unverified_sample'. P0 7-day plan.

Can the client fake a payment? — No. Migration 20260518090000 revokes everything. service_role only.

How do you prevent duplicate callbacks? — Three layers: webhook_nonces UNIQUE on (signature, payload_hash); webhook_events.idempotency_key UNIQUE per (CheckoutRequestID, ResultCode, ReceiptNumber); ledger_posted_at flag on pending_payments.

What happens if the Daraja callback fails or never arrives? — reconciliation-job sweeps pending older than 30 min, calls Daraja STK Query. Result via provider-status-applier which never posts to ledger from STK Query (lacks receipt + amount). Stale rows become timeout.

How do reversals work? — Currently they don't. Late-conflict goes to manual review. Full reversal backend is P0.

How is the ledger protected? — Append-only with REVOKE; double-entry via single post_double_entry RPC; hash chain over (transaction_ref, entry_type, amount, balance_before, balance_after, account_phone); optimistic balance lock.

What is local/demo vs server-backed? — Server: STK, callbacks, reconciliation, ledger, PIN, OTP, WebAuthn, trusted devices, risk decisions, AI routing, audit. Local: budgets, AI activity mirror, settlement engine display, the two admin dashboards we're rebuilding. clientLedgerGuard prevents client ledger writes in production.

How do you handle SIM swap? — Today client heuristics only. Production: MNO HLR query + tighter step-up on phone-IMEI change.

How do you handle device theft? — trusted_devices server table with revocation. isClientDeviceRevoked check in initiate-payment before any Daraja call. WebAuthn step-up required.

How does AI avoid unsafe actions? — _shared/ai-action-policy.ts classifies every request. Financial/forbidden never produce executable actions, only proposed with confirmation. Forbidden patterns: OTP/PIN reveal, ledger mutation, payment override, risk override, direct invocation of initiate-payment/post_double_entry. Server-validated response shape.

How do you prove RLS works? — Unit tests show migrations apply revokes. SQL-level deny test pack on 7-day plan.

What exactly is missing before production? — Provider directory backend, reversal/dispute backend, notification worker, B2C support, merchant model, real cron, live observability, production Daraja creds, BCP/DR, DPA. 4-8 weeks.

What rate limits? — 5 initiations/hour/user; 30 AI/hour/user; webhook nonces UNIQUE; OTP send/verify rate-limit migrations.

What metrics? — audit_events (financial), security_events (security/auth), risk_decisions, payment_reconciliation_events, webhook_events, ai_sessions. Sentry on 7-day plan.

Reconciliation cadence? — On-demand today via admin UI. Cron every 5 min on 7-day plan.

STK Query mismatches? — STK Query 'succeeded' → review_required. Never post ledger from STK Query (lacks receipt + amount). Only real callback posts.

Amount + phone validated on callback? — Yes, compareAmount and comparePhone in payment-lifecycle.ts. Mismatch → review_required, no ledger post, recon event, critical audit.

Late failure after success? — Ledger never auto-reversed. late_conflicting_callback event + critical audit + manual review.

Orphan callback? — 404 PENDING_PAYMENT_NOT_FOUND, mark webhook_event failed, emit webhook.orphan critical.

Body-size limit? — 512 KiB.

Timestamp tolerance? — ±300 seconds.

Secrets storage? — Edge Function secrets via Supabase CLI. Never frontend bundle, repo, or URL params.

Risk engine failure mode? — Fail-closed to manual_review with risk_score 100 and support_review step-up.

Who can call admin-reconciliation? — JWT-bound to app_metadata.role = admin or auditor.

Raw Daraja callbacks logged? — webhook_events.payload with SHA-256 payload_hash. Admin UI reads safe payment_reconciliation_review view only.

How are users created? — Supabase Auth + phone-OTP via Africa's Talking. profiles sanitized (20260517000003), role escalation prevented (20260517000004).

Service-role key blast radius? — Total. Kept in Edge Function secrets only, never CI logs, rotate on incident.

Daily limit enforced? — Risk engine returns block for daily_limit_exceeded. Default 150k KES.

Daraja 200 with non-zero result code? — STK rejection, status failed, result_code/result_desc recorded, generic user message.

## 22. Final recommendation

Should I pitch this now? Yes — as an architecture proposal with a working sandbox-grade payment lifecycle. Not as a launch-ready M-PESA alternative.

What to avoid showing:
- SecurityOperationsCenter page
- AdminSecurityDashboard page
- Bonga.jsx (5 lines)
- Anything labeled "live" without sandbox-cert evidence
- The hardcoded popularBillers in Paybill.jsx as "our verified directory"

What to show first:
1. Real end-to-end Send flow against Daraja sandbox on live staging URL
2. ReconciliationCommandCenter after intentionally creating a stuck payment
3. risk_decisions + audit_events tables filling up live
4. Biometric step-up modal on high-value send
5. Duke AI refusing to execute but proposing with explanation
6. 30+ unit tests passing live
7. 33 migrations folder with lockdown SQL highlighted

What to say the app is: "Zuri Connect Africa is a consumer fintech super-app proposal built on a production-shaped M-PESA payment architecture. The Daraja STK push, callback handling, reconciliation, and ledger run today against sandbox. The visual design and AI assistant are differentiators. The provider directory, merchant side, dispute backend, and notification worker are the next four sprints on the roadmap."

What NOT to claim:
- "Live in production."
- "Verified provider directory."
- "Real-time SIM-swap detection."
- "Bonga rewards integration."
- "Merchant collections platform."
- "Bulk disbursements / payroll."
- "Customer support tooling."
- "Compliance-certified."

ONE backend upgrade that most increases credibility: Provider directory backend (§10) with admin verification workflow inside ReconciliationCommandCenter.

ONE UI change that most increases credibility: Replace hardcoded popularBillers in Paybill.jsx with a real provider-search Edge Function call.

ONE security improvement that most increases credibility: Publish a passing RLS deny test pack as part of pre-pitch chain.

## 23. Audit gap closures (second pass)

### 23.1 Strengths I underweighted

| # | Finding |
|---|---|
| S1 | admin-reconciliation/handler.ts is 642 lines of genuine, well-structured admin logic. PII masked (maskPhone, redactReference), reads use safe payment_reconciliation_review view only, terminal payments refused for re-action, role exclusively from app_metadata.role. |
| S2 | _shared/admin-roles.ts is a clean single-source RBAC helper that reads app_metadata only. |
| S3 | verify-biometric is REAL WebAuthn: ECDSA P-256 signature verification, DER→P1363 conversion, rpIdHash match, userPresent + userVerified flags, signCount monotonicity, single-use challenge with 5-min TTL. |
| S4 | send-otp uses real Africa's Talking SMS gateway with sandbox/live URL switch. Peppered hash via _shared/otp-crypto.ts. |
| S5 | CSP is genuinely production-grade. Both nginx.conf and vercel.json ship default-src 'self', no script-src 'unsafe-inline', no unsafe-eval, frame-ancestors 'none', connect-src pinned to *.supabase.co, COOP/CORP same-origin, Permissions-Policy opens publickey-credentials and microphone correctly. |
| S6 | nginx limit_req_zone 80 req/s burst 120 at the edge. |
| S7 | Send.jsx loads contacts from real profiles table. No hardcoded contacts. Comments explain WebAuthn challenge consumption fix. |

Updated scores: Safaricom engineer confidence 6→7, Backend launch-readiness 4→4.5, Security maturity 6.5→7.5.

### 23.2 Findings that worsen the picture

N1 — CRITICAL: tests/security/auth-and-webhook.test.js line 2 imports verifyDarajaWebhookRequest from @/backend/webhooks/verifyWebhook.js — that's the localStorage CLIENT-SIDE backend, not the real Edge Function. The test names ("rejects stale webhook timestamps", "rejects Daraja callback with tampered payload hash") imply they cover the production callback path. They do not. The real verifyWebhookSignature in webhook-handler/index.ts has ZERO direct tests.

N2 — MEDIUM: fraud-analysis Edge Function is ORPHANED. Exposed via src/api/endpoints.js and src/services/fraudService.js, but no page calls fraudService. fraud_logs and risk_events will be empty.
> RESOLVED 2025-11-05: fraud-analysis Edge Function and src/services/fraudService.js deleted (Prompt 2.3). Risk scoring path now has a single source of truth: _shared/risk-engine.ts.
> FOLLOW-UP 2026-05-29: deployed instance of fraud-analysis also removed from Supabase via Prompt 3.4.5. Function is now gone in both source and deployment.

N3 — MEDIUM: fraud-analysis is a PARALLEL RISK PATH. It contains its own evaluateRisk with similar but not identical weights to _shared/risk-engine.ts.
> RESOLVED 2025-11-05: fraud-analysis Edge Function and src/services/fraudService.js deleted (Prompt 2.3). Risk scoring path now has a single source of truth: _shared/risk-engine.ts.

N4 — MEDIUM: Voice biometric OVERCLAIM. SecurityCentre.jsx shows "Voice Print — Kenyan accent profile, active: true" (line 402). No verify-voice Edge Function. Voice modules client-side only.

N5 — MEDIUM: SIM Verification OVERCLAIM. Same page line 404 hardcodes fake phone suffix "+254 712…678" with active: true. No SIM-binding migration.

N6 — MEDIUM: SESSION_LOG, SECURITY_EVENTS, CHECKS at lines 21-44 are hardcoded fake data. Honesty mitigates: banner at line 369 says "Sample data — live checks load from the security telemetry endpoint when available", and "Capability preview" label at line 398. But the data still looks like real telemetry visually.

N7 — MEDIUM: "Powered by Zuri Behavioral Intelligence" under Scam Shield header (line 217) where stats come from getRecentThreats/getTopScamPatterns reading one device's localStorage. Overclaim.

N8 — LOW: nginx.conf and vercel.json Permissions-Policy drift. nginx: microphone=(). vercel: microphone=(self). Align.
> RESOLVED 2025-11-06: nginx.conf and vercel.json security headers aligned (Prompt 2.6). Both deployments now ship identical Permissions-Policy and CSP. See docs/SECURITY_HEADERS.md for the sync requirement.

N9 (Resolved 2026-05-29 in Prompt 3.4.5): 'ai-router-' (with trailing dash) — orphan Edge Function with no source references, removed from Supabase.

### 23.3 Updated risk register additions

R26 — Critical: Security test targets client-side fake verifier. Fix: extract verifyWebhookSignature into _shared/webhook-verify.ts and unit-test it.
R27 — Medium: Orphan fraud-analysis; parallel risk path. Fix: delete or consolidate.
R28 — Medium: Voice/SIM "active: true" overclaim in SecurityCentre.
R29 — Low: CSP Permissions-Policy drift nginx vs vercel.

## 24. Concrete code skeletons for the two P0 backends

### 24.1 Provider Directory backend — minimum viable

Migration supabase/migrations/20260525090000_provider_directory.sql:

```sql
CREATE TABLE IF NOT EXISTS public.providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category    text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','suspended','retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.provider_payment_methods (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id               uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  method_type               text NOT NULL
                            CHECK (method_type IN ('paybill','till','send_money','partner_api')),
  shortcode                 text NOT NULL,
  account_reference_label   text,
  account_reference_format  text,
  verification_status       text NOT NULL DEFAULT 'unverified'
                            CHECK (verification_status IN
                              ('unverified','pending_review','verified','suspended')),
  last_verified_at          timestamptz,
  verified_by               uuid REFERENCES auth.users(id),
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method_type, shortcode)
);

CREATE INDEX IF NOT EXISTS ix_ppm_status ON public.provider_payment_methods (verification_status, method_type);
CREATE INDEX IF NOT EXISTS ix_ppm_provider ON public.provider_payment_methods (provider_id);

CREATE TABLE IF NOT EXISTS public.provider_verification_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method_id  uuid NOT NULL REFERENCES public.provider_payment_methods(id) ON DELETE CASCADE,
  source_type        text NOT NULL
                     CHECK (source_type IN
                       ('safaricom_directory','provider_letter','utility_invoice',
                        'field_visit','partner_api','signed_contract')),
  source_reference   text NOT NULL,
  evidence_hash      text,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  verified_by        uuid NOT NULL REFERENCES auth.users(id),
  attestation        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.provider_wrong_number_reports (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method_id        uuid REFERENCES public.provider_payment_methods(id),
  reporter_user_id         uuid NOT NULL REFERENCES auth.users(id),
  alleged_correct_shortcode text,
  reason                   text NOT NULL,
  status                   text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','investigating','resolved','rejected')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz
);

CREATE INDEX IF NOT EXISTS ix_pwnr_reporter ON public.provider_wrong_number_reports (reporter_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.provider_audit_events (
  id                bigserial PRIMARY KEY,
  payment_method_id uuid REFERENCES public.provider_payment_methods(id),
  actor_id          uuid REFERENCES auth.users(id),
  actor_role        text,
  action            text NOT NULL,
  before            jsonb,
  after             jsonb,
  at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.providers                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers                       FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_payment_methods        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_payment_methods        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_verification_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_verification_sources   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_wrong_number_reports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_wrong_number_reports   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_audit_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_audit_events           FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_providers_read_active ON public.providers
  FOR SELECT TO authenticated USING (status = 'active');

CREATE POLICY p_ppm_read_verified ON public.provider_payment_methods
  FOR SELECT TO authenticated USING (verification_status = 'verified');

CREATE POLICY p_pwnr_insert_own ON public.provider_wrong_number_reports
  FOR INSERT TO authenticated WITH CHECK (reporter_user_id = auth.uid());

CREATE POLICY p_pwnr_read_own ON public.provider_wrong_number_reports
  FOR SELECT TO authenticated USING (reporter_user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.providers                     FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.provider_payment_methods      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.provider_verification_sources FROM anon, authenticated;
REVOKE       UPDATE, DELETE ON public.provider_wrong_number_reports   FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.provider_audit_events         FROM anon, authenticated;
```

Edge Functions follow patterns of existing initiate-payment/webhook-handler:
- provider-search: JWT auth via supabase.auth.getUser, query verified entries only with provider status='active', max 50 results, supports q/category/method_type filters
- report-wrong-number: JWT auth, rate limit ≤3 reports per user per 24h, writes audit_events row
- admin-verify-provider: requireAdminRole(['admin']), inserts provider_verification_sources row + updates provider_payment_methods to verification_status='verified', writes provider_audit_events with before/after, writes audit_events with event_type 'provider.verified'

Gate in initiate-payment (add after phone match, before buildPendingPaymentRecord):
For payment_type 'paybill' or 'till', SELECT from provider_payment_methods matching (method_type, shortcode) WHERE verification_status='verified'. If no match, return 422 UNVERIFIED_PROVIDER with security_events 'payment.unverified_provider_blocked'.

#### Phase 3 — Provider Directory Status (as of 2026-05-29)

All four prompts deployed:
- 3.1+3.2: Migration applied (5 tables, RLS forced)
- 3.3: provider-search Edge Function (live)
- 3.4: report-wrong-number Edge Function (live)
- 3.5: admin-verify-provider Edge Function + verify_provider_payment_method Postgres function (live)
- 3.6: provider gate in initiate-payment shipped behind ZURI_REQUIRE_VERIFIED_PROVIDER flag (dormant)

Activation status: GATE DORMANT

To activate: see docs/PROVIDER_DIRECTORY_ACTIVATION.md

Known limitation: only 1 verified entry will exist after seed (KPLC PayBill 888880). All other paybill/till payments will be rejected once the gate is active. Production launch requires at least 5 real verified entries via admin-verify-provider.

### 24.2 Dispute / Reversal backend — minimum viable

Migration supabase/migrations/20260525100000_disputes_reversals.sql:

```sql
CREATE TABLE IF NOT EXISTS public.disputes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_payment_id  uuid NOT NULL REFERENCES public.pending_payments(id) ON DELETE RESTRICT,
  reporter_user_id    uuid NOT NULL REFERENCES auth.users(id),
  reason              text NOT NULL
                      CHECK (reason IN
                        ('wrong_amount','wrong_recipient','duplicate_charge',
                         'unauthorized','provider_not_received','other')),
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN
                        ('open','investigating','reversal_requested',
                         'resolved_refund','resolved_no_action','rejected')),
  description         text,
  evidence_refs       text[] DEFAULT '{}',
  assigned_to         uuid REFERENCES auth.users(id),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);

CREATE INDEX IF NOT EXISTS ix_disputes_status_open ON public.disputes (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS ix_disputes_payment ON public.disputes (pending_payment_id);
CREATE INDEX IF NOT EXISTS ix_disputes_reporter ON public.disputes (reporter_user_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS public.reversal_requests (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id                          uuid NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  daraja_originator_conversation_id   text,
  daraja_conversation_id              text,
  status                              text NOT NULL DEFAULT 'queued'
                                      CHECK (status IN
                                        ('queued','sent_to_daraja','accepted','reversed','failed')),
  raw_provider_response               jsonb,
  initiated_by                        uuid NOT NULL REFERENCES auth.users(id),
  initiated_at                        timestamptz NOT NULL DEFAULT now(),
  finalized_at                        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_reversal_per_dispute
  ON public.reversal_requests (dispute_id)
  WHERE status IN ('queued','sent_to_daraja','accepted');

ALTER TABLE public.disputes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.reversal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reversal_requests FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_disputes_read_own ON public.disputes
  FOR SELECT TO authenticated USING (reporter_user_id = auth.uid());

CREATE POLICY p_disputes_insert_own ON public.disputes
  FOR INSERT TO authenticated WITH CHECK (reporter_user_id = auth.uid());

REVOKE UPDATE, DELETE        ON public.disputes          FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.reversal_requests FROM anon, authenticated;
```

Edge Functions:
- open-dispute: JWT auth, verify pending_payment.user_id matches caller, reject ≥3 open disputes (429), validate reason, insert dispute + audit_events + notifications queue row
- admin-request-reversal: requireAdminRole(['admin']), validates dispute_id status='investigating', inserts reversal_requests status='queued', updates dispute status to 'reversal_requested', audit_events 'dispute.reversal_requested' critical. TODO: actual Daraja Reversal API call (needs B2C initiator credentials + security cert) and reversal-callback function.

UI: Add "Report this transaction" button on every History.jsx row that opens a dispute modal POSTing to open-dispute. Add "Disputes" tab to ReconciliationCommandCenter reading from a new disputes_review view.

## 25. Pre-pitch command sequence

Run from latest-best-version-60-main:

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run scan:secrets
npm run audit:buttons
```

If any fails, stop and fix.

Deploy migrations: `npx supabase db push`

Deploy Edge Functions:
- Regular JWT-enforced: initiate-payment, webhook-handler, reconciliation-job, admin-reconciliation, complete-step-up, verify-biometric, verify-otp, set-pin, security-devices, fraud-analysis, settlement-recovery, notification-dispatcher
- --no-verify-jwt: ai-router, send-otp
- New: provider-search, report-wrong-number, admin-verify-provider, open-dispute

Set secrets via `npx supabase secrets set`:
APP_ORIGIN, APP_ENV=staging, DARAJA_ENV=sandbox, DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, DARAJA_SHORTCODE, DARAJA_PASSKEY, DARAJA_CALLBACK_URL=https://<project>.functions.supabase.co/webhook-handler, MPESA_WEBHOOK_SECRET=$(openssl rand -hex 32), OTP_PEPPER, PIN_PEPPER, GEMINI_API_KEY, GEMINI_MODEL=gemini-2.0-flash-lite, AT_API_KEY, AT_USERNAME=zuriconnect254, AT_FROM=ZURI

Smoke:
- npm run build
- node scripts/ai-router-smoke.mjs
- node scripts/smoke-send-otp.mjs

Browser: log in with test phone (+254143305099), send KSh 10 sandbox, confirm:
- pending_payments row appears (status='waiting_for_mpesa')
- Callback within 30s → status='succeeded'
- ledger_entries has matching debit + credit pair
- audit_events has payment.webhook.succeeded with correlation_id matching tx_ref

Final gate: `npm run prepitch` — screenshot green output as slide.

## 26. Minute-by-minute pitch demo flow (20 min)

| Minute | Surface | Talking points |
|---|---|---|
| 0:00-1:30 | Title slide | "Consumer fintech super-app proposal on production-shaped M-PESA backend. Running in Daraja sandbox today, not production." Scoreboard real vs roadmap. |
| 1:30-3:00 | Home on real phone | "Customer view. Balance derived from server-authoritative ledger; page paints local mirror first." Tap into Send. |
| 3:00-6:00 | Send end-to-end | Send KSh 20 to sandbox number. Open second window with Supabase SQL editor querying audit_events DESC LIMIT 5. Biometric step-up triggers, payment confirms. |
| 6:00-7:00 | Audit trail | Six tabs: pending_payments, webhook_events, payment_reconciliation_events, risk_decisions, audit_events, ledger_entries. |
| 7:00-9:00 | Stuck payment recovery | UPDATE pending_payments SET checkout_request_id='fake'; trigger reconciliation; watch it resolve. |
| 9:00-10:30 | Duplicate callback test | "What if Daraja sends same callback twice?" Run npx vitest tests/unit/idempotency.test.js live. |
| 10:30-12:00 | Architecture file | Open webhook-handler/index.ts. 486 lines: IP allowlist, HMAC, nonces, idempotency. |
| 12:00-14:00 | Duke AI | "Send 5000 to mom" — proposes, doesn't execute. Biometric still required. "Why was my last payment held?" — explains using risk_decisions.reasons. |
| 14:00-16:00 | Roadmap slide | 7-day plan from §20. Provider directory + disputes + notifications. |
| 16:00-17:00 | Honesty slide | What this app is NOT today. Migration plan. |
| 17:00-18:00 | Security maturity | CSP in nginx.conf, REVOKE in ledger lockdown migration, WebAuthn in verify-biometric. |
| 18:00-20:00 | Q&A | Use §21 answers. |

DO NOT during demo: click SecurityOperationsCenter or AdminSecurityDashboard; show Paybill hardcoded shortcodes as "verified directory"; open Bonga; open DevTools; claim "live".

## 27. What to expect in the room

CEO/commercial lead: Responds to consumer experience, Duke AI, security narrative. "When are you live?" answer: "30-60 days bake after sandbox-to-production cert."

Engineering reviewer: Impressed by webhook-handler, verify-biometric, admin-reconciliation, risk-engine, CSP, migrations. Will catch:
- src/backend/ / src/server/domain/ localStorage shadow stack
- Security test importing wrong verifier
- Paybill.jsx claim mismatch with initiate-payment
- Orphan fraud-analysis function
- Hardcoded SESSION_LOG in SecurityCentre.jsx

Front-foot all five and you turn 5 negatives into 5 positives.

Security/fraud reviewer: Goes to RLS, secrets, reversal. Uncomfortable that no reversal path exists. Impressed by hash-chain, server-managed PIN, peppered OTP, WebAuthn step-up binding, IP allowlist + nonces. Walking in with dispute backend wired neutralizes biggest concern.

## 28. One paragraph to read on stage

"Zuri Connect Africa is a consumer fintech proposal. Our M-PESA payment lifecycle runs against Daraja sandbox today — server-only credentials, IP-allowlisted callbacks, HMAC signatures, replay nonces, idempotency keys, a hash-chained append-only ledger, and a reconciliation pipeline you'd recognize from production. We have real WebAuthn, server-managed PIN, peppered OTP via Africa's Talking, and a server-side risk engine that fails closed. Three things are deliberately not real yet: a verified provider directory, a dispute and reversal backend, and a notification worker. Each is one sprint of work. We know exactly what we're building, why, and in what order. We're not asking to launch — we're asking to be on Safaricom's roadmap as the consumer surface that makes M-PESA feel like the future."
