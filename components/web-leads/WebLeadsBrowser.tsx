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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/Card";
import { parseFilters, filtersToParams, type WebLeadFilters, type WebLeadView } from "@/lib/web-leads/filters";
import { hasNoFilters, readRememberedFilters, rememberFilters } from "@/lib/web-leads/filter-memory";
import {
  fetchCachedWebLeadsJson,
  invalidateWebLeadsClientCache,
  webLeadsRequestUrls,
} from "@/lib/web-leads/client-cache";
import type { Facets } from "@/lib/web-leads/queries";
// TYPE-ONLY. `lib/web-leads/data.ts` imports getServiceSupabase() -> next/headers
// (server-only). A *value* import of PAGE_SIZE from there -- as a prior draft of
// this file had -- pulls that whole module into the client bundle and fails the
// build ("You're importing a component that needs next/headers"). pageSize is
// read from the /api/web-leads response body instead, which is the same source
// of truth without crossing the server/client line.
import type { WebLeadRow } from "@/lib/web-leads/data";
import { activeFilterCount, FilterRail, FilterSheet } from "./FilterRail";
import { LeadsTable } from "./LeadsTable";
import { LeadsToolbar } from "./LeadsToolbar";
import { WebLeadDetail } from "./WebLeadDetail";
import { TerritoryAssignment } from "./TerritoryAssignment";
import { CallMode } from "./CallMode";

const VIEWS: { key: WebLeadView; label: string }[] = [
  { key: "leads", label: "Leads" },
  { key: "mine", label: "My leads" },
  { key: "territories", label: "Assign" },
];

/** A segmented control, not browser tabs -- one bordered pill, active state
 *  filled with the accent wash, matching ListTabs.tsx's own active treatment
 *  but sized for a primary nav role rather than a secondary filter. */
function ViewSwitcher({
  active,
  onChange,
  teamView,
}: {
  active: WebLeadView;
  onChange: (v: WebLeadView) => void;
  teamView: boolean;
}) {
  return (
    <div role="tablist" aria-label="View" className="inline-flex items-center gap-0.5 rounded-lg border border-bg-border bg-bg-panel p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          role="tab"
          aria-selected={active === v.key}
          onClick={() => onChange(v.key)}
          // 44px until `xl`. This is the control that decides whether a rep is
          // looking at the shared pool or their own book, and getting it wrong
          // on a phone means claiming out of the wrong list.
          className={`inline-flex min-h-11 items-center rounded-md px-3.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:py-1.5 ${
            active === v.key ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-bg-elev hover:text-fg"
          }`}
        >
          {v.key === "mine" && teamView ? "Team leads" : v.label}
        </button>
      ))}
    </div>
  );
}

