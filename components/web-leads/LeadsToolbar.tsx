"use client";

/**
 * LeadsToolbar — search, targeting, ordering, and the way into a call block.
 *
 * WHY THESE FOUR CONTROLS SIT TOGETHER (2026-08-23): they are the sentence a
 * rep composes before they start dialling -- "these businesses, scoring this
 * badly, worst first, go". Splitting them across a rail, a header and a table
 * header made that sentence something you assembled by hunting. The rail keeps
 * the geography and industry hierarchy, which is browsing; this bar holds the
 * decisions that turn a list into a queue.
 *
 * THE SCORE BAND IS THE ONE THAT WAS MISSING. The corpus measurement says the
 * real prospects are the ~5,258 sites scoring under 40, and that the ~2,471 at
 * 74+ will win a website-quality argument against us. Until this control
 * existed there was no way for a rep to act on either fact -- the insight was
 * in a document nobody on a phone reads.
 *
 * BANDS ARE RANGES, NOT JUDGEMENTS. "Under 40", not "weak". See filters.ts.
 */

import { Phone, Search, X } from "lucide-react";
import type { LeadSort, ScoreBand, WebLeadFilters } from "@/lib/web-leads/filters";

const BANDS: { key: ScoreBand; label: string; hint: string }[] = [
  { key: "all", label: "Any score", hint: "Every lead in the current filters" },
  { key: "under40", label: "Under 40", hint: "Sites with the most wrong, and the easiest to improve on" },
  { key: "mid", label: "40 to 59", hint: "Sites with real gaps but a working base" },
  { key: "sixty_plus", label: "60 and up", hint: "Sites that already do most things well" },
  { key: "unscored", label: "Not scored", hint: "No website on file, not measured, or we could not reach it" },
];

const SORTS: { key: LeadSort; label: string }[] = [
  { key: "opportunity", label: "Lowest score first" },
  { key: "score_desc", label: "Highest score first" },
  { key: "name", label: "Business name A to Z" },
];

export function LeadsToolbar({
  filters, onChange, total, loading, queryDraft, onQueryDraft, onStartCalling, canStartCalling,
}: {
  filters: WebLeadFilters;
  onChange: (f: WebLeadFilters) => void;
  total: number;
  loading: boolean;
  queryDraft: string;
  onQueryDraft: (v: string) => void;
  onStartCalling: () => void;
  canStartCalling: boolean;
}) {
  // Every control resets to page 1: changing what you are looking at while
  // staying on page 8 of the previous result set shows a rep an arbitrary
  // slice of their new filter and reads as "there is nothing here".
  const set = (patch: Partial<WebLeadFilters>) => onChange({ ...filters, ...patch, page: 1 });

  const chips: { label: string; clear: () => void }[] = [
    ...filters.provinces.map((p) => ({ label: p, clear: () => set({ provinces: filters.provinces.filter((x) => x !== p) }) })),
    ...filters.cities.map((c) => ({ label: c, clear: () => set({ cities: filters.cities.filter((x) => x !== c) }) })),
    ...filters.industries.map((i) => ({ label: i, clear: () => set({ industries: filters.industries.filter((x) => x !== i) }) })),
    ...(filters.noSiteOnly ? [{ label: "No website found yet", clear: () => set({ noSiteOnly: false }) }] : []),
    ...(filters.query ? [{ label: `"${filters.query}"`, clear: () => { onQueryDraft(""); set({ query: "" }); } }] : []),
  ];

  const clearAll = () =>
    set({ provinces: [], cities: [], industries: [], noSiteOnly: false, band: "all", query: "" });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-dim" />
          <input
            type="search"
            // Controlled draft synced from the URL by the parent: defaultValue
            // only applies on mount, so browser back/forward -- which correctly
            // changes the results -- left this box showing stale text. Typing
            // stays local (no URL push per keystroke); Enter commits.
            value={queryDraft}
            onChange={(e) => onQueryDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") set({ query: queryDraft }); }}
            placeholder="Search name or phone"
            className="w-56 rounded-lg border border-bg-border bg-bg-deep py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint transition-colors focus:border-accent focus:outline-none"
          />
        </div>

        <div className="h-6 w-px bg-bg-border" aria-hidden />

        <div role="group" aria-label="Website score" className="inline-flex items-center gap-0.5 rounded-lg border border-bg-border bg-bg-panel p-0.5">
          {BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              title={b.hint}
              aria-pressed={filters.band === b.key}
              onClick={() => set({ band: b.key })}
              className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 ${
                filters.band === b.key ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-bg-elev hover:text-fg"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        <label className="sr-only" htmlFor="lead-sort">Sort</label>
        <select
          id="lead-sort"
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value as LeadSort })}
          className="rounded-lg border border-bg-border bg-bg-panel px-2.5 py-2 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 focus:border-accent focus:outline-none"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key} className="bg-bg-panel text-fg">{s.label}</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2.5">
          {!loading && (
            <p className="text-sm text-fg-muted">
              <span className="tabular-nums font-bold text-fg">{total.toLocaleString()}</span>{" "}
              lead{total === 1 ? "" : "s"}
            </p>
          )}
          <button
            type="button"
            onClick={onStartCalling}
            disabled={!canStartCalling}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-accent to-accent-muted px-4 py-2 text-sm font-bold text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_8px_20px_-8px_rgba(59,130,246,0.45)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-40"
          >
            <Phone className="h-4 w-4" />Start calling
          </button>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.clear}
              className="inline-flex items-center gap-1 rounded-full border border-bg-border bg-bg-panel px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
            >
              {c.label}<X className="h-3 w-3" />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="rounded-full px-2 py-1 text-xs font-semibold text-fg-dim underline-offset-2 transition-colors hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
