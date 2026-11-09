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
import { sendTelegram, type TelegramLane, type TelegramDelivery } from "@/lib/notify/telegram";
import { shouldAlert } from "@/lib/notify/alert-decay";
import { alertSignature, worstVerdict, type CheckResult } from "./checks-core";
import { DRIP_CHECKS, runCheck, type DripCheck } from "./drip-checks";
import { WORKER_REPORTER_OFFLINE_REASON } from "@/lib/automations/worker-status";
import { emailDripChecks } from "./email-drip-checks";
import { FORM_CHECKS } from "./form-checks";
import { DEPLOY_CHECKS } from "./deploy-checks";
import { CALENDAR_CHECKS } from "./calendar-checks";
import { WORKER_REPORTER_CHECKS } from "./worker-reporter-checks";
import { DASHBOARD_EMAIL_CHECKS } from "./dashboard-email-checks";
import { DEPARTMENT_CHAT_CHECKS } from "./department-chat-checks";
import { healthAlertStateKey } from "./alert-state-key";
import { isRetiredTenant } from "@/lib/tenant/retired";

import { computeCoverage } from "./coverage";
import { incidentWindow } from "./incident-window";

/**
 * Every check this run evaluates.
 *
 * Built PER RUN rather than once at module load: the email-drip thresholds are
 * read from env at call time so the six-week ramp can move without a deploy,
 * and a list captured at process start would keep grading against a stale
 * target while reporting green.
 */
export function allChecks() {
  return [...tenantOutcomeChecks(), ...OASIS_GLOBAL_CHECKS, ...DEPARTMENT_CHAT_CHECKS];
}
export { DEPARTMENT_CHAT_CHECKS };

/**
 * OASIS-global infrastructure checks, persisted under the OASIS tenant and
 * paged to CC's lane: the shared calendar, worker status, and the cloud-owned
 * dashboard email queue. Calendar stays FIRST because its probe owns a
 * wall-clock budget the route depends on.
 */
export const OASIS_GLOBAL_CHECKS: DripCheck[] = [
  ...CALENDAR_CHECKS,
  ...WORKER_REPORTER_CHECKS,
  ...DASHBOARD_EMAIL_CHECKS.map((check) => ({ ...check, lane: "operator" as const })),
];

/** Tenant-scoped merchant/delivery checks; excludes OASIS-global infrastructure. */
export function tenantOutcomeChecks(): DripCheck[] {
  return [...DRIP_CHECKS, ...emailDripChecks(), ...FORM_CHECKS, ...DEPLOY_CHECKS];
}

/**
 * Checks that grade the whole estate and ignore the tenant they run under:
 * whether production serves main, whether pages reach their lanes (it reads
 * every `alerting.telegram_delivery` row), and the estate-wide form
 * dead-letter table.
 *
 * They rode SunBiz's tenant run until SunBiz was retired on 2026-09-28, and
 * now persist under the OASIS tenant. Retiring a client must never silence a
 * platform check, and a platform check must never keep writing rows for a
 * client that is gone.
 */
// A global opt-out has no workspace either (optouts.global_web_filings_hourly).
const ESTATE_WIDE_FORM_CHECK_IDS: ReadonlySet<string> = new Set(["forms.submit_failures_open", "optouts.global_web_filings_hourly"]);
export const ESTATE_WIDE_CHECKS: DripCheck[] = [
  ...DEPLOY_CHECKS,
  ...FORM_CHECKS.filter((c) => ESTATE_WIDE_FORM_CHECK_IDS.has(c.id)),
];


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
function lanesFor(check: { lane?: TelegramLane | TelegramLane[] }): TelegramLane[] {
  if (Array.isArray(check.lane)) return check.lane;
  return [check.lane ?? "sunbiz-ops"];
}

