/**
 * lib/lenders/lender-intelligence.ts — learn which lender likes which paper.
 *
 * Supersedes feedback-bias.ts: instead of the thin (never-written) lender_feedback
 * table keyed only on industry+revenue, this reads the real outcome ledger
 * (lender_reply_outcomes) joined to the paper profile frozen at shop time
 * (deal_paper_snapshot), and scores each candidate lender on its ACTUAL approve/
 * decline behavior for paper SIMILAR to the deal in hand.
 *
 * Two exports:
 *   applyLenderIntelligenceBias — drop-in for the match-lenders ranking (same
 *     signature/shape as the old applyLenderFeedbackBias). Fail-open.
 *   getLenderIntelligence — full per-lender stats for the lender intelligence view.
 *
 * Contract: ANY DB error / empty history → return scores unmodified. The
 * recommender must never break because the tables are empty or new.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { MatchScore, ApplicationProfile, LenderWarning } from "./match-fitness";

const LOOKBACK_DAYS = 365;
const REVENUE_BAND_PCT = 0.35;
const MIN_SIMILAR_FOR_BIAS = 3;
const APPROVAL_BONUS = 12;
const DECLINE_PENALTY = 15;

type OutcomeRow = {
  lender_id: string;
  application_id: string;
  outcome: string;
  decline_reason_code: string | null;
  reply_at: string;
};
type SnapshotRow = {
  application_id: string;
  paper_grade: string | null;
  monthly_revenue: number | null;
  position_count: number | null;
  industry: string | null;
};

const isApproval = (o: string) => o === "approved" || o === "counter_offer";
const isDecline = (o: string) => o === "declined";

function positionBucket(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  if (n <= 1) return 0;
  if (n <= 3) return 1;
  return 2;
}

/** How many paper dimensions of `snap` match the current deal. */
function similarityScore(app: ApplicationProfile, snap: SnapshotRow): number {
  let matches = 0;
  let comparable = 0;
  if (app.paper_grade && snap.paper_grade) {
    comparable++;
    if (app.paper_grade.toUpperCase() === snap.paper_grade.toUpperCase()) matches++;
  }
  if (app.monthly_revenue !== undefined && snap.monthly_revenue !== null) {
    comparable++;
    const lo = app.monthly_revenue * (1 - REVENUE_BAND_PCT);
    const hi = app.monthly_revenue * (1 + REVENUE_BAND_PCT);
    if (snap.monthly_revenue >= lo && snap.monthly_revenue <= hi) matches++;
  }
  if (app.position_count !== undefined && snap.position_count !== null) {
    comparable++;
    if (positionBucket(app.position_count) === positionBucket(snap.position_count)) matches++;
  }
  if (app.industry && snap.industry) {
    comparable++;
    if (app.industry.toLowerCase() === snap.industry.toLowerCase()) matches++;
  }
  // No comparable dimensions → treat as weakly similar (1) so a lender's overall
  // history still nudges; otherwise require ≥2 matching dimensions.
  if (comparable === 0) return 1;
  return matches;
}

async function loadOutcomesWithPaper(
  tenantId: string,
  lenderIds: string[],
): Promise<{ outcomes: OutcomeRow[]; snapByApp: Map<string, SnapshotRow> }> {
  const db = getServiceSupabase();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const oR = await db
    .from("lender_reply_outcomes")
    .select("lender_id, application_id, outcome, decline_reason_code, reply_at")
    .eq("tenant_id", tenantId)
    .in("lender_id", lenderIds)
    .gte("reply_at", cutoff);
  // A query ERROR (tables missing / RLS / outage) is NOT the same as "no history
  // yet" — log the error so a broken learning loop is visible, not silently
  // mistaken for a brand-new lender with no data.
  if (oR.error) { console.error("[lender-intelligence] outcomes query failed (reverting to rules):", oR.error.message || oR.error); return { outcomes: [], snapByApp: new Map() }; }
  if (!oR.data) return { outcomes: [], snapByApp: new Map() };
  const outcomes = oR.data as OutcomeRow[];
  const appIds = [...new Set(outcomes.map((o) => o.application_id))];
  const snapByApp = new Map<string, SnapshotRow>();
  if (appIds.length) {
    const sR = await db
      .from("deal_paper_snapshot")
      .select("application_id, paper_grade, monthly_revenue, position_count, industry")
      .eq("tenant_id", tenantId)
      .in("application_id", appIds);
    for (const r of (sR.data || []) as SnapshotRow[]) {
      // Keep the latest snapshot per application (first wins; query order is fine for a proxy).
      if (!snapByApp.has(r.application_id)) snapByApp.set(r.application_id, r);
    }
  }
  return { outcomes, snapByApp };
}

