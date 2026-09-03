"use client";

/**
 * FilterRail — the province/city/industry hierarchy, as CHECKBOXES.
 *
 * The hierarchy is a way in, not a cage. Every level is selectable, so
 * "plumbing across the board" is an industry with no city, and "plumbing in
 * Toronto" adds the city. A strict page-per-level drill-down cannot express the
 * first, which is why this is a rail rather than a set of pages.
 *
 * Restyled onto the app's dark tokens (2026-08-23 revamp) -- matches
 * components/leads/LeadDetailDrawer.tsx and ConversationListPane.tsx: bg-bg-
 * panel/bg-bg-elev surfaces, bg-bg-border hairlines, fg-* text scale, accent
 * checkboxes (`accent-accent`, the same convention FormRenderer.tsx and
 * AgentInboxList.tsx already use).
 *
 * ═══ 2026-08-25: THE SAME TREE, TWO CONTAINERS, AND WHY THE BREAKPOINT IS 2XL
 *
 * Adon, on reps working from anywhere: "I want them to have the freedom of
 * being able to work from where they want in the world... ensuring that the
 * software is very compatible with mobile."
 *
 * A 256px sticky column beside the results is the right shape only when there
 * is room for BOTH. Below that it is not merely cramped, it CLIPS -- and the
 * arithmetic is worse than it looks, so it is written out here rather than
 * reasoned about again:
 *
 *   content box = min(viewport - sidebar, 1280) - horizontal padding
 *     390  ->  358   (no sidebar below `md`, px-4)
 *     414  ->  382
 *     768  ->  464   (240px sidebar from `md` up, px-8)
 *    1024  ->  720
 *    1280  ->  976
 *    1536  -> 1216   (max-w-7xl caps it here and at every width above)
 *
 *   the rail costs 256 + a 28px gap = 284 of that, always.
 *
 * MEASURED IN CHROME (.measure/, `node .measure/measure.mjs`), the shared-pool
 * table's floor is 730px and My Leads' is 828px. So the pool's results column
 * only holds its own table from 976 + 284 = 1260px of content box -- i.e. a
 * 1564px viewport. At 1280, production today gives the pool 692px for a 730px
 * table and CLIPS "View site" out of an `overflow-hidden` wrapper. That is not
 * a mobile bug; it is shipping on the operator's own laptop, and the column
 * budget in LeadsTable.tsx did not catch it because every number in it was
 * measured on My Leads, which has no rail.
 *
 * So the rail is a persistent column only at `2xl` (1536+), where the pool
 * gets 1216 - 284 = 932px and the table fits with room to spare. Everywhere
 * below that -- phone, tablet, and the 1280 laptop -- the same tree is a sheet
 * behind a Filters button that reports how many are on. Nothing is removed and
 * nothing is hidden: the active filters are also still on screen as removable
 * chips in the toolbar, which is where a rep looks to answer "why am I seeing
 * these".
 *
 * TAP TARGETS ARE 44px UP TO `2xl`, not just on a phone. A 14px checkbox is
 * one mis-tap from claiming the wrong lead, and a claim is a compare-and-swap
 * that takes a real business out of every other rep's pool. The rail's own
 * dense 28px rows come back at `2xl`, where a mouse is doing the pointing.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, AlertCircle, X } from "lucide-react";
import type { WebLeadFilters } from "@/lib/web-leads/filters";
import type { Facets } from "@/lib/web-leads/queries";

const toggle = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * How many of the RAIL's own filters are on.
 *
 * Deliberately not "how many filters are on" in general: the score band, sort,
 * search and Open now all live in the toolbar, in plain sight, and counting
 * them here would make the Filters button claim credit for state the rep can
 * already see. A badge that disagrees with what opening the sheet shows is a
 * badge a rep stops reading.
 */
export function activeFilterCount(filters: WebLeadFilters): number {
  return (
    filters.provinces.length +
    filters.cities.length +
    filters.industries.length +
    (filters.noSiteOnly ? 1 : 0) +
    (filters.ownerOnly ? 1 : 0)
  );
}

/** Shared by the rail and the sheet, so the two can never drift into two
 *  different filter trees. */
const ROW =
  "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-bg-border bg-bg-panel px-3 py-2.5 text-sm text-fg transition-colors hover:border-accent/40 2xl:min-h-0";
/** The checkbox itself stays 14px -- it is a dark-theme convention shared with
 *  FormRenderer.tsx and AgentInboxList.tsx. What grows is the HIT AREA: every
 *  one of these lives inside a <label> that is at least 44px tall, so the whole
 *  row is the target. */
const BOX = "h-3.5 w-3.5 shrink-0 rounded accent-accent";

function RailSkeleton() {
  return (
    <div className="w-64 shrink-0 space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-9 rounded-md bg-bg-elev animate-pulse-slow" />
      <div className="space-y-2">
        <div className="h-2.5 w-16 rounded bg-bg-elev animate-pulse-slow" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-6 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
      <div className="space-y-2">
        <div className="h-2.5 w-16 rounded bg-bg-elev animate-pulse-slow" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
        ))}
      </div>
    </div>
  );
}

