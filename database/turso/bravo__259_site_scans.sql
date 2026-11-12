-- Free AI scan (oasisai.work/scan): one row per public website scan.
--
-- Tier 0 (the Worker, keyless) fills facts_json and score_json within the request.
-- Tier 1 (the VPS runner's site_scan_enrich job, keyless, our own data + local ML) fills
-- enrich_json, narrative_json and embedding_json. A claimed scan links the lead it became and
-- the AI audit engagement it opened. outcome feeds the weekly re-ranking (learn.py).
CREATE TABLE IF NOT EXISTS site_scans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  -- queued | reading | enriching | done | failed
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'read',
  facts_json TEXT,
  score_json TEXT,
  enrich_json TEXT,
  narrative_json TEXT,
  embedding_json TEXT,
  error_code TEXT,
  -- none | claimed | booked | bought
  outcome TEXT NOT NULL DEFAULT 'none',
  lead_record_id TEXT,
  engagement_id TEXT,
  ip_hash TEXT,
  scan_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  enriched_at TEXT,
  expires_at TEXT NOT NULL
);
-- One scan per domain per day per workspace: a repeat within the day reuses the row.
CREATE UNIQUE INDEX IF NOT EXISTS ux_site_scans_tenant_domain_day ON site_scans(tenant_id, domain, scan_day);
CREATE INDEX IF NOT EXISTS idx_site_scans_tenant_created ON site_scans(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_scans_tenant_status ON site_scans(tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_site_scans_engagement ON site_scans(tenant_id, engagement_id);