/**
 * Bias match scores by each lender's learned approve/decline behavior on paper
 * SIMILAR to this deal. Drop-in replacement for applyLenderFeedbackBias.
 */
export async function applyLenderIntelligenceBias(
  scores: MatchScore[],
  application: ApplicationProfile,
  tenantId: string,
): Promise<MatchScore[]> {
  if (scores.length === 0) return scores;
  try {
    const lenderIds = scores.map((s) => s.lender_id);
    const { outcomes, snapByApp } = await loadOutcomesWithPaper(tenantId, lenderIds);
    if (outcomes.length === 0) return scores;

    return scores.map((score) => {
      const rows = outcomes.filter((o) => o.lender_id === score.lender_id);
      if (rows.length === 0) return score;

      // Similar-paper subset: snapshot present AND ≥2 matching dimensions
      // (similarityScore returns 1 only when nothing was comparable).
      const similar = rows.filter((r) => {
        const snap = snapByApp.get(r.application_id);
        if (!snap) return false;
        return similarityScore(application, snap) >= 2;
      });
      const pool = similar.length >= MIN_SIMILAR_FOR_BIAS ? similar : rows;
      const onSimilar = similar.length >= MIN_SIMILAR_FOR_BIAS;

      const approvals = pool.filter((r) => isApproval(r.outcome)).length;
      const declines = pool.filter((r) => isDecline(r.outcome)).length;
      const decided = approvals + declines;
      if (decided < MIN_SIMILAR_FOR_BIAS) return score;

      const approvalRate = approvals / decided;
      const reasons = [...score.reasons];
      const warnings: LenderWarning[] = [...score.warnings];
      let delta = 0;
      const scope = onSimilar ? "similar" : "past";

      if (approvalRate >= 0.6) {
        delta += APPROVAL_BONUS;
        reasons.push(`Approved ${approvals}/${decided} ${scope} deals`);
      } else if (approvalRate <= 0.2) {
        delta -= DECLINE_PENALTY;
        // Surface the dominant decline reason — the nuance the operator needs.
        const reasonCounts = new Map<string, number>();
        for (const r of pool) if (isDecline(r.outcome) && r.decline_reason_code) reasonCounts.set(r.decline_reason_code, (reasonCounts.get(r.decline_reason_code) || 0) + 1);
        const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        warnings.push({
          severity: "warning",
          code: "historical_decline_pattern",
          detail: `Declined ${declines}/${decided} ${scope} deals${top ? ` — usually: ${top[0].replace(/_/g, " ")}` : ""}`,
        });
      }

      if (delta === 0) return score;
      const newScore = Math.max(0, Math.min(100, score.score + delta));
      const blockers = warnings.filter((w) => w.severity === "high_risk").map((w) => w.detail);
      return { ...score, score: newScore, reasons, warnings, blockers };
    });
  } catch (e) {
    // Fail open — never break the recommender — but make the failure VISIBLE so a
    // silently-degraded ranker (back to dumb rules) doesn't go unnoticed.
    console.error("[lender-intelligence] bias failed, reverting to rules:", e instanceof Error ? e.message : e);
    return scores;
  }
}

