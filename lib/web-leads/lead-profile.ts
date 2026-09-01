/**
 * lead-profile.ts — the DESIGNATION: what type of bad this website is, named.
 *
 * ═══ WHY (Adon, 2026-09-01, round 5) ════════════════════════════════════════
 *
 * "Really outlining the graph of what type of bad it is for each lead."
 *
 * The radar already draws the shape of the problem; this module NAMES the
 * shape, in words a rep can glance at and say. Seven pillars are seven facts,
 * but a rep opening the card mid-dial needs the one-word version first: is
 * this an invisible storefront, a leaky funnel, a full rebuild? The
 * classification plate on the battle card renders what this module returns.
 *
 * ═══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * 1. EVERY WORD IS HAND-WRITTEN, in the fixed tables below, rendered verbatim
 *    (battle-card rule 3). The classifier picks WHICH hand-written entry
 *    applies; it never composes a sentence.
 * 2. THE CLASSIFIER IS ARITHMETIC, not judgement: ordered threshold rules
 *    over the same dimension scores every chart already renders. Same input,
 *    same designation, every time. It is TOTAL — every scored profile maps to
 *    exactly one designation, so the plate can never render blank.
 * 3. A DESIGNATION IS A SHAPE, NOT A COLOUR. The name may carry a verdict in
 *    words — this card is full of verdict words; that is the product — but
 *    the rendering keeps the colour doctrine: dimension chips wear identity
 *    hues, the plate itself wears the neutral accent, nothing is tinted by
 *    how bad the news is. tests/web-leads-guards.test.ts bans the verdict
 *    colour classes in this file like every other file in the feature.
 * 4. tests/web-leads-battlecard.test.ts §8e pins totality (a sweep of
 *    synthetic profiles must all classify), the 7-entry completeness of the
 *    crater table, and that no entry is a stub.
 */

import type { DimensionProfile } from "./audit";

export type LeadDesignation = {
  /** Stable machine name for the shape rule that fired. */
  code: string;
  /** The stamped plate name. Hand-written, glanceable, sayable. */
  name: string;
  /** One sentence: what this shape IS, in rep language. */
  meaning: string;
  /** One sentence: how to sell this shape. */
  play: string;
  /** The dimension keys that define the shape (1–3), for the identity chips. */
  primary: string[];
};

/**
 * One designation per dimension, for the profile where a SINGLE area has
 * collapsed while the rest hold up. Keys must cover every dimension the audit
 * produces — a crater with no name would fall through to a generic label and
 * the plate would say less than the chart. Pinned complete by the test.
 */
export const CRATER_DESIGNATIONS: Record<string, Omit<LeadDesignation, "code" | "primary">> = {
  conversion: {
    name: "Leaky funnel",
    meaning: "The site gets seen, but gives a visitor no easy way to act on it.",
    play: "Sell the calls they never get: every visitor who cannot tap a number is a job that went to whoever answered first.",
  },
  trust: {
    name: "Credibility gap",
    meaning: "The site exists, but nothing on it proves this is a real, current business.",
    play: "Sell reassurance: the reviews, photos and proof a stranger looks for before deciding to call.",
  },
  design: {
    name: "Dated storefront",
    meaning: "The site works, but looks like the year it was built, and a visitor reads age as neglect.",
    play: "Sell the comparison: put their site next to the benchmark and let the difference speak.",
  },
  mobile: {
    name: "Broken on phones",
    meaning: "The site was built for a desktop, and most of the people looking at it are not on one.",
    play: "Sell the pocket test: ask them to open their own site on their own phone while you wait.",
  },
  content: {
    name: "Empty shelf",
    meaning: "The site names the business, but never quite says what it sells, to whom, or where.",
    play: "Sell the questions a visitor cannot answer there: services, prices, area, hours.",
  },
  performance: {
    name: "Slow gate",
    meaning: "The site has the goods, but makes every visitor wait at the door for them.",
    play: "Sell the seconds: name the load time, then ask what a visitor does instead of waiting.",
  },
  discoverability: {
    name: "Invisible storefront",
    meaning: "The site exists, but the people searching for exactly this business never find it.",
    play: "Sell the searches happening without them: their category, their city, somebody else's result.",
  },
};