function RailError({ error }: { error: string }) {
  // An error must never look like "no leads exist" — say what broke.
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
      <AlertCircle className="mb-2 h-4 w-4" />
      <p className="font-medium">Filters unavailable</p>
      <p className="mt-1 text-xs text-red-300/80">{error}</p>
    </div>
  );
}

function FilterTree({
  facets, filters, onChange,
}: {
  facets: Facets;
  filters: WebLeadFilters;
  onChange: (f: WebLeadFilters) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const set = (patch: Partial<WebLeadFilters>) => onChange({ ...filters, ...patch, page: 1 });

  return (
    <div className="space-y-5">
      {/* COUNTRY IS A SWITCH, NOT A CHECKBOX. A rep is always working one
          market: Canada and the US run under different outbound law (CASL vs
          TCPA/DNC), so "both at once" is not a view anybody should have. It
          sits at the top because it changes what every filter below it means —
          the province list is Canadian, the state list is not. */}
      <div className="flex gap-1 rounded-lg border border-bg-border bg-bg-panel/40 p-1">
        {([
          { key: "ca" as const, label: "🇨🇦 Canada" },
          { key: "us" as const, label: "🇺🇸 United States" },
        ]).map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={filters.country === c.key}
            onClick={() => set({ country: c.key, provinces: [], cities: [] })}
            className={`min-h-11 flex-1 rounded-md px-2 text-xs font-semibold transition-colors xl:min-h-0 xl:py-1.5 ${
              filters.country === c.key
                ? "bg-accent text-bg-deep"
                : "text-fg-muted hover:bg-bg-elev hover:text-fg"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <label className={ROW}>
        <input
          type="checkbox"
          className={BOX}
          checked={filters.noSiteOnly}
          onChange={() => set({ noSiteOnly: !filters.noSiteOnly })}
        />
        <span>No website found yet</span>
      </label>

      {/* The owner's name is the difference between "is the owner in?" and
          "can I speak to Marie?". Sits beside the website filter because a rep
          picks both the same way: what do I know before I dial. */}
      <label className={ROW}>
        <input
          type="checkbox"
          className={BOX}
          checked={filters.ownerOnly}
          onChange={() => set({ ownerOnly: !filters.ownerOnly })}
        />
        <span>Owner identified by name</span>
      </label>

      <div className="rounded-lg border border-bg-border bg-bg-panel/40 p-3">
        <h3 className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Provinces</h3>
        <ul className="space-y-0.5">
          {facets.provinces.map((p) => (
            <li key={p.code}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Expand ${p.code}`}
                  aria-expanded={Boolean(open[p.code])}
                  onClick={() => setOpen((o) => ({ ...o, [p.code]: !o[p.code] }))}
                  // 44px square until 2xl. It was 18px, which on a phone is a
                  // coin toss between expanding a province and ticking it.
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 2xl:h-6 2xl:w-6"
                >
                  {open[p.code] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <label className="flex min-h-11 flex-1 cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm text-fg transition-colors hover:bg-bg-elev 2xl:min-h-0">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className={BOX}
                      checked={filters.provinces.includes(p.code)}
                      onChange={() => set({ provinces: toggle(filters.provinces, p.code) })}
                    />
                    {p.code}
                  </span>
                  <span className="tabular-nums text-xs text-fg-dim">{p.count.toLocaleString()}</span>
                </label>
              </div>

              {open[p.code] && (
                <ul className="ml-6 space-y-0.5 border-l border-bg-border pl-2">
                  {p.cities.map((c) => (
                    <li key={c.name}>
                      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-sm text-fg-muted transition-colors hover:bg-bg-elev hover:text-fg 2xl:min-h-0">
                        <span className="flex min-w-0 items-center gap-2 truncate">
                          <input
                            type="checkbox"
                            className={BOX}
                            checked={filters.cities.includes(c.name)}
                            onChange={() => set({ cities: toggle(filters.cities, c.name) })}
                          />
                          <span className="truncate">{c.name}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-xs text-fg-dim">{c.count.toLocaleString()}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-bg-border bg-bg-panel/40 p-3">
        <h3 className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Industries</h3>
        <ul className="space-y-0.5">
          {facets.industries.map((i) => (
            <li key={i.name}>
              <label className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm text-fg-muted transition-colors hover:bg-bg-elev hover:text-fg 2xl:min-h-0">
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <input
                    type="checkbox"
                    className={BOX}
                    checked={filters.industries.includes(i.name)}
                    onChange={() => set({ industries: toggle(filters.industries, i.name) })}
                  />
                  {/* "CC Leads" no longer gets accent styling or a HOT badge:
                      zero leads carry that industry, so the badge advertised an
                      empty queue (removed 2026-09-02 with its toolbar button). */}
                  <span className="truncate">{i.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-xs text-fg-dim">{i.count.toLocaleString()}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function FilterRail({
  facets, filters, onChange, loading, error,
}: {
  facets: Facets | null;
  filters: WebLeadFilters;
  onChange: (f: WebLeadFilters) => void;
  loading: boolean;
  error: string | null;
}) {
  // Sticky, and scrolls independently of the results. A rep who pages down a
  // 50-row table should not have to scroll back up to change a city -- the
  // rail is a control surface, not part of the document flow. `top-6` clears
  // the app chrome; the inner max-height keeps the whole rail on screen when
  // a province expands to forty cities.
  //
  // `hidden 2xl:block`: below 1536 this same tree is the sheet below, because
  // the 284px this column costs is the difference between the results table
  // fitting and being clipped. See the module header's arithmetic.
  return (
    <aside className="sticky top-6 hidden max-h-[calc(100vh-3rem)] w-64 shrink-0 overflow-y-auto overscroll-contain pr-1 2xl:block">
      {error ? <RailError error={error} /> : loading || !facets ? <RailSkeleton /> : (
        <FilterTree facets={facets} filters={filters} onChange={onChange} />
      )}
    </aside>
  );
}

/**
 * The same tree as a sheet, for every width below `2xl`.
 *
 * A SHEET AND NOT A SQUEEZED COLUMN. The rail's problem on a phone was never
 * that it looked bad -- it was that it took 284 of 358 available pixels and
 * left the results 74px, which the harness measures on `main` today. A rep
 * cannot browse a pool through a 74px window.
 *
 * It closes on Escape, on the backdrop, and on "Show leads", and it locks the
 * page behind it while open -- the same three affordances CallMode.tsx and
 * WebLeadDetail.tsx already document for their overlays. Filters apply as they
 * are ticked rather than on a Save button: the count in the footer updates
 * live, so a rep sees what a filter did before committing to it.
 */
export function FilterSheet({
  open, onClose, facets, filters, onChange, loading, error, total,
}: {
  open: boolean;
  onClose: () => void;
  facets: Facets | null;
  filters: WebLeadFilters;
  onChange: (f: WebLeadFilters) => void;
  loading: boolean;
  error: string | null;
  /** Live result count, so "Show 3,760 leads" is the answer to what was just
   *  ticked rather than a generic Done button. */
  total?: number;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);

    /**
     * 🚨 THE BREAKPOINT CLOSES THE SHEET, NOT JUST HIDES IT. (Codex review,
     * 2026-08-25, P2.)
     *
     * `2xl:hidden` on the container below is CSS, and CSS cannot change React
     * state. So a rep who opened the sheet and then crossed 1536 -- rotating a
     * tablet, dragging a window, docking a laptop -- got the desktop rail on a
     * page whose body was STILL `overflow: hidden`, held by this effect, with
     * the only control that could release it now `display: none`. The page
     * stops scrolling and there is nothing on screen to blame.
     *
     * Keyed to the same 1536 the class is, and it runs once on mount too, so
     * opening the sheet at a width where the rail already exists is a no-op
     * rather than a lock. The `2xl:hidden` class stays as belt and braces for
     * the frame before this runs, but it is no longer the mechanism.
     */
    const rail = window.matchMedia("(min-width: 1536px)");
    const closeIfRailTakesOver = () => { if (rail.matches) onClose(); };
    closeIfRailTakesOver();
    rail.addEventListener("change", closeIfRailTakesOver);

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      rail.removeEventListener("change", closeIfRailTakesOver);
    };
  }, [open, onClose]);

  if (!open) return null;

  const clearAll = () => onChange({ ...filters, provinces: [], cities: [], industries: [], noSiteOnly: false, page: 1 });
  const count = activeFilterCount(filters);

  return (
    <div className="fixed inset-0 z-50 flex 2xl:hidden" role="dialog" aria-modal="true" aria-label="Filters">
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      {/* Full width on a phone, a panel on a tablet. `max-w-[26rem]` rather
          than a percentage so the tree never has to reflow at a width it was
          not designed for. */}
      <div className="relative flex h-full w-full max-w-[26rem] flex-col border-r border-bg-border bg-bg shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-bg-border px-4 py-3">
          <p className="text-sm font-bold text-fg">
            Filters{count > 0 && <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">{count}</span>}
          </p>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-bg-border text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {error ? <RailError error={error} /> : loading || !facets ? <RailSkeleton /> : (
            <FilterTree facets={facets} filters={filters} onChange={onChange} />
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2.5 border-t border-bg-border px-4 py-3">
          <button
            type="button"
            onClick={clearAll}
            disabled={count === 0}
            className="min-h-11 rounded-lg border border-bg-border px-4 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 flex-1 rounded-lg bg-gradient-to-br from-accent to-accent-muted px-4 text-sm font-bold text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {typeof total === "number" ? `Show ${total.toLocaleString()} lead${total === 1 ? "" : "s"}` : "Show leads"}
          </button>
        </footer>
      </div>
    </div>
  );
}
