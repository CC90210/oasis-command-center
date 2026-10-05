"use client";

/**
 * audit-parts.tsx — the three renderers every audit surface in this feature
 * draws, in one place.
 *
 * WHY IT EXISTS (Task 5, 2026-09-14). `Meter`, `MeasuredLine` and
 * `RemedyLines` were module-private inside `BattleCard.tsx`. When the
 * capability catalogue was built (Task 4) it could not import them, so it
 * reimplemented them, and within one task three differences appeared between
 * the two copies that nobody chose:
 *
 *   1. the catalogue's bar dropped the tick overlay, and both bars render on
 *      the same card;
 *   2. the "Not recorded" sentence was reworded and lost the data typeface;
 *   3. the unmeasurable-check table existed twice, in two files that cannot
 *      see each other.
 *
 * None of those were decisions. They are what a private component costs when
 * a second surface needs it, so the components live here now and both
 * surfaces render the same markup from the same source.
 *
 * WHAT IS DELIBERATELY NOT CONVERGED ON THIS, AND WHY. `CallMode.tsx` also
 * renders `remedyFor`'s two sentences, and it keeps its own markup. It is not
 * a copy of this renderer that drifted: it never imported one, it takes the
 * same two strings from the same `remedyFor` call, and its differences
 * (semibold labels, a wider gap, no wrapping div) are the overlay's own type
 * scale, which is larger than the card's because a rep reads it at arm's
 * length with a stranger on the line. Converging it would be a VISUAL change
 * to a surface this change did not otherwise touch, and it would buy nothing:
 * the words, which are the part that can drift into a false claim, already
 * have exactly one source. The same reasoning does not apply to the two
 * copies above, which were copies, of a renderer, that did drift.
 *
 * WHAT THIS FILE DOES NOT DO. No I/O, no state, no hooks. It reads no audit
 * and computes no score: `Meter` is handed a length, `MeasuredLine` is handed
 * a code and the crawler's own blob, `RemedyLines` is handed a code. The
 * words come from `remedies.ts` and `check-evidence.ts` and are never
 * reworded on the way through.
 *
 * COLOUR. The only colour any of these carries is the dimension identity hue
 * the CALLER passes to `Meter` and the one constant cyan every telemetry
 * accent in this feature wears, worn identically whatever the value. Nothing
 * here is tinted by a score, a stage or a judgement, and this file is on the
 * colour ban list in `tests/web-leads-guards.test.ts`.
 */

import { evidenceStateFor, type EvidenceState } from "@/lib/web-leads/check-evidence";
import { remedyFor } from "@/lib/web-leads/remedies";

/** "Costs them:" / "We'd fix it:" as one pair, from the hand-written table in
 *  remedies.ts. Renders nothing when a code has no entry rather than an empty
 *  bullet or the word "undefined".
 *
 *  `CapabilityRow.tsx` deliberately does NOT use this pair: it splits the two
 *  lines apart so each sits under the block it grounds, which is a layout
 *  decision documented there. Both surfaces take the sentences themselves
 *  from `remedyFor` and reword neither. */
export function RemedyLines({ code }: { code: string }) {
  const remedy = remedyFor(code);
  if (!remedy) return null;
  return (
    <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-fg-dim">
      <p><span className="font-medium text-fg-muted">Costs them:</span> {remedy.costs}</p>
      <p><span className="font-medium text-fg-muted">We&apos;d fix it:</span> {remedy.fix}</p>
    </div>
  );
}

/**
 * The pinpointed measurement behind one check (Adon, 2026-09-01: "you have to
 * pinpoint things in the website that are showing that"). Renders the
 * crawler's own numbers for THIS site next to the check they decided --
 * "Server took 2,340 ms to send its first byte; under 800 ms earns the
 * point." -- so a score is never a number a rep has to take on faith.
 *
 * The four states and the order they are tried in belong to
 * `evidenceStateFor` in `lib/web-leads/check-evidence.ts`; this renders
 * whichever one it returns and decides nothing. Taking a STATE rather than a
 * code is also what lets a test render the unmeasurable branch, which is
 * otherwise unreachable while the table is empty, without writing into module
 * state.
 */
export function CheckEvidenceLine({ state }: { state: EvidenceState }) {
  if (state.kind === "unmeasurable") {
    return (
      <p className="mt-1.5 text-xs leading-relaxed text-fg-dim [font-family:var(--battle-data)]">
        <span className="font-medium text-fg-muted">Not measurable:</span> {state.note}
      </p>
    );
  }
  if (state.kind === "measured") {
    return (
      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted [font-family:var(--battle-data)]">
        <span className="font-medium" style={{ color: "#7dd3fc" }}>Seen on the site:</span> {state.line}
      </p>
    );
  }
  if (state.kind === "unmeasured") {
    return (
      <p className="mt-1.5 text-xs leading-relaxed text-fg-dim [font-family:var(--battle-data)]">
        <span className="font-medium text-fg-muted">Not recorded:</span> the crawl did not capture what this check
        needs, so treat this line with caution and verify by eye before quoting it.
      </p>
    );
  }
  return null;
}

/** The same line, resolved from a code and the crawler's blob. Every call
 *  site in the application uses this form; `CheckEvidenceLine` is the seam a
 *  test renders a specific state through. */
export function MeasuredLine({ code, signals }: { code: string; signals: Record<string, unknown> | null }) {
  return <CheckEvidenceLine state={evidenceStateFor(code, signals)} />;
}

/** The bar's LENGTH is the value; its colour, when a `hue` is given, is the
 *  dimension's fixed identity hue (see battle-hud.ts) -- the same hue at 4 as
 *  at 94, so rule 1 holds. With no hue it stays the neutral fill. The tick
 *  overlay segments the fill into a HUD readout; it is engraved on the track,
 *  identical at every value. */
export function Meter({
  value, drawn, reduced, hue,
}: {
  value: number;
  drawn: boolean;
  reduced: boolean;
  hue?: { from: string; to: string };
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
      {/* Drawn with transform, not width (round 9): width is a layout
          property and animating it re-lays-out every frame; scaleX from a
          left origin is the identical picture on the compositor. */}
      <span
        className={hue ? "block h-full rounded-full" : "block h-full rounded-full bg-fg-dim"}
        style={{
          width: `${pct}%`,
          transform: drawn ? "scaleX(1)" : "scaleX(0)",
          transformOrigin: "left",
          transition: reduced ? "none" : "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          background: hue ? `linear-gradient(90deg, ${hue.from}, ${hue.to})` : undefined,
          boxShadow: hue ? `0 0 8px ${hue.to}55` : undefined,
        }}
      />
      <span
        className="absolute inset-0"
        style={{ background: "repeating-linear-gradient(90deg, transparent 0px, transparent 7px, rgba(6,7,10,0.6) 7px, rgba(6,7,10,0.6) 8px)" }}
      />
    </span>
  );
}
