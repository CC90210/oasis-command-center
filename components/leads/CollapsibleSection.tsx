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
 */

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function CollapsibleSection({
  title,
  subtitle,
  storageKey,
  defaultCollapsed = true,
  collapsedPreview,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  storageKey?: string;
  defaultCollapsed?: boolean;
  collapsedPreview?: ReactNode;
  children: ReactNode;
}) {
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
    <section className="rounded-xl border border-bg-border bg-bg-panel shadow-card transition-all">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between gap-4 px-5 py-3 text-left hover:bg-bg-elev/40 transition-colors"
        aria-expanded={!isCollapsed}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4 text-fg-dim flex-shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-fg-dim flex-shrink-0" />
            )}
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-fg">
              {title}
            </h2>
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
      {!isCollapsed && (
        <div className="border-t border-bg-border p-5">{children}</div>
      )}
    </section>
  );
}
