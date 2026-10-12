-- Exact-pairing pull queue for coding-harness turns.
--
-- The browser never supplies a command or filesystem path. The server stores
-- one allow-listed chat task, bound to one pairing and one saved engine. That
-- pairing pulls it, then writes a bounded SSE event stream with a short-lived
-- server-signed credential.

CREATE TABLE IF NOT EXISTS bridge_harness_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  engine_kind TEXT NOT NULL,
  engine_name TEXT NOT NULL,
  chat_mode TEXT NOT NULL,
  repo_writes INTEGER NOT NULL DEFAULT 0,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claim_id TEXT,
  lease_id TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  deadline_at TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (pairing_id) REFERENCES bridge_pairings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bridge_harness_jobs_claim_idx
  ON bridge_harness_jobs (tenant_id, pairing_id, status, created_at);

CREATE INDEX IF NOT EXISTS bridge_harness_jobs_owner_idx
  ON bridge_harness_jobs (tenant_id, user_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS bridge_harness_jobs_claim_id_idx
  ON bridge_harness_jobs (tenant_id, pairing_id, claim_id)
  WHERE claim_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bridge_harness_job_events (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq),
  FOREIGN KEY (job_id) REFERENCES bridge_harness_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bridge_harness_job_events_tenant_idx
  ON bridge_harness_job_events (tenant_id, job_id, seq);
