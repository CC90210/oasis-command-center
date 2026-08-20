"use client";

/**
 * FilterRail — the province/city/industry hierarchy, as CHECKBOXES.
 *
 * The hierarchy is a way in, not a cage. Every level is selectable, so
 * "plumbing across the board" is an industry with no city, and "plumbing in
 * Toronto" adds the city. A strict page-per-level drill-down cannot express the
 * first, which is why this is a rail rather than a set of pages.
 */

import { useState } from "react";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";
import type { WebLeadFilters } from "@/lib/web-leads/filters";
import type { Facets } from "@/lib/web-leads/queries";

const toggle = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

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
      <div className="w-64 shrink-0 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <AlertCircle className="mb-2 h-4 w-4" />
        <p className="font-medium">Filters unavailable</p>
        <p className="mt-1 text-xs text-red-700">{error}</p>
      </div>
    );
  }

  if (loading || !facets) {
    return <div className="w-64 shrink-0 animate-pulse rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-400">Loading filters…</div>;
  }

  const set = (patch: Partial<WebLeadFilters>) => onChange({ ...filters, ...patch, page: 1 });

  return (
    <aside className="w-64 shrink-0 space-y-6">
      <label className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={filters.noSiteOnly}
          onChange={() => set({ noSiteOnly: !filters.noSiteOnly })}
        />
        <span>No website found yet</span>
      </label>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Provinces</h3>
        <ul className="space-y-0.5">
          {facets.provinces.map((p) => (
            <li key={p.code}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Expand ${p.code}`}
                  onClick={() => setOpen((o) => ({ ...o, [p.code]: !o[p.code] }))}
                  className="rounded p-0.5 text-slate-400 hover:bg-slate-100"
                >
                  {open[p.code] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <label className="flex flex-1 cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={filters.provinces.includes(p.code)}
                      onChange={() => set({ provinces: toggle(filters.provinces, p.code) })}
                    />
                    {p.code}
                  </span>
                  <span className="tabular-nums text-xs text-slate-500">{p.count.toLocaleString()}</span>
                </label>
              </div>

              {open[p.code] && (
                <ul className="ml-6 space-y-0.5 border-l border-slate-200 pl-2">
                  {p.cities.map((c) => (
                    <li key={c.name}>
                      <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-sm hover:bg-slate-50">
                        <span className="flex items-center gap-2 truncate">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={filters.cities.includes(c.name)}
                            onChange={() => set({ cities: toggle(filters.cities, c.name) })}
                          />
                          <span className="truncate">{c.name}</span>
                        </span>
                        <span className="tabular-nums text-xs text-slate-500">{c.count.toLocaleString()}</span>
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
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Industries</h3>
        <ul className="space-y-0.5">
          {facets.industries.map((i) => (
            <li key={i.name}>
              <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                <span className="flex items-center gap-2 truncate">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={filters.industries.includes(i.name)}
                    onChange={() => set({ industries: toggle(filters.industries, i.name) })}
                  />
                  <span className="truncate">{i.name}</span>
                </span>
                <span className="tabular-nums text-xs text-slate-500">{i.count.toLocaleString()}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
