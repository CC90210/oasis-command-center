/**
 * lib/web-leads/automations-match.ts — decides which of `CAPABILITIES`
 * (`lib/web-leads/automations.ts`) apply to the lead a rep is on the phone
 * with right now, and in what order.
 *
 * WHAT THIS DOES: a pure partition of the 15 reviewed capabilities into
 * `relevant` (this lead failed at least one code the capability covers),
 * `rest` (it covers no code this lead failed, or the site was never
 * audited), and `ladder` (the five offer-ladder entries, which carry no
 * codes and are never matched against an audit at all). `relevant` and
 * `rest` are ordered by the summed WEIGHTED recoverable points of the
 * lead's own failing checks inside that capability's `codes`, descending,
 * with the capability `id` as an explicit secondary key so two calls with
 * the same input produce byte-identical order. `ladder` is ordered by its own stage
 * progression (`today` < `after_evidence` < `month_six_plus` < `year_plus`,
 * per `automations.ts`'s exported `STAGES`), then the same `id` tie-break.
 *
 * WHY THE KEY IS WEIGHTED, AND WHAT IT COST TO GET WRONG (fix round 2,
 * 2026-09-14). This module originally summed `DimensionProfile.checks[].points`
 * as-is. Raw check points are NOT comparable across dimensions and ranking
 * on them is a defect, not a simplification. Each dimension normalises to
 * its own raw total (conversion 96, trust 92, design 86, the rest 100) and
 * then carries a very different weight into the composite (conversion 0.26
 * down to discoverability 0.08), so one raw point is worth between 0.2708
 * and 0.0800 composite: a 3.39x spread. `angles.ts` carries the standing
 * written warning on exactly this, above `selectAngle`: "Ranking on the raw
 * score sends a rep into the smaller conversation and, worse, into the
 * smaller build."
 *
 * What it did on a live call: a lead failing only `local_schema` (raw 36,
 * weighted 2.88) ranked ABOVE a lead failing only `tel_link` (raw 18,
 * weighted 4.88), so the rep opened on structured data markup instead of
 * "your phone number is not tappable" -- while the angle rendered higher on
 * the same card, chosen by `selectAngle`'s weighted function, said the
 * opposite. The card contradicted itself.
 *
 * The key is composite points. Per failing code it is
 * `Math.max(0, 100 - dimension.score) * dimension.weight * points / failedRaw`,
 * where `failedRaw` is the summed `points` of the FAILING checks in that
 * code's own dimension. That is `recoverablePoints(d)` from `angles.ts`
 * split across the codes that earned it, in proportion to their raw points.
 * So a capability bundle's figure is in the SAME UNIT as the number the
 * rest of the battle card already speaks, and is printable rather than
 * merely sortable.
 *
 * 🚨 THE ROUNDING, AND WHY IT IS NOT A ROUNDING ERROR (fix round 3,
 * 2026-09-14). Fix round 2 computed the share as `points * weight * 100 /
 * rawTotal`, which is the same quantity derived from an UNROUNDED score.
 * `quality-model.js`'s `scoreDimension` stores
 * `Math.round((earned / total) * 100)`, and `recoverablePoints` reads that
 * stored, rounded value. The two therefore disagreed by up to
 * `0.5 * weight` (worst case 0.1300, on conversion), which across the 1,145
 * reachable failing-subsets of the seven dimensions meant:
 *
 *   - 504 of 1,145 (44%) printed a DIFFERENT FIGURE at one decimal place
 *     than `FixFirst` printed for the same lead, on the same card, at the
 *     same time (both rendered together until Task 5 deleted `FixFirst`
 *     and gave its section to the catalogue); and
 *   - 1,764 dimension pairs ORDERED OPPOSITELY to `recoverablePoints`,
 *     which is the function `selectAngle` uses to choose the angle printed
 *     higher up that card. Worked example: conversion with raw 18 failing
 *     against trust with raw 25 failing. The unrounded key said trust;
 *     `recoverablePoints` says conversion.
 *
 * That is the same self-contradicting card the weighting fix existed to
 * eliminate, back at a smaller magnitude. Taking the total from the stored
 * score and splitting it removes it by construction: the sum over ALL of a
 * dimension's failing codes is `Math.max(0, 100 - score) * weight`, which
 * is `recoverablePoints(d)`, whatever rounding produced the stored score.
 *
 * HOW CLOSE "IS" ACTUALLY IS, corrected in Task 5 (2026-09-14). This
 * sentence used to end "bit for bit", and that is not what the arithmetic
 * does. The shares are divided out per code and added back up in binary
 * floating point, so the sum recovers the total EXACTLY in most cases and
 * lands within 2 ulp of it in the rest. Measured twice, by two different
 * harnesses that agree on the bound: enumerating the 1,145 reachable subsets
 * gives exact `===` in 857 of them and a difference in the other 288, worst
 * case 2 ulp; a 185,815-case randomised sweep over this same expression
 * found exact in 83.7% and worst case 2 ulp again.
 *
 * Across the whole range of values this module can produce (0 to
 * `100 * 0.26`), 2 ulp is under 1e-14: orders of magnitude below the 1e-9
 * the comparator ties on, and invisible at the one decimal place the card
 * prints, so the ORDERING and the PRINTED FIGURE are unaffected. What is
 * not true, and what "bit for bit" claimed, is that a strict equality check
 * holds on every lead.
 *
 * ON THE SUBSET COUNT, since two numbers were in circulation (fix round 1,
 * 2026-09-14): it is 1,145, not 1,152. 1,152 is the sum of 2^n over the
 * seven dimensions' check counts, which includes the EMPTY failing set once
 * per dimension. A dimension with nothing failing is not a failing subset:
 * it contributes no capability to `relevant` and no share to split. The
 * correct count is the sum of (2^n - 1), and the difference is exactly 7,
 * one per dimension. Every figure above is over 1,145. Neither harness is
 * checked in, so the percentages are a measurement rather than a guarantee;
 * the 2 ulp bound is what the text relies on.
 *
 * The identity is pinned by a test rather than asserted here, and the
 * fixture's `score` must be a value `Math.round` can actually produce: fix
 * round 2's test used `81.25`, which `scoreDimension` would have stored as
 * `81`, so it passed while pinning something production cannot do. A
 * capability bundle also generally covers only PART of a dimension, so its
 * own sum equals `recoverablePoints` only when the bundle's failing codes
 * are all of that dimension's failing codes; the test builds that case
 * deliberately.
 *
 * WHAT THIS STILL DOES NOT GUARANTEE: the split across codes WITHIN a
 * dimension is proportional to raw points, which is a choice this module
 * makes, not a number the scoring model stores. Only the per-dimension
 * total is a quantity `quality-model.js` and `angles.ts` also compute. Two
 * capabilities splitting one dimension are therefore ordered by this
 * module's own proportional rule.
 *
 * WHAT THIS DOES NOT DO. It does not decide anything about copy, does not
 * touch `automations.ts` (imported read-only), and does not re-derive or
 * re-weight the scoring model: `points`, `weight` and the checks list all
 * ride the stored profile row, and nothing here carries a copy of a model
 * constant to drift. It performs no I/O and calls no model:
 * a rep opens the battle card mid-call and nothing here may wait on
 * anything, which is also what makes every rule below testable in
 * isolation, with no database and no network, in
 * tests/web-leads-automations-match.test.ts.
 *
 * THE `hasWebsite: false` DECISION (Task 3, 2026-09-14). Design spec §5
 * states the outcome -- "shows the whole website group as one build rather
 * than a defect list, because 'we would fix your tap-to-call button' is
 * nonsense when there is no site" -- without prescribing the mechanism.
 * This is the mechanism: when `opts.hasWebsite` is false, EVERY `today`
 * capability is placed in `relevant` (not `rest`, and never split against
 * `rest`), because with no website there is nothing to hold back behind a
 * "show all" affordance -- all ten are the pitch. `failedCodes` is set to
 * that capability's full `codes` list, because with no site literally none
 * of what a bundle covers exists yet, so there is no partial-coverage claim
 * to avoid (contrast the general case, where `failedCodes` deliberately
 * narrows to the codes THIS lead actually failed, precisely so a bundle's
 * `costsThem` sentence is never read as true of the whole bundle when only
 * one code inside it failed for this lead -- see the codes-per-capability
 * note two paragraphs down). `recoverable` is `null` for every entry in
 * this branch -- UNSCORED, not zero, because no audit ran and there is no
 * point value to sum. See "THE `recoverable: number | null` DECISION" below
 * for why this is a type, not a comment. Ordering among these ten falls
 * back entirely to the id tie-break, which is the honest description of
 * "one buildable set" rather than a ranked defect list. `opts.hasWebsite`
 * is authoritative over whatever `dimensions` were passed -- a stale or
 * contradictory audit does not override an explicit "there is no website".
 *
 * THE NO-AUDIT CASE (empty `dimensions`, `hasWebsite: true`) is not a
 * special branch either, for the same reason a per-capability "were any of
 * its codes observed at all" check (below) already covers it: with no
 * checks anywhere in `dimensions`, no code of any capability is ever
 * observed, so every `today` capability's `recoverable` comes out `null`
 * and it lands in `rest` by the same general rule that handles a
 * fully-audited lead with an unobserved capability. `ladder` still renders
 * in full, because ladder entries are never matched against an audit at
 * all. The result: the full catalogue renders, unranked, never a blank
 * panel.
 *
 * THE `recoverable: number | null` DECISION (fix round 1, 2026-09-14).
 * Originally `recoverable` was `number`, pinned to 0 for both the
 * `hasWebsite: false` branch and every unscored `rest` entry in the
 * no-audit case. Both 0s were prose-documented as "unscored, not really
 * zero" -- but a `0` a capability earns because an audit ran, found its
 * codes, and confirmed none of them failing (VERIFIED clean) is a
 * genuinely different fact from a `0` standing in for "we have no idea,
 * nothing was ever checked" (UNSCORED), and nothing at the type level told
 * Task 4's renderer which one it was holding. `null` now means UNSCORED,
 * unconditionally: it appears when NONE of a capability's `codes` were
 * observed in any `DimensionProfile.checks` passed in (which is what makes
 * the no-audit case, dimensions === [], fall out of the general rule
 * without a special branch: zero checks means zero codes observed for
 * every capability) or when `opts.hasWebsite` is false (no website, so no
 * observation is possible at all). A real `number` -- including a real `0`
 * -- appears only when at least one of a capability's codes was actually
 * present in `dimensions.checks`, whether it passed or failed. This also
 * means a genuinely PARTIAL audit (some dimensions scored, others missing)
 * now correctly marks a capability `null` if none of ITS codes happened to
 * be among the dimensions that were scored, rather than silently reporting
 * a false "0 recoverable" for a capability nobody actually checked.
 *
 * PER-CAPABILITY FAILED CODES, NOT A BUNDLE-LEVEL BOOLEAN. A capability
 * qualifies for `relevant` when ANY ONE of its codes failed for this lead,
 * but `automations.ts`'s `costsThem` sentence is written once, for the
 * whole bundle. A lead missing only `map` and `years_trading` still has
 * `look-established`'s other six codes passing, so a bundle-level cost
 * sentence is being asserted where only part of it is true for this lead.
 * `failedCodes` exists so Task 4 can render the specific codes that
 * actually failed -- the per-code detail that grounds the bundle-level
 * sentence -- rather than repeating the same overclaim `automations.ts`'s
 * own docblock already names and hedges in prose. This module does not fix
 * the copy; it hands the caller the data needed to.
 *
 * KNOWN LIMIT: if the same check `code` appeared in more than one
 * `DimensionProfile` in the input (it should not -- each of the 44 codes in
 * `REMEDIES` is scored by exactly one dimension in
 * `services/leadgen/lib/quality-model.js`), the later dimension's entry for
 * that code silently overwrites the earlier one when building the lookup
 * map below. This module does not detect or warn on that case; it assumes
 * the caller's `dimensions` came from `profileSite()` and each code appears
 * at most once.
 */

