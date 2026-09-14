/**
 * lib/web-leads/automations-match.ts — decides which of `CAPABILITIES`
 * (`lib/web-leads/automations.ts`) apply to the lead a rep is on the phone
 * with right now, and in what order.
 *
 * WHAT THIS DOES: a pure partition of the 15 reviewed capabilities into
 * `relevant` (this lead failed at least one code the capability covers),
 * `rest` (it covers no code this lead failed, or the site was never
 * audited), and `ladder` (the four offer-ladder entries, which carry no
 * codes and are never matched against an audit at all). `relevant` and
 * `rest` are ordered by the summed `points` of the lead's own failing
 * checks inside that capability's `codes`, descending, with the capability
 * `id` as an explicit secondary key so two calls with the same input
 * produce byte-identical order. `ladder` is ordered by its own stage
 * progression (`today` < `after_evidence` < `month_six_plus` < `year_plus`,
 * `STAGE_ORDER` below), then the same `id` tie-break.
 *
 * WHAT THIS DOES NOT DO. It does not decide anything about copy, does not
 * touch `automations.ts` (imported read-only), does not re-derive a scoring
 * model -- `DimensionProfile.checks[].points` is the only source of a
 * recoverable value, summed as-is. It performs no I/O and calls no model:
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
 * note two paragraphs down). `recoverable` is pinned to 0 for every entry in
 * this branch, and that 0 does NOT mean "nothing recoverable" -- it means
 * "no audit ran, so there is no scored point value to sum". A caller must
 * not render it as a real score; ordering among these ten falls back
 * entirely to the id tie-break, which is the honest description of "one
 * buildable set" rather than a ranked defect list. `opts.hasWebsite` is
 * authoritative over whatever `dimensions` were passed -- a stale or
 * contradictory audit does not override an explicit "there is no website".
 *
 * THE NO-AUDIT CASE (empty `dimensions`, `hasWebsite: true`) is not a
 * special branch. With no checks to inspect, no capability's codes are ever
 * found failing, so every `today` capability's `failedCodes` comes out
 * empty and it lands in `rest` by the same general rule that handles a
 * fully-scored lead with a clean capability. `ladder` still renders in
 * full, because ladder entries are never matched against an audit at all.
 * The result: the full catalogue renders, unranked, never a blank panel.
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

import { CAPABILITIES } from "./automations";
import type { Capability, Stage } from "./automations";
import type { DimensionProfile } from "./audit";

export type Matched = {
  capability: Capability;
  /** The subset of `capability.codes` that failed for THIS lead. Empty for
   *  a capability in `rest`, empty for every ladder entry (they carry no
   *  codes at all), and equal to the FULL `codes` list for every entry in
   *  `relevant` when `opts.hasWebsite` is false (see module docblock). */
  failedCodes: string[];
  /** Sum of `points` across `failedCodes`, from this lead's own audit.
   *  0 for a `rest` entry (nothing failed), 0 for every ladder entry (no
   *  codes to sum), and 0 for every `relevant` entry when
   *  `opts.hasWebsite` is false -- that last 0 means "unscored", not
   *  "nothing recoverable". Never negative, never re-derives a weight or a
   *  dimension score; it is exactly the sum of the failing checks' own
   *  `points` values. */
  recoverable: number;
};

export type MatchedCatalogue = {
  /** `stage === "today"` capabilities with at least one failed code for
   *  this lead, or (when `hasWebsite` is false) every `today` capability,
   *  treated as one buildable set. Ordered by `recoverable` descending,
   *  `capability.id` ascending as the tie-break. */
  relevant: Matched[];
  /** `stage === "today"` capabilities with no failed code for this lead --
   *  including every one of them when there was no audit at all. Same
   *  ordering rule as `relevant`; in practice every entry here ties at 0,
   *  so the order is the id tie-break alone. Never dropped, never merged
   *  into `relevant`: a rep asking "what else do you do" reaches this list
   *  through the same "show all" affordance the objection console uses. */
  rest: Matched[];
  /** `stage !== "today"` capabilities, always present, never matched
   *  against an audit (they carry no codes). Ordered by stage progression
   *  (`today` < `after_evidence` < `month_six_plus` < `year_plus`), then
   *  the id tie-break. */
  ladder: Matched[];
};

export type MatchOptions = {
  /** Whether this lead has a website at all. Authoritative: when false,
   *  every `today` capability is placed in `relevant` as one buildable
   *  set, regardless of what `dimensions` carries. See module docblock. */
  hasWebsite: boolean;
};

/** The stage-climb order, also the ladder's render order. Re-exported
 *  nowhere; `automations.ts` already exports `STAGES` for that. */
const STAGE_ORDER: readonly Stage[] = ["today", "after_evidence", "month_six_plus", "year_plus"];

/** Strict, total, and independent of insertion order: two capabilities with
 *  equal `recoverable` never compare equal here, because `id` is unique
 *  (pinned by tests/web-leads-automations.test.ts). Relying on
 *  `Array.prototype.sort`'s stability alone to hold ties in place is NOT
 *  this guarantee -- it would still make two calls on the same input agree,
 *  but only by accident of the input array's own order, which is not an
 *  order this module asserts or owns. This comparator makes the total order
 *  explicit instead. */
function byRecoverableThenId(a: Matched, b: Matched): number {
  if (a.recoverable !== b.recoverable) return b.recoverable - a.recoverable;
  if (a.capability.id === b.capability.id) return 0;
  return a.capability.id < b.capability.id ? -1 : 1;
}

/** Same reasoning as `byRecoverableThenId`, keyed on stage progression
 *  instead of points, because ladder entries carry no codes and therefore
 *  no recoverable value to rank by. */
function byStageThenId(a: Matched, b: Matched): number {
  const sa = STAGE_ORDER.indexOf(a.capability.stage);
  const sb = STAGE_ORDER.indexOf(b.capability.stage);
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
      .map((capability) => ({ capability, failedCodes: [...capability.codes], recoverable: 0 }))
      .sort(byRecoverableThenId);
    return { relevant, rest: [], ladder };
  }

  const pointsByCode = new Map<string, number>();
  const failedCodesSeen = new Set<string>();
  for (const dimension of dimensions) {
    for (const c of dimension.checks) {
      pointsByCode.set(c.code, c.points);
      if (!c.has) failedCodesSeen.add(c.code);
    }
  }

  const relevant: Matched[] = [];
  const rest: Matched[] = [];
  for (const capability of today) {
    const failedCodes = capability.codes.filter((code) => failedCodesSeen.has(code));
    const recoverable = failedCodes.reduce((sum, code) => sum + (pointsByCode.get(code) ?? 0), 0);
    const matched: Matched = { capability, failedCodes, recoverable };
    (failedCodes.length > 0 ? relevant : rest).push(matched);
  }
  relevant.sort(byRecoverableThenId);
  rest.sort(byRecoverableThenId);

  return { relevant, rest, ladder };
}
