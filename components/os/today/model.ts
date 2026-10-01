/**
 * components/os/today/model.ts — what the owner's morning brief shows, decided
 * without a database.
 *
 * The brief (components/today/FounderToday.tsx → TodayBrief) is built in three
 * steps, and this file owns the two that carry policy:
 *
 *   1. todayBriefPlan   which blocks this viewer may FETCH. A block the plan
 *                       says no to is never loaded, so it cannot ship in the
 *                       RSC payload by accident (lib/role-surfaces.ts: "may
 *                       this data be fetched", not "may it be painted").
 *   2. the loaders      (loaders.ts, server-only) run only what the plan allows
 *                       and return a Read<T>: a value, or "could not find out".
 *   3. the builders     below turn those reads into rows and cards.
 *
 * UNKNOWN IS NOT ZERO. Every builder keeps these states apart: not permitted
 * (null: the block is absent), failed (Read ok:false: "Couldn't load"), a
 * source that answered but has never held anything ("No tickets yet", "Books
 * incomplete"), and a real value. A failed read never becomes 0, a source the
 * OS cannot see says "Not connected" with a way to connect it — never $0 — and
 * an empty history is never dressed as a health verdict ("Within SLA").
 *
 * PURE: no session, no database, no next/*. tests/os-today.test.ts runs every
 * builder in bare node.
 */

import type { Persona, SurfaceCapabilities } from "@/lib/role-surfaces";
import type { DepartmentKey } from "@/lib/os/types";
import { floorCount } from "@/lib/os/count";
import type { GoalProgress } from "@/lib/goals/goal-math";
import type { BoardSummary } from "@/lib/oasis-board-summary-rules";
import { WON_STAGES } from "@/lib/oasis-board-summary-rules";
import { OPEN_TICKET_STATUSES, slaStatus } from "@/lib/delivery/rules";
import { formatOperatorDate } from "@/lib/dates";
import type { ApprovalsBlock } from "@/lib/os/approvals/rules";
import { needsAttention } from "@/lib/connections/rules";
import type { CashCoverage, CoverageAccount } from "@/lib/founders-finances/cash-coverage";
import { stripeSyncLine } from "@/lib/founders-finances/stripe-sync-status";
import { AUTOMATIONS_HREF, failedRoutinesHref, type RoutineHealth } from "@/components/os/department/routine-rules";
import { CONNECTOR_CATALOG } from "@/lib/os/connectors";
import { FOUNDER_MEETING_DURATION_MINUTES } from "@/lib/website-sales-meeting";

/** A read that can fail. `ok:false` means "could not find out", which is not zero. */
export type Read<T> = { ok: true; value: T } | { ok: false };

// ─────────────────────────────────────────────────────────────────────────────
// 1. The plan: which blocks may be fetched for this viewer
// ─────────────────────────────────────────────────────────────────────────────

export type TodayBriefPlan = {
  /** OASIS money (revenue goal, collected, Stripe MRR) — lib/goals/oasis-money. */
  money: boolean;
  /** The Finances cash snapshot. The loader additionally requires a finance owner. */
  cash: boolean;
  /** Pipeline follow-ups and counts: the /pipeline board query, or raw lead records. */
  pipeline: "board" | "records" | null;
  /** Support tickets and projects (lib/delivery). */
  delivery: boolean;
  /** The shared inbound tape (hot replies). */
  inbound: boolean;
  /** Content published in the last 7 days (the Marketing card). */
  content: boolean;
  /** The workspace's connections that need the owner (Settings › Connections is owner/admin only). */
  connections: boolean;
  /** Routine health (the Operations card and a failed-routine row): whoever the rail shows Operations to. */
  routines: boolean;
};