import { CAPABILITIES, STAGES } from "./automations";
import type { Capability } from "./automations";
import type { AuditResult, DimensionProfile } from "./audit";

/**
 * Does this lead have a LIVE website, from the audit's own state. This is the
 * one place `MatchOptions.hasWebsite` is derived from, and it lives beside the
 * option it feeds rather than inline at the call site, because it is now read
 * twice: the battle card mounts the catalogue once for a scored lead and once
 * for a lead that has no score to show.
 *
 * TWO STATES MEAN NO LIVE SITE, not one:
 *
 *   no_website  `auditFor` returns this at rule 1, for a lead carrying no
 *               website URL at all. Nothing was ever there to look at.
 *   parked      the domain resolved to a for-sale parking page. We DID look,
 *               and what we found was the absence of a live site. Treating
 *               this as "has a website" put the no-audit intro ("this site
 *               has not been checked yet") directly under the card's own
 *               measured sentence ("their domain has lapsed and is listed for
 *               sale"), which is one screen contradicting itself.
 *
 * Every other state means there IS a site: `unreachable` means our crawler was
 * blocked and the site may be excellent, `not_scored` means nobody has looked
 * yet, and `scored` means we looked and measured it. None of those may be told
 * "there is no website for this business", which is why this is a two-state
 * check and not "is the audit scored".
 *
 * It is a function over the audit and never over `lead.websiteUrl`: the audit
 * is the measurement, and a wrong `true` here sends a business with no site
 * down the per-check defect path.
 */
