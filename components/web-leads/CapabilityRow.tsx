"use client";

/**
 * CapabilityRow — one capability from `lib/web-leads/automations.ts`, as a
 * scannable summary row that expands IN PLACE to the five layers behind it.
 *
 * WHAT THIS RENDERS: a button carrying the capability's identity dot, its
 * `title`, its one-line `summary` and a chevron, and nothing else. A rep
 * reads this list mid-sentence with a stranger on the line, so the scan
 * target is titles. Everything else is behind the tap. When open, the
 * detail renders `whatItIs`, then the cost layer, then `howYouSayIt` as the
 * visually dominant block, then `whatWeDeliver` WHEN THE CAPABILITY CARRIES
 * ANY, then the stage gate, in that order. `whatWeDeliver` is optional: a
 * capability whose scope we have not verified carries no bullets, and that
 * layer is then omitted entirely rather than shown empty or hedged.
 *
 * WHAT THIS DOES NOT DO: it holds no state of its own. `open` and
 * `onToggle` are owned by `CapabilityCatalogue`, which is what enforces one
 * open row at a time across every group on the card. It performs no I/O,
 * logs nothing, and records nothing about what a rep opened (design spec
 * §3.4 non-goal: pitch tracking is a separate build). It holds no
 * prospect-facing copy of its own beyond its section labels, the stage
 * wording below and the four state sentences below: every other sentence on
 * screen comes verbatim from `automations.ts`, `remedies.ts` or
 * `check-evidence.ts`.
 *
 * ═══ THE SPOKEN LINE IS DOMINANT, THE REST IS CONTEXT ══════════════════════
 *
 * Same rule `ObjectionCard.tsx` documents and follows: `howYouSayIt` is the
 * only thing on this panel that leaves a rep's mouth. `whatItIs`, the cost
 * layer and `whatWeDeliver` are things a rep reads to themselves so they can
 * answer a question; they are styled quieter and smaller so none of them can
 * be mistaken for the script at a glance mid-sentence.
 *
 * ═══ THE FIGURE ON THE ROW ═════════════════════════════════════════════════
 *
 * `recoverable` is WEIGHTED composite points, computed in
 * `automations-match.ts` and never here. Per failing code it is
 * `Math.max(0, 100 - dimension.score) * dimension.weight * points /
 * failedRaw`, where `failedRaw` is the summed raw `points` of the FAILING
 * checks in that code's own dimension, summed over the codes this lead
 * actually failed. That is `recoverablePoints(dimension)` from `angles.ts`
 * split across the codes that earned it, in proportion to their raw points.
 * It is the same unit `recoverablePoints`
 * produces and the same unit the retired `FixFirst` printed as
 * "+9.8", so the figure is comparable across capabilities and across the
 * rest of the card, and it is printed in that same convention: right
 * aligned, one decimal, tabular numerals, the constant cyan every "+points"
 * figure on this card wears. That cyan is the METRIC's identity, worn
 * identically at every value, not a grade.
 *
 * 🚨 THIS DOCBLOCK CARRIED THE WRONG FORMULA until the final review
 * (2026-09-14), and it is named here rather than quietly swapped because the
 * direction of the error is the point. It said `points * weight * 100 /
 * dimensionRawTotal`, which is fix round 2's shape: exactly the expression
 * fix round 3 REMOVED and which `automations-match.ts:46-70` spends fifty
 * lines justifying the removal of. It reconstructs an UNROUNDED score where
 * `quality-model.js`'s `scoreDimension` stores a rounded one, which printed a
 * different figure at one decimal on 504 of the 1,145 reachable failing
 * subsets and ordered 1,764 dimension pairs opposite to `recoverablePoints`,
 * the function that chooses the angle printed higher up the same card.
 * `CapabilityCatalogue.tsx`'s docblock describes the shipped formula
 * correctly, so the two sibling components disagreed, inside one branch,
 * about how the number on this row is computed.
 *
 * The derivation, the rounding argument and the measured floating-point
 * bound all live in `automations-match.ts`'s module docblock, beside the
 * code. This one states the formula and points there rather than restating
 * the reasoning, because a second copy of a fifty-line argument is what
 * drifted.
 *
 * An earlier draft of this component printed no figure at all, on the
 * grounds that a bundle sum mixed scales. That was true of the RAW key it
 * was written against and is not true of this one, and it also misread
 * `FixFirst`, which printed the weighted figure on its row and declined
 * only to print a raw per-check number beside it (it printed raw inside the
 * expanded detail, with the denominator named: "{points} of this area's 100
 * pts"). Fixing the key dissolved the objection. `FixFirst` was deleted in
 * Task 5, when this component took over its section.
 *
 * `ranking` is the same value expressed as a bar length relative to the
 * largest entry in the same list, which is what makes the ORDER legible at
 * a glance rather than requiring a rep to compare decimals mid-sentence.
 * Both render only for a capability whose codes were actually measured and
 * actually failed; every other state gets a sentence instead, never a zero.
 *
 * ═══ THE IDENTITY HUE ══════════════════════════════════════════════════════
 *
 * `hue` is the dimension identity hue from `battle-hud.ts`, the same colour
 * this area wears on the radar and in the shape list. It
 * encodes WHICH area, never how bad: trust is that blue at a score of 4 and
 * at a score of 94. This component never picks a hue itself and never
 * derives one from a value; it renders whatever the catalogue passes.
 *
 * `hue` is NULLABLE, and null renders NO DOT (fix round 2, 2026-09-14). It
 * must not fall back to `FALLBACK_HUE`: that hue's `to` is `#7dd3fc`, which
 * is byte-identical to `DIM_HUES.content.to`, and the dot paints `hue.to`
 * alone, so a fallback dot is pixel-identical to a content dot. On an
 * ordinary lead that would put the same mark on `say-what-you-do` and on
 * every unresolved row, breaking the one-colour-one-area coding three tests
 * protect. No area identified, no identity mark.
 *
 * Nothing else here is coloured by a score, a stage or a judgement.
 */

