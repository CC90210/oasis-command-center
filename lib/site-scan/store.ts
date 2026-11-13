/**
 * lib/site-scan/store.ts — site_scans rows (database/turso/bravo__259_site_scans.sql).
 *
 * Every read and write names the tenant. One row per domain per day per workspace (the unique
 * index): a visitor who starts a scan of a domain scanned earlier today takes that row over and
 * the site is read again, in front of them. A finished report is never handed to a new visitor
 * as the answer (CC, 2026-11-13: the page showed a report from the morning at once, "finished in
 * two seconds"; every scan a visitor starts is a real run they watch). The one row a visitor
 * joins rather than restarts is a read of the same domain still in progress.
 */
import type { Client, InStatement, InValue } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { isMissingTableError } from "@/lib/api-helpers";
import { eventsTableMissing } from "@/lib/site-scan/events";
import { BROWSER_READ_UNREAD } from "@/lib/site-scan/browser-read";
import { shotsTableMissing } from "@/lib/site-scan/screenshot";
import { LEASE_GUARD } from "@/lib/tools/store";
import {
  ENRICH_WAIT_MINUTES,
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

/** A row still `queued`/`reading` this long after its last write was orphaned (a crashed Worker). */
export const STALE_READ_MS = 3 * 60_000;

/**
 * What one scan is "of": the host, plus the business's folder on a shared site builder
 * (acme.wixsite.com/acme), so two businesses on one builder host never share a scan.
 */
export function scanKeyOf(target: { host: string; pathPrefix: string }): string {
  const host = target.host.toLowerCase().replace(/^www\./, "");
  return target.pathPrefix && target.pathPrefix !== "/" ? `${host}${target.pathPrefix.toLowerCase()}` : host;
}

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

/**
 * A read on which the Worker got nothing a browser might (refused, not answered, a bot check:
 * BROWSER_READ_UNREAD) or almost nothing (site.thin): the one the runner's browser read may
 * replace (saveBrowserRead, lib/site-scan/browser-read.ts).
 */
// COALESCE: a read with nothing unread is NULL here, and NOT (NULL) would hide every good report.
const BROWSER_WANTED = `(COALESCE(json_extract(facts_json, '$.site.unread'), '') IN (${BROWSER_READ_UNREAD.map(() => "?").join(", ")}) OR COALESCE(json_extract(facts_json, '$.site.thin'), 0) = 1)`;

/**
 * Is a scan being worked on right now in any of these workspaces? The runner's claim answer tells
 * it to come back in a couple of seconds while one is (lib/tools/runner-handlers.ts): the match
 * and the pictures start while the visitor watches, never a poll interval later. A read older
 * than STALE_READ_MS is a dead Worker's, and an enrichment older than its wait is closed by the
 * view; neither is work pending. A database without the table has no scans.
 */
export async function scanWorkPending(db: Client, tenantIds: readonly string[], now: Date): Promise<boolean> {
  if (!tenantIds.length) return false;
  try {
    const rs = await db.execute({
      sql: `SELECT 1 FROM site_scans WHERE tenant_id IN (${tenantIds.map(() => "?").join(", ")})
              AND ((status IN ('queued', 'reading') AND updated_at >= ?) OR (status = 'enriching' AND updated_at >= ?)) LIMIT 1`,
      args: [...tenantIds, new Date(now.getTime() - STALE_READ_MS).toISOString(), new Date(now.getTime() - ENRICH_WAIT_MINUTES * 60_000).toISOString()],
    });
    return rs.rows.length > 0;
  } catch (err) {
    const e = err as { message?: string; code?: string } | null;
    if (isMissingTableError(e, "site_scans") || /no such table/i.test(e?.message ?? "")) return false;
    throw err;
  }
}

/**
 * A new scan row, ready for Tier 0. `started` says the caller owns this read and must run it:
 * true for a fresh row, and for today's row of the domain whenever it is not being worked on
 * right now (it is reset in place, under the one-per-day index, and the site is read again).
 * False when another visitor's read of the same domain today is the one in progress, which the
 * caller's visitor then follows; and for a finished report a lead already claimed, which stays.
 */
export async function insertScan(
  db: Client,
  input: { tenantId: string; domain: string; url: string; ipHash: string | null; now: Date },
): Promise<{ row: ScanRow; started: boolean }> {
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
    if (!(err instanceof Error && /UNIQUE|constraint/i.test(err.message))) throw err;
    // Two visitors, one domain, one day. A row not being worked on is reset for this attempt (the
    // conditional UPDATE lets exactly one visitor win); a live one is the scan.
    const staleBefore = new Date(input.now.getTime() - STALE_READ_MS).toISOString();
    const enrichOverdueBefore = new Date(input.now.getTime() - ENRICH_WAIT_MINUTES * 60_000).toISOString();
    // The row this visitor's read may take over: a finished report nobody claimed, a failed one, a
    // read nobody has touched for STALE_READ_MS (its Worker died), or an enrichment the runner
    // never delivered (the view closes those as done at the same age).
    const resettable = `tenant_id = ? AND domain = ? AND scan_day = ? AND lead_record_id IS NULL
              AND (status IN ('done', 'failed') OR (status IN ('queued', 'reading') AND updated_at < ?) OR (status = 'enriching' AND updated_at < ?))`;
    const where = [input.tenantId, input.domain, day, staleBefore, enrichOverdueBefore];
    // The retry is read again, so its Tier 0 claim is released with the rest (bravo__260).
    const resetSql = (claim: string) => ({
      sql: `UPDATE site_scans SET status = 'reading', stage = 'read', url = ?, facts_json = NULL, score_json = NULL, enrich_json = NULL, narrative_json = NULL,
              embedding_json = NULL, error_code = NULL, enriched_at = NULL${claim}, created_at = ?, updated_at = ?, expires_at = ? WHERE ${resettable}`,
      // A reset is a fresh read: it is dated now (so it is reusable, and not reset again) and kept the full TTL.
      args: [input.url, at, at, expires, ...where],
    });
    // The failed attempt's feed goes in the same transaction as the reset, on the same condition: it
    // is never replayed beside the new read, never uses up its allowance, and no stream can claim
    // the new read (and start writing) between the two.
    const clearFeed = { sql: `DELETE FROM site_scan_events WHERE tenant_id = ? AND scan_id IN (SELECT id FROM site_scans WHERE ${resettable})`, args: [input.tenantId, ...where] };
    let resetRows: number;
    try {
      resetRows = (await db.batch([clearFeed, resetSql(", tier0_claimed_at = NULL")], "write"))[1].rowsAffected;
    } catch (resetErr) {
      // A database that predates bravo__260 has neither the feed nor the claim: the reset alone.
      if (!(eventsTableMissing(resetErr) || (resetErr instanceof Error && /no such column: tier0_claimed_at/i.test(resetErr.message)))) throw resetErr;
      resetRows = (await db.execute(resetSql(""))).rowsAffected;
    }
    const rs = await db.execute({ sql: `SELECT ${COLUMNS} FROM site_scans WHERE tenant_id = ? AND domain = ? AND scan_day = ? LIMIT 1`, args: [input.tenantId, input.domain, day] });
    const r = rs.rows[0];
    if (!r) throw err;
    const row = rowFromRecord(r as unknown as Record<string, unknown>);
    if (resetRows === 1) {
      // The earlier run's pictures of the walk go too (bravo__262): the new walk takes its own, and a
      // frame showing the morning's home page beside a fresh read would be the old report again.
      try {
        await db.execute({ sql: "DELETE FROM site_scan_shots WHERE tenant_id = ? AND scan_id = ?", args: [input.tenantId, row.id] });
      } catch (shotErr) {
        if (!shotsTableMissing(shotErr)) throw shotErr;
      }
    }
    return { row, started: resetRows === 1 };
  }
  const row = await getScan(db, input.tenantId, id);
  if (!row) throw new Error("site-scan.store: inserted a scan but cannot read it back");
  return { row, started: true };
}