export function hasLiveWebsite(audit: Pick<AuditResult, "state">): boolean {
  return audit.state !== "no_website" && audit.state !== "parked";
}

export type Matched = {
  capability: Capability;
  /** The subset of `capability.codes` that failed for THIS lead. Empty for
   *  a capability in `rest`, empty for every ladder entry (they carry no
   *  codes at all), and equal to the FULL `codes` list for every entry in
   *  `relevant` when `opts.hasWebsite` is false (see module docblock). */
  failedCodes: string[];
  /** Summed WEIGHTED recoverable points across `failedCodes`, from this
   *  lead's own audit -- composite points, the same unit `recoverablePoints`
   *  in `angles.ts` produces and the same unit the battle card already
   *  prints, so this value is printable and not merely a sort key. Raw
   *  `checks[].points` are deliberately NOT used: see WHY THE KEY IS
   *  WEIGHTED in the module docblock. Set only when at least one of
   *  `capability.codes` was actually observed
   *  in `dimensions`. `number`, including a real `0`, means an audit
   *  looked at this capability's codes and that is what it found (`0` =
   *  verified clean, nothing to recover). `null` means UNSCORED: no code
   *  this capability covers was ever observed, either because
   *  `opts.hasWebsite` was false or because `dimensions` carried no check
   *  for any of them (which includes, but is not limited to, the
   *  empty-`dimensions` "no audit at all" case). `null` is never a stand-in
   *  for zero and a caller must not render it as one -- that is the whole
   *  reason this is a type and not a comment (fix round 1, 2026-09-14: the
   *  previous `number`-only version pinned both cases to `0` and asked the
   *  renderer to remember which `0` it was holding). Never negative, never
   *  re-derives a weight or a dimension score. */
  recoverable: number | null;
};

