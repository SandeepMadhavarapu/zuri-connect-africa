# Zuri Connect — Operations Runbook

Last updated: 2026-05-30
Owner: Engineering

---

## How to use this runbook

The two admin surfaces are the strategic dashboard at **`/admin`** and the
incident-response Security Operations Center at **`/admin/soc`**. Open `/admin`
at the start of every shift for the strategic overview (panels 1–6). When
something looks wrong, drill into `/admin/soc` for the table-level detail
(panels 7–12). Both pages are gated behind `VITE_ALLOW_INTERNAL_PAGES` and
require an `admin`, `auditor`, `fraud_analyst`, or `operator` role on
`app_metadata.role`.

Both pages refresh automatically every 30 seconds. The freshness dot next to
the page title is green while data is fresh; if it turns amber (data older than
45 s) or the data looks frozen, click **Retry**. If a red error banner appears,
the Edge Function call failed — click **Retry**; if it persists, treat it as a
Supabase/Edge Function incident (see Escalation contacts). For anything not
covered in this runbook, escalate to engineering rather than guessing.

---

## Escalation contacts

> **Note for Sandeep:** this table is intentionally a stub — replace the
> placeholders with real numbers/handles before launch.

| Role | Name | When to page |
|---|---|---|
| Engineering on-call | _TBD_ | sev1 / sev2 |
| Daraja support | Safaricom (number _TBD_) | webhook outages |
| Africa's Talking | _(number TBD)_ | SMS delivery issues |
| Supabase support | dashboard | database / Edge Function issues |

---

## Severity definitions

| Severity | Meaning | Response |
|---|---|---|
| **P1** | Money stuck, money incorrect, or PII at risk | Page engineering on-call immediately, day or night |
| **P2** | Degraded service — not yet losing money, but trending wrong | Triage within the shift; escalate if unresolved |
| **P3** | Monitoring-only — note it, watch the trend | No page; review at next routine check |

Each panel below cites the severity its **red** state triggers.

---

## Dashboard panels (Strategic — `/admin`)

### Panel 1 — System Health
- **What it shows:** Audit critical events (24h), webhook success rate (24h), last reconciliation run status.
- **Good:** 0 critical events, success rate ≥99%, last run within 24h with status `completed`.
- **Warning thresholds:** 1–4 critical events, success rate 95–99%, last run 24–48h old.
- **Critical thresholds:** 5+ critical events, success rate <95%, last run >48h old or status `failed`.
- **Action on warning:** Open `/admin/soc` → Live Audit Stream → scan for `critical` severity rows. Read the event payloads. Common causes: transient Daraja network issues, recent deploys.
- **Action on critical:** **P1.** Page engineering on-call immediately. Note the `audit_event` IDs and `webhook_event` IDs visible at the moment of incident.

### Panel 2 — Webhook Health (24h)
- **What it shows:** Hourly webhook ingestion bars (one bar per hour, colored by success rate) and replay-attempt count derived from `webhook_nonces`.
- **Good:** Bars green (100% success), replay attempts = 0.
- **Warning thresholds:** One or more amber bars (95–99% success), replay attempts 1–2.
- **Critical thresholds:** Any red bar (<95% success) in the last 3 hours, or replay attempts ≥3.
- **Action on warning:** Cross-check `/admin/soc` → Webhook Failures (panel 10) for the failing source. Confirm it is not a one-off.
- **Action on critical:** **P1** if sustained >10 min. Follow the *Daraja webhook failure spike* playbook below.

### Panel 3 — Risk Engine Trend (24h)
- **What it shows:** Block / step-up / allow decision counts per hour, average risk score (24h), and top block reason codes. _Not visible to `operator`._
- **Good:** Allow dominates, block rate stable vs prior days, avg risk score in its normal band.
- **Warning thresholds:** Block count 2–3× the trailing daily average, or a new reason code climbing the top-5.
- **Critical thresholds:** Block count >5× average (possible attack wave **or** a risk-engine bug after a deploy).
- **Action on warning:** Note the dominant reason code. Check for a recent risk-engine / `riskEngine.js` deploy.
- **Action on critical:** **P2** (or **P1** if blocks are clearly false-positives stopping legitimate payments). Page engineering — a misconfigured threshold can block all customers.

### Panel 4 — Payment Flow Health
- **What it shows:** Stale pending payments (>10 min unresolved) and manual-review queue depth.
- **Good:** Stale = 0, review queue <5.
- **Warning thresholds:** Stale 1–9, review queue 5–19.
- **Critical thresholds:** Stale 10+, review queue 20+.
- **Action on warning:** Stale pending usually means a Daraja callback never arrived. Check panel 2/10. For the review queue, see the *Manual review queue growth* playbook.
- **Action on critical:** **P1** for stale money (customers paid, order not credited). Page engineering and capture the affected `pending_payments` tx_refs.

