/**
 * The geometry harness's client entry.
 *
 * WHY A REAL CLIENT BUNDLE AND NOT renderToStaticMarkup: effects have to run.
 * `useNow()` drives the reachability cell, `useAudit()` drives Call Mode's
 * talking points, and the filter sheet's open/closed state is `useState`. A
 * static render measures the skeleton and the closed drawer -- i.e. exactly the
 * states that cannot overflow -- and would have reported a clean pass on a
 * layout nobody had actually laid out.
 *
 * `fetch` is stubbed to serve one synthetic audit so no network, no login and
 * no real lead is involved. The app's own login wall is what has stopped every
 * previous session looking at this feature in a browser at all.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PageHeader } from "@/components/Card";
import { LeadsTable } from "@/components/web-leads/LeadsTable";
import { FilterRail, FilterSheet, activeFilterCount } from "@/components/web-leads/FilterRail";
import { LeadsToolbar } from "@/components/web-leads/LeadsToolbar";
import { CallMode } from "@/components/web-leads/CallMode";
import { parseFilters } from "@/lib/web-leads/filters";
import { LEADS, FACETS } from "./fixtures";
import { AUDIT } from "./audit-fixture";

const origFetch = window.fetch;
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  if (url.includes("/audit")) {
    return Promise.resolve(new Response(JSON.stringify(AUDIT), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return origFetch(input as RequestInfo, init);
}) as typeof window.fetch;

const filters = parseFilters(new URLSearchParams("prov=ON,QC&city=Toronto&ind=Restaurants%20%26%20Bars&nosite=1&open=1&q=brasserie&band=under40"));
const noop = () => {};

/**
 * The list block, reproducing WebLeadsBrowser's own wrapper markup.
 *
 * `.measure/measure.mjs` reads WebLeadsBrowser.tsx and requires the wrapper
 * class string below to be the one the app actually renders, so this cannot
 * silently drift from the page it claims to measure -- a harness measuring a
 * layout the app no longer ships is worse than no harness, because it reports
 * a pass.
 *
 * `?sheet=1` mounts the filter sheet OPEN. A closed overlay is exactly the
 * state that cannot overflow, so measuring only that would grade the one case
 * that was never in doubt.
 */
function ListBlock({ mine }: { mine: boolean }) {
  const [sheetOpen, setSheetOpen] = useState(new URLSearchParams(location.search).get("sheet") === "1" && !mine);
  const [selected, setSelected] = useState<Set<string>>(new Set(["fixture-0001"]));
  const toggle = (id: string) =>
    setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="2xl:flex 2xl:gap-7">
      {!mine && (
        <>
          <FilterRail facets={FACETS} filters={filters} onChange={noop} loading={false} error={null} />
          <FilterSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            facets={FACETS}
            filters={filters}
            onChange={noop}
            loading={false}
            error={null}
            total={3760}
          />
        </>
      )}
      <div className="min-w-0 flex-1 space-y-4">
        <LeadsToolbar
          filters={filters}
          onChange={noop}
          total={3760}
          loading={false}
          queryDraft=""
          onQueryDraft={noop}
          onStartCalling={noop}
          canStartCalling
          selectedCount={selected.size}
          onClaim={noop}
          claiming={false}
          claimLabel={mine ? "Release" : "Claim"}
          canMutate
          filterCount={activeFilterCount(filters)}
          onOpenFilters={mine ? null : () => setSheetOpen(true)}
        />
        <LeadsTable
          leads={LEADS}
          total={3760}
          page={1}
          pageSize={2}
          onPage={noop}
          onOpen={noop}
          loading={false}
          error={null}
          emptyHint="No leads."
          selected={selected}
          onToggle={toggle}
          onToggleAll={noop}
          showStage={mine}
          canSelect
        />
      </div>
    </div>
  );
}

/**
 * ONE SURFACE PER PAGE LOAD, selected by ?surface=.
 *
 * Call Mode sets `document.body.style.overflow = "hidden"` on mount (it is a
 * modal overlay). Mounting it alongside the list would suppress the page
 * scroller and make the list's own horizontal overflow unmeasurable -- the
 * harness would report a clean pass on a page that overflows.
 */
const SURFACE = new URLSearchParams(location.search).get("surface") || "list";

function mount(id: string, node: React.ReactNode) {
  const el = document.getElementById(id);
  if (el) { el.removeAttribute("hidden"); createRoot(el).render(node); }
}

if (SURFACE === "list") {
  mount("header", (
    <PageHeader
      title="Leads"
      subtitle="Canadian businesses by province, city and industry. Website status is from a public directory and has not been verified, confirm on the call."
      action={
        <div role="tablist" aria-label="View" className="inline-flex items-center gap-0.5 rounded-lg border border-bg-border bg-bg-panel p-0.5">
          {["Leads", "My leads", "Assign"].map((l, idx) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={idx === 0}
              className={`inline-flex min-h-11 items-center rounded-md px-3.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:py-1.5 ${
                idx === 0 ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-bg-elev hover:text-fg"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      }
    />
  ));
  mount("pool", <ListBlock mine={false} />);
  mount("mine", <ListBlock mine />);
}
if (SURFACE === "call") {
  mount("callmode", (
    <CallMode
      leads={LEADS}
      queueKey="k"
      queueLabel="Restaurants & Bars · Toronto · under 40"
      ready
      onExit={noop}
      onLoadMore={noop}
      hasMore
    />
  ));
}
