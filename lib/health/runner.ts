/**
 * lib/health/runner.ts — runs the outcome checks, persists results, and alerts.
 *
 * The piece that turns checks into something Adon actually hears about. Written
 * after a three-week SMS outage and a one-day email outage passed unnoticed.
 *
 * Design notes worth keeping:
 *   - Every check runs even if an earlier one throws. One broken check must not
 *     silence the rest, which is how a monitor becomes decorative.
 *   - A check that throws is reported as `check_broken` and ALERTS. Not knowing
 *     is not the same as healthy.
 *   - Alert decay is delegated to lib/notify/alert-decay.ts. There is exactly
 *     one ladder in this codebase and this file does not add a second.
 *   - Recovery is announced. A condition that clears without a message trains
 *     people to ignore the channel, because they never learn it self-heals.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram } from "@/lib/notify/telegram";
import { shouldAlert } from "@/lib/notify/alert-decay";
import { alertSignature, worstVerdict, type CheckResult } from "./checks-core";
import { DRIP_CHECKS, runCheck } from "./drip-checks";

type Db = ReturnType<typeof getServiceSupabase>;

const SEV_ICON: Record<string, string> = {
  failing: "🔴",
  degraded: "🟠",
  check_broken: "⚪",
  ok: "🟢",
};

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type RunSummary = {
  ran: number;
  results: CheckResult[];
  alerted: string[];
  recovered: string[];
  worst: string;
};

/**
 * Run every drip check for a tenant, persist, and alert on anything not ok.
 *
 * `notify:false` runs the checks and records them without sending, which is how
 * the daily digest and any manual invocation avoid double-paging.
 */
export async function runHealthChecks(
  tenantId: string,
  opts: { nowMs?: number; notify?: boolean } = {},
): Promise<RunSummary> {
  const db = getServiceSupabase();
  const nowMs = opts.nowMs ?? Date.now();
  const notify = opts.notify !== false;
  const results: CheckResult[] = [];
  const alerted: string[] = [];
  const recovered: string[] = [];

  for (const check of DRIP_CHECKS) {
    let result: CheckResult;
    try {
      result = await runCheck(db, tenantId, check, nowMs);
    } catch (err) {
      // A check that throws is a failure of the check, not a pass of the thing.
      result = {
        id: check.id,
        verdict: "check_broken",
        observed: NaN,
        baseline: null,
        reason: `check threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      };
    }
    results.push(result);

    // Persist first, so a later notify failure cannot lose the observation.
    await db.from("health_check_runs").insert({
      tenant_id: tenantId,
      check_id: result.id,
      surface: "oasis",
      verdict: result.verdict,
      observed: Number.isFinite(result.observed) ? result.observed : null,
      baseline: result.baseline,
      reason: result.reason.slice(0, 500),
      ran_at: new Date(nowMs).toISOString(),
    }).then(() => undefined, () => undefined);

    if (!notify) continue;

    const key = `health:${result.id}`;
    const stateRow = await db.from("health_alert_state").select("*").eq("alert_key", key).maybeSingle();
    const state = stateRow.data as
      | { last_signature: string | null; last_alerted_at: string | null; repeat_n: number | null; first_failed_at: string | null }
      | null;

    if (result.verdict === "ok") {
      // Announce recovery once, then clear the episode so the next failure
      // starts a fresh ladder rather than inheriting a 24h window.
      if (state?.first_failed_at) {
        recovered.push(result.id);
        await sendTelegram(
          `🟢 <b>RECOVERED</b> — ${esc(result.id)}\n${esc(result.reason)}`,
          { lane: "sunbiz-ops" },
        ).catch(() => undefined);
        await db.from("health_alert_state").upsert({
          alert_key: key, tenant_id: tenantId, last_signature: null,
          last_alerted_at: state.last_alerted_at, repeat_n: 0, first_failed_at: null,
          updated_at: new Date(nowMs).toISOString(),
        }, { onConflict: "alert_key" }).then(() => undefined, () => undefined);
      }
      continue;
    }

    const signature = alertSignature(result.id, result.verdict);
    const decision = shouldAlert(
      signature,
      { lastSignature: state?.last_signature, lastAlertedAt: state?.last_alerted_at, repeatN: state?.repeat_n },
      new Date(nowMs),
    );
    if (!decision.send) continue;

    const body =
      `${SEV_ICON[result.verdict]} <b>${esc(result.verdict.toUpperCase())}</b> — ${esc(result.id)}\n` +
      `${esc(check.describe(result))}\n` +
      `<i>next check in 15 min · re-alerts in ${decision.windowH}h if still bad</i>`;
    const sent = await sendTelegram(body, { lane: "sunbiz-ops" }).catch(() => ({ ok: false }));

    // Record the alert attempt regardless of delivery. If Telegram is down we
    // must not spin re-sending every 15 minutes; the delivery self-test is the
    // separate mechanism that catches a dead channel.
    alerted.push(result.id);
    await db.from("health_alert_state").upsert({
      alert_key: key,
      tenant_id: tenantId,
      last_signature: signature,
      last_alerted_at: new Date(nowMs).toISOString(),
      repeat_n: decision.nextRepeatN,
      first_failed_at: state?.first_failed_at ?? new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    }, { onConflict: "alert_key" }).then(() => undefined, () => undefined);

    if (!sent.ok) {
      console.error("[health] telegram delivery failed", { check: result.id });
    }
  }

  return { ran: results.length, results, alerted, recovered, worst: worstVerdict(results) };
}

/**
 * The dead-man's switch, from the OTHER side.
 *
 * The 2026-06-30 audit's finding #3: apex-health-monitor is not in its own watch
 * list and has no external switch, so its death silences every alert with no
 * notice. This runs on Vercel — a different machine, a different failure domain
 * — and reports if the local fleet's heartbeat goes stale.
 *
 * A watchdog that cannot report its own death is decorative.
 */
export async function checkFleetHeartbeat(
  db: Db,
  opts: { maxStaleMin?: number; nowMs?: number } = {},
): Promise<CheckResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const maxStale = (opts.maxStaleMin ?? 30) * 60_000;
  try {
    const r = await db
      .from("agent_activity")
      .select("created_at")
      .eq("agent", "apex-health-monitor")
      .order("created_at", { ascending: false })
      .limit(1);
    if (r.error) {
      return { id: "fleet.heartbeat", verdict: "check_broken", observed: NaN, baseline: null,
        reason: `could not read fleet heartbeat: ${r.error.message}`.slice(0, 200) };
    }
    const last = r.data?.[0]?.created_at ? Date.parse(r.data[0].created_at) : NaN;
    if (!Number.isFinite(last)) {
      return { id: "fleet.heartbeat", verdict: "failing", observed: 0, baseline: null,
        reason: "the local health monitor has never reported in" };
    }
    const staleMin = Math.round((nowMs - last) / 60_000);
    return nowMs - last > maxStale
      ? { id: "fleet.heartbeat", verdict: "failing", observed: staleMin, baseline: opts.maxStaleMin ?? 30,
          reason: `the local health monitor last reported ${staleMin} min ago — alerting for the whole JARVIS fleet may be dead` }
      : { id: "fleet.heartbeat", verdict: "ok", observed: staleMin, baseline: opts.maxStaleMin ?? 30,
          reason: `local monitor reported ${staleMin} min ago` };
  } catch (err) {
    return { id: "fleet.heartbeat", verdict: "check_broken", observed: NaN, baseline: null,
      reason: `heartbeat check threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
  }
}
