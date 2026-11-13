-- Free AI scan, live: what the scanner did, step by step, as the visitor watches it.
--
-- Append-only. The Worker's Tier 0 writes `worker` events as it reads the site (each page, each
-- check, each signal found); the runner's Tier 1 writes `runner` events through the signed
-- progress route (category, location, each competitor and prospect). The page follows them over
-- GET /api/scan/:id/stream, resuming after the last id it saw. Every line is a real step taken;
-- nothing here is written for show. Deleted with their scan (lib/site-scan/store.ts purge).
CREATE TABLE IF NOT EXISTS site_scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  at TEXT NOT NULL,
  -- worker | runner
  source TEXT NOT NULL,
  -- note | page | check | signal | speed | score | geo | screenshot | category | competitor
  -- | prospect | segment | dns | email | done | error (lib/site-scan/events.ts EVENT_KINDS)
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_scan_events_scan ON site_scan_events(tenant_id, scan_id, id);

-- Who runs a scan's Tier 0: the visitor's live stream claims it and runs it inside that
-- connection (no 30-second after() ceiling); POST /api/scan's fallback runs it only when no
-- stream did. One claim per read; reset with the row when a failed scan is retried.
ALTER TABLE site_scans ADD COLUMN tier0_claimed_at TEXT;
