"use client";

/**
 * CollapsibleSection — wraps a server-rendered block in a client-side
 * collapse toggle. Used in the pipeline lead drawer to hide the contact
 * metadata band + full edit form behind a single click so the operator's
 * eye lands on the action toolbar + lifecycle buttons instead.
 *
 * Persistence is per-storage-key via localStorage so the operator's
 * choice survives navigation. Provide a stable storageKey or omit it
 * for ephemeral state.
 *
 * The `collapsedPreview` slot lets the caller show a compact one-line
 * summary while collapsed — name+company+email tag for the contact
 * band, for instance.
 *
 * `keepMounted` (Codex review round 2, 2026-10-10): default false unmounts
 * `children` while collapsed (the pipeline drawer's own form/band hold
 * nothing worth keeping once hidden). A caller whose children hold state
 * that must survive a collapse - the Oasis Whiteboard's canvas and undo
 * history, a Tools card's in-progress form and poll timers
 * (app/founders/marketing/tools/page.tsx) - passes `keepMounted` instead:
 * `children` stay in the tree always, hidden with the `hidden` attribute
 * (display:none), so React never unmounts them on a collapse/reopen.
 *
 * HEADING STRUCTURE (Codex review round 3, 2026-10-10, LOW): the toggle is
 * now `<h2><button aria-expanded aria-controls>` - the standard WAI-ARIA
 * disclosure pattern - not `<button><h2>`. A heading INSIDE a button is
 * presentational to assistive tech (a button may only contain phrasing
 * content), so it never reaches heading navigation; wrapping the button in
 * the heading instead means the heading is real. The outer `<h2>` carries
 * `display: contents` so it adds no box of its own, and the section itself
 * is `aria-labelledby` that same heading, so a screen reader also names the
 * region (which the Whiteboard section on Content Tools had lost entirely).
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function CollapsibleSection({
  title,
  subtitle,
  storageKey,
  defaultCollapsed = true,
  collapsedPreview,
  keepMounted = false,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  storageKey?: string;
  defaultCollapsed?: boolean;
  collapsedPreview?: ReactNode;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const reactId = useId();
  const headingId = `${reactId}-heading`;
  const panelId = `${reactId}-panel`;
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!storageKey) {
      setCollapsed(defaultCollapsed);
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === "0") setCollapsed(false);
      else if (raw === "1") setCollapsed(true);
      else setCollapsed(defaultCollapsed);
    } catch {
      setCollapsed(defaultCollapsed);
    }
  }, [storageKey, defaultCollapsed]);

  const isCollapsed = collapsed ?? defaultCollapsed;

  function toggle() {
    const next = !isCollapsed;
    setCollapsed(next);
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // localStorage blocked — toggle still works for this session.
      }
    }
  }

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-bg-border bg-bg-panel shadow-card transition-all">
      <h2 id={headingId} className="contents">
        <button
          type="button"
          onClick={toggle}
          className="w-full flex items-center justify-between gap-4 px-5 py-3 text-left hover:bg-bg-elev/40 transition-colors"
          aria-expanded={!isCollapsed}
          aria-controls={panelId}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isCollapsed ? (
                <ChevronRight className="w-4 h-4 text-fg-dim flex-shrink-0" />
              ) : (
                <ChevronDown className="w-4 h-4 text-fg-dim flex-shrink-0" />
              )}
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-fg">
                {title}
              </span>
            </div>
            {subtitle && (
              <div className="text-xs text-fg-muted mt-1 ml-6">{subtitle}</div>
            )}
            {isCollapsed && collapsedPreview && (
              <div className="text-sm text-fg-muted mt-1.5 ml-6 truncate">
                {collapsedPreview}
              </div>
            )}
          </div>
        </button>
      </h2>
      {keepMounted ? (
        <div id={panelId} className="border-t border-bg-border p-5" hidden={isCollapsed}>
          {children}
        </div>
      ) : (
        !isCollapsed && (
          <div id={panelId} className="border-t border-bg-border p-5">
            {children}
          </div>
        )
      )}
    </section>
  );
}
