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
 *
 * ═══ 2026-08-25, ON A PHONE ════════════════════════════════════════════════
 *
 * The sentence a rep composes is the same one; it just cannot be one row of
 * controls at 358px. Three things change and nothing is removed:
 *
 *   - THE FILTERS BUTTON. Below `2xl` the province/city/industry rail is a
 *     sheet (FilterRail.tsx explains why the breakpoint is 1536 and not 1024),
 *     so this bar carries the way into it, with a count of how many of ITS
 *     filters are on. The chips row underneath still names every one of them
 *     individually, so the count is a summary of something visible rather than
 *     the only trace of hidden state.
 *   - EVERY CONTROL IS 44px UNTIL `xl`. A rep standing in a car park mis-taps a
 *     28px segmented control, and one of the things next to it claims leads.
 *   - THE TWO ACTIONS GO FULL WIDTH BELOW `sm`. "Start calling" is the whole
 *     point of the screen on a phone; it should not be a 100px button that has
 *     wrapped onto its own line anyway.
 */

import { Clock, Loader2, Phone, Search, SlidersHorizontal, UserPlus, X } from "lucide-react";
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
  selectedCount, onClaim, claiming, claimLabel, canMutate, filterCount, onOpenFilters,
}: {
  filters: WebLeadFilters;
  onChange: (f: WebLeadFilters) => void;
  total: number;
  loading: boolean;
  queryDraft: string;
  onQueryDraft: (v: string) => void;
  onStartCalling: () => void;
  canStartCalling: boolean;
  selectedCount: number;
  /** Claim into my book (shared pool) or release back to it (My Leads). The
   *  parent owns which of the two this is, so the bar never has to know which
   *  view it is rendered in. */
  onClaim: () => void;
  claiming: boolean;
  claimLabel: string;
  /** Server-resolved sales mutation capability. Read-only viewers keep every
   *  targeting/read control but never receive claim or call affordances. */
  canMutate: boolean;
  /** How many of the RAIL's filters are on, for the Filters button's badge.
   *  Counted by FilterRail.activeFilterCount so the badge and the sheet can
   *  never disagree about what "a filter" is. */
  filterCount: number;
  /** Opens the filter sheet. Null in My Leads, which has no rail: a rep's own
   *  book is small enough to scan and filtering your own 100 leads by province
   *  is a question nobody has. A null here removes the button rather than
   *  disabling it -- a dead control is worse than an absent one. */
  onOpenFilters: (() => void) | null;
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
    ...(filters.openNow ? [{ label: "Open right now", clear: () => set({ openNow: false }) }] : []),
    ...(filters.query ? [{ label: `"${filters.query}"`, clear: () => { onQueryDraft(""); set({ query: "" }); } }] : []),
  ];

  const clearAll = () =>
    set({ provinces: [], cities: [], industries: [], noSiteOnly: false, openNow: false, band: "all", query: "" });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Full width on a phone, where it is the first row and a 224px box
            beside nothing just leaves a hole. */}
        <div className="relative w-full sm:w-auto">
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
            className="min-h-11 w-full rounded-lg border border-bg-border bg-bg-deep py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint transition-colors focus:border-accent focus:outline-none sm:w-56 xl:min-h-0"
          />
        </div>

        {/* THE WAY INTO THE RAIL, below `2xl`. Carries the count so a rep can
            see that something is narrowing their pool without opening it --
            the sheet's own footer then says how many leads that leaves. */}
        {onOpenFilters && (
          <button
            type="button"
            onClick={onOpenFilters}
            aria-label={filterCount > 0 ? `Filters, ${filterCount} on` : "Filters"}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-3.5 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 2xl:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {filterCount > 0 && (
              <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-xs font-bold tabular-nums text-accent">{filterCount}</span>
            )}
          </button>
        )}

        <div className="hidden h-6 w-px bg-bg-border sm:block" aria-hidden />

        <div role="group" aria-label="Website score" className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-bg-border bg-bg-panel p-0.5">
          {BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              title={b.hint}
              aria-pressed={filters.band === b.key}
              onClick={() => set({ band: b.key })}
              className={`inline-flex min-h-11 items-center rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:px-2.5 xl:py-1.5 ${
                filters.band === b.key ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-bg-elev hover:text-fg"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        {/* OPEN NOW. A plain toggle rather than a third state in the band
            group, because it answers a different question: the bands are about
            which prospect is worth calling, this is about which one will pick
            up. Deliberately NOT on by default -- roughly three-quarters of the
            corpus has no hours in the directory, and defaulting this on would
            hide most of a rep's territory to make a smaller list look tidier.
            The title spells out what it excludes, because a filter that quietly
            drops unknowns is the kind a rep stops trusting. */}
        <button
          type="button"
          aria-pressed={filters.openNow}
          title="Only businesses whose recorded hours say they are open right now, in their own time zone. Leads with no hours on file are hidden while this is on."
          onClick={() => set({ openNow: !filters.openNow })}
          className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:px-2.5 xl:py-2 ${
            filters.openNow
              ? "border-accent/40 bg-accent/15 text-accent"
              : "border-bg-border bg-bg-panel text-fg-dim hover:border-accent/40 hover:text-fg"
          }`}
        >
          <Clock className="h-3.5 w-3.5" />Open now
        </button>

        <label className="sr-only" htmlFor="lead-sort">Sort</label>
        <select
          id="lead-sort"
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value as LeadSort })}
          className="min-h-11 rounded-lg border border-bg-border bg-bg-panel px-2.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 focus:border-accent focus:outline-none xl:min-h-0 xl:py-2"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key} className="bg-bg-panel text-fg">{s.label}</option>
          ))}
        </select>

        {/* Full width below `sm` so "Start calling" is a thumb-sized bar rather
            than a button that has wrapped onto its own line at 40% width. */}
        <div className="flex w-full items-center gap-2.5 sm:ml-auto sm:w-auto">
          {!loading && (
            <p className="whitespace-nowrap text-sm text-fg-muted">
              <span className="tabular-nums font-bold text-fg">{total.toLocaleString()}</span>{" "}
              lead{total === 1 ? "" : "s"}
            </p>
          )}
          {canMutate && selectedCount > 0 && (
            <button
              type="button"
              onClick={onClaim}
              disabled={claiming}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3.5 text-sm font-bold text-accent transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50 sm:flex-none xl:min-h-0 xl:py-2"
            >
              {claiming ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              {claimLabel} {selectedCount}
            </button>
          )}
          {canMutate && (
            <button
              type="button"
              onClick={onStartCalling}
              disabled={!canStartCalling}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-accent to-accent-muted px-4 text-sm font-bold text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_8px_20px_-8px_rgba(59,130,246,0.45)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-40 sm:flex-none xl:min-h-0 xl:py-2"
            >
              <Phone className="h-4 w-4" />Start calling
            </button>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.clear}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-bg-border bg-bg-panel px-3 text-xs text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:px-2.5 xl:py-1"
            >
              {c.label}<X className="h-3.5 w-3.5 xl:h-3 xl:w-3" />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="min-h-11 rounded-full px-3 text-xs font-semibold text-fg-dim underline-offset-2 transition-colors hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:px-2 xl:py-1"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
