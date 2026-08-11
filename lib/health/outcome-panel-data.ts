/**
 * lib/health/outcome-panel-data.ts — the reads behind the outcome-check panel.
 *
 * Split out of the panel component so the PAGE can count the same signals into
 * its header verdict. Without that, `/health` could render "All clear" above a
 * card reporting a failing check, a stale check, an open alert, or a read
 * failure — a headline contradicting the evidence directly beneath it, which is
 * worse than either alone because the header is what people actually read.
 *
 * One read, two consumers. Loading it twice would let the two halves of the
 * page disagree about the same moment.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { toPanelRows, type PanelCheck, type OpenAlert, type PanelRow } from "./panel-core";

export type OutcomeCheckData = {
  rows: PanelRow[];
  openAlerts: OpenAlert[];
  /** True when EITHER read failed. The panel is then blind, which is an
   *  unknown, never a clean bill of health. */
  readFailed: boolean;
  readError: string | null;
  /** Rows needing attention plus open alerts, plus one for a blind read. What
   *  the page header counts. */
  signalCount: number;
};

export async function loadOutcomeChecks(tenantId: string | null, nowMs: number): Promise<OutcomeCheckData> {
  const empty: OutcomeCheckData = { rows: [], openAlerts: [], readFailed: false, readError: null, signalCount: 0 };
  if (!tenantId) return empty;

  const db = getServiceSupabase();

  // Latest run per check. A bounded recent window reduced in memory, rather
  // than a query per check: the table is small and one read beats twelve.
  const runsRes = await db
    .from("health_check_runs")
    .select("check_id, verdict, observed, baseline, reason, ran_at")
    .eq("tenant_id", tenantId)
    .order("ran_at", { ascending: false })
    .limit(400);

  const latest = new Map<string, PanelCheck>();
  for (const r of runsRes.data || []) {
    const id = String(r.check_id);
    if (latest.has(id)) continue; // list is desc, so the first is newest
    latest.set(id, {
      checkId: id,
      verdict: String(r.verdict),
      observed: typeof r.observed === "number" ? r.observed : null,
      baseline: typeof r.baseline === "number" ? r.baseline : null,
      reason: r.reason ?? null,
      ranAt: r.ran_at ?? null,
    });
  }
  const rows = toPanelRows([...latest.values()], nowMs);

  const alertsRes = await db
    .from("health_alert_state")
    .select("alert_key, first_failed_at, last_alerted_at, repeat_n")
    .eq("tenant_id", tenantId)
    .not("first_failed_at", "is", null)
    .order("first_failed_at", { ascending: true })
    .limit(50);
  const openAlerts: OpenAlert[] = (alertsRes.data || []).map((a) => ({
    alertKey: String(a.alert_key),
    firstFailedAt: a.first_failed_at ?? null,
    lastAlertedAt: a.last_alerted_at ?? null,
    repeatN: Number(a.repeat_n ?? 0),
  }));

  // BOTH reads. If only the alert query fails, openAlerts is empty and the card
  // would show a clean board while alert visibility is actually gone.
  const readFailed = Boolean(runsRes.error || alertsRes.error);
  const readError = runsRes.error?.message
    ? `checks: ${runsRes.error.message}`
    : alertsRes.error?.message
      ? `open alerts: ${alertsRes.error.message}`
      : null;

  const signalCount =
    rows.filter((r) => r.needsAttention).length + openAlerts.length + (readFailed ? 1 : 0);

  return { rows, openAlerts, readFailed, readError, signalCount };
}
