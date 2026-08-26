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
 * KNOWN RESIDUAL, NOT CLOSED (measured 2026-08-23). This module treats a
 * non-null `profile` as proof the panel would call the row scored. The panel
 * goes one step further: coerceProfile() also has to PARSE it, and returns
 * not_scored when it cannot. So a row whose profile is non-null but malformed
 * would show a number here and "Not scored yet" there. Codex raised it; it is
 * left open deliberately rather than silently.
 *
 * Exposure today is zero: of 23,170 non-null profiles in this tenant, 0 fail
 * json_valid, 0 lack `composite`, and 0 lack a `dimensions` array. Every one
 * was written by a single code path (JARVIS score-sites.mjs / backfill-
 * profiles.mjs), which stringifies profileSite() output in the same call that
 * writes quality_score, so a valid score beside an invalid profile is
 * essentially only reachable through corruption or a future schema change.
 *
 * Both available fixes cost more than that risk right now: validating here
 * means transferring all ~23,000 full profiles on every list request, which is
 * the exact cost this module exists to avoid, and a persisted validity flag
 * means a JARVIS migration plus a backfill. If the model version ever bumps or
 * the profile shape changes, re-run that query FIRST -- a non-zero answer turns
 * this from a note into a bug.
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
import { WEBDEV_TENANT_ID, LEAD_READ_CAP, MODEL_VERSION, assertCompleteRead } from "./tenant";
import { memo, TTL } from "./cache";
import { parkedSignalsOrFilter, confirmParked } from "./parked-domains";

/** The five honest states. The first four match audit.ts's AuditResult
 *  discriminant; `parked` was added 2026-08-25 -- see ScoreIndex.parked. */
export type ScoreState = "scored" | "unreachable" | "not_scored" | "no_website" | "parked";

export type ScoreIndex = {
  /** business_id -> composite, newest audit only, profile-backed rows only. */
  scored: Map<string, number>;
  /** business_id of every site we tried and failed to reach. NEVER a score. */
  unreachable: Set<string>;
  /**
   * business_id of every "site" that turned out to be a domain FOR SALE.
   *
   * Added 2026-08-25, after a rep-facing battle card offered two competitors
   * whose links opened hugedomains.com. The links were the symptom; the SCORE
   * was the defect. All 53 parking pages in the corpus scored EXACTLY 82, and
   * every one of them landed in the top tier. A parking page is one template,
   * so it scores once and repeats, and it scores WELL because it genuinely is
   * fast, HTTPS, mobile-friendly, and has a phone link, a form and testimonials
   * -- the very things the 49 checks measure. The crawler was not broken. It
   * faithfully measured a page belonging to a domain broker.
   *
   * Competitor selection takes the BEST-scoring peers in a city and industry,
   * so an 82 outranked almost every real site: parked domains were not merely
   * included, they were preferentially surfaced. NEVER a score, never a peer.
   */
  parked: Set<string>;
};

export const EMPTY_SCORE_INDEX: ScoreIndex = {
  scored: new Map(),
  unreachable: new Set(),
  parked: new Set(),
};

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
  // Memoised: three whole-table reads (~50,000 rows) that change only when a
  // scoring RUN writes -- a batch job measured in hours, not a per-request
  // event. See lib/web-leads/cache.ts for why this is safe here.
  return memo("web-leads:scores", TTL.SCORES, loadScoreIndex);
}

/**
 * The parked-domain candidate net, on its OWN cache entry.
 *
 * WHY IT IS SPLIT OUT (measured live, 2026-08-26): this read takes 2,125 ms to
 * return 57 rows / 0.07 MB. It is the slowest query on the Leads page per row
 * returned, by a wide margin, and the cost is the SCAN not the transfer --
 * sixteen leading-wildcard LIKE patterns over the `signals` blob of all 23,222
 * audit rows. A leading-wildcard LIKE cannot use an index, so this is a full
 * scan by construction.
 *
 * Folded into loadScoreIndex() it was re-paid on every SCORES rebuild (five
 * minutes, per instance) to recompute something that only changes when the
 * audit worker writes. On its own TTL it is paid about once per half hour.
 *
 * STILL FAILS LOUD, AND STILL PROVES COMPLETENESS. Both were already true here
 * and neither may be traded for speed: a parked read that quietly returned
 * short leaves the for-sale pages it missed sitting in `scored` at 82, back at
 * the top of every peer group, being offered to a prospect as their best
 * competitor -- and nothing on screen would look wrong. Throwing inside the memo
 * means the failure is not cached, so the next request retries rather than
 * inheriting a bad index for half an hour.
 *
 * `signals` comes back too, because the SQL filter is a NET, not a verdict:
 * `signals.like.*dan.com*` also matches `chezjordan.com`, and LIKE cannot
 * express "on a hostname label boundary". confirmParked() re-checks each
 * candidate properly. ~57 rows, so the extra column costs nothing; getting this
 * wrong strips a real business of its score.
 */