/**
 * Who runs a scan's Tier 0. The visitor's live stream claims it and runs it inside its own
 * connection; POST /api/scan's fallback claims it only if no stream did. The conditional UPDATE
 * lets exactly one of them win. `unsupported`: the database predates bravo__260, so the caller
 * runs Tier 0 the old way (POST's after()) and the stream only follows.
 */
export async function claimTier0(db: Client, input: { tenantId: string; id: string; now: Date }): Promise<"claimed" | "taken" | "unsupported"> {
  try {
    const rs = await db.execute({
      sql: `UPDATE site_scans SET tier0_claimed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'reading' AND tier0_claimed_at IS NULL`,
      args: [input.now.toISOString(), input.now.toISOString(), input.tenantId, input.id],
    });
    return rs.rowsAffected === 1 ? "claimed" : "taken";
  } catch (err) {
    if (err instanceof Error && /no such column: tier0_claimed_at/i.test(err.message)) return "unsupported";
    throw err;
  }
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

/**
 * The browser's read in place of the Worker's empty one (lib/site-scan/run.ts browserRead): only
 * while the runner is working on the row, and only over a read the Worker could not do, so a later
 * post never overwrites a real read.
 */
export type ScanLease = { jobId: string; runnerKey: string; leaseId: string };

export async function saveBrowserRead(
  db: Client,
  input: { tenantId: string; id: string; facts: ScanFacts; score: ScanScore; narrative: ScanNarrative; now: Date; lease?: ScanLease },
): Promise<boolean> {
  // With a lease, the write holds only while the runner's lease on the job does (the same test as
  // enrichStatement): a runner that paused past its lease and resumes after the job moved on writes nothing.
  const rs = await db.execute({
    sql: `UPDATE site_scans SET facts_json = ?, score_json = ?, narrative_json = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'enriching' AND ${BROWSER_WANTED}${input.lease ? ` AND EXISTS (SELECT 1 FROM tool_jobs WHERE ${LEASE_GUARD})` : ""}`,
    args: [
      JSON.stringify(input.facts), JSON.stringify(input.score), JSON.stringify(input.narrative), input.now.toISOString(), input.tenantId, input.id, ...BROWSER_READ_UNREAD,
      ...(input.lease ? [input.lease.jobId, input.lease.runnerKey, input.lease.leaseId] : []),
    ],
  });
  return rs.rowsAffected === 1;
}

export type EnrichWrite = { tenantId: string; id: string; enrich: ScanEnrich; narrative: ScanNarrative | null; embedding: number[] | null; now: Date };

/**
 * The runner's enrichment as one statement, written only while the runner's lease still holds the
 * job (the same test as lib/tools/store.ts LEASE_GUARD, inside the statement). The caller runs it
 * in one transaction with the guarded job completion: a runner that paused past its lease and
 * resumes after another runner finished cannot overwrite the public report.
 */
export function enrichStatement(input: EnrichWrite, lease: { jobId: string; runnerKey: string; leaseId: string }): InStatement {
  const base = saveEnrichSql(input);
  return {
    sql: `${base.sql} AND EXISTS (SELECT 1 FROM tool_jobs WHERE id = ? AND claimed_by = ? AND lease_id = ? AND status IN ('claimed', 'running'))`,
    args: [...base.args, lease.jobId, lease.runnerKey, lease.leaseId],
  };
}

function saveEnrichSql(input: EnrichWrite): { sql: string; args: InValue[] } {
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
  return { sql: `UPDATE site_scans SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ? AND status IN ('enriching', 'done')`, args };
}

/** The enrichment without a lease (tests, operator repair). The runner path uses enrichStatement. */
export async function saveEnrich(db: Client, input: EnrichWrite): Promise<boolean> {
  const rs = await db.execute(saveEnrichSql(input));
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

/**
 * Record the scan's first claim: the lead whose audit opened first (lib/site-scan/claim.ts calls
 * this only after the engagement exists). The conditional UPDATE decides a race: one lead is
 * `reserved`, any other sees `taken` (claims are not exclusive; that lead keeps its own
 * engagement). The same lead again is `mine`, a retry.
 */
export async function reserveClaim(
  db: Client,
  input: { tenantId: string; id: string; leadRecordId: string; now: Date },
): Promise<"reserved" | "mine" | "taken"> {
  const rs = await db.execute({
    sql: `UPDATE site_scans SET lead_record_id = ?, outcome = CASE WHEN outcome = 'none' THEN 'claimed' ELSE outcome END, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND lead_record_id IS NULL`,
    args: [input.leadRecordId, input.now.toISOString(), input.tenantId, input.id],
  });
  if (rs.rowsAffected === 1) return "reserved";
  const row = await getScan(db, input.tenantId, input.id);
  return row?.leadRecordId === input.leadRecordId ? "mine" : "taken";
}

/** Record the engagement a reserved claim opened. Only the claim's own lead, and only once. */
export async function setClaimEngagement(
  db: Client,
  input: { tenantId: string; id: string; leadRecordId: string; engagementId: string; now: Date },
): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE site_scans SET engagement_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND lead_record_id = ? AND engagement_id IS NULL`,
    args: [input.engagementId, input.now.toISOString(), input.tenantId, input.id, input.leadRecordId],
  });
  return rs.rowsAffected === 1;
}

/**
 * Retention: delete the scans past expires_at (30 days) that nobody claimed. Their facts, visitor
 * address hash and outcome go with them; that drops their `none` outcomes from learn.py's weekly
 * re-rank, which is the cost of keeping a stranger's scan no longer than declared. A claimed scan
 * is the first step of a lead's audit and is kept with it, but its visitor address hash is cleared.
 */
export async function purgeExpiredScans(db: Client, tenantId: string, now: Date, limit = 500): Promise<{ deleted: number; scrubbed: number }> {
  const at = now.toISOString();
  const del = await db.execute({
    sql: `DELETE FROM site_scans WHERE tenant_id = ? AND id IN (SELECT id FROM site_scans WHERE tenant_id = ? AND expires_at < ? AND lead_record_id IS NULL LIMIT ?)`,
    args: [tenantId, tenantId, at, limit],
  });
  const scrub = await db.execute({
    sql: `UPDATE site_scans SET ip_hash = NULL WHERE tenant_id = ? AND expires_at < ? AND lead_record_id IS NOT NULL AND ip_hash IS NOT NULL`,
    args: [tenantId, at],
  });
  // A deleted scan's pictures of the walk go with it (bravo__262; a database without the table has none).
  try {
    await db.execute({
      sql: `DELETE FROM site_scan_shots WHERE tenant_id = ? AND scan_id IN (
              SELECT DISTINCT sh.scan_id FROM site_scan_shots sh WHERE sh.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM site_scans s WHERE s.tenant_id = sh.tenant_id AND s.id = sh.scan_id) LIMIT ?)`,
      args: [tenantId, tenantId, limit],
    });
  } catch (err) {
    if (!(err instanceof Error && /no such table: site_scan_shots/i.test(err.message))) throw err;
  }
  // A deleted scan's live feed goes with it (a claimed scan keeps both).
  try {
    await db.execute({
      sql: `DELETE FROM site_scan_events WHERE tenant_id = ? AND id IN (
              SELECT e.id FROM site_scan_events e WHERE e.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM site_scans s WHERE s.tenant_id = e.tenant_id AND s.id = e.scan_id) LIMIT ?)`,
      args: [tenantId, tenantId, limit * 50],
    });
  } catch (err) {
    if (!eventsTableMissing(err)) throw err;
  }
  return { deleted: del.rowsAffected, scrubbed: scrub.rowsAffected };
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
