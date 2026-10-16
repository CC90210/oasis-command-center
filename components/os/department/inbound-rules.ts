/**
 * components/os/department/inbound-rules.ts - the Sales tab's "Inbound leads"
 * tile and its list of new inbound leads waiting for a person, pure (no
 * database, no server-only) so the wording is unit-tested.
 *
 * The Sales board is the cold-prospecting book. Leads that arrive through the
 * oasisai.work forms live in the warm-inbound queue, which that board never
 * counts, so this is where a founder opening Sales sees them.
 */
import type { KpiTileProps } from "@/components/os/KpiTile";
import { auditAnswerLabel, bottleneckLabel, finishedFormPhrase, funnelStageLabel, leadFunnelForm } from "@/lib/forms/ai-audit-format";

/** The leads the list looks back over. */
export const INBOUND_WINDOW_DAYS = 14;
/** How many leads the Needs-you list names; the rest are one "more" line. */
export const INBOUND_LIST_SHOWN = 5;
/** How many rows "New inbound leads (14 days)" shows; the rest are one link to Warm inbound. */
export const INBOUND_RECENT_SHOWN = 10;

/** A new inbound lead nobody has picked up, as one readable line. */
export type InboundWaitingLead = { id: string; line: string };

/** One row of "New inbound leads (14 days)": who, how big, how far, and when the call is. */
export type InboundRecentLead = {
  id: string;
  name: string;
  company: string | null;
  /** "$10-50K/mo", never the option key. */
  revenue: string | null;
  /** The funnel chip ("Audit requested"); null for a lead with no funnel stage. */
  stage: string | null;
  /** The booked call in Toronto time, or "Unbooked". */
  booked: string;
  href: string;
};

/**
 * Every warm-inbound lead created in the last INBOUND_WINDOW_DAYS, newest
 * first, at any stage. `truncated` makes `total` a floor (see inboundRecent).
 */
export type InboundRecent = { total: number; leads: InboundRecentLead[]; truncated: boolean };

/** The warm-inbound queue's figures: how many, and how far along. */
export type InboundFigures = {
  total: number;
  untouched: number;
  booked: number;
  /** New inbound leads still waiting for a first touch (absent where not read). */
  waiting?: { total: number; leads: InboundWaitingLead[]; truncated: boolean };
  /** "New inbound leads (14 days)" on the Sales desk, and the Warm inbound badge (absent where not read). */
  recent?: InboundRecent;
};

/** Where the tile's action goes: the queue itself. */
export const INBOUND_QUEUE_HREF = "/pipeline?motion=inbound";

const n = (v: number) => v.toLocaleString("en-US");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * "Ada Lovelace · Acme · $10-50K/mo · audit done, unbooked - needs follow-up".
 * Option keys are turned into words ("10k_50k" never shows) and the line says
 * what the lead did, so a founder knows what to say before opening it.
 */