### Panel 5 — Scam Shield Signals
- **What it shows:** Auth failures (24h), SIM-swap signals (24h), critical security events (24h).
- **Good:** All three at 0.
- **Warning thresholds:** Auth failures 1–9, SIM-swap 1–2, critical 1–4.
- **Critical thresholds:** Auth failures 10+, SIM-swap 3+, critical 5+.
- **Action on warning:** Open `/admin/soc` → Live Audit Stream, filter mentally to `security`/`critical`. Look for clustering by user, geography, or shortcode.
- **Action on critical:** **P1** for a SIM-swap spike — follow the *SIM swap signal spike* playbook. Auth-failure spikes alone are usually credential-stuffing: confirm rate-limits are tripping.

### Panel 6 — Provider Directory Health
- **What it shows:** Verified vs unverified payment-method count and open wrong-number report count.
- **Good:** Verified coverage high, open reports = 0.
- **Warning thresholds:** Open reports 1–4, or a sudden jump in unverified shortcodes.
- **Critical thresholds:** Open reports 5+, especially multiple for one shortcode.
- **Action on warning:** Open `/admin/soc` → Wrong Number Queue (panel 12) and read the reports.
- **Action on critical:** **P2.** Follow the *Provider directory wrong-number reports* playbook. A wrong shortcode routes real money to the wrong recipient.

---

## Incident response panels (Drill-down — `/admin/soc`)

### Panel 7 — Live Audit Stream
- **What it shows:** Last 50 `audit_events` — time, severity, category, event type, actor (first 8 chars of `actor_id`).
- **Good:** Mostly `info` severity; recognizable categories.
- **Warning thresholds:** Repeated `warn` rows of the same event type.
- **Critical thresholds:** Any `critical` rows, or a burst of identical events from one actor.
- **Action on warning:** Hover a row's time for the full timestamp. Note the event type and actor for correlation.
- **Action on critical:** **P1.** Capture the `audit_event` IDs. This stream is also the regulatory-evidence feed — do not clear or filter destructively.

### Panel 8 — Manual Review Queue
- **What it shows:** `payment_reconciliation_events` flagged `requires_manual_review` — created time, tx ref, mismatch type (`amount_mismatch` / `phone_mismatch` / `both`), action.
- **Good:** Queue empty.
- **Warning thresholds:** Items present and aging toward 2h.
- **Critical thresholds:** Any item >24h old, or the queue growing faster than it clears.
- **Action on warning:** Identify the dominant mismatch type (see playbook). Each item should resolve within 2h of creation.
- **Action on critical:** **P2.** Anything >24h old → escalate. Persistent amount mismatches point at Daraja partial settlement; phone mismatches point at MSISDN normalization.

### Panel 9 — Device Trust Registry
- **What it shows:** `trusted_devices` — last seen, device label + fingerprint, user (first 8 chars), trust state, status. **PII panel: `admin` + `auditor` only.** `fraud_analyst` and `operator` see a "Restricted" locked card.
- **Good:** Expected devices, no unexpected recent enrollments.
- **Warning thresholds:** New enrollments for a user who also shows auth failures.
- **Critical thresholds:** New trusted device immediately before a high-value transaction on a flagged account.
- **Action on warning:** Correlate the `user_id` against panels 5 and 7.
- **Action on critical:** **P1.** Revoke the device (see *SIM swap signal spike* playbook). Confirmed ATO = revoke first, investigate second.

### Panel 10 — Webhook Failures & DLQ
- **What it shows:** `webhook_events` with status `failed` — failed-at time, source badge (`daraja`, `africastalking`, …), idempotency key, action.
- **Good:** Empty (no failures in 24h).
- **Warning thresholds:** A handful of failures from one source, not increasing.
- **Critical thresholds:** Continuous new failures, or failures across multiple sources at once.
- **Action on warning:** Note the idempotency keys; confirm whether retries eventually succeeded in panel 2.
- **Action on critical:** **P1.** Follow the *Daraja webhook failure spike* playbook. Open a Daraja support ticket with timestamps.

### Panel 11 — Reconciliation Runs
- **What it shows:** Top — last 10 runs (started, type, status, orphans debit/credit, duration). Bottom — 7-day daily difference trend bar chart (green = 0, amber = <100, red = ≥100).
- **Good:** Recent runs `completed`, 0 orphans, trend bars all green.
- **Warning thresholds:** One amber bar, or a single run with a small orphan count.
- **Critical thresholds:** Red bars two days running, any run with status `failed`, or rising orphan counts.
- **Action on warning:** Open the worst run and note its orphan count and timestamp.
- **Action on critical:** **P1.** Follow the *Reconciliation difference non-zero for 2+ days* playbook. **Freeze ledger deploys until cause is found.**

