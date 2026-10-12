/**
 * lib/offers/tracking-store.ts - offer_funnel_events (migration bravo__218,
 * V5a). Raw read/write helpers over the table, following the exact pattern
 * lib/offer-pages/store.ts already uses for the Turso data plane: a plain
 * `Client`, every statement scoped by tenant_id, "table missing" treated as
 * "no tracking available" rather than an error (the table may not exist yet
 * in every environment this code runs in).
 *
 * THE VOCABULARY LIVES HERE, NOT IN A CHECK CONSTRAINT (house rule: see the
 * migration's own comment). isValidEvent / sanitizeDetail are the one place
 * an event name or its detail keys are accepted; tests/offer-funnel-events.test.ts
 * pins both.
 *
 * No `server-only`: tests drive this against a local libSQL file.
 */
import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { offerPagesDb, isMissingOfferTable } from "@/lib/offer-pages/store";

export { offerPagesDb };

/** The whitelisted event vocabulary (HANDOVER section 5 + the build spec). */
export const FUNNEL_EVENT_NAMES = [
  "page_view",
  "video_play",
  "video_progress",
  "path_selected",
  "step_viewed",
  "step_submitted",
  "community_click",
  "checkout_click",
  "booking_made",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

export function isValidFunnelEvent(value: unknown): value is FunnelEventName {
  return typeof value === "string" && (FUNNEL_EVENT_NAMES as readonly string[]).includes(value);
}

/** video_progress's only valid checkpoints. Anything else is dropped (not rejected). */
const VIDEO_PROGRESS_CHECKPOINTS = new Set([25, 50, 75, 100]);
/** path_selected's only valid values: the four pillars from the funnel doc. */
const PATH_VALUES = new Set(["p1", "p2", "p3", "p4"]);

/**
 * The server decides what a detail object may hold, per event -- never the
 * client. Returns a JSON string to store, or null when there is nothing (or
 * nothing VALID) to store. An unrecognized or out-of-range value is dropped
 * silently; it never rejects the event itself (fail-quiet ingest, per the
 * build spec: a malformed detail must not cost the page_view/step_viewed its
 * own row).
 */
export function sanitizeFunnelDetail(event: FunnelEventName, raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (event === "video_progress") {
    const percent = Number(obj.percent);
    if (!VIDEO_PROGRESS_CHECKPOINTS.has(percent)) return null;
    return JSON.stringify({ percent });
  }
  if (event === "path_selected") {
    const path = typeof obj.path === "string" ? obj.path.trim().toLowerCase() : "";
    if (!PATH_VALUES.has(path)) return null;
    return JSON.stringify({ path });
  }
  // Every other event in FUNNEL_EVENT_NAMES carries no detail today.
  return null;
}

/** step_index: a small non-negative integer, or null. Anything else is dropped. */
export function sanitizeStepIndex(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 50) return null;
  return n;
}

/**
 * visit_id: the opaque per-browser-session id from lib/offers/tracking-client.ts.
 * A UUID (any version) or, defensively, any 16-128 char token of [A-Za-z0-9_-]
 * -- the browser's crypto.randomUUID() is a UUID, but this never hard-fails a
 * future format change into silently dropping every event.
 */
export function isValidVisitId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(raw);
}

function rowsOf<T extends Record<string, unknown>>(rs: { rows: unknown[]; columns: string[] }): T[] {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o as T;
  });
}

/** "offer_funnel_events does not exist yet": bravo__218 has not been applied here. */
export function isMissingFunnelTable(err: unknown): boolean {
  return /no such table:\s*"?offer_funnel_events\b/i.test(err instanceof Error ? err.message : String(err));
}

let missingLogged = false;
function noteMissing(where: string): void {
  if (missingLogged) return;
  missingLogged = true;
  console.error(`[offer-funnel] table missing (${where}): migration bravo__218 not applied, no events are recorded`);
}

/**
 * Record one event. Never throws on a missing table or a DB error -- a
 * tracking failure must never surface to the visitor or the caller that fired
 * it (the ingest route always answers 204 regardless). Returns whether a row
 * was actually written, for the caller's own logging.
 */
