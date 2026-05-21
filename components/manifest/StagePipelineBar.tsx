/**
 * StagePipelineBar — Salesforce "Path" component.
 *
 * Renders the chevron-arrow stage chain that Adon's team pattern-matches
 * against from Salesforce. Each stage is a clickable chip that filters
 * the table below by `stage=<key>`. The currently-active stage is bold
 * + underlined; others render with their stage color at slightly reduced
 * opacity so the active one pops.
 *
 * Visual technique: a horizontal flex row of <li> elements where each
 * element has a `clip-path` polygon that gives it the arrow shape (cut
 * triangle on the right, matching notch on the left of the next item).
 * No SVG, no images — pure CSS so it reflows on narrow viewports and
 * the colors come straight from inline `style` to match the per-stage
 * hex codes exactly.
 *
 * Counts: optional `counts` map (key → number) renders the number of
 * records currently in that stage as a small badge on the chip.
 */

import Link from "next/link";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";

type Props = {
  stages: StageMeta[];
  activeKey: string | null;
  /** href base; this component appends `?<paramName>=<key>` (or removes it for "All"). */
  basePath: string;
  /** optional per-stage record counts to render as a badge */
  counts?: Record<string, number>;
  /** URL parameter used for the filter. Default "stage"; the
   *  PipelineSuperview's Opportunity-side passes "opp_stage" so two
   *  bars on the same page can filter independently. */
  paramName?: string;
};

export function StagePipelineBar({ stages, activeKey, basePath, counts, paramName = "stage" }: Props) {
  return (
    <nav
      aria-label="Pipeline stages"
      // 2026-05-21 redesign: prior layout kept all chips on a single row
      // with overflow-x-auto + clip-path chevrons, which forced operators
      // with 11+ stages to horizontally scroll to see the last few. CC's
      // explicit ask: "all 11 stages need to be listed horizontally,
      // exactly the same as sunbiz, no scroll." The new layout uses
      // flex-wrap pills (no chevron clip-path) so every stage is visible
      // at once — wraps to a second row on narrower viewports instead
      // of disappearing off-screen. Matches the pill-tab pattern Sun Biz
      // uses on /leads (LeadsTableClient.tsx).
      className="w-full"
    >
      <ul className="flex flex-wrap items-stretch gap-1.5">
        {/* "All" pill — first; un-coloured so it's distinct from the
            stage chips. Acts as the "clear filter" affordance. */}
        <li>
          <Link
            href={basePath}
            className={`inline-flex items-center justify-center h-8 px-3 text-[11.5px] font-semibold uppercase tracking-wider rounded-md border transition-colors ${
              activeKey === null
                ? "border-accent bg-accent/10 text-accent"
                : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg hover:border-accent/40"
            }`}
          >
            All
          </Link>
        </li>
        {stages.map((stage) => {
          const isActive = stage.key === activeKey;
          const count = counts?.[stage.key];
          return (
            <li key={stage.key}>
              <Link
                href={`${basePath}?${paramName}=${encodeURIComponent(stage.key)}`}
                aria-current={isActive ? "page" : undefined}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[11.5px] font-semibold whitespace-nowrap transition-transform hover:translate-y-[-1px]"
                style={{
                  background: stage.bg,
                  color: stage.fg,
                  opacity: activeKey === null || isActive ? 1 : 0.82,
                  boxShadow: isActive ? `0 0 0 2px ${stage.bg}, 0 0 0 3px var(--accent, #5eb1ff)` : "none",
                }}
              >
                <span className={isActive ? "underline underline-offset-4 decoration-2" : ""}>
                  {stage.label}
                </span>
                {typeof count === "number" && (
                  <span
                    className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-mono"
                    style={{
                      background: "rgba(0,0,0,0.32)",
                      color: stage.fg,
                    }}
                  >
                    {count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
