/**
 * SettingsSection — a Card that collapses.
 *
 * CC, 2026-08-17: *"instead of it being a long page with all these different
 * features and settings, it should be a bunch of subheadings that I can click
 * on. For example, when I click on Team, it opens up all of the capabilities and
 * features… That's all I'm asking for."*
 *
 * Visually identical to `<Card>` when open — same rounded-xl panel on a
 * hairline, same sentence-case 14px header — so a section and a card side by
 * side read as one system. The only additions are a chevron and the fact that
 * the header is now a button. (OASIS OS, 2026-09-28: the uppercase-tracked title
 * and the `card-glow` / `shadow-card` chrome went with Card's; a section sits on
 * the canvas's plane, and only overlays carry a shadow.)
 *
 * NATIVE <details>, so this stays a SERVER component: no "use client", no
 * hydration cost for a disclosure the browser has implemented for a decade, and
 * it still opens and closes if JS never arrives. Matches the idiom already in
 * AutomationsContent, and the same one this component's `nested` tone absorbed.
 *
 * WHERE THE `action` GOES, AND WHY IT IS NOT IN THE SUMMARY.
 * Everything inside <summary> is part of the toggle target, so a header button
 * or link would fire ITS action and flip the section at the same time — "Pair a
 * machine →" would navigate while the panel it sat on animated open behind it.
 * Putting the action in the body instead would hide it whenever the section is
 * closed, which is worse: the whole point of a collapsed page is to act without
 * expanding.
 *
 * So the action is absolutely positioned over the header, a sibling of <summary>
 * rather than a child. It stays visible while collapsed, it is outside the
 * click-to-toggle region, and no JavaScript is needed to keep those two facts
 * true. `pr-44` on the summary reserves the room so a long title never slides
 * underneath it.
 */
export function SettingsSection({
  title,
  subtitle,
  action,
  defaultOpen = false,
  tone = "panel",
  id,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** Rendered top-right, outside the toggle target. */
  action?: React.ReactNode;
  /** Open on first paint. Reserve for the one or two sections most visits need. */
  defaultOpen?: boolean;
  /**
   * `panel` is a top-level settings section and carries Card's chrome.
   * `nested` is a sub-section INSIDE one — recessed rather than raised, so a
   * fold within a fold reads as depth instead of as two siblings.
   *
   * This absorbed a second component. The collapsing work shipped `Fold` for the
   * sub-sections first and `SettingsSection` for the top-level ones after — two
   * files implementing the same details/summary/chevron mechanism, which means
   * every later fix to the animation, the a11y or the click target has to be
   * made twice and will eventually be made once.
   */
  tone?: "panel" | "nested";
  id?: string;
  children: React.ReactNode;
}) {
  const shell =
    tone === "panel"
      ? "rounded-xl border border-hairline bg-bg-panel"
      : "rounded-xl border border-hairline bg-bg-deep/30 open:bg-bg-deep/50";
  return (
    // scroll-mt: a fragment link (#providers) lands the header clear of the
    // top edge instead of flush against it.
    <details id={id} open={defaultOpen} className={`group relative scroll-mt-6 transition-colors duration-150 ${shell}`}>
      <summary
        className="cursor-pointer select-none list-none flex items-start gap-3 px-4 py-3
                   pr-44 rounded-xl group-open:rounded-b-none
                   hover:bg-bg-hover/40 transition-colors duration-150
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
      >
        <span
          aria-hidden
          className="mt-[3px] shrink-0 text-fg-dim text-[10px] transition-transform duration-150
                     group-open:rotate-90 motion-reduce:transition-none"
        >
          ▸
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-fg">
            {title}
          </span>
          {subtitle && <span className="mt-0.5 block text-[13px] leading-5 text-fg-muted">{subtitle}</span>}
        </span>
      </summary>

      {action && (
        // Sibling of <summary>, not a child — see the note above. `top-3` lines
        // it up with the first row of the title rather than the block's centre,
        // which drifts as subtitles wrap to two and three lines.
        <div className="absolute right-4 top-2.5 z-10">{action}</div>
      )}

      {/* The divider belongs to the OPEN state. Rendering it always would draw a
          line under a closed section and make it look like an empty panel.
          A nested fold skips it — inside an already-bordered panel it reads as
          clutter rather than as structure. */}
      <div className={tone === "panel" ? "border-t border-hairline p-4" : "px-4 pb-4 pt-1"}>
        {children}
      </div>
    </details>
  );
}