/** The four whole-shape designations, for profiles no single crater explains. */
export const SHAPE_DESIGNATIONS: Record<"rebuild" | "contender" | "two_front" | "erosion", Omit<LeadDesignation, "code" | "primary">> = {
  rebuild: {
    name: "Full rebuild",
    meaning: "No single area is carrying this site; patching one thing leaves six more failing.",
    play: "Sell the restart: one rebuilt site outruns seven separate repairs, and costs less than buying them one at a time.",
  },
  contender: {
    name: "Strong contender",
    meaning: "Most of this site already works; what is left is the gap between good and best in their market.",
    play: "Sell the margin: name the benchmark and the two or three specific checks that separate them from it.",
  },
  two_front: {
    name: "Two-front fight",
    meaning: "Two areas are dragging the score together; fixing either alone leaves the other still losing them work.",
    play: "Sell them as one job: the two fixes share a cause, a build, and a bill.",
  },
  erosion: {
    name: "Broad erosion",
    meaning: "Nothing has collapsed outright, but almost every area is leaking a few points.",
    play: "Sell the total: no single fault sounds urgent on its own, so quote the one number that adds them all up.",
  },
};

/** How far below the median of the OTHER dimensions a score must sit to
 *  count as a crater on its own (deep enough that the shape is ABOUT it). */
const CRATER_GAP = 25;
/** The shallower bar the two worst must BOTH clear for a two-front fight. */
const FRONT_GAP = 15;
/** Every score below this = nothing worth keeping = full rebuild. */
const REBUILD_CEILING = 45;
/** Composite at or above this = the sell is the margin, not the wreckage. */
const CONTENDER_FLOOR = 75;

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Name the shape of one scored profile. Ordered rules, first match wins:
 *
 *   1. REBUILD    — every area under 45: the shape is "all of it".
 *   2. CRATER     — the worst area ≥25 under the median of the others AND
 *                   standing alone: either the second-worst is ≥15 above it,
 *                   or the second-worst is not itself dragging. One collapse
 *                   dominates any composite, including a good one. (Without
 *                   the standing-alone clause, two areas dragging TOGETHER
 *                   would stamp a crater on whichever happens to sit lower —
 *                   naming one villain when the shape has two. Caught by the
 *                   §8e two-front case on first run, 2026-09-01.)
 *   3. TWO-FRONT  — the two worst both ≥15 under the median of the rest.
 *   4. CONTENDER  — composite ≥75 with no crater: sell the margin.
 *   5. EROSION    — everything else: spread-out decay, no single villain.
 *
 * Total by construction: rule 5 has no condition.
 */
export function designateLead(dimensions: DimensionProfile[], composite: number): LeadDesignation {
  const byScore = [...dimensions].sort((a, b) => a.score - b.score);

  // A profile too thin to have a shape (fewer than three areas) can only be
  // spoken about as a whole. Real audits always carry seven; this is the
  // totality backstop, not an expected path.
  if (byScore.length < 3) {
    return { code: "erosion", primary: byScore.map((d) => d.key), ...SHAPE_DESIGNATIONS.erosion };
  }

  if (byScore.every((d) => d.score < REBUILD_CEILING)) {
    return { code: "rebuild", primary: byScore.slice(0, 3).map((d) => d.key), ...SHAPE_DESIGNATIONS.rebuild };
  }

  const worst = byScore[0];
  const second = byScore[1];
  const medianOfOthers = median(byScore.slice(1).map((d) => d.score));
  const medianOfRest = median(byScore.slice(2).map((d) => d.score));
  const craterEntry = CRATER_DESIGNATIONS[worst.key];
  const worstStandsAlone =
    second.score - worst.score >= FRONT_GAP || medianOfRest - second.score < FRONT_GAP;
  if (craterEntry && medianOfOthers - worst.score >= CRATER_GAP && worstStandsAlone) {
    return { code: `crater_${worst.key}`, primary: [worst.key], ...craterEntry };
  }

  if (medianOfRest - worst.score >= FRONT_GAP && medianOfRest - second.score >= FRONT_GAP) {
    return { code: "two_front", primary: [worst.key, second.key], ...SHAPE_DESIGNATIONS.two_front };
  }

  if (composite >= CONTENDER_FLOOR) {
    return { code: "contender", primary: [worst.key], ...SHAPE_DESIGNATIONS.contender };
  }

  return { code: "erosion", primary: byScore.slice(0, 2).map((d) => d.key), ...SHAPE_DESIGNATIONS.erosion };
}
