-- bravo__225_automation_templates.sql
--
-- The guided automation builder stores the operator-reviewed definition apart
-- from generated code, and binds a new cron row to one active daemon pairing.
-- The cron action payload carries only this template's id. The authenticated
-- poll route reads the reviewed source and signs it for the exact pairing's
-- bearer before that daemon materializes the script file.
-- Legacy cron rows keep target_pairing_id NULL and preserve their current
-- owner/expected-executor routing exactly.
--
-- Apply before deploying code that writes automation_templates. The poll route
-- is rollout-safe: a database without target_pairing_id falls back to the
-- legacy select and never strands the current scheduler.

ALTER TABLE tenant_cron_jobs ADD COLUMN target_pairing_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tenant_cron_jobs_target
  ON tenant_cron_jobs (tenant_id, target_pairing_id, enabled);

CREATE TABLE IF NOT EXISTS automation_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  cron_job_id TEXT,
  target_pairing_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('marketing', 'sales', 'operations', 'finance', 'customer_success', 'executive')),
  objective TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'event', 'manual')),
  schedule_hint TEXT NOT NULL DEFAULT '',
  input_parameters_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_parameters_json)),
  expected_outputs TEXT NOT NULL,
  connector_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(connector_keys_json)),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('draft', 'ready', 'retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (cron_job_id) REFERENCES tenant_cron_jobs(id),
  FOREIGN KEY (target_pairing_id) REFERENCES bridge_pairings(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_automation_templates_cron
  ON automation_templates (tenant_id, cron_job_id)
  WHERE cron_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_templates_target
  ON automation_templates (tenant_id, target_pairing_id, status, created_at);
