/**
 * /feed — Team › Feed: what the departments did, and what is waiting on you.
 *
 * Tabs: Needs you · All · Shipped, plus a department filter (design doc 01
 * §(c) Feed). Needs you holds the approval cards (lib/os/approvals): every
 * outward action a department drafted, waiting for Approve · Send back ·
 * Comment, and under them the last week of decisions with their REAL outcomes
 * ("Sent ✓", "Failed: …"). It opens by default whenever something is waiting.
 *
 * Unfiltered, the tab's count and its other rows are Today's own
 * (components/os/today/brief-load.ts loadViewerNeedsYou, model.ts
 * needsYouTotal): the tab used to count approvals alone while Today's pill
 * counted every source, two "Needs you" labels with two numbers. Filtered by
 * a department, it is that department's approvals, as before.
 *
 * SCOPE, IN ORDER, ALL ON THE SERVER:
 *   1. requireOsRoute("/feed") — the rail's own gate, first, before any read.
 *   2. Approvals: the session's workspace, cut to the departments this viewer
 *      is seated in and the rail opens (lib/os/approvals/scope.ts). Owners and
 *      admins see every department.
 *   3. loadTenantFeed(session tenant) — correlation_id = the viewer's
 *      workspace, for EVERY viewer, operators included. The empire-wide
 *      operator branch the old tape had (isOperatorEmail → no filter) is not
 *      reachable from this page; it belongs to Admin › Event log.
 *   4. visibleFeedRows — the tape's audience (system surfaces, where it lived
 *      on /operations), minus departments the viewer cannot open and money
 *      rows for anyone who may not read company financials.
 * A viewer outside the tape's audience never triggers the event read at all.
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
import { ApprovalCard } from "@/components/os/approvals/ApprovalCard";
import { loadPendingApprovals, loadRecentDecisions } from "@/components/os/approvals/load";
import { loadViewerNeedsYou } from "@/components/os/today/brief-load";
import { isReviewItem, needsYouTotal, type NeedsYou } from "@/components/os/today/model";
import { NeedsYouRows } from "@/components/os/today/NeedsYouList";
import { approvalScopeFromViewer } from "@/lib/os/approvals/scope";
import { safe } from "@/lib/api-helpers";
import { floorCount } from "@/lib/os/count";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { mayOpenOsHref } from "@/lib/os/nav";
import type { DepartmentKey } from "@/lib/os/types";
import { FeedRefresher } from "./refresher";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feed" };

type Search = { tab?: string | string[]; dept?: string | string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Approval cards on the Needs-you tab, and decisions under them. */
const FEED_APPROVALS_SHOWN = 50;
const FEED_DECISIONS_SHOWN = 20;

