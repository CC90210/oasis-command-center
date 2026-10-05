/**
 * attach-scores — put the website score onto pipeline rows, server-side.
 *
 * WHY THIS EXISTS
 * The CRM board at /pipeline and the prospecting list at /web-leads render the
 * SAME rows: both read `tenant_records` where `entity_type='lead'` in tenant
 * ef8d389e (slug `oasis-ai-cc`). Measured 2026-08-25: 31,034 leads, 20,123 with
 * a website. So every business fact a rep sees on the leads tab -- address,
 * city, industry, website, the condition sentence -- is already sitting on the
 * pipeline row, unread, because `oasisRowModel` only ever looked at the generic
 * CRM fields (name, company, email, phone, ai_score).
 *
 * The score is the ONE exception. It does not live on the lead row at all. It
 * lives in `leadgen_site_audits`, keyed by `webdev_source_business_id`, and the
 * leads tab resolves it through lib/web-leads/scores.ts. So the pipeline needs
 * the same join, and this is it.
 *
 * WHY IT RESOLVES ON THE SERVER
 * `ScoreIndex` is a Map plus a Set. Neither survives the server -> client
 * boundary, and LeadPipelineView is a client component. Rather than convert the
 * index to a plain object and ship ~23,000 entries to a browser rendering
 * eleven rows, each row is resolved here and carries two plain values.
 *
 * WHY IT REUSES THE SCORE INDEX ASSEMBLER
 * A second scoring rule is how two surfaces start disagreeing. The pipeline
 * queries only the business ids it will render, but scores.ts assembles those
 * rows with the same newest-audit, unreachable and parked-domain precedence as
 * the full Leads index. Same decision code; much smaller database read.
 *
 * FAIL-CLOSED, AND WHAT THAT MEANS HERE
 * `fetchScoreIndex` throws on a short read rather than serving a plausible
 * wrong queue -- see its doc comment. This does NOT catch that. A pipeline that
 * cannot prove its scores are complete must fail loudly, exactly like the leads
 * tab, because the alternative is silently demoting scored leads to "Not scored
 * yet" on the one screen a rep works from.
 */

import {
  fetchScoreIndexForBusinessIds,
  resolveScore,
  type ScoreIndex,
  type ScoreState,
} from "./scores";

/** Field names written onto `data`. Prefixed `derived_` so nothing mistakes
 *  them for stored columns -- `website_condition` next door IS stored, and a
 *  reader should be able to tell the two apart without checking the schema. */
export const DERIVED_SCORE_KEY = "derived_website_score";
export const DERIVED_SCORE_STATE_KEY = "derived_website_score_state";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Attach `derived_website_score` and `derived_website_score_state` to each row.
 *
 * Mirrors attachAssignedNames: same shape in, same shape out, `data` widened.
 * Returns rows untouched when there are none, so a board with an empty stage
 * never pays for the index.
 */
export async function attachWebsiteScores<
  R extends { data: Record<string, unknown> },
>(rows: R[], injectedIndex?: ScoreIndex): Promise<R[]> {
  if (rows.length === 0) return rows;
  // `injectedIndex` exists so the mapping below can be tested against a REAL
  // ScoreIndex rather than a hand-made stub of whatever shape the test author
  // imagined. A fake that implements the caller's own mistake cannot fail; this
  // repo has been bitten by exactly that twice.
  const businessIds = rows.flatMap((row) => {
    const id = str(row.data.webdev_source_business_id);
    return id ? [id] : [];
  });
  const index = injectedIndex ?? (await fetchScoreIndexForBusinessIds(businessIds));
  return rows.map((r) => {
    const { score, scoreState } = resolveScore(
      str(r.data.website),
      str(r.data.webdev_source_business_id),
      index,
    );
    return {
      ...r,
      data: {
        ...r.data,
        [DERIVED_SCORE_KEY]: score,
        [DERIVED_SCORE_STATE_KEY]: scoreState,
      },
    };
  });
}

/**
 * The sentence a non-scored state renders as, for a caller that has no score.
 *
 * THREE STATES, THREE SENTENCES, NEVER A NUMBER OR A BLANK. This is the same
 * rule the battle card and the leads table follow, and it is not cosmetic: a
 * site our crawler was blocked from may be excellent, and a rep who sees a zero
 * or an empty cell will say something about it on a call that we never
 * measured. `no_website` deliberately returns null so the caller renders the
 * lead's OWN `website_condition` verbatim instead -- that field is OpenStreetMap's
 * hedged wording ("Has a site, not yet reviewed"), and it is the one statement
 * about a missing website that is actually true.
 */
export function scoreStateSentence(state: ScoreState): string | null {
  switch (state) {
    // A measured fact, not a hedge: their web address has lapsed and a broker
    // is selling it. See lib/web-leads/parked-domains.ts for how 53 of these
    // scored 82 and reached prospects as "best-scoring competitors".
    case "parked":
      return "Domain listed for sale, no live site";
    case "unreachable":
      return "We could not check this site";
    case "not_scored":
      return "Not scored yet";
    case "no_website":
      return null;
    default:
      return null;
  }
}
