/**
 * /clients — Clients › All clients: the business's own customers.
 *
 * Until the `customers` table lands (plan D5), the list is assembled from what
 * OASIS already records (components/os/landings/clients-model.ts): deals won in
 * Pipeline, delivery projects and open support tickets. Nothing here is typed
 * in or sampled; an empty workspace shows how clients appear, not a demo row.
 *
 * GATE, first statement: requireOsRoute("/clients") — the rail's own rule
 * (capabilities.canSeeClientIdentities). Each source then applies its own
 * page's rule (clients-data.ts), so a column the viewer may not read renders as
 * an em dash, never as 0.
 */

import Link from "next/link";
import { Card } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import {
  CLIENTS_DELIVERY_LIMIT,
  CLIENTS_LEAD_LIMIT,
  loadClientSources,
  type SourceState,
} from "@/components/os/landings/clients-data";
import {
  buildClientRows,
  shownCount,
  type ClientFloors,
  type ClientRow,
} from "@/components/os/landings/clients-model";
import { mayOpenOsHref } from "@/lib/os/nav";
import { timeAgo } from "@/lib/fmt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

const rowsOf = <T,>(s: SourceState<T>): T[] | null => (s.state === "ok" ? s.rows : null);

export default async function ClientsPage() {
  const viewer = await requireOsRoute("/clients");
  const sources = await loadClientSources(viewer);
  const canOpen = (href: string) => mayOpenOsHref(viewer.navInput, href);
  const doors = [
    canOpen("/tickets") ? { href: "/tickets", label: "Support desk" } : null,
    canOpen("/projects") ? { href: "/projects", label: "Projects" } : null,
  ].filter((d): d is { href: string; label: string } => d !== null);
  const actions = doors.length ? (
    <>
      {doors.map((d) => (
        <Link key={d.href} href={d.href} prefetch={false} className="btn-secondary">
          {d.label}
        </Link>
      ))}
    </>
  ) : undefined;

  // A workspace that is not OASIS's own: no client records yet, and the delivery
  // rows it can read are OASIS's work for it, not its customers.
  if (sources.wonDeals.state === "not_applicable") {
    return (
      <PageFrame title="Clients" subtitle="The customers your business serves." actions={actions}>
        <HowClientsAppear
          lead="Client records are not switched on for this workspace yet."
          canOpenPipeline={canOpen("/pipeline")}
        />
      </PageFrame>
    );
  }

  if (sources.wonDeals.state === "not_allowed") {
    return (
      <PageFrame title="Clients" subtitle="The customers your business serves." actions={actions}>
        <Card>
          <div className="py-6">
            <p className="text-sm font-medium text-fg">Your role sees clients through your own deals.</p>
            <p className="mt-1 text-[13px] text-fg-muted">
              The full client list is the whole book, which owners and admins manage.{" "}
              {canOpen("/pipeline") && (
                <Link href="/pipeline" prefetch={false} className="text-accent hover:underline">
                  Open your pipeline
                </Link>
              )}
            </p>
          </div>
        </Card>
      </PageFrame>
    );
  }

  const leads = rowsOf(sources.wonDeals) ?? [];
  const projectsCapped = sources.projects.state === "ok" && sources.projects.truncated;
  const ticketsCapped = sources.tickets.state === "ok" && sources.tickets.truncated;
  const built = buildClientRows({
    leads,
    projects: rowsOf(sources.projects),
    tickets: rowsOf(sources.tickets),
    capped: {
      leads: sources.wonDeals.state === "ok" && sources.wonDeals.truncated,
      projects: projectsCapped,
      tickets: ticketsCapped,
    },
  });
  const { floors } = built;
  const openTickets = sumKnown(built.rows.map((r) => r.openTickets));
  const activeProjects = sumKnown(built.rows.map((r) => r.activeProjects));
  const subtitle = [
    counted(built.rows.length, floors.clients, "client"),
    openTickets === null ? null : counted(openTickets, floors.openTickets, "open ticket"),
    activeProjects === null ? null : counted(activeProjects, floors.activeProjects, "active project"),
  ]
    .filter(Boolean)
    .join(" · ");
  const cappedLists = [projectsCapped ? "projects" : null, ticketsCapped ? "open tickets" : null].filter(Boolean);
  const failed = [
    sources.wonDeals.state === "error" ? "won deals from Pipeline" : null,
    sources.projects.state === "error" ? "projects" : null,
    sources.tickets.state === "error" ? "tickets" : null,
  ].filter(Boolean);
  const deliveryHidden = sources.projects.state === "not_allowed";

  return (
    <PageFrame
      title="Clients"
      subtitle={failed.length === 0 ? subtitle : "The customers your business serves."}
      actions={actions}
    >
      <div className="space-y-4">
        {failed.length > 0 && (
          <p role="alert" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
            Couldn&rsquo;t load {failed.join(", ")}. The list below may be incomplete; the error has been logged.
          </p>
        )}

        {built.rows.length === 0 && failed.length === 0 ? (
          <HowClientsAppear lead="No clients yet." canOpenPipeline={canOpen("/pipeline")} />
        ) : built.rows.length > 0 ? (
          <ClientsTable rows={built.rows} deliveryHidden={deliveryHidden} floors={floors} />
        ) : null}

        {built.unlinkedTickets !== null && built.unlinkedTickets > 0 && (
          <p className="text-[13px] text-fg-muted">
            {shownCount(built.unlinkedTickets, floors.unlinkedTickets)} open ticket
            {built.unlinkedTickets === 1 && !floors.unlinkedTickets ? " is" : "s are"} not linked to a client yet.{" "}
            {canOpen("/tickets") && (
              <Link href="/tickets" prefetch={false} className="text-accent hover:underline">
                Review in Support desk
              </Link>
            )}
          </p>
        )}
        {sources.wonDeals.state === "ok" && sources.wonDeals.truncated && (
          <p className="text-xs text-fg-dim">Showing the {CLIENTS_LEAD_LIMIT} most recently updated won deals.</p>
        )}
        {cappedLists.length > 0 && (
          <p className="text-xs text-fg-dim">
            Only the first {CLIENTS_DELIVERY_LIMIT} {cappedLists.join(" and ")} were read, so counts marked + are
            minimums, not totals.
          </p>
        )}
      </div>
    </PageFrame>
  );
}