export type MatchedCatalogue = {
  /** `stage === "today"` capabilities with at least one failed code for
   *  this lead, or (when `hasWebsite` is false) every `today` capability,
   *  treated as one buildable set. Ordered by `recoverable` descending
   *  (`null` sorts after every real number -- see `byRecoverableThenId`),
   *  `capability.id` ascending as the tie-break. */
  relevant: Matched[];
  /** `stage === "today"` capabilities with no failed code for this lead --
   *  including every one of them when there was no audit at all. Same
   *  ordering rule as `relevant`. A capability that was genuinely audited
   *  and found clean sorts here with a real `0`; a capability nobody
   *  observed sorts here with `null`, after every real value including
   *  that `0`. Never dropped, never merged into `relevant`: a rep asking
   *  "what else do you do" reaches this list through the same "show all"
   *  affordance the objection console uses. */
  rest: Matched[];
  /** `stage !== "today"` capabilities, always present, never matched
   *  against an audit (they carry no codes, so `recoverable` is always a
   *  real `0` here -- structurally, not because anything went unscored).
   *  Ordered by stage progression (`today` < `after_evidence` <
   *  `month_six_plus` < `year_plus`), then the id tie-break. */
  ladder: Matched[];
};

export type MatchOptions = {
  /** Whether this lead has a website at all. Authoritative: when false,
   *  every `today` capability is placed in `relevant` as one buildable
   *  set, regardless of what `dimensions` carries. See module docblock. */
  hasWebsite: boolean;
};