export function todayBriefPlan(input: {
  persona: Persona;
  capabilities: SurfaceCapabilities;
  /** isWebsiteSalesTenantSlug(tenantSlug): the workspace runs the /pipeline board. */
  websiteSalesBoard: boolean;
  /** Departments this viewer's rail shows (mayOpenOsHref over OS_DEPARTMENTS). */
  departments: ReadonlySet<DepartmentKey>;
}): TodayBriefPlan {
  const caps = input.capabilities;
  // canSeeCompanyFinancials already requires an OASIS workspace (capabilitiesFor).
  // Money is also an OWNER's block: the grandfathered `legacy` persona inherits
  // the founder money flag, and it does not get OASIS's revenue on its Today.
  const money = caps.canSeeCompanyFinancials && input.persona === "founder";
  return {
    money,
    cash: money,
    pipeline: caps.canSeeAllPipeline ? (input.websiteSalesBoard ? "board" : "records") : null,
    // The Client Success department is drawn only where lib/delivery/access.ts
    // admits the viewer; the capability is ANDed so a caller passing a wrong
    // department set still cannot open the queue.
    delivery: caps.canSeeDeliveryQueues && input.departments.has("client_success"),
    inbound: caps.canSeeInboundTape,
    content: input.departments.has("marketing"),
    // The same people lib/connections/access.ts lets manage connections: an
    // owner/admin (the founder persona) who may see system surfaces and act.
    connections: input.persona === "founder" && caps.canSeeSystemSurfaces && caps.canAct,
    routines: input.departments.has("operations"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

export function greetingFor(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** "CC" from "CC", "Adon" from "Adon Cohen". Falls back to no name at all. */
export function firstName(name: string | null | undefined): string | null {
  const first = (name || "").trim().split(/\s+/)[0] || "";
  return first && first.toLowerCase() !== "operator" ? first : null;
}

/** $1,234 — whole US dollars, the same format GoalCountdownCard prints. */
export function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v.trim() : "";
}

export function operatorTime(ms: number): string {
  return formatOperatorDate({ hour: "numeric", minute: "2-digit", hour12: true }, new Date(ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline: overdue follow-ups and today's meetings, from rows already read
// ─────────────────────────────────────────────────────────────────────────────

export type LeadRow = { id: string; data: Record<string, unknown> };
export type LeadLite = { id: string; name: string; at: number };

/** Stages where there is nothing left to follow up (won, delivery, lost, archived). */
const CLOSED_STAGES: ReadonlySet<string> = new Set([...WON_STAGES, "lost", "archived"]);

function leadName(data: Record<string, unknown>): string {
  return str(data, "company") || str(data, "name") || str(data, "email") || "Unnamed lead";
}

function leadStage(data: Record<string, unknown>): string {
  return str(data, "stage") || str(data, "status");
}

/**
 * The stage a lead sits in while a founder meeting is booked and has not been
 * held. Of the board's MEETING_STAGES (lib/oasis-board-summary-rules.ts) it is
 * the only one that promises a FUTURE meeting: demo_completed and
 * proposal_sent already record that the meeting happened.
 */
const BOOKED_MEETING_STAGE = "founder_meeting_booked";

function cancelledMeeting(data: Record<string, unknown>): boolean {
  return str(data, "founder_meeting_status").toLowerCase().startsWith("cancel");
}

/** Time to write the outcome down once a meeting has ended, before it counts as missing. */
const OUTCOME_GRACE_MS = 60 * 60 * 1000;

/**
 * When a booked meeting's outcome becomes "missing": the meeting's end (its
 * own length, audit_duration_minutes as the booking writes it, else the
 * standard founder meeting) plus an hour to close it out. Before that the
 * meeting is still running, or has just ended.
 */
function outcomeDueAt(meetingAt: number, data: Record<string, unknown>): number {
  const minutes = Number(data.audit_duration_minutes);
  const length = Number.isFinite(minutes) && minutes > 0 ? minutes : FOUNDER_MEETING_DURATION_MINUTES;
  return meetingAt + length * 60_000 + OUTCOME_GRACE_MS;
}

/**
 * What the owner has to do about the open leads, one bucket per lead.
 *
 * On 2026-09-29 Today said "15 follow-ups past due" and "2 in founder
 * meetings". All 15 dates were promises made before the revenue cycle began
 * (2026-09-23) and carried in when the leads were stamped into it; the 2
 * meetings had happened weeks earlier and were never closed out; and 42 of the
 * 57 open leads had no next step at all, which no check could flag. So:
 *
 *   outcomeMissing  booked meeting that ended over an hour ago (outcomeDueAt),
 *                   still in the booked stage: the meeting happened (or did
 *                   not) and nobody said.
 *   overdue         next step dated inside this cycle and already past.
 *   carriedOver     next step dated BEFORE the cycle began: a promise from the
 *                   last cycle, shown on its own under Review, never counted
 *                   as something waiting (isReviewItem).
 *   noNextStep      open, and no next step recorded at all (also Review).
 *
 * A booked meeting that has not reached outcomeDueAt IS the lead's next step
 * (the booking writes next_action_at = the meeting time), so a meeting still
 * ahead or still running is in no bucket: not "no next step", not "overdue".
 * Only a follow-up promised for BEFORE the meeting can still be late.
 *
 * The buckets are exclusive, in that order, so a lead is counted once: a past
 * meeting with a stale follow-up date is a missing outcome, not also a
 * follow-up. `cycleStartMs` null (a workspace with no cycle, the records
 * source) means nothing is carried over.
 */
export type SalesBuckets = {
  outcomeMissing: LeadLite[];
  overdue: LeadLite[];
  carriedOver: LeadLite[];
  noNextStep: LeadLite[];
};

export function salesBuckets(rows: readonly LeadRow[], nowMs: number, cycleStartMs: number | null): SalesBuckets {
  const out: SalesBuckets = { outcomeMissing: [], overdue: [], carriedOver: [], noNextStep: [] };
  for (const row of rows) {
    const data = row.data || {};
    const stage = leadStage(data);
    if (CLOSED_STAGES.has(stage)) continue;
    const name = leadName(data);
    const meetingAt = Date.parse(str(data, "founder_meeting_at"));
    const next = Date.parse(str(data, "next_action_at"));
    if (stage === BOOKED_MEETING_STAGE && Number.isFinite(meetingAt) && !cancelledMeeting(data)) {
      if (outcomeDueAt(meetingAt, data) < nowMs) {
        out.outcomeMissing.push({ id: row.id, name, at: meetingAt });
        continue;
      }
      // The meeting is the next step; only an earlier promise can be late.
      if (!Number.isFinite(next) || next >= meetingAt) continue;
    }
    if (!Number.isFinite(next)) {
      // Updated recently first would be a guess; oldest-created is not in the
      // row. Name order keeps the list stable between reloads.
      out.noNextStep.push({ id: row.id, name, at: 0 });
      continue;
    }
    if (next >= nowMs) continue;
    if (cycleStartMs !== null && next < cycleStartMs) out.carriedOver.push({ id: row.id, name, at: next });
    else out.overdue.push({ id: row.id, name, at: next });
  }
  const byAt = (a: LeadLite, b: LeadLite) => a.at - b.at;
  out.outcomeMissing.sort(byAt);
  out.overdue.sort(byAt);
  out.carriedOver.sort(byAt);
  out.noNextStep.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Founder meetings booked inside [startMs, endMs), earliest first. Cancelled ones are not meetings. */
export function meetingsBetween(rows: readonly LeadRow[], startMs: number, endMs: number): LeadLite[] {
  const out: LeadLite[] = [];
  for (const row of rows) {
    const data = row.data || {};
    if (cancelledMeeting(data)) continue;
    const at = Date.parse(str(data, "founder_meeting_at"));
    if (Number.isFinite(at) && at >= startMs && at < endMs) {
      out.push({ id: row.id, name: leadName(data), at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export type SalesSnapshot = {
  source: "board" | "records";
  /** The /pipeline board's own counts (board source only). */
  summary: BoardSummary | null;
  /** Open leads (records source): not won, lost or archived. */
  openLeads: number;
  /** Next step dated inside this cycle and already past (salesBuckets). */
  overdue: LeadLite[];
  /** Next step dated before this cycle began: carried over, never counted as fresh. */
  carriedOver: LeadLite[];
  /** Open leads with no next step recorded. */
  noNextStep: LeadLite[];
  /** Booked founder meetings whose time has passed with no outcome recorded. */
  outcomeMissing: LeadLite[];
  meetingsToday: LeadLite[];
  /**
   * The rows read were a window, not every lead (a board stage past its
   * overview limit, or more records than one read returns). Counts derived from
   * rows are then a floor, and the brief says "at least".
   */
  partial: boolean;
  /**
   * The source holds a lead at all: any lead record, open or closed (records
   * source), or one on this cycle's board (board source). Without one, "0 open
   * leads" and a green "No follow-ups past due" describe a pipeline nobody has
   * used yet, so the card says "No leads yet" instead of a health verdict.
   */
  hasLeads: boolean;
};

export function summarizeRecords(
  rows: readonly LeadRow[],
  total: number,
  nowMs: number,
  day: { startMs: number; endMs: number },
): SalesSnapshot {
  return {
    source: "records",
    summary: null,
    openLeads: rows.filter((r) => !CLOSED_STAGES.has(leadStage(r.data || {}))).length,
    // A workspace's own lead records have no revenue cycle: nothing is carried over.
    ...salesBuckets(rows, nowMs, null),
    meetingsToday: meetingsBetween(rows, day.startMs, day.endMs),
    partial: total > rows.length,
    hasLeads: total > 0 || rows.length > 0,
  };
}

export function summarizeBoard(input: {
  rows: readonly LeadRow[];
  summary: BoardSummary;
  truncatedStages: readonly string[];
  nowMs: number;
  day: { startMs: number; endMs: number };
}): SalesSnapshot {
  const cycleStartMs = Date.parse(input.summary.cycleStartedAt);
  return {
    source: "board",
    summary: input.summary,
    openLeads: Math.max(0, input.summary.onBoard - input.summary.won),
    ...salesBuckets(input.rows, input.nowMs, Number.isFinite(cycleStartMs) ? cycleStartMs : null),
    meetingsToday: meetingsBetween(input.rows, input.day.startMs, input.day.endMs),
    // Only an OPEN stage past its window can hide an overdue follow-up or a
    // booked meeting (MEETING_STAGES are all open); a won column past its
    // overview limit cannot.
    partial: input.truncatedStages.some((stage) => !CLOSED_STAGES.has(stage)),
    hasLeads: input.summary.onBoard > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery: SLA and projects
// ─────────────────────────────────────────────────────────────────────────────

export type TicketLite = { id: string; number: string; title: string };

export type DeliverySnapshot = {
  /**
   * Whose desk this is to the viewer (lib/delivery/access.ts DeliveryViewer
   * kind). "founder": the team that runs the desk and owes the replies.
   * "client": someone reading OASIS's desk as its client, whose requests these
   * are: a missed SLA there is OASIS's miss, not their task.
   */
  viewerKind: "founder" | "client";
  openTickets: number;
  breached: TicketLite[];
  atRisk: TicketLite[];
  activeProjects: number;
  /** Active projects whose due date has passed. */
  overdueProjects: number;
  /** The ticket read hit its ceiling: ticket counts and SLA are floors. */
  ticketsTruncated: boolean;
  /** The project read hit its ceiling: project counts are floors. */
  projectsTruncated: boolean;
  /**
   * The desk has ever held a ticket, open or closed. With none, "0 open" and
   * "Within SLA" describe a desk nobody has used yet, so the card says "No
   * tickets yet" instead of a health verdict.
   */
  ticketHistory: boolean;
};

const ACTIVE_PROJECT: ReadonlySet<string> = new Set(["discovery", "building", "review"]);

export function summarizeDelivery(input: {
  viewerKind: DeliverySnapshot["viewerKind"];
  tickets: ReadonlyArray<{
    id: string;
    ticket_number: string;
    title: string;
    status: string;
    severity: string;
    sla_target: string;
    first_response_at: string | null;
    created_at: string;
  }>;
  projects: ReadonlyArray<{ stage: string; due_date: string | null }>;
  ticketsTruncated: boolean;
  projectsTruncated: boolean;
  /** Whether any closed ticket exists; only asked when no ticket is open. */
  closedTicketsExist: boolean;
  now: Date;
  /** YYYY-MM-DD, operator time zone. */
  todayKey: string;
}): DeliverySnapshot {
  const open = input.tickets.filter((t) => (OPEN_TICKET_STATUSES as readonly string[]).includes(t.status));
  const breached: TicketLite[] = [];
  const atRisk: TicketLite[] = [];
  for (const t of open) {
    const state = slaStatus(t, input.now).state;
    const lite = { id: t.id, number: t.ticket_number, title: t.title };
    if (state === "breached") breached.push(lite);
    else if (state === "at_risk") atRisk.push(lite);
  }
  const active = input.projects.filter((p) => ACTIVE_PROJECT.has(p.stage));
  return {
    viewerKind: input.viewerKind,
    openTickets: open.length,
    breached,
    atRisk,
    activeProjects: active.length,
    overdueProjects: active.filter((p) => !!p.due_date && p.due_date < input.todayKey).length,
    ticketsTruncated: input.ticketsTruncated,
    projectsTruncated: input.projectsTruncated,
    ticketHistory: input.tickets.length > 0 || input.closedTicketsExist,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: hot replies from the last day
// ─────────────────────────────────────────────────────────────────────────────

export type HotReply = { id: string; subject: string; intent: string; at: number };

const HOT_INTENTS: ReadonlySet<string> = new Set(["hot_lead", "frustrated", "billing_issue", "support_urgent"]);
const HOT_PRIORITIES: ReadonlySet<string> = new Set(["critical", "urgent"]);

/**
 * The lead_interactions types that answer someone: a sent email, DM, LinkedIn
 * message or text, or a call made. The outbound set the lead's next-action
 * route reads (app/api/leads/[id]/next-action); a queued email has not gone out.
 */
export const REPLY_ANSWER_TYPES: readonly string[] = ["email_sent", "dm_sent", "linkedin_sent", "call_made", "sms_sent"];
const REPLY_ANSWERS: ReadonlySet<string> = new Set(REPLY_ANSWER_TYPES);

/** A touch on a lead, as the hot-reply check sees it. */
export type LeadTouch = { lead_id?: string | null; type?: string | null; created_at: string };

/**
 * Inbound the classifier marked hot, received inside the window, that nobody
 * has answered yet. The reader behind this (priorityInbound) falls back to
 * UNclassified rows when nothing is flagged, so the classification is checked
 * again here: an unread newsletter is not something that needs the owner.
 *
 * ANSWERED IS NOT WAITING. A hot reply stayed in Needs you, urgent, for its
 * whole 24 hours even after the owner wrote back. `outbound` is the touches
 * logged on the same leads (REPLY_ANSWER_TYPES): a reply with a later one on
 * its lead has been answered and drops out. A reply matched to no lead cannot
 * be checked, so it stays.
 */
export function pickHotReplies(
  rows: ReadonlyArray<{ id: string; lead_id?: string | null; subject?: string | null; created_at: string; metadata?: unknown }>,
  nowMs: number,
  outbound: readonly LeadTouch[] = [],
  windowMs = 24 * 60 * 60 * 1000,
): HotReply[] {
  const lastAnswer = new Map<string, number>();
  for (const touch of outbound) {
    const lead = (touch.lead_id || "").trim();
    const at = Date.parse(touch.created_at);
    if (!lead || !Number.isFinite(at) || !REPLY_ANSWERS.has(String(touch.type || ""))) continue;
    if (at > (lastAnswer.get(lead) ?? -Infinity)) lastAnswer.set(lead, at);
  }
  const out: HotReply[] = [];
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    const lead = (row.lead_id || "").trim();
    if (lead && (lastAnswer.get(lead) ?? -Infinity) > at) continue;
    const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
    const cls = (meta.classification && typeof meta.classification === "object"
      ? meta.classification
      : {}) as Record<string, unknown>;
    const intent = typeof cls.intent === "string" ? cls.intent.toLowerCase() : "";
    const priority = typeof cls.priority === "string" ? cls.priority.toLowerCase() : "";
    if (!HOT_INTENTS.has(intent) && !HOT_PRIORITIES.has(priority)) continue;
    out.push({ id: row.id, subject: (row.subject || "").trim() || "(no subject)", intent: intent || priority, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ─────────────────────────────────────────────────────────────────────────────
// Money: goal pace and cash
// ─────────────────────────────────────────────────────────────────────────────

/** The same labels GoalCountdownCard prints, so the two can never disagree in words. */
export const GOAL_STATUS_LABEL: Record<GoalProgress["status"], string> = {
  met: "Goal met",
  on_track: "On pace",
  behind: "Behind pace",
  missed: "Deadline passed",
  upcoming: "Not started",
};

export type GoalPaceView =
  | { kind: "no_goal" }
  | { kind: "error"; label: string }
  | {
      kind: "live";
      label: string;
      collectedCents: number;
      targetCents: number;
      periodEnd: string;
      /** 0-100, for the bar. */
      pct: number;
      /** Where the straight line to the target says today should be, 0-100. Null when not computable. */
      pacePct: number | null;
      status: GoalProgress["status"];
      statusLabel: string;
      daysLeft: number;
      dailyNeedCents: number;
      /** Plain sentences about what the figure does not include. */
      caveats: string[];
    };

/**
 * The goal as the brief shows it, from lib/goals/oasis-money's OasisMoney —
 * the one reader Today and Analytics share. No arithmetic of its own beyond
 * reading the pace line: progress and status come from computeGoalProgress.
 */
export function goalPaceView(money: {
  goal: { label: string; target_cents: number; period_end: string } | null;
  progress: GoalProgress | null;
  paceSeries: ReadonlyArray<{ collected: number | null; pace: number }>;
  stripeConnected: boolean | null;
  collected: { fx_missing_days?: string[] } | null;
}): GoalPaceView {
  if (!money.goal) return { kind: "no_goal" };
  // A goal with no progress means the collected-revenue read failed. That is
  // "we could not count", never "$0 collected".
  if (!money.progress) return { kind: "error", label: money.goal.label };
  const p = money.progress;
  const target = money.goal.target_cents;
  let pacePct: number | null = null;
  for (let i = money.paceSeries.length - 1; i >= 0; i -= 1) {
    if (money.paceSeries[i].collected !== null) {
      pacePct = target > 0 ? Math.min(100, Math.max(0, (money.paceSeries[i].pace * 100 * 100) / target)) : null;
      break;
    }
  }
  const caveats: string[] = [];
  if (money.stripeConnected === false) caveats.push("Card payments are not counted: Stripe is not connected to Finances.");
  else if (money.stripeConnected === null) caveats.push("Could not confirm the Stripe connection, so card payments may be missing.");
  const fx = money.collected?.fx_missing_days ?? [];
  if (fx.length > 0) caveats.push(`${plural(fx.length, "day has", "days have")} no exchange rate yet and ${fx.length === 1 ? "is" : "are"} not counted in USD.`);
  return {
    kind: "live",
    label: money.goal.label,
    collectedCents: p.collected_cents,
    targetCents: target,
    periodEnd: money.goal.period_end,
    pct: Math.max(0, Math.min(100, p.pct)),
    pacePct,
    status: p.status,
    statusLabel: GOAL_STATUS_LABEL[p.status],
    daysLeft: p.days_left,
    dailyNeedCents: p.daily_need_cents,
    caveats,
  };
}

/** What the Finances overview reader returned, reduced to the brief's needs. */
export type CashSnapshot = {
  cashCadCents: number;
  /** Any balance or movement on a bank/cash account in the last six months. */
  hasCashActivity: boolean;
  overdueCount: number;
  /** "CA$1,200.00 + US$300.00", or null when nothing is overdue. */
  overdueLabel: string | null;
  unreviewed: number;
  /** May cashCadCents be called a balance, and what each account holds (overview().coverage). */
  coverage: Pick<CashCoverage, "complete" | "gaps" | "bankLines"> & {
    accounts: ReadonlyArray<Pick<CoverageAccount, "name" | "covers">>;
  };
};

/** One account the cash figure is made of, and what it covers, for the caption. */
export type CashAccountLine = { name: string; covers: string };

type CashDetail = {
  overdueCount: number;
  overdueLabel: string | null;
  unreviewed: number;
  /** Any bank line was ever imported. False: "Bank lines to review" says "Bank not connected", not "None". */
  bankConnected: boolean;
  accounts: CashAccountLine[];
};

export type CashView =
  | ({ kind: "live"; cashCadCents: number } & CashDetail)
  /**
   * The books are missing part of the story of a cash account (no opening
   * balance, Stripe payouts never booked). The ledger sum is NOT cash on hand
   * and is shown only as a labelled detail, with the reasons.
   */
  | ({ kind: "incomplete"; ledgerCadCents: number; gaps: string[] } & CashDetail)
  | { kind: "not_connected" }
  | { kind: "error" };

/**
 * A ledger with no bank activity at all has a cash balance of zero because
 * nothing was ever recorded, not because the account is empty. That is "Not
 * connected", never CA$0. A ledger with activity but an incomplete story
 * (lib/founders-finances/cash-coverage.ts) is "Books incomplete", never a
 * balance: −CA$1,788.23 on 2026-09-29 was six September expenses from a
 * chequing account with no opening balance, plus Stripe money never paid out
 * in the books.
 */
export function cashView(read: Read<CashSnapshot>): CashView {
  if (!read.ok) return { kind: "error" };
  const c = read.value;
  if (!c.hasCashActivity) return { kind: "not_connected" };
  const detail: CashDetail = {
    overdueCount: c.overdueCount,
    overdueLabel: c.overdueLabel,
    unreviewed: c.unreviewed,
    bankConnected: c.coverage.bankLines > 0,
    accounts: c.coverage.accounts.map((a) => ({ name: a.name, covers: a.covers })),
  };
  if (!c.coverage.complete) {
    return { kind: "incomplete", ledgerCadCents: c.cashCadCents, gaps: [...c.coverage.gaps], ...detail };
  }
  return { kind: "live", cashCadCents: c.cashCadCents, ...detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3a. Needs you
// ─────────────────────────────────────────────────────────────────────────────

export type NeedsYouTone = "urgent" | "attention" | "info";
export type NeedsYouIcon = "follow_up" | "sla" | "reply" | "meeting" | "invoice" | "bank" | "connection" | "routine";

/** One live connection as Needs you sees it (lib/connections/store listActiveConnections, reduced). */
export type ConnectionAttention = { provider: string; label: string; status: string; detail: string | null };

export type NeedsYouItem = {
  id: string;
  tone: NeedsYouTone;
  icon: NeedsYouIcon;
  title: string;
  detail: string | null;
  /** Shown as a pill. Null for a single-row item (one reply, one meeting). */
  count: number | null;
  /** The count came from a read that hit its ceiling: the pill prints a floor. */
  capped?: boolean;
  href: string;
  /**
   * The leads this row counts (`lead:<id>`), one per unit of `count`. A lead
   * can sit in two rows at once (a follow-up past due AND a meeting booked
   * today); each row says so, and the shared total counts the lead once
   * (needsYouTotal). Absent on a row that is not about leads: its `count` is
   * its own things, which no other row counts.
   */
  subjects?: readonly string[];
};

/** A lead as a Needs-you subject: the key the shared total counts it by. */
const leadSubjects = (leads: readonly LeadLite[]): string[] => leads.map((l) => `lead:${l.id}`);

export type NeedsYou = {
  items: NeedsYouItem[];
  /** Sources that could not be read, named, so an empty list is never mistaken for "all clear". */
  unavailable: string[];
  /**
   * Approval cards waiting on this viewer (lib/os/approvals), always drawn
   * first. Absent when the approvals block was not read for this viewer; a
   * failed read is absent here and named in `unavailable`.
   */
  approvals?: ApprovalsBlock | null;
};

const TONE_ORDER: Record<NeedsYouTone, number> = { urgent: 0, attention: 1, info: 2 };

function names(list: ReadonlyArray<{ name: string }>, max = 2): string {
  const shown = list.slice(0, max).map((l) => l.name);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

export function buildNeedsYou(input: {
  sales: Read<SalesSnapshot> | null;
  delivery: Read<DeliverySnapshot> | null;
  inbound: Read<HotReply[]> | null;
  cash: Read<CashSnapshot> | null;
  /** Approvals waiting on this viewer. Null/absent = not read for this viewer. */
  approvals?: Read<ApprovalsBlock> | null;
  /** The workspace's live connections. Null/absent = not read for this viewer. */
  connections?: Read<ConnectionAttention[]> | null;
  /** The workspace's routine health. Null/absent = not read for this viewer. */
  routines?: Read<RoutineHealth> | null;
  nowMs: number;
  formatTime?: (ms: number) => string;
}): NeedsYou {
  const time = input.formatTime ?? operatorTime;
  const items: NeedsYouItem[] = [];
  const unavailable: string[] = [];

  // Approvals first: they are the one thing here only this person can unblock.
  let approvals: ApprovalsBlock | null = null;
  if (input.approvals) {
    if (!input.approvals.ok) unavailable.push("approvals");
    else approvals = input.approvals.value;
  }

  // A connection in an attention status (lib/connections/rules needsAttention)
  // stays here until it recovers; the list is read fresh, so recovery clears it.
  if (input.connections) {
    if (!input.connections.ok) unavailable.push("connection health");
    else {
      for (const c of input.connections.value) {
        if (!needsAttention(c.status)) continue;
        items.push({
          id: `connection-${c.provider}`,
          tone: c.status === "degraded" ? "attention" : "urgent",
          icon: "connection",
          title: `${c.label} connection needs attention`,
          detail: c.detail ?? "Open Settings › Connections to see what the last check found.",
          count: null,
          href: CONNECTIONS_HREF,
        });
      }
    }
  }

  if (input.delivery) {
    if (!input.delivery.ok) unavailable.push("support tickets");
    // A client reading OASIS's desk is told nothing here: a breach on their
    // own request is the vendor's miss, not their task, and it must not add
    // to their count (the rule the department tabs keep, numbers.ts).
    else if (input.delivery.value.viewerKind === "founder") {
      const d = input.delivery.value;
      if (d.breached.length > 0) {
        items.push({
          id: "sla-breached",
          tone: "urgent",
          icon: "sla",
          title: `${d.ticketsTruncated ? "At least " : ""}${plural(d.breached.length, "ticket is", "tickets are")} past the first-response SLA`,
          detail: d.breached.slice(0, 2).map((t) => `${t.number} ${t.title}`).join(" · "),
          count: d.breached.length,
          capped: d.ticketsTruncated,
          href: "/tickets?sla=breached",
        });
      }
      if (d.atRisk.length > 0) {
        items.push({
          id: "sla-at-risk",
          tone: "attention",
          icon: "sla",
          title: `${d.ticketsTruncated ? "At least " : ""}${plural(d.atRisk.length, "ticket is", "tickets are")} close to the first-response SLA`,
          detail: d.atRisk.slice(0, 2).map((t) => `${t.number} ${t.title}`).join(" · "),
          count: d.atRisk.length,
          capped: d.ticketsTruncated,
          href: "/tickets?sla=at_risk",
        });
      }
    }
  }

  if (input.routines) {
    if (!input.routines.ok) unavailable.push("routine runs");
    else if (input.routines.value.failed24h.length > 0) {
      const failed = input.routines.value.failed24h;
      // Sent where the failed rows are LISTED: the Operations panel shows the
      // workspace lane only, Automations the Empire lane (routine-rules.ts).
      const href = failedRoutinesHref(failed);
      items.push({
        id: "routines-failed",
        tone: "urgent",
        icon: "routine",
        title: `${plural(failed.length, "routine", "routines")} failed in the last 24 hours`,
        detail: `Open ${href === AUTOMATIONS_HREF ? "Automations" : "Operations"} to see which, and what the last run said`,
        count: failed.length,
        href,
      });
    }
  }

  if (input.sales) {
    if (!input.sales.ok) unavailable.push("pipeline follow-ups");
    else {
      const s = input.sales.value;
      // One row per bucket (salesBuckets), and each row names its leads
      // (`subjects`): a lead also in "booked today" is counted once in the total.
      const floor = s.partial ? "At least " : "";
      if (s.overdue.length > 0) {
        const n = s.overdue.length;
        items.push({
          id: "follow-ups",
          tone: "urgent",
          icon: "follow_up",
          title: `${floor}${plural(n, "follow-up is", "follow-ups are")} past due`,
          detail: names(s.overdue),
          count: n,
          capped: s.partial,
          href: "/pipeline",
          subjects: leadSubjects(s.overdue),
        });
      }
      if (s.outcomeMissing.length > 0) {
        const n = s.outcomeMissing.length;
        items.push({
          id: "meeting-outcomes",
          tone: "attention",
          icon: "meeting",
          title: `${floor}${plural(n, "founder meeting has", "founder meetings have")} no outcome recorded`,
          detail: `${names(s.outcomeMissing)} · the meeting time has passed`,
          count: n,
          capped: s.partial,
          href: "/pipeline?stage=founder_meeting_booked",
          subjects: leadSubjects(s.outcomeMissing),
        });
      }
      if (s.carriedOver.length > 0) {
        const n = s.carriedOver.length;
        // A promise from before the cycle began: something to look over, not
        // something waiting (isReviewItem), so it is "info" like no next step.
        items.push({
          id: "follow-ups-carried",
          tone: "info",
          icon: "follow_up",
          title: `${floor}${plural(n, "follow-up was", "follow-ups were")} due before this cycle began`,
          detail: `Carried over · ${names(s.carriedOver)}`,
          count: n,
          capped: s.partial,
          href: "/pipeline",
          subjects: leadSubjects(s.carriedOver),
        });
      }
      if (s.noNextStep.length > 0) {
        const n = s.noNextStep.length;
        items.push({
          id: "no-next-step",
          tone: "info",
          icon: "follow_up",
          title: `${floor}${plural(n, "open lead has", "open leads have")} no next step`,
          detail: names(s.noNextStep),
          count: n,
          capped: s.partial,
          href: "/pipeline",
          subjects: leadSubjects(s.noNextStep),
        });
      }
      // Today's booked meetings, less any already in the meeting-outcomes row:
      // an earlier meeting with no outcome was counted in both, so the same
      // lead added 2 to the total. The schedule still lists the whole day.
      const missing = new Set(s.outcomeMissing.map((l) => l.id));
      const booked = s.meetingsToday.filter((m) => !missing.has(m.id));
      if (booked.length > 0) {
        const first = booked[0];
        items.push({
          id: "meetings-today",
          tone: "info",
          icon: "meeting",
          title: `${plural(booked.length, "meeting", "meetings")} booked today`,
          detail: `First at ${time(first.at)} with ${first.name}`,
          count: booked.length,
          href: "/pipeline?stage=founder_meeting_booked",
          subjects: leadSubjects(booked),
        });
      }
    }
  }

  if (input.inbound) {
    if (!input.inbound.ok) unavailable.push("inbound replies");
    else {
      for (const reply of input.inbound.value.slice(0, 3)) {
        items.push({
          id: `reply-${reply.id}`,
          tone: "urgent",
          icon: "reply",
          title: reply.subject,
          detail: `${reply.intent.replace(/_/g, " ")} · received ${time(reply.at)}`,
          count: null,
          href: `/interactions/${reply.id}`,
        });
      }
    }
  }

  if (input.cash) {
    if (!input.cash.ok) unavailable.push("invoices and bank activity");
    else {
      const c = input.cash.value;
      if (c.overdueCount > 0) {
        items.push({
          id: "invoices-overdue",
          tone: "attention",
          icon: "invoice",
          title: `${plural(c.overdueCount, "invoice is", "invoices are")} overdue`,
          detail: c.overdueLabel ? `${c.overdueLabel} outstanding` : null,
          count: c.overdueCount,
          href: "/founders/finances/invoices?status=overdue",
        });
      }
      if (c.unreviewed > 0) {
        items.push({
          id: "bank-review",
          tone: "info",
          icon: "bank",
          title: `${plural(c.unreviewed, "bank transaction", "bank transactions")} to categorise`,
          detail: "Uncategorised lines are left out of the reports until reviewed",
          count: c.unreviewed,
          href: "/founders/finances/transactions?status=unreviewed",
        });
      }
    }
  }

  items.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  return { items, unavailable, ...(input.approvals ? { approvals } : {}) };
}

/**
 * The rows to look over, not things waiting on the viewer: open leads with no
 * next step, follow-ups promised before this cycle began, and today's booked
 * meetings (the schedule lists them; one that passes with no outcome comes
 * back as "meeting-outcomes", which counts). Needs you draws them under a
 * "Review" heading below the rows that need the viewer, and the count leaves
 * them out: on 2026-09-30 OASIS's Today counted 66 of them (46 leads with no
 * next step, 20 follow-ups carried over from before the 2026-09-23 cycle) as
 * things waiting on CC, so the number could never reach zero.
 *
 * Named by row, not by tone: bank lines to categorise are "info" too, and they
 * are owner work that stays in the count (the finance backlog).
 */
const REVIEW_ROW_IDS: ReadonlySet<string> = new Set(["follow-ups-carried", "no-next-step", "meetings-today"]);

export function isReviewItem(item: Pick<NeedsYouItem, "id">): boolean {
  return REVIEW_ROW_IDS.has(item.id);
}

/**
 * Everything waiting on the viewer, counted as THINGS, not rows: 15 overdue
 * follow-ups are 15, not "1 item". Approvals are added by their exact count.
 * Review rows (isReviewItem) are shown but never counted.
 *
 * THE ONE COUNT. Today's Needs you header, Today's Chief of Staff card and the
 * /team/chief-of-staff header all print this, from one NeedsYou built by
 * buildNeedsYou over the same reads (components/os/today/brief-load.ts), so
 * the three cannot answer "what needs me" differently. They did: the card
 * counted rows (1) while the tab counted SLA breaches plus routine failures
 * (0), for the same moment.
 *
 * THINGS ARE DISTINCT: a lead that is in two rows (a follow-up past due and a
 * meeting booked today; a meeting held this morning and no next step since)
 * is one thing waiting on the viewer, not two. Rows about leads name them
 * (`subjects`), and the total counts each lead once; every other row counts
 * its own things, which no other row does. The rows keep their own counts:
 * each is true of the leads it lists.
 *
 * `capped`: the total is a floor, because an item behind it came from a capped
 * read or a source could not be read at all.
 */
export function needsYouTotal(n: NeedsYou): { total: number; capped: boolean } {
  const subjects = new Set<string>();
  let own = 0;
  const counted = n.items.filter((item) => !isReviewItem(item));
  for (const item of counted) {
    if (item.subjects) for (const s of item.subjects) subjects.add(s);
    else own += item.count ?? 1;
  }
  const total = subjects.size + own + (n.approvals?.total ?? 0);
  return { total, capped: n.unavailable.length > 0 || counted.some((item) => item.capped === true) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3b. One card per department
// ─────────────────────────────────────────────────────────────────────────────

export type DeptMetric =
  | { kind: "live"; value: string; label: string }
  | { kind: "not_connected"; label: string; connectHref: string }
  | { kind: "error"; label: string }
  /** Nothing measures this yet. An em dash with the reason, never a 0. */
  | { kind: "unmeasured"; label: string }
  /**
   * The source answered and has never held anything: a desk with no ticket
   * ever, a workspace with no routine set up. Words, never a 0, because a 0
   * there reads as a verdict ("within SLA", "no failures") with nothing behind it.
   */
  | { kind: "no_data"; label: string };

export type DeptTone = "needs_you" | "attention" | "ok" | "quiet";

/**
 * The source a department's number comes from, and its state, as ONE line
 * under the card. Derived from what the card actually reads, never a fixed
 * label: the Marketing card used to print "Meta Ads · Not connected" whatever
 * was true, about an app it does not read, while the number above it came
 * from Zernio's post analytics.
 *
 *   live           the source has reported; `note` says how fresh.
 *   not_connected  a source the number needs is not connected; `href` connects it.
 *   no_data        nothing has arrived from the source yet.
 *   error          the source's state could not be read.
 */
export type DeptConnection = {
  label: string;
  state: "live" | "not_connected" | "no_data" | "error";
  note: string;
  /** The Connect link. Only a "not_connected" line carries one. */
  href: string | null;
};

export type DeptCardModel = {
  key: DepartmentKey;
  label: string;
  href: string;
  tone: DeptTone;
  status: string;
  metric: DeptMetric;
  detail: string | null;
  connection: DeptConnection | null;
};

/** Where an owner connects the tools a department reads (Settings › Connections). */
export const CONNECTIONS_HREF = "/settings/connections";
/** Where Stripe is pinned for the Finances book today. */
export const FINANCE_STRIPE_HREF = "/founders/finances/settings#stripe";

/**
 * The Finance card's Stripe line. Not pinned = "Not connected" with the way to
 * connect it. Pinned = WHEN the books last heard from Stripe ("Last synced 3
 * hours ago", "Never synced"), never a bare "Connected": on 2026-09-29 a
 * pinned account and a healthy webhook had synced nothing for five days. A
 * sync older than two days, or a read that failed, is shown as such.
 */
export function stripeConnection(
  connected: boolean | null,
  sync: { ok: true; lastSyncAt: string | null } | { ok: false } | null,
  nowMs: number,
): DeptConnection {
  if (connected === false) return { label: "Stripe", state: "not_connected", note: "Not connected", href: FINANCE_STRIPE_HREF };
  if (connected === null || !sync || !sync.ok) return { label: "Stripe", state: "error", note: "Couldn't check", href: null };
  const line = stripeSyncLine(sync.lastSyncAt, nowMs);
  return { label: "Stripe", state: line.state === "live" ? "live" : line.state === "never" ? "no_data" : "error", note: line.note, href: null };
}

/**
 * The calendars behind today's schedule (loaders.ts loadCalendarStatus):
 *
 *   personal   the viewer's own Google Calendar login (Settings › Personal).
 *   workspace  the OASIS workspace calendar a booking falls back to when its
 *              host has no Google Calendar connected (lib/integrations/
 *              google-calendar systemCalendarConfig; "configured" means its
 *              credentials are present, not that they work). Null outside
 *              OASIS: it is OASIS's identity, not the viewer's.
 */
export type CalendarStatus = {
  personal: { connected: boolean; address: string | null };
  workspace: { configured: boolean; address: string | null } | null;
};

/** What the Marketing card reads: Zernio's post analytics for this workspace (lib/queries momentumMetrics). */
export type ContentWeek = {
  /** Distinct pieces published in 7 days. Null = the post read failed. */
  published: number | null;
  /** The newest post_analytics sync for this workspace. Null = nothing has ever synced. */
  lastSyncedAt: string | null;
  /**
   * Whether this workspace has its own Zernio (formerly Late) account
   * connected: a live tenant_connections row for zernio/late, or a Late key in
   * the workspace's key store. Asked only when nothing has ever synced (posts
   * that synced already name their source); null when not asked.
   */
  zernioConnected: boolean | null;
};

/** The window the Marketing card counts published pieces over (momentumMetrics contentPublished7d). */
const CONTENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The catalog's name for the app Marketing's number comes from (lib/os/connectors.ts). */
function marketingSourceLabel(): string {
  const zernio = CONNECTOR_CATALOG.find((c) => c.slug === "zernio");
  return zernio ? `${zernio.name} post analytics` : "Post analytics";
}

/**
 * The Marketing line before any source is known to be this workspace's: no
 * vendor is named, because a tool the owner never connected reads as a broken
 * sync ("Zernio post analytics · Nothing synced yet" on every new workspace).
 */
const SOCIAL_SOURCE_LABEL = "Social posting";

/** "Sep 29, 4:16 PM" in the operator's time zone. */
export function operatorWhen(ms: number): string {
  return formatOperatorDate({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }, new Date(ms));
}

export function buildDepartmentCards(input: {
  departments: ReadonlyArray<{ key: DepartmentKey; label: string; href: string }>;
  needsYou: NeedsYou;
  sales: Read<SalesSnapshot> | null;
  delivery: Read<DeliverySnapshot> | null;
  /** What the Marketing card reads. Null = not read for this viewer. */
  content: Read<ContentWeek> | null;
  goal: GoalPaceView | null;
  stripeConnected: boolean | null;
  /**
   * When the books last heard from Stripe (lib/goals/oasis-money stripeSync).
   * Absent or ok:false while Stripe is pinned = "Couldn't check": a pin says
   * nothing about whether anything has synced.
   */
  stripeSync?: { ok: true; lastSyncAt: string | null } | { ok: false } | null;
  /** The workspace's routine health (the Operations card). Null = not read for this viewer. */
  routines: Read<RoutineHealth> | null;
  /** Now, for freshness: a Marketing sync older than its own 7-day window cannot count that week. */
  nowMs: number;
  formatWhen?: (ms: number) => string;
}): DeptCardModel[] {
  return input.departments.flatMap((d): DeptCardModel[] => {
    const card = departmentCard(d, input);
    return card ? [card] : [];
  });
}

function meetingsDetail(s: SalesSnapshot, meetings: number): string {
  const missing = s.outcomeMissing.length;
  if (missing === 0) return `${meetings} in founder meetings`;
  // outcomeMissing comes from the rows read; a windowed read makes it a floor,
  // so the rest of the meeting count cannot be derived from it.
  if (s.partial) return `${meetings} in founder meetings, at least ${missing} with no outcome`;
  return `${Math.max(0, meetings - missing)} in founder meetings · ${plural(missing, "meeting", "meetings")} with no outcome`;
}

function departmentCard(
  d: { key: DepartmentKey; label: string; href: string },
  input: Parameters<typeof buildDepartmentCards>[0],
): DeptCardModel | null {
  const base = { key: d.key, label: d.label, href: d.href, detail: null, connection: null };
  const when = input.formatWhen ?? operatorWhen;
  switch (d.key) {
    case "chief_of_staff": {
      // The same total as the Needs you header and /team/chief-of-staff.
      const { total, capped } = needsYouTotal(input.needsYou);
      const gaps = input.needsYou.unavailable;
      const detail = gaps.length > 0 ? `Couldn't check ${gaps.join(", ")}` : null;
      // Nothing found, but not every source answered: that is unknown, not 0.
      if (total === 0 && capped) {
        return { ...base, tone: "attention", status: "Partly checked", metric: { kind: "error", label: "Not every source answered" }, detail };
      }
      const shown = floorCount(total, capped);
      return {
        ...base,
        tone: total > 0 ? "needs_you" : "ok",
        status: total > 0 ? `${shown} waiting on you` : "Nothing waiting",
        metric: { kind: "live", value: shown, label: total === 1 && !capped ? "item needs you" : "items need you" },
        detail,
      };
    }
    case "sales": {
      const r = input.sales;
      if (!r) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Pipeline is scoped to your own leads" } };
      if (!r.ok) return { ...base, tone: "attention", status: "Couldn't load", metric: { kind: "error", label: "Pipeline read failed" } };
      const s = r.value;
      // A pipeline that has never held a lead has no follow-ups to be past
      // due: "No follow-ups past due" over "0 open leads" was a green verdict
      // with nothing behind it (the class #482/#496 fixed for tickets).
      if (!s.hasLeads) {
        return {
          ...base,
          tone: "quiet",
          status: "No leads yet",
          metric: {
            kind: "no_data",
            label: s.source === "board" ? "No leads are on the board this cycle yet" : "No leads have been added to this workspace yet",
          },
        };
      }
      const floor = s.partial ? "At least " : "";
      const overdue = s.overdue.length;
      const missing = s.outcomeMissing.length;
      const carried = s.carriedOver.length;
      const status =
        overdue > 0
          ? `${floor}${plural(overdue, "follow-up", "follow-ups")} past due`
          : missing > 0
            ? `${floor}${plural(missing, "meeting", "meetings")} with no outcome`
            : carried > 0
              ? `${floor}${plural(carried, "follow-up", "follow-ups")} carried over`
              : "No follow-ups past due";
      const tone: DeptTone =
        overdue > 0 || missing > 0 ? "needs_you" : carried > 0 || s.noNextStep.length > 0 ? "attention" : "ok";
      if (s.source === "board" && s.summary) {
        return {
          ...base,
          tone,
          status,
          metric: { kind: "live", value: String(s.summary.onBoard), label: "on the board this cycle" },
          detail: `${s.summary.qualified} qualified · ${meetingsDetail(s, s.summary.meetings)} · ${s.summary.won} won`,
        };
      }
      return {
        ...base,
        tone,
        status,
        metric: { kind: "live", value: floorCount(s.openLeads, s.partial), label: "open leads" },
      };
    }
    case "marketing": {
      const r = input.content;
      const label = marketingSourceLabel();
      if (!r) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Content reporting is not on your plan" } };
      if (!r.ok || r.value.published === null) {
        // Which source this workspace has is part of what could not be read,
        // so no vendor is named.
        return {
          ...base,
          tone: "attention",
          status: "Couldn't load",
          metric: { kind: "error", label: "Published-content read failed" },
          connection: { label: SOCIAL_SOURCE_LABEL, state: "error", note: "Couldn't check", href: null },
        };
      }
      const { published, lastSyncedAt, zernioConnected } = r.value;
      const syncedMs = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
      if (!Number.isFinite(syncedMs)) {
        // Nothing has ever synced. Zernio is named only for a workspace that
        // connected its own account; every other workspace is told how to
        // start, never shown a tool it has never heard of as "not syncing".
        if (zernioConnected !== true) {
          return {
            ...base,
            tone: "quiet",
            status: "Connect a social account",
            metric: { kind: "no_data", label: "No social account is connected yet" },
            connection: { label: SOCIAL_SOURCE_LABEL, state: "not_connected", note: "Not connected", href: CONNECTIONS_HREF },
          };
        }
        // Connected, and no post has synced yet: "0 published" would read as
        // "we stopped posting" about a source that has never reported.
        return {
          ...base,
          tone: "quiet",
          status: "No posts synced yet",
          metric: { kind: "no_data", label: "No published posts have synced yet" },
          connection: { label, state: "no_data", note: "Nothing synced yet", href: null },
        };
      }
      const connection: DeptConnection = { label, state: "live", note: `Last synced ${when(syncedMs)}`, href: null };
      // The last sync is older than the week being counted: every post of
      // that week could be missing, so the count is not a count. The sync runs
      // on the operator's machine, and a week with it off read as a real 0.
      if (input.nowMs - syncedMs > CONTENT_WINDOW_MS) {
        return {
          ...base,
          tone: "attention",
          status: "Sync stopped",
          metric: { kind: "error", label: "Too old to count this week's posts" },
          connection: { label, state: "error", note: `Last synced ${when(syncedMs)}: too old to count this week`, href: null },
        };
      }
      return {
        ...base,
        tone: published > 0 ? "ok" : "quiet",
        status: published > 0 ? "Publishing" : "Nothing published this week",
        metric: { kind: "live", value: String(published), label: published === 1 ? "piece published in 7 days" : "pieces published in 7 days" },
        connection,
      };
    }
    case "client_success": {
      const r = input.delivery;
      if (!r) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Support is not in your view" } };
      if (!r.ok) return { ...base, tone: "attention", status: "Couldn't load", metric: { kind: "error", label: "Support read failed" } };
      const d = r.value;
      // Breached / at-risk come from the same capped ticket read as the open
      // count, so all three are floors whenever it was capped (lib/os/count.ts).
      // "Within SLA" is a claim about EVERY open ticket; a capped read cannot
      // make it, since tickets past the ceiling may be breached (CodeRabbit
      // #469). Such a read says the check is incomplete instead.
      // Each read carries its own cap: a capped PROJECT list says nothing
      // about the tickets, and the reverse (CodeRabbit #469, second pass).
      const tCap = d.ticketsTruncated;
      const pCap = d.projectsTruncated;
      const projects = `${floorCount(d.activeProjects, pCap)} ${d.activeProjects === 1 && !pCap ? "active project" : "active projects"}`;
      const projectDetail = `${projects}${d.overdueProjects > 0 ? ` · ${floorCount(d.overdueProjects, pCap)} past due` : ""}`;
      // Someone reading OASIS's desk as its client: these are the requests
      // their team filed, and a missed first-response target is OASIS's miss,
      // not their task (the rule Needs you and the Client Success tab keep,
      // numbers.ts). Their open requests, never "past SLA".
      if (d.viewerKind === "client") {
        return {
          ...base,
          tone: "quiet",
          status: !d.ticketHistory ? "No requests yet" : d.openTickets > 0 ? "Requests open with OASIS" : "No open requests",
          metric: d.ticketHistory
            ? { kind: "live", value: floorCount(d.openTickets, tCap), label: d.openTickets === 1 && !tCap ? "open request" : "open requests" }
            : { kind: "no_data", label: "Your team has not filed a support request yet" },
          detail: projectDetail,
        };
      }
      // A desk that has never held a ticket is not "Within SLA": the claim
      // needs tickets behind it (2026-09-29: every workspace had 0 ever).
      if (!d.ticketHistory) {
        return {
          ...base,
          tone: "quiet",
          status: "No tickets yet",
          metric: { kind: "no_data", label: "The support desk has had no tickets yet" },
          detail: projectDetail,
        };
      }
      return {
        ...base,
        tone: d.breached.length > 0 ? "needs_you" : d.atRisk.length > 0 || tCap ? "attention" : "ok",
        status: d.breached.length > 0
          ? `${floorCount(d.breached.length, tCap)} past SLA`
          : d.atRisk.length > 0
            ? `${floorCount(d.atRisk.length, tCap)} close to SLA`
            : tCap
              ? "SLA not fully checked"
              : "Within SLA",
        metric: {
          kind: "live",
          value: floorCount(d.openTickets, tCap),
          label: d.openTickets === 1 && !tCap ? "open ticket" : "open tickets",
        },
        detail: projectDetail,
      };
    }
    case "finance": {
      const g = input.goal;
      const connection = stripeConnection(input.stripeConnected, input.stripeSync ?? null, input.nowMs);
      if (!g) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Company money is owner-only" } };
      if (g.kind === "error") return { ...base, tone: "attention", status: "Couldn't load", metric: { kind: "error", label: "Collected revenue read failed" }, connection };
      if (g.kind === "no_goal") return { ...base, tone: "quiet", status: "No active goal", metric: { kind: "unmeasured", label: "Set a revenue goal to track pace" }, connection };
      return {
        ...base,
        tone: g.status === "behind" || g.status === "missed" ? "attention" : "ok",
        status: g.statusLabel,
        metric: { kind: "live", value: usd(g.collectedCents), label: `collected of ${usd(g.targetCents)} by ${g.periodEnd}` },
        detail: g.daysLeft > 0 ? `${plural(g.daysLeft, "day", "days")} left` : null,
        connection,
      };
    }
    case "operations": {
      // The workspace's routines (tenant_cron_jobs) and, for OASIS, the Empire
      // scheduler's rows that carry its tenant id: the same rows and the same
      // routineHealth the Operations tab prints (components/os/department).
      const r = input.routines;
      if (!r) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Routines are the owners' view" } };
      if (!r.ok) return { ...base, tone: "attention", status: "Couldn't load", metric: { kind: "error", label: "Routine read failed" } };
      const h = r.value;
      if (h.total === 0) {
        return { ...base, tone: "quiet", status: "No routines yet", metric: { kind: "no_data", label: "No routines are set up for this workspace" } };
      }
      const failed = h.failed24h.length;
      const lastOk = h.lastSuccessAt ? Date.parse(h.lastSuccessAt) : NaN;
      return {
        ...base,
        tone: failed > 0 ? "needs_you" : h.on === 0 ? "quiet" : "ok",
        status: failed > 0 ? `${failed} failed in 24h` : h.on === 0 ? "Every routine is off" : "No failures in 24h",
        metric: { kind: "live", value: String(h.on), label: `of ${plural(h.total, "routine", "routines")} on` },
        detail: Number.isFinite(lastOk) ? `Last successful run ${when(lastOk)}` : "No successful run recorded yet",
      };
    }
    default:
      // Legal / Content / Research: opt-in modules with no page yet
      // (lib/os/departments.ts), so no card either.
      return null;
  }
}
