"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { parseFilters, filtersToParams, type WebLeadFilters } from "@/lib/web-leads/filters";
import type { Facets } from "@/lib/web-leads/queries";
// TYPE-ONLY. `lib/web-leads/data.ts` imports getServiceSupabase() -> next/headers
// (server-only). A *value* import of PAGE_SIZE from there — as a prior draft of
// this file had — pulls that whole module into the client bundle and fails the
// build ("You're importing a component that needs next/headers"). pageSize is
// read from the /api/web-leads response body instead (see the second
// useEffect below), which is the same source of truth without crossing the
// server/client line.
import type { WebLead } from "@/lib/web-leads/data";
import { FilterRail } from "./FilterRail";
import { LeadsTable } from "./LeadsTable";
import { WebLeadDetail } from "./WebLeadDetail";

export function WebLeadsBrowser() {
  const router = useRouter();
  const sp = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(sp.toString())), [sp]);

  const [facets, setFacets] = useState<Facets | null>(null);
  const [facetError, setFacetError] = useState<string | null>(null);
  const [leads, setLeads] = useState<WebLead[]>([]);
  const [total, setTotal] = useState(0);
  // Infinity, not 50: an inert placeholder for "server hasn't answered yet".
  // total is also 0 until the same response lands, so Math.ceil(0 / Infinity)
  // still resolves to 1 page and no pager renders. Real pageSize always
  // arrives together with the leads/total it describes, from the same
  // response body, so the two can never disagree.
  const [pageSize, setPageSize] = useState<number>(Number.POSITIVE_INFINITY);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const push = useCallback((f: WebLeadFilters) => {
    const qs = filtersToParams(f).toString();
    router.push(qs ? `/web-leads?${qs}` : "/web-leads", { scroll: false });
  }, [router]);

  useEffect(() => {
    const qs = filtersToParams({ ...filters, page: 1, leadId: null }).toString();
    fetch(`/api/web-leads/facets?${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        setFacets(await r.json());
        setFacetError(null);
      })
      .catch((e) => setFacetError(e instanceof Error ? e.message : "failed"));
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    const qs = filtersToParams({ ...filters, leadId: null }).toString();
    fetch(`/api/web-leads?${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const body = await r.json();
        setLeads(body.leads);
        setTotal(body.total);
        setPageSize(body.pageSize);
        setListError(null);
      })
      .catch((e) => setListError(e instanceof Error ? e.message : "failed"))
      .finally(() => setLoading(false));
  }, [filters]);

  // Name the filter that emptied the list rather than saying a bare "0 results".
  const emptyHint = useMemo(() => {
    const parts: string[] = [];
    if (filters.industries.length) parts.push(filters.industries.join(" or "));
    if (filters.cities.length) parts.push(`in ${filters.cities.join(" or ")}`);
    else if (filters.provinces.length) parts.push(`in ${filters.provinces.join(" or ")}`);
    if (filters.noSiteOnly) parts.push("with no website found yet");
    if (filters.query) parts.push(`matching "${filters.query}"`);
    return parts.length ? `No leads ${parts.join(" ")}. Try removing a filter.` : "No leads yet.";
  }, [filters]);

  const chips: { label: string; clear: () => void }[] = [
    ...filters.provinces.map((p) => ({ label: p, clear: () => push({ ...filters, provinces: filters.provinces.filter((x) => x !== p), page: 1 }) })),
    ...filters.cities.map((c) => ({ label: c, clear: () => push({ ...filters, cities: filters.cities.filter((x) => x !== c), page: 1 }) })),
    ...filters.industries.map((i) => ({ label: i, clear: () => push({ ...filters, industries: filters.industries.filter((x) => x !== i), page: 1 }) })),
  ];

  return (
    <div className="flex gap-6 p-6">
      <FilterRail facets={facets} filters={filters} onChange={push} loading={!facets && !facetError} error={facetError} />

      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            defaultValue={filters.query}
            placeholder="Search name or phone"
            onKeyDown={(e) => { if (e.key === "Enter") push({ ...filters, query: (e.target as HTMLInputElement).value, page: 1 }); }}
            className="w-64 rounded-md border border-slate-200 px-3 py-1.5 text-sm"
          />
          {chips.map((c) => (
            <button key={c.label} type="button" onClick={c.clear} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-200">
              {c.label}<X className="h-3 w-3" />
            </button>
          ))}
        </div>

        <LeadsTable
          leads={leads} total={total} page={filters.page} pageSize={pageSize}
          onPage={(n) => push({ ...filters, page: n })}
          onOpen={(id) => push({ ...filters, leadId: id })}
          loading={loading} error={listError} emptyHint={emptyHint}
        />
      </div>

      {filters.leadId && (
        <WebLeadDetail leadId={filters.leadId} onClose={() => push({ ...filters, leadId: null })} />
      )}
    </div>
  );
}
