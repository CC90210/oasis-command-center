"use client";

/**
 * CapabilityCatalogue — the ranked list of what Oasis would build for the
 * business a rep is on the phone with, grouped by when it becomes sellable.
 *
 * It replaces `FixFirst` in `BattleCard.tsx`, which ranked the seven scored
 * DIMENSIONS. This ranks the fifteen reviewed CAPABILITIES in
 * `lib/web-leads/automations.ts`, which are the same measurements regrouped
 * into things an owner recognises as something they would buy. Nobody
 * purchases `og_tags`; they purchase "show up properly when someone shares
 * your page". Wiring it into the card, and deleting `FixFirst`, is the next
 * task; this component is not yet rendered anywhere.
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
 * `remedies.ts` or `check-evidence.ts`. It does not currently render inside
 * `BattleCard.tsx` at all.
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
 * Nothing in this component turns `null` into `0`. `rankingFor` returns
 * `null` for it and every state except `scored`, `CapabilityRow` draws no
 * bar and prints no figure when it is null, and the row renders a written
 * sentence saying nothing has been checked. Telling an owner with no
 * website that they have "0 points to recover" is the failure this typing
 * exists to prevent, and a `0` is also a materially different claim from a
 * `null`: "we checked and it is fine" must never render as "we have no
 * idea". Note also that no bundle sum is printed even when it IS a real
 * number, for the scale reason `CapabilityRow`'s docblock sets out.
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
 * be resolved and `hueFor` returns its neutral fallback. Ladder entries
 * carry no codes at all and always take that fallback. So on a no-audit
 * lead every dot on this list is the same neutral colour. That is honest
 * (nothing here has been measured, so no area has been identified) but it
 * does mean the hue is not a constant per capability across leads the way
 * it is per dimension across surfaces.
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
 * score, a stage or a judgement, and this file joins the colour ban list in
 * `tests/web-leads-guards.test.ts` in the next task.
 */

import { useMemo, useState } from "react";
import { hueFor } from "./battle-hud";
import { CapabilityRow, STAGE_HEADING, type RowState } from "./CapabilityRow";
import type { CheckResult, DimensionProfile } from "@/lib/web-leads/audit";
import { STAGES, type Capability, type Stage } from "@/lib/web-leads/automations";
import { matchCapabilities, type Matched } from "@/lib/web-leads/automations-match";

/** Read once so a rep knows why the list looks the way it does. One of
 *  these renders above the primary list in every case, including the cases
 *  where there is plenty to show, so the panel is never rows with no
 *  explanation. */
const PRIMARY_INTRO: Record<"noWebsite" | "noAudit" | "clean" | "ranked", string> = {
  noWebsite:
    "There is no website for this business, so there is nothing to pick apart. This is the whole build, as one thing. Talk about what they would get, not about what is wrong.",
  noAudit:
    "This site has not been checked yet, so nothing below is ranked and no finding here is specific to them. It is the full list of what we build for a website. Ask what they have rather than telling them.",
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
}) {
  // One open row across every group on this panel. A rep is reading, not
  // comparing, and a second open detail pushes the first off the screen
  // they are mid-sentence on. Held here rather than per row so opening a
  // ladder entry closes an open website entry too.
  const [openId, setOpenId] = useState<string | null>(null);
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

  const introKey: keyof typeof PRIMARY_INTRO = !hasWebsite
    ? "noWebsite"
    : !hasAudit
      ? "noAudit"
      : matched.relevant.length > 0
        ? "ranked"
        : "clean";

  // The largest ordering value in the primary list, used only to scale the
  // bars against each other. Floored at 1 so a list whose values are all 0
  // divides by something, and never used as a figure.
  const maxRanking = useMemo(() => {
    const values = primary.map((m) => m.recoverable).filter((v): v is number => typeof v === "number");
    return Math.max(1, ...values);
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
      state.kind === "scored" && typeof entry.recoverable === "number"
        ? (entry.recoverable / maxRanking) * 100
        : null;
    return (
      <CapabilityRow
        key={entry.capability.id}
        capability={entry.capability}
        state={state}
        hue={hueFor(dimensionKey ?? "")}
        open={openId === entry.capability.id}
        onToggle={() => setOpenId((prev) => (prev === entry.capability.id ? null : entry.capability.id))}
        checks={checkByCode}
        signals={signals}
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
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {"Read these only if they ask what else we do. Do not open with them."}
            </p>
            <ul className="mt-2 space-y-1">{entries.map(renderRow)}</ul>
          </div>
        );
      })}
    </div>
  );
}

export default CapabilityCatalogue;