export type LenderIntelligence = {
  lender_id: string;
  total: number;
  approvals: number;
  declines: number;
  approval_rate: number | null;
  decline_reasons: { code: string; n: number }[];
  by_paper_grade: { grade: string; approvals: number; declines: number }[];
  avg_approved_amount: number | null;
  avg_factor: number | null;
  recent: { application_id: string; outcome: string; decline_reason_code: string | null; reply_at: string }[];
};

/** Full learned profile for one lender — powers the per-lender intelligence view. */
export async function getLenderIntelligence(tenantId: string, lenderId: string): Promise<LenderIntelligence> {
  const empty: LenderIntelligence = {
    lender_id: lenderId, total: 0, approvals: 0, declines: 0, approval_rate: null,
    decline_reasons: [], by_paper_grade: [], avg_approved_amount: null, avg_factor: null, recent: [],
  };
  try {
    const db = getServiceSupabase();
    const oR = await db
      .from("lender_reply_outcomes")
      .select("application_id, outcome, decline_reason_code, offer_amount, offer_factor, reply_at")
      .eq("tenant_id", tenantId)
      .eq("lender_id", lenderId)
      .order("reply_at", { ascending: false });
    if (oR.error || !oR.data) return empty;
    const rows = oR.data as Array<{ application_id: string; outcome: string; decline_reason_code: string | null; offer_amount: number | null; offer_factor: number | null; reply_at: string }>;
    if (rows.length === 0) return empty;

    const approvals = rows.filter((r) => isApproval(r.outcome)).length;
    const declines = rows.filter((r) => isDecline(r.outcome)).length;
    const decided = approvals + declines;

    const reasonCounts = new Map<string, number>();
    for (const r of rows) if (r.decline_reason_code) reasonCounts.set(r.decline_reason_code, (reasonCounts.get(r.decline_reason_code) || 0) + 1);

    const amounts = rows.filter((r) => isApproval(r.outcome) && typeof r.offer_amount === "number").map((r) => r.offer_amount as number);
    const factors = rows.filter((r) => typeof r.offer_factor === "number").map((r) => r.offer_factor as number);

    // by paper grade — join snapshots.
    const appIds = [...new Set(rows.map((r) => r.application_id))];
    const gradeByApp = new Map<string, string>();
    if (appIds.length) {
      const sR = await db.from("deal_paper_snapshot").select("application_id, paper_grade").eq("tenant_id", tenantId).in("application_id", appIds);
      for (const s of (sR.data || []) as Array<{ application_id: string; paper_grade: string | null }>) if (s.paper_grade && !gradeByApp.has(s.application_id)) gradeByApp.set(s.application_id, s.paper_grade.toUpperCase());
    }
    const gradeAgg = new Map<string, { approvals: number; declines: number }>();
    for (const r of rows) {
      const g = gradeByApp.get(r.application_id);
      if (!g) continue;
      const cur = gradeAgg.get(g) || { approvals: 0, declines: 0 };
      if (isApproval(r.outcome)) cur.approvals++;
      else if (isDecline(r.outcome)) cur.declines++;
      gradeAgg.set(g, cur);
    }

    return {
      lender_id: lenderId,
      total: rows.length,
      approvals,
      declines,
      approval_rate: decided > 0 ? approvals / decided : null,
      decline_reasons: [...reasonCounts.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n),
      by_paper_grade: [...gradeAgg.entries()].map(([grade, v]) => ({ grade, ...v })).sort((a, b) => a.grade.localeCompare(b.grade)),
      avg_approved_amount: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length) : null,
      avg_factor: factors.length ? Math.round((factors.reduce((a, b) => a + b, 0) / factors.length) * 1000) / 1000 : null,
      recent: rows.slice(0, 20).map((r) => ({ application_id: r.application_id, outcome: r.outcome, decline_reason_code: r.decline_reason_code, reply_at: r.reply_at })),
    };
  } catch (e) {
    console.error("[lender-intelligence] getLenderIntelligence failed:", e instanceof Error ? e.message : e);
    return empty;
  }
}
