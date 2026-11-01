/** Manual, read-only Meta Insights import. No campaign or budget API writes. */
import "server-only";
import type { Client, InStatement } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { META_GRAPH_VERSION } from "@/lib/integrations/key-probes";

const DAY = 86_400_000;
const ID = /^\d{5,25}$/;
const MAX_ASSETS = 500;
const MAX_PAGES = 10;
const MAX_BYTES = 2_000_000;
export type MetaImportError = "not_configured" | "no_linked_ads" | "mapping_conflict" | "mapping_changed" |
  "report_context_conflict" | "provider_unavailable" | "provider_rejected" | "invalid_report" | "report_too_large" | "storage_unavailable";
export type MetaImportResult = { ok: false; error: MetaImportError } | {
  ok: true; imported: number; linkedAssets: number; unlinkedAssets: number; unmatchedRows: number;
  from: string; through: string; currency: string; timezone: string;
};
type Asset = { id: string; adId: string; externalId: string | null; rawMeta: string; meta: Record<string, unknown> };
type Deps = { db?: Client; fetch?: typeof fetch; now?: Date; credentials?: (tenantId: string) => Promise<Record<string, string>> };
class ImportFailure extends Error { constructor(readonly code: MetaImportError) { super(code); } }
function fail(code: MetaImportError): never { throw new ImportFailure(code); }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (!(typeof value === "string" && /^\d+$/.test(value)) && typeof value !== "number") return fail("invalid_report");
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fail("invalid_report");
}
function spend(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && /^\d{1,12}(?:\.\d{1,6})?$/.test(value) ? value : fail("invalid_report");
}
function conversion(row: Record<string, unknown>, event: unknown): number | null {
  // Action types overlap. Never sum them or rename every conversion a lead.
  if (event !== "lead" && event !== "purchase") return null;
  if (!Array.isArray(row.actions)) return null;
  const found = row.actions.map(object).filter(action => action.action_type === event);
  if (found.length > 1) return fail("invalid_report");
  return found.length ? count(found[0].value) : null;
}
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return fail("invalid_report");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_BYTES) { await reader.cancel(); return fail("report_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder().decode(all))); }
  catch { return fail("invalid_report"); }
}

/**
 * Mapping is marketing_asset.external_id (133_marketing_hub.sql: platform ad ID),
 * with explicit meta.platform_ad_id compatibility. Never names, titles or order.
 * API contract: Meta's official SDK AdAccount.get_insights (GET, level=ad,
 * time_increment=1) and AdsInsights fields, facebook/facebook-python-business-sdk.
 */
export async function importMetaDelivery(tenantId: string, deps: Deps = {}): Promise<MetaImportResult> {
  if (!tenantId) return { ok: false, error: "not_configured" };
  const capturedAt = (deps.now ?? new Date()).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bundle = await (deps.credentials ?? (id => getTenantIntegrationBundle(id, "meta_ads", { allowEnvFallback: false })))(tenantId);
    const token = bundle.access_token?.trim();
    const accountId = bundle.ad_account_id?.trim().replace(/^act_/, "");
    if (!token || !accountId || !ID.test(accountId) || /[\r\n]/.test(token)) return fail("not_configured");
    const db = deps.db ?? getTursoClient();
    const result = await db.execute({ sql: "SELECT id, external_id, meta FROM marketing_asset WHERE tenant_id = ? AND channel = 'paid-meta' LIMIT ?", args: [tenantId, MAX_ASSETS + 1] });
    if (result.rows.length > MAX_ASSETS) return fail("report_too_large");
    const assets = new Map<string, Asset>();
    for (const row of result.rows) {
      const rawMeta = typeof row.meta === "string" ? row.meta : "{}";
      let meta: Record<string, unknown>;
      try { meta = object(JSON.parse(rawMeta)); }
      catch { meta = {}; }
      const externalId = typeof row.external_id === "string" ? row.external_id : null;
      const external = externalId && ID.test(externalId) ? externalId : null;
      const explicit = typeof meta.platform_ad_id === "string" && ID.test(meta.platform_ad_id) ? meta.platform_ad_id : null;
      if (meta.platform_ad_id !== undefined && !explicit) return fail("mapping_conflict");
      if (external && explicit && external !== explicit) return fail("mapping_conflict");
      const adId = explicit ?? external;
      if (!adId) continue;
      try {
        const parsed = JSON.parse(rawMeta);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("mapping_conflict");
      } catch { return fail("mapping_conflict"); }
      if (assets.has(adId)) return fail("mapping_conflict");
      assets.set(adId, { id: String(row.id), adId, externalId, rawMeta, meta });
    }
    if (!assets.size) return fail("no_linked_ads");
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 30_000);
    const request = async (path: string, params: URLSearchParams) => {
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}?${params}`, {
          method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: ctrl.signal, redirect: "error", cache: "no-store",
        });
      } catch { return fail("provider_unavailable"); }
      if (!response.ok) return fail("provider_rejected");
      let body: Record<string, unknown>;
      try { body = await bodyOf(response); }
      catch (error) { if (error instanceof ImportFailure) throw error; return fail("provider_unavailable"); }
      if (body.error) return fail("provider_rejected");
      return body;
    };
    const account = await request(`act_${accountId}`, new URLSearchParams({ fields: "id,currency,timezone_name" }));
    if (account.id !== `act_${accountId}` || typeof account.currency !== "string" || !/^[A-Z]{3}$/.test(account.currency) || typeof account.timezone_name !== "string") return fail("invalid_report");
    const currency = account.currency;
    const timezone = account.timezone_name;
    let through: string;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(capturedAt));
      const get = (type: string) => parts.find(p => p.type === type)!.value;
      through = `${get("year")}-${get("month")}-${get("day")}`;
    } catch { return fail("invalid_report"); }
    const from = new Date(Date.parse(`${through}T12:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      fields: "account_id,account_currency,ad_id,date_start,date_stop,impressions,reach,clicks,spend,actions",
      level: "ad", time_increment: "1", time_range: JSON.stringify({ since: from, until: through }), limit: "500",
      action_report_time: "impression", use_unified_attribution_setting: "true",
    });
    const observations: Array<{ asset: Asset; day: string; impressions: number | null; reach: number | null; clicks: number | null; spend: string | null; conversions: number | null }> = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let unmatchedRows = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await request(`act_${accountId}/insights`, params);
      if (!Array.isArray(body.data) || body.data.length > 500) return fail("invalid_report");
      for (const raw of body.data) {
        const row = object(raw);
        if (row.account_id !== accountId || row.account_currency !== currency) return fail("invalid_report");
        const asset = typeof row.ad_id === "string" ? assets.get(row.ad_id) : undefined;
        if (!asset) { unmatchedRows++; continue; }
        const day = row.date_start;
        if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || row.date_stop !== day || day < from || day > through || seen.has(`${asset.id}:${day}`)) return fail("invalid_report");
        if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return fail("invalid_report");
        seen.add(`${asset.id}:${day}`);
        observations.push({ asset, day, impressions: count(row.impressions), reach: count(row.reach), clicks: count(row.clicks), spend: spend(row.spend), conversions: conversion(row, asset.meta.conversion_event) });
      }
      const paging = object(body.paging);
      if (!paging.next) break;
      const after = object(paging.cursors).after;
      if (page === MAX_PAGES - 1 || typeof after !== "string" || after.length > 2048 || cursors.has(after)) return fail("report_too_large");
      // Never follow provider-supplied next URLs: credentials go only to our fixed host/path.
      cursors.add(after);
      params.set("after", after);
    }
    clearTimeout(timer);
    timer = undefined;
    if (observations.length) {
      const tx = await db.transaction("write");
      try {
        const measured = new Map(observations.map(o => [o.asset.id, o.asset]));
        for (const asset of measured.values()) {
          const meta = asset.meta;
          const conversionEvent = meta.conversion_event === "lead" || meta.conversion_event === "purchase" ? meta.conversion_event : null;
          if ((meta.currency && meta.currency !== currency) || (meta.ads_reporting_timezone && meta.ads_reporting_timezone !== timezone) || (meta.meta_ad_account_id && meta.meta_ad_account_id !== accountId)) return fail("report_context_conflict");
          const existing = await tx.execute({ sql: "SELECT 1 FROM marketing_metric_daily WHERE tenant_id = ? AND asset_id = ? AND source IN ('meta','meta_ads','meta-api') LIMIT 1", args: [tenantId, asset.id] });
          if (existing.rows.length && (!meta.currency || !meta.ads_reporting_timezone || !meta.meta_ad_account_id)) return fail("report_context_conflict");
          if (existing.rows.length && meta.ads_conversion_event !== conversionEvent) return fail("report_context_conflict");
          // The asset is the history key. A changed ad mapping must not blend
          // different ads across days, including history without provenance.
          if (existing.rows.length && meta.ads_imported_ad_id !== asset.adId) return fail("report_context_conflict");
          const updated = await tx.execute({
            sql: "UPDATE marketing_asset SET meta = ? WHERE tenant_id = ? AND id = ? AND channel = 'paid-meta' AND external_id IS ? AND meta = ?",
            args: [JSON.stringify({ ...meta, currency, ads_reporting_timezone: timezone, meta_ad_account_id: accountId, ads_conversion_event: conversionEvent, ads_imported_ad_id: asset.adId }), tenantId, asset.id, asset.externalId, asset.rawMeta],
          });
          if (updated.rowsAffected !== 1) return fail("mapping_changed");
        }
        const statements: InStatement[] = observations.map(o => ({
          sql: `INSERT INTO marketing_metric_daily (tenant_id, asset_id, date, impressions, reach, clicks, spend, conversions, source, captured_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'meta_ads', ?)
            ON CONFLICT(tenant_id, asset_id, date, source) DO UPDATE SET
              impressions=excluded.impressions, reach=excluded.reach, clicks=excluded.clicks, spend=excluded.spend,
              conversions=excluded.conversions, captured_at=excluded.captured_at
            WHERE marketing_metric_daily.captured_at <= excluded.captured_at`,
          args: [tenantId, o.asset.id, o.day, o.impressions, o.reach, o.clicks, o.spend, o.conversions, capturedAt],
        }));
        for (let i = 0; i < statements.length; i += 100) await tx.batch(statements.slice(i, i + 100));
        await tx.commit();
      } catch (error) { await tx.rollback(); throw error; }
      finally { tx.close(); }
    }
    return { ok: true, imported: observations.length, linkedAssets: assets.size, unlinkedAssets: result.rows.length - assets.size, unmatchedRows, from, through, currency, timezone };
  } catch (error) {
    // Provider bodies and thrown error messages can include access tokens. Return a fixed code only.
    return { ok: false, error: error instanceof ImportFailure ? error.code : "storage_unavailable" };
  } finally { if (timer) clearTimeout(timer); }
}
