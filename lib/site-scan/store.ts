/**
 * lib/site-scan/store.ts — site_scans rows (database/turso/bravo__259_site_scans.sql).
 *
 * Every read and write names the tenant. A domain is scanned once per day per workspace; a
 * repeat inside SCAN_REUSE_DAYS hands back the latest finished row instead of reading the site
 * again (the cache that keeps the free scan free).
 */
import type { Client, InValue } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { isMissingTableError } from "@/lib/api-helpers";
import {
  SCAN_STAGES,
  SCAN_TTL_DAYS,
  type ScanEnrich,
  type ScanFacts,
  type ScanNarrative,
  type ScanRow,
  type ScanScore,
  type ScanStage,
  type ScanStatus,
} from "@/lib/site-scan/types";

export const SCAN_REUSE_DAYS = 7;

const COLUMNS =
  "id, tenant_id, domain, url, status, stage, facts_json, score_json, enrich_json, narrative_json, error_code, outcome, " +
  "lead_record_id, engagement_id, created_at, updated_at, enriched_at";

function parse<T>(v: unknown): T | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

function asStage(v: unknown): ScanStage {
  return (SCAN_STAGES as readonly string[]).includes(String(v)) ? (v as ScanStage) : "read";
}

function asStatus(v: unknown): ScanStatus {
  const s = String(v);
  return s === "reading" || s === "enriching" || s === "done" || s === "failed" ? s : "queued";
}

export function rowFromRecord(r: Record<string, unknown>): ScanRow {
  const outcome = String(r.outcome ?? "none");
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    domain: String(r.domain),
    url: String(r.url),
    status: asStatus(r.status),
    stage: asStage(r.stage),
    facts: parse<ScanFacts>(r.facts_json),
    score: parse<ScanScore>(r.score_json),
    enrich: parse<ScanEnrich>(r.enrich_json),
    narrative: parse<ScanNarrative>(r.narrative_json),
    errorCode: typeof r.error_code === "string" && r.error_code ? r.error_code : null,
    outcome: outcome === "claimed" || outcome === "booked" || outcome === "bought" ? outcome : "none",
    leadRecordId: typeof r.lead_record_id === "string" && r.lead_record_id ? r.lead_record_id : null,
    engagementId: typeof r.engagement_id === "string" && r.engagement_id ? r.engagement_id : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    enrichedAt: typeof r.enriched_at === "string" && r.enriched_at ? r.enriched_at : null,
  };
}

export async function siteScanTablesInstalled(db: Client): Promise<boolean> {
  try {
    await db.execute("SELECT id FROM site_scans LIMIT 1");
    return true;
  } catch (err) {
    const e = err as { message?: string; code?: string } | null;
    // libSQL says "no such table: site_scans" with no stable code; Postgres and PostgREST have theirs.
    if (isMissingTableError(e, "site_scans") || /no such table/i.test(e?.message ?? "")) return false;
    throw err;
  }
}

export async function getScan(db: Client, tenantId: string, id: string): Promise<ScanRow | null> {
  const rs = await db.execute({ sql: `SELECT ${COLUMNS} FROM site_scans WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [tenantId, id] });
  const r = rs.rows[0];
  return r ? rowFromRecord(r as unknown as Record<string, unknown>) : null;
}

/** The latest usable scan of a domain within SCAN_REUSE_DAYS: finished, or still being worked on. */
export async function findReusableScan(db: Client, tenantId: string, domain: string, now: Date): Promise<ScanRow | null> {
  const since = new Date(now.getTime() - SCAN_REUSE_DAYS * 86_400_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS} FROM site_scans WHERE tenant_id = ? AND domain = ? AND created_at >= ? AND status <> 'failed' ORDER BY created_at DESC LIMIT 1`,
    args: [tenantId, domain, since],
  });
  const r = rs.rows[0];
  return r ? rowFromRecord(r as unknown as Record<string, unknown>) : null;
}

