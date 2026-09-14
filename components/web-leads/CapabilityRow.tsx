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
 * visually dominant block, then `whatWeDeliver`, then the stage gate, in
 * that order.
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
 * `recoverable` is WEIGHTED composite points (fix round 2, 2026-09-14):
 * `points * weight * 100 / dimensionRawTotal`, summed over the codes this
 * lead actually failed. That is the same unit `recoverablePoints` in
 * `angles.ts` produces and the same unit `FixFirst` printed as "+9.8", so
 * the figure is comparable across capabilities and across the rest of the
 * card, and it is printed here in `FixFirst`'s own convention: right
 * aligned, one decimal, tabular numerals, the constant cyan every "+points"
 * figure on this card wears. That cyan is the METRIC's identity, worn
 * identically at every value, not a grade.
 *
 * An earlier draft of this component printed no figure at all, on the
 * grounds that a bundle sum mixed scales. That was true of the RAW key it
 * was written against and is not true of this one, and it also misread
 * `FixFirst`, which prints the weighted figure on the row and declines only
 * to print a raw per-check number beside it (it prints raw inside the
 * expanded detail, with the denominator named: "{points} of this area's 100
 * pts"). Fixing the key dissolved the objection.
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
 * this area wears on the radar, in the shape list and in the fix list. It
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
import { checkEvidenceFor } from "@/lib/web-leads/check-evidence";

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
 *   noWebsite  the lead has no website, so nothing has been or can be
 *              measured. Every website capability is part of one build.
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

/** "Costs them:" and "We'd fix it:", verbatim from `remedies.ts`, are the
 *  two lines the rest of this card already speaks. They are rendered in two
 *  different places here rather than as one pair, which is a departure from
 *  `RemedyLines` in `BattleCard.tsx` and is deliberate: the `costs` line
 *  belongs under the bundle's own cost sentence, which is what it grounds,
 *  and the `fix` line belongs under `whatWeDeliver`, which is the scope
 *  block it adds per-code detail to. Rendering the pair together under the
 *  cost sentence put a second block of scope copy directly above the scope
 *  block. Neither string is reworded. */
function costLineFor(code: string): string | null {
  return remedyFor(code)?.costs ?? null;
}

function fixLineFor(code: string): string | null {
  return remedyFor(code)?.fix ?? null;
}

const SECTION_LABEL = "text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";
const CONTEXT_TEXT = "mt-1.5 text-xs leading-relaxed text-fg-muted";

/**
 * Checks the model scores but cannot currently MEASURE for a prospect.
 *
 * A VERBATIM SECOND COPY of `UNMEASURABLE_CHECKS` in `BattleCard.tsx`, kept
 * because that one is module-private and this task may not edit that file.
 * Both are empty today: model v2 (2026-09-02) retired the one entry this
 * carried rather than keep apologising for it, and the map stays because
 * the honest-disclaimer machinery is the feature and the next unmeasurable
 * check will need it.
 *
 * WHAT THIS DOES NOT COVER, and it matters: these are two independent maps,
 * not one shared constant. Adding an entry to `BattleCard.tsx`'s map alone
 * changes nothing on this component, and vice versa. Task 5 exports and
 * dedupes the evidence renderer; this copy must go in that change rather
 * than be left as a second place to remember.
 */
const UNMEASURABLE_CHECKS: Record<string, string> = {};

/**
 * The four honest states of a per-check evidence line, in the order
 * `MeasuredLine` in `BattleCard.tsx` tries them. The unmeasurable branch is
 * FIRST and is not optional: a check our own model cannot measure for
 * anybody is named as our flaw, before any attempt to read a signal that
 * was never going to be there.
 *
 *   unmeasurable -> named as our flaw, with an instruction to ignore it
 *   measured     -> the crawler's own numbers for THIS site
 *   unmeasured   -> the crawl recorded other things but not this: said in
 *                   words, never guessed
 *   no blob      -> nothing renders, because with no signals at all there
 *                   is no way to tell "unrecorded" from "very old row"
 */
function EvidenceLine({ code, signals }: { code: string; signals: Record<string, unknown> | null }) {
  const unmeasurable = UNMEASURABLE_CHECKS[code];
  if (unmeasurable) {
    return (
      <p className="mt-1 text-xs leading-relaxed text-fg-dim">
        <span className="font-medium text-fg-muted">Not measurable:</span> {unmeasurable}
      </p>
    );
  }
  const line = checkEvidenceFor(code, signals);
  if (line) {
    return (
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
        <span className="font-medium text-fg-dim">Seen on the site:</span> {line}
      </p>
    );
  }
  if (signals) {
    return (
      <p className="mt-1 text-xs leading-relaxed text-fg-dim">
        <span className="font-medium text-fg-muted">Not recorded:</span>{" "}
        {"the crawl did not capture what this check needs, so verify it by eye before quoting it."}
      </p>
    );
  }
  return null;
}

/**
 * The ordering bar. Length only, no figure, no units, wearing the identity
 * hue. `drawn` and `reduced` are the same first-draw gate `FixFirst`'s
 * meter used and carry the same meaning: `drawn` is the parent section's
 * one-shot "this block has been drawn" flag, `reduced` is the viewer's
 * reduced-motion preference, which removes the transition entirely.
 *
 * LIMIT, stated rather than assumed: with `drawn` false the fill sits at
 * zero length, which reads as "nothing here" rather than "not drawn yet".
 * That is the same behaviour the shipped meter has, and it is why this
 * renders only inside an opened detail: in the wired card the section has
 * drawn long before a rep can tap a row open. This component does not
 * detect or correct a caller that passes `drawn={false}` permanently.
 */
function RankingBar({
  pct, hue, drawn, reduced,
}: {
  pct: number;
  hue: { from: string; to: string };
  drawn: boolean;
  reduced: boolean;
}) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
      <span
        className="block h-full rounded-full"
        style={{
          width: `${width}%`,
          transform: drawn ? "scaleX(1)" : "scaleX(0)",
          transformOrigin: "left",
          transition: reduced ? "none" : "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          background: `linear-gradient(90deg, ${hue.from}, ${hue.to})`,
          boxShadow: `0 0 8px ${hue.to}55`,
        }}
      />
    </span>
  );
}

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
   *  `checkEvidenceFor`. Null is a valid value and renders no evidence
   *  line at all, which is what `BattleCard.tsx`'s MeasuredLine does with
   *  it: with no blob there is nothing to distinguish "not recorded" from
   *  "very old row". */
  signals: Record<string, unknown> | null;
  /** The weighted composite points this capability would recover for this
   *  lead, from `Matched.recoverable`. Printed on the row in `FixFirst`'s
   *  convention. Null means UNSCORED, which is every state except
   *  `scored`, and renders nothing at all rather than a zero. */
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
              cyan FixFirst prints. The cyan is the metric's own identity,
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
                      <EvidenceLine code={code} signals={signals} />
                    </li>
                  );
                })}
              </ul>
              {ranking !== null && hue && (
                <div className="mt-3">
                  <RankingBar pct={ranking} hue={hue} drawn={drawn} reduced={reduced} />
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-muted/80">
                    {"The figure on the row, drawn against the largest one in this list. It is points back on their overall score, which is the same number the rest of this card counts in."}
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
          {state.kind === "noWebsite" && (
            <div>
              <p className={SECTION_LABEL}>Where this stands today</p>
              <p className={CONTEXT_TEXT}>
                {"There is no website for this business yet, so none of this has been measured and none of it exists to be fixed. Read this as part of what gets built, not as a list of things that are wrong."}
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
          <div>
            <p className={SECTION_LABEL}>What we deliver</p>
            <ul className="mt-1.5 space-y-1">
              {capability.whatWeDeliver.map((item) => (
                <li key={item} className="flex gap-2 text-xs leading-relaxed text-fg-muted">
                  <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-dim" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            {failedCodes.length > 0 && (
              <ul className="mt-2.5 space-y-1 border-l border-bg-border pl-3">
                {failedCodes.map((code) => {
                  const fix = fixLineFor(code);
                  if (!fix) return null;
                  return (
                    <li key={code} className="text-xs leading-relaxed text-fg-dim">
                      <span className="font-medium text-fg-muted">We&apos;d fix it:</span> {fix}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Layer 5. */}
          <div className="border-t border-bg-border pt-3">
            <p className={SECTION_LABEL}>When to sell it</p>
            <p className="mt-1.5 text-xs font-semibold text-fg-dim">{STAGE_HEADING[capability.stage]}</p>
            {capability.stageReason && <p className={CONTEXT_TEXT}>{capability.stageReason}</p>}
          </div>

          {capability.source && (
            <p className="text-[11px] leading-relaxed text-fg-muted/70">Source: {capability.source}</p>
          )}
        </div>
      )}
    </li>
  );
}

export default CapabilityRow;
