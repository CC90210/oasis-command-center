/**
 * Database-only cloud routes for the OASIS morning brief and the narrow
 * cloud-route + paired-computer health signal.
 *
 * Both jobs fail closed behind their own forwarding flag. Their dry mode reads
 * the same cloud truth and builds the same preview as live mode, but never
 * calls an alert, notification or recovery writer.
 *
 * Hourly health is not a replacement for the retired Windows watchdog. It has
 * no view of arbitrary host processes; VPS daemon health remains a separate
 * service-check concern in the later daemon-tier migration.
 */
import "server-only";

import type { Client } from "@libsql/client";
import {
  meetingsBetween,
  pickHotReplies,
  REPLY_ANSWER_TYPES,
  salesBuckets,
  type HotReply,
} from "@/components/os/today/model";
import { loadCronFlows, type CronFlow } from "@/lib/automations/cron-runs";
import {
  beginOperatorJobDeliveryAttempt,
  claimOperatorJobDelivery,
  completeOperatorJobDelivery,
  markOperatorJobDeliveryUnknown,
} from "@/lib/automations/operator-job-delivery";
import { operatorDateKey, operatorDayStartIso } from "@/lib/dates";
import { machineState, type MachineState } from "@/lib/devices/presence";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveAgentAlerts, writeAgentAlert } from "@/lib/notify/agent-alert";
import { pushWorkspaceAlert, type AlertPush } from "@/lib/notify/alert-route";
import { escapeTelegramHtml } from "@/lib/notify/telegram";
import { oasisBoardProgramFilter, oasisBoardStages } from "@/lib/oasis-lead-create";
import { summarizeBoardCounts } from "@/lib/oasis-board-summary-rules";
import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
import { priorityInbound } from "@/lib/queries";
import { redactAll } from "@/lib/secret-redaction";
import { getTursoClient } from "@/lib/turso";
import { cronMatches } from "@/workers/oasis-cc-cron/src/cron-match";

export const MORNING_BRIEF_FORWARD_ENV = "OASIS_MORNING_BRIEF_FORWARD";
export const HOURLY_HEALTH_FORWARD_ENV = "OASIS_HOURLY_HEALTH_FORWARD";
export const HOURLY_HEALTH_SCOPE_NOTE =
  "Scope: cloud routes and paired computers only. VPS daemon health is a separate service-check concern.";

const TRUTHY = new Set(["1", "on", "true", "yes"]);
const MINUTE_MS = 60_000;
const EIGHT_DAYS_MS = 8 * 24 * 60 * MINUTE_MS;

