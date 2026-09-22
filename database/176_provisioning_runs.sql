-- 176: Automated provisioning pipeline — tracks each step of client setup.

CREATE TABLE IF NOT EXISTS provisioning_runs (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id      TEXT NOT NULL,
  tenant_slug    TEXT,
  stripe_invoice TEXT,
  status         TEXT DEFAULT 'pending',
  steps_json     TEXT DEFAULT '[]',
  error_message  TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prov_tenant ON provisioning_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_prov_status ON provisioning_runs(status);
