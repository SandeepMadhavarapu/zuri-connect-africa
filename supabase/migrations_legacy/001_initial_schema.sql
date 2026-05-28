-- =============================================================================
-- Zuri Connect Africa — Initial PostgreSQL Schema
-- Migration: 001_initial_schema
-- Compatible: Supabase (PostgreSQL 15+)
-- =============================================================================
-- Design principles:
--   • Ledger and audit tables are append-only (enforced by trigger)
--   • All monetary amounts stored as INTEGER (minor units / cents)
--   • Optimistic concurrency via version columns
--   • Soft-delete via deleted_at on mutable tables
--   • All timestamps UTC with timezone
--   • UUID primary keys using gen_random_uuid()
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- fuzzy search on phone numbers
CREATE EXTENSION IF NOT EXISTS "btree_gist";  -- exclusion constraints on ranges

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
CREATE TYPE account_status     AS ENUM ('active','suspended','closed','pending_kyc');
CREATE TYPE kyc_level          AS ENUM ('none','basic','standard','enhanced');
CREATE TYPE session_status     AS ENUM ('active','expired','revoked','suspicious');
CREATE TYPE device_trust_level AS ENUM ('trusted','provisional','untrusted','blocked');
CREATE TYPE tx_type            AS ENUM ('send_money','receive_money','buy_airtime','buy_bundle','paybill','till_payment','withdrawal','deposit','reversal','fee','interest','adjustment');
CREATE TYPE tx_status          AS ENUM ('pending','processing','completed','failed','reversed','disputed','on_hold');
CREATE TYPE entry_direction    AS ENUM ('debit','credit');
CREATE TYPE fraud_severity     AS ENUM ('low','medium','high','critical');
CREATE TYPE fraud_resolution   AS ENUM ('open','investigating','confirmed_fraud','false_positive','escalated');
CREATE TYPE effect_type        AS ENUM ('ALLOW','REVIEW','ESCALATE','DENY');
CREATE TYPE webhook_status     AS ENUM ('pending','delivered','failed','retrying','dead_letter');
CREATE TYPE job_status         AS ENUM ('queued','processing','completed','failed','dead_letter','cancelled');
CREATE TYPE reconcile_status   AS ENUM ('pending','running','completed','failed','requires_review');
CREATE TYPE dispute_status     AS ENUM ('open','under_review','resolved_for_user','resolved_for_merchant','closed');
CREATE TYPE channel_type       AS ENUM ('ussd','stk_push','app','api','web','ivr');
CREATE TYPE notification_type  AS ENUM ('sms','push','email','in_app','webhook');
CREATE TYPE compliance_flag    AS ENUM ('aml_alert','ctr_required','sar_filed','ofac_match','pep_match','sanctions_match');

-- ---------------------------------------------------------------------------
-- Helper: updated_at trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helper: append-only enforcement trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. Updates and deletes are not permitted.',
    TG_TABLE_NAME;
END;
$$;

-- ===========================================================================
-- CORE IDENTITY
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           TEXT        NOT NULL UNIQUE,
  country_code    TEXT        NOT NULL DEFAULT 'KE',
  display_name    TEXT,
  email           TEXT,
  account_status  account_status NOT NULL DEFAULT 'pending_kyc',
  kyc_level       kyc_level      NOT NULL DEFAULT 'none',
  kyc_verified_at TIMESTAMPTZ,

  -- Financial profile
  primary_currency  TEXT    NOT NULL DEFAULT 'KES',
  daily_limit_minor BIGINT  NOT NULL DEFAULT 100000,    -- 1 000 KES
  monthly_limit_minor BIGINT NOT NULL DEFAULT 3000000, -- 30 000 KES

  -- Risk profile
  risk_score      SMALLINT    NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  fraud_flags     JSONB       NOT NULL DEFAULT '[]',
  pep_status      BOOLEAN     NOT NULL DEFAULT FALSE,
  sanctions_match BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Metadata
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  version     INTEGER     NOT NULL DEFAULT 1,
  metadata    JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_users_phone          ON users (phone);
