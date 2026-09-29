/**
 * OverviewPanel — the right-hand column of a department tab (design doc §(b)):
 * Needs you · Numbers · Routines · Connections · Suggested asks, in that order,
 * each a sentence-case heading over hairline-separated content.
 *
 * Server component. Everything it shows arrives already read and already
 * scoped; it makes no decisions about who may see what. Suggested asks is the
 * one client island (it fills the channel's composer).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { KpiTile, type KpiTileProps } from "@/components/os/KpiTile";
import { ApprovalCard } from "@/components/os/approvals/ApprovalCard";
import type { ApprovalsRead } from "@/components/os/approvals/load";
import type { ApprovalsBlock } from "@/lib/os/approvals/rules";
import { timeAgo } from "@/lib/fmt";
import type { SuggestedAsk } from "./config";
import type { AttentionItem } from "./numbers";
import { describeSchedule, lastRunLabel, routineTitle, type RoutineRow } from "./routine-rules";
import type { Read } from "./routines";
import { SuggestedAsks } from "./SuggestedAsks";

const CONNECTIONS_HREF = "/settings/connections";
const ROUTINES_SHOWN = 6;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-hairline px-4 py-4 first:border-t-0">
      <h2 className="mb-2.5 text-[13px] font-semibold leading-5 text-fg">{title}</h2>
      {children}
    </section>
  );
}

function NeedsYou({
  items,
  approvals,
  feedHref,
}: {
  items: readonly AttentionItem[];
  approvals: ApprovalsRead<ApprovalsBlock>;
  feedHref: string | null;
}) {
  const block = approvals.ok ? approvals.value : null;
  const more = block ? block.total - block.items.length : 0;
  const nothing = !!block && block.total === 0 && items.length === 0;
  return (
    <div className="space-y-2.5">
      {block && block.items.length > 0 && (
        <ul className="space-y-2.5" aria-label="Approvals waiting on you">
          {block.items.map((a) => (
            <li key={a.id}>
              <ApprovalCard approval={a} density="compact" />
            </li>
          ))}
        </ul>
      )}
      {more > 0 &&
        (feedHref ? (
          <Link href={feedHref} prefetch={false} className="inline-block text-[13px] font-medium text-accent hover:underline">
            All {block?.total} in Feed
          </Link>
        ) : (
          <p className="text-xs leading-4 text-fg-dim">{more} more waiting.</p>
        ))}
      {!approvals.ok && (
        // A failed read is not "nothing waiting": say which half is missing.
        <p className="text-[13px] leading-5 text-status-warm">Couldn’t load approvals. Reload in a minute.</p>
      )}
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-[13px] leading-5">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-unread" />
              {item.href ? (
                <Link href={item.href} prefetch={false} className="text-fg hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span className="text-fg">{item.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {nothing && (
        <p className="text-[13px] leading-5 text-fg-dim">
          Nothing is waiting on you. When this department drafts something that goes out, it waits here for your yes.
        </p>
      )}
    </div>
  );
}

function Routines({ routines }: { routines: Read<RoutineRow[]> }) {
  if (!routines.ok) {
    return <p className="text-[13px] leading-5 text-status-warm">Couldn’t load routines.</p>;
  }
  const rows = routines.value;
  if (rows.length === 0) {
    return <p className="text-[13px] leading-5 text-fg-dim">No routines for this department yet.</p>;
  }
  const shown = rows.slice(0, ROUTINES_SHOWN);
  return (
    <div>
      <ul className="divide-y divide-hairline">
        {shown.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 py-2 first:pt-0">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium leading-5 text-fg" title={r.description || undefined}>
                {routineTitle(r.name)}
              </div>
              <div className="text-xs leading-4 text-fg-dim">
                {describeSchedule(r.schedule)} · {lastRunLabel(r, timeAgo)}
              </div>
            </div>
            <span
              className={`mt-0.5 shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[11px] font-medium leading-4 ${
                r.enabled ? "text-fg" : "text-fg-dim"
              }`}
            >
              {r.enabled ? "On" : "Off"}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <p className="mt-2 text-xs leading-4 text-fg-dim">
          {rows.length - shown.length} more not shown
        </p>
      )}
    </div>
  );
}

function Connections({
  apps,
  canManage,
}: {
  apps: readonly string[];
  canManage: boolean;
}) {
  return (
    <div className="space-y-2.5">
      {apps.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {apps.map((app) => (
            <li key={app}>
              {canManage ? (
                <Link
                  href={CONNECTIONS_HREF}
                  prefetch={false}
                  className="inline-flex h-7 items-center rounded-md border border-hairline px-2 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-active-hover hover:text-fg"
                >
                  {app}
                </Link>
              ) : (
                <span className="inline-flex h-7 items-center rounded-md border border-hairline px-2 text-xs font-medium text-fg-muted">
                  {app}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] leading-5 text-fg-muted">This department watches every connection.</p>
      )}
      <p className="text-xs leading-4 text-fg-dim">
        {canManage ? (
          <>
            Live status checks are not measured yet.{" "}
            <Link href={CONNECTIONS_HREF} prefetch={false} className="text-accent hover:underline">
              Manage connections
            </Link>
          </>
        ) : (
          "Live status checks are not measured yet. An owner or admin manages connections."
        )}
      </p>
    </div>
  );
}

export type OverviewPanelProps = {
  attention: readonly AttentionItem[];
  /** This department's approvals waiting on the viewer (top few + total). */
  approvals: ApprovalsRead<ApprovalsBlock>;
  /** The Feed's Needs-you tab filtered to this department, when the viewer's rail has the Feed. */
  feedHref: string | null;
  tiles: readonly KpiTileProps[];
  routines: Read<RoutineRow[]>;
  connections: readonly string[];
  canManageConnections: boolean;
  asks: readonly SuggestedAsk[];
};

export function OverviewPanel({
  attention,
  approvals,
  feedHref,
  tiles,
  routines,
  connections,
  canManageConnections,
  asks,
}: OverviewPanelProps) {
  return (
    <aside aria-label="Overview" className="rounded-xl border border-hairline bg-bg-panel">
      <Section title="Needs you">
        <NeedsYou items={attention} approvals={approvals} feedHref={feedHref} />
      </Section>
      {tiles.length > 0 && (
        <Section title="Numbers">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {tiles.map((t) => (
              <KpiTile key={t.label} {...t} />
            ))}
          </div>
        </Section>
      )}
      <Section title="Routines">
        <Routines routines={routines} />
      </Section>
      <Section title="Connections">
        <Connections apps={connections} canManage={canManageConnections} />
      </Section>
      {asks.length > 0 && (
        <Section title="Suggested asks">
          <SuggestedAsks asks={asks} />
        </Section>
      )}
    </aside>
  );
}