export async function insertFunnelEvent(
  db: Client,
  input: {
    tenantId: string;
    formId: string;
    visitId: string;
    event: FunnelEventName;
    stepIndex?: number | null;
    detail?: string | null;
    leadId?: string | null;
    now?: string;
  },
): Promise<boolean> {
  try {
    await db.execute({
      sql: `INSERT INTO offer_funnel_events (id, tenant_id, form_id, visit_id, event, step_index, detail, lead_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        input.tenantId,
        input.formId,
        input.visitId,
        input.event,
        input.stepIndex ?? null,
        input.detail ?? null,
        input.leadId ?? null,
        input.now ?? new Date().toISOString(),
      ],
    });
    return true;
  } catch (err) {
    if (isMissingFunnelTable(err) || isMissingOfferTable(err)) {
      noteMissing("insert");
      return false;
    }
    console.error("[offer-funnel] insert failed", { tenantId: input.tenantId, event: input.event, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Link a visit to the lead it just became, at submit -- and ONLY then. Every
 * row this visit wrote BEFORE the visitor gave their details gets lead_id
 * filled in once; a row already linked (a second step's submit re-running
 * this) is left alone, so the FIRST lead a visit resolves to is final.
 * Never throws: a failed link must not fail the submission it rides on.
 */
export async function linkVisitToLead(
  db: Client,
  input: { tenantId: string; visitId: string; leadId: string },
): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE offer_funnel_events SET lead_id = ?
            WHERE tenant_id = ? AND visit_id = ? AND lead_id IS NULL`,
      args: [input.leadId, input.tenantId, input.visitId],
    });
  } catch (err) {
    if (isMissingFunnelTable(err) || isMissingOfferTable(err)) {
      noteMissing("link");
      return;
    }
    console.error("[offer-funnel] visit-lead link failed", { tenantId: input.tenantId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Does this visit already carry a lead (from an earlier submit in the same
 * session)? Used by /go/community to decide whether to also write the
 * save_basin.enrolled lead interaction. null on any failure or missing table
 * -- the redirect still happens either way; this is best-effort enrichment.
 */
export async function findLeadForVisit(db: Client, tenantId: string, visitId: string): Promise<string | null> {
  try {
    const rs = await db.execute({
      sql: `SELECT lead_id FROM offer_funnel_events
            WHERE tenant_id = ? AND visit_id = ? AND lead_id IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
      args: [tenantId, visitId],
    });
    const r = rowsOf<{ lead_id: string }>(rs)[0];
    return r ? String(r.lead_id) : null;
  } catch (err) {
    if (isMissingFunnelTable(err) || isMissingOfferTable(err)) {
      noteMissing("find-lead");
      return null;
    }
    console.error("[offer-funnel] find-lead-for-visit failed", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export type FunnelCounts = { views: number | null; video_plays: number | null; community: number | null };

/**
 * Distinct-visit counts per form, over a window, for the three funnel-strip
 * metrics this migration makes real: views (page_view), video_plays
 * (video_play), community (community_click). Leads keeps using
 * lib/offer-pages/store.ts:countRecentLeads (form_submissions is the
 * authoritative source there); booked has no tracking yet and stays "-"
 * regardless of this read. null per metric on a failed read (shown "-" with
 * "couldn't load", never a false 0), matching countRecentLeads' contract.
 */
export async function countFunnelEventMetrics(
  db: Client,
  tenantId: string,
  formIds: string[],
  sinceIso: string,
): Promise<Record<string, FunnelCounts>> {
  const out: Record<string, FunnelCounts> = Object.fromEntries(
    formIds.map((id) => [id, { views: 0, video_plays: 0, community: 0 }]),
  );
  if (!formIds.length) return out;
  try {
    const marks = formIds.map(() => "?").join(", ");
    const rs = await db.execute({
      sql: `SELECT form_id, event, COUNT(DISTINCT visit_id) AS n FROM offer_funnel_events
            WHERE tenant_id = ? AND created_at >= ? AND form_id IN (${marks})
              AND event IN ('page_view', 'video_play', 'community_click')
            GROUP BY form_id, event`,
      args: [tenantId, sinceIso, ...formIds],
    });
    const key: Record<string, keyof FunnelCounts> = {
      page_view: "views",
      video_play: "video_plays",
      community_click: "community",
    };
    for (const r of rowsOf<{ form_id: string; event: string; n: number }>(rs)) {
      const k = key[r.event];
      if (!k) continue;
      out[String(r.form_id)][k] = Number(r.n ?? 0);
    }
    return out;
  } catch (err) {
    // Missing table (bravo__218 not yet applied here) and a genuine query
    // failure are both "could not read this" to the caller -- same contract
    // countRecentLeads already uses for `leads`: null, never a false 0, shown
    // as "-" / "couldn't load" by funnelCell(value, "unavailable").
    if (isMissingFunnelTable(err) || isMissingOfferTable(err)) noteMissing("counts");
    else console.error("[offer-funnel] funnel counts unreadable", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return Object.fromEntries(formIds.map((id) => [id, { views: null, video_plays: null, community: null }]));
  }
}

/**
 * The 13-month retention purge (migration comment). Deletes every event
 * created before `cutoffIso` and returns the row count removed. No cron
 * wiring yet -- this is the helper a later scheduled job calls.
 */
export async function purgeFunnelEventsOlderThan(db: Client, cutoffIso: string): Promise<number> {
  try {
    const rs = await db.execute({
      sql: `DELETE FROM offer_funnel_events WHERE created_at < ?`,
      args: [cutoffIso],
    });
    return rs.rowsAffected;
  } catch (err) {
    if (isMissingFunnelTable(err) || isMissingOfferTable(err)) {
      noteMissing("purge");
      return 0;
    }
    throw err;
  }
}

/** 13 months back from `now`, as an ISO string -- the retention cutoff the migration documents. */
export function retentionCutoff(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - 13);
  return d.toISOString();
}
