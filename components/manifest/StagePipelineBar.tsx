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
      // Mobile polish (B.1): touch-action allows native momentum scrolling on
      // iOS Safari; the right-edge mask fades the last chevron's edge so an
      // overflowing bar visually telegraphs "more to the right." On viewports
      // ≥640px the content fits — the mask becomes a no-op because the row
      // ends before the fade region begins.
      className="w-full overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] [touch-action:pan-x] [scrollbar-width:thin] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] sm:[mask-image:none]"
    >
      <ul className="flex items-stretch gap-0 min-w-max">
        {/* "All" pill — sticky-left on overflow so the operator can always
            tap "All" to escape a filter without scrolling the bar back. */}
        <li className="shrink-0 sticky left-0 z-10 bg-bg-deep">
          <Link
            href={basePath}
            className={`inline-flex items-center px-3 h-9 text-[12px] font-semibold uppercase tracking-wider rounded-l-md border border-r-0 border-bg-border ${
              activeKey === null
                ? "bg-bg-elev text-fg"
                : "bg-bg-deep/40 text-fg-muted hover:text-fg"
            }`}
            style={{ minWidth: "60px" }}
          >
            All
          </Link>
        </li>
        {stages.map((stage, i) => {
          const isActive = stage.key === activeKey;
          const isFirst = false; // visual chain — first chevron is "All" above
          const isLast = i === stages.length - 1;
          const count = counts?.[stage.key];
          // Chevron polygon: cuts the right edge into a point, and notches
          // the left edge to receive the previous chevron's point.
          const clip = isLast
            ? "polygon(0 0, calc(100% - 0px) 0, 100% 50%, calc(100% - 0px) 100%, 0 100%, 12px 50%)"
            : "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)";
          return (
            <li key={stage.key} className="shrink-0 -ml-[1px]">
              <Link
                href={`${basePath}?${paramName}=${encodeURIComponent(stage.key)}`}
                className="relative inline-flex items-center justify-center gap-2 h-9 px-5 text-[12.5px] font-semibold whitespace-nowrap transition-transform hover:translate-y-[-1px]"
                style={{
                  background: stage.bg,
                  color: stage.fg,
                  clipPath: clip,
                  WebkitClipPath: clip,
                  opacity: activeKey === null || isActive ? 1 : 0.78,
                  paddingLeft: isFirst ? "16px" : "22px",
                  paddingRight: isLast ? "16px" : "22px",
                }}
                aria-current={isActive ? "page" : undefined}
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
