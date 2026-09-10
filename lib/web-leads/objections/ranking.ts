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

  // No site at all: there is no incumbent to defend, so "we have someone" is
  // close to impossible, and "nothing is broken" is the whole conversation.
  if (!facts.hasWebsite) {
    if (family === "already_handled") score -= 35;
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

  // The objection belonging to the angle the rep is actually opening with is
  // the push-back that opener invites, so it leads its family.
  if (o.dimension && facts.selectedAngleKey && o.dimension === facts.selectedAngleKey) {
    score += 40;
  }

  // A DIY builder on the crawl means a person built it, and often a relative.
  // That objection is answered differently from every other already_handled
  // entry, so it must not sit behind them.
  if (facts.builderPlatform && o.slug === "nephew-built-it") {
    score += 45;
  }

  // Observed reality outranks the hand-written guesses above once there is
  // enough of it. Scaled so it breaks ties and shifts near-ties without
  // flattening the situational rules into a global popularity chart.
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
