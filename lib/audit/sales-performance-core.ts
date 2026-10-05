export type SalesLeadMetricRow = {
  data?: Record<string, unknown> | null;
};

export type SalesLeadKpis = {
  assigned: number;
  contacted: number;
  qualified: number;
  booked: number;
  won: number;
  lost: number;
  overdue: number;
};

const QUALIFIED_OR_LATER = new Set([
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
  "in_build",
  "client_review",
  "launched",
]);

const BOOKED_OR_LATER = new Set([
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
  "in_build",
  "client_review",
  "launched",
]);

const WON_OR_LATER = new Set(["won", "onboarding", "in_build", "client_review", "launched"]);
const TERMINAL = new Set(["lost", ...WON_OR_LATER]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value: unknown): number | null {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cumulative sales funnel metrics for one rep's already query-scoped lead rows.
 * Timestamps preserve conversion credit after a lead advances to a later stage.
 */
export function summarizeSalesRepLeads(
  rows: SalesLeadMetricRow[],
  nowMs: number = Date.now(),
): SalesLeadKpis {
  const out: SalesLeadKpis = {
    assigned: rows.length,
    contacted: 0,
    qualified: 0,
    booked: 0,
    won: 0,
    lost: 0,
    overdue: 0,
  };

  for (const row of rows) {
    const data = row.data && typeof row.data === "object" ? row.data : {};
    const stage = text(data.stage).toLowerCase();
    if (validDate(data.last_contacted_at) !== null) out.contacted += 1;
    if (validDate(data.qualified_at) !== null || QUALIFIED_OR_LATER.has(stage)) {
      out.qualified += 1;
    }
    if (
      validDate(data.founder_meeting_at) !== null ||
      validDate(data.founder_meeting_booked_at) !== null ||
      BOOKED_OR_LATER.has(stage)
    ) {
      out.booked += 1;
    }
    if (WON_OR_LATER.has(stage)) out.won += 1;
    if (stage === "lost") out.lost += 1;

    const followUpAt = validDate(
      data.next_action_at ?? data.next_follow_up_at ?? data.next_followup_at,
    );
    if (followUpAt !== null && followUpAt < nowMs && !TERMINAL.has(stage)) {
      out.overdue += 1;
    }
  }

  return out;
}
