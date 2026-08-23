"use client";

/**
 * WebLeadsBrowser — the whole /web-leads page (2026-08-23 revamp).
 *
 * WHY THIS EXISTS, AND WHY IT LOOKS DIFFERENT NOW: this feature shipped in a
 * light theme (`bg-white`, `text-slate-*`) inside a dashboard that is dark
 * everywhere else -- 215 other components on the app's dark tokens, these 8
 * on light slate. That mismatch, not any individual polish gap, was why the
 * operator called it "a white island" and asked for a revamp. This file (and
 * every component it mounts) now uses the same tokens as
 * components/leads/LeadDetailDrawer.tsx, components/conversations/
 * ConversationListPane.tsx, components/leads/AssignmentControl.tsx and
 * components/Card.tsx's PageHeader -- studied directly before writing a line
 * here, and reused wherever a pattern already existed rather than invented
 * fresh (checkbox accent color, drawer chrome, panel/raised surfaces, the
 * segmented-tab treatment from components/conversations/ListTabs.tsx).
 *
 * ONE PAGE, THREE IN-PAGE VIEWS, NOT THREE DESTINATIONS: Pipeline
 * (PipelineBoard.tsx) and Territories (TerritoryAssignment.tsx) used to be
 * a separate route and an always-on inline card, respectively. The operator
 * said, verbatim, "Not a separate pipeline page" about the former, and the
 * latter cluttered the default Leads view with an admin-only control most
 * viewers can't even use. Both are now views switched by the segmented
 * control below, carried in the URL as `?view=pipeline` / `?view=territories`
 * -- an EXTENSION of the same lib/web-leads/filters.ts mechanism the
 * province/city/industry/search filters already use, not a parallel one, so
 * a view survives a refresh, back/forward, and a shared link exactly like
 * every other filter here.
 *
 * ONE SHARED DETAIL PANEL: Leads and Pipeline both open a lead through the
 * same `?lead=<id>` URL convention (established before this revamp). Rather
 * than let each view mount its own <WebLeadDetail>, this component owns the
 * single instance below, keyed off `filters.leadId` -- opening a lead from
 * the stage board and from the results table land on the exact same panel.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { PageHeader } from "@/components/Card";
import { parseFilters, filtersToParams, type WebLeadFilters, type WebLeadView } from "@/lib/web-leads/filters";
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
import { TerritoryAssignment } from "./TerritoryAssignment";
import { PipelineBoard } from "./PipelineBoard";

const VIEWS: { key: WebLeadView; label: string }[] = [
  { key: "leads", label: "Leads" },
  { key: "pipeline", label: "Pipeline" },
  { key: "territories", label: "Territories" },
];

/** A segmented control, not browser tabs -- one bordered pill, active state
 * filled with the accent wash, matching ListTabs.tsx's own active treatment
 * (components/conversations/ListTabs.tsx) but sized for a primary nav role
 * rather than a secondary filter. */
function ViewSwitcher({ active, onChange }: { active: WebLeadView; onChange: (v: WebLeadView) => void }) {
  return (
    <div role="tablist" aria-label="View" className="inline-flex items-center gap-0.5 rounded-lg border border-bg-border bg-bg-panel p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          role="tab"
          aria-selected={active === v.key}
          onClick={() => onChange(v.key)}
          className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 ${
            active === v.key
              ? "bg-accent/15 text-accent"
              : "text-fg-dim hover:bg-bg-elev hover:text-fg"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

export function WebLeadsBrowser() {
  const router = useRouter();
  const sp = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(sp.toString())), [sp]);
  const view = filters.view;

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

  // Local draft for the search box, synced from the URL. See the search
  // <input> below for why this exists instead of defaultValue.
  const [queryDraft, setQueryDraft] = useState(filters.query);
  useEffect(() => {
    setQueryDraft(filters.query);
  }, [filters.query]);

  const push = useCallback((f: WebLeadFilters) => {
    const qs = filtersToParams(f).toString();
    router.push(qs ? `/web-leads?${qs}` : "/web-leads", { scroll: false });
  }, [router]);

  // Switching views keeps every other field (filters, page, an open lead)
  // intact -- Leads' own filters simply go unread by Pipeline/Territories,
  // so a rep who narrows to "Toronto salons", checks Pipeline, then comes
  // back to Leads finds their filters exactly where they left them.
  const setView = useCallback((v: WebLeadView) => push({ ...filters, view: v }), [push, filters]);
  const closeLead = useCallback(() => push({ ...filters, leadId: null }), [push, filters]);

  // `alive` guards against an out-of-order response: if filters change again
  // before this fetch resolves, the effect's cleanup flips alive to false and
  // the late .then()/.catch() becomes a no-op instead of overwriting fresher
  // state with stale data. The check runs in the SECOND .then(), after the
  // body has already been parsed -- not right after the fetch resolves --
  // so a slow body arriving after a newer request can't win. WebLeadDetail.tsx
  // enforces the same alive-after-body-parse invariant for its per-lead
  // fetch, via a differently-shaped promise chain.
  useEffect(() => {
    let alive = true;
    const qs = filtersToParams({ ...filters, page: 1, leadId: null }).toString();
    fetch(`/api/web-leads/facets?${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => {
        if (!alive) return;
        setFacets(body);
        setFacetError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setFacetError(e instanceof Error ? e.message : "failed");
      });
    return () => {
      alive = false;
    };
  }, [filters]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const qs = filtersToParams({ ...filters, leadId: null }).toString();
    fetch(`/api/web-leads?${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => {
        if (!alive) return;
        setLeads(body.leads);
        setTotal(body.total);
        setPageSize(body.pageSize);
        setListError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setListError(e instanceof Error ? e.message : "failed");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
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
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        subtitle="Canadian businesses by province, city and industry. Website status is from a public directory and has not been verified, confirm on the call."
        action={<ViewSwitcher active={view} onChange={setView} />}
      />

      {view === "leads" && (
        <div className="flex gap-6">
          <FilterRail facets={facets} filters={filters} onChange={push} loading={!facets && !facetError} error={facetError} />

          <div className="min-w-0 flex-1">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-dim" />
                <input
                  type="search"
                  // Controlled + synced from filters.query (the effect above),
                  // rather than defaultValue: defaultValue only applies on mount,
                  // so browser back/forward -- which correctly changes the results
                  // via the URL -- left the box showing stale text. A local draft
                  // state keeps typing snappy (no URL push per keystroke, search
                  // still commits on Enter) while staying in sync whenever the URL
                  // itself changes the query from underneath the input.
                  value={queryDraft}
                  onChange={(e) => setQueryDraft(e.target.value)}
                  placeholder="Search name or phone"
                  onKeyDown={(e) => { if (e.key === "Enter") push({ ...filters, query: queryDraft, page: 1 }); }}
                  className="w-64 rounded-md border border-bg-border bg-bg-deep py-1.5 pl-8 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                />
              </div>
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
            </div>

            <LeadsTable
              leads={leads} total={total} page={filters.page} pageSize={pageSize}
              onPage={(n) => push({ ...filters, page: n })}
              onOpen={(id) => push({ ...filters, leadId: id })}
              loading={loading} error={listError} emptyHint={emptyHint}
            />
          </div>
        </div>
      )}

      {view === "pipeline" && <PipelineBoard />}

      {view === "territories" && (
        <div className="max-w-3xl">
          <TerritoryAssignment />
        </div>
      )}

      {filters.leadId && <WebLeadDetail leadId={filters.leadId} onClose={closeLead} />}
    </div>
  );
}
