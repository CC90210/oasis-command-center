/**
 * lib/site-scan/metrics.ts — how the free scan is being used, for the founders' page
 * (app/ai-audits/scans). Read-only, one workspace, straight from site_scans (and the live feed's
 * step counts when bravo__260 is installed).
 *
 * What a number means: a "scan" is one site read on one day (a repeat of the same site the same
 * day reuses its row); "visitors" counts distinct hashed addresses (an approximation: one office
 * shares an address, one phone moves between them). Unclaimed scans are deleted after 30 days
 * (lib/site-scan/store.ts purgeExpiredScans), so totals cover the last 30 days plus every scan
 * that was sent to the team.
 */
import type { Client } from "@libsql/client";
import { eventsTableMissing } from "@/lib/site-scan/events";

export type ScanTotals = {
  scans: number;
  sites: number;
  visitors: number;
  last24h: number;
  last7d: number;
  claimed: number;
  failed: number;
  matched: number;
  avgScore: number | null;
};

export type ScanDay = { day: string; scans: number; claimed: number };
export type ScanCategory = { label: string; scans: number };
export type RecentScan = {
  id: string;
  domain: string;
  status: string;
  outcome: string;
  createdAt: string;
  enrichedAt: string | null;
  errorCode: string | null;
  score: number | null;
  category: string | null;
  competitors: number;
  prospects: number;
  engine: string | null;
  steps: number | null;
  leadRecordId: string | null;
  engagementId: string | null;
};

export type ScanCountry = { country: string; scans: number };
export type ScanMetrics = { totals: ScanTotals; days: ScanDay[]; categories: ScanCategory[]; countries: ScanCountry[]; recent: RecentScan[] };

const n = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));
const orNull = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The last `days` calendar days (UTC), oldest first, each present even with no scans. */
export function dayRange(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export async function scanMetrics(db: Client, tenantId: string, now: Date, opts: { days?: number; recent?: number } = {}): Promise<ScanMetrics> {
  const days = dayRange(now, opts.days ?? 30);
  const since24 = new Date(now.getTime() - 86_400_000).toISOString();
  const since7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const t = (
    await db.execute({
      sql: `SELECT COUNT(*) AS scans, COUNT(DISTINCT domain) AS sites, COUNT(DISTINCT ip_hash) AS visitors,
                   SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24h,
                   SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last7d,
                   SUM(CASE WHEN outcome <> 'none' THEN 1 ELSE 0 END) AS claimed,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                   SUM(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS matched,
                   AVG(CAST(json_extract(score_json, '$.total') AS REAL)) AS avg_score
            FROM site_scans WHERE tenant_id = ?`,
      args: [since24, since7, tenantId],
    })
  ).rows[0];
  const totals: ScanTotals = {
    scans: n(t?.scans),
    sites: n(t?.sites),
    visitors: n(t?.visitors),
    last24h: n(t?.last24h),
    last7d: n(t?.last7d),
    claimed: n(t?.claimed),
    failed: n(t?.failed),
    matched: n(t?.matched),
    avgScore: orNull(t?.avg_score) === null ? null : Math.round(Number(t?.avg_score)),
  };

  const byDay = new Map<string, ScanDay>();
  for (const r of (
    await db.execute({
      sql: `SELECT scan_day, COUNT(*) AS scans, SUM(CASE WHEN outcome <> 'none' THEN 1 ELSE 0 END) AS claimed
            FROM site_scans WHERE tenant_id = ? AND scan_day >= ? GROUP BY scan_day`,
      args: [tenantId, days[0]],
    })
  ).rows) {
    byDay.set(String(r.scan_day), { day: String(r.scan_day), scans: n(r.scans), claimed: n(r.claimed) });
  }

  const categories: ScanCategory[] = (
    await db.execute({
      sql: `SELECT json_extract(enrich_json, '$.category.label') AS label, COUNT(*) AS scans FROM site_scans
            WHERE tenant_id = ? AND enrich_json IS NOT NULL AND json_extract(enrich_json, '$.category.label') IS NOT NULL
            GROUP BY label ORDER BY scans DESC, label LIMIT 8`,
      args: [tenantId],
    })
  ).rows.map((r) => ({ label: String(r.label), scans: n(r.scans) }));

  // Where the scanned businesses are: the country the matching engine located them in (engine 2.0).
  const countries: ScanCountry[] = (
    await db.execute({
      sql: `SELECT upper(json_extract(enrich_json, '$.location.country')) AS country, COUNT(*) AS scans FROM site_scans
            WHERE tenant_id = ? AND enrich_json IS NOT NULL AND json_extract(enrich_json, '$.location.country') IS NOT NULL
            GROUP BY country ORDER BY scans DESC, country LIMIT 10`,
      args: [tenantId],
    })
  ).rows.map((r) => ({ country: String(r.country), scans: n(r.scans) }));

  const recentSql = (steps: string) => `
    SELECT s.id, s.domain, s.status, s.outcome, s.created_at, s.enriched_at, s.error_code, s.lead_record_id, s.engagement_id,
           json_extract(s.score_json, '$.total') AS score,
           json_extract(s.enrich_json, '$.category.label') AS category,
           json_array_length(json_extract(s.enrich_json, '$.competitors')) AS competitors,
           json_array_length(json_extract(s.enrich_json, '$.prospects')) AS prospects,
           json_extract(s.enrich_json, '$.engine.version') AS engine,
           ${steps} AS steps
    FROM site_scans s WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT ?`;
  const args = [tenantId, Math.min(200, opts.recent ?? 50)];
  let rows;
  try {
    rows = (await db.execute({ sql: recentSql("(SELECT COUNT(*) FROM site_scan_events e WHERE e.tenant_id = s.tenant_id AND e.scan_id = s.id)"), args })).rows;
  } catch (err) {
    if (!eventsTableMissing(err)) throw err;
    rows = (await db.execute({ sql: recentSql("NULL"), args })).rows;
  }
  const recent: RecentScan[] = rows.map((r) => ({
    id: String(r.id),
    domain: String(r.domain),
    status: String(r.status),
    outcome: String(r.outcome ?? "none"),
    createdAt: String(r.created_at),
    enrichedAt: str(r.enriched_at),
    errorCode: str(r.error_code),
    score: orNull(r.score),
    category: str(r.category),
    competitors: n(r.competitors),
    prospects: n(r.prospects),
    engine: str(r.engine),
    steps: orNull(r.steps),
    leadRecordId: str(r.lead_record_id),
    engagementId: str(r.engagement_id),
  }));

  return { totals, days: days.map((d) => byDay.get(d) ?? { day: d, scans: 0, claimed: 0 }), categories, countries, recent };
}