import { ChevronDown } from "lucide-react";
import type { CheckResult } from "@/lib/web-leads/audit";
import type { Capability, Stage } from "@/lib/web-leads/automations";
import { remedyFor } from "@/lib/web-leads/remedies";
import { MeasuredLine, Meter } from "./audit-parts";

/**
 * Which of the five situations this row is in. The catalogue decides it
 * once, from `matchCapabilities`'s output plus `hasWebsite`, and this
 * component only renders it. The three non-`scored` website states exist
 * because each is a genuinely different fact about this lead and rendering
 * any of them as a defect list would put a claim on screen the audit does
 * not support:
 *
 *   scored     an audit ran, and at least one code this bundle covers
 *              failed. `failedCodes` is that subset, never the whole bundle.
 *   clean      an audit ran, it looked at this bundle's codes, and none of
 *              them failed.
 *   unscored   NO code this bundle covers was observed at all (which
 *              includes, but is not limited to, a lead with no audit).
 *              `Matched.recoverable` is `null` in this state and must never
 *              be rendered as a figure.
 *   noWebsite  our record carries no working website for this lead: either
 *              no address at all, or one that resolved to a parked for-sale
 *              page. Nothing here has been measured. Every website
 *              capability is part of one build. Note the asymmetry the copy
 *              has to honour: `parked` is something we looked at,
 *              `no_website` is something we simply do not hold. See
 *              `hasLiveWebsite` in `automations-match.ts`.
 *   ladder     a `stage !== "today"` entry. These carry no codes and are
 *              never matched against an audit at all.
 */
export type RowState =
  | { kind: "scored"; failedCodes: string[] }
  | { kind: "clean" }
  | { kind: "unscored" }
  | { kind: "noWebsite" }
  | { kind: "ladder" };

/** The stage gate, in words. Never a colour: design spec §6 bans colour
 *  keyed to a stage exactly as it bans colour keyed to a score, and a rep
 *  who sees a tinted row says something aloud the tint cannot back up.
 *  Written here rather than in `automations.ts` because it is UI chrome
 *  (a group heading and a one-line gate), not catalogue copy: the reasoned
 *  sentence per capability is `stageReason`, which comes from the module
 *  and renders verbatim underneath. No price appears in any of these, per
 *  the standing rule that not one spoken sentence on this card carries a
 *  figure. */