export async function insertScan(
  db: Client,
  input: { tenantId: string; domain: string; url: string; ipHash: string | null; now: Date },
): Promise<ScanRow> {
  const id = randomUUID();
  const at = input.now.toISOString();
  const day = at.slice(0, 10);
  const expires = new Date(input.now.getTime() + SCAN_TTL_DAYS * 86_400_000).toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO site_scans (id, tenant_id, domain, url, status, stage, outcome, ip_hash, scan_day, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, 'reading', 'read', 'none', ?, ?, ?, ?, ?)`,
      args: [id, input.tenantId, input.domain, input.url, input.ipHash, day, at, at, expires],
    });
  } catch (err) {
    // Two visitors, one domain, one day: the row that won is the scan.
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
      const rs = await db.execute({ sql: `SELECT ${COLUMNS} FROM site_scans WHERE tenant_id = ? AND domain = ? AND scan_day = ? LIMIT 1`, args: [input.tenantId, input.domain, day] });
      const r = rs.rows[0];
      if (r) return rowFromRecord(r as unknown as Record<string, unknown>);
    }
    throw err;
  }
  const row = await getScan(db, input.tenantId, id);
  if (!row) throw new Error("site-scan.store: inserted a scan but cannot read it back");
  return row;
}

export async function saveTier0(
  db: Client,
  input: { tenantId: string; id: string; facts: ScanFacts; score: ScanScore; narrative: ScanNarrative; status: ScanStatus; stage: ScanStage; now: Date },
): Promise<boolean> {
  const at = input.now.toISOString();
  const rs = await db.execute({
    sql: `UPDATE site_scans SET facts_json = ?, score_json = ?, narrative_json = ?, status = ?, stage = ?, error_code = NULL, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'reading')`,
    args: [JSON.stringify(input.facts), JSON.stringify(input.score), JSON.stringify(input.narrative), input.status, input.stage, at, input.tenantId, input.id],
  });
  return rs.rowsAffected === 1;
}

export async function saveEnrich(
  db: Client,
  input: { tenantId: string; id: string; enrich: ScanEnrich; narrative: ScanNarrative | null; embedding: number[] | null; now: Date },
): Promise<boolean> {
  const at = input.now.toISOString();
  const sets: string[] = ["enrich_json = ?", "status = 'done'", "stage = 'done'", "enriched_at = ?", "updated_at = ?"];
  const args: InValue[] = [JSON.stringify(input.enrich), at, at];
  if (input.narrative) {
    sets.push("narrative_json = ?");
    args.push(JSON.stringify(input.narrative));
  }
  if (input.embedding) {
    sets.push("embedding_json = ?");
    args.push(JSON.stringify(input.embedding));
  }
  args.push(input.tenantId, input.id);
  const rs = await db.execute({ sql: `UPDATE site_scans SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ? AND status IN ('enriching', 'done')`, args });
  return rs.rowsAffected === 1;
}

export async function setStatus(
  db: Client,
  input: { tenantId: string; id: string; status: ScanStatus; stage: ScanStage; errorCode?: string | null; now: Date; onlyFrom?: ScanStatus[] },
): Promise<boolean> {
  const from = input.onlyFrom ?? [];
  const rs = await db.execute({
    sql: `UPDATE site_scans SET status = ?, stage = ?, error_code = ?, updated_at = ? WHERE tenant_id = ? AND id = ?${from.length ? ` AND status IN (${from.map(() => "?").join(", ")})` : ""}`,
    args: [input.status, input.stage, input.errorCode ?? null, input.now.toISOString(), input.tenantId, input.id, ...from],
  });
  return rs.rowsAffected === 1;
}

export async function attachLead(
  db: Client,
  input: { tenantId: string; id: string; leadRecordId: string; engagementId: string | null; now: Date },
): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE site_scans SET lead_record_id = ?, engagement_id = COALESCE(?, engagement_id), outcome = CASE WHEN outcome = 'none' THEN 'claimed' ELSE outcome END, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
    args: [input.leadRecordId, input.engagementId, input.now.toISOString(), input.tenantId, input.id],
  });
  return rs.rowsAffected === 1;
}

/** The latest scan of a domain for an operator view (the SEO site page, the audit workspace). */
export async function latestScanForDomain(db: Client, tenantId: string, domain: string): Promise<ScanRow | null> {
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS} FROM site_scans WHERE tenant_id = ? AND domain = ? AND status <> 'failed' ORDER BY created_at DESC LIMIT 1`,
    args: [tenantId, domain],
  });
  const r = rs.rows[0];
  return r ? rowFromRecord(r as unknown as Record<string, unknown>) : null;
}

export async function scanForEngagement(db: Client, tenantId: string, engagementId: string): Promise<ScanRow | null> {
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS} FROM site_scans WHERE tenant_id = ? AND engagement_id = ? ORDER BY created_at DESC LIMIT 1`,
    args: [tenantId, engagementId],
  });
  const r = rs.rows[0];
  return r ? rowFromRecord(r as unknown as Record<string, unknown>) : null;
}

/** Counts the public page shows as proof: scans run and distinct domains, this workspace. */
export async function scanCounts(db: Client, tenantId: string): Promise<{ scans: number; domains: number }> {
  const rs = await db.execute({ sql: "SELECT COUNT(*) AS n, COUNT(DISTINCT domain) AS d FROM site_scans WHERE tenant_id = ? AND status <> 'failed'", args: [tenantId] });
  const r = rs.rows[0];
  return { scans: Number(r?.n ?? 0), domains: Number(r?.d ?? 0) };
}
