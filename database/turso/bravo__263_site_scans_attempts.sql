-- Free AI scan: one row per ATTEMPT, no longer one per domain per day.
--
-- The one-per-day unique index made a repeat of a domain take the day's row over in place
-- (lib/site-scan/store.ts insertScan, #821), which kept the earlier attempt's identity alive on
-- the new run: its claim key (signed over the scan id) could attach the new visitor's run to the
-- earlier visitor's audit, its visitor hash stayed on the row, a late write from the earlier
-- attempt's runner could land on the new report, and a read that straddled UTC midnight was never
-- joined because the new day's insert never met the row. Each attempt now gets its own row and id;
-- the one case a visitor joins rather than starts is a read of the same domain still in progress,
-- found by this index whatever the day (independent review of #821, 2026-11-14).
DROP INDEX IF EXISTS ux_site_scans_tenant_domain_day;
CREATE INDEX IF NOT EXISTS idx_site_scans_tenant_domain_created ON site_scans(tenant_id, domain, created_at);
