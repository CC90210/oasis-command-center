/**
 * Fold — a labelled disclosure section for the Settings page.
 *
 * CC, 2026-08-17, on the Credentials card: he wanted the two halves
 * "collapsible/foldable with clean headers" instead of both panels always open,
 * which made one card the tallest thing on the page.
 *
 * Native `<details>/<summary>`, matching what AutomationsContent and the AI-setup
 * sections already use, rather than a new state-managed accordion. It keeps this
 * a SERVER component — no "use client", no hydration for a control the browser
 * has implemented for a decade — and it stays open/closed correctly if JS never
 * loads. The rotation is the same `group-open:rotate-90` idiom used elsewhere,
 * so this reads as the page's existing language rather than a new dialect.
 *
 * `hint` renders in the header and stays visible while COLLAPSED, on purpose. A
 * fold that hides what is behind it makes the operator open all of them to find
 * anything, which is how a tidier page becomes a slower one.
 */
export function Fold({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** One line describing what is inside — shown collapsed, so it stays useful. */
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-xl border border-bg-border bg-bg-deep/30 overflow-hidden
                 transition-colors open:bg-bg-deep/50"
    >
      <summary
        className="cursor-pointer select-none list-none px-4 py-3 flex items-start gap-3
                   hover:bg-bg-hover/60 transition-colors"
      >
        <span
          aria-hidden
          className="mt-0.5 text-fg-dim text-[10px] transition-transform duration-200
                     group-open:rotate-90"
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-bold uppercase tracking-wider text-fg-muted">
            {title}
          </span>
          {hint && (
            <span className="mt-0.5 block text-[11px] leading-relaxed text-fg-dim">{hint}</span>
          )}
        </span>
      </summary>
      {/* Padding lives here, not on <details>, so the collapsed bar is compact
          while the open body still breathes. */}
      <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}
