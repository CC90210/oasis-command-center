"use client";

/**
 * CapabilityCatalogue — the ranked list of what Oasis would build for the
 * business a rep is on the phone with, grouped by when it becomes sellable.
 *
 * It replaced `FixFirst` in `BattleCard.tsx`, which ranked the seven scored
 * DIMENSIONS. This ranks the fifteen reviewed CAPABILITIES in
 * `lib/web-leads/automations.ts`, which are the same measurements regrouped
 * into things an owner recognises as something they would buy. Nobody
 * purchases `og_tags`; they purchase "show up properly when someone shares
 * your page". Since Task 5 (2026-09-14) this is what the card's `fixes`
 * section renders, and `FixFirst` is deleted.
 *
 * ═══ WHAT IT DOES ══════════════════════════════════════════════════════════
 *
 * Calls `matchCapabilities(dimensions, { hasWebsite })` once per render pass
 * and renders its three lists. It adds no ranking of its own: the ordering
 * inside `relevant` and `rest` is the one that module produced, and the
 * ladder's order is that module's stage progression. It decides four things
 * the matcher deliberately left to the renderer:
 *
 *   1. WHICH LIST IS THE PRIMARY PANEL (see below, it is not always
 *      `relevant`).
 *   2. WHICH OF THE FIVE ROW STATES each entry is in, from `failedCodes`,
 *      `recoverable` and `hasWebsite`.
 *   3. THE IDENTITY HUE for each capability, from the audit itself.
 *   4. WHETHER the angle already on screen higher up covers the same area.
 *
 * ═══ WHAT IT DOES NOT DO ═══════════════════════════════════════════════════
 *
 * No I/O, no fetch, no model call, no write. It records nothing about which
 * capabilities a rep opened or pitched: design spec §3.4 makes pitch
 * tracking an explicit non-goal, and the objection engine's database exists
 * because that engine has to learn, which this one does not. It does not
 * read, modify or re-derive the scoring model, and it does not decide any
 * copy: every prospect-facing sentence comes from `automations.ts`,
 * `remedies.ts` or `check-evidence.ts`.
 *
 * ═══ THE PRIMARY PANEL IS NOT ALWAYS `relevant` ════════════════════════════
 *
 * Design spec §5: "A rep on the phone must never get a blank panel."
 * `relevant` holds only the capabilities with a failing code for THIS lead,
 * and there are two ordinary situations where that list is empty:
 *
 *   NO AUDIT. `matchCapabilities` puts all ten website capabilities in
 *   `rest` with `recoverable: null`, because with no checks anywhere no
 *   code was ever observed. Rendering `relevant` as the panel and `rest`
 *   only behind a "show all" control would leave that rep looking at a
 *   heading, no rows, and the offer ladder underneath.
 *
 *   AUDITED AND CLEAN. Every code passed, so `relevant` is empty and
 *   `rest` holds ten genuinely-verified-clean capabilities.
 *
 * So the primary list is `relevant` when it has rows and `rest` when it does
 * not, and the "show all" control appears only when there is actually a
 * second list to reveal. Whichever list is primary, an explicit sentence
 * above it says what this lead's situation is, so the panel is never rows
 * without an explanation or an explanation without rows.
 *
 * ═══ `recoverable: null` IS UNSCORED, AND NEVER RENDERS AS A NUMBER ════════
 *
 * `Matched.recoverable` is `number | null`. `null` means no code this
 * capability covers was observed at all, either because the lead has no
 * website or because nothing was ever checked. A real number, INCLUDING a
 * real `0`, means an audit looked and that is what it found.
 *
 * Nothing in this component turns `null` into `0`. Both `recoverable` and
 * `ranking` are passed as `null` for every state except `scored`,
 * `CapabilityRow` draws no bar and prints no figure when they are null, and
 * the row renders a written sentence saying nothing has been checked.
 * Telling an owner with no website that they have "0 points to recover" is
 * the failure this typing exists to prevent, and a `0` is also a materially
 * different claim from a `null`: "we checked and it is fine" must never
 * render as "we have no idea".
 *
 * The same distinction decides the PANEL HEADLINE, not only the rows: see
 * `everyPrimaryRowScored` below. A panel whose rows are a mix of real
 * numbers and nulls is a PARTIAL audit and says so, because the headline is
 * the sentence a rep reads aloud.
 *
 * WHAT `recoverable` IS: weighted composite points. It is
 * `recoverablePoints(dimension)` from `angles.ts` split across the codes
 * that failed, in proportion to their raw points, summed over the codes
 * this capability covers. `automations-match.ts`'s docblock carries the
 * derivation and the two defects behind it, both of which made the card
 * contradict itself and both of which are fixed there rather than papered
 * over here: a RAW sum of `checks[].points` (fix round 2), and then a share
 * derived from an UNROUNDED score when `quality-model.js` stores a rounded
 * one (fix round 3). Because the value is now the same unit the rest of the
 * card prints, and agrees with it, the figure is printed on the row.
 *
 * ═══ THE IDENTITY HUE, AND WHERE IT COMES FROM ═════════════════════════════
 *
 * Each capability wears the hue of its PRIMARY DIMENSION: the dimension
 * owning the most of the codes it covers, resolved from THIS lead's own
 * `dimensions` rather than from a table typed into this file. That is
 * deliberate. `automations.ts` carries no dimension key, and a second
 * capability-to-dimension map maintained here would drift out of step with
 * the scoring model the moment a code moved, silently, with nothing to
 * catch it. Deriving it from the audit means it cannot disagree with the
 * radar beside it.
 *
 * WHAT THAT DOES NOT COVER, stated rather than glossed: with no audit, no
 * website, or a code not present in `dimensions`, no primary dimension can
 * be resolved. Ladder entries carry no codes at all and never resolve one.
 * Those rows get `hue: null` and render NO DOT (fix round 2, 2026-09-14).
 * They must not fall back to `FALLBACK_HUE`: that hue's `to` is `#7dd3fc`
 * and `DIM_HUES.content.to` is the same string, and the dot paints `to`
 * alone, so a fallback dot was pixel-identical to a content dot. On an
 * ordinary scored lead that put the content dimension's mark on
 * `say-what-you-do` and on all five ladder entries at once, which is
 * exactly the one-colour-one-area coding three tests protect. No area
 * identified, no identity mark.
 *
 * WHAT IT COSTS, STATED WIDER THAN IT USED TO BE (final review,
 * 2026-09-14). The hue is not a constant per capability across leads the way
 * it is per dimension across surfaces, and the limit is not only "an
 * unaudited lead's list carries no dots at all", which is what this
 * paragraph said. TWO BUNDLES STRADDLE DIMENSIONS, so on a PARTIAL audit
 * they can wear the wrong area's colour rather than none:
 *
 *   `look-current`               `fresh` (content) among eight design codes.
 *   `findable-and-safe-to-click` `https` (performance) among five
 *                                discoverability codes.
 *
 * `primaryDimensionKey` counts only the codes actually present in THIS
 * lead's `dimensions`. On an audit where the minority dimension was scored
 * and the majority one was not, the minority code is the only one counted,
 * so it wins the count and the row wears content's or performance's hue
 * while the bundle belongs to design or discoverability. Nothing is
 * mislabelled in words and no number moves; the dot points at the wrong
 * area on the radar beside it.
 *
 * This is reachable, not theoretical: the `partial` path is the one this
 * branch made live, and it is exactly the shape where one dimension carries
 * checks and the rest carry none. It is not fixed by a typed
 * capability-to-dimension table, which is the thing this derivation exists
 * to avoid: that table drifts silently the moment a code moves, on EVERY
 * lead, which is a worse failure than a wrong dot on a partial audit. It is
 * recorded rather than papered over.
 *
 * ═══ THE ANGLE ALREADY ON SCREEN ═══════════════════════════════════════════
 *
 * `angles.ts` holds one angle per dimension, and `BattleCard.tsx` renders
 * the selected one near the top of the card. Several capabilities in
 * `automations.ts` were written in the same house voice as the angle for
 * their own dimension and reuse parts of it closely: `look-established`
 * carries the trust angle's diagnostic and cost, `easy-to-call` closes on
 * the conversion angle's line, `look-current` opens with the design angle's
 * diagnostic. On a call where that dimension is the selected angle, the rep
 * now has closely related wording on screen from two components and can
 * read it out twice.
 *
 * `alreadySaidAbove` marks it. WHAT IT ACTUALLY CHECKS, and nothing more:
 * whether `selectedAngleKey` equals the capability's resolved primary
 * dimension. That is a claim about the AREA being the same, and the note it
 * renders says exactly that and asks the rep to skim before reading. It is
 * NOT sentence-level duplicate detection: it compares no strings, so it
 * will mark a capability whose wording does not in fact overlap (any other
 * capability in the same dimension), and it will miss wording reused across
 * dimensions. A string-similarity check was considered and rejected because
 * the reuse is near-verbatim rather than verbatim, so a substring match
 * would report "no duplication" while the duplication was on screen, which
 * is a worse failure than a slightly wide warning.
 *
 * Nothing is hidden, de-emphasised or reordered by this flag. Suppressing a
 * spoken line on a guess about what a rep already said is a larger risk
 * than a line skimmed twice, and `howYouSayIt` staying dominant is the rule
 * this card shares with `ObjectionCard.tsx`.
 *
 * ═══ COLOUR ════════════════════════════════════════════════════════════════
 *
 * The only colour keyed to anything is the dimension identity hue, which
 * encodes which area and never how bad, exactly as `battle-hud.ts`
 * documents. Stage groups are labelled in words. Nothing is tinted by a
 * score, a stage or a judgement, and this file is on the colour ban list in
 * `tests/web-leads-guards.test.ts`.
 */

