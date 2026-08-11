/**
 * lib/drips/activity-queries.ts — the reads behind the Drips activity tab.
 *
 * The rules that decide whether a row counts as a send live in activity-core.ts
 * and are pure. This file is I/O only.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  classifyRunStatus,
  summarizeFailures,
  isHeldForPolicy,
  outcomeWindow,
  type ActivityStatus,
  type FailureSummary,
} from "./activity-core";

type Db = ReturnType<typeof getServiceSupabase>;

export type { ActivityStatus, FailureSummary } from "./activity-core";
export { classifyRunStatus, summarizeFailures } from "./activity-core";

export type DripActivityRow = {
  id: string;
  leadId: string;
  leadName: string | null;
  sequenceName: string | null;
  stepIndex: number | null;
  channel: string | null;
  brand: string;
  status: ActivityStatus;
  rawStatus: string | null;
  fromIdentity: string | null;
  /** The provider's own reason, verbatim. Paraphrasing an error is how a
   *  diagnosable failure becomes a shrug. */
  error: string | null;
  heldForPolicy: boolean;
  sentAt: string | null;
  scheduledFor: string | null;
};

export type ActivityFilters = {
  channel?: "email" | "sms";
  status?: ActivityStatus;
  sequenceName?: string;
  sinceMs?: number;
  limit?: number;
};

/**
 * Recent drip activity.
 *
 * Tenant-scoped on every query: the service role bypasses RLS, so the filter is
 * the only thing keeping one tenant's merchant list off another's screen.
 */
export async function recentDripActivity(
  tenantId: string,
  filters: ActivityFilters = {},
): Promise<DripActivityRow[]> {
  const db: Db = getServiceSupabase();
  const limit = Math.min(filters.limit ?? 200, 500);
  const since = new Date(filters.sinceMs ?? Date.now() - 7 * 24 * 3_600_000).toISOString();

  const COLS =
    "id, lead_id, sequence_name, step_index, channel, status, from_identity, last_error, sent_at, scheduled_for";

  /**
   * TWO QUERIES, EACH WITH ITS OWN LIMIT, and that is the point.
   *
   * A single query has to pick one ORDER BY, and whichever it picks decides
   * which rows survive the limit — a later JS sort cannot recover a row the
   * database already discarded. Ordering by scheduled_for drops the open
   * failures once a tenant has more than `limit` runs in the window; ordering
   * by sent_at drops recently-sent rows that were scheduled long ago, which is
   * exactly the backlog case outcomeWindow exists for. Both losses are silent.
   *
   * So: OPEN rows (nothing sent yet — every failure and everything pending) are
   * fetched separately from COMPLETED ones. Each is capped, so a flood of
   * either cannot crowd out the other.
   *
   * The previous single query also carried `.order("sent_at", { nullsFirst })`,
   * which was a comment asserting something that never happened: the live plane
   * is Turso, lib/turso-postgrest.ts accepts only `{ ascending }`, and SQLite
   * puts NULLs LAST on a DESC sort. The rows an operator opens this tab FOR
   * were sorting to the bottom.
   */
  const base = (kind: "open" | "done") => {
    let q = db
      .from("drip_runs")
      .select(COLS)
      .eq("tenant_id", tenantId);
    q =
      kind === "open"
        ? // Open: no sent_at at all, due inside the window.
          q.is("sent_at", null).gte("scheduled_for", since)
        : // Completed: measured by when it actually SENT, not when it was due.
          q.not("sent_at", "is", null).gte("sent_at", since);
    q = q.order(kind === "open" ? "scheduled_for" : "sent_at", { ascending: false }).limit(limit);
    if (filters.channel) q = q.eq("channel", filters.channel);
    if (filters.sequenceName) q = q.eq("sequence_name", filters.sequenceName);
    return q;
  };

  const [openRes, doneRes] = await Promise.all([base("open"), base("done")]);
  // Either failing is a failure. Returning half the picture as if it were the
  // whole one is the silent-truncation shape this module exists to refuse.
  if (openRes.error) throw new Error(`drip activity read failed: ${openRes.error.message}`);
  if (doneRes.error) throw new Error(`drip activity read failed: ${doneRes.error.message}`);
  const runs = [...(openRes.data || []), ...(doneRes.data || [])];

  // Lead names and brands in ONE batched read rather than per row.
  const leadIds = [...new Set(runs.map((r) => String(r.lead_id)).filter(Boolean))].slice(0, 500);
  const names = new Map<string, string>();
  const brands = new Map<string, string>();
  if (leadIds.length > 0) {
    const leads = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .in("id", leadIds);
    // Throwing here, not degrading. If this read fails the brand map stays
    // empty and EVERY row falls back to "sunbiz" — so a screenful of Bluerise
    // sends would be labelled SunBiz on the one surface built to report what
    // actually went out. A wrong brand is worse than no screen: it is the same
    // wrong answer the drip engine would give, echoed back as confirmation.
    if (leads.error) throw new Error(`drip activity lead read failed: ${leads.error.message}`);
    for (const l of leads.data || []) {
      const d = (l.data || {}) as Record<string, unknown>;
      const name = String(d.business_name || d.contact_name || "").trim();
      if (name) names.set(String(l.id), name);
      const b = String(d.sending_brand || "").trim();
      if (b) brands.set(String(l.id), b);
    }
  }

  const rows: DripActivityRow[] = runs.map((r) => ({
    id: String(r.id),
    leadId: String(r.lead_id),
    leadName: names.get(String(r.lead_id)) ?? null,
    sequenceName: r.sequence_name ?? null,
    stepIndex: typeof r.step_index === "number" ? r.step_index : null,
    channel: r.channel ?? null,
    // An absent stamp means SunBiz, matching brand-routing's safe default.
    brand: brands.get(String(r.lead_id)) ?? "sunbiz",
    status: classifyRunStatus(r),
    rawStatus: r.status ?? null,
    fromIdentity: r.from_identity ?? null,
    error: r.last_error ?? null,
    heldForPolicy: isHeldForPolicy(r.last_error),
    sentAt: r.sent_at ?? null,
    scheduledFor: r.scheduled_for ?? null,
  }));

  // Sorted HERE, not in SQL, so the order does not depend on which dialect is
  // behind getServiceSupabase(). Postgres and SQLite disagree about where NULLs
  // land, and the compat shim does not carry nullsFirst at all.
  //
  // Open rows first — a failure or a stuck retry is what an operator opened
  // this tab for — then completed sends, newest first.
  rows.sort((a, b) => {
    const openA = a.sentAt ? 1 : 0;
    const openB = b.sentAt ? 1 : 0;
    if (openA !== openB) return openA - openB;
    const key = (r: DripActivityRow) => r.sentAt || r.scheduledFor || "";
    return key(b).localeCompare(key(a));
  });

  return filters.status ? rows.filter((r) => r.status === filters.status) : rows;
}

