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
import { sendTelegram, type TelegramLane } from "@/lib/notify/telegram";
import { shouldAlert } from "@/lib/notify/alert-decay";
import { alertSignature, worstVerdict, type CheckResult } from "./checks-core";
import { DRIP_CHECKS, runCheck } from "./drip-checks";
import { emailDripChecks } from "./email-drip-checks";
import { FORM_CHECKS } from "./form-checks";
import { DEPLOY_CHECKS } from "./deploy-checks";
import { CALENDAR_CHECKS } from "./calendar-checks";

import { computeCoverage } from "./coverage";

/**
 * Every check this run evaluates.
 *
 * Built PER RUN rather than once at module load: the email-drip thresholds are
 * read from env at call time so the six-week ramp can move without a deploy,
 * and a list captured at process start would keep grading against a stale
 * target while reporting green.
 */
export function allChecks() {
  return [...DRIP_CHECKS, ...emailDripChecks(), ...FORM_CHECKS, ...DEPLOY_CHECKS, ...CALENDAR_CHECKS];
}


type Db = ReturnType<typeof getServiceSupabase>;

/**
 * Where a check's alerts go.
 *
 * `sunbiz-ops` is the default because every check that existed when this runner
 * was written was a SunBiz drip check, and the lane was hardcoded to match. The
 * estate outgrew that: the OASIS workspace-calendar check added in #334 would
 * have announced an OASIS booking outage into the CLIENT's ops channel, for a
 * product they do not operate. An alert in the wrong room is an alert nobody
 * acts on, which is indistinguishable from no alert at all -- the exact failure
 * mode this whole subsystem was built after.
 *
 * Defaulting rather than requiring the field keeps every existing check on the
 * lane it already used, so this is additive: nothing reroutes by accident.
 */
function laneFor(check: { lane?: TelegramLane }): TelegramLane {
  return check.lane ?? "sunbiz-ops";
}

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
  let telegramFailures = 0;

  const checks = allChecks();
  for (const check of checks) {
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
          { lane: laneFor(check) },
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
    const sent = await sendTelegram(body, { lane: laneFor(check) }).catch(() => ({ ok: false }));

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
      // THE ALERT CHANNEL IS A SINGLE POINT OF FAILURE (2026-06-30 audit,
      // finding #1) and on 2026-08-07 it was genuinely down: @KnutRPEbot had
      // been kicked from the sunbiz-ops group, so every alert returned 403 and
      // the only record was a console line nobody reads.
      //
      // A delivery failure is therefore recorded as its own check result, in
      // the DATABASE — a path that does not depend on the channel that just
      // failed. Otherwise a dead alert channel is indistinguishable from a
      // healthy fleet, which is the exact failure this whole system exists to
      // prevent.
      //
      // Note also: Telegram's getChat returns ok for a group the bot has been
      // kicked from. Only a real send proves deliverability, so any future
      // self-test must SEND, not probe.
      console.error("[health] telegram delivery failed", { check: result.id });
      telegramFailures += 1;
      await db.from("health_check_runs").insert({
        tenant_id: tenantId,
        check_id: "alerting.telegram_delivery",
        surface: "oasis",
        verdict: "failing",
        observed: 0,
        baseline: 1,
        reason: `could not deliver the ${result.id} alert to the sunbiz-ops lane`.slice(0, 500),
        ran_at: new Date(nowMs).toISOString(),
      }).then(() => undefined, () => undefined);
    }
  }

  // One summary row per run, so "was anything even checked" is answerable from
  // the database alone, without trusting the alert channel.
  await db.from("health_check_runs").insert({
    tenant_id: tenantId,
    check_id: "health.run_completed",
    surface: "oasis",
    verdict: telegramFailures > 0 ? "degraded" : "ok",
    observed: results.length,
    baseline: checks.length,
    reason: `${results.length} checks ran; ${alerted.length} alerted; ${telegramFailures} undeliverable`,
    ran_at: new Date(nowMs).toISOString(),
  }).then(() => undefined, () => undefined);

  return { ran: results.length, results, alerted, recovered, worst: worstVerdict(results) };
}

/**
 * What exists but is not checked.
 *
 * The 2026-08-06 incident was caused by a hand-maintained watch list, not by a
 * missing check. So the gap itself is monitored: crons come from vercel.json,
 * brands from the registry, and anything without a corresponding check is
 * reported. Low severity and weekly, because it is a backlog rather than an
 * outage — but never silent, because silence is how the list fell behind.
 */
export async function reportCoverageGap(
  vercelConfig: unknown,
  opts: { notify?: boolean } = {},
): Promise<{ uncovered: string[]; crons: number }> {
  const cov = computeCoverage({
    vercelConfig,
    knownCheckIds: allChecks().map((c) => c.id),
  });
  if (opts.notify && cov.uncovered.length > 0) {
    const shown = cov.uncovered.slice(0, 15);
    await sendTelegram(
      `⚪ <b>MONITORING GAP</b> — ${cov.uncovered.length} surface(s) have no health check\n` +
        shown.map((u) => `· ${esc(u)}`).join("\n") +
        (cov.uncovered.length > shown.length ? `\n…and ${cov.uncovered.length - shown.length} more` : "") +
        `\n<i>${cov.crons.length} cron routes discovered from vercel.json</i>`,
      { lane: "sunbiz-ops" },
    ).catch(() => undefined);
  }
  return { uncovered: cov.uncovered, crons: cov.crons.length };
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
