"use client";

/**
 * clients-status: the Clients list's status tabs (All, Prospect, Onboarding,
 * Active, Paused, Past) and the records under them.
 *
 * A TAB FILTERS WHAT THE PAGE ALREADY HAS. The server reads every status once
 * (a 500-row page, lib/os/customers/store.ts listCustomers) and renders each
 * record's row; a tab click shows that status's rows at once and writes the
 * status into the address bar with history.replaceState, which Next keeps in
 * step with useSearchParams without a server round trip. A refresh, Back or a
 * shared link opens the same status, because the address bar is the source of
 * truth: this list follows it whenever it changes (the rail, Clear, Back). The
 * click's own write reaches useSearchParams in a transition, a moment after
 * the click's render, so a click is shown at once and the bar catches up
 * (clickStatus, followAddressBar).
 *
 * A LIST CUT AT ITS PAGE SIZE (`fromServer`) cannot be filtered from the rows
 * at hand, so there a tab is a link: the server reads that status, the tab bar
 * answers the click while it does (components/os/OsTabBar.tsx), and the rows
 * shown are the server's, for the status in the address bar.
 *
 * The rows themselves are rendered on the server (app/clients/page.tsx
 * CustomerRow) and handed over as elements, one per record, so health badges,
 * owners and last touch read exactly as before; this file only chooses which
 * of them to show. All splits current clients from Past ones, as before.
 *
 * Server components never import this file (or components/os/OsTabBar.tsx)
 * directly: they use the re-exports in clients-actions.tsx, the Clients pages'
 * one client boundary. Why is in that file's header.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/Card";
import { OsTabBar, type OsTab } from "@/components/os/OsTabBar";
import { CUSTOMER_LIFECYCLES, CUSTOMER_LIFECYCLE_LABELS, isOneOf, type CustomerLifecycle } from "@/lib/os/customers/rules";

/** A status tab's key: "" is All. */
export type ClientStatus = "" | CustomerLifecycle;

/** The status a `lifecycle` search param names; anything else is All. PURE. */
export function clientStatusOf(param: string | null | undefined): ClientStatus {
  return isOneOf(CUSTOMER_LIFECYCLES, param) ? param : "";
}

/**
 * Which rows a status shows, by index into the page's rows (kept in the
 * server's order). All lists current clients, then Past ones under their own
 * heading; a status lists its own. PURE.
 */
export function rowsForStatus(lifecycles: readonly CustomerLifecycle[], status: ClientStatus): { current: number[]; past: number[] } {
  const all = lifecycles.map((_, i) => i);
  if (status) return { current: all.filter((i) => lifecycles[i] === status), past: [] };
  return { current: all.filter((i) => lifecycles[i] !== "churned"), past: all.filter((i) => lifecycles[i] === "churned") };
}

/** The status in the address bar, kept current by Next through replaceState and every navigation. */
function useStatusInUrl(): ClientStatus {
  return clientStatusOf(useSearchParams().get("lifecycle"));
}

/** What the list shows, and the address bar's status as this list last saw it. */
export type StatusView = { shown: ClientStatus; seen: ClientStatus };

/**
 * A tab click: its rows are shown at once. The click also writes the address
 * bar, but Next applies that write in a transition, a moment AFTER this
 * render, so `seen` waits for it; were it moved now, the bar's old value would
 * read as a change from outside and pull the list back to the tab just left.
 * PURE.
 */
export function clickStatus(view: StatusView, status: ClientStatus): StatusView {
  return { shown: status, seen: view.seen };
}

/**
 * Every render: a status the address bar did not hold before (Back, Clear,
 * the rail, or a click's own write landing) is followed; an unchanged bar
 * leaves the clicked tab shown. Returns `view` itself when nothing changed. PURE.
 */
export function followAddressBar(view: StatusView, inUrl: ClientStatus): StatusView {
  return inUrl === view.seen ? view : { shown: inUrl, seen: inUrl };
}