export function WebLeadsBrowser({
  canMutate,
  teamView = false,
}: {
  canMutate: boolean;
  teamView?: boolean;
}) {
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

  /**
   * The filter sheet, below `2xl`. LOCAL state and not a URL param, for the
   * same reason Call Mode is: a `?filters=1` link would open a modal over
   * somebody else's screen, and these links get pasted into chat. What the
   * sheet SETS is entirely URL-driven, so the shareable part still travels.
   *
   * IT DELIBERATELY DOES NOT CLOSE ON A URL CHANGE, unlike `selected` below.
   * Every tick inside it pushes a new URL, so closing on `sp` would slam the
   * sheet shut the instant a rep chose their first province -- they would get
   * exactly one filter per open. It closes on Escape, the backdrop, the footer
   * button, and by unmounting when the view switches to My Leads (which has no
   * rail; see `listBlock`).
   */
  const [filtersOpen, setFiltersOpen] = useState(false);

  /**
   * Ticked lead ids, and the result of the last claim.
   *
   * Selection lives HERE rather than inside LeadsTable so the toolbar's
   * "Claim N" button and the table's checkboxes cannot disagree about what is
   * selected. A button that claims a different set than the one highlighted is
   * the kind of bug a rep only discovers after the calls are made.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [claiming, setClaiming] = useState(false);
  const [claimNote, setClaimNote] = useState<string | null>(null);
  /**
   * Bumped after any successful claim or release, to force a refetch.
   *
   * The list effect keys off `filters`. After a claim the URL is unchanged, so
   * pushing the same filters does not change that dependency and the effect
   * never re-runs; router.refresh() does not help either, since this is a
   * client component holding its own state. The claimed rows therefore stayed
   * sitting in the pool until the rep navigated away -- looking exactly as
   * though the claim had failed. (Codex review, 2026-08-24.)
   */
  const [refreshKey, setRefreshKey] = useState(0);

  // A selection is only meaningful against the rows it was made on. When the
  // filters, page or view change, the ticked ids may no longer be on screen --
  // and claiming rows a rep cannot see is exactly the surprise this feature
  // exists to prevent.
  useEffect(() => { setSelected(new Set()); setClaimNote(null); }, [sp]);

  // Local draft for the search box, synced from the URL. See LeadsToolbar's
  // input for why this exists instead of defaultValue.
  const [queryDraft, setQueryDraft] = useState(filters.query);
  useEffect(() => { setQueryDraft(filters.query); }, [filters.query]);

  const push = useCallback((f: WebLeadFilters) => {
    const qs = filtersToParams(f).toString();
    router.push(qs ? `/web-leads?${qs}` : "/web-leads", { scroll: false });
  }, [router]);

  /**
   * ═══ FILTERS SURVIVE LEAVING THE PAGE (Adon, 2026-08-25) ══════════════════
   *
   * "once you click the filters until you un-click the filters, it's going to
   * stay on that filter no matter where you go."
   *
   * Filters live in the URL, which makes them exact and shareable and also
   * makes them die the moment a rep opens a battle card or any sidebar tab.
   * Coming back lands on a bare /web-leads, so a rep claiming fifty Toronto
   * salons re-picked province, city and industry after every single lead.
   *
   * TWO EFFECTS, IN THIS ORDER, AND THE ORDER MATTERS.
   *
   * The restore runs ONCE, on mount, and only when the URL carries no filters
   * -- so it can never fight a rep who is actively filtering, and never
   * overrides a link somebody was sent. `router.replace`, not `push`, so the
   * bare URL does not become a back-button stop that bounces them straight
   * forward again.
   *
   * The remember runs on every change AFTER that, never before: writing on the
   * first render would overwrite a real memory with the empty URL we are about
   * to replace, which is the whole bug in miniature.
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const current = sp.toString();
    if (!hasNoFilters(current)) return;
    const remembered = readRememberedFilters();
    if (!remembered) return;
    // Carry an open drawer through: a rep who deep-linked to one lead keeps it
    // open, with the filters it was found under restored around it.
    const leadId = new URLSearchParams(current).get("lead");
    const target = leadId ? `${remembered}&lead=${encodeURIComponent(leadId)}` : remembered;
    router.replace(`/web-leads?${target}`, { scroll: false });
  }, [sp, router]);

  useEffect(() => {
    if (!restoredRef.current) return;
    rememberFilters(sp.toString());
  }, [sp]);

  // Switching views keeps every other field (filters, page, an open lead)
  // intact -- Leads' own filters simply go unread by Pipeline/Territories, so a
  // rep who narrows to "Toronto salons", checks Pipeline, then comes back finds
  // their filters exactly where they left them.
  const setView = useCallback((v: WebLeadView) => push({ ...filters, view: v }), [push, filters]);
  const closeLead = useCallback(() => push({ ...filters, leadId: null }), [push, filters]);
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
    if (view === "territories") {
      setLeads([]);
      setLeadsKey(null);
      setTotal(0);
      setPageSize(Number.POSITIVE_INFINITY);
      setFacets(null);
      setFacetError(null);
      setListError(null);
      setLoading(false);
      return () => { alive = false; };
    }
    setLoading(true);
    const qs = filtersToParams({ ...filters, leadId: null }).toString();
    // scope=mine asks for the caller's own book; the default pool excludes
    // every lead somebody currently holds. `view` is already in `qs` (it is a
    // filter), but the server reads scope explicitly rather than inferring it
    // from a presentation concern.
    const url = webLeadsRequestUrls(qs).list;
    fetchCachedWebLeadsJson<{
      leads: WebLeadRow[];
      total: number;
      page: number;
      pageSize: number;
      facets: Facets | null;
    }>(url)
      .then((body) => {
        if (!alive) return;
        setLeads(body.leads);
        // Stamped from `qs`, the query these leads were fetched with -- not
        // from `filters`, which may already have moved on. That is the whole
        // point of the stamp.
        setLeadsKey(qs);
        setTotal(body.total);
        setPageSize(body.pageSize);
        setFacets(body.facets);
        setFacetError(null);
        setListError(null);
      })
      .catch((e) => {
        if (!alive) return;
        const message = e instanceof Error ? e.message : "failed";
        setListError(message);
        setFacets(null);
        setFacetError(message);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filters, refreshKey, view]);

  // Name the filter that emptied the list rather than saying a bare "0 results".
  const emptyHint = useMemo(() => {
    const parts: string[] = [];
    if (filters.industries.length) parts.push(filters.industries.join(" or "));
    if (filters.cities.length) parts.push(`in ${filters.cities.join(" or ")}`);
    else if (filters.provinces.length) parts.push(`in ${filters.provinces.join(" or ")}`);
    if (filters.noSiteOnly) parts.push("with no website found yet");
    // Named explicitly because this is the filter most likely to have emptied
    // the page for a reason that has nothing to do with the rep's targeting:
    // it is 7am where they are, or the directory holds no hours for any of them.
    if (filters.openNow) parts.push("open right now in their own time zone");
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

  const mine = view === "mine";
  const canOperateCurrentView = canMutate && !(teamView && mine);

  /**
   * Claim the ticked leads into my book, or (in My Leads) release them back to
   * the pool.
   *
   * REPORTS WHAT ACTUALLY HAPPENED, not what was attempted. A rep ticks 60,
   * two were taken by someone else in the last minute and one is over their
   * cap: saying "claimed 60" would be a lie the rep only discovers when three
   * of their calls turn out to belong to someone else. The server returns the
   * granted, refused and lost-race sets separately and this renders the
   * difference. Same discipline assign.ts documents: "a half-assigned territory
   * that reports success is worse than an error".
   */
  const runClaim = useCallback(async () => {
    if (!canOperateCurrentView) return;
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setClaiming(true);
    setClaimNote(null);
    try {
      const r = await fetch(`/api/web-leads/claim${mine ? "?release=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: ids }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setClaimNote(body?.error ? `Could not do that: ${body.error}` : "Could not do that. Try again.");
        return;
      }
      invalidateWebLeadsClientCache();
      if (mine) {
        const n = (body.released || []).length;
        const failed = (body.refused || []).length;
        setClaimNote(
          `Released ${n} back to the pool.` + (failed ? ` ${failed} could not be released.` : ""),
        );
      } else {
        const got = (body.claimed || []).length;
        const lost = (body.lostRace || []).length;
        const capped = (body.refused || []).filter((x: { reason: string }) => x.reason === "at_capacity").length;
        const gone = (body.refused || []).length - capped;
        const trackingFailed = (body.trackingFailed || []).length;
        setClaimNote(
          [
            `Claimed ${got}.`,
            lost ? `${lost} were taken by someone else just now.` : "",
            gone ? `${gone} were already held.` : "",
            capped ? `${capped} would put you over your ${body.cap} lead limit.` : "",
            trackingFailed ? `${trackingFailed} claims saved, but their activity tracking needs an admin check.` : "",
            `You now hold ${body.held} of ${body.cap}.`,
          ].filter(Boolean).join(" "),
        );
      }
      setSelected(new Set());
      // Re-read so the claimed leads leave the pool (or the released ones leave
      // my book) at once, rather than lingering until the next navigation.
      setRefreshKey((n) => n + 1);
    } catch {
      setClaimNote("Could not confirm whether the server finished. Refresh before trying again so you do not act on stale ownership.");
    } finally {
      setClaiming(false);
    }
  }, [canOperateCurrentView, selected, mine]);

  /**
   * YOU CANNOT CALL WHAT YOU DO NOT HOLD.
   *
   * Call Mode used to open straight off the shared pool. That quietly defeated
   * the entire claim system: two reps on the same filtered view -- "Toronto
   * salons under 40", the obvious Monday queue -- both pressed Start calling
   * and dialled the same businesses, because nothing about calling a pool lead
   * assigned it to anyone. Every guarantee elsewhere in this feature was intact
   * and the one path a rep actually uses went around all of it. (Codex review,
   * 2026-08-23.)
   *
   * From the pool, Start calling now CLAIMS this page first and enters Call
   * Mode on what was actually granted. From My leads it opens directly -- those
   * are already yours.
   *
   * Claiming the page rather than all 3,760 matches is deliberate: a rep works
   * a page at a time, and locking thousands of leads behind one button press
   * would drain the pool for everyone else in a single click.
   */
  const startCalling = useCallback(async () => {
    if (!canOperateCurrentView) return;
    if (mine) { setCalling(true); return; }
    const ids = leads.map((l) => l.id);
    if (ids.length === 0) return;
    setClaiming(true);
    setClaimNote(null);
    try {
      const r = await fetch("/api/web-leads/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: ids }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setClaimNote(body?.error ? `Could not start: ${body.error}` : "Could not start calling. Try again.");
        return;
      }
      invalidateWebLeadsClientCache();
      const got: string[] = body.claimed || [];
      const trackingFailed = (body.trackingFailed || []).length;
      if (got.length === 0) {
        // Never open an empty queue and let the rep discover it. Say why.
        setClaimNote(
          `Nothing to call — these were all taken by someone else, or you are at your ${body.cap} lead limit. You hold ${body.held}.`,
        );
        return;
      }
      setClaimNote(
        `Claimed ${got.length} of ${ids.length}. You now hold ${body.held} of ${body.cap}. They are yours until you release them.` +
          (trackingFailed ? ` ${trackingFailed} activity records need an admin check.` : ""),
      );
      // Land in My leads: the queue a rep works is their own book, and the
      // claimed leads have by definition just left the pool this view shows.
      push({ ...filters, view: "mine", page: 1 });
      setCalling(true);
    } catch {
      setClaimNote("Could not confirm whether the claims finished. Refresh before calling so you only work leads shown in your book.");
    } finally {
      setClaiming(false);
    }
  }, [canOperateCurrentView, mine, leads, push, filters]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[], select: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) { if (select) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  const listBlock = (
    // `2xl:flex` rather than `flex`: below 1536 the rail is a sheet, so there
    // is no second column to lay out and the results take the full content box.
    // See FilterRail.tsx for the arithmetic -- at 1280 a persistent rail leaves
    // the pool 692px for a 730px table and clips a control out of an
    // `overflow-hidden` wrapper, which is happening in production today.
    <div className="2xl:flex 2xl:gap-7">
      {/* The rail narrows the shared pool. A rep's own book is small enough to
          scan and is not filtered by geography -- filtering your own 100 leads
          by province is a question nobody has. */}
      {!mine && (
        <>
          <FilterRail facets={facets} filters={filters} onChange={push} loading={!facets && !facetError} error={facetError} />
          <FilterSheet
            open={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            facets={facets}
            filters={filters}
            onChange={push}
            loading={!facets && !facetError}
            error={facetError}
            total={loading ? undefined : total}
          />
        </>
      )}

      <div className="min-w-0 flex-1 space-y-4">
        <LeadsToolbar
          filters={filters}
          onChange={push}
          total={total}
          loading={loading}
          queryDraft={queryDraft}
          onQueryDraft={setQueryDraft}
          onStartCalling={startCalling}
          canStartCalling={!loading && leads.length > 0 && !claiming}
          selectedCount={selected.size}
          onClaim={runClaim}
          claiming={claiming}
          claimLabel={mine ? "Release" : "Claim"}
          canMutate={canOperateCurrentView}
          filterCount={activeFilterCount(filters)}
          onOpenFilters={mine ? null : () => setFiltersOpen(true)}
        />

        {claimNote && (
          <p className="rounded-lg border border-bg-border bg-bg-panel px-3.5 py-2.5 text-sm text-fg-muted">
            {claimNote}
          </p>
        )}

        <LeadsTable
          leads={leads} total={total} page={filters.page} pageSize={pageSize}
          onPage={(n) => push({ ...filters, page: n })}
          onOpen={openLead}
          loading={loading} error={listError}
          emptyHint={mine ? (teamView ? "No roster-assigned team leads yet." : "Nothing in your book yet. Go to Leads, tick the ones you want and claim them.") : emptyHint}
          selected={selected} onToggle={toggle} onToggleAll={toggleAll}
          showStage={mine}
          canSelect={canOperateCurrentView}
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={mine ? (teamView ? "Team leads" : "My leads") : "Leads"}
        subtitle={
          mine
            ? teamView
              ? "Read-only roster view of every lead assigned to the OASIS sales team."
              : "The leads you have claimed. Nobody else can call these while you hold them."
            : "Canadian businesses by province, city and industry. Website status is from a public directory and has not been verified, confirm on the call."
        }
        action={<ViewSwitcher active={view} onChange={setView} teamView={teamView} />}
      />

      {(view === "leads" || mine) && listBlock}

      {view === "territories" && (
        <div className="max-w-3xl">
          <TerritoryAssignment />
        </div>
      )}

      {calling && canOperateCurrentView && (
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
          // No onOpenDetail any more: Call Mode's "Full detail" is now a link
          // to /web-leads/[id] (the battle card) in a new tab, so a rep reading
          // the deep view keeps their place in the queue instead of dropping
          // out of Call Mode to open a narrower drawer behind it.
          hasMore={filters.page < pages}
          onLoadMore={() => push({ ...filters, page: filters.page + 1 })}
        />
      )}

      {filters.leadId && <WebLeadDetail leadId={filters.leadId} onClose={closeLead} canMutate={canOperateCurrentView && mine} />}
    </div>
  );
}
