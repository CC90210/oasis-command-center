/**
 * scores.ts — the website score for MANY leads at once, for the list view.
 *
 * WHY THIS EXISTS: lib/web-leads/audit.ts answers "how does THIS site score"
 * for one lead, on open, and returns the full 49-check profile. That is the
 * right shape for the detail panel and the wrong shape for a list: a rep
 * looking at 31,016 leads could not tell a prospect worth calling from one
 * who will win the argument without opening every row one at a time. The
 * targeting fact this whole pipeline produced -- that the real prospects are
 * the ~5,258 scoring under 40, and the ~2,471 at 74+ should not be pitched on
 * website quality at all -- was not actionable anywhere in the UI until this
 * module existed.
 *
 * IT MUST AGREE WITH audit.ts, EXACTLY. Two code paths that answer the same
 * question and disagree is how a rep ends up reading one number off the table
 * and a different one off the panel, mid-call, to a stranger. Two guarantees
 * keep them in lockstep:
 *
 *   1. SAME NUMBER. `leadgen_site_audits.quality_score` is not a second,
 *      separately-derived score. JARVIS's score-sites.mjs writes it as
 *      `result.profile.overall`, and scoring-run.js builds that profile as
 *      `{ ...raw, overall: raw.composite }` from the SAME profileSite() call
 *      whose `composite` audit.ts renders. One computation, persisted twice:
 *      once as an indexed integer column for exactly this kind of read, once
 *      inside the profile JSON for the panel. (Verified against JARVIS source
 *      2026-08-23, not assumed -- services/leadgen/score-sites.mjs:393 and
 *      services/leadgen/lib/scoring-run.js:51-56.)
 *
 *   2. SAME PRECEDENCE. resolveScore() below applies audit.ts's four states in
 *      audit.ts's order, for audit.ts's reasons. See its comment.
 *
 * WHY NOT JUST SELECT THE PROFILE: `profile` is the full 49-check evaluation
 * with every rep-facing label -- kilobytes per row, ~23,000 rows. This selects
 * three narrow columns and never transfers a profile. `.is("profile",
 * "not.null")` restricts the read to rows the panel would ALSO call "scored"
 * (audit.ts rule 3 treats a null profile as not_scored), so a row written
 * before migrations/005_audit_profile.sql and never backfilled cannot show a
 * number here while the panel says "Not scored yet" for the same lead.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID, LEAD_READ_CAP } from "./data";
import { MODEL_VERSION } from "./audit";

/** The four honest states, identical to audit.ts's AuditResult discriminant. */
export type ScoreState = "scored" | "unreachable" | "not_scored" | "no_website";

export type ScoreIndex = {
  /** business_id -> composite, newest audit only, profile-backed rows only. */
  scored: Map<string, number>;
  /** business_id of every site we tried and failed to reach. NEVER a score. */
  unreachable: Set<string>;
};

export const EMPTY_SCORE_INDEX: ScoreIndex = { scored: new Map(), unreachable: new Set() };

/**
 * Both score tables for this tenant, in two narrow reads.
 *
 * Truncation is fatal here, not degraded: LEAD_READ_CAP's doc comment explains
 * why a silently-short read is the failure this feature exists to avoid, and a
 * short read here is worse than a short read of leads. It would not blank the
 * list -- it would quietly demote real scored leads to "Not scored", drop them
 * out of a score-band filter, and hand a rep a call queue that LOOKS complete
 * while missing exactly the prospects they asked for. So this throws, and the
 * list route surfaces it, rather than serving a plausible wrong queue.
 */
export async function fetchScoreIndex(): Promise<ScoreIndex> {
  const db = getServiceSupabase();

  const [audits, unreachable] = await Promise.all([
    db
      .from("leadgen_site_audits")
      .select("business_id,quality_score,fetched_at")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("audit_version", MODEL_VERSION)
      // Rows whose profile never landed are `not_scored` to the panel (audit.ts
      // rule 3). Excluding them here is what keeps the two views agreeing.
      .is("profile", "not.null")
      .limit(LEAD_READ_CAP),
    db
      .from("leadgen_site_unreachable")
      .select("business_id")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("audit_version", MODEL_VERSION)
      .limit(LEAD_READ_CAP),
  ]);

  if (audits.error) throw new Error(`audit_index_read_failed: ${audits.error.message}`);
  if (unreachable.error) throw new Error(`unreachable_index_read_failed: ${unreachable.error.message}`);

  const auditRows = (audits.data || []) as { business_id: string; quality_score: number | null; fetched_at: string }[];
  const unreachableRows = (unreachable.data || []) as { business_id: string }[];

  if (auditRows.length >= LEAD_READ_CAP || unreachableRows.length >= LEAD_READ_CAP) {
    throw new Error(
      `score_index_truncated: hit the ${LEAD_READ_CAP}-row cap, scores would be silently incomplete`,
    );
  }

  // One business can hold several audit rows (the table's natural key is
  // business_id + audit_version + url, so a business with two URLs has two).
  // audit.ts resolves that by taking the newest fetched_at; do the same, or a
  // lead's table score could come from a different crawl than its panel score.
  const newest = new Map<string, { score: number; at: string }>();
  for (const r of auditRows) {
    if (typeof r.quality_score !== "number") continue; // never invent a 0
    const prev = newest.get(r.business_id);
    if (!prev || r.fetched_at > prev.at) newest.set(r.business_id, { score: r.quality_score, at: r.fetched_at });
  }

  const scored = new Map<string, number>();
  for (const [bid, v] of newest) scored.set(bid, v.score);

  return { scored, unreachable: new Set(unreachableRows.map((r) => r.business_id)) };
}

/**
 * The state and number for one lead, applying audit.ts's precedence EXACTLY:
 *
 *   1. no website on the lead        -> no_website
 *   2. a site we could not reach     -> unreachable   (never a number)
 *   3. no profile-backed audit row   -> not_scored    (never a zero)
 *   4. otherwise                     -> scored
 *
 * `unreachable` is checked BEFORE `not_scored` for audit.ts's stated reason: a
 * known failure to reach a site must not be reported as "we haven't tried yet"
 * (reads as neutral) OR as a score (reads as a verdict about the business).
 * Both are wrong in different ways; only naming the failure is honest. A site
 * our crawler was blocked from may be perfectly good.
 */
export function resolveScore(
  websiteUrl: string | null,
  businessId: string | null,
  index: ScoreIndex,
): { score: number | null; scoreState: ScoreState } {
  if (!websiteUrl) return { score: null, scoreState: "no_website" };
  if (!businessId) return { score: null, scoreState: "not_scored" };
  if (index.unreachable.has(businessId)) return { score: null, scoreState: "unreachable" };
  const score = index.scored.get(businessId);
  if (typeof score !== "number") return { score: null, scoreState: "not_scored" };
  return { score, scoreState: "scored" };
}