export default async function FeedPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const viewer = await requireOsRoute("/feed");
  const sp = (await searchParams) ?? {};
  const { capabilities, tenantId, tenantSlug } = viewer.surface;
  const canSeeTape = capabilities.canSeeSystemSurfaces;

  // Chips = the departments this viewer's rail draws. A department they cannot
  // open is neither a filter nor, below, a source of rows.
  const departments: FeedDepartmentOption[] = OS_DEPARTMENTS.filter((d) => mayOpenOsHref(viewer.navInput, d.href)).map(
    (d) => ({ key: d.key, slug: d.slug, label: d.label }),
  );
  const departmentLabels: Partial<Record<DepartmentKey, string>> = Object.fromEntries(
    departments.map((d) => [d.key, d.label]),
  );

  const dept = parseFeedDepartment(first(sp.dept), departments);
  const deptSlug = dept ? departments.find((d) => d.key === dept)?.slug ?? null : null;
  const tabs: FeedTab[] = canSeeTape ? ["needs", "all", "shipped"] : ["needs"];

  // What is waiting on this viewer. Read first: it decides the default tab and
  // the Needs-you count. Unfiltered, the count is Today's (every source, one
  // list); filtered by a department, its approvals (rows carry no department).
  // Today's reads reject when one of them never answers (W0's deadlines). On
  // Today that is the page; here it is one tab's count and rows, so a hung
  // read degrades to the approvals count, as a floor, with a note, and never
  // takes the tape down with it.
  const scope = approvalScopeFromViewer({ surface: viewer.surface, navInput: viewer.navInput });
  const [pending, needsRead] = await Promise.all([
    loadPendingApprovals({ scope, tenantSlug, department: dept, limit: FEED_APPROVALS_SHOWN }),
    dept
      ? Promise.resolve(null)
      : safe<NeedsYou | "unread">(
          "feed.needs_you",
          loadViewerNeedsYou({ viewer: viewer.surface, navInput: viewer.navInput, approvalsLimit: 1 }),
          "unread",
        ),
  ]);
  const needsUnread = needsRead === "unread";
  const needs = needsUnread ? null : needsRead;
  const waiting = needs
    ? needsYouTotal(needs)
    : pending.ok
      ? { total: pending.value.total, capped: needsUnread }
      : null;
  // Rows other than approvals (which are drawn as full cards above them).
  const needsRows = needs?.items ?? [];
  const rowsWaiting = needsRows.some((item) => !isReviewItem(item));

  const rawTab = first(sp.tab);
  const tab: FeedTab =
    rawTab === undefined && waiting !== null && waiting.total > 0 ? "needs" : parseFeedTab(rawTab, canSeeTape);

  // The tape is read for its audience on every tab: the All / Shipped counts
  // on the tab bar come from it.
  const [feed, decisions] = await Promise.all([
    canSeeTape ? loadTenantFeed({ tenantId }) : Promise.resolve(null),
    tab === "needs" ? loadRecentDecisions({ scope, tenantSlug, department: dept, limit: FEED_DECISIONS_SHOWN }) : Promise.resolve(null),
  ]);
  const visible =
    feed && feed.ok
      ? visibleFeedRows(feed.rows, {
          canSeeTape,
          canSeeCompanyFinancials: capabilities.canSeeCompanyFinancials,
          departments: new Set(departments.map((d) => d.key)),
        })
      : [];
  const inDept = dept ? rowsForTab(visible, "all", dept) : visible;
  // A count nobody could finish is a floor ("3+"); a floor of 0 is no number at all.
  const needsCount = waiting && (waiting.total > 0 || !waiting.capped) ? floorCount(waiting.total, waiting.capped) : null;
  const counts: Partial<Record<FeedTab, number | string>> = {
    ...(needsCount !== null ? { needs: needsCount } : {}),
    ...(feed && feed.ok ? { all: inDept.length, shipped: inDept.filter(isShipped).length } : {}),
  };
  const unchecked = (needs?.unavailable ?? []).filter((source) => source !== "approvals");
  const rows = rowsForTab(visible, tab, dept);
  const deptLabel = dept ? departmentLabels[dept] : null;
  const windowDays = feed && feed.ok ? feed.windowDays : 7;

  return (
    <PageFrame
      title="Feed"
      subtitle={
        canSeeTape
          ? `What your departments did in the last ${windowDays} days, and what is waiting on you.`
          : "What is waiting on you."
      }
      actions={canSeeTape ? <FeedRefresher /> : undefined}
    >
      <div className="space-y-4">
        <FeedTabs active={tab} tabs={tabs} deptSlug={deptSlug} counts={counts} />
        <FeedDepartmentChips tab={tab} active={dept} options={departments} />

        {tab === "needs" ? (
          <div className="space-y-6">
            {!pending.ok ? (
              <Card>
                <div className="py-6">
                  <p className="text-sm font-medium text-fg">Couldn&rsquo;t load approvals.</p>
                  <p className="mt-1 text-[13px] text-fg-muted">
                    This is a failed read, not an empty queue. The error has been logged; refresh to try again.
                  </p>
                </div>
              </Card>
            ) : pending.value.items.length === 0 && !rowsWaiting && !needsUnread && unchecked.length === 0 ? (
              <NeedsYouEmpty department={deptLabel ?? null} />
            ) : pending.value.items.length > 0 ? (
              <section aria-label="Waiting on you" className="space-y-3">
                <ul className="space-y-3">
                  {pending.value.items.map((a) => (
                    <li key={a.id}>
                      <ApprovalCard approval={a} />
                    </li>
                  ))}
                </ul>
                {pending.value.total > pending.value.items.length && (
                  <p className="text-xs text-fg-dim">
                    Showing the oldest-waiting {pending.value.items.length} of {pending.value.total}. Decide these and the rest
                    move up.
                  </p>
                )}
              </section>
            ) : null}

            {/* The rest of what Today lists: follow-ups, tickets past SLA,
                failed routines, hot replies, connections, then Review. */}
            {needsRows.length > 0 && (
              <Card noPadding>
                <NeedsYouRows items={needsRows} />
              </Card>
            )}
            {unchecked.length > 0 && (
              <p className="text-xs text-status-warm">
                Couldn&rsquo;t check {unchecked.join(", ")} just now. This list may be incomplete; reload in a minute.
              </p>
            )}
            {needsUnread && (
              <p className="text-xs text-status-warm">
                Couldn&rsquo;t check the rest of what Today lists just now, so only approvals are counted here. Reload in a
                minute.
              </p>
            )}

            {decisions && (
              <section aria-labelledby="recent-decisions" className="space-y-3">
                <h2 id="recent-decisions" className="text-sm font-semibold text-fg">
                  Recently decided
                </h2>
                {!decisions.ok ? (
                  <p className="text-[13px] text-status-warm">Couldn&rsquo;t load recent decisions. Refresh to try again.</p>
                ) : decisions.value.items.length === 0 ? (
                  <p className="text-[13px] text-fg-muted">No decisions in the last 7 days.</p>
                ) : (
                  <>
                    <ul className="space-y-3">
                      {decisions.value.items.map((a) => (
                        <li key={a.id}>
                          <ApprovalCard approval={a} density="compact" />
                        </li>
                      ))}
                    </ul>
                    {/* More were decided than fit: say so, never imply the list is complete. */}
                    {decisions.value.truncated && (
                      <p className="text-xs text-fg-dim">
                        Showing the latest {decisions.value.items.length} decisions from the last 7 days; older ones are not listed here.
                      </p>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
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
              oasisWorkspace={viewer.oasis}
              emptyMessage={
                tab === "shipped"
                  ? `Nothing shipped${deptLabel ? ` from ${deptLabel}` : ""} in the last ${windowDays} days.`
                  : `No ${deptLabel ? `${deptLabel} ` : ""}activity in the last ${windowDays} days.`
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
