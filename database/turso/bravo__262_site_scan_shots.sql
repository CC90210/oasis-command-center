-- Free AI scan: the pictures the runner takes as it walks the site in a real browser (the home page
-- first, then the pages it opens), shown in the live view's browser frame as each one arrives
-- (lib/site-scan/screenshot.ts, POST /api/internal/tools/scan-screenshot with seq, GET
-- /api/scan/:id/shot/:seq). One row per picture, at most MAX_SHOTS per scan; deleted with the scan.
CREATE TABLE IF NOT EXISTS site_scan_shots (
  tenant_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  page_url TEXT NOT NULL,
  jpeg BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scan_id, seq)
);
