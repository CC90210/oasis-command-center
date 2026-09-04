"use client";

/**
 * RivalComparison — the one competitor instrument on the battle card.
 *
 * ═══ WHY IT REPLACED TWO THINGS ════════════════════════════════════════════
 *
 * Adon, 2026-09-03: "there's a redundant aspect where you added a secondary
 * graph that's also showing all of the different aspects of that... if you're
 * gonna do that, the graph has to be much nicer, much cleaner... and you
 * should be clicking into every single one of their competitors."
 *
 * He was right twice. The card carried a second WebGL instrument that redrew
 * the same seven dimensions the radar already draws, AND a flat list under it
 * repeating those same numbers a third time — all of it against exactly ONE
 * competitor, while three competitor names sat above it that a rep could not
 * open. Both are gone; this is what replaced them.
 *
 * ═══ WHY THIS SHAPE AND NOT ANOTHER RADAR ══════════════════════════════════
 *
 * The radar answers "what shape is this site?" — a silhouette, all seven areas
 * at once, no second party in it. A comparison has to answer a DIFFERENT
 * question or it is redundant by construction, and the question a rep is
 * actually asking on the call is "where do they lose to the businesses they
 * compete with, and by how much?"
 *
 * That question is linear and ranked, so the grammar here is linear and
 * ranked: one track per area on a shared 0-100 baseline, the prospect's mark
 * and the rival's mark on it, and THE DISTANCE BETWEEN THEM DRAWN AS A BAR.
 * The bar is the signature: the gap is not something a rep has to compute
 * from two numbers, it is the thing they see. Rows sort by that gap, so the
 * first row is the conversation.
 *
 * ═══ THE RULES IT DOES NOT GET TO BREAK ════════════════════════════════════
 *
 * 1. NO COLOUR IS KEYED TO A SCORE. Colour answers WHOSE mark this is: the
 *    prospect is always cyan, and each rival wears one fixed hue with the
 *    top-ranked keeping the GOLD the radar already outlines it in — so the
 *    business the radar calls the benchmark is the same colour here. A rival
 *    ahead and a rival behind wear the same hue at every score, and the
 *    palette is warm/neutral with no traffic-light red or green in it.
 * 2. THE GAP'S SIGN IS A FACT, NOT A VERDICT. Ahead and behind are rendered
 *    with a signed number and the direction the bar runs, never with red and
 *    green.
 * 3. EVERY WORD IS MEASURED. The per-area detail quotes the prospect's own
 *    failing checks from the audit; nothing here is generated.
 * 4. `prefers-reduced-motion` settles everything instantly.
 */

import { useMemo, useState } from "react";
import type { Rival } from "@/lib/web-leads/competitors";
import type { DimensionProfile } from "@/lib/web-leads/audit";
import { hueFor, CYAN } from "./battle-hud";
import { remedyFor } from "@/lib/web-leads/remedies";

/**
 * WHOSE mark, by rank. Rank 1 keeps GOLD because the radar already outlines
 * that same business in gold; the rest are warm/neutral so they can never be
 * confused with the cool identity hues the seven AREAS wear. No green, no
 * red: a rival is not a verdict.
 */
const RIVAL_HUES = ["#fbbf24", "#fb923c", "#f472b6", "#94a3b8", "#fcd34d"];
const rivalHue = (i: number) => RIVAL_HUES[i % RIVAL_HUES.length];

const clamp = (n: number) => Math.min(100, Math.max(0, n));

type Props = {
  rivals: Rival[];
  /** The prospect's own dimensions, for the failing-check detail. */
  dimensions: DimensionProfile[];
  leadName: string;
  reduced: boolean;
};