CREATE INDEX idx_users_account_status ON users (account_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_risk_score     ON users (risk_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_phone_trgm     ON users USING gin (phone gin_trgm_ops);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  device_id       TEXT        NOT NULL,
  fingerprint     TEXT        NOT NULL,
  trust_level     device_trust_level NOT NULL DEFAULT 'provisional',
  trust_score     SMALLINT    NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  platform        TEXT,       -- 'android'|'ios'|'web'
  os_version      TEXT,
  app_version     TEXT,
  push_token      TEXT,

  -- Geolocation snapshot
  last_country    TEXT,
  last_region     TEXT,
  last_lat        DOUBLE PRECISION,
  last_lon        DOUBLE PRECISION,
  last_ip         INET,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Risk signals
  sim_swap_detected   BOOLEAN NOT NULL DEFAULT FALSE,
  vpn_detected        BOOLEAN NOT NULL DEFAULT FALSE,
  rooted_jailbroken   BOOLEAN NOT NULL DEFAULT FALSE,
  impossible_travel   BOOLEAN NOT NULL DEFAULT FALSE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  version     INTEGER     NOT NULL DEFAULT 1,

  UNIQUE (user_id, device_id)
);

CREATE INDEX idx_devices_user_id     ON devices (user_id);
CREATE INDEX idx_devices_fingerprint ON devices (fingerprint);
CREATE INDEX idx_devices_trust_level ON devices (trust_level) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id       UUID        REFERENCES devices (id) ON DELETE SET NULL,
  token_hash      TEXT        NOT NULL UNIQUE,  -- SHA-256 of session token
  refresh_hash    TEXT        UNIQUE,
  status          session_status NOT NULL DEFAULT 'active',

  -- Context
  channel         channel_type NOT NULL DEFAULT 'app',
  ip_address      INET,
  user_agent      TEXT,
  country         TEXT,
  auth_method     TEXT,       -- 'pin','face_id','webauthn','otp'

  -- Timing
  auth_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,

  -- Risk
  risk_score_at_auth SMALLINT NOT NULL DEFAULT 0,
  step_up_required   BOOLEAN  NOT NULL DEFAULT FALSE,
  step_up_reason     TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_status     ON sessions (status) WHERE status = 'active';
CREATE INDEX idx_sessions_expires    ON sessions (expires_at) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- passkeys (WebAuthn credentials)
-- ---------------------------------------------------------------------------
CREATE TABLE passkeys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id       UUID        REFERENCES devices (id) ON DELETE SET NULL,
  credential_id   BYTEA       NOT NULL UNIQUE,
  public_key      BYTEA       NOT NULL,
  counter         BIGINT      NOT NULL DEFAULT 0,
  aaguid          UUID,
  transports      TEXT[]      NOT NULL DEFAULT '{}',
  backup_eligible BOOLEAN     NOT NULL DEFAULT FALSE,
  backed_up       BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_passkeys_user_id ON passkeys (user_id) WHERE is_active = TRUE;

-- ===========================================================================
-- FINANCIAL LEDGER
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- accounts (virtual wallet accounts)
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  currency        TEXT        NOT NULL DEFAULT 'KES',
  balance_minor   BIGINT      NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  available_minor BIGINT      NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  reserved_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),

  is_frozen       BOOLEAN     NOT NULL DEFAULT FALSE,
  frozen_reason   TEXT,
  frozen_at       TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version     INTEGER     NOT NULL DEFAULT 1,

  -- Invariant: balance = available + reserved
  CONSTRAINT chk_balance_split CHECK (balance_minor = available_minor + reserved_minor)
);

CREATE INDEX idx_accounts_user_id ON accounts (user_id);

CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ledger_entries — APPEND-ONLY
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  tx_id           UUID,       -- references transactions.id (nullable for system entries)
  direction       entry_direction NOT NULL,
  amount_minor    BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency        TEXT        NOT NULL DEFAULT 'KES',
  balance_after   BIGINT      NOT NULL CHECK (balance_after >= 0),

  -- Double-entry reference
  counterpart_entry_id UUID,  -- the matching debit/credit

  -- Audit chain
  prev_hash       TEXT        NOT NULL DEFAULT '',
  entry_hash      TEXT        NOT NULL,  -- SHA-256(prev_hash || id || account_id || amount || ts)

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memo            TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_ledger_account_id    ON ledger_entries (account_id, created_at DESC);
CREATE INDEX idx_ledger_user_id       ON ledger_entries (user_id, created_at DESC);
CREATE INDEX idx_ledger_tx_id         ON ledger_entries (tx_id) WHERE tx_id IS NOT NULL;
CREATE INDEX idx_ledger_created_at    ON ledger_entries (created_at DESC);

-- Enforce append-only
CREATE TRIGGER trg_ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reference       TEXT        NOT NULL UNIQUE,    -- external idempotency key
  internal_ref    TEXT        NOT NULL UNIQUE DEFAULT ('ZC-' || substr(gen_random_uuid()::TEXT, 1, 8)),
  tx_type         tx_type     NOT NULL,
  status          tx_status   NOT NULL DEFAULT 'pending',
  channel         channel_type NOT NULL DEFAULT 'app',

  -- Parties
  from_account_id UUID        REFERENCES accounts (id) ON DELETE RESTRICT,
  to_account_id   UUID        REFERENCES accounts (id) ON DELETE RESTRICT,
  from_phone      TEXT        NOT NULL DEFAULT '',
  to_phone        TEXT        NOT NULL DEFAULT '',
  merchant_code   TEXT,
  merchant_name   TEXT,

  -- Amounts
  amount_minor    BIGINT      NOT NULL CHECK (amount_minor > 0),
  fee_minor       BIGINT      NOT NULL DEFAULT 0,
  currency        TEXT        NOT NULL DEFAULT 'KES',

  -- Reconciliation
  provider_ref    TEXT,       -- M-PESA confirmation code, etc.
  provider_status TEXT,
  settled_at      TIMESTAMPTZ,
  settlement_delay_ms INT     NOT NULL DEFAULT 0,

  -- Risk & policy
  risk_score      SMALLINT    NOT NULL DEFAULT 0,
  policy_effect   effect_type NOT NULL DEFAULT 'ALLOW',
  policy_correlation_id TEXT,
  fraud_reviewed  BOOLEAN     NOT NULL DEFAULT FALSE,
  on_hold         BOOLEAN     NOT NULL DEFAULT FALSE,
  hold_reason     TEXT,

  -- Timing
  initiated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INTEGER     NOT NULL DEFAULT 1,
  metadata        JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_tx_user_id         ON transactions (user_id, created_at DESC);
CREATE INDEX idx_tx_reference       ON transactions (reference);
CREATE INDEX idx_tx_from_phone      ON transactions (from_phone, created_at DESC);
CREATE INDEX idx_tx_to_phone        ON transactions (to_phone, created_at DESC);
CREATE INDEX idx_tx_status          ON transactions (status) WHERE status IN ('pending','processing','on_hold');
CREATE INDEX idx_tx_provider_ref    ON transactions (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX idx_tx_policy_effect   ON transactions (policy_effect) WHERE policy_effect != 'ALLOW';
CREATE INDEX idx_tx_created_at      ON transactions (created_at DESC);
-- For velocity queries
CREATE INDEX idx_tx_velocity        ON transactions (from_phone, created_at DESC) WHERE status = 'completed';

CREATE TRIGGER trg_tx_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- account_limits — tiered limits per user
-- ---------------------------------------------------------------------------
CREATE TABLE account_limits (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kyc_level       kyc_level   NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'KES',

  -- Per-transaction limits
  single_tx_min   BIGINT      NOT NULL DEFAULT 100,
  single_tx_max   BIGINT      NOT NULL DEFAULT 70000,

  -- Rolling window limits
  daily_max       BIGINT      NOT NULL DEFAULT 100000,
  weekly_max      BIGINT      NOT NULL DEFAULT 500000,
  monthly_max     BIGINT      NOT NULL DEFAULT 3000000,

  -- Cooldown enforcement
  cooldown_until  TIMESTAMPTZ,
  cooldown_reason TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, kyc_level, currency)
);

