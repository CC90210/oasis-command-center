/**
 * lenders/feedback-bias.ts — adjust match scores using historical
 * lender feedback from the `lender_feedback` table (migration 069).
 *
 * 2026-05-25 (second SunBiz product meeting): the pure-rule scorer in
 * match-fitness.ts doesn't know that Lender X has approved 4 deals
 * similar to this one in the past 90 days (positive signal) or that
 * Lender Y has declined 5 similar deals with no approvals (negative
 * signal). This layer reads that history and nudges scores accordingly.
 *
 * Fallback contract: any DB error or empty table → return `scores`
 * unmodified. The recommender must NEVER break because this table is
 * empty, inaccessible, or on an old schema.
 *
 * Schema assumed for `lender_feedback` (migration 069):
 *   id           uuid
 *   tenant_id    uuid
 *   lender_id    uuid  (FK → tenant_records.id where entity_type='lender')
 *   industry     text
 *   monthly_revenue  numeric
 *   outcome      text  ('approved' | 'declined' | 'info_requested' | 'no_response')
 *   created_at   timestamptz
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { MatchScore, ApplicationProfile, LenderWarning } from "./match-fitness";

/** Revenue band tolerance: ±30% of the application's monthly revenue. */
const REVENUE_BAND_PCT = 0.3;

/** Look-back window in days. */
const LOOKBACK_DAYS = 90;

/** Score bonus when ≥2 similar deals approved in window. */
const APPROVAL_BONUS = 10;

/** Score penalty when ≥3 similar deals declined AND zero approvals in window. */
const DECLINE_PENALTY = 15;

/** Minimum approved deals for the bonus to fire. */
const MIN_APPROVALS_FOR_BONUS = 2;

/** Minimum declined deals (with zero approvals) for the penalty to fire. */
const MIN_DECLINES_FOR_PENALTY = 3;

type FeedbackRow = {
  lender_id: string;
  industry: string | null;
  monthly_revenue: number | null;
  outcome: string;
};

/**
 * Apply historical feedback bias to a list of scored lender matches.
 * Returns the adjusted scores array. Falls back to `scores` on any
 * DB error so the recommender never breaks due to a missing table.
 */
export async function applyLenderFeedbackBias(
  scores: MatchScore[],
  application: ApplicationProfile,
  tenantId: string,
): Promise<MatchScore[]> {
  if (scores.length === 0) return scores;

  try {
    const db = getServiceSupabase();
    const lenderIds = scores.map((s) => s.lender_id);
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await db
      .from("lender_feedback")
      .select("lender_id, industry, monthly_revenue, outcome")
      .eq("tenant_id", tenantId)
      .in("lender_id", lenderIds)
      .gte("created_at", cutoff);

    if (error) {
      // Table may not exist yet (pre-migration 069). Fail open.
      return scores;
    }

    if (!data || data.length === 0) {
      return scores;
    }

    const rows = data as FeedbackRow[];

    return scores.map((score) => {
      const lenderRows = rows.filter((r) => r.lender_id === score.lender_id);
      if (lenderRows.length === 0) return score;

      // Filter to rows that are "similar" to this application:
      //   - same industry (if application has one AND the feedback row has one)
      //   - monthly revenue within REVENUE_BAND_PCT of application's revenue
      // If the application doesn't supply industry/revenue we skip that
      // filter so we still get some signal from the history.
      const similar = lenderRows.filter((r) => {
        const industryMatch =
          !application.desired_product ||
          !r.industry ||
          r.industry === application.desired_product;

        const revenueMatch =
          application.monthly_revenue === undefined ||
          r.monthly_revenue === null ||
          (
            r.monthly_revenue >= application.monthly_revenue * (1 - REVENUE_BAND_PCT) &&
            r.monthly_revenue <= application.monthly_revenue * (1 + REVENUE_BAND_PCT)
          );

        return industryMatch && revenueMatch;
      });

      if (similar.length === 0) return score;

      const approvals = similar.filter((r) => r.outcome === "approved").length;
      const declines = similar.filter((r) => r.outcome === "declined").length;

      const newReasons = [...score.reasons];
      const newWarnings: LenderWarning[] = [...score.warnings];
      let delta = 0;

      if (approvals >= MIN_APPROVALS_FOR_BONUS) {
        delta += APPROVAL_BONUS;
        newReasons.push(`Approved ${approvals} similar deal${approvals === 1 ? "" : "s"} in last ${LOOKBACK_DAYS}d`);
      }

      if (declines >= MIN_DECLINES_FOR_PENALTY && approvals === 0) {
        delta -= DECLINE_PENALTY;
        newWarnings.push({
          severity: "warning",
          code: "historical_decline_pattern",
          detail: `Declined ${declines} similar deal${declines === 1 ? "" : "s"} in last ${LOOKBACK_DAYS}d with no approvals`,
        });
      }

      if (delta === 0) return score;

      const newScore = Math.max(0, Math.min(100, score.score + delta));
      // Maintain backward-compat: blockers = high_risk subset of warnings.
      const blockers = newWarnings
        .filter((w) => w.severity === "high_risk")
        .map((w) => w.detail);

      return {
        ...score,
        score: newScore,
        reasons: newReasons,
        warnings: newWarnings,
        blockers,
      };
    });
  } catch {
    // Fail open — any unexpected error (network, schema mismatch, etc.)
    // should not break the recommender.
    return scores;
  }
}