async function loadParkedCandidates(): Promise<{ business_id: string; signals: unknown }[]> {
  return memo("web-leads:parked", TTL.PARKED, async () => {
    const db = getServiceSupabase();
    const res = await db
      .from("leadgen_site_audits")
      .select("business_id,signals", { count: "exact" })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("audit_version", MODEL_VERSION)
      .or(parkedSignalsOrFilter())
      .limit(LEAD_READ_CAP);
    if (res.error) throw new Error(`parked_index_read_failed: ${res.error.message}`);
    const rows = (res.data || []) as unknown as { business_id: string; signals: unknown }[];
    assertCompleteRead("parked_index", rows, res.count);
    return rows;
  });
}

async function loadScoreIndex(): Promise<ScoreIndex> {
  const db = getServiceSupabase();

  const [allAudits, scoredAudits, unreachable, parkedRes] = await Promise.all([
    // EVERY audit row, so the newest one per business can be identified before
    // anything is filtered out -- see the newest-row comment below for why that
    // order matters. `profile` is never selected: it is the full 49-check
    // evaluation, kilobytes per row across ~23,000 rows, and all this needs is
    // one bit about it, which the second read supplies.
    db
      .from("leadgen_site_audits")
      // `count: "exact"` is not decoration: it is how these reads PROVE they
      // are complete rather than assuming it. See assertCompleteRead().
      .select("business_id,fetched_at", { count: "exact" })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("audit_version", MODEL_VERSION)
      .limit(LEAD_READ_CAP),
    // The subset the panel would call `scored`: a profile actually landed
    // (audit.ts rule 3 treats a null profile as not_scored, so a row written
    // before migrations/005_audit_profile.sql and never backfilled is not a
    // score no matter what its quality_score column says).
    db
      .from("leadgen_site_audits")
      .select("business_id,quality_score,fetched_at", { count: "exact" })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("audit_version", MODEL_VERSION)
      // `.not("profile", "is", null)`, NOT `.is("profile", "not.null")`. The
      // second reads better and only works here: our Turso adapter accepts
      // "not.null" as an `is.` value, real supabase-js serialises it to
      // `profile=is.not.null`, and PostgREST rejects that outright -- so on the
      // supabase-js path every /api/web-leads request would 500 while loading
      // the score index. This form compiles on both. (Codex review 2026-08-23.)
      .not("profile", "is", null)
      .limit(LEAD_READ_CAP),
    db
      .from("leadgen_site_unreachable")
      .select("business_id", { count: "exact" })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("audit_version", MODEL_VERSION)
      .limit(LEAD_READ_CAP),
    // PARKED DOMAINS. Memoised SEPARATELY and for far longer than the rest of
    // this index -- see loadParkedCandidates() and TTL.PARKED in ./cache.
    loadParkedCandidates(),
  ]);

  if (allAudits.error) throw new Error(`audit_index_read_failed: ${allAudits.error.message}`);
  if (scoredAudits.error) throw new Error(`audit_index_read_failed: ${scoredAudits.error.message}`);
  if (unreachable.error) throw new Error(`unreachable_index_read_failed: ${unreachable.error.message}`);
  // The parked read's own error check and completeness proof moved INTO
  // loadParkedCandidates() when it got its own cache entry, so that a failure
  // is never memoised -- see its doc comment. Both guarantees still hold; they
  // are just enforced one level down now.

  const allRows = (allAudits.data || []) as { business_id: string; fetched_at: string }[];
  const scoredRows = (scoredAudits.data || []) as { business_id: string; quality_score: number | null; fetched_at: string }[];
  const unreachableRows = (unreachable.data || []) as { business_id: string }[];

  // Completeness is PROVED against each read's own match count, not inferred
  // from whether our cap was hit -- see assertCompleteRead() in tenant.ts for
  // the truncation this catches that a cap comparison cannot. A short read here
  // does not blank the page: it quietly demotes real scored leads to "not
  // scored" and drops them out of every band filter, handing a rep a queue that
  // looks complete and is not.
  assertCompleteRead("audit_index", allRows, allAudits.count);
  assertCompleteRead("audit_index_scored", scoredRows, scoredAudits.count);
  assertCompleteRead("unreachable_index", unreachableRows, unreachable.count);
  // parked_index is proved complete inside loadParkedCandidates(), for the same
  // reason as its siblings and with the sharpest consequence of the four: a
  // truncated parked read leaves the parking pages it missed sitting in `scored`
  // at 82, back at the top of every peer group, offered to prospects as their
  // best competitor, with nothing on screen looking wrong.

  /**
   * NEWEST ROW FIRST, THEN ASK WHETHER IT IS SCORED -- NOT THE OTHER WAY ROUND.
   *
   * One business can hold several audit rows (the natural key is business_id +
   * audit_version + url, so a business with two URLs has two). audit.ts orders
   * ALL of them by fetched_at, takes the newest, and only then reports "not
   * scored" if that row's profile is null.
   *
   * An earlier draft of this function filtered `profile is not null` in SQL and
   * picked the newest of whatever survived. That looks equivalent and is not:
   * for a business whose newest crawl has no profile but an older one does, it
   * silently resurrects the OLD score, so the table shows 61 while the panel
   * says "Not scored yet" about the same business. Codex caught it in review
   * (2026-08-23). It matches zero rows in production today -- verified by
   * query, which is precisely why it would have sat here unnoticed until the
   * next re-crawl wrote a profile-less row and quietly re-dated an old score.
   */
  const newestAt = new Map<string, string>();
  for (const r of allRows) {
    const prev = newestAt.get(r.business_id);
    if (!prev || r.fetched_at > prev) newestAt.set(r.business_id, r.fetched_at);
  }

  // The precise decision, not the query's coarse guess -- see confirmParked().
  const parkedCandidates = parkedRes;
  const parked = confirmParked(parkedCandidates);

  const scored = new Map<string, number>();
  for (const r of scoredRows) {
    // Only if THIS row is the business's newest audit. Anything older is a
    // superseded crawl and the panel would not show it either.
    if (newestAt.get(r.business_id) !== r.fetched_at) continue;
    if (typeof r.quality_score !== "number") continue; // never invent a 0
    // A domain that is FOR SALE never carries a score. Excluded HERE, at the
    // one place scores are built, rather than filtered at each of the places
    // they are read -- the leads table, the band filters, the percentile
    // denominator and the competitor peer groups all consume this map, and a
    // rule applied at four call sites is a rule that will be missed at a fifth.
    if (parked.has(r.business_id)) continue;
    scored.set(r.business_id, r.quality_score);
  }

  return {
    scored,
    unreachable: new Set(unreachableRows.map((r) => r.business_id)),
    parked,
  };
}