export function inboundLeadLine(data: Record<string, unknown>): string {
  const revenue = auditAnswerLabel("revenue", text(data.revenue_band) || text(data.monthly_revenue));
  const company = text(data.company_name) || text(data.company);
  const done = text(data.funnel_stage) === "audit_requested";
  const parts = [
    text(data.name) || "New lead",
    company,
    revenue ?? "",
    bottleneckLabel(text(data.primary_bottleneck)).slice(0, 60),
    // Which form: the finished stage is shared by every booking form (#655).
    done ? `${finishedFormPhrase(leadFunnelForm(data))}, unbooked - needs follow-up` : "started the form, did not finish",
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * The new inbound leads still waiting for a first touch, newest first: stage
 * `researched` (nobody has picked them up), not booked, created in the last
 * INBOUND_WINDOW_DAYS. `truncated` is true when the window held fewer waiting
 * rows than the stage count says exist, so the total is a floor.
 */
export function inboundWaiting(
  rows: ReadonlyArray<{ id: string; created_at: string; data: Record<string, unknown> }>,
  nowMs: number,
  stageResearchedCount: number,
): NonNullable<InboundFigures["waiting"]> {
  const since = nowMs - INBOUND_WINDOW_DAYS * 86_400_000;
  const untouched = rows.filter((r) => r.data.stage === "researched");
  const waiting = untouched
    .filter((r) => {
      if (text(r.data.funnel_stage) === "meeting_booked") return false;
      const created = Date.parse(r.created_at);
      return Number.isFinite(created) && created >= since;
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return {
    total: waiting.length,
    leads: waiting.slice(0, INBOUND_LIST_SHOWN).map((r) => ({ id: r.id, line: inboundLeadLine(r.data) })),
    truncated: stageResearchedCount > untouched.length,
  };
}

/**
 * "New inbound leads (14 days)", the list the Sales desk promised (CC
 * 2026-10-16): every warm-inbound lead created in the window, whatever stage it
 * reached, so a founder sees who came in, how big they are, how far through the
 * funnel they got and whether a call is booked. Read from the same window as
 * the tile and Needs you (listOasisPipelineWindow, sales_motion inbound_warm,
 * this workspace only).
 *
 * The window keeps the most recently UPDATED rows of each stage and lists a
 * stage in `truncatedStages` when it held more. A row it left out was updated
 * no later than the oldest row it kept, and created no later than it was
 * updated, so a truncated stage can only hide a lead from this window when its
 * oldest kept row was itself updated inside the window. Only then is `total` a
 * floor; an old, long stage (lost) does not make every count "N+".
 *
 * `formatTime` is the booked-call alert's Toronto-time formatter, passed in so
 * this file stays free of server-only imports.
 */
export function inboundRecent(
  rows: ReadonlyArray<{ id: string; created_at: string; updated_at?: string | null; data: Record<string, unknown> }>,
  nowMs: number,
  truncatedStages: readonly string[],
  formatTime: (iso: string) => string,
): InboundRecent {
  const since = nowMs - INBOUND_WINDOW_DAYS * 86_400_000;
  const recent = rows
    .filter((r) => {
      const created = Date.parse(r.created_at);
      return Number.isFinite(created) && created >= since;
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const truncated = truncatedStages.some((stage) => {
    const kept = rows.filter((r) => r.data.stage === stage).map((r) => Date.parse(r.updated_at ?? ""));
    // No readable timestamp means no proof: say "may be more" rather than guess.
    if (kept.length === 0 || kept.some((t) => !Number.isFinite(t))) return true;
    return Math.min(...kept) >= since;
  });
  return {
    total: recent.length,
    leads: recent.slice(0, INBOUND_RECENT_SHOWN).map((r) => {
      const meetingAt = text(r.data.founder_meeting_at);
      return {
        id: r.id,
        name: text(r.data.name) || "New lead",
        company: text(r.data.company_name) || text(r.data.company) || null,
        revenue: auditAnswerLabel("revenue", text(r.data.revenue_band) || text(r.data.monthly_revenue)),
        stage: funnelStageLabel(r.data.funnel_stage, leadFunnelForm(r.data)),
        booked: meetingAt ? formatTime(meetingAt) : "Unbooked",
        href: `/pipeline/${r.id}`,
      };
    }),
    truncated,
  };
}

/**
 * Null: this viewer has no warm-inbound scope, so no tile is drawn (a number
 * from a narrower scope would be a different number than the queue shows).
 */
export function inboundTiles(
  read: { ok: true; value: InboundFigures } | { ok: false } | null,
): KpiTileProps[] {
  if (read === null) return [];
  if (!read.ok) return [{ label: "Inbound leads", value: null, status: "error", hint: "Lead read failed" }];
  const { total, untouched, booked } = read.value;
  if (total === 0) {
    return [{ label: "Inbound leads", value: null, status: "no_data", emptyText: "None yet", hint: "From the website forms" }];
  }
  return [
    {
      label: "Inbound leads",
      value: n(total),
      status: "live",
      hint: `${n(untouched)} untouched · ${n(booked)} booked`,
      action: { label: "Open Warm inbound", href: INBOUND_QUEUE_HREF },
    },
  ];
}

/** One line of the Sales tab's "Needs you". Same shape as AttentionItem. */
export type InboundAttentionItem = { id: string; label: string; href: string; count: number; capped?: boolean };

/**
 * The Needs-you lines for new inbound leads: each of the first few by name (a
 * link to the lead), then one line for the rest. A failed read adds nothing
 * (the tile already says the read failed); counts are what the viewer can act
 * on, so a lead waiting counts once.
 */
export function inboundAttention(
  read: { ok: true; value: InboundFigures } | { ok: false } | null,
): InboundAttentionItem[] {
  if (read === null || !read.ok || !read.value.waiting) return [];
  const { total, leads, truncated } = read.value.waiting;
  const items: InboundAttentionItem[] = leads.map((l) => ({
    id: `inbound-${l.id}`,
    label: l.line,
    href: `/pipeline/${l.id}`,
    count: 1,
  }));
  const rest = total - leads.length;
  if (rest > 0 || truncated) {
    items.push({
      id: "inbound-more",
      // A known remainder says how many; a capped read that shows every row it read can only say "may".
      label:
        rest > 0
          ? `${n(rest)} more new inbound lead${rest === 1 ? "" : "s"} waiting in Warm inbound`
          : "There may be more new inbound leads waiting in Warm inbound",
      href: INBOUND_QUEUE_HREF,
      count: Math.max(rest, 0),
      ...(truncated ? { capped: true } : {}),
    });
  }
  return items;
}