/** Unset, misspelled and explicit false values all keep a job off. */
export function jobForwardingEnabled(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

/** Explicit read-only mode accepted by both cron routes. */
export function requestedDryRun(url: URL): boolean {
  const dry = (url.searchParams.get("dry_run") ?? "").trim().toLowerCase();
  const mode = (url.searchParams.get("mode") ?? "").trim().toLowerCase();
  return TRUTHY.has(dry) || mode === "dry" || mode === "test";
}

function numberValue(value: unknown, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} was not a non-negative number`);
  return parsed;
}

export type MorningBriefFacts = {
  date: string;
  pipeline: {
    open: number;
    qualified: number | null;
    meetings: number | null;
    won: number | null;
    overdueFollowups: number;
    missingNextStep: number;
    missingMeetingOutcome: number;
    meetingsToday: number;
    partial: boolean;
  };
  hotReplies: Array<Pick<HotReply, "subject" | "intent">>;
  delivery: {
    activeProjects: number;
    overdueProjects: number;
    blockedTasks: number;
    openTickets: number;
    breachedTickets: number;
  };
  needsYou: { pendingApprovals: number; openAlerts: number };
};

async function collectBriefHotReplies(nowMs: number): Promise<HotReply[]> {
  const inbound = await priorityInbound(OASIS_OPERATOR_TENANT_ID, 10);
  const leads = [...new Set(inbound.map((row) => (row.lead_id || "").trim()).filter(Boolean))];
  const oldest = inbound.reduce((min, row) => Math.min(min, Date.parse(row.created_at)), Infinity);
  let outbound: Array<{ lead_id: string | null; type: string; created_at: string }> = [];
  if (leads.length > 0 && Number.isFinite(oldest)) {
    const result = await getServiceSupabase()
      .from("lead_interactions")
      .select("lead_id, type, created_at")
      .eq("tenant_id", OASIS_OPERATOR_TENANT_ID)
      .in("lead_id", leads)
      .in("type", [...REPLY_ANSWER_TYPES])
      .gte("created_at", new Date(oldest).toISOString());
    if (result.error) throw new Error(`reply answers read failed: ${result.error.message}`);
    outbound = (result.data || []) as typeof outbound;
  }
  return pickHotReplies(inbound, nowMs, outbound);
}

/**
 * Read only OASIS's tenant rows plus the native OASIS pipeline/Today readers.
 * No local snapshots, shell commands, model calls, revenue_events or
 * monthly_metrics are involved.
 */
export async function collectMorningBriefFacts(
  db: Client = getTursoClient(),
  nowMs: number = Date.now(),
): Promise<MorningBriefFacts> {
  const now = new Date(nowMs);
  const day = {
    nowMs,
    startMs: Date.parse(operatorDayStartIso(now)),
    endMs: Date.parse(operatorDayStartIso(now, 1)),
    todayKey: operatorDateKey(now),
  };

  const stages = oasisBoardStages({ teamRole: "owner", isOwner: true });
  const filter = oasisBoardProgramFilter("oasis-ai-cc");
  const [pipeline, hotReplies, counts] = await Promise.all([
    listOasisPipelineWindow({
      tenantId: OASIS_OPERATOR_TENANT_ID,
      stageKeys: stages.map((stage) => stage.key),
      salesProgram: filter.salesProgram,
      salesMotion: filter.salesMotion,
      cycle: CURRENT_OASIS_PIPELINE_CYCLE,
    }),
    collectBriefHotReplies(nowMs),
    db.batch(
      [
        {
          sql: "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND status = 'pending'",
          args: [OASIS_OPERATOR_TENANT_ID],
        },
        {
          sql: "SELECT COUNT(*) AS n FROM agent_alerts WHERE tenant_id = ? AND resolved_at IS NULL",
          args: [OASIS_OPERATOR_TENANT_ID],
        },
        {
          sql: `SELECT
                  SUM(CASE WHEN archived_at IS NULL AND stage IN ('discovery','building','review') THEN 1 ELSE 0 END) AS active,
                  SUM(CASE WHEN archived_at IS NULL AND stage IN ('discovery','building','review') AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END) AS overdue
                FROM delivery_projects WHERE tenant_id = ?`,
          args: [day.todayKey, OASIS_OPERATOR_TENANT_ID],
        },
        {
          sql: "SELECT COUNT(*) AS n FROM delivery_tasks WHERE tenant_id = ? AND status = 'blocked'",
          args: [OASIS_OPERATOR_TENANT_ID],
        },
        {
          sql: `SELECT
                  SUM(CASE WHEN status IN ('open','in_progress','waiting_on_client') THEN 1 ELSE 0 END) AS open,
                  SUM(CASE WHEN status IN ('open','in_progress','waiting_on_client') AND first_response_at IS NULL AND sla_target < ? THEN 1 ELSE 0 END) AS breached
                FROM support_tickets WHERE tenant_id = ?`,
          args: [now.toISOString(), OASIS_OPERATOR_TENANT_ID],
        },
      ],
      "read",
    ),
  ]);

  if (counts.length !== 5) throw new Error("the OASIS brief count batch was incomplete");
  const summary = summarizeBoardCounts(pipeline.stageCounts, CURRENT_OASIS_PIPELINE_CYCLE.startedAt);
  const cycleStart = Date.parse(summary.cycleStartedAt);
  const buckets = salesBuckets(pipeline.rows, nowMs, Number.isFinite(cycleStart) ? cycleStart : null);
  const meetingsToday = meetingsBetween(pipeline.rows, day.startMs, day.endMs);

  return {
    date: day.todayKey,
    pipeline: {
      open: Math.max(0, summary.onBoard - summary.won),
      qualified: summary.qualified,
      meetings: summary.meetings,
      won: summary.won,
      overdueFollowups: buckets.overdue.length + buckets.carriedOver.length,
      missingNextStep: buckets.noNextStep.length,
      missingMeetingOutcome: buckets.outcomeMissing.length,
      meetingsToday: meetingsToday.length,
      // A truncated stage can hide follow-up or meeting details. Counts then
      // remain honest floors instead of pretending the returned window is all.
      partial: pipeline.truncatedStages.length > 0,
    },
    hotReplies: hotReplies.map(({ subject, intent }) => ({ subject, intent })),
    delivery: {
      activeProjects: numberValue(counts[2].rows[0]?.active ?? 0, "active projects"),
      overdueProjects: numberValue(counts[2].rows[0]?.overdue ?? 0, "overdue projects"),
      blockedTasks: numberValue(counts[3].rows[0]?.n ?? 0, "blocked tasks"),
      openTickets: numberValue(counts[4].rows[0]?.open ?? 0, "open tickets"),
      breachedTickets: numberValue(counts[4].rows[0]?.breached ?? 0, "breached tickets"),
    },
    needsYou: {
      pendingApprovals: numberValue(counts[0].rows[0]?.n ?? 0, "pending approvals"),
      openAlerts: numberValue(counts[1].rows[0]?.n ?? 0, "open alerts"),
    },
  };
}

/** Deterministic, database-only brief text. Financial truth remains Atlas-owned. */
export function renderMorningBrief(facts: MorningBriefFacts): string {
  const q = facts.pipeline.partial ? "at least " : "";
  const board = [
    `${q}${facts.pipeline.open} open`,
    facts.pipeline.qualified === null ? null : `${facts.pipeline.qualified} qualified`,
    facts.pipeline.meetings === null ? null : `${facts.pipeline.meetings} meeting-stage`,
    facts.pipeline.won === null ? null : `${facts.pipeline.won} won`,
  ].filter((value): value is string => value !== null).join(" · ");
  const hot = facts.hotReplies.length === 0
    ? "Hot replies: none waiting"
    : `Hot replies: ${facts.hotReplies.length} waiting` + facts.hotReplies.slice(0, 3)
      .map((reply) => `\n  • ${escapeTelegramHtml(reply.subject || "No subject")} (${escapeTelegramHtml(reply.intent || "unclassified")})`)
      .join("");

  return [
    `🌅 OASIS morning brief · ${facts.date}`,
    `Pipeline: ${board}`,
    `Follow-up: ${q}${facts.pipeline.overdueFollowups} overdue · ${q}${facts.pipeline.missingNextStep} missing next step · ${q}${facts.pipeline.missingMeetingOutcome} meeting outcomes missing`,
    `Today: ${q}${facts.pipeline.meetingsToday} meetings`,
    hot,
    `Delivery: ${facts.delivery.activeProjects} active projects · ${facts.delivery.overdueProjects} overdue · ${facts.delivery.blockedTasks} blocked tasks`,
    `Support: ${facts.delivery.openTickets} open · ${facts.delivery.breachedTickets} past first-response SLA`,
    `Needs you: ${facts.needsYou.pendingApprovals} approvals · ${facts.needsYou.openAlerts} open alerts`,
  ].join("\n");
}

export type MorningBriefRun = {
  ok: true;
  mode: "dry_run" | "live";
  tenant_id: string;
  preview: string;
  facts: MorningBriefFacts;
  notification_writes: number;
  notification_sends: number;
  delivery: AlertPush | null;
  delivery_state: "not_attempted" | "delivered" | "already_delivered";
  delivery_key: string;
  idempotent: boolean;
};

type MorningBriefDeps = {
  collect: () => Promise<MorningBriefFacts>;
  push: (tenantId: string, text: string) => Promise<AlertPush>;
  db?: Client;
  now?: () => number;
  claimToken?: () => string;
  requestReview?: (input: { deliveryKey: string; detail: string }) => Promise<void>;
};

async function defaultMorningBriefReview(input: { deliveryKey: string; detail: string }): Promise<void> {
  const alert = await writeAgentAlert({
    tenantId: OASIS_OPERATOR_TENANT_ID,
    alertType: "operator_job_delivery_unknown",
    severity: "warn",
    title: "Morning brief delivery needs review",
    body: `The ${input.deliveryKey} provider attempt has no trustworthy delivery receipt. ${input.detail}`,
    subjectType: "operator_job_delivery",
    subjectId: input.deliveryKey,
    payload: { delivery_key: input.deliveryKey, status: "delivery_unknown" },
    // Never recursively page the same Telegram destination whose receipt is
    // uncertain. The durable Needs-you card plus the red cron run are the review path.
    telegram: false,
  });
  if (!alert.stored) console.error("[morning-brief] delivery review card was not stored", { deliveryKey: input.deliveryKey });
}

async function flagMorningBriefUnknown(input: {
  db: Client;
  deliveryKey: string;
  claimToken: string;
  nowMs: number;
  providerOutcome?: unknown;
  error?: unknown;
  requestReview: NonNullable<MorningBriefDeps["requestReview"]>;
  detail: string;
}): Promise<void> {
  try {
    await markOperatorJobDeliveryUnknown({
      db: input.db,
      tenantId: OASIS_OPERATOR_TENANT_ID,
      deliveryKey: input.deliveryKey,
      claimToken: input.claimToken,
      nowMs: input.nowMs,
      providerOutcome: input.providerOutcome,
      error: input.error,
    });
  } catch (error) {
    console.error("[morning-brief] delivery_unknown receipt update failed", redactAll(error instanceof Error ? error.message : String(error)));
  }
  try {
    await input.requestReview({ deliveryKey: input.deliveryKey, detail: input.detail });
  } catch (error) {
    console.error("[morning-brief] delivery_unknown review write failed", redactAll(error instanceof Error ? error.message : String(error)));
  }
}

export async function runMorningBrief(
  dryRun: boolean,
  deps: MorningBriefDeps = {
    collect: () => collectMorningBriefFacts(),
    push: (tenantId, text) => pushWorkspaceAlert(tenantId, text),
  },
): Promise<MorningBriefRun> {
  const facts = await deps.collect();
  const preview = renderMorningBrief(facts);
  const deliveryKey = `morning_brief:${facts.date}`;
  if (dryRun) {
    return {
      ok: true,
      mode: "dry_run",
      tenant_id: OASIS_OPERATOR_TENANT_ID,
      preview,
      facts,
      notification_writes: 0,
      notification_sends: 0,
      delivery: null,
      delivery_state: "not_attempted",
      delivery_key: deliveryKey,
      idempotent: false,
    };
  }

  const db = deps.db ?? getTursoClient();
  const nowMs = deps.now?.() ?? Date.now();
  const requestReview = deps.requestReview ?? defaultMorningBriefReview;
  const claim = await claimOperatorJobDelivery({
    db,
    tenantId: OASIS_OPERATOR_TENANT_ID,
    jobKey: "morning_brief",
    scheduledFor: facts.date,
    nowMs,
    claimToken: deps.claimToken?.(),
  });
  if (claim.state === "already_delivered") {
    return {
      ok: true,
      mode: "live",
      tenant_id: OASIS_OPERATOR_TENANT_ID,
      preview,
      facts,
      notification_writes: 0,
      notification_sends: 0,
      delivery: null,
      delivery_state: "already_delivered",
      delivery_key: claim.deliveryKey,
      idempotent: true,
    };
  }
  if (claim.state === "delivery_in_flight") {
    throw new Error(`morning brief delivery in flight: ${claim.deliveryKey}`);
  }
  if (claim.state === "delivery_unknown") {
    await requestReview({
      deliveryKey: claim.deliveryKey,
      detail: "The earlier attempt is terminally ambiguous and was not retried.",
    });
    throw new Error(`morning brief delivery unknown; operator review required: ${claim.deliveryKey}`);
  }

  await beginOperatorJobDeliveryAttempt({
    db,
    tenantId: OASIS_OPERATOR_TENANT_ID,
    deliveryKey: claim.deliveryKey,
    claimToken: claim.claimToken,
    nowMs,
  });

  let delivery: AlertPush;
  try {
    delivery = await deps.push(OASIS_OPERATOR_TENANT_ID, preview);
  } catch (error) {
    await flagMorningBriefUnknown({
      db,
      deliveryKey: claim.deliveryKey,
      claimToken: claim.claimToken,
      nowMs,
      error,
      requestReview,
      detail: "The provider call ended without a response, so automatic retry is blocked.",
    });
    throw new Error(`morning brief delivery unknown; operator review required: ${claim.deliveryKey}`);
  }
  if (!delivery.delivered) {
    await flagMorningBriefUnknown({
      db,
      deliveryKey: claim.deliveryKey,
      claimToken: claim.claimToken,
      nowMs,
      providerOutcome: delivery.outcome,
      error: "provider did not return a delivered receipt",
      requestReview,
      detail: `The provider did not confirm delivery (${redactAll(delivery.outcome)}); automatic retry is blocked.`,
    });
    throw new Error(`morning brief delivery unknown; operator review required: ${claim.deliveryKey}`);
  }

  let receiptStored = false;
  try {
    receiptStored = await completeOperatorJobDelivery({
      db,
      tenantId: OASIS_OPERATOR_TENANT_ID,
      deliveryKey: claim.deliveryKey,
      claimToken: claim.claimToken,
      nowMs: deps.now?.() ?? Date.now(),
      providerOutcome: delivery.outcome,
    });
  } catch (error) {
    await flagMorningBriefUnknown({
      db,
      deliveryKey: claim.deliveryKey,
      claimToken: claim.claimToken,
      nowMs: deps.now?.() ?? Date.now(),
      providerOutcome: delivery.outcome,
      error,
      requestReview,
      detail: "Telegram reported delivery, but the durable receipt could not be stored; automatic retry is blocked.",
    });
    throw new Error(`morning brief delivery unknown; operator review required: ${claim.deliveryKey}`);
  }
  if (!receiptStored) {
    await flagMorningBriefUnknown({
      db,
      deliveryKey: claim.deliveryKey,
      claimToken: claim.claimToken,
      nowMs: deps.now?.() ?? Date.now(),
      providerOutcome: delivery.outcome,
      error: "delivered receipt compare-and-swap failed",
      requestReview,
      detail: "Telegram reported delivery, but the durable receipt lost its compare-and-swap; automatic retry is blocked.",
    });
    throw new Error(`morning brief delivery unknown; operator review required: ${claim.deliveryKey}`);
  }
  return {
    ok: true,
    mode: "live",
    tenant_id: OASIS_OPERATOR_TENANT_ID,
    preview,
    facts,
    notification_writes: 0,
    notification_sends: delivery.delivered ? 1 : 0,
    delivery,
    delivery_state: "delivered",
    delivery_key: claim.deliveryKey,
    idempotent: false,
  };
}

export type ComputerHeartbeat = { label: string; lastSeenAt: string | null; state: MachineState };
export type HourlyHealthFacts = { cronFlows: CronFlow[]; computers: ComputerHeartbeat[] };

/** Cloud cron history is platform-wide by design; computer rows are strictly OASIS-scoped. */
export async function collectHourlyHealthFacts(
  db: Client = getTursoClient(),
  nowMs: number = Date.now(),
): Promise<HourlyHealthFacts> {
  const [cronFlows, computers] = await Promise.all([
    loadCronFlows(db, nowMs),
    db.execute({
      sql: "SELECT label, last_seen_at FROM bridge_pairings WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY label",
      args: [OASIS_OPERATOR_TENANT_ID],
    }),
  ]);
  if (cronFlows === null) throw new Error("cron run history could not be read");
  return {
    cronFlows,
    computers: computers.rows.map((row) => ({
      label: String(row.label || "Paired computer").slice(0, 100),
      lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
      state: machineState(row.last_seen_at === null ? null : String(row.last_seen_at), nowMs),
    })),
  };
}

/**
 * True after at least one completed scheduled occurrence has passed since the
 * last run, or since this deployed registry first observed a never-run route.
 */
export function cronFlowIsStale(flow: CronFlow, nowMs: number): boolean {
  const baseline = flow.last?.at ?? flow.observedAt;
  if (!baseline) return false; // Not deployed/observed yet: honestly unmeasured.
  const baselineMs = Date.parse(baseline);
  if (!Number.isFinite(baselineMs)) return true;
  const endMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  if (endMs <= baselineMs) return false; // Exclude the tick currently being recorded.
  if (endMs - baselineMs > EIGHT_DAYS_MS) return true;
  const startMs = Math.floor(baselineMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let at = startMs; at <= endMs; at += MINUTE_MS) {
    if (cronMatches(flow.schedule, new Date(at), flow.timeZone)) return true;
  }
  return false;
}

export type HourlyHealthVerdict = {
  ok: boolean;
  scheduled: number;
  healthy: number;
  failed: string[];
  stale: string[];
  unmeasured: string[];
  computers: ComputerHeartbeat[];
  issues: string[];
};

export function evaluateHourlyHealth(facts: HourlyHealthFacts, nowMs: number): HourlyHealthVerdict {
  const failed = facts.cronFlows.filter((flow) => flow.last && !flow.last.ok).map((flow) => flow.path);
  const stale = facts.cronFlows
    .filter((flow) => (flow.last ? flow.last.ok : flow.observedAt !== null) && cronFlowIsStale(flow, nowMs))
    .map((flow) => flow.path);
  const staleSet = new Set(stale);
  const unmeasured = facts.cronFlows.filter((flow) => !flow.last && !staleSet.has(flow.path)).map((flow) => flow.path);
  const issues = [
    ...failed.map((path) => `${path} last run failed`),
    ...stale.map((path) => `${path} missed a due run`),
  ];
  if (facts.computers.length === 0) issues.push("No OASIS computer is paired");
  else if (facts.computers.every((computer) => computer.state === "offline")) issues.push("All OASIS computers are offline");
  return {
    ok: issues.length === 0,
    scheduled: facts.cronFlows.length,
    healthy: facts.cronFlows.length - failed.length - stale.length - unmeasured.length,
    failed,
    stale,
    unmeasured,
    computers: facts.computers,
    issues,
  };
}

export function renderHourlyHealth(verdict: HourlyHealthVerdict): string {
  const computerLine = verdict.computers.length === 0
    ? "none paired"
    : verdict.computers.map((computer) => `${computer.label} ${computer.state}`).join(" · ");
  const lines = [
    `${verdict.ok ? "✅" : "⚠️"} OASIS hourly health`,
    `Cloud jobs: ${verdict.healthy}/${verdict.scheduled} healthy · ${verdict.failed.length} failed · ${verdict.stale.length} stale · ${verdict.unmeasured.length} not measured yet`,
    `Computers: ${computerLine}`,
    HOURLY_HEALTH_SCOPE_NOTE,
  ];
  // writeAgentAlert owns Telegram escaping for this text. Keeping this raw
  // avoids rendering a computer named "Mac & Mini" as "Mac &amp; Mini".
  if (verdict.issues.length) lines.push(...verdict.issues.slice(0, 8).map((issue) => `• ${issue}`));
  return lines.join("\n");
}

type HourlyHealthDeps = {
  collect: () => Promise<HourlyHealthFacts>;
  writeAlert: typeof writeAgentAlert;
  resolveAlerts: typeof resolveAgentAlerts;
};

export type HourlyHealthRun = {
  ok: boolean;
  mode: "dry_run" | "live";
  tenant_id: string;
  preview: string;
  verdict: HourlyHealthVerdict;
  notification_writes: number;
  notification_sends: number;
  recovery_writes: number;
  alert: Awaited<ReturnType<typeof writeAgentAlert>> | null;
  recovered: number;
};

export async function runHourlyHealth(
  dryRun: boolean,
  nowMs: number = Date.now(),
  deps: HourlyHealthDeps = {
    collect: () => collectHourlyHealthFacts(getTursoClient(), nowMs),
    writeAlert: writeAgentAlert,
    resolveAlerts: resolveAgentAlerts,
  },
): Promise<HourlyHealthRun> {
  const verdict = evaluateHourlyHealth(await deps.collect(), nowMs);
  const preview = renderHourlyHealth(verdict);
  const base = { ok: verdict.ok, tenant_id: OASIS_OPERATOR_TENANT_ID, preview, verdict };
  if (dryRun) {
    return {
      ...base,
      mode: "dry_run",
      notification_writes: 0,
      notification_sends: 0,
      recovery_writes: 0,
      alert: null,
      recovered: 0,
    };
  }
  if (!verdict.ok) {
    const alert = await deps.writeAlert({
      tenantId: OASIS_OPERATOR_TENANT_ID,
      alertType: "cloud_cron_and_computer_health",
      severity: "warn",
      title: "OASIS cloud-route or paired-computer health needs attention",
      body: preview,
      subjectType: "system_health",
      subjectId: "cloud-crons-and-computers",
      payload: { failed: verdict.failed, stale: verdict.stale, unmeasured: verdict.unmeasured },
      telegramOncePerOpen: true,
    });
    return {
      ...base,
      mode: "live",
      notification_writes: 1,
      notification_sends: alert.delivered ? 1 : 0,
      recovery_writes: 0,
      alert,
      recovered: 0,
    };
  }
  const recovered = await deps.resolveAlerts({
    tenantId: OASIS_OPERATOR_TENANT_ID,
    alertType: "cloud_cron_and_computer_health",
    subjectId: "cloud-crons-and-computers",
    resolvedBy: "auto: cloud routes and paired OASIS computers are healthy",
  });
  return {
    ...base,
    mode: "live",
    notification_writes: 0,
    notification_sends: 0,
    recovery_writes: recovered > 0 ? 1 : 0,
    alert: null,
    recovered,
  };
}