/**
 * Lanes still owed a RECOVERED message, parked in `last_signature`.
 *
 * A failure alert can afford to lose a lane: the ladder re-sends it, and
 * `alerting.telegram_delivery` catches a channel that is dead outright. A
 * recovery cannot. Clearing `first_failed_at` is terminal — there is no second
 * chance — so a lane that rejects the one recovery message keeps its red alert
 * until a human notices, which is the whole failure mode this file exists to
 * prevent.
 *
 * Retrying the message wholesale would be worse: a lane that is dead for days
 * (2026-08-07: @KnutRPEbot kicked from the sunbiz-ops group) would re-tell the
 * REACHABLE audience "RECOVERED" every 15 minutes. So only the lanes that did
 * not accept are carried forward, and only they are retried.
 *
 * `last_signature` is the carrier because it is dead space during an ok run —
 * it only means anything while a failure is active. A real signature can never
 * collide with this marker, so a NEW failure arriving mid-retry reads as a new
 * signature and alerts immediately, which is exactly right.
 */
const RECOVERY_PENDING = "recovery-pending:";

export function pendingRecoveryLanes(signature: string | null | undefined): TelegramLane[] | null {
  if (!signature || !signature.startsWith(RECOVERY_PENDING)) return null;
  const lanes = signature
    .slice(RECOVERY_PENDING.length)
    .split(",")
    .filter(Boolean) as TelegramLane[];
  return lanes.length ? lanes : null;
}

/**
 * FAILURE CONFIRMATION. A check that fails ONCE opens its
 * episode quietly: last_signature = UNCONFIRMED + signature, no message. The
 * next run, 15 minutes later, either confirms it (still failing: alert now) or
 * closes it with no message (ok: nothing was said, so nothing "recovered").
 *
 * On 2026-11-06 the shared calendar check failed at 13:45Z and passed at
 * 14:00Z, and CC got 🔴 FAILING and 🟢 RECOVERED for a blip he could not and
 * did not need to act on. CC: "a lot of major issues with repetitive messages."
 *
 * Two consecutive failures or three failures in six observations confirm the
 * episode. Two real successful observations are required to close it.
 */
const UNCONFIRMED = "unconfirmed:";

