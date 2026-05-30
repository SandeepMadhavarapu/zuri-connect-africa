# Provider Directory Activation Guide

## Overview

The provider directory gate in `initiate-payment` blocks paybill and till payments to shortcodes that are not present in `provider_payment_methods` with `verification_status = 'verified'`. The gate is controlled by the `ZURI_REQUIRE_VERIFIED_PROVIDER` Edge Function secret.

**Current state:** The gate is deployed but dormant. `ZURI_REQUIRE_VERIFIED_PROVIDER` is unset, so all paybill/till payments pass through regardless of directory state.

**Where the gate lives:** `supabase/functions/initiate-payment/index.ts` — inserted after phone match validation, before `buildPendingPaymentRecord`. On rejection it returns HTTP 422 with `{"error": "unverified_provider"}`.

**Why it exists:** Prevents payments to fraudulent or unregistered shortcodes. Only admins running the `admin-verify-provider` Edge Function can add verified entries.

---

## Activation Procedure

Follow these steps in order. Do not skip steps.

### Step 0 — Understand the seed-admin system user

Running this seed creates a system user in `auth.users`:

| Field | Value |
|---|---|
| UUID | `aaaa0000-0000-0000-0000-000000000001` |
| Email | `seed-admin@zuriconnect.internal` |
| Password | None |
| Role | `seed_script` (not `admin`) |

**This is normal, expected, and required for a correct audit trail.** The seed-admin user exists solely as the FK target for `provider_verification_sources.verified_by` and `provider_audit_events.actor_id`. Without it, those columns would reference an orphan sentinel UUID that resolves to nothing in `auth.users` — misleading for auditors. The `actor_role = 'seed_script'` value distinguishes these rows from real admin actions.

The seed-admin user:
- **cannot log in** — `encrypted_password` is NULL; no JWT will ever be issued for it
- **has no real email account** — `seed-admin@zuriconnect.internal` is an internal placeholder only
- **has no application permissions** — `app_metadata.role` is `"seed_script"`, not `"admin"`, so it cannot call any privileged Edge Function

To remove it in future (e.g., before a formal audit): first delete all seed verification rows that reference it (`provider_verification_sources` and `provider_audit_events` rows with `actor_id = 'aaaa0000-0000-0000-0000-000000000001'`), then delete the `auth.users` row. Always do this inside a transaction.

### Step 1 — Apply the demo seed

The gate requires at least one verified entry in `provider_payment_methods` before it is turned on, or all paybill/till payments will be rejected.

Open the Supabase dashboard → SQL Editor, paste and run the contents of:

```
supabase/seed/provider_directory_demo.sql
```

Or via psql (replace `<connection-string>` with your database URL):

```bash
psql <connection-string> -f supabase/seed/provider_directory_demo.sql
```

The seed is idempotent — running it twice does not create duplicate rows.

### Step 2 — Verify the seed

In the SQL Editor, run:

```sql
SELECT id, method_type, shortcode, verification_status, last_verified_at, notes
FROM public.provider_payment_methods
WHERE verification_status = 'verified';
```

Expected result: at least 1 row with `shortcode = '888880'` and `verification_status = 'verified'`.

### Step 3 — Set the env flag

```bash
npx supabase secrets set ZURI_REQUIRE_VERIFIED_PROVIDER=true --project-ref nyqsnznglklqgaezsisv
```

### Step 4 — Redeploy initiate-payment

The function must be redeployed to pick up the new secret:

```bash
npx supabase functions deploy initiate-payment
```

### Step 5 — Smoke test

**Verified shortcode (should succeed):**
Call `initiate-payment` with a valid JWT and `"payment_type": "paybill"`, `"to_phone": "888880"`. The gate should pass and the payment should proceed to the risk engine.

**Unverified shortcode (should be rejected):**
Call `initiate-payment` with `"payment_type": "paybill"`, `"to_phone": "999999"`. Expected response:

```json
HTTP 422
{
  "error": "unverified_provider",
  "message": "This destination is not in our verified provider directory. You can search verified billers via provider-search."
}
```

**Send-money (should be unaffected):**
Call `initiate-payment` with `"payment_type": "send"`. The gate does not apply to peer-to-peer transfers regardless of the flag.

---

## Rollback Procedure

If the gate causes unexpected failures, roll back immediately — no migration needed:

### Step 1 — Unset the flag

```bash
npx supabase secrets unset ZURI_REQUIRE_VERIFIED_PROVIDER --project-ref nyqsnznglklqgaezsisv
```

### Step 2 — Redeploy to pick up the unset

```bash
npx supabase functions deploy initiate-payment
```

The gate is dormant again. Payments flow normally. Diagnose the failure before re-activating.

---

## Warnings

**The seed entry is DEMO ONLY.**
The KPLC PayBill 888880 entry was inserted by a seed script, not verified by an admin through the `admin-verify-provider` Edge Function with real evidence. Do not present this entry to auditors or Safaricom reviewers as proof of directory verification.

**Before launch, replace the demo seed with real entries.**
Real verified entries must go through `admin-verify-provider` with a valid `source_type` and `source_reference` (e.g., Safaricom directory cross-check, provider letter, utility invoice). The seed entry should be deleted or superseded before any public production launch.

**Minimum coverage for production launch.**
With only 1 verified entry (KPLC PayBill 888880), all other paybill/till shortcodes will be rejected once the gate is active. Production launch requires at least 5 real verified entries covering the most common billers (KPLC, Nairobi Water, DSTV, Safaricom postpaid, a major bank paybill). Use `admin-verify-provider` to add them.
