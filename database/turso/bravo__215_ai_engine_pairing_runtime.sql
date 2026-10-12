-- bravo__215_ai_engine_pairing_runtime.sql
--
-- Bind every computer-backed engine choice and department run to one concrete
-- pairing, and add the narrow pull queue used to repair/test that runtime.
-- The computer always calls out; OCC never opens an inbound connection.
--
-- Runtime jobs deliberately carry only an allowlisted action ('probe' or
-- 'auth'), a structured engine identity, and an optional probe prompt. There
-- is no command, environment, header, token, or free-form failure column.
-- Vocabularies are enforced once in lib/bridge/runtime-jobs, following the
-- repo rule that SQLite migrations do not duplicate application CHECK lists.
--
-- Existing engine/run rows remain valid: every added binding column is NULL.
-- Code must treat NULL as the pre-migration workspace-routing behaviour.
-- Timestamps are UTC ISO-8601 TEXT written by the application.

ALTER TABLE agent_model_config ADD COLUMN computer_pairing_id TEXT;
ALTER TABLE agent_model_config ADD COLUMN fallback_policy TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_model_config_computer_pairing
  ON agent_model_config (tenant_id, user_id, computer_pairing_id, agent_key);

ALTER TABLE bridge_pairings ADD COLUMN claim_runtime_state TEXT;

ALTER TABLE dept_chat_runs ADD COLUMN target_pairing_id TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_kind TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_name TEXT;

CREATE INDEX IF NOT EXISTS dept_chat_runs_target_idx
  ON dept_chat_runs (tenant_id, user_id, target_pairing_id, status, created_at);

-- A connector claims workspace-default work for one exact pairing regardless
-- of which member requested it, so the hot pull query cannot lead with user_id.
CREATE INDEX IF NOT EXISTS dept_chat_runs_pairing_claim_idx
  ON dept_chat_runs (tenant_id, target_pairing_id, status, created_at);

CREATE INDEX IF NOT EXISTS dept_chat_runs_runtime_engine_idx
  ON dept_chat_runs (tenant_id, runtime_engine_kind, runtime_engine_name, status, created_at);

CREATE TABLE IF NOT EXISTS bridge_runtime_jobs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  pairing_id        TEXT NOT NULL,
  action            TEXT NOT NULL,
  engine_kind       TEXT NOT NULL,
  engine_name       TEXT NOT NULL,
  prompt            TEXT,
  status            TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  claim_id          TEXT,
  lease_id          TEXT,
  claimed_at        TEXT,
  heartbeat_at      TEXT,
  deadline_at       TEXT,
  progress_code     TEXT,
  result_code       TEXT,
  result_json       TEXT,
  error_code        TEXT,
  error_retryable   INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT
);

-- Browser status: one signed-in person may see only their own job in their
-- own workspace. The id is retained last for efficient point lookup after
-- both isolation predicates have been supplied.
CREATE INDEX IF NOT EXISTS bridge_runtime_jobs_owner_idx
  ON bridge_runtime_jobs (tenant_id, user_id, id, updated_at);

-- A computer pulls only work explicitly addressed to its authenticated
-- pairing. tenant_id leads every tenant-bearing index in this migration.
CREATE INDEX IF NOT EXISTS bridge_runtime_jobs_claim_idx
  ON bridge_runtime_jobs (tenant_id, pairing_id, status, created_at);

-- Retrying the browser mutation creates no duplicate work for the same
-- machine. Reusing a key with different action/engine data is rejected by the
-- store rather than silently returning an unrelated job.
CREATE UNIQUE INDEX IF NOT EXISTS bridge_runtime_jobs_idempotency_idx
  ON bridge_runtime_jobs (tenant_id, pairing_id, idempotency_key);

-- claim_id is the connector's request id. A lost claim response may retrieve
-- the same live lease, but that request id can never consume a second job.
CREATE UNIQUE INDEX IF NOT EXISTS bridge_runtime_jobs_pairing_claim_idx
  ON bridge_runtime_jobs (tenant_id, pairing_id, claim_id)
  WHERE claim_id IS NOT NULL;

-- Lease transitions always carry all four values (tenant, pairing, job,
-- lease); this keeps their lookup exact and tenant-leading.
CREATE INDEX IF NOT EXISTS bridge_runtime_jobs_lease_idx
  ON bridge_runtime_jobs (tenant_id, pairing_id, id, lease_id, status);