/** Sum of counts, or null when any is unknown — a partial sum would read as the total. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** "3 clients", "1 client", "500+ open tickets" — a floor is never singular. */
function counted(value: number, floor: boolean, noun: string): string {
  return `${shownCount(value, floor)} ${noun}${value === 1 && !floor ? "" : "s"}`;
}

function HowClientsAppear({ lead, canOpenPipeline }: { lead: string; canOpenPipeline: boolean }) {
  return (
    <Card>
      <div className="py-6">
        <p className="text-sm font-medium text-fg">{lead}</p>
        <p className="mt-1 max-w-prose text-[13px] leading-5 text-fg-muted">
          A deal becomes a client when it is won in Pipeline, and stays one through onboarding, build and launch. Each
          client shows its status, open support tickets, active projects and the last time you were in touch.
        </p>
        {canOpenPipeline && (
          <Link href="/pipeline" prefetch={false} className="mt-3 inline-block text-[13px] text-accent hover:underline">
            Go to Pipeline
          </Link>
        )}
      </div>
    </Card>
  );
}

function Count({ value, hidden, floor }: { value: number | null; hidden: boolean; floor: boolean }) {
  if (value === null) {
    return (
      <span className="text-fg-dim" title={hidden ? "Owners only" : "Couldn't load"} aria-label={hidden ? "Owners only" : "Couldn't load"}>
        —
      </span>
    );
  }
  return (
    <span
      className={value > 0 ? "text-fg" : "text-fg-muted"}
      title={floor ? `At least ${value}: the list stopped at its read limit` : undefined}
    >
      {shownCount(value, floor)}
    </span>
  );
}

function ClientsTable({
  rows,
  deliveryHidden,
  floors,
}: {
  rows: readonly ClientRow[];
  deliveryHidden: boolean;
  floors: ClientFloors;
}) {
  const th = "px-4 py-2 text-left text-xs font-medium text-fg-dim";
  const td = "px-4 py-2.5 align-middle";
  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-hairline">
              <th className={th}>Name</th>
              <th className={th}>Status</th>
              <th className={`${th} text-right`}>Open tickets</th>
              <th className={`${th} text-right`}>Active projects</th>
              <th className={`${th} text-right`}>Last touch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => (
              <tr key={r.key} className="transition-colors duration-150 hover:bg-active-hover">
                <td className={td}>
                  {r.href ? (
                    <Link href={r.href} prefetch={false} className="font-medium text-fg hover:underline">
                      {r.name}
                    </Link>
                  ) : (
                    <span className="font-medium text-fg">{r.name}</span>
                  )}
                  {r.contact && <div className="text-xs text-fg-dim">{r.contact}</div>}
                </td>
                <td className={`${td} text-fg-muted`}>{r.status}</td>
                <td className={`${td} text-right tabular-nums`}>
                  <Count value={r.openTickets} hidden={deliveryHidden} floor={floors.openTickets} />
                </td>
                <td className={`${td} text-right tabular-nums`}>
                  <Count value={r.activeProjects} hidden={deliveryHidden} floor={floors.activeProjects} />
                </td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums text-fg-muted`} title={r.lastTouch ?? undefined}>
                  {r.lastTouch ? timeAgo(r.lastTouch) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
