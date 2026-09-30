"use client";

import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Menu, Search, Settings2, X } from "lucide-react";
import type { CalendarView } from "@/lib/calendar/types";

export const VIEW_LABELS: Record<CalendarView, { label: string; key: string }> = {
  day: { label: "Day", key: "D" },
  "4day": { label: "4 days", key: "X" },
  week: { label: "Week", key: "W" },
  month: { label: "Month", key: "M" },
  year: { label: "Year", key: "Y" },
  schedule: { label: "Schedule", key: "A" },
};

type Props = {
  title: string;
  view: CalendarView;
  query: string | null;
  saving: boolean;
  onMenu: () => void;
  onToday: () => void;
  onStep: (dir: -1 | 1) => void;
  onView: (v: CalendarView) => void;
  onQuery: (q: string | null) => void;
  onSettings: () => void;
  onShortcuts: () => void;
};

export function Toolbar({ title, view, query, saving, onMenu, onToday, onStep, onView, onQuery, onSettings, onShortcuts }: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = query !== null;
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2 md:flex-nowrap md:gap-3">
      <button type="button" className="icon-btn" onClick={onMenu} aria-label="Toggle sidebar">
        <Menu className="h-5 w-5" />
      </button>
      <h1 className="mr-1 hidden text-base font-semibold tracking-tight text-fg lg:block">Schedule</h1>

      {searching ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1 md:max-w-md">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-fg-dim" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search events"
              placeholder="Search titles, places, notes, guests"
              className="input h-9 pl-8"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && onQuery(null)}
            />
          </div>
          <button type="button" className="icon-btn" onClick={() => onQuery(null)} aria-label="Close search">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="btn" onClick={onToday} title="Today (T)">
            Today
          </button>
          <div className="flex">
            <button type="button" className="icon-btn" onClick={() => onStep(-1)} aria-label="Previous period" title="Previous (K)">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button type="button" className="icon-btn" onClick={() => onStep(1)} aria-label="Next period" title="Next (J)">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <h2 className="min-w-0 flex-1 truncate text-lg font-medium text-fg" aria-live="polite">
            {title}
          </h2>
        </>
      )}

      <span className="sr-only" aria-live="polite">{saving ? "Saving" : ""}</span>
      {saving && <span className="hidden text-[11px] text-fg-dim sm:inline">Saving…</span>}

      <div className="ml-auto flex items-center gap-1">
        {!searching && (
          <button type="button" className="icon-btn" onClick={() => onQuery("")} aria-label="Search (/)" title="Search (/)">
            <Search className="h-4 w-4" />
          </button>
        )}
        <button type="button" className="icon-btn hidden sm:inline-grid" onClick={onShortcuts} aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)">
          <Keyboard className="h-4 w-4" />
        </button>
        <button type="button" className="icon-btn" onClick={onSettings} aria-label="Calendar settings" title="Settings">
          <Settings2 className="h-4 w-4" />
        </button>
        <label className="sr-only" htmlFor="cal-view-select">View</label>
        <select id="cal-view-select" className="select h-8 w-auto py-0 text-[13px] md:hidden" value={view} onChange={(e) => onView(e.target.value as CalendarView)}>
          {(Object.keys(VIEW_LABELS) as CalendarView[]).map((v) => (
            <option key={v} value={v}>{VIEW_LABELS[v].label}</option>
          ))}
        </select>
        <div className="seg ml-1 hidden md:inline-flex" role="group" aria-label="View">
          {(Object.keys(VIEW_LABELS) as CalendarView[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)} title={`${VIEW_LABELS[v].label} (${VIEW_LABELS[v].key})`}>
              {VIEW_LABELS[v].label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
