import "server-only";
import type { Client } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";

export type AdCreative = {
  id: string;
  title: string;
  campaign: string | null;
  status: string;
  hook: string | null;
  body: string | null;
  updatedAt: string;
};
export type AdsReport = {
  from: string;
  through: string;
  creatives: AdCreative[];
  creativesCapped: boolean;
  spend: number | null;
  clicks: number | null;
  conversions: number | null;
  costPerClick: number | null;
  currency: string | null;
  reportingTimezone: string | null;
  conversionKind: "leads" | "conversions";
  observations: number;
  measuredAssets: number;
  lastCapturedAt: string | null;
  stale: boolean;
  error: boolean;
};

const DAY = 86_400_000;
const MAX_OBSERVATIONS = 20_000;
const MAX_CREATIVES = 100;
type Metric = {
  asset_id: unknown; spend: unknown; clicks: unknown; conversions: unknown;
  captured_at: unknown; meta: unknown;
};

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function metadata(raw: unknown): Record<string, unknown> {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function total(rows: Metric[], key: "spend" | "clicks" | "conversions"): number | null {
  if (!rows.length) return null;
  let sum = 0;
  for (const row of rows) {
    const value = numeric(row[key]);
    if (value === null || (key !== "spend" && !Number.isSafeInteger(value))) return null;
    sum += value;
  }
  return Number.isFinite(sum) && (key === "spend" || Number.isSafeInteger(sum)) ? sum : null;
}

/**
 * Stored Meta delivery observations, not a provider connection check. A saved
 * token alone never proves that metrics have arrived. Organic and other tenants'
 * rows cannot enter this report. Imports for the same asset/day are observations
 * of one fact, so use the latest one instead of adding two copies of its spend.
 * NULL remains unknown; an unlabelled conversion is never called a lead.
 */
export async function loadAdsReport(
  tenantId: string,
  { db, now = Date.now() }: { db?: Pick<Client, "execute">; now?: number } = {},
): Promise<AdsReport> {
  let through = new Date(now).toISOString().slice(0, 10);
  let from = new Date(now - 6 * DAY).toISOString().slice(0, 10);
  const empty: AdsReport = {
    from, through, creatives: [], creativesCapped: false, spend: null, clicks: null,
    conversions: null, costPerClick: null, currency: null, reportingTimezone: null, conversionKind: "conversions",
    observations: 0, measuredAssets: 0, lastCapturedAt: null, stale: false, error: false,
  };
  if (!tenantId) return { ...empty, error: true };
  try {
    const client = db ?? getTursoClient();
    const [assets, contexts] = await Promise.all([
      client.execute({
        sql: `SELECT id, title, campaign, status, hook, body, updated_at FROM marketing_asset
          WHERE tenant_id = ? AND channel = 'paid-meta'
          ORDER BY updated_at DESC, id LIMIT ?`,
        args: [tenantId, MAX_CREATIVES + 1],
      }),
      client.execute({
        sql: `SELECT DISTINCT a.meta FROM marketing_asset a WHERE a.tenant_id = ? AND a.channel = 'paid-meta'
          AND EXISTS(SELECT 1 FROM marketing_metric_daily m WHERE m.tenant_id = a.tenant_id AND m.asset_id = a.id AND m.source IN ('meta','meta_ads','meta-api')) LIMIT 501`,
        args: [tenantId],
      }),
    ]);
    const zones = contexts.rows.map(row => metadata(row.meta).ads_reporting_timezone ?? null);
    const reportingTimezone = zones.length && zones.every(zone => typeof zone === "string" && zone === zones[0]) ? zones[0] as string : null;
    if (reportingTimezone) {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: reportingTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
      const get = (type: string) => parts.find(part => part.type === type)!.value;
      through = `${get("year")}-${get("month")}-${get("day")}`;
      from = new Date(Date.parse(`${through}T12:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
      empty.from = from; empty.through = through; empty.reportingTimezone = reportingTimezone;
    }
    const mixedTimezones = contexts.rows.length > 500 || (!reportingTimezone && zones.some(zone => zone !== null));
    const daily = await client.execute({
        sql: `WITH observations AS (
          SELECT m.asset_id, m.spend, m.clicks, m.conversions, m.captured_at, a.meta,
            ROW_NUMBER() OVER (PARTITION BY m.asset_id, m.date
              ORDER BY m.captured_at DESC, m.source) AS observation_rank
          FROM marketing_metric_daily m
          JOIN marketing_asset a ON a.tenant_id = m.tenant_id AND a.id = m.asset_id
          WHERE m.tenant_id = ? AND a.tenant_id = ? AND a.channel = 'paid-meta'
            AND m.source IN ('meta', 'meta_ads', 'meta-api') AND m.date >= ? AND m.date <= ?
        ) SELECT asset_id, spend, clicks, conversions, captured_at, meta
          FROM observations WHERE observation_rank = 1 ORDER BY asset_id LIMIT ?`,
        args: [tenantId, tenantId, from, through, MAX_OBSERVATIONS + 1],
      });
    const creatives = assets.rows.slice(0, MAX_CREATIVES).map((row): AdCreative => ({
      id: String(row.id), title: String(row.title), campaign: row.campaign ? String(row.campaign) : null,
      status: String(row.status), hook: row.hook ? String(row.hook) : null,
      body: row.body ? String(row.body) : null, updatedAt: String(row.updated_at),
    }));
    if (mixedTimezones || daily.rows.length > MAX_OBSERVATIONS) return { ...empty, creatives, creativesCapped: assets.rows.length > MAX_CREATIVES, error: true };
    const rows = daily.rows as unknown as Metric[];
    const metas = rows.map((row) => metadata(row.meta));
    const currencies = metas.map((meta) => typeof meta.currency === "string" && /^[A-Z]{3}$/.test(meta.currency) ? meta.currency : null);
    const currency = currencies.length && currencies.every((c) => c !== null && c === currencies[0]) ? currencies[0] : null;
    const spend = currency ? total(rows, "spend") : null;
    const clicks = total(rows, "clicks");
    const timestamps = rows.map((row) => typeof row.captured_at === "string" ? Date.parse(row.captured_at) : NaN);
    const validTimes = timestamps.filter(Number.isFinite);
    const lastMs = validTimes.length ? Math.max(...validTimes) : null;
    return {
      ...empty, creatives, creativesCapped: assets.rows.length > MAX_CREATIVES,
      spend, clicks, conversions: total(rows, "conversions"), currency,
      costPerClick: spend !== null && clicks !== null && clicks > 0 ? spend / clicks : null,
      conversionKind: metas.length && metas.every((m) => ("ads_conversion_event" in m ? m.ads_conversion_event : m.conversion_event) === "lead") ? "leads" : "conversions",
      observations: rows.length, measuredAssets: new Set(rows.map((r) => r.asset_id)).size,
      lastCapturedAt: lastMs === null ? null : new Date(lastMs).toISOString(),
      stale: rows.length > 0 && (validTimes.length !== rows.length || timestamps.some((t) => t > now + 5 * 60_000) || lastMs === null || now - lastMs > 2 * DAY),
    };
  } catch (error) {
    console.error("[marketing.ads] stored report unavailable", { tenantId, error: error instanceof Error ? error.message : "query_failed" });
    return { ...empty, error: true };
  }
}
