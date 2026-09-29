/**
 * /feed — Team › Feed: what the departments did, and what is waiting on you.
 *
 * Tabs: Needs you · All · Shipped, plus a department filter (design doc 01
 * §(c) Feed). Needs you is where approval cards land; approvals have not
 * shipped, so it says plainly that nothing is held rather than showing a count
 * of zero for a queue that does not exist.
 *
 * SCOPE, IN ORDER, ALL ON THE SERVER:
 *   1. requireOsRoute("/feed") — the rail's own gate, first, before any read.
 *   2. loadTenantFeed(session tenant) — correlation_id = the viewer's
 *      workspace, for EVERY viewer, operators included. The empire-wide
 *      operator branch the old tape had (isOperatorEmail → no filter) is not
 *      reachable from this page; it belongs to Admin › Event log.
 *   3. visibleFeedRows — the tape's audience (system surfaces, where it lived
 *      on /operations), minus departments the viewer cannot open and money
 *      rows for anyone who may not read company financials.
 * A viewer outside the tape's audience never triggers the read at all.
 */

import { PageFrame } from "@/components/os/PageFrame";
import { Card } from "@/components/Card";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { loadTenantFeed } from "@/components/os/landings/feed-data";
import {
  parseFeedDepartment,
  parseFeedTab,
  rowsForTab,
  isShipped,
  visibleFeedRows,
  type FeedTab,
} from "@/components/os/landings/feed-model";
import {
  FeedDepartmentChips,
  FeedRows,
  FeedTabs,
  NeedsYouEmpty,
  type FeedDepartmentOption,
} from "@/components/os/landings/FeedView";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { mayOpenOsHref } from "@/lib/os/nav";
import type { DepartmentKey } from "@/lib/os/types";
import { FeedRefresher } from "./refresher";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feed" };

type Search = { tab?: string | string[]; dept?: string | string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function FeedPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const viewer = await requireOsRoute("/feed");
  const sp = (await searchParams) ?? {};
  const { capabilities, tenantId } = viewer.surface;
  const canSeeTape = capabilities.canSeeSystemSurfaces;

  // Chips = the departments this viewer's rail draws. A department they cannot
  // open is neither a filter nor, below, a source of rows.
  const departments: FeedDepartmentOption[] = OS_DEPARTMENTS.filter((d) => mayOpenOsHref(viewer.navInput, d.href)).map(
    (d) => ({ key: d.key, slug: d.slug, label: d.label }),
  );
  const departmentLabels: Partial<Record<DepartmentKey, string>> = Object.fromEntries(
    departments.map((d) => [d.key, d.label]),
  );

  const tab = parseFeedTab(first(sp.tab), canSeeTape);
  const dept = canSeeTape ? parseFeedDepartment(first(sp.dept), departments) : null;
  const deptSlug = dept ? departments.find((d) => d.key === dept)?.slug ?? null : null;
  const tabs: FeedTab[] = canSeeTape ? ["needs", "all", "shipped"] : ["needs"];

  const feed = canSeeTape ? await loadTenantFeed({ tenantId }) : null;
  const visible =
    feed && feed.ok
      ? visibleFeedRows(feed.rows, {
          canSeeTape,
          canSeeCompanyFinancials: capabilities.canSeeCompanyFinancials,
          departments: new Set(departments.map((d) => d.key)),
        })
      : [];
  const inDept = dept ? rowsForTab(visible, "all", dept) : visible;
  const counts: Partial<Record<FeedTab, number>> =
    feed && feed.ok ? { all: inDept.length, shipped: inDept.filter(isShipped).length } : {};
  const rows = rowsForTab(visible, tab, dept);
  const deptLabel = dept ? departmentLabels[dept] : null;

  return (
    <PageFrame
      title="Feed"
      subtitle={
        canSeeTape
          ? `What your departments did in the last ${feed && feed.ok ? feed.windowDays : 7} days, and what is waiting on you.`
          : "What is waiting on you."
      }
      actions={canSeeTape ? <FeedRefresher /> : undefined}
    >
      <div className="space-y-4">
        <FeedTabs active={tab} tabs={tabs} deptSlug={deptSlug} counts={counts} />
        {canSeeTape && tab !== "needs" && <FeedDepartmentChips tab={tab} active={dept} options={departments} />}

        {tab === "needs" ? (
          <NeedsYouEmpty />
        ) : feed && !feed.ok ? (
          <Card>
            <div className="py-6">
              <p className="text-sm font-medium text-fg">Couldn&rsquo;t load the feed.</p>
              <p className="mt-1 text-[13px] text-fg-muted">
                This is a failed read, not a quiet week. The error has been logged; refresh to try again.
              </p>
            </div>
          </Card>
        ) : (
          <>
            <FeedRows
              rows={rows}
              departmentLabels={departmentLabels}
              emptyMessage={
                tab === "shipped"
                  ? `Nothing shipped${deptLabel ? ` from ${deptLabel}` : ""} in the last ${feed?.ok ? feed.windowDays : 7} days.`
                  : `No ${deptLabel ? `${deptLabel} ` : ""}activity in the last ${feed?.ok ? feed.windowDays : 7} days.`
              }
            />
            {feed?.ok && feed.truncated && (
              <p className="text-xs text-fg-dim">Showing the latest {feed.rows.length} events in this window.</p>
            )}
          </>
        )}
      </div>
    </PageFrame>
  );
}