import { useMemo, useState } from "react";
import { hueFor } from "./battle-hud";
import { CapabilityRow, LADDER_GATE_NOTE, STAGE_HEADING, type RowState } from "./CapabilityRow";
import type { CheckResult, DimensionProfile } from "@/lib/web-leads/audit";
import { STAGES, type Capability, type Stage } from "@/lib/web-leads/automations";
import { matchCapabilities, type Matched } from "@/lib/web-leads/automations-match";

/** Read once so a rep knows why the list looks the way it does. One of
 *  these renders above the primary list in every case, including the cases
 *  where there is plenty to show, so the panel is never rows with no
 *  explanation. */
const PRIMARY_INTRO: Record<"noWebsite" | "noAudit" | "partial" | "clean" | "ranked", string> = {
  // WHAT THE RECORD SUPPORTS, NOT WHAT THE WORLD CONTAINS (final review,
  // 2026-09-14). This used to open "There is no website for this business",
  // which is a verified fact about the world that nothing here verified.
  // `hasWebsite` is false for two audit states and only one of them is a
  // measurement: `parked` means the domain resolved to a for-sale page, but
  // `no_website` is `fetchAudit`'s first line, `if (!lead.websiteUrl)`, so it
  // restates a missing field in our own directory record. `NotScored` renders
  // directly above this on the same screen and hedges it correctly ("No
  // website found yet, needs checking"); this sentence then stated it as
  // settled and built the whole pitch on it, so an owner answering "we do,
  // it's at acme.ca" ended the call. It now says what we hold, and hands the
  // rep the line that keeps the pitch alive when the owner says otherwise.
  // See `hasLiveWebsite` in `automations-match.ts`.
  noWebsite:
    "We have no working website on file for this business, so there is nothing here to pick apart. This is the whole build, as one thing. Talk about what they would get, not about what is wrong. If they tell you they do have a site, take the address and keep going: what you are selling is the same either way.",
  noAudit:
    "This site has not been checked yet, so nothing below is ranked and no finding here is specific to them. It is the full list of what we build for a website. Ask what they have rather than telling them.",
  partial:
    "We only got through part of this site. Nothing we did look at came back failing, but several of the things below were never checked at all, and each row says which it is. Do not tell them the site came back clean.",
  clean:
    "We checked this site and none of the things we look for came back failing. There is nothing to open a call on here. These are the pieces we would still own and run for them.",
  ranked: "What we would build for them, heaviest first.",
};

