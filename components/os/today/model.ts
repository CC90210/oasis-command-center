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
 * UNKNOWN IS NOT ZERO. Every builder keeps three states apart: not permitted
 * (null: the block is absent), failed (Read ok:false: "Couldn't load"), and a
 * real value. A failed read never becomes 0, and a source the OS cannot see
 * says "Not connected" with a way to connect it — never $0.
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

/** Open leads whose promised next action is already in the past, oldest first. */
export function overdueFollowUps(rows: readonly LeadRow[], nowMs: number): LeadLite[] {
  const out: LeadLite[] = [];
  for (const row of rows) {
    const data = row.data || {};
    if (CLOSED_STAGES.has(leadStage(data))) continue;
    const at = Date.parse(str(data, "next_action_at"));
    if (Number.isFinite(at) && at < nowMs) out.push({ id: row.id, name: leadName(data), at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Founder meetings booked inside [startMs, endMs), earliest first. Cancelled ones are not meetings. */
export function meetingsBetween(rows: readonly LeadRow[], startMs: number, endMs: number): LeadLite[] {
  const out: LeadLite[] = [];
  for (const row of rows) {
    const data = row.data || {};
    if (str(data, "founder_meeting_status").toLowerCase().startsWith("cancel")) continue;
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
  overdue: LeadLite[];
  meetingsToday: LeadLite[];
  /**
   * The rows read were a window, not every lead (a board stage past its
   * overview limit, or more records than one read returns). Counts derived from
   * rows are then a floor, and the brief says "at least".
   */
  partial: boolean;
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
    overdue: overdueFollowUps(rows, nowMs),
    meetingsToday: meetingsBetween(rows, day.startMs, day.endMs),
    partial: total > rows.length,
  };
}

export function summarizeBoard(input: {
  rows: readonly LeadRow[];
  summary: BoardSummary;
  truncatedStages: readonly string[];
  nowMs: number;
  day: { startMs: number; endMs: number };
}): SalesSnapshot {
  return {
    source: "board",
    summary: input.summary,
    openLeads: Math.max(0, input.summary.onBoard - input.summary.won),
    overdue: overdueFollowUps(input.rows, input.nowMs),
    meetingsToday: meetingsBetween(input.rows, input.day.startMs, input.day.endMs),
    // Only an OPEN stage past its window can hide an overdue follow-up or a
    // booked meeting (MEETING_STAGES are all open); a won column past its
    // overview limit cannot.
    partial: input.truncatedStages.some((stage) => !CLOSED_STAGES.has(stage)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery: SLA and projects
// ─────────────────────────────────────────────────────────────────────────────

export type TicketLite = { id: string; number: string; title: string };

export type DeliverySnapshot = {
  openTickets: number;
  breached: TicketLite[];
  atRisk: TicketLite[];
  activeProjects: number;
  /** Active projects whose due date has passed. */
  overdueProjects: number;
  /** A list hit its read ceiling: the counts are a floor. */
  truncated: boolean;
};

const ACTIVE_PROJECT: ReadonlySet<string> = new Set(["discovery", "building", "review"]);

export function summarizeDelivery(input: {
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
  truncated: boolean;
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
    openTickets: open.length,
    breached,
    atRisk,
    activeProjects: active.length,
    overdueProjects: active.filter((p) => !!p.due_date && p.due_date < input.todayKey).length,
    truncated: input.truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: hot replies from the last day
// ─────────────────────────────────────────────────────────────────────────────

export type HotReply = { id: string; subject: string; intent: string; at: number };

const HOT_INTENTS: ReadonlySet<string> = new Set(["hot_lead", "frustrated", "billing_issue", "support_urgent"]);
const HOT_PRIORITIES: ReadonlySet<string> = new Set(["critical", "urgent"]);

/**
 * Inbound the classifier marked hot, received inside the window. The reader
 * behind this (priorityInbound) falls back to UNclassified rows when nothing is
 * flagged, so the classification is checked again here: an unread newsletter is
 * not something that needs the owner.
 */
export function pickHotReplies(
  rows: ReadonlyArray<{ id: string; subject?: string | null; created_at: string; metadata?: unknown }>,
  nowMs: number,
  windowMs = 24 * 60 * 60 * 1000,
): HotReply[] {
  const out: HotReply[] = [];
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
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
};

export type CashView =
  | { kind: "live"; cashCadCents: number; overdueCount: number; overdueLabel: string | null; unreviewed: number }
  | { kind: "not_connected" }
  | { kind: "error" };

/**
 * A ledger with no bank activity at all has a cash balance of zero because
 * nothing was ever recorded, not because the account is empty. That is "Not
 * connected", never CA$0.
 */
export function cashView(read: Read<CashSnapshot>): CashView {
  if (!read.ok) return { kind: "error" };
  const c = read.value;
  if (!c.hasCashActivity) return { kind: "not_connected" };
  return {
    kind: "live",
    cashCadCents: c.cashCadCents,
    overdueCount: c.overdueCount,
    overdueLabel: c.overdueLabel,
    unreviewed: c.unreviewed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3a. Needs you
// ─────────────────────────────────────────────────────────────────────────────

export type NeedsYouTone = "urgent" | "attention" | "info";
export type NeedsYouIcon = "follow_up" | "sla" | "reply" | "meeting" | "invoice" | "bank";

export type NeedsYouItem = {
  id: string;
  tone: NeedsYouTone;
  icon: NeedsYouIcon;
  title: string;
  detail: string | null;
  /** Shown as a pill. Null for a single-row item (one reply, one meeting). */
  count: number | null;
  href: string;
};

export type NeedsYou = {
  items: NeedsYouItem[];
  /** Sources that could not be read, named, so an empty list is never mistaken for "all clear". */
  unavailable: string[];
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
  nowMs: number;
  formatTime?: (ms: number) => string;
}): NeedsYou {
  const time = input.formatTime ?? operatorTime;
  const items: NeedsYouItem[] = [];
  const unavailable: string[] = [];

  if (input.delivery) {
    if (!input.delivery.ok) unavailable.push("support tickets");
    else {
      const d = input.delivery.value;
      if (d.breached.length > 0) {
        items.push({
          id: "sla-breached",
          tone: "urgent",
          icon: "sla",
          title: `${plural(d.breached.length, "ticket is", "tickets are")} past the first-response SLA`,
          detail: d.breached.slice(0, 2).map((t) => `${t.number} ${t.title}`).join(" · "),
          count: d.breached.length,
          href: "/tickets?sla=breached",
        });
      }
      if (d.atRisk.length > 0) {
        items.push({
          id: "sla-at-risk",
          tone: "attention",
          icon: "sla",
          title: `${plural(d.atRisk.length, "ticket is", "tickets are")} close to the first-response SLA`,
          detail: d.atRisk.slice(0, 2).map((t) => `${t.number} ${t.title}`).join(" · "),
          count: d.atRisk.length,
          href: "/tickets?sla=at_risk",
        });
      }
    }
  }

  if (input.sales) {
    if (!input.sales.ok) unavailable.push("pipeline follow-ups");
    else {
      const s = input.sales.value;
      if (s.overdue.length > 0) {
        const n = s.overdue.length;
        items.push({
          id: "follow-ups",
          tone: "urgent",
          icon: "follow_up",
          title: `${s.partial ? "At least " : ""}${plural(n, "follow-up is", "follow-ups are")} past due`,
          detail: names(s.overdue),
          count: n,
          href: "/pipeline",
        });
      }
      if (s.meetingsToday.length > 0) {
        const first = s.meetingsToday[0];
        items.push({
          id: "meetings-today",
          tone: "info",
          icon: "meeting",
          title: `${plural(s.meetingsToday.length, "meeting", "meetings")} booked today`,
          detail: `First at ${time(first.at)} with ${first.name}`,
          count: s.meetingsToday.length,
          href: "/pipeline?stage=founder_meeting_booked",
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
  return { items, unavailable };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3b. One card per department
// ─────────────────────────────────────────────────────────────────────────────

export type DeptMetric =
  | { kind: "live"; value: string; label: string }
  | { kind: "not_connected"; label: string; connectHref: string }
  | { kind: "error"; label: string }
  /** Nothing measures this yet. An em dash with the reason, never a 0. */
  | { kind: "unmeasured"; label: string };

export type DeptTone = "needs_you" | "attention" | "ok" | "quiet";

export type DeptCardModel = {
  key: DepartmentKey;
  label: string;
  href: string;
  tone: DeptTone;
  status: string;
  metric: DeptMetric;
  detail: string | null;
  /** A source this department depends on that the OS cannot see yet. */
  connection: { label: string; href: string } | null;
};

/** Where an owner connects the tools a department reads (Settings › Connections). */
export const CONNECTIONS_HREF = "/settings/connections";
/** Where Stripe is pinned for the Finances book today. */
export const FINANCE_STRIPE_HREF = "/founders/finances/settings#stripe";

export function buildDepartmentCards(input: {
  departments: ReadonlyArray<{ key: DepartmentKey; label: string; href: string }>;
  needsYou: NeedsYou;
  sales: Read<SalesSnapshot> | null;
  delivery: Read<DeliverySnapshot> | null;
  /** Distinct pieces published in 7 days; ok:true with null = the reader could not count. */
  content: Read<number | null> | null;
  goal: GoalPaceView | null;
  stripeConnected: boolean | null;
}): DeptCardModel[] {
  return input.departments.flatMap((d): DeptCardModel[] => {
    const card = departmentCard(d, input);
    return card ? [card] : [];
  });
}

function departmentCard(
  d: { key: DepartmentKey; label: string; href: string },
  input: Parameters<typeof buildDepartmentCards>[0],
): DeptCardModel | null {
  const base = { key: d.key, label: d.label, href: d.href, detail: null, connection: null };
  switch (d.key) {
    case "chief_of_staff": {
      const n = input.needsYou.items.length;
      const gaps = input.needsYou.unavailable;
      return {
        ...base,
        tone: n > 0 ? "needs_you" : gaps.length > 0 ? "attention" : "ok",
        status: n > 0 ? `${n} waiting on you` : gaps.length > 0 ? "Partly checked" : "Nothing waiting",
        metric: { kind: "live", value: String(n), label: n === 1 ? "item needs you" : "items need you" },
        detail: gaps.length > 0 ? `Couldn't check ${gaps.join(", ")}` : null,
      };
    }
    case "sales": {
      const r = input.sales;
      if (!r) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Pipeline is scoped to your own leads" } };
      if (!r.ok) return { ...base, tone: "attention", status: "Couldn't load", metric: { kind: "error", label: "Pipeline read failed" } };
      const s = r.value;
      const overdue = s.overdue.length;
      const status = overdue > 0
        ? `${s.partial ? "At least " : ""}${plural(overdue, "follow-up", "follow-ups")} past due`
        : "No follow-ups past due";
      if (s.source === "board" && s.summary) {
        return {
          ...base,
          tone: overdue > 0 ? "needs_you" : "ok",
          status,
          metric: { kind: "live", value: String(s.summary.onBoard), label: "on the board this cycle" },
          detail: `${s.summary.qualified} qualified · ${s.summary.meetings} in founder meetings · ${s.summary.won} won`,
        };
      }
      return {
        ...base,
        tone: overdue > 0 ? "needs_you" : "ok",
        status,
        metric: { kind: "live", value: floorCount(s.openLeads, s.partial), label: "open leads" },
      };
    }
    case "marketing": {
      const r = input.content;
      const connection = { label: "Meta Ads", href: CONNECTIONS_HREF };
      if (!r) return { ...base, tone: "quiet", status: "Not in your view", metric: { kind: "unmeasured", label: "Content reporting is not on your plan" }, connection };
      if (!r.ok || r.value === null) {
        return { ...base, tone: "attention", status: "Couldn't load", metric: { kind: "error", label: "Published-content read failed" }, connection };
      }
      return {
        ...base,
        tone: r.value > 0 ? "ok" : "quiet",
        status: r.value > 0 ? "Publishing" : "Nothing published this week",
        metric: { kind: "live", value: String(r.value), label: r.value === 1 ? "piece published in 7 days" : "pieces published in 7 days" },
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
      return {
        ...base,
        tone: d.breached.length > 0 ? "needs_you" : d.atRisk.length > 0 ? "attention" : "ok",
        status: d.breached.length > 0
          ? `${floorCount(d.breached.length, d.truncated)} past SLA`
          : d.atRisk.length > 0
            ? `${floorCount(d.atRisk.length, d.truncated)} close to SLA`
            : "Within SLA",
        metric: {
          kind: "live",
          value: floorCount(d.openTickets, d.truncated),
          label: d.openTickets === 1 && !d.truncated ? "open ticket" : "open tickets",
        },
        detail: `${plural(d.activeProjects, "active project", "active projects")}${d.overdueProjects > 0 ? ` · ${d.overdueProjects} past due` : ""}`,
      };
    }
    case "finance": {
      const g = input.goal;
      const connection = input.stripeConnected === false ? { label: "Stripe", href: FINANCE_STRIPE_HREF } : null;
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
    case "operations":
      // Nothing measures routine or connection health yet (plan Phase 2:
      // routine_runs, connection_health_checks). An em dash with the reason.
      return {
        ...base,
        tone: "quiet",
        status: "Not measured yet",
        metric: { kind: "unmeasured", label: "Routine and connection health checks arrive with Operations" },
      };
    default:
      // Legal / Content / Research: opt-in modules with no page yet
      // (lib/os/departments.ts), so no card either.
      return null;
  }
}
