/**
 * SettingsSection — a Card that collapses.
 *
 * CC, 2026-08-17: *"instead of it being a long page with all these different
 * features and settings, it should be a bunch of subheadings that I can click
 * on. For example, when I click on Team, it opens up all of the capabilities and
 * features… That's all I'm asking for."*
 *
 * Visually identical to `<Card>` when open — same rounded-xl panel, same
 * uppercase-tracked header, same 20px body — because this replaces Card on the
 * settings page and the page should not appear to have been rebuilt. The only
 * additions are a chevron and the fact that the header is now a button.
 *
 * NATIVE <details>, so this stays a SERVER component: no "use client", no
 * hydration cost for a disclosure the browser has implemented for a decade, and
 * it still opens and closes if JS never arrives. Matches the idiom already in
 * AutomationsContent and components/settings/Fold.
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
  id,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** Rendered top-right, outside the toggle target. */
  action?: React.ReactNode;
  /** Open on first paint. Reserve for the one or two sections most visits need. */
  defaultOpen?: boolean;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      open={defaultOpen}
      className="group relative rounded-xl border border-bg-border bg-bg-panel shadow-card
                 card-glow transition-all"
    >
      <summary
        className="cursor-pointer select-none list-none flex items-start gap-3 px-5 py-3.5
                   pr-44 rounded-xl group-open:rounded-b-none
                   hover:bg-bg-hover/40 transition-colors"
      >
        <span
          aria-hidden
          className="mt-[3px] shrink-0 text-fg-dim text-[10px] transition-transform duration-200
                     group-open:rotate-90"
        >
          ▸
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-bold uppercase tracking-[0.14em] text-fg">
            {title}
          </span>
          {subtitle && <span className="mt-1 block text-xs text-fg-muted">{subtitle}</span>}
        </span>
      </summary>

      {action && (
        // Sibling of <summary>, not a child — see the note above. `top-3` lines
        // it up with the first row of the title rather than the block's centre,
        // which drifts as subtitles wrap to two and three lines.
        <div className="absolute right-5 top-3 z-10">{action}</div>
      )}

      {/* The divider belongs to the OPEN state. Rendering it always would draw a
          line under a closed section and make it look like an empty panel. */}
      <div className="border-t border-bg-border p-5">{children}</div>
    </details>
  );
}
