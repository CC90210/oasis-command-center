/**
 * ai-audit-ingest.ts — CRM ingestion for the B2B qualification funnel.
 *
 * WHAT WAS MISSING. app/api/forms/submit/route.ts already upserts the `leads`
 * row, transitions stage and fires notifications — it is a hardened path and
 * this file does not duplicate any of it. Two things it never did:
 *
 *   1. no `lead_interactions` row on submit, so the funnel answers existed only
 *      inside the form submission and never appeared on the lead's timeline;
 *   2. no score, so every inbound funnel lead sat at whatever default the row
 *      was created with and the pipeline could not rank them.
 *
 * SCHEMA NOTE, verified against the live DB rather than assumed: `leads` has
 * `score` (int) and `status` (text) — there is NO `leads.stage` column. Funnel
 * "stage" language maps onto `status`. `lead_interactions` keys off
 * (lead_id, tenant_id) and carries type/channel/direction/content/metadata.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type AiAuditAnswers = Record<string, unknown>;

/** leads.status values this funnel uses. Matches the CRM vocabulary. */
export type LeadStatus = "cold" | "warm" | "contacted" | "qualified";

// ── Scoring rubric ───────────────────────────────────────────────────────────
//
// Deliberately a transparent additive rubric, not a model call. Three reasons:
// it runs inside a request and must be fast and deterministic; a lead score
// that changes between identical submissions is untrustworthy; and CC has to be
// able to read WHY a lead scored 78 without asking anyone.
//
// Weights encode the actual buying signal: budget and timeline outrank revenue,
// because a $30K/mo business with money set aside and a 30-day deadline closes,
// while a $250K/mo business "just exploring" does not.

// Weights are tuned so a maximal submission totals EXACTLY 100 —
// 20 + 27 + 23 + 10 + 5 + 5 + 5 + 5. The first draft summed to 115 and relied
// on a clamp, which meant every strong lead saturated at 100 and the ranking
// lost all discrimination exactly where CC needs it most. Caught by the E2E
// run, not by the unit tests: the "parts sum to score" assertion only ran on a
// mid-tier lead, so the clamp never fired in the suite.
const REVENUE_POINTS: Record<string, number> = {
  pre_revenue: 0,
  under_10k: 3,
  "10k_50k": 10,
  "50k_250k": 16,
  "250k_plus": 20,
};

const BUDGET_POINTS: Record<string, number> = {
  none_yet: 2,
  under_2k: 7,
  "2k_5k": 15,
  "5k_15k": 22,
  "15k_plus": 27,
};

const TIMELINE_POINTS: Record<string, number> = {
  immediate: 23,
  "30_days": 17,
  quarter: 9,
  exploring: 2,
};

const GOAL_POINTS: Record<string, number> = {
  agent_fleet: 10,        // highest intent — wants the whole operation
  sales_leadgen: 8,       // revenue-adjacent, easiest ROI story
  workflow_automation: 6,
  customer_support: 6,
};

// Someone who already tried and failed is a BETTER prospect than someone who
// has never looked: the problem is proven and the naive fixes are exhausted.
const TRIED_POINTS: Record<string, number> = {
  hired: 5,
  diy: 4,
  tools: 3,
  never: 0,
};

const TEAM_POINTS: Record<string, number> = {
  solo: 0,
  "2_5": 2,
  "6_20": 4,
  "21_100": 5,
  "100_plus": 5,
};

function pts(table: Record<string, number>, value: unknown): number {
  return typeof value === "string" ? (table[value] ?? 0) : 0;
}

export type ScoreBreakdown = {
  score: number;
  status: LeadStatus;
  parts: Record<string, number>;
  reasons: string[];
};

/**
 * 0-100 qualification score. Pure — no I/O, fully unit-tested.
 */