export function isUnconfirmed(signature: string | null | undefined): boolean {
  return Boolean(signature && signature.startsWith(UNCONFIRMED));
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

/**
 * Plain-English second line for a RECOVERED Telegram notice.
 *
 * `evaluate()` sets `reason: "none observed"` on every `must_be_zero` check
 * that does not use `observeDetailed`, so Telegram previously received
 * `🟢 RECOVERED — fleet.worker_status_reporter\nnone observed`. Checks with an
 * `observed === 0` branch in `describe()` (worker-reporter, calendar, deploy)
 * already have a human recovery sentence; count-based checks whose `describe()`
 * templates `"${r.observed} ... did NOT arrive"` start with `"0 "` and get a
 * clean all-clear line instead.
 */
export function recoveryDetail(check: Pick<DripCheck, "describe">, result: CheckResult): string {
  if (result.reason !== "none observed") return result.reason;
  const described = check.describe(result).trim();
  if (described && !/^0\b/.test(described)) return described;
  return "Back to normal (0 issues observed).";
}

export type RunSummary = {
  ran: number;
  results: CheckResult[];
  alerted: string[];
  recovered: string[];
  worst: string;
  failedAlerts: number;
};

/**
 * Run every drip check for a tenant, persist, and alert on anything not ok.
 *
 * `notify:false` runs the checks and records them without sending, which is how
 * the daily digest and any manual invocation avoid double-paging.
 */
export async function runHealthChecks(
  tenantId: string,
  opts: {
    nowMs?: number;
    notify?: boolean;
    checks?: readonly DripCheck[];
    /** Test seam for exercising the real state machine without production data. */
    db?: Db;
    /** Test seam for proving delivery decisions without sending Telegram messages. */
    sendTelegramImpl?: typeof sendTelegram;
  } = {},
): Promise<RunSummary> {
  // A retired tenant has no outcomes left to grade, and every row this writes
  // (health_check_runs, health_alert_state) lands in tables that are being
  // exported and deleted. Nothing is checked, persisted or paged.
  if (isRetiredTenant(tenantId)) {
    return { ran: 0, results: [], alerted: [], recovered: [], worst: worstVerdict([]), failedAlerts: 0 };
  }
  const db = opts.db ?? getServiceSupabase();
  const send = opts.sendTelegramImpl ?? sendTelegram;
  const nowMs = opts.nowMs ?? Date.now();
  const notify = opts.notify !== false;
  const results: CheckResult[] = [];
  const alerted: string[] = [];
  const recovered: string[] = [];
  let telegramFailures = 0;

  const checks = opts.checks ? [...opts.checks] : allChecks();
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
    const persisted = await db.from("health_check_runs").insert({
      tenant_id: tenantId,
      check_id: result.id,
      surface: "oasis",
      verdict: result.verdict,
      observed: Number.isFinite(result.observed) ? result.observed : null,
      baseline: result.baseline,
      reason: result.reason.slice(0, 500),
      ran_at: new Date(nowMs).toISOString(),
    });
    if (persisted.error) throw new Error("health_observation_write_failed");

    if (!notify) continue;

    // `alert_key` is globally unique in the deployed schema. Qualifying it as
    // well as filtering by tenant keeps two workspaces running the same check
    // on independent decay/recovery ladders.
    const key = healthAlertStateKey(tenantId, result.id);
    const stateRow = await db
      .from("health_alert_state")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("alert_key", key)
      .maybeSingle();
    const state = stateRow.data as
      | { last_signature: string | null; last_alerted_at: string | null; repeat_n: number | null; first_failed_at: string | null; recent_verdicts_json?: unknown; delivery_status?: string | null; delivery_claim_token?: string | null; delivery_receipts_json?: unknown }
      | null;
    if (stateRow.error) throw new Error("health_incident_state_read_failed");
    // Intentional offline is not an observation of recovery. Do not add it to
    // the success window, otherwise one live success would close the episode.
    if (result.id === "fleet.worker_status_reporter" && result.reason === WORKER_REPORTER_OFFLINE_REASON) continue;
    const window = incidentWindow(state?.recent_verdicts_json, result.verdict, Boolean(state?.first_failed_at));
    const observationState = { recent_verdicts_json: window.serialized };
    const observed = await db.from("health_alert_state").upsert({
      alert_key: key, tenant_id: tenantId,
      ...observationState, updated_at: new Date(nowMs).toISOString(),
    }, { onConflict: "alert_key" });
    if (observed.error) throw new Error("health_incident_state_write_failed");
    let claimToken = state?.delivery_claim_token ?? null;
    const writeState = async (values: Record<string, unknown>): Promise<boolean> => {
      let mutation = db.from("health_alert_state").update(values).eq("tenant_id", tenantId).eq("alert_key", key);
      mutation = claimToken === null ? mutation.is("delivery_claim_token", null) : mutation.eq("delivery_claim_token", claimToken);
      const written = await mutation.select("alert_key");
      if (written.error) throw new Error("health_incident_state_write_failed");
      return written.data?.length === 1;
    };
    const claimDelivery = async (): Promise<boolean> => {
      const token = crypto.randomUUID();
      if (!await writeState({ delivery_status: "dispatching", delivery_claim_token: token, delivery_updated_at: new Date(nowMs).toISOString() })) return false;
      claimToken = token;
      return true;
    };
    let receipts: Record<string, { phase: string; providerMessageId: number }> = {};
    try {
      const raw = state?.delivery_receipts_json;
      const saved = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
      if (saved && typeof saved === "object" && !Array.isArray(saved)) receipts = saved;
    } catch { /* prior version had no provider receipts */ }
    // A killed send or ambiguous acknowledgment requires reconciliation.
    // Neither a fresh check nor a recovery is permission to replay that effect.
    if (["dispatching", "unknown"].includes(state?.delivery_status ?? "")) {
      telegramFailures++;
      continue;
    }

    if (result.verdict === "ok") {
      // A PC being off makes its local reporter not applicable; it does not
      // prove an earlier reporting outage recovered. Keep that episode open
      // until the same paired computer comes back with a healthy report.
      if (state?.first_failed_at && !window.recovered) continue;
      // Failed once, never confirmed, never told: close the episode silently.
      if (state?.first_failed_at && isUnconfirmed(state.last_signature)) {
        await writeState({
          alert_key: key, tenant_id: tenantId,
          ...observationState,
          last_signature: null, last_alerted_at: state.last_alerted_at, repeat_n: 0,
          first_failed_at: null, delivery_status: "none", updated_at: new Date(nowMs).toISOString(),
        });
        continue;
      }
      // Announce recovery once, then clear the episode so the next failure
      // starts a fresh ladder rather than inheriting a 24h window.
      if (state?.first_failed_at) {
        recovered.push(result.id);
        // Recovery is announced to every lane that was told about the failure.
        // Telling one team it is fixed while the other is still watching a red
        // alert is how a resolved incident stays open.
        //
        // On a retry run, only the lanes that did not accept it last time.
        const currentLanes = lanesFor(check);
        // A saved retry is not permission to contact an audience removed since
        // the original alert. Do not re-page audiences that already accepted it.
        const owed = (pendingRecoveryLanes(state.last_signature) ?? currentLanes).filter(lane => currentLanes.includes(lane));
        const stillOwed: TelegramLane[] = [];
        let unknownReceipt = false;
        const recoveryLine = recoveryDetail(check, result);
        if (!await claimDelivery()) continue;
        for (const lane of owed) {
          const r: TelegramDelivery = await send(
            `🟢 <b>RECOVERED</b> — ${esc(result.id)}\n${esc(recoveryLine)}`,
            { lane },
          ).catch(() => ({ ok: false, delivery: "unknown" as const }));
          if (!r.ok) stillOwed.push(lane);
          if (!r.ok && r.delivery !== "rejected") unknownReceipt = true;
          if (r.ok && r.providerMessageId) receipts[lane] = { phase: "recovery", providerMessageId: r.providerMessageId };
        }
        // The episode stays OPEN while a lane is still owed the news, so the
        // next run retries it. Closing it here would strand that lane's
        // operators on a red alert with nothing left to resolve it.
        if (!await writeState({
          alert_key: key, tenant_id: tenantId,
          ...observationState,
          delivery_status: unknownReceipt ? "unknown" : stillOwed.length ? "rejected" : "delivered",
          delivery_updated_at: new Date(nowMs).toISOString(), delivery_receipts_json: JSON.stringify(receipts),
          last_signature: stillOwed.length ? `${RECOVERY_PENDING}${stillOwed.join(",")}` : null,
          last_alerted_at: state.last_alerted_at, repeat_n: 0,
          first_failed_at: stillOwed.length ? state.first_failed_at : null,
          updated_at: new Date(nowMs).toISOString(),
        })) throw new Error("health_recovery_claim_lost");

        if (stillOwed.length) {
          // Same principle as an undeliverable alert: record it in the
          // DATABASE, on a path that does not depend on the channel that just
          // failed. `alerting.telegram_delivery` is itself a check, so a lane
          // that stays dead becomes an alert of its own rather than silence.
          console.error("[health] telegram recovery delivery failed", {
            check: result.id, lanes: stillOwed,
          });
          telegramFailures += 1;
          await db.from("health_check_runs").insert({
            tenant_id: tenantId,
            check_id: "alerting.telegram_delivery",
            surface: "oasis",
            verdict: "failing",
            observed: 0,
            baseline: 1,
            reason: `could not deliver the ${result.id} recovery to ${stillOwed.join(", ")}`.slice(0, 500),
            ran_at: new Date(nowMs).toISOString(),
          }).then(() => undefined, () => undefined);
        }
      }
      continue;
    }

    const signature = alertSignature(result.id, result.verdict);
    // Two-strike: a failure with no open episode is recorded, not sent. The
    // next run confirms it or closes it silently (see UNCONFIRMED).
    if (!state?.first_failed_at && !window.confirm) {
      await writeState({
        alert_key: key, tenant_id: tenantId,
        ...observationState,
        last_signature: `${UNCONFIRMED}${signature}`,
        last_alerted_at: state?.last_alerted_at ?? null,
        repeat_n: 0,
        first_failed_at: new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
      });
      continue;
    }
    if (isUnconfirmed(state?.last_signature) && !window.confirm) continue;
    // A confirmed episode alerts as a first alert; after that, the decay ladder.
    const confirming = !state?.first_failed_at || isUnconfirmed(state.last_signature);
    const decision = shouldAlert(
      signature,
      confirming
        ? { lastSignature: null, lastAlertedAt: null, repeatN: 0 }
        : { lastSignature: state!.last_signature, lastAlertedAt: state!.last_alerted_at, repeatN: state!.repeat_n },
      new Date(nowMs),
    );
    if (!decision.send) continue;

    const body =
      `${SEV_ICON[result.verdict]} <b>${esc(result.verdict.toUpperCase())}</b> — ${esc(result.id)}\n` +
      `${esc(check.describe(result))}\n` +
      `<i>next check in 15 min · re-alerts in ${decision.windowH}h if still bad</i>`;
    // Delivery counts as successful if ANY lane took it. The ladder exists to
    // stop re-sending every 15 minutes; one reachable audience is enough for
    // that, and the delivery self-test is what catches a dead channel.
    let sent: { ok: boolean } = { ok: false };
    const rejected: TelegramLane[] = [];
    let unknownReceipt = false;
    if (!await claimDelivery()) continue;
    for (const lane of lanesFor(check)) {
      const r: TelegramDelivery = await send(body, { lane }).catch(() => ({ ok: false, delivery: "unknown" as const }));
      if (r.ok) sent = { ok: true };
      else rejected.push(lane);
      if (!r.ok && r.delivery !== "rejected") unknownReceipt = true;
      if (r.ok && r.providerMessageId) receipts[lane] = { phase: "alert", providerMessageId: r.providerMessageId };
    }

    // Only a confirmed receipt advances suppression. Definitive refusals stay
    // retryable; unknown acknowledgment is held by its durable delivery latch.
    if (sent.ok) alerted.push(result.id);
    if (!await writeState({
      alert_key: key,
      tenant_id: tenantId,
      ...observationState,
      delivery_status: unknownReceipt ? "unknown" : rejected.length ? "rejected" : "delivered",
      delivery_updated_at: new Date(nowMs).toISOString(), delivery_receipts_json: JSON.stringify(receipts),
      last_signature: sent.ok ? signature : state?.last_signature ?? null,
      last_alerted_at: sent.ok ? new Date(nowMs).toISOString() : state?.last_alerted_at ?? null,
      repeat_n: sent.ok ? decision.nextRepeatN : state?.repeat_n ?? 0,
      first_failed_at: state?.first_failed_at ?? new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    })) throw new Error("health_alert_claim_lost");

    // RECORDED WHENEVER A LANE REFUSED, not only when EVERY lane refused.
    //
    // This used to be `if (!sent.ok)`. With one lane the two conditions were
    // the same sentence. With two they are not: the 2026-08-07 outage was
    // exactly one dead lane (@KnutRPEbot kicked from the sunbiz-ops group)
    // while the other kept working, so `sent.ok` stayed true and the dead lane
    // left no trace at all. The audience that heard nothing is the audience
    // whose silence needs recording.
    if (rejected.length) {
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
      console.error("[health] telegram delivery failed", { check: result.id, lanes: rejected });
      telegramFailures += 1;
      await db.from("health_check_runs").insert({
        tenant_id: tenantId,
        check_id: "alerting.telegram_delivery",
        surface: "oasis",
        verdict: "failing",
        observed: 0,
        baseline: 1,
        // Name the lanes that actually rejected it. This line used to read
        // "the sunbiz-ops lane" unconditionally — the same defect as the rest
        // of this branch: a lane constant standing in for a lane decision. It
        // sent whoever read the row looking at the wrong chat.
        // Name the lanes, and say whether ANYONE heard it. "one of two lanes
        // is down" and "the alert reached nobody" are different incidents with
        // different urgency, and a reader at 2am should not have to infer
        // which one this row is.
        reason: (
          sent.ok
            ? `could not deliver the ${result.id} alert to ${rejected.join(", ")} (another lane took it)`
            : `could not deliver the ${result.id} alert to ${rejected.join(", ")} — NO lane took it`
        ).slice(0, 500),
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

  return { ran: results.length, results, alerted, recovered, worst: worstVerdict(results), failedAlerts: telegramFailures };
}

/**
 * What exists but is not checked.
 *
 * The 2026-08-06 incident was caused by a hand-maintained watch list, not by a
 * missing check. So the gap itself is monitored: crons come from config/cron-registry.json,
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
        `\n<i>${cov.crons.length} cron routes discovered from config/cron-registry.json</i>`,
      { lane: "sunbiz-ops" },
    ).catch(() => undefined);
  }
  return { uncovered: cov.uncovered, crons: cov.crons.length };
}
