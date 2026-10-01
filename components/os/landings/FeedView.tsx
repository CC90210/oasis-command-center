/**
 * FeedView — the Feed's tabs, department chips and rows. Server component:
 * every row it receives has already been scoped to the workspace
 * (feed-data.ts) and cut to the viewer (feed-model.ts visibleFeedRows).
 *
 * Tabs and chips are plain links (?tab=, ?dept=), so the filtered view is a
 * URL someone can share and the page needs no client state. Prefetch is off:
 * a click re-renders the same route with a new query, and prefetching every
 * chip on every load would re-run the feed read for filters nobody picked.
 */

import Link from "next/link";
import { Card, Tag } from "@/components/Card";
import { projectEvent } from "@/lib/event-projection";
import { timeAgo } from "@/lib/fmt";
import type { DepartmentKey } from "@/lib/os/types";
import {
  FEED_TABS,
  departmentForEvent,
  displayPayload,
  feedPublisherLabel,
  feedSummary,
  feedSystemName,
  type FeedEventRow,
  type FeedTab,
} from "@/components/os/landings/feed-model";

export type FeedDepartmentOption = { key: DepartmentKey; slug: string; label: string };

function feedHref(tab: FeedTab, dept: string | null): string {
  const q = new URLSearchParams();
  q.set("tab", tab);
  if (dept) q.set("dept", dept);
  return `/feed?${q.toString()}`;
}

export function FeedTabs({
  active,
  tabs,
  deptSlug,
  counts,
}: {
  active: FeedTab;
  tabs: readonly FeedTab[];
  deptSlug: string | null;
  /**
   * Shown only for tabs with a known count: a failed read shows no number,
   * never 0. A floor arrives already formatted ("3+", lib/os/count.ts).
   */
  counts: Partial<Record<FeedTab, number | string>>;
}) {
  return (
    <nav aria-label="Feed" className="flex gap-1 border-b border-hairline">
      {FEED_TABS.filter((t) => tabs.includes(t.key)).map((t) => {
        const isActive = t.key === active;
        const count = counts[t.key];
        return (
          <Link
            key={t.key}
            href={feedHref(t.key, deptSlug)}
            prefetch={false}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
              isActive ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
            {count !== undefined && <span className="text-xs tabular-nums text-fg-dim">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

export function FeedDepartmentChips({
  tab,
  active,
  options,
}: {
  tab: FeedTab;
  active: DepartmentKey | null;
  options: readonly FeedDepartmentOption[];
}) {
  if (options.length === 0) return null;
  const chip = (isActive: boolean) =>
    `inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ${
      isActive ? "border-hairline bg-active text-fg" : "border-hairline text-fg-muted hover:bg-active-hover hover:text-fg"
    }`;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by department">
      <Link href={feedHref(tab, null)} prefetch={false} className={chip(active === null)} aria-current={active === null ? "true" : undefined}>
        All departments
      </Link>
      {options.map((d) => (
        <Link
          key={d.key}
          href={feedHref(tab, d.slug)}
          prefetch={false}
          className={chip(active === d.key)}
          aria-current={active === d.key ? "true" : undefined}
        >
          {d.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * Honest empty Needs-you: the approvals read ran and nothing is waiting on
 * this viewer. A FAILED read never renders this (the page says it failed).
 */
export function NeedsYouEmpty({ department = null }: { department?: string | null }) {
  return (
    <Card>
      <div className="py-6">
        <p className="text-sm font-medium text-fg">
          Nothing is waiting on you{department ? ` from ${department}` : ""}.
        </p>
        <p className="mt-1 max-w-prose text-[13px] leading-5 text-fg-muted">
          When a department drafts something that leaves the business (an email, a post), it waits here until you
          approve it or send it back with a note. Nothing goes out before someone says yes.
        </p>
      </div>
    </Card>
  );
}

export function FeedRows({
  rows,
  departmentLabels,
  emptyMessage,
  oasisWorkspace,
}: {
  rows: readonly FeedEventRow[];
  departmentLabels: Readonly<Partial<Record<DepartmentKey, string>>>;
  emptyMessage: string;
  /** The viewer stands in OASIS's own workspace: only there does a producer's own name print. */
  oasisWorkspace: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="py-6 text-sm text-fg-muted">{emptyMessage}</p>
      </Card>
    );
  }
  return (
    <Card noPadding>
      <ul className="divide-y divide-hairline">
        {rows.map((row) => {
          // The wire name (BRAVO_RECORD_STATUS_CHANGED) never reaches the
          // screen, not even as a tooltip: the label is the projected one,
          // every system name passes feed-model's naming rule, and the
          // summary is this viewer's (feedSummary).
          const ev = projectEvent({ ...row, payload: displayPayload(row.payload, oasisWorkspace) });
          const label = feedSystemName(ev.label) ?? "Activity";
          const summary = ev.summary !== "—" ? feedSummary(ev.summary, oasisWorkspace) : null;
          const dept = departmentForEvent(row);
          const who = dept ? departmentLabels[dept] ?? null : null;
          const when = ev.published_at || row.created_at;
          const sev = (row.severity || "").toLowerCase();
          return (
            <li key={row.id} className="flex items-start gap-3 px-4 py-2.5">
              <time
                className="w-14 shrink-0 pt-0.5 text-xs tabular-nums text-fg-dim"
                dateTime={when || undefined}
                title={when || undefined}
              >
                {timeAgo(when)}
              </time>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-fg">{label}</span>
                  <span className="text-xs text-fg-dim">{who ?? feedPublisherLabel(row.publisher_agent, oasisWorkspace)}</span>
                  {(sev === "error" || sev === "critical") && <Tag tone="hot">Failed</Tag>}
                  {(sev === "warn" || sev === "warning") && <Tag tone="warm">Warning</Tag>}
                </div>
                {summary && <p className="mt-0.5 truncate text-[13px] leading-5 text-fg-muted">{summary}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