export function RivalComparison({ rivals, dimensions, leadName, reduced }: Props) {
  // null = compare against ALL of them at once (the field view).
  const [activeIdx, setActiveIdx] = useState<number | null>(0);
  const [openArea, setOpenArea] = useState<string | null>(null);

  const checksByKey = useMemo(
    () => new Map(dimensions.map((d) => [d.key, d.checks.filter((c) => !c.has).sort((a, b) => b.points - a.points)])),
    [dimensions],
  );

  /**
   * One row per area. When a single rival is selected the gap is against that
   * rival; in the field view it is against the BEST score any rival posted in
   * that area, because that is the bar the prospect actually has to clear.
   */
  const rows = useMemo(() => {
    const base = rivals[0]?.dimensions ?? [];
    return base
      .map((d) => {
        const perRival = rivals.map((r, i) => {
          const row = r.dimensions.find((x) => x.key === d.key);
          return { idx: i, name: r.competitor.name, score: row ? row.leader : 0 };
        });
        const best = perRival.reduce((m, p) => (p.score > m.score ? p : m), perRival[0] ?? { idx: 0, name: "", score: 0 });
        const against = activeIdx === null ? best.score : (perRival[activeIdx]?.score ?? 0);
        return {
          key: d.key,
          label: d.label,
          theirs: d.theirs,
          against,
          gap: d.theirs - against,
          perRival,
          bestName: best.name,
        };
      })
      // Biggest deficit first: the first row a rep reads is the conversation.
      .sort((a, b) => a.gap - b.gap);
  }, [rivals, activeIdx]);

  if (!rivals.length) return null;

  const activeName = activeIdx === null ? "the best of them" : rivals[activeIdx].competitor.name;

  return (
    <div>
      {/* ── who are we comparing against ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {rivals.map((r, i) => {
          const on = activeIdx === i;
          const hue = rivalHue(i);
          return (
            <button
              key={`${r.competitor.name}-${i}`}
              type="button"
              onClick={() => { setActiveIdx(i); setOpenArea(null); }}
              aria-pressed={on}
              className={`group/riv inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none ${
                on ? "border-accent/50 bg-bg-raised/80" : "border-bg-border bg-bg-panel/60 hover:border-accent/30"
              }`}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: hue, boxShadow: on ? `0 0 8px ${hue}` : "none" }}
              />
              <span className="min-w-0">
                <span className={`block max-w-[13rem] truncate text-xs ${on ? "font-semibold text-fg" : "text-fg-muted"}`}>
                  {r.competitor.name}
                </span>
                <span className="block text-[10px] text-fg-dim [font-family:var(--battle-data)]">
                  scores {r.composite}
                </span>
              </span>
            </button>
          );
        })}
        {rivals.length > 1 && (
          <button
            type="button"
            onClick={() => { setActiveIdx(null); setOpenArea(null); }}
            aria-pressed={activeIdx === null}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none ${
              activeIdx === null ? "border-accent/50 bg-bg-raised/80 text-fg" : "border-bg-border text-fg-muted hover:border-accent/30 hover:text-fg"
            }`}
          >
            All {rivals.length} at once
          </button>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-fg-dim">
        {activeIdx === null ? (
          <>Each area shows every competitor&apos;s mark. The bar runs from {leadName} to the best score anyone posted in that area.</>
        ) : (
          <>The bar is the distance between {leadName} and {activeName} in each area. Tap an area for what is behind it.</>
        )}
      </p>

      {/* ── the gap tracks ───────────────────────────────────────────── */}
      <ul className="mt-4 space-y-1">
        {rows.map((row) => {
          const isOpen = openArea === row.key;
          const areaHue = hueFor(row.key);
          const lo = Math.min(row.theirs, row.against);
          const hi = Math.max(row.theirs, row.against);
          const behind = row.gap < 0;
          const misses = checksByKey.get(row.key) ?? [];
          return (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => setOpenArea(isOpen ? null : row.key)}
                aria-expanded={isOpen}
                className="block w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: areaHue.to }} />
                    <span className="truncate text-xs text-fg-muted">{row.label}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-fg-dim [font-family:var(--battle-data)]">
                    <span className="font-semibold text-fg">{row.theirs}</span>
                    <span className="mx-1 text-fg-dim">vs</span>
                    {row.against}
                    {/* A signed number and a direction word. Never a colour,
                        never an arrow that reads as a verdict. */}
                    <span className="ml-2 text-fg-muted">
                      ({row.gap > 0 ? "+" : ""}{row.gap})
                    </span>
                  </span>
                </span>

                {/* THE TRACK. One shared 0-100 baseline; the lit segment
                    between the two marks IS the gap, which is the whole
                    reason this instrument exists. */}
                <span aria-hidden className="relative mt-2 block h-5">
                  <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-bg-border" />
                  {/* the gap segment */}
                  <span
                    className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                    style={{
                      left: `${lo}%`,
                      width: `${Math.max(0.6, hi - lo)}%`,
                      background: behind
                        ? `linear-gradient(90deg, ${CYAN}, ${activeIdx === null ? "#fbbf24" : rivalHue(activeIdx)})`
                        : `linear-gradient(90deg, ${activeIdx === null ? "#fbbf24" : rivalHue(activeIdx)}, ${CYAN})`,
                      opacity: 0.55,
                      transition: reduced ? "none" : "left 380ms cubic-bezier(0.22,1,0.36,1), width 380ms cubic-bezier(0.22,1,0.36,1)",
                    }}
                  />
                  {/* every rival's mark, in the field view */}
                  {activeIdx === null
                    ? row.perRival.map((p) => (
                        <span
                          key={p.idx}
                          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px]"
                          style={{ left: `${clamp(p.score)}%`, background: rivalHue(p.idx), opacity: 0.9 }}
                        />
                      ))
                    : (
                      <span
                        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px]"
                        style={{
                          left: `${clamp(row.against)}%`,
                          background: rivalHue(activeIdx),
                          boxShadow: `0 0 8px ${rivalHue(activeIdx)}`,
                          transition: reduced ? "none" : "left 380ms cubic-bezier(0.22,1,0.36,1)",
                        }}
                      />
                    )}
                  {/* the prospect's mark, always a filled circle in cyan */}
                  <span
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                    style={{ left: `${clamp(row.theirs)}%`, borderColor: CYAN, background: "#06070a", boxShadow: `0 0 10px ${CYAN}88` }}
                  />
                </span>
              </button>

              {/* ── click-into detail for this one area ──────────────── */}
              {isOpen && (
                <div className="mx-2 mb-2 rounded-lg border border-bg-border bg-bg-raised/50 p-3.5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
                    {row.label} · everyone measured
                  </p>
                  <ul className="mt-2 space-y-1">
                    <li className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border-2" style={{ borderColor: CYAN }} />
                        <span className="truncate font-semibold text-fg">{leadName}</span>
                      </span>
                      <span className="tabular-nums text-fg [font-family:var(--battle-data)]">{row.theirs}</span>
                    </li>
                    {[...row.perRival].sort((a, b) => b.score - a.score).map((p) => (
                      <li key={p.idx} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span aria-hidden className="h-2 w-2 shrink-0 rotate-45 rounded-[2px]" style={{ background: rivalHue(p.idx) }} />
                          <span className="truncate text-fg-muted">{p.name}</span>
                        </span>
                        <span className="tabular-nums text-fg-dim [font-family:var(--battle-data)]">{p.score}</span>
                      </li>
                    ))}
                  </ul>

                  {misses.length > 0 ? (
                    <div className="mt-3 border-t border-bg-border pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
                        What is costing {leadName} here
                      </p>
                      <p className="mt-1.5 text-sm font-semibold text-fg">{misses[0].label}</p>
                      {remedyFor(misses[0].code) && (
                        <p className="mt-1 text-xs leading-relaxed text-fg-dim">{remedyFor(misses[0].code)!.costs}</p>
                      )}
                      {misses.length > 1 && (
                        <p className="mt-1.5 text-[11px] text-fg-muted">
                          and {misses.length - 1} other failing {misses.length - 1 === 1 ? "check" : "checks"} in this area
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-3 border-t border-bg-border pt-3 text-xs text-fg-dim">
                      Everything we check in this area passed for {leadName}.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default RivalComparison;
