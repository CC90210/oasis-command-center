"use client";

/**
 * RailGroup — a sentence-case, collapsible group of rail rows ("Departments",
 * "Sales", "Marketing"). An unlabelled group renders its rows with no header.
 *
 * Collapse state is a per-viewer convenience kept in localStorage. It is read
 * after mount, not during render, so the server HTML (always expanded) and the
 * first client render agree and hydration stays clean; a viewer who collapsed a
 * group sees it close one frame later, which is the right trade against a
 * hydration error on every page.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const STORAGE_PREFIX = "oasis.os.rail-group.v1:";

export function RailGroup({
  id,
  label,
  children,
}: {
  /** Stable group id (OsNavGroup.id) — the storage key. */
  id: string;
  /** Null renders the rows with no header and no collapse. */
  label: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const listId = useId();

  useEffect(() => {
    if (!label) return;
    try {
      if (window.localStorage.getItem(STORAGE_PREFIX + id) === "0") setOpen(false);
    } catch {
      // Blocked storage: the group simply starts open.
    }
  }, [id, label]);

  if (!label) {
    return <ul className="space-y-px">{children}</ul>;
  }

  const toggle = () => {
    setOpen((was) => {
      const next = !was;
      try {
        window.localStorage.setItem(STORAGE_PREFIX + id, next ? "1" : "0");
      } catch {
        // Convenience only; the toggle still works for this page view.
      }
      return next;
    });
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={listId}
        className="flex h-7 w-full items-center gap-1 rounded-md px-2.5 text-[12.5px] font-medium text-fg-dim outline-none transition-colors duration-150 hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span className="min-w-0 truncate text-left">{label}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className={`shrink-0 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      <ul id={listId} hidden={!open} className="mt-px space-y-px">
        {children}
      </ul>
    </div>
  );
}