/** Strict, total, and independent of insertion order: two capabilities with
 *  equal `recoverable` never compare equal here, because `id` is unique
 *  (pinned by tests/web-leads-automations.test.ts). Relying on
 *  `Array.prototype.sort`'s stability alone to hold ties in place is NOT
 *  this guarantee -- it would still make two calls on the same input agree,
 *  but only by accident of the input array's own order, which is not an
 *  order this module asserts or owns. This comparator makes the total order
 *  explicit instead.
 *
 *  WHERE `null` SORTS, DECIDED DELIBERATELY (fix round 1, 2026-09-14):
 *  after every real number, including a real `0`. This module ranks by
 *  evidence. A capability an audit actually looked at and confirmed clean
 *  (`0`) is a stronger, more specific claim than a capability nobody has
 *  looked at yet (`null`) -- "we checked and it's fine" must never render
 *  behind "we have no idea", so `null` is the lowest-priority position, not
 *  a mid-table one. Two `null`s tie-break by `id` exactly like two reals.
 *
 *  THE TIE IS AN EPSILON, NOT AN EQUALITY (fix round 2, 2026-09-14). The
 *  key became a weighted float, so two values that are mathematically equal
 *  can differ in the last bit and a strict `!==` would then rank one above
 *  the other on floating-point noise instead of falling through to the id.
 *  Renders would still agree with each other, but the id tie-break would be
 *  unreachable for exactly the cases it was written for. 1e-9 is the same
 *  epsilon `selectAngle` in `angles.ts` uses on the same unit. */
function byRecoverableThenId(a: Matched, b: Matched): number {
  if (a.recoverable === null || b.recoverable === null) {
    if (a.recoverable === null && b.recoverable !== null) return 1;
    if (b.recoverable === null && a.recoverable !== null) return -1;
  } else {
    const diff = b.recoverable - a.recoverable;
    if (Math.abs(diff) > 1e-9) return diff;
  }
  if (a.capability.id === b.capability.id) return 0;
  return a.capability.id < b.capability.id ? -1 : 1;
}

/** Same reasoning as `byRecoverableThenId`, keyed on stage progression
 *  instead of points, because ladder entries carry no codes and therefore
 *  no recoverable value to rank by. `STAGES` is imported from
 *  `automations.ts` rather than re-declared here, so a reorder there
 *  propagates here automatically instead of silently drifting out of
 *  sync. */
