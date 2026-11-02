-- Exclusive, expiring execution grants for the cloud script scheduler.
-- Additive only: existing job switches, schedules and run history are preserved.
CREATE TABLE IF NOT EXISTS tenant_cron_execution_leases (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  occurrence_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  job_action_type TEXT NOT NULL,
  job_agent_key TEXT NOT NULL,
  job_schedule TEXT NOT NULL,
  job_payload TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, job_id)
);