function Table({ head, rows }: { head: ReactNode; rows: ReactNode[] }) {
  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[840px] text-sm">
          {head}
          <tbody className="divide-y divide-hairline">{rows}</tbody>
        </table>
      </div>
    </Card>
  );
}

export function ClientsByStatus({
  tabs,
  fromServer,
  lifecycles,
  rows,
  head,
  empty,
  formFiltered,
  filterForm,
}: {
  /** One per status; each href keeps the form's filters. */
  tabs: readonly OsTab[];
  /** The list hit its page size: a tab navigates and the server reads that status. */
  fromServer: boolean;
  /** Each row's status, in the server's order. */
  lifecycles: readonly CustomerLifecycle[];
  /** Each record's row, rendered on the server, in the same order. */
  rows: readonly ReactNode[];
  /** The table's header row, rendered on the server. */
  head: ReactNode;
  /** What All shows when there are no records at all. */
  empty: ReactNode;
  /** The search, owner or archived filter is on. */
  formFiltered: boolean;
  /** The search form, drawn between the tabs and the records as before. */
  filterForm: ReactNode;
}) {
  const inUrl = useStatusInUrl();
  const [view, setView] = useState<StatusView>({ shown: inUrl, seen: inUrl });
  // When the address bar changes (the rail, Clear, Back, or a click's own
  // write landing), the list follows it.
  const followed = followAddressBar(view, inUrl);
  if (followed !== view) setView(followed);
  // A cut list holds one status's rows, from the server: it shows the address bar's.
  const status = fromServer ? inUrl : followed.shown;
  const pick = (key: string, href: string) => {
    setView((v) => clickStatus(v, clientStatusOf(key)));
    // No server round trip: the rows are already here.
    window.history.replaceState(null, "", href);
  };
  const { current, past } = rowsForStatus(lifecycles, status);
  const label = status ? CUSTOMER_LIFECYCLE_LABELS[status] : "";

  return (
    <>
      <OsTabBar label="Client status" tabs={tabs} active={status} onSelect={fromServer ? undefined : pick} />
      {filterForm}
      {rows.length === 0 && !status ? (
        empty
      ) : current.length === 0 && past.length === 0 ? (
        <Card>
          <p className="py-4 text-[13px] text-fg-muted">
            {formFiltered ? "No clients match these filters." : `No clients with the status ${label}.`}
          </p>
        </Card>
      ) : (
        <>
          {current.length > 0 ? (
            <Table head={head} rows={current.map((i) => rows[i])} />
          ) : (
            <Card>
              <p className="py-4 text-[13px] text-fg-muted">No current clients. Every client record here is a past engagement.</p>
            </Card>
          )}
          {past.length > 0 && (
            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-fg">Past clients</h2>
                <p className="mt-0.5 text-[13px] text-fg-muted">Engagements that ended. Their history stays on each record.</p>
              </div>
              <Table head={head} rows={past.map((i) => rows[i])} />
            </section>
          )}
        </>
      )}
    </>
  );
}

/** The filter form's status: carried into a search, so it keeps the tab the list is on. */
export function ClientStatusField() {
  const status = useStatusInUrl();
  return status ? <input type="hidden" name="lifecycle" value={status} /> : null;
}

/** "Clear", while any filter or a status is on. */
export function ClearClientFilters({ formFiltered }: { formFiltered: boolean }) {
  const status = useStatusInUrl();
  if (!formFiltered && !status) return null;
  return (
    <Link href="/clients" prefetch={false} className="pb-2 text-sm text-fg-muted hover:text-fg">
      Clear
    </Link>
  );
}

/**
 * A client record's tab bar, drawn by its layout (app/clients/[id]/layout.tsx).
 * A layout is not rendered again when only ?tab= changes, so the bar reads the
 * tab from the address bar (`param`); a missing or unknown one is Overview,
 * the first tab, as the page renders it.
 */
export function ClientRecordTabs({ tabs }: { tabs: readonly OsTab[] }) {
  return <OsTabBar label="Client record" param="tab" tabs={tabs} />;
}
