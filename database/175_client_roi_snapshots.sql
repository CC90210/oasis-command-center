-- 175: Client ROI snapshots — nightly aggregation of tenant AI value metrics.
-- Populated by a cron job; read by the client-portal dashboard.

CREATE TABLE IF NOT EXISTS client_roi_snapshots (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id     TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  messages_handled    INTEGER DEFAULT 0,
  leads_processed     INTEGER DEFAULT 0,
  hours_saved_est     REAL    DEFAULT 0,
  avg_response_sec    INTEGER DEFAULT 0,
  ai_actions_taken    INTEGER DEFAULT 0,
  custom_metrics_json TEXT    DEFAULT '{}',
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_roi_tenant_date ON client_roi_snapshots(tenant_id, snapshot_date);