/**
 * The state and number for one lead, applying audit.ts's precedence EXACTLY:
 *
 *   1. no website on the lead        -> no_website
 *   2. the domain is FOR SALE        -> parked        (never a number)
 *   3. a site we could not reach     -> unreachable   (never a number)
 *   4. no profile-backed audit row   -> not_scored    (never a zero)
 *   5. otherwise                     -> scored
 *
 * `unreachable` is checked BEFORE `not_scored` for audit.ts's stated reason: a
 * known failure to reach a site must not be reported as "we haven't tried yet"
 * (reads as neutral) OR as a score (reads as a verdict about the business).
 * Both are wrong in different ways; only naming the failure is honest. A site
 * our crawler was blocked from may be perfectly good.
 *
 * `parked` is checked FIRST of the three, and it outranks `unreachable` on
 * purpose. We did not fail to reach a parked domain -- we reached it perfectly
 * and got a domain broker's sales page. Reporting that as "we could not check
 * this site" would be a second false statement in place of the first, and it
 * would throw away the strongest opener a rep has: their domain has lapsed and
 * is currently for sale to anyone with a credit card.
 */
export function resolveScore(
  websiteUrl: string | null,
  businessId: string | null,
  index: ScoreIndex,
): { score: number | null; scoreState: ScoreState } {
  if (!websiteUrl) return { score: null, scoreState: "no_website" };
  if (!businessId) return { score: null, scoreState: "not_scored" };
  if (index.parked.has(businessId)) return { score: null, scoreState: "parked" };
  if (index.unreachable.has(businessId)) return { score: null, scoreState: "unreachable" };
  const score = index.scored.get(businessId);
  if (typeof score !== "number") return { score: null, scoreState: "not_scored" };
  return { score, scoreState: "scored" };
}