### Panel 12 — Provider Wrong Number Queue
- **What it shows:** `provider_wrong_number_reports` with status `open` / `investigating` — reported time, shortcode/payment-method id, reporter (first 8 chars), status.
- **Good:** No open reports.
- **Warning thresholds:** Isolated single reports across different shortcodes.
- **Critical thresholds:** Multiple open reports for the **same** shortcode.
- **Action on warning:** Read each report's reason. Decide investigate vs dismiss.
- **Action on critical:** **P2.** Follow the *Provider directory wrong-number reports* playbook — suspend the shortcode if genuinely wrong.

---

## Common incident playbooks

### Playbook: Daraja webhook failure spike
- **Symptoms:** Panel 2 success rate drops <95%; panel 10 (Webhook Failures) shows new entries.
- **First check:** `webhook_nonces` — is the `source_ip` changing? Could be a Daraja routing change.
- **Second check:** Daraja status page — <https://developer.safaricom.co.ke>.
- **Third check:** Recent deploys — has the webhook signature secret rotated?
- **Action:** If isolated, monitor. If sustained >10 minutes, **P1** escalate. Open a Daraja support ticket with timestamps and affected idempotency keys.

### Playbook: Manual review queue growth
- **Symptoms:** Panel 4 (Payment Flow Health) shows review queue >20.
- **Cause:** Reconciliation engine is flagging mismatches faster than they get resolved.
- **First check:** Panel 8 — what is the dominant mismatch type? Amount mismatches usually mean Daraja partial settlement; phone mismatches usually mean an MSISDN normalization bug.
- **Action:** Assign 30 min to triage. Each item should resolve within 2h of creation. Anything >24h old → **P2** escalate.

### Playbook: SIM swap signal spike
- **Symptoms:** Panel 5 shows `sim_swap_signals_24h` > 5.
- **Cause:** Either a coordinated ATO attack **or** a Daraja-side telco reporting glitch.
- **First check:** Panel 7 — filter audit by `event_type='sim_swap_detected'`.
- **Second check:** Identify affected user IDs. Are they clustered by geography, time, or shortcode?
- **Action:** **P1.** Revoke `trusted_devices` for affected users via `admin-verify-provider` or directly in SQL. Reach out to the telco-relations contact at Safaricom.

### Playbook: Reconciliation difference non-zero for 2+ days
- **Symptoms:** Panel 11 trend chart shows red bars two days running.
- **Cause:** Ledger drift — possible double-post, missed callback, or manual ledger edit.
- **First check:** Panel 11 last 10 runs — which run had the biggest orphan count?
- **Second check:** Query `ledger_entries` near the orphan timestamp.
- **Action:** **P1.** This is a money-correctness issue. Page engineering immediately. **Do not deploy any code changes to ledger functions until the cause is identified.**

### Playbook: Provider directory wrong-number reports
- **Symptoms:** Panel 12 shows multiple open reports for the same shortcode.
- **Cause:** Either the shortcode has changed (provider migrated paybill) **or** a typo'd shortcode entered the directory.
- **Action:** Investigate via `admin-verify-provider`. If the shortcode is genuinely wrong, mark `verification_status='suspended'` and create a ticket to find the correct shortcode.

---

## Routine operational tasks

### Daily (first 15 minutes of shift)
- [ ] Check panel 1 — any criticals overnight?
- [ ] Check panel 4 — any stale pending payments?
- [ ] Check panel 8 — any items >24h in manual review?
- [ ] Check panel 11 — was the last reconciliation run successful?

### Weekly
- [ ] Review panel 12 trend — any shortcodes accumulating multiple reports?
- [ ] Review panel 11 7-day trend — are differences trending toward 0 or away from 0?
- [ ] Review panel 5 — any new event types appearing in scam signals?

### Monthly
- [ ] Verify all 4 roles still appropriate for current team composition.
- [ ] Run integration tests against `admin-soc-readonly` to verify the Edge Function still meets contract (`npm run test:integration`).
- [ ] Review `docs/SHADOW_STACK_AUDIT.md` and `docs/PROVIDER_DIRECTORY_ACTIVATION.md` for relevance.

---

## What this runbook does NOT cover
- User support workflows (separate runbook).
- Hiring / onboarding new ops staff (separate doc).
- Compliance / regulatory reporting (separate doc, owner: legal).
- Daraja go-live and certification (Sandeep's notes).