function byStageThenId(a: Matched, b: Matched): number {
  const sa = STAGES.indexOf(a.capability.stage);
  const sb = STAGES.indexOf(b.capability.stage);
  if (sa !== sb) return sa - sb;
  if (a.capability.id === b.capability.id) return 0;
  return a.capability.id < b.capability.id ? -1 : 1;
}

export function matchCapabilities(dimensions: DimensionProfile[], opts: MatchOptions): MatchedCatalogue {
  const today = CAPABILITIES.filter((c) => c.stage === "today");
  const ladderCapabilities = CAPABILITIES.filter((c) => c.stage !== "today");

  const ladder: Matched[] = ladderCapabilities
    .map((capability) => ({ capability, failedCodes: [], recoverable: 0 }))
    .sort(byStageThenId);

  if (!opts.hasWebsite) {
    const relevant: Matched[] = today
      .map((capability) => ({ capability, failedCodes: [...capability.codes], recoverable: null }))
      .sort(byRecoverableThenId);
    return { relevant, rest: [], ladder };
  }

  // observedCodes: every code this audit actually reported on, pass or
  // fail. A capability with none of its codes in this set was never
  // scored -- that is the ONLY condition that produces `recoverable: null`
  // below, and it is what makes the empty-`dimensions` "no audit at all"
  // case fall out of this general loop with no special branch: zero checks
  // means zero codes observed for every capability.
  const observedCodes = new Set<string>();
  const weightedByCode = new Map<string, number>();
  const failedCodesSeen = new Set<string>();
  for (const dimension of dimensions) {
    // THE WHOLE DIMENSION'S recoverable total, taken from the STORED score
    // via the same expression `recoverablePoints` uses, then split across
    // the checks that actually failed in proportion to their raw points.
    //
    // Splitting the stored total is what makes this agree with the rest of
    // the card. Deriving the share from `points / rawTotal` instead (fix
    // round 1's shape) reconstructs an UNROUNDED score, and
    // `quality-model.js`'s `scoreDimension` stores
    // `Math.round((earned / total) * 100)`. See THE ROUNDING, AND WHY IT IS
    // NOT A ROUNDING ERROR in the module docblock for what that cost.
    const recoverableTotal = Math.max(0, 100 - dimension.score) * dimension.weight;
    const failedRaw = dimension.checks.reduce((n, c) => (c.has ? n : n + c.points), 0);
    for (const c of dimension.checks) {
      observedCodes.add(c.code);
      // Only a FAILING check can carry recoverable points, so a passing one
      // is 0 here. That 0 is never summed either way (`recoverable` below
      // reduces over `failedCodes` only); it is set so the map has an entry
      // for every observed code and `observedCodes` and this map can never
      // disagree about what was seen.
      //
      // `failedRaw === 0` means nothing failed in this dimension, so there
      // is no failing code to divide among and nothing to recover; the
      // guard is there for the divide, not for a reachable share.
      const share = !c.has && failedRaw > 0 ? (recoverableTotal * c.points) / failedRaw : 0;
      weightedByCode.set(c.code, share);
      if (!c.has) failedCodesSeen.add(c.code);
    }
  }

  const relevant: Matched[] = [];
  const rest: Matched[] = [];
  for (const capability of today) {
    const anyCodeObserved = capability.codes.some((code) => observedCodes.has(code));
    const failedCodes = capability.codes.filter((code) => failedCodesSeen.has(code));
    const recoverable: number | null = anyCodeObserved
      ? failedCodes.reduce((sum, code) => sum + (weightedByCode.get(code) ?? 0), 0)
      : null;
    const matched: Matched = { capability, failedCodes, recoverable };
    (failedCodes.length > 0 ? relevant : rest).push(matched);
  }
  relevant.sort(byRecoverableThenId);
  rest.sort(byRecoverableThenId);

  return { relevant, rest, ladder };
}