const SHOW_ALL_LABEL = "text-[11px] font-semibold text-fg-dim underline decoration-dotted underline-offset-2 hover:text-fg";
const GROUP_HEADING = "text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";

/**
 * The dimension owning the most of this capability's codes, from the lead's
 * own audit. Null when none of them were observed, which is every capability
 * on an unaudited lead and every ladder entry.
 *
 * The tie-break is the dimension key in ascending order, so a capability
 * split evenly between two dimensions resolves to the same one on every
 * render rather than to whichever the iteration order happened to reach
 * first. It is arbitrary but it is stable, which is what a colour that means
 * "this area" needs to be.
 */
function primaryDimensionKey(capability: Capability, dimensionByCode: Map<string, string>): string | null {
  const counts = new Map<string, number>();
  for (const code of capability.codes) {
    const key = dimensionByCode.get(code);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const key of [...counts.keys()].sort()) {
    const count = counts.get(key) ?? 0;
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Which of the five situations an entry is in. `hasWebsite` is checked
 *  before `failedCodes`, because `matchCapabilities` fills `failedCodes`
 *  with the capability's FULL code list in the no-website branch (nothing
 *  exists, so nothing is partial) and those codes were never measured.
 *  Reading them as findings would put a per-check defect claim on screen
 *  for a business with no site. */
function stateFor(entry: Matched, hasWebsite: boolean): RowState {
  if (entry.capability.stage !== "today") return { kind: "ladder" };
  if (!hasWebsite) return { kind: "noWebsite" };
  if (entry.failedCodes.length > 0) return { kind: "scored", failedCodes: entry.failedCodes };
  return entry.recoverable === null ? { kind: "unscored" } : { kind: "clean" };
}

export function CapabilityCatalogue({
  dimensions,
  hasWebsite,
  signals,
  drawn,
  reduced,
  selectedAngleKey = null,
  defaultOpenId = null,
}: {
  /** This lead's audit, straight from the stored profile. An empty array is
   *  the "no audit at all" case and is handled, not guarded against. */
  dimensions: DimensionProfile[];
  /** Whether this lead has a website at all. Authoritative over
   *  `dimensions`, matching `matchCapabilities`. */
  hasWebsite: boolean;
  /** The crawler's signal blob, passed through to the per-check evidence
   *  lines. Null renders no evidence line rather than a guess. */
  signals: Record<string, unknown> | null;
  /** The parent section's one-shot first-draw flag, for the ordering bar. */
  drawn: boolean;
  /** The viewer's reduced-motion preference. Removes the bar's transition. */
  reduced: boolean;
  /** The dimension key of the angle rendered higher up this card, from
   *  `selectAngle`. Null when no angle was selected, which suppresses every
   *  overlap note. */
  selectedAngleKey?: string | null;
  /** Which row starts open. Defaults to none, which is what the card wants
   *  on arrival. It exists for two reasons and both are real: the ranking
   *  bar lives inside a detail, so with no interaction available a server
   *  render can otherwise never reach it (which is how the bar's scaling
   *  went unpinned through two review rounds); and `BattleCard.tsx`'s
   *  docblock already describes a radar-axis tap opening one detail in
   *  place, so this is the seam Task 5 needs if that ever points at a
   *  capability. It seeds state and does not control it: a later change to
   *  this prop does NOT move the open row, because the rep's own taps own
   *  it from first render onward. */
  defaultOpenId?: string | null;
}) {
  // One open row across every group on this panel. A rep is reading, not
  // comparing, and a second open detail pushes the first off the screen
  // they are mid-sentence on. Held here rather than per row so opening a
  // ladder entry closes an open website entry too.
  const [openId, setOpenId] = useState<string | null>(defaultOpenId);
  const [showRest, setShowRest] = useState(false);

  const matched = useMemo(() => matchCapabilities(dimensions, { hasWebsite }), [dimensions, hasWebsite]);

  const { checkByCode, dimensionByCode } = useMemo(() => {
    const byCode = new Map<string, CheckResult>();
    const dimByCode = new Map<string, string>();
    for (const dimension of dimensions) {
      for (const check of dimension.checks) {
        byCode.set(check.code, check);
        dimByCode.set(check.code, dimension.key);
      }
    }
    return { checkByCode: byCode, dimensionByCode: dimByCode };
  }, [dimensions]);

  const hasAudit = dimensions.some((d) => d.checks.length > 0);

  // Primary list: `relevant` when it has rows, `rest` when it does not. The
  // second list is only ever offered when it is genuinely a second list.
  const primary = matched.relevant.length > 0 ? matched.relevant : matched.rest;
  const secondary = matched.relevant.length > 0 ? matched.rest : [];

  // "Clean" is a claim about COVERAGE, not just about findings, so it is
  // only made when every row in the panel carries a real number. `hasAudit`
  // alone is not enough: it is true as soon as ONE dimension has checks, and
  // `audit.ts`'s `coerceProfile` validates a stored profile with
  // `Array.isArray(profile.dimensions)` and nothing per-dimension, so a
  // partial or older-MODEL_VERSION profile reaches here intact. Without this
  // an eight-row panel whose rows each read "nothing this covers has been
  // checked" sat under a headline saying the site came back clean, and the
  // headline is the part a rep reads aloud. `automations-match.ts` marks
  // those rows `null` precisely so this distinction survives; flattening it
  // back here would have thrown that away.
  const everyPrimaryRowScored = primary.every((m) => typeof m.recoverable === "number");
  const introKey: keyof typeof PRIMARY_INTRO = !hasWebsite
    ? "noWebsite"
    : !hasAudit
      ? "noAudit"
      : matched.relevant.length > 0
        ? "ranked"
        : everyPrimaryRowScored
          ? "clean"
          : "partial";

  // THE COVERAGE FACT HAS TO BE ON SCREEN WITH NO INTERACTION (fix round 3,
  // 2026-09-14). The `partial` intro above only fires when `relevant` is
  // empty. A partially-audited lead that DOES have a failing code takes the
  // `ranked` branch instead, and the capabilities nobody checked have empty
  // `failedCodes`, so they are in `rest`, so they are in `secondary`, so
  // they are behind the collapsed "show all" control. Rendered, that lead
  // showed one row, one figure, and a control: the words "nothing this
  // covers has been checked" were not in the DOM at all, two interactions
  // away. A rep reads "heaviest first" over a one-of-ten sample and has
  // nothing on screen telling them six of seven dimensions were never
  // looked at. "Heaviest first" is a coverage claim a partial audit cannot
  // support.
  //
  // So the count is computed across BOTH lists and rendered as its own
  // always-visible line under the intro. It counts capabilities, not
  // checks, because capabilities are what the rows are; `recoverable ===
  // null` is exactly "no code this one covers was observed", which is the
  // distinction `automations-match.ts` exists to preserve.
  const unscoredCount = [...matched.relevant, ...matched.rest].filter((m) => m.recoverable === null).length;
  const todayCount = matched.relevant.length + matched.rest.length;
  const showCoverageNote = introKey === "ranked" && unscoredCount > 0;

  // The largest weighted value in the primary list, used only to scale the
  // bars against each other. The FIGURE each row prints is `recoverable`
  // itself, not this ratio.
  //
  // NO FLOOR (fix round 3, 2026-09-14; the figures below corrected in Task
  // 5, because they were carried over from the round-2 key and no longer
  // described what this code computes). This was `Math.max(1, ...values)`, a
  // floor written when the key was raw check points whose smallest non-zero
  // value was 4. Weighted composite points go well below 1: on the design
  // dimension of the sub-one fixture, with only `favicon` failing, the value
  // is 0.70. Under the floor that lead's sole row drew at 70% of a bar
  // captioned "drawn against the largest one in this list" while BEING the
  // largest one in the list. Null when there is nothing positive to scale
  // against, which makes every `ranking` null and draws no bar at all rather
  // than a meaningless one.
  const maxRanking = useMemo(() => {
    const values = primary
      .map((m) => m.recoverable)
      .filter((v): v is number => typeof v === "number" && v > 0);
    return values.length > 0 ? Math.max(...values) : null;
  }, [primary]);

  const ladderByStage = useMemo(() => {
    const groups = new Map<Stage, Matched[]>();
    for (const entry of matched.ladder) {
      const list = groups.get(entry.capability.stage) ?? [];
      list.push(entry);
      groups.set(entry.capability.stage, list);
    }
    return groups;
  }, [matched.ladder]);

  function renderRow(entry: Matched) {
    const state = stateFor(entry, hasWebsite);
    const dimensionKey = primaryDimensionKey(entry.capability, dimensionByCode);
    const ranking =
      state.kind === "scored" && typeof entry.recoverable === "number" && maxRanking !== null
        ? (entry.recoverable / maxRanking) * 100
        : null;
    return (
      <CapabilityRow
        key={entry.capability.id}
        capability={entry.capability}
        state={state}
        // Null, never FALLBACK_HUE: its `to` is byte-identical to the
        // content dimension's, and the dot paints `to` alone.
        hue={dimensionKey ? hueFor(dimensionKey) : null}
        open={openId === entry.capability.id}
        onToggle={() => setOpenId((prev) => (prev === entry.capability.id ? null : entry.capability.id))}
        checks={checkByCode}
        signals={signals}
        recoverable={state.kind === "scored" ? entry.recoverable : null}
        ranking={ranking}
        drawn={drawn}
        reduced={reduced}
        alreadySaidAbove={selectedAngleKey !== null && dimensionKey !== null && dimensionKey === selectedAngleKey}
      />
    );
  }

  return (
    <div>
      <p className="text-xs leading-relaxed text-fg-muted">{PRIMARY_INTRO[introKey]}</p>

      {showCoverageNote && (
        <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
          {`We only got through part of this site: ${unscoredCount} of the ${todayCount} areas below were never checked at all. What is ranked here is ranked on the part we did see, so do not tell them this is everything.`}
        </p>
      )}

      {primary.length > 0 ? (
        <ul className="mt-3 space-y-1">{primary.map(renderRow)}</ul>
      ) : (
        // Not reachable while `automations.ts` holds any `today` entry,
        // since `relevant` and `rest` together always hold all of them. It
        // is a sentence rather than an empty div because an empty panel
        // mid-call is indistinguishable from a component that failed.
        <p className="mt-3 text-xs leading-relaxed text-fg-muted">
          {"Nothing is listed for the website itself. What we would still build for them is grouped below."}
        </p>
      )}

      {secondary.length > 0 && (
        <div className="mt-3">
          {showRest ? (
            <>
              <p className={GROUP_HEADING}>Everything else we would own on the site</p>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                {"Nothing here came back failing for them, so none of it opens a call. It is what to reach for when they ask what else is included."}
              </p>
              <ul className="mt-2 space-y-1">{secondary.map(renderRow)}</ul>
              <button type="button" onClick={() => setShowRest(false)} className={`mt-2 ${SHOW_ALL_LABEL}`}>
                Hide the rest
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setShowRest(true)} className={SHOW_ALL_LABEL}>
              Show all {secondary.length} more we would own on the site
            </button>
          )}
        </div>
      )}

      {/* The ladder. Separated and labelled in words, with each entry's own
          stage reason readable without opening it, so a rep can answer a
          question about it intelligently without the screen inviting them
          to open the call with it (design spec §3.3). */}
      {STAGES.filter((stage) => stage !== "today").map((stage) => {
        const entries = ladderByStage.get(stage) ?? [];
        if (entries.length === 0) return null;
        return (
          <div key={stage} className="mt-5 border-t border-bg-border pt-4">
            <p className={GROUP_HEADING}>{STAGE_HEADING[stage]}</p>
            {/* Shared with `IndustryAutomationGuide.tsx`, which renders on
                the same card and carries entries with the same titles. Two
                copies of this instruction is how one product ends up gated
                on one section and open-with-it on the next. */}
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{LADDER_GATE_NOTE.group}</p>
            <ul className="mt-2 space-y-1">{entries.map(renderRow)}</ul>
          </div>
        );
      })}
    </div>
  );
}

export default CapabilityCatalogue;
