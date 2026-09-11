/**
 * rankObjections — which brush-off is this particular owner most likely to use.
 *
 * PURE. No I/O, no model call, no import that reaches a database. Two reasons,
 * and the second is the load-bearing one:
 *
 *   1. Every rule below is a guess about human behaviour, and a guess that is
 *      only exercised through the UI is a guess nobody ever checks. Pure means
 *      tests/objection-ranking.test.ts can assert each rule directly.
 *   2. A rep taps this list mid-sentence. Nothing here may ever wait on
 *      inference. The lead-tailored WORDING is generated ahead of time and
 *      cached (Phase 2); the ORDER is computed here, synchronously, always.
 *
 * SCORES ARE RELATIVE, NOT MEANINGFUL. The numbers exist to produce an order.
 * Nothing outside this file reads them, and nothing in the UI renders them,
 * because a number next to an objection would read as a probability we cannot
 * support.
 */

import type { CatalogObjection, ObjectionFacts, ObjectionFamily } from "./types";

/** How many cards the console leaves open. The rest sit behind one control. */
export const CONSOLE_OPEN_COUNT = 5;

/**
 * The one objection in the real catalog that a DIY BUILDER on the crawl makes
 * likely: scripts/seed-objection-catalog.ts's "We already have a website. My
 * nephew built it." row. Used by exactly ONE rule now -- the builder-platform
 * bonus in objectionScore -- because that rule is genuinely about this single
 * objection and no property of the row generalises it (a detected Wix install
 * does not make "we get all our work by word of mouth" more likely).
 *
 * IT NO LONGER CARRIES THE NO-WEBSITE PENALTY. That rule moved onto the
 * catalog row itself (`websitePremise`, database/turso/172), because the same
 * premise applies to five rows, not one, and "which objections presuppose a
 * site" is an editorial property of the wording rather than a fact about a
 * slug. See the no-website block in objectionScore.
 *
 * tests/objection-ranking.test.ts asserts this value against
 * lib/web-leads/objections/seed-slugs.ts's SEEDED_SLUGS -- the list
 * scripts/seed-objection-catalog.ts actually writes -- so a drift between the
 * two fails the test loudly instead of silently turning the rule into a no-op
 * (task-7 fix round 1, finding F1: this constant used to be the literal
 * "nephew-built-it", which matched neither the real seeded slug nor anything
 * the test's own fixture used, so the rule never fired against real data and
 * the test never noticed). That defect is the reason the no-website rule below
 * is keyed on a COLUMN and not on a second slug literal.
 */
export const NEPHEW_BUILT_WEBSITE_SLUG = "nephew-built-website";

/**
 * How far a no-website lead's console moves an objection whose premise does
 * or does not survive the absence of a site. Exported so the test can state
 * the arithmetic it relies on instead of re-deriving it.
 *
 * -35 is sized to push a `requires_site` objection below every
 * premise-neutral family (no_need 45 - 35 = 10 < no_money 35), because a
 * question the lead physically cannot be asked belongs behind the click, not
 * merely lower. +20 is sized to lift a `substitute` objection above
 * brush_off's base 50 (already_handled 40 + 20 = 60), because for a lead with
 * no site the substitute-channel claim IS the opening objection.
 */
export const NO_WEBSITE_REQUIRES_SITE_PENALTY = -35;
export const NO_WEBSITE_SUBSTITUTE_BONUS = 20;

/**
 * The resting order when we know nothing. Roughly how often each family shows
 * up on a cold B2B call, and it is only a starting point: once the event table
 * has rows, the `frequency` argument moves entries off these defaults.
 */
const FAMILY_BASE: Readonly<Record<ObjectionFamily, number>> = {
  brush_off: 50,
  no_need: 45,
  already_handled: 40,
  no_money: 35,
  no_trust: 25,
  no_authority: 20,
};

