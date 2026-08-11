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

  let q = db
    .from("drip_runs")
    .select(
      "id, lead_id, sequence_name, step_index, channel, status, from_identity, last_error, sent_at, scheduled_for",
    )
    .eq("tenant_id", tenantId)
    .gte("scheduled_for", since)
    .order("scheduled_for", { ascending: false })
    .limit(limit);
  if (filters.channel) q = q.eq("channel", filters.channel);
  if (filters.sequenceName) q = q.eq("sequence_name", filters.sequenceName);

  const res = await q;
  if (res.error) throw new Error(`drip activity read failed: ${res.error.message}`);
  const runs = res.data || [];

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

  return filters.status ? rows.filter((r) => r.status === filters.status) : rows;
}

/**
 * Headline numbers for the tab.
 *
 * Deliberately only failure/error shape. Opens, clicks and per-variant
 * performance stay in /metrics; duplicating them here would create a second
 * set of numbers to disagree with the first.
 */
export async function dripFailureSummary(
  tenantId: string,
  sinceMs: number = Date.now() - 24 * 3_600_000,
): Promise<FailureSummary & { heldForPolicy: number }> {
  const db: Db = getServiceSupabase();
  const res = await db
    .from("drip_runs")
    .select("status, from_identity, last_error")
    .eq("tenant_id", tenantId)
    .gte("scheduled_for", new Date(sinceMs).toISOString())
    .limit(5000);
  if (res.error) throw new Error(`drip summary read failed: ${res.error.message}`);
  const rows = res.data || [];
  return {
    ...summarizeFailures(rows),
    heldForPolicy: rows.filter((r) => isHeldForPolicy(r.last_error)).length,
  };
}
