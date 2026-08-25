/**
 * BASELINE entry: the layout exactly as `main` ships it today, so the harness
 * can be checked against a known number (the 823px table floor documented in
 * LeadsTable.tsx) before it is trusted to grade anything new.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { LeadsTable } from "@/components/web-leads/LeadsTable";
import { FilterRail } from "@/components/web-leads/FilterRail";
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

const filters = parseFilters(new URLSearchParams("provinces=ON&industries=Restaurants+%26+Bars&band=under40"));
const noop = () => {};

function ListBlock({ mine }: { mine: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(["fixture-0001"]));
  return (
    <div className="flex gap-7">
      {!mine && (
        <FilterRail facets={FACETS} filters={filters} onChange={noop} loading={false} error={null} />
      )}
      <div className="min-w-0 flex-1 space-y-4">
        <LeadsToolbar
          filters={filters} onChange={noop} total={3760} loading={false}
          queryDraft="" onQueryDraft={noop} onStartCalling={noop} canStartCalling
          selectedCount={selected.size} onClaim={noop} claiming={false}
          claimLabel={mine ? "Release" : "Claim"} canMutate
        />
        <LeadsTable
          leads={LEADS} total={3760} page={1} pageSize={50} onPage={noop} onOpen={noop}
          loading={false} error={null} emptyHint="No leads."
          selected={selected} onToggle={(id) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          onToggleAll={noop} showStage={mine} canSelect
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
  mount("pool", <ListBlock mine={false} />);
  mount("mine", <ListBlock mine />);
}
if (SURFACE === "call") {
  mount("callmode", (
    <CallMode leads={LEADS} queueKey="k" queueLabel="Restaurants & Bars · Toronto · under 40" ready onExit={noop} onLoadMore={noop} hasMore />
  ));
}
