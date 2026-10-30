/**
 * Database-only replacements for the Windows Daily Bravo Brief and Hourly
 * Cron Health jobs.
 *
 * Both jobs fail closed behind their own forwarding flag. Their dry mode reads
 * the same cloud truth and builds the same preview as live mode, but never
 * calls an alert, notification or recovery writer.
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
import { getTursoClient } from "@/lib/turso";
import { cronMatches } from "@/workers/oasis-cc-cron/src/cron-match";

export const MORNING_BRIEF_FORWARD_ENV = "OASIS_MORNING_BRIEF_FORWARD";
export const HOURLY_HEALTH_FORWARD_ENV = "OASIS_HOURLY_HEALTH_FORWARD";

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
};

type MorningBriefDeps = {
  collect: () => Promise<MorningBriefFacts>;
  push: (tenantId: string, text: string) => Promise<AlertPush>;
};

export async function runMorningBrief(
  dryRun: boolean,
  deps: MorningBriefDeps = {
    collect: () => collectMorningBriefFacts(),
    push: (tenantId, text) => pushWorkspaceAlert(tenantId, text),
  },
): Promise<MorningBriefRun> {
  const facts = await deps.collect();
  const preview = renderMorningBrief(facts);
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
    };
  }
  const delivery = await deps.push(OASIS_OPERATOR_TENANT_ID, preview);
  if (!delivery.delivered) {
    // A green cron row must mean the founder was reached. Throwing makes the
    // route non-2xx, so the Worker retries once and records the failed brief
    // instead of turning a missed notification into an apparent success.
    throw new Error(`morning brief was not delivered: ${delivery.outcome}`);
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

/** True after at least one scheduled occurrence has passed without a recorded run. */
export function cronFlowIsStale(flow: CronFlow, nowMs: number): boolean {
  if (!flow.last) return false; // Honest "unmeasured", not a fabricated outage.
  const lastMs = Date.parse(flow.last.at);
  if (!Number.isFinite(lastMs)) return true;
  const endMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  if (endMs <= lastMs) return false; // Exclude the tick currently being recorded.
  if (endMs - lastMs > EIGHT_DAYS_MS) return true;
  const startMs = Math.floor(lastMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
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
    .filter((flow) => flow.last?.ok && cronFlowIsStale(flow, nowMs))
    .map((flow) => flow.path);
  const unmeasured = facts.cronFlows.filter((flow) => !flow.last).map((flow) => flow.path);
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
      title: "OASIS cloud or computer health needs attention",
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
    resolvedBy: "auto: cloud crons and an OASIS computer are healthy",
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