export const STAGE_HEADING: Record<Stage, string> = {
  today: "Sell this on this call",
  after_evidence: "Later, once the first evidence reports have landed",
  month_six_plus: "Later, month six at the earliest",
  year_plus: "Later, about a year in",
};

/**
 * The instruction that goes with a later-stage entry, in the two positions a
 * later-stage entry is rendered in. ONE export with two fields, not two
 * strings in two files, because the two positions are on the SAME screen and
 * a rep reading contradictory instructions about one product is the defect
 * this exists to close (final review, 2026-09-14).
 *
 *   `group`   above a stage group in `CapabilityCatalogue.tsx`, where
 *             several entries share the heading.
 *   `single`  on one card in `IndustryAutomationGuide.tsx`, whose menu
 *             carries entries with the same title as a ladder capability.
 *             That component renders `defaultOpen` on the battle card with
 *             an ask-now discovery question, directly under the catalogue's
 *             gated copy for the same product, until it is gated too. See
 *             `gatedBy` in `lib/industry-automations.ts`.
 *
 * `group` is byte-identical to the sentence the catalogue already shipped.
 * Nothing about the gate is coloured: design spec §6 bans colour keyed to a
 * stage exactly as it bans colour keyed to a score.
 */
export const LADDER_GATE_NOTE = {
  group: "Read these only if they ask what else we do. Do not open with them.",
  single: "Read this one only if they ask what else we do. Do not open with it.",
} as const;

/** "Costs them:" and "We'd fix it:", verbatim from `remedies.ts`, are the
 *  two lines the rest of this card already speaks. They are rendered in two
 *  different places here rather than as one pair, which is a departure from
 *  the shared `RemedyLines` in `./audit-parts` and is deliberate: the
 *  `costs` line
 *  belongs under the bundle's own cost sentence, which is what it grounds,
 *  and the `fix` line belongs under `whatWeDeliver`, which is the scope
 *  block it adds per-code detail to. Rendering the pair together under the
 *  cost sentence put a second block of scope copy directly above the scope
 *  block. Neither string is reworded.
 *
 *  When a capability carries no `whatWeDeliver` bullets, the fix lines still
 *  render, without the heading: they are per-code statements about checks
 *  that actually failed, they label themselves "We'd fix it", and they do
 *  not depend on the bundle scope list being present. */
function costLineFor(code: string): string | null {
  return remedyFor(code)?.costs ?? null;
}

function fixLineFor(code: string): string | null {
  return remedyFor(code)?.fix ?? null;
}

const SECTION_LABEL = "text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";
const CONTEXT_TEXT = "mt-1.5 text-xs leading-relaxed text-fg-muted";

/*
 * THE EVIDENCE LINE, THE ORDERING BAR AND THE UNMEASURABLE TABLE ALL MOVED
 * (Task 5, 2026-09-14). This file used to carry its own `EvidenceLine`, its
 * own `RankingBar` and its own copy of `UNMEASURABLE_CHECKS`, because the
 * originals were module-private inside `BattleCard.tsx` and Task 4 could not
 * import them. Three differences appeared that nobody chose: the bar lost the
 * tick overlay while both bars rendered on the same card, the "Not recorded"
 * sentence was reworded and lost the data typeface, and the table existed in
 * two files that could not see each other.
 *
 * The renderers now live in `./audit-parts` and the table in
 * `lib/web-leads/check-evidence.ts` beside the function that turns a code
 * into a sentence. This component imports `MeasuredLine` and `Meter` and owns
 * neither. The ordering of the four evidence states is `evidenceStateFor`'s,
 * pinned directly in `tests/web-leads-automations-catalogue.test.ts` rather
 * than through rendered markup, which is what removed the need to export a
 * mutable table for a test to write into.
 */

