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
 */

import { useState } from "react";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";
import type { WebLeadFilters } from "@/lib/web-leads/filters";
import type { Facets } from "@/lib/web-leads/queries";

const toggle = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

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

export function FilterRail({
  facets, filters, onChange, loading, error,
}: {
  facets: Facets | null;
  filters: WebLeadFilters;
  onChange: (f: WebLeadFilters) => void;
  loading: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // An error must never look like "no leads exist" — say what broke.
  if (error) {
    return (
      <div className="w-64 shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
        <AlertCircle className="mb-2 h-4 w-4" />
        <p className="font-medium">Filters unavailable</p>
        <p className="mt-1 text-xs text-red-300/80">{error}</p>
      </div>
    );
  }

  if (loading || !facets) {
    return <RailSkeleton />;
  }

  const set = (patch: Partial<WebLeadFilters>) => onChange({ ...filters, ...patch, page: 1 });

  return (
    <aside className="w-64 shrink-0 space-y-6">
      <label className="flex cursor-pointer items-center gap-2 rounded-md border border-bg-border bg-bg-panel px-3 py-2 text-sm text-fg transition-colors hover:border-accent/40">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded accent-accent"
          checked={filters.noSiteOnly}
          onChange={() => set({ noSiteOnly: !filters.noSiteOnly })}
        />
        <span>No website found yet</span>
      </label>

      <div>
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Provinces</h3>
        <ul className="space-y-0.5">
          {facets.provinces.map((p) => (
            <li key={p.code}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Expand ${p.code}`}
                  onClick={() => setOpen((o) => ({ ...o, [p.code]: !o[p.code] }))}
                  className="rounded p-0.5 text-fg-dim transition-colors hover:bg-bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
                >
                  {open[p.code] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <label className="flex flex-1 cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm text-fg transition-colors hover:bg-bg-elev">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded accent-accent"
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
                      <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-sm text-fg-muted transition-colors hover:bg-bg-elev hover:text-fg">
                        <span className="flex items-center gap-2 truncate">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded accent-accent"
                            checked={filters.cities.includes(c.name)}
                            onChange={() => set({ cities: toggle(filters.cities, c.name) })}
                          />
                          <span className="truncate">{c.name}</span>
                        </span>
                        <span className="tabular-nums text-xs text-fg-dim">{c.count.toLocaleString()}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Industries</h3>
        <ul className="space-y-0.5">
          {facets.industries.map((i) => (
            <li key={i.name}>
              <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm text-fg-muted transition-colors hover:bg-bg-elev hover:text-fg">
                <span className="flex items-center gap-2 truncate">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-accent"
                    checked={filters.industries.includes(i.name)}
                    onChange={() => set({ industries: toggle(filters.industries, i.name) })}
                  />
                  <span className="truncate">{i.name}</span>
                </span>
                <span className="tabular-nums text-xs text-fg-dim">{i.count.toLocaleString()}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
