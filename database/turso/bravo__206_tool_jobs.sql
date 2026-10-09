-- bravo__206_tool_jobs.sql
--
-- Toolkit (Content > Tools). tool_jobs: one row per tool run, for every tool. Worker tools run inside
-- the request (status goes running -> done | failed in it). Runner tools are queued here and claimed by
-- a signed runner on a computer (POST /api/internal/tools/claim, lib/tools/runner-handlers.ts); the
-- lease (lease_id, lease_expires_at) decides who may report on a job. tool_runners: when each runner
-- was last seen, per tenant it serves, so a runner tool is shown only while a runner is live.
-- House rules: IF NOT EXISTS everywhere; vocabularies live in lib/tools (no CHECK); JSON is TEXT.

CREATE TABLE IF NOT EXISTS tool_jobs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  tool_key          TEXT NOT NULL,
  runs_on           TEXT NOT NULL,
  status            TEXT NOT NULL,
  stage             TEXT,
  input_json        TEXT NOT NULL DEFAULT '{}',
  input_hash        TEXT NOT NULL,
  idempotency_key   TEXT,
  dedupe_key        TEXT,
  created_by        TEXT,
  created_by_email  TEXT,
  claimed_by        TEXT,
  lease_id          TEXT,
  claimed_at        TEXT,
  heartbeat_at      TEXT,
  lease_expires_at  TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  asset_id          TEXT,
  upload_path       TEXT,
  upload_bytes      INTEGER,
  upload_sha256     TEXT,
  upload_md5        TEXT,
  result_json       TEXT,
  error_code        TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_jobs_tenant_tool_created ON tool_jobs (tenant_id, tool_key, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_jobs_tenant_status_created ON tool_jobs (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_jobs_claim ON tool_jobs (runs_on, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_jobs_tenant_idempotency
  ON tool_jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_jobs_tenant_inflight
  ON tool_jobs (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','claimed','running');
CREATE TRIGGER IF NOT EXISTS tool_jobs_tenant_immutable
BEFORE UPDATE OF tenant_id ON tool_jobs
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tool_jobs.tenant_id is immutable');
END;

CREATE TABLE IF NOT EXISTS tool_runners (
  tenant_id     TEXT NOT NULL,
  runner_key    TEXT NOT NULL,
  label         TEXT NOT NULL,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  version       TEXT,
  last_seen_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, runner_key)
);
CREATE TRIGGER IF NOT EXISTS tool_runners_tenant_immutable
BEFORE UPDATE OF tenant_id ON tool_runners
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tool_runners.tenant_id is immutable');
END;