/**
 * Headline numbers for the tab.
 *
 * Deliberately only failure/error shape. Opens, clicks and per-variant
 * performance stay in /metrics; duplicating them here would create a second
 * set of numbers to disagree with the first.
 */
const SUMMARY_ROW_CAP = 5000;

export async function dripFailureSummary(
  tenantId: string,
  sinceMs: number = Date.now() - 24 * 3_600_000,
): Promise<FailureSummary & { heldForPolicy: number; truncated: boolean }> {
  const db: Db = getServiceSupabase();
  const res = await db
    .from("drip_runs")
    .select("status, from_identity, last_error")
    .eq("tenant_id", tenantId)
    .or(outcomeWindow(new Date(sinceMs).toISOString()))
    // One more than the cap, purely so hitting the cap is DETECTABLE. Reading
    // exactly the cap cannot distinguish "5000 rows" from "at least 5000".
    .limit(SUMMARY_ROW_CAP + 1);
  if (res.error) throw new Error(`drip summary read failed: ${res.error.message}`);
  const all = res.data || [];
  // A capped read produces real numbers over a partial sample. Rendering those
  // as fact is the same false denominator this module exists to prevent, one
  // level up, so the cap is REPORTED rather than absorbed.
  const truncated = all.length > SUMMARY_ROW_CAP;
  const rows = truncated ? all.slice(0, SUMMARY_ROW_CAP) : all;
  return {
    ...summarizeFailures(rows),
    heldForPolicy: rows.filter((r) => isHeldForPolicy(r.last_error)).length,
    truncated,
  };
}