export function CapabilityRow({
  capability,
  state,
  hue,
  open,
  onToggle,
  checks,
  signals,
  recoverable,
  ranking,
  drawn,
  reduced,
  alreadySaidAbove,
}: {
  capability: Capability;
  state: RowState;
  /** The primary dimension's identity hue, chosen by the catalogue. NULL
   *  when no primary dimension could be resolved, which renders no dot at
   *  all rather than the shared fallback hue. See the file docblock. */
  hue: { from: string; to: string } | null;
  open: boolean;
  onToggle: () => void;
  /** Code to the audit's own check row, for the label and nothing else.
   *  A code missing from this map renders its remedy lines without a
   *  heading rather than the word "undefined". */
  checks: Map<string, CheckResult>;
  /** The crawler's signal blob for this lead, passed straight through to
   *  `evidenceStateFor`. Null is a valid value and renders no evidence
   *  line at all, which is what the shared `MeasuredLine` does with it:
   *  with no blob there is nothing to distinguish "not recorded" from
   *  "very old row". */
  signals: Record<string, unknown> | null;
  /** The weighted composite points this capability would recover for this
   *  lead, from `Matched.recoverable`. Printed on the row in the "+points"
   *  convention the rest of this card uses. Null means UNSCORED, which is
   *  every state except `scored`, and renders nothing at all rather than a
   *  zero. */
  recoverable: number | null;
  /** The same value as a bar length, 0 to 100, relative to the largest
   *  entry in the same list. Null whenever `recoverable` is. */
  ranking: number | null;
  drawn: boolean;
  reduced: boolean;
  /** True when the angle already rendered higher up this card is the angle
   *  for this capability's own dimension, so the rep has closely related
   *  wording on screen twice. See CapabilityCatalogue's docblock for
   *  exactly what this does and does not detect. */
  alreadySaidAbove: boolean;
}) {
  const failedCodes = state.kind === "scored" ? state.failedCodes : [];
  const detailId = `capability-detail-${capability.id}`;

  // Layer 4 has two independent sources: the bundle's own scope bullets,
  // which some capabilities deliberately do not carry, and the per-code fix
  // lines for the checks that failed. `fixLineFor` returns null for a code it
  // has no line for, so the fix lines are resolved here rather than counted
  // from `failedCodes`: a non-empty `failedCodes` that resolves to no lines
  // would otherwise render an empty list.
  const deliverables = capability.whatWeDeliver ?? [];
  const fixLines = failedCodes
    .map((code) => ({ code, fix: fixLineFor(code) }))
    .filter((entry): entry is { code: string; fix: string } => entry.fix !== null);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailId}
        className="block w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <ChevronDown
              aria-hidden
              className={`h-3.5 w-3.5 shrink-0 text-fg-dim transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
            />
            {/* The identity hue of this capability's primary dimension: the
                same colour this area wears on the radar and in the shape
                list. Which area, never how bad. Omitted entirely when no
                dimension resolved, because the shared fallback hue is
                byte-identical to the content dimension's. */}
            {hue && (
              <span
                aria-hidden
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: hue.to, boxShadow: `0 0 6px ${hue.to}` }}
              />
            )}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-fg">{capability.title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-fg-dim">{capability.summary}</span>
            </span>
          </span>
          {/* Weighted composite points, the same unit and the same constant
              cyan every "+points" figure on this card wears. The cyan is
              the metric's own identity,
              worn identically at every value, not a grade. Absent, never
              zeroed, when this capability is unscored. */}
          {recoverable !== null && (
            <span
              className="shrink-0 text-sm tabular-nums [font-family:var(--battle-data)]"
              style={{ color: "#7dd3fc" }}
            >
              +{recoverable.toFixed(1)}
            </span>
          )}
        </span>
      </button>

      {/* The gate, visible WITHOUT opening the row, and outside the button
          so the scan target stays title plus summary. Design spec §3.3: a
          rep has to be able to read when a later item becomes sellable
          without the screen inviting them to open with it. */}
      {capability.stage !== "today" && capability.stageReason && (
        <p className="ml-8 mt-0.5 pr-2 text-[11px] leading-relaxed text-fg-muted/80">{capability.stageReason}</p>
      )}

      {open && (
        <div
          id={detailId}
          className="mb-2 ml-2 mt-1.5 space-y-3.5 rounded-lg border border-accent/15 bg-bg-raised/50 p-3.5 backdrop-blur-sm motion-safe:animate-fade-in"
        >
          {/* Layer 1. */}
          <div>
            <p className={SECTION_LABEL}>What it is</p>
            <p className={CONTEXT_TEXT}>{capability.whatItIs}</p>
          </div>

          {/* Layer 2, and the grounding that keeps it honest. The bundle's
              own `costsThem` is written once for the whole bundle, but a
              bundle qualifies when ANY ONE of its codes failed, so on its
              own it asserts more than this lead's audit found. The failed
              checks render underneath it with their own reviewed cost line
              and the crawler's own evidence, so the rep can see exactly
              which part of the sentence is standing on something. */}
          {state.kind === "scored" && capability.costsThem && (
            <div>
              <p className={SECTION_LABEL}>What it is costing them</p>
              <p className={CONTEXT_TEXT}>{capability.costsThem}</p>
              <ul className="mt-2.5 space-y-2.5 border-l border-bg-border pl-3">
                {failedCodes.map((code) => {
                  const label = checks.get(code)?.label ?? null;
                  const costs = costLineFor(code);
                  return (
                    <li key={code}>
                      {label && <p className="text-xs font-semibold text-fg">{label}</p>}
                      {costs && <p className="mt-1 text-xs leading-relaxed text-fg-dim">{costs}</p>}
                      <MeasuredLine code={code} signals={signals} />
                    </li>
                  );
                })}
              </ul>
              {/* `&& hue` REMOVED (final review, 2026-09-14): it could never
                  be false, so it read as a live guard over a case that does
                  not exist. A non-null `ranking` requires `state.kind ===
                  "scored"`, which requires a non-empty `failedCodes`, which
                  means those codes were observed in `dimensions`, which means
                  the catalogue's `primaryDimensionKey` resolved a key, and
                  `hueFor` in `battle-hud.ts` returns `FALLBACK_HUE` rather
                  than null for an unknown one. `Meter`'s `hue` is optional
                  and it draws a plain bar without one, so `?? undefined`
                  keeps the type honest instead of asserting the
                  impossibility away.

                  THE CAPTION'S SECOND SENTENCE IS HEDGED, and the hedge is
                  load bearing. The per-DIMENSION total this splits IS the
                  number the rest of the card counts in:
                  `recoverablePoints(d)`, which `selectAngle` and the shape
                  list both read. The split of that total ACROSS the codes
                  inside one dimension is proportional to raw points, which
                  `automations-match.ts:107-112` states plainly is "a choice
                  this module makes, not a number the scoring model stores".
                  Unhedged, the caption told a rep that a bundle's share was
                  something the model records. Two capabilities splitting one
                  dimension are ordered by our rule, not by the model's. */}
              {ranking !== null && (
                <div className="mt-3">
                  <Meter value={ranking} hue={hue ?? undefined} drawn={drawn} reduced={reduced} />
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-muted/80">
                    {"The figure on the row, drawn against the largest one in this list. It is points back on their overall score, counted in the same unit as the rest of this card. How that area's points are split between the pieces inside it is our own working, not something the scoring model stores."}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* The three states that are NOT a finding. Each is an explicit
              sentence rather than a blank space or a zero, because a rep
              who sees nothing here assumes the panel failed to load, and a
              rep who sees a zero tells an owner something the audit never
              established. */}
          {/* WHAT THE RECORD SUPPORTS, NOT WHAT THE WORLD CONTAINS (final
              review, 2026-09-14). This said "There is no live website for
              this business", an absolute nothing in this branch measured:
              `no_website` is `fetchAudit`'s `if (!lead.websiteUrl)` line, a
              fact about a missing field in our own directory record. It now
              says what we hold. The line arming the rep for an owner who
              answers with an address lives in the catalogue's intro, which
              renders once; repeating it on all ten rows would bury it. */}
          {state.kind === "noWebsite" && (
            <div>
              <p className={SECTION_LABEL}>Where this stands today</p>
              <p className={CONTEXT_TEXT}>
                {"We have no working website on file for this business, so none of this has been measured and there is nothing here to fix. Read this as part of what gets built, not as a list of things that are wrong."}
              </p>
            </div>
          )}
          {state.kind === "unscored" && (
            <div>
              <p className={SECTION_LABEL}>Where this stands today</p>
              <p className={CONTEXT_TEXT}>
                {"Nothing this covers has been checked for this business, so there is no finding here and no score to quote. It is still part of what gets built."}
              </p>
            </div>
          )}
          {state.kind === "clean" && (
            <div>
              <p className={SECTION_LABEL}>Where this stands today</p>
              <p className={CONTEXT_TEXT}>
                {"We checked the things behind this one and they all passed, so there is nothing here costing them anything today. Worth knowing so nobody tells them otherwise."}
              </p>
            </div>
          )}

          {/* Layer 3, dominant. The only thing on this panel spoken aloud. */}
          <div className="border-l-2 border-accent/30 pl-3">
            <p className={SECTION_LABEL}>How you say it</p>
            {alreadySaidAbove && (
              <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
                {"The opening angle further up this card is for this same area, so some of what follows will be close to what you have already said. Skim it before you read it out."}
              </p>
            )}
            <p className="mt-1.5 text-[15px] leading-relaxed text-fg">{capability.howYouSayIt}</p>
          </div>

          {/* Layer 4. The bundle's scope, then the per-code fix lines for
              the checks that actually failed, which are the specific half
              of the same answer. */}
          {(deliverables.length > 0 || fixLines.length > 0) && (
            <div>
              {/* The heading belongs to the scope bullets. A capability that
                  carries none omits it, so nothing announces a scope list
                  that is not there. The fix lines below label themselves. */}
              {deliverables.length > 0 && (
                <>
                  <p className={SECTION_LABEL}>What we deliver</p>
                  <ul className="mt-1.5 space-y-1">
                    {deliverables.map((item) => (
                      <li key={item} className="flex gap-2 text-xs leading-relaxed text-fg-muted">
                        <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-dim" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {fixLines.length > 0 && (
                <ul
                  className={
                    deliverables.length > 0
                      ? "mt-2.5 space-y-1 border-l border-bg-border pl-3"
                      : "space-y-1 border-l border-bg-border pl-3"
                  }
                >
                  {fixLines.map(({ code, fix }) => (
                    <li key={code} className="text-xs leading-relaxed text-fg-dim">
                      <span className="font-medium text-fg-muted">We&apos;d fix it:</span> {fix}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Layer 5. THE REASON IS NOT REPEATED HERE (final review,
              2026-09-14). `stageReason` is ~60 words and it already renders
              above, outside the button, on every open AND closed later-stage
              row, which is the copy design spec §3.3 actually requires: a
              rep must be able to read the gate without opening anything. A
              second verbatim copy inside the detail put the same paragraph
              on screen twice, a few hundred pixels apart. The heading below
              is what this layer adds that the always-visible line does
              not. */}
          <div className="border-t border-bg-border pt-3">
            <p className={SECTION_LABEL}>When to sell it</p>
            <p className="mt-1.5 text-xs font-semibold text-fg-dim">{STAGE_HEADING[capability.stage]}</p>
          </div>

          {/* DEAD TODAY, AND LABELLED RATHER THAN DELETED (final review,
              2026-09-14). No entry in `automations.ts` sets `source` and its
              own docblock says none can: spec §7.3's competitor-price
              exemption is the only thing the field is for, and that
              exemption "has nowhere to live here" because every `Capability`
              field is spoken or read off the screen mid-call. So this branch
              has never rendered and cannot render as the module stands. It
              is kept, not removed, because the field's own declaration
              states it is required the moment any copy cites a figure, and a
              future entry that sets it must not have its attribution
              silently dropped. No test enforces that requirement today: the
              money sweep in tests/web-leads-automations.test.ts is a FLAT
              ban, deliberately not source-gated, and its own comment says
              why. Same honesty as the unreachable empty-panel
              sentence in `CapabilityCatalogue.tsx`: an unreachable branch
              says so. */}
          {capability.source && (
            <p className="text-[11px] leading-relaxed text-fg-muted/70">Source: {capability.source}</p>
          )}
        </div>
      )}
    </li>
  );
}

export default CapabilityRow;