function familyScore(family: ObjectionFamily, facts: ObjectionFacts): number {
  let score = FAMILY_BASE[family];

  // NO FAMILY-WIDE hasWebsite RULE LIVES HERE ANY MORE, in either direction.
  //
  // It used to drop already_handled by 35 (task-7 fix round 1, finding F3:
  // wrong for 5 of the real catalog's 6 already_handled rows) and raise
  // no_need by 30. The second half was wrong for the same reason the first
  // half was, and was found by the final whole-branch review: no_need was
  // read as "nothing is broken" GENERICALLY, but every no_need row in the
  // real seed is a denial about an EXISTING site -- "It loads fine for me.",
  // "It looks fine on my phone.", "Our customers do not care what it looks
  // like.", "We get plenty of calls." Ranked against the real 15-row catalog,
  // that +30 put four of those in the open five for a lead with no website at
  // all, while "We get all our work by word of mouth." sat at #12 and "We
  // have a Facebook page, that does the job." at #10, both behind the "Show
  // all 15" click.
  //
  // FAMILY IS THE WRONG CARRIER for this. Whether an objection survives the
  // absence of a website is a property of its WORDING, decided by whoever
  // writes the row, and it cuts across families: 4 no_need rows and 1
  // already_handled row require a site, 2 already_handled rows are the reason
  // there is no site, and the remaining 8 do not care. It is therefore
  // carried on the row (`websitePremise`) and applied in objectionScore.
  //
  // A slug list would have been the other option and is deliberately NOT what
  // this is: a ranking rule keyed on a slug literal is exactly the defect
  // finding F1 already recorded in this file.

  // A site that already scores well earns its owner the right to say the
  // phone rings fine, which is the hardest version of no_need to answer.
  if (typeof facts.overallScore === "number" && facts.overallScore >= 75) {
    if (family === "no_need") score += 30;
  }

  // A visibly poor site pushes the argument off "is it broken" and onto money.
  if (typeof facts.overallScore === "number" && facts.overallScore < 40) {
    if (family === "no_money") score += 12;
    if (family === "no_need") score -= 10;
  }

  // Someone we have chased and finally caught is someone who wants off the
  // phone, whatever their site looks like.
  if (facts.priorNoAnswerCalls >= 3 && family === "brush_off") score += 25;

  // A competitor measurably ahead makes "we already have someone" the reflex,
  // because the owner assumes their existing arrangement covers it.
  if (typeof facts.competitorGap === "number" && facts.competitorGap >= 15) {
    if (family === "already_handled") score += 10;
  }

  return score;
}

function objectionScore(
  o: CatalogObjection,
  facts: ObjectionFacts,
  frequency: Record<string, number>,
): number {
  let score = familyScore(o.family, facts);

  // NO SITE AT ALL. The open cards must be objections this lead could
  // actually raise, so the row's own premise decides, per row:
  //
  //   requires_site  the objection asserts something about a site that
  //                  exists ("It loads fine for me.", "We already have a
  //                  website."). This lead cannot say it. Behind the click.
  //   substitute     the objection names what the owner believes replaces a
  //                  site ("We get all our work by word of mouth.", "We have
  //                  a Facebook page, that does the job."). This is the
  //                  reason there is no site, so it leads.
  //   null/other     premise-neutral. Untouched, ranks on family base.
  //
  // The premise is a column on objection_catalog (database/turso/172), NOT a
  // list in this file: see NEPHEW_BUILT_WEBSITE_SLUG's docblock for why a
  // second slug literal was the wrong answer, and types.ts's WebsitePremise
  // for the classification itself. An unclassified row lands on
  // premise-neutral, which is the safe default -- no opinion, never a wrong
  // opinion.
  if (!facts.hasWebsite) {
    if (o.websitePremise === "requires_site") score += NO_WEBSITE_REQUIRES_SITE_PENALTY;
    if (o.websitePremise === "substitute") score += NO_WEBSITE_SUBSTITUTE_BONUS;
  }

  // The objection belonging to the angle the rep is actually opening with is
  // the push-back that opener invites, so it leads its family.
  if (o.dimension && facts.selectedAngleKey && o.dimension === facts.selectedAngleKey) {
    score += 40;
  }

  // A DIY builder on the crawl means a person built it, and often a relative.
  // That objection is answered differently from every other already_handled
  // entry, so it must not sit behind them.
  if (facts.builderPlatform && o.slug === NEPHEW_BUILT_WEBSITE_SLUG) {
    score += 45;
  }

  // Observed reality outranks the hand-written guesses above once there is
  // enough of it. Capped at +20, which is enough on its own to override the
  // +10 competitorGap bump and the +12 poor-score (overallScore < 40) bump --
  // but not the +25 no-answer bump, the +30 overallScore no_need bumps, the
  // +40 selected-angle bump, or the +45 builder-platform bump. Frequency can
  // win a small situational signal; it cannot flatten the strong ones.
  const seen = frequency[o.id];
  if (typeof seen === "number" && seen > 0) {
    score += Math.min(20, Math.log10(seen + 1) * 10);
  }

  return score;
}

/**
 * Ranks, never filters: every objection handed in comes back out. A rep who
 * needs the twenty-fifth entry must be able to reach it, so hiding is the
 * console's job (CONSOLE_OPEN_COUNT) and never the ranker's.
 *
 * `frequency` maps objection id to tenant-wide event count. Optional so the
 * ranker stays usable before the event table has rows.
 */
export function rankObjections(
  catalog: CatalogObjection[],
  facts: ObjectionFacts,
  frequency: Record<string, number> = {},
): CatalogObjection[] {
  return [...catalog]
    .map((o, index) => ({ o, index, score: objectionScore(o, facts, frequency) }))
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-9) return diff;
      // Slug, then original index: a total order, so two renders of the same
      // lead never disagree and a rep's muscle memory survives a reload.
      const bySlug = a.o.slug.localeCompare(b.o.slug);
      return bySlug !== 0 ? bySlug : a.index - b.index;
    })
    .map((entry) => entry.o);
}
