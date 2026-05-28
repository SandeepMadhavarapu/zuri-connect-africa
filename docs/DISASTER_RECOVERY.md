# Disaster recovery — Zuri Connect Africa

## Immutable ledger

Ledger entries are hash-chained in client-side services; production systems should persist authoritative state in Supabase Postgres with RLS. **Never delete** ledger rows; use compensating entries.

## Append-only snapshots

`reconciliationEngine` maintains snapshot keys in `localStorage` for offline-first UX. Server-side: enable **Point-in-Time Recovery (PITR)** on Supabase production databases and retain backups per compliance needs.

## Automated backups

- Supabase: scheduled backups (dashboard) + optional logical dumps to object storage.
- Artifacts: CI uploads build artifacts and coverage; retain Docker images by digest in your registry.

## Replay recovery

- **Ledger replay**: `replayLedger` validates double-entry consistency — run after outage to detect drift.
- **Queue replay**: dead-letter queue entries should be replayable idempotently — use idempotency keys stored in `src` idempotency utilities.

## Queue replay safety

Before replaying DLQ messages:

1. Verify idempotency record prevents duplicate financial posts.
2. Confirm settlement state machine allows transition.
3. Attach correlation ID for audit.

## Rollback-safe deployments

- Frontend: promote previous Vercel deployment or redeploy prior container image digest.
- Database: restore from PITR snapshot; replay compensating transactions if partial writes occurred.

## Reconciliation recovery

After extended outage:

1. Run reconciliation job (Edge Function / scheduled worker).
2. Compare settlement totals vs. ledger replay output.
3. Open incidents for mismatches; block new high-value transfers until cleared.

## Dead-letter queue recovery

1. Drain DLQ to a staging replay topic.
2. Validate each payload signature and timestamp (replay window).
3. Re-submit through the primary processor with idempotency headers.

## Runbook contacts

Define on-call rotations and escalation for fraud + settlement teams in your internal wiki (not committed here).
