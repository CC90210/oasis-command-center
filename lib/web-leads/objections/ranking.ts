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
 * The one objection in the real catalog that claims an INCUMBENT WEBSITE
 * (scripts/seed-objection-catalog.ts's "We already have a website. My
 * nephew built it." row). Every other already_handled objection in the real
 * seed -- word of mouth, a Facebook page, off-site reviews, being on a map
 * listing, local reputation -- is website-INDEPENDENT, which is why this is
 * carried as one specific slug rather than a property of the whole
 * already_handled family (see the no-website rule in objectionScore below,
 * and task-7 fix round 1, finding F3).
 *
 * Hoisted into a single exported constant, used by both the builder-platform
 * bonus and the no-website penalty, so a rename of the seeded slug has
 * exactly one place in this file to update. tests/objection-ranking.test.ts
 * asserts this value against lib/web-leads/objections/seed-slugs.ts's
 * SEEDED_SLUGS -- the list scripts/seed-objection-catalog.ts actually
 * writes -- so a drift between the two fails the test loudly instead of
 * silently turning both rules into no-ops (task-7 fix round 1, finding F1:
 * this constant used to be the literal "nephew-built-it", which matched
 * neither the real seeded slug nor anything the test's own fixture used,
 * so the rule never fired against real data and the test never noticed).
 */
export const NEPHEW_BUILT_WEBSITE_SLUG = "nephew-built-website";

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

  // No site at all: "nothing is broken" is the whole conversation, family-wide.
  // This used to ALSO drop the whole already_handled family by 35 on the
  // premise that already_handled means an incumbent website specifically --
  // wrong for 5 of the real catalog's 6 already_handled rows (word of mouth,
  // a Facebook page, off-site reviews, a directory listing, local reputation
  // are all website-INDEPENDENT, and are if anything MORE likely from a
  // no-website lead, not less: they are precisely the reasons that lead gives
  // for never having built a site). That half moved to objectionScore below,
  // scoped to the one objection that actually claims an incumbent website
  // (NEPHEW_BUILT_WEBSITE_SLUG), instead of punishing the whole family.
  // (task-7 fix round 1, finding F3.)
  if (!facts.hasWebsite) {
    if (family === "no_need") score += 30;
  }

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

  // No site at all: there is no incumbent WEBSITE to defend, so the one
  // objection that actually claims one (NEPHEW_BUILT_WEBSITE_SLUG) is close
  // to impossible. Deliberately scoped to that single slug, not the whole
  // already_handled family -- see familyScore's comment and
  // NEPHEW_BUILT_WEBSITE_SLUG's docblock. (task-7 fix round 1, finding F3.)
  if (!facts.hasWebsite && o.slug === NEPHEW_BUILT_WEBSITE_SLUG) {
    score -= 35;
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