export function scoreAiAuditLead(answers: AiAuditAnswers): ScoreBreakdown {
  const parts: Record<string, number> = {
    revenue: pts(REVENUE_POINTS, answers.monthly_revenue),
    budget: pts(BUDGET_POINTS, answers.budget),
    timeline: pts(TIMELINE_POINTS, answers.timeframe),
    goal: pts(GOAL_POINTS, answers.automation_goal),
    tried_before: pts(TRIED_POINTS, answers.tried_before),
    team: pts(TEAM_POINTS, answers.team_size),
  };

  // Engagement signals: someone who wrote out their bottleneck in their own
  // words, or asked for a call outright, is self-selecting as serious.
  const detail = typeof answers.bottleneck_detail === "string" ? answers.bottleneck_detail.trim() : "";
  parts.detail = detail.length >= 40 ? 5 : detail.length > 0 ? 2 : 0;
  parts.asked_for_call = answers.wants_call === "yes" ? 5 : 0;

  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, raw));

  const reasons: string[] = [];
  if (answers.timeframe === "immediate") reasons.push("wants it fixed now");
  if (parts.budget >= 18) reasons.push("budget already allocated");
  if (parts.revenue >= 20) reasons.push("revenue supports a real engagement");
  if (answers.automation_goal === "agent_fleet") reasons.push("wants a full agent fleet");
  if (answers.tried_before === "hired") reasons.push("burned by a previous vendor — knows the cost of inaction");
  if (parts.asked_for_call) reasons.push("asked to book a call");
  if (answers.timeframe === "exploring" && parts.budget <= 2) reasons.push("no timeline and no budget — nurture, don't chase");

  // Bands, not arbitrary cutoffs: `qualified` is reserved for leads where BOTH
  // money and urgency are present, because that is the only combination worth
  // interrupting CC's day for.
  const hasMoney = parts.budget >= 18 || parts.revenue >= 20;
  const hasUrgency = parts.timeline >= 20;
  let status: LeadStatus;
  if (score >= 65 && hasMoney && hasUrgency) status = "qualified";
  else if (score >= 45) status = "warm";
  else status = "cold";

  return { score, status, parts, reasons };
}

/** One-line human summary for the interaction timeline + Telegram. */
export function summarizeAiAuditLead(answers: AiAuditAnswers, s: ScoreBreakdown): string {
  const bits = [
    typeof answers.company === "string" && answers.company ? answers.company : "unknown company",
    typeof answers.automation_goal === "string" ? answers.automation_goal.replace(/_/g, " ") : "goal unstated",
    typeof answers.monthly_revenue === "string" ? answers.monthly_revenue.replace(/_/g, "-") : "revenue unstated",
    typeof answers.timeframe === "string" ? `timeline ${answers.timeframe.replace(/_/g, " ")}` : "timeline unstated",
  ];
  return `${bits.join(" · ")} — score ${s.score}/100 (${s.status})`;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export type IngestInput = {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  answers: AiAuditAnswers;
};

export type IngestResult = {
  ok: boolean;
  score?: number;
  status?: LeadStatus;
  /** The full breakdown this call already computed. Returned so the notify
   *  step can reuse it instead of re-scoring — CC's Telegram alert must quote
   *  the SAME numbers and reasons that were written to the lead timeline, and
   *  re-deriving them is how those two drift apart. */
  breakdown?: ScoreBreakdown;
  interaction_id?: string;
  error?: string;
};

/**
 * Score the lead, stamp score+status, and write the timeline interaction.
 *
 * Soft-fails by design: this runs inside `after()` on a request that has
 * ALREADY captured the lead. Throwing here would lose nothing that matters but
 * would surface as an unhandled rejection — so failures are returned, logged,
 * and the lead survives with its default score.
 */
export async function ingestAiAuditSubmission(input: IngestInput): Promise<IngestResult> {
  const { db, tenantId, leadId, answers } = input;
  try {
    const s = scoreAiAuditLead(answers);
    const summary = summarizeAiAuditLead(answers, s);

    const upd = await db
      .from("leads")
      .update({
        score: s.score,
        status: s.status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId);
    if (upd.error) {
      console.error("[ai-audit.ingest] lead update failed:", upd.error.message);
    }

    const ins = await db
      .from("lead_interactions")
      .insert({
        lead_id: leadId,
        tenant_id: tenantId,
        type: "form_submission",
        channel: "web",
        direction: "inbound",
        subject: "AI Automation Audit — intake completed",
        content: summary,
        content_preview: summary.slice(0, 200),
        agent_source: "ai_audit_funnel",
        metadata: {
          form_slug: "ai-audit",
          score: s.score,
          score_parts: s.parts,
          status: s.status,
          reasons: s.reasons,
          answers,
        },
      })
      .select("id")
      .maybeSingle();
    if (ins.error) {
      console.error("[ai-audit.ingest] interaction insert failed:", ins.error.message);
      // Still hand back the breakdown: the timeline write failed but the score
      // is valid, and CC would rather get the alert than lose the lead too.
      return { ok: false, score: s.score, status: s.status, breakdown: s, error: ins.error.message };
    }

    return {
      ok: true,
      score: s.score,
      status: s.status,
      breakdown: s,
      interaction_id: (ins.data as { id?: string } | null)?.id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ai-audit.ingest] failed:", msg);
    return { ok: false, error: msg };
  }
}
