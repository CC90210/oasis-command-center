"use client";

/**
 * WebLeadsBrowser — the whole /web-leads page.
 *
 * ONE PAGE, THREE IN-PAGE VIEWS, NOT THREE DESTINATIONS. Pipeline
 * (PipelineBoard.tsx) and Territories (TerritoryAssignment.tsx) were once a
 * separate route and an always-on inline card. The operator said, verbatim,
 * "Not a separate pipeline page" about the former, and the latter cluttered the
 * default view with an admin-only control most viewers cannot use. Both are now
 * switched by the segmented control below and carried in the URL as
 * `?view=pipeline` / `?view=territories` -- an EXTENSION of the same
 * lib/web-leads/filters.ts mechanism the province/city/industry filters already
 * use, not a parallel one, so a view survives a refresh, back/forward and a
 * shared link exactly like every other filter here.
 *
 * DARK TOKENS, LIKE THE REST OF THE APP. This feature originally shipped in a
 * light theme (`bg-white`, `text-slate-*`) inside a dashboard that is dark in
 * 215 other components -- a white island. Every surface here now uses the same
 * tokens as components/leads/LeadDetailDrawer.tsx,
 * components/conversations/ConversationListPane.tsx and components/Card.tsx.
 *
 * THE 2026-08-23 PASS ADDED THE PART THAT MAKES IT A SALES TOOL. Browsing was
 * already fine; dialling was not a thing you could do. Three additions, in the
 * order they matter:
 *
 *   - CallMode.tsx: the filtered list becomes a queue you work one lead at a
 *     time, where the disposition is a keystroke and it advances you.
 *   - LeadsToolbar.tsx: score band + sort, so "Toronto salons scoring under 40,
 *     worst first" is a queue a rep can compose. The corpus measurement that
 *     says those are the real prospects was, until now, only in a document.
 *   - the website score in the list itself (LeadsTable.tsx), so a rep can see
 *     who is worth calling without opening 31,016 panels.
 *
 * ONE SHARED DETAIL PANEL. Leads, Pipeline and Call Mode all open a lead
 * through the same `?lead=<id>` URL convention. This component owns the single
 * <WebLeadDetail> instance, keyed off `filters.leadId`, so every route into a
 * lead lands on the exact same panel.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/Card";
import { parseFilters, filtersToParams, type WebLeadFilters, type WebLeadView } from "@/lib/web-leads/filters";
import type { Facets } from "@/lib/web-leads/queries";
// TYPE-ONLY. `lib/web-leads/data.ts` imports getServiceSupabase() -> next/headers
// (server-only). A *value* import of PAGE_SIZE from there -- as a prior draft of
// this file had -- pulls that whole module into the client bundle and fails the
// build ("You're importing a component that needs next/headers"). pageSize is
// read from the /api/web-leads response body instead, which is the same source
// of truth without crossing the server/client line.
import type { WebLeadRow } from "@/lib/web-leads/data";
import { FilterRail } from "./FilterRail";
import { LeadsTable } from "./LeadsTable";
import { LeadsToolbar } from "./LeadsToolbar";
import { WebLeadDetail } from "./WebLeadDetail";
import { TerritoryAssignment } from "./TerritoryAssignment";
import { PipelineBoard } from "./PipelineBoard";
import { CallMode } from "./CallMode";

const VIEWS: { key: WebLeadView; label: string }[] = [
  { key: "leads", label: "Leads" },
  { key: "pipeline", label: "Pipeline" },
  { key: "territories", label: "Territories" },
];

/** A segmented control, not browser tabs -- one bordered pill, active state
 *  filled with the accent wash, matching ListTabs.tsx's own active treatment
 *  but sized for a primary nav role rather than a secondary filter. */
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
            active === v.key ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-bg-elev hover:text-fg"
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
  const [leads, setLeads] = useState<WebLeadRow[]>([]);
  /**
   * The queue identity the currently-held `leads` actually belong to.
   *
   * `loading` alone is not enough to answer "is what I am showing the thing I
   * say I am showing". Between a rep hitting "load the next page" and that
   * response landing, the URL (and so queueKey) already names page 2 while
   * `leads` still holds page 1. Call Mode uses the comparison, not the flag --
   * see its `ready` prop.
   */
  const [leadsKey, setLeadsKey] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  // Infinity, not 50: an inert placeholder for "the server hasn't answered
  // yet". total is also 0 until the same response lands, so Math.ceil(0 /
  // Infinity) still resolves to 1 page and no pager renders. The real pageSize
  // always arrives together with the leads/total it describes, from the same
  // response body, so the two can never disagree.
  const [pageSize, setPageSize] = useState<number>(Number.POSITIVE_INFINITY);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Call Mode is LOCAL state, not a URL param, on purpose. A `?calling=1` link
   * would drop whoever opened it straight into a full-screen dialling overlay
   * they did not ask for -- and these links get pasted into chat. The queue it
   * works is entirely URL-driven, so the shareable part (which leads, in which
   * order) still travels; only the mode does not.
   */
  const [calling, setCalling] = useState(false);

  // Local draft for the search box, synced from the URL. See LeadsToolbar's
  // input for why this exists instead of defaultValue.
  const [queryDraft, setQueryDraft] = useState(filters.query);
  useEffect(() => { setQueryDraft(filters.query); }, [filters.query]);

  const push = useCallback((f: WebLeadFilters) => {
    const qs = filtersToParams(f).toString();
    router.push(qs ? `/web-leads?${qs}` : "/web-leads", { scroll: false });
  }, [router]);

  // Switching views keeps every other field (filters, page, an open lead)
  // intact -- Leads' own filters simply go unread by Pipeline/Territories, so a
  // rep who narrows to "Toronto salons", checks Pipeline, then comes back finds
  // their filters exactly where they left them.
  const setView = useCallback((v: WebLeadView) => push({ ...filters, view: v }), [push, filters]);
  const closeLead = useCallback(() => push({ ...filters, leadId: null }), [push, filters]);

  /**
   * Bumped when a call outcome is logged from the detail panel, and read by
   * the list and facet effects below so both re-run.
   *
   * A counter, not a boolean: a rep logging two calls in a row must get two
   * refreshes, and it is deliberately NOT part of `filters` -- putting it in
   * the URL would push a history entry per logged call and turn the browser
   * Back button into a walk through the rep's morning.
   */
  const [refreshNonce, setRefreshNonce] = useState(0);
  const onLeadLogged = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const openLead = useCallback((id: string) => push({ ...filters, leadId: id }), [push, filters]);

  // `alive` guards against an out-of-order response: if filters change again
  // before this fetch resolves, the cleanup flips alive to false and the late
  // .then()/.catch() becomes a no-op instead of overwriting fresher state with
  // stale data. The check runs in the SECOND .then(), AFTER the body has been
  // parsed -- not right after the fetch resolves -- so a slow body arriving
  // after a newer request cannot win. WebLeadDetail.tsx and useAudit.ts enforce
  // the same invariant for their own fetches.
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
    return () => { alive = false; };
  }, [filters, refreshNonce]);

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
        // Stamped from `qs`, the query these leads were fetched with -- not
        // from `filters`, which may already have moved on. That is the whole
        // point of the stamp.
        setLeadsKey(qs);
        setTotal(body.total);
        setPageSize(body.pageSize);
        setListError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setListError(e instanceof Error ? e.message : "failed");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filters, refreshNonce]);

  // Name the filter that emptied the list rather than saying a bare "0 results".
  const emptyHint = useMemo(() => {
    const parts: string[] = [];
    if (filters.industries.length) parts.push(filters.industries.join(" or "));
    if (filters.cities.length) parts.push(`in ${filters.cities.join(" or ")}`);
    else if (filters.provinces.length) parts.push(`in ${filters.provinces.join(" or ")}`);
    if (filters.noSiteOnly) parts.push("with no website found yet");
    if (filters.band === "under40") parts.push("scoring under 40");
    if (filters.band === "mid") parts.push("scoring 40 to 59");
    if (filters.band === "sixty_plus") parts.push("scoring 60 and up");
    if (filters.band === "unscored") parts.push("without a website score");
    if (filters.query) parts.push(`matching "${filters.query}"`);
    return parts.length ? `No leads ${parts.join(" ")}. Try removing a filter.` : "No leads yet.";
  }, [filters]);

  /** What the rep chose, in their own words -- shown at the top of Call Mode so
   *  they can see which queue they are working without leaving it. */
  const queueLabel = useMemo(() => {
    const parts = [
      filters.industries.join(" / "),
      filters.cities.join(" / ") || filters.provinces.join(" / "),
      filters.band === "under40" ? "under 40" :
        filters.band === "mid" ? "40 to 59" :
          filters.band === "sixty_plus" ? "60 and up" :
            filters.band === "unscored" ? "not scored" : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "All leads";
  }, [filters]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  /** The identity of the queue the URL currently describes. Compared against
   *  `leadsKey` to tell "these are the leads I asked for" apart from "these are
   *  whatever arrived last". Built the same way the fetch builds its query, so
   *  the two strings are comparable by construction. */
  const queueKey = useMemo(
    () => filtersToParams({ ...filters, leadId: null }).toString(),
    [filters],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        subtitle="Canadian businesses by province, city and industry. Website status is from a public directory and has not been verified, confirm on the call."
        action={<ViewSwitcher active={view} onChange={setView} />}
      />

      {view === "leads" && (
        <div className="flex gap-7">
          <FilterRail facets={facets} filters={filters} onChange={push} loading={!facets && !facetError} error={facetError} />

          <div className="min-w-0 flex-1 space-y-4">
            <LeadsToolbar
              filters={filters}
              onChange={push}
              total={total}
              loading={loading}
              queryDraft={queryDraft}
              onQueryDraft={setQueryDraft}
              onStartCalling={() => setCalling(true)}
              canStartCalling={!loading && leads.length > 0}
            />

            <LeadsTable
              leads={leads} total={total} page={filters.page} pageSize={pageSize}
              onPage={(n) => push({ ...filters, page: n })}
              onOpen={openLead}
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

      {calling && (
        <CallMode
          leads={leads}
          // Page AND filter identity: a rep who changes a filter in another tab
          // and comes back is working a different queue even at the same page
          // number, and the cursor should start over rather than land mid-list.
          queueKey={queueKey}
          queueLabel={queueLabel}
          // NOT `!loading`. The leads on screen must belong to THIS queue key,
          // or a rep can be handed the previous page's first lead with live
          // disposition buttons while the next page is still in flight.
          ready={!loading && leadsKey === queueKey}
          onExit={() => setCalling(false)}
          // Leaving Call Mode to open the drawer, rather than stacking two
          // full-screen overlays on top of each other.
          onOpenDetail={(id) => { setCalling(false); openLead(id); }}
          hasMore={filters.page < pages}
          onLoadMore={() => push({ ...filters, page: filters.page + 1 })}
        />
      )}

      {filters.leadId && (
        <WebLeadDetail leadId={filters.leadId} onClose={closeLead} onLogged={onLeadLogged} />
      )}
    </div>
  );
}