CREATE INDEX idx_limits_user_id ON account_limits (user_id);

CREATE TRIGGER trg_limits_updated_at
  BEFORE UPDATE ON account_limits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- SETTLEMENTS & REVERSALS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- settlements
-- ---------------------------------------------------------------------------
CREATE TABLE settlements (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id           UUID        NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  provider        TEXT        NOT NULL,   -- 'mpesa','airtel','equity_eazzy'
  provider_ref    TEXT,
  amount_minor    BIGINT      NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'KES',
  fee_minor       BIGINT      NOT NULL DEFAULT 0,
  net_minor       BIGINT      GENERATED ALWAYS AS (amount_minor - fee_minor) STORED,
  status          TEXT        NOT NULL DEFAULT 'pending',
  settled_at      TIMESTAMPTZ,
  failure_reason  TEXT,
  retry_count     SMALLINT    NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_settlements_tx_id      ON settlements (tx_id);
CREATE INDEX idx_settlements_status     ON settlements (status) WHERE status != 'settled';
CREATE INDEX idx_settlements_provider   ON settlements (provider, settled_at DESC);
CREATE INDEX idx_settlements_retry      ON settlements (next_retry_at) WHERE status = 'pending' AND retry_count > 0;

CREATE TRIGGER trg_settlements_updated_at
  BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- reversals
-- ---------------------------------------------------------------------------
CREATE TABLE reversals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  original_tx_id  UUID        NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  reversal_tx_id  UUID        REFERENCES transactions (id) ON DELETE RESTRICT,
  initiated_by    UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reason          TEXT        NOT NULL,
  amount_minor    BIGINT      NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'requested',   -- requested|approved|rejected|completed
  approved_by     UUID        REFERENCES users (id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_reversals_original_tx ON reversals (original_tx_id);
CREATE INDEX idx_reversals_status      ON reversals (status) WHERE status IN ('requested','approved');

CREATE TRIGGER trg_reversals_updated_at
  BEFORE UPDATE ON reversals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- disputes
-- ---------------------------------------------------------------------------
CREATE TABLE disputes (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id           UUID            NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  user_id         UUID            NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status          dispute_status  NOT NULL DEFAULT 'open',
  category        TEXT            NOT NULL,   -- 'unauthorized','duplicate','wrong_amount','not_received'
  description     TEXT,
  evidence_urls   TEXT[]          NOT NULL DEFAULT '{}',
  resolution_note TEXT,
  resolved_by     UUID            REFERENCES users (id),
  resolved_at     TIMESTAMPTZ,
  escalated_at    TIMESTAMPTZ,
  due_by          TIMESTAMPTZ     NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_disputes_tx_id  ON disputes (tx_id);
CREATE INDEX idx_disputes_user   ON disputes (user_id);
CREATE INDEX idx_disputes_status ON disputes (status) WHERE status != 'closed';
CREATE INDEX idx_disputes_due    ON disputes (due_by) WHERE status IN ('open','under_review');

CREATE TRIGGER trg_disputes_updated_at
  BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- FRAUD & SECURITY
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fraud_events — APPEND-ONLY
-- ---------------------------------------------------------------------------
CREATE TABLE fraud_events (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  tx_id           UUID          REFERENCES transactions (id) ON DELETE SET NULL,
  session_id      UUID          REFERENCES sessions (id) ON DELETE SET NULL,
  device_id       UUID          REFERENCES devices (id) ON DELETE SET NULL,

  event_type      TEXT          NOT NULL,   -- 'sim_swap','impossible_travel','velocity_spike',...
  severity        fraud_severity NOT NULL DEFAULT 'medium',
  resolution      fraud_resolution NOT NULL DEFAULT 'open',

  -- Signal snapshot
  risk_score      SMALLINT      NOT NULL DEFAULT 0,
  policy_id       TEXT,
  policy_name     TEXT,
  triggered_rules JSONB         NOT NULL DEFAULT '[]',
  context_snapshot JSONB        NOT NULL DEFAULT '{}',  -- trimmed context at event time

  -- Analyst notes
  analyst_id      UUID          REFERENCES users (id) ON DELETE SET NULL,
  analyst_note    TEXT,
  reviewed_at     TIMESTAMPTZ,

  -- Immutable chain
  prev_hash       TEXT          NOT NULL DEFAULT '',
  entry_hash      TEXT          NOT NULL,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fraud_user_id    ON fraud_events (user_id, created_at DESC);
CREATE INDEX idx_fraud_tx_id      ON fraud_events (tx_id) WHERE tx_id IS NOT NULL;
CREATE INDEX idx_fraud_severity   ON fraud_events (severity, created_at DESC) WHERE resolution = 'open';
CREATE INDEX idx_fraud_resolution ON fraud_events (resolution) WHERE resolution IN ('open','investigating');
CREATE INDEX idx_fraud_event_type ON fraud_events (event_type, created_at DESC);

CREATE TRIGGER trg_fraud_append_only
  BEFORE UPDATE OR DELETE ON fraud_events
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ---------------------------------------------------------------------------
-- fraud_graph_nodes
-- ---------------------------------------------------------------------------
CREATE TABLE fraud_graph_nodes (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type   TEXT    NOT NULL,   -- 'phone','device','ip','account'
  node_value  TEXT    NOT NULL,
  risk_score  SMALLINT NOT NULL DEFAULT 0,
  flags       TEXT[]  NOT NULL DEFAULT '{}',
  is_blocked  BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (node_type, node_value)
);

CREATE INDEX idx_fraud_node_value ON fraud_graph_nodes (node_value);
CREATE INDEX idx_fraud_node_risk  ON fraud_graph_nodes (risk_score DESC) WHERE is_blocked = FALSE;

CREATE TRIGGER trg_fraud_nodes_updated_at
  BEFORE UPDATE ON fraud_graph_nodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- fraud_graph_edges
-- ---------------------------------------------------------------------------
CREATE TABLE fraud_graph_edges (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  source_node_id  UUID    NOT NULL REFERENCES fraud_graph_nodes (id) ON DELETE CASCADE,
  target_node_id  UUID    NOT NULL REFERENCES fraud_graph_nodes (id) ON DELETE CASCADE,
  edge_type       TEXT    NOT NULL,   -- 'transacted_with','shares_device','shares_ip'
  weight          REAL    NOT NULL DEFAULT 1.0,
  tx_count        INT     NOT NULL DEFAULT 1,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (source_node_id, target_node_id, edge_type)
);

CREATE INDEX idx_fraud_edge_source ON fraud_graph_edges (source_node_id);
CREATE INDEX idx_fraud_edge_target ON fraud_graph_edges (target_node_id);

-- ---------------------------------------------------------------------------
-- threat_signals
-- ---------------------------------------------------------------------------
CREATE TABLE threat_signals (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type TEXT    NOT NULL,   -- 'global_threat','watchlist','velocity_pattern'
  indicator   TEXT    NOT NULL,   -- phone / IP / pattern
  score       SMALLINT NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  source      TEXT    NOT NULL DEFAULT 'internal',
  confidence  REAL    NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threat_indicator ON threat_signals (indicator, signal_type);
CREATE INDEX idx_threat_expires   ON threat_signals (expires_at) WHERE expires_at IS NOT NULL;

CREATE TRIGGER trg_threat_signals_updated_at
  BEFORE UPDATE ON threat_signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- POLICY ENGINE PERSISTENCE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- policy_evaluations — APPEND-ONLY
-- ---------------------------------------------------------------------------
CREATE TABLE policy_evaluations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id       TEXT        NOT NULL UNIQUE,
  tx_id                UUID        REFERENCES transactions (id) ON DELETE SET NULL,
  user_id              UUID        REFERENCES users (id) ON DELETE SET NULL,
  session_id           UUID        REFERENCES sessions (id) ON DELETE SET NULL,

  final_effect         effect_type NOT NULL,
  observed_effect      effect_type NOT NULL,
  is_dry_run           BOOLEAN     NOT NULL DEFAULT FALSE,

  triggered_count      SMALLINT    NOT NULL DEFAULT 0,
  total_evaluated      SMALLINT    NOT NULL DEFAULT 0,
  triggered_policies   JSONB       NOT NULL DEFAULT '[]',  -- [{policyId, severity, effect}]
  aggregated_actions   JSONB       NOT NULL DEFAULT '[]',
  auth_requirements    JSONB       NOT NULL DEFAULT '{}',
  composite_score      SMALLINT    NOT NULL DEFAULT 0,

  evaluation_latency_ms SMALLINT   NOT NULL DEFAULT 0,
  context_meta         JSONB       NOT NULL DEFAULT '{}',  -- trimmed context

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policy_eval_user       ON policy_evaluations (user_id, created_at DESC);
CREATE INDEX idx_policy_eval_effect     ON policy_evaluations (final_effect) WHERE final_effect != 'ALLOW';
CREATE INDEX idx_policy_eval_created    ON policy_evaluations (created_at DESC);
CREATE INDEX idx_policy_eval_corr       ON policy_evaluations (correlation_id);

CREATE TRIGGER trg_policy_eval_append_only
  BEFORE UPDATE OR DELETE ON policy_evaluations
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ===========================================================================
-- WEBHOOKS & EVENTS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT            NOT NULL,
  payload         JSONB           NOT NULL,
  source          TEXT            NOT NULL DEFAULT 'internal',
  source_ip       INET,
  signature       TEXT,           -- HMAC-SHA256 hex
  status          webhook_status  NOT NULL DEFAULT 'pending',

  -- Delivery tracking
  attempts        SMALLINT        NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,
  failure_reason  TEXT,

  -- Idempotency
  idempotency_key TEXT            UNIQUE,
  received_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ     NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

  -- Correlation
  tx_id           UUID            REFERENCES transactions (id) ON DELETE SET NULL,
  user_id         UUID            REFERENCES users (id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_status       ON webhook_events (status) WHERE status IN ('pending','retrying');
CREATE INDEX idx_webhook_event_type   ON webhook_events (event_type, created_at DESC);
CREATE INDEX idx_webhook_next_retry   ON webhook_events (next_retry_at) WHERE status = 'retrying';
CREATE INDEX idx_webhook_idempotency  ON webhook_events (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ===========================================================================
-- QUEUE SYSTEM
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- queue_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE queue_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name      TEXT        NOT NULL,   -- 'payments','settlements','notifications'
  job_type        TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  status          job_status  NOT NULL DEFAULT 'queued',
  priority        SMALLINT    NOT NULL DEFAULT 50,  -- 0 = highest, 100 = lowest

  -- Idempotency
  idempotency_key TEXT        UNIQUE,

  -- Execution tracking
  attempts        SMALLINT    NOT NULL DEFAULT 0,
  max_attempts    SMALLINT    NOT NULL DEFAULT 5,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by      TEXT,       -- worker instance ID
  claimed_at      TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,

  -- Correlation
  correlation_id  TEXT,
  tx_id           UUID        REFERENCES transactions (id) ON DELETE SET NULL,
  user_id         UUID        REFERENCES users (id) ON DELETE SET NULL,

  -- Scheduling
  run_after       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_queue_runnable    ON queue_jobs (queue_name, priority ASC, next_run_at ASC)
  WHERE status = 'queued';
CREATE INDEX idx_queue_status      ON queue_jobs (status, queue_name);
CREATE INDEX idx_queue_idem        ON queue_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_queue_lock_exp    ON queue_jobs (lock_expires_at) WHERE status = 'processing';
CREATE INDEX idx_queue_correlation ON queue_jobs (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TRIGGER trg_queue_updated_at
  BEFORE UPDATE ON queue_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- RECONCILIATION
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- reconciliation_reports
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_reports (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date     DATE              NOT NULL,
  provider        TEXT              NOT NULL,
  status          reconcile_status  NOT NULL DEFAULT 'pending',

  -- Totals
  total_transactions_internal INT   NOT NULL DEFAULT 0,
  total_transactions_provider INT   NOT NULL DEFAULT 0,
  matched_count   INT               NOT NULL DEFAULT 0,
  unmatched_internal_count INT      NOT NULL DEFAULT 0,
  unmatched_provider_count INT      NOT NULL DEFAULT 0,
  disputed_count  INT               NOT NULL DEFAULT 0,

  -- Amounts (in minor units)
  total_amount_internal BIGINT      NOT NULL DEFAULT 0,
  total_amount_provider BIGINT      NOT NULL DEFAULT 0,
  amount_discrepancy    BIGINT      GENERATED ALWAYS AS (total_amount_internal - total_amount_provider) STORED,

  -- Execution
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failure_reason  TEXT,
  initiated_by    UUID              REFERENCES users (id) ON DELETE SET NULL,

  -- Detail
  unmatched_refs  JSONB             NOT NULL DEFAULT '[]',
  summary_notes   TEXT,

  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  UNIQUE (report_date, provider)
);

CREATE INDEX idx_recon_date     ON reconciliation_reports (report_date DESC);
CREATE INDEX idx_recon_status   ON reconciliation_reports (status) WHERE status IN ('pending','running','requires_review');
CREATE INDEX idx_recon_provider ON reconciliation_reports (provider, report_date DESC);

CREATE TRIGGER trg_recon_updated_at
  BEFORE UPDATE ON reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- TELECOM & CHANNEL OPERATIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- telecom_events — APPEND-ONLY
-- ---------------------------------------------------------------------------
CREATE TABLE telecom_events (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    REFERENCES users (id) ON DELETE SET NULL,
  event_type  TEXT    NOT NULL,   -- 'ussd_session','stk_push','sim_swap','number_port'
  channel     channel_type NOT NULL DEFAULT 'ussd',
  phone       TEXT    NOT NULL,
  session_id  TEXT,
  payload     JSONB   NOT NULL DEFAULT '{}',
  duration_ms INT,
  success     BOOLEAN,
  error_code  TEXT,
  carrier     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_telecom_user     ON telecom_events (user_id, created_at DESC);
CREATE INDEX idx_telecom_phone    ON telecom_events (phone, created_at DESC);
CREATE INDEX idx_telecom_type     ON telecom_events (event_type, created_at DESC);

CREATE TRIGGER trg_telecom_append_only
  BEFORE UPDATE OR DELETE ON telecom_events
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ===========================================================================
-- NOTIFICATIONS & AI INTERACTIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type            notification_type NOT NULL,
  channel         TEXT              NOT NULL,
  subject         TEXT,
  body            TEXT              NOT NULL,
  metadata        JSONB             NOT NULL DEFAULT '{}',
  is_read         BOOLEAN           NOT NULL DEFAULT FALSE,
  read_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  tx_id           UUID              REFERENCES transactions (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_user_unread ON notifications (user_id, created_at DESC) WHERE is_read = FALSE;
CREATE INDEX idx_notif_tx_id       ON notifications (tx_id) WHERE tx_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ai_interactions — APPEND-ONLY
-- ---------------------------------------------------------------------------
CREATE TABLE ai_interactions (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID    REFERENCES users (id) ON DELETE SET NULL,
  session_id      UUID    REFERENCES sessions (id) ON DELETE SET NULL,
  model           TEXT    NOT NULL,
  feature         TEXT    NOT NULL,   -- 'scam_shield','voice_verify','chat_assist'
  input_tokens    INT     NOT NULL DEFAULT 0,
  output_tokens   INT     NOT NULL DEFAULT 0,
  latency_ms      INT     NOT NULL DEFAULT 0,
  success         BOOLEAN NOT NULL DEFAULT TRUE,
  error_code      TEXT,
  context_flags   JSONB   NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_user_id   ON ai_interactions (user_id, created_at DESC);
CREATE INDEX idx_ai_feature   ON ai_interactions (feature, created_at DESC);

CREATE TRIGGER trg_ai_append_only
  BEFORE UPDATE OR DELETE ON ai_interactions
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ===========================================================================
-- COMPLIANCE & AUDIT
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- compliance_flags
-- ---------------------------------------------------------------------------
CREATE TABLE compliance_flags (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID              NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  tx_id           UUID              REFERENCES transactions (id) ON DELETE SET NULL,
  flag_type       compliance_flag   NOT NULL,
  reason          TEXT              NOT NULL,
  amount_minor    BIGINT,
  currency        TEXT,
  status          TEXT              NOT NULL DEFAULT 'open',  -- open|under_review|filed|dismissed
  reporter_id     UUID              REFERENCES users (id) ON DELETE SET NULL,
  reported_at     TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compliance_user   ON compliance_flags (user_id, created_at DESC);
CREATE INDEX idx_compliance_type   ON compliance_flags (flag_type, status);
CREATE INDEX idx_compliance_open   ON compliance_flags (status) WHERE status = 'open';

CREATE TRIGGER trg_compliance_updated_at
  BEFORE UPDATE ON compliance_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_log — APPEND-ONLY, immutable
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID    REFERENCES users (id) ON DELETE SET NULL,
  actor_id        UUID    REFERENCES users (id) ON DELETE SET NULL,
  session_id      UUID    REFERENCES sessions (id) ON DELETE SET NULL,
  category        TEXT    NOT NULL,   -- 'AUTH','SESSION','STEPUP','RISK','ATO','TX','ADMIN'
  event           TEXT    NOT NULL,
  severity        TEXT    NOT NULL DEFAULT 'info',  -- 'info','warn','error','critical'
  details         JSONB   NOT NULL DEFAULT '{}',
  ip_address      INET,
  user_agent      TEXT,
  request_id      TEXT,

  -- Immutable hash chain
  prev_hash       TEXT    NOT NULL DEFAULT '',
  entry_hash      TEXT    NOT NULL,   -- SHA-256(prev_hash || id || category || event || ts)

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user_id    ON audit_log (user_id, created_at DESC);
CREATE INDEX idx_audit_category   ON audit_log (category, created_at DESC);
CREATE INDEX idx_audit_severity   ON audit_log (severity, created_at DESC) WHERE severity IN ('warn','error','critical');
CREATE INDEX idx_audit_created_at ON audit_log (created_at DESC);

CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ===========================================================================
-- SCHEMA VERSION
-- ===========================================================================
CREATE TABLE schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);

INSERT INTO schema_migrations (version, description) VALUES
  ('001', 'Initial schema: users, sessions, ledger, transactions, fraud, policy, webhooks, queues, reconciliation, compliance');
