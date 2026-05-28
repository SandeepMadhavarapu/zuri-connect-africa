-- Immutable ledger: one row per (transaction_ref, entry_type) to block replay/retry/refresh duplicates.
-- Application uses upsert on this pair; append-only semantics preserved by never issuing UPDATE/DELETE client paths.

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_tx_ref_entry_type
  ON public.ledger_entries (transaction_ref, entry_type);
