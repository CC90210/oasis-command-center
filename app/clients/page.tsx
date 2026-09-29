/**
 * /clients — Clients › All clients: the business's OWN customers
 * (docs/os-revamp/PLAN.md decision 5; the `customers` table, migration
 * bravo__188).
 *
 * THE LIST is the workspace's client records: status (lifecycle), owner, open
 * tickets and active projects on the workspace's own desk, last touch and
 * tags, with filters and "New client". Ticket and project counts are for the
 * desk's team (owners and admins); for anyone else they are unknown — an em
 * dash, never 0.
 *
 * NOT YET CLIENT RECORDS (OASIS only). Before client records existed, OASIS's
 * clients were assembled from what it already records (components/os/landings/
 * clients-model.ts): deals won in Pipeline, delivery projects and open support
 * tickets. Those are still shown, honestly labelled, until each is converted:
 * a won deal that already has a record links to it; the rest offer "Convert to
 * client" (owners and admins). Nothing here is typed in or sampled.
 *
 * GATE, first statement: requireOsRoute("/clients") — the rail's own rule
 * (capabilities.canSeeClientIdentities). Each source then applies its own rule
 * (clients-data.ts, clients-records-data.ts).
 */

import Link from "next/link";
import { Card } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { KpiTile } from "@/components/os/KpiTile";
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
import {
  loadConvertedLeads,
  loadCustomerRecords,
  loadWorkspaceDirectory,
  ownerName,
  ownerOptions,
} from "@/components/os/landings/clients-records-data";
import { ConvertToClientButton, NewClientButton } from "@/components/os/landings/clients-actions";
import { clientsViewerFromSurface } from "@/lib/os/customers/session";
import { CUSTOMER_LIFECYCLES, CUSTOMER_LIFECYCLE_LABELS, isOneOf } from "@/lib/os/customers/rules";
import type { CustomerListRow } from "@/lib/os/customers/store";
import { mayOpenOsHref } from "@/lib/os/nav";
import { timeAgo } from "@/lib/fmt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

type Search = { lifecycle?: string; q?: string; owner?: string; archived?: string };

const rowsOf = <T,>(s: SourceState<T>): T[] | null => (s.state === "ok" ? s.rows : null);

// Next's generated PageProps check rejects a defaulted (possibly-undefined)
// first argument, so the prop is required in the type; `props?.` keeps a bare
// ClientsPage() call (the landing tests) working at runtime.
export default async function ClientsPage(props: { searchParams?: Promise<Search> }) {
  const viewer = await requireOsRoute("/clients");
  const sp = ((await props?.searchParams) ?? {}) as Search;
  const cv = clientsViewerFromSurface(viewer.surface)!;
  const filters = {
    lifecycle: isOneOf(CUSTOMER_LIFECYCLES, sp.lifecycle) ? sp.lifecycle : null,
    q: sp.q?.trim() || null,
    owner: sp.owner?.trim() || null,
    includeArchived: sp.archived === "1",
  };
  const [records, sources, directory] = await Promise.all([
    loadCustomerRecords(cv, filters),
    loadClientSources(viewer),
    loadWorkspaceDirectory(cv.tenantId),
  ]);
  const canOpen = (href: string) => mayOpenOsHref(viewer.navInput, href);
  const owners = ownerOptions(directory);

  const actions = (
    <>
      {canOpen("/tickets") && (
        <Link href="/tickets" prefetch={false} className="btn-secondary">
          Support desk
        </Link>
      )}
      {cv.canWrite && records.state !== "not_set_up" && <NewClientButton owners={owners} defaultOwner={cv.userId} />}
    </>
  );

  // ── the records ──────────────────────────────────────────────────────────
  const rows = records.state === "ok" ? records.value.rows : [];
  const filtered = Boolean(filters.lifecycle || filters.q || filters.owner || filters.includeArchived);
  const byLifecycle = (l: string) => rows.filter((r) => r.lifecycle === l).length;
  const sumOrNull = (pick: (r: CustomerListRow) => number | null) =>
    rows.some((r) => pick(r) === null) ? null : rows.reduce((n, r) => n + (pick(r) ?? 0), 0);

  // ── the pipeline-derived clients (OASIS) ─────────────────────────────────
  const derivedApplies = sources.wonDeals.state !== "not_applicable";
  // A list at its read cap makes its counts floors ("500+"), never totals
  // (lib/os/count.ts; #469).
  const projectsCapped = sources.projects.state === "ok" && sources.projects.truncated;
  const ticketsCapped = sources.tickets.state === "ok" && sources.tickets.truncated;
  const built = derivedApplies && !filtered && sources.wonDeals.state !== "not_allowed"
    ? buildClientRows({
        leads: rowsOf(sources.wonDeals) ?? [],
        projects: rowsOf(sources.projects),
        tickets: rowsOf(sources.tickets),
        capped: {
          leads: sources.wonDeals.state === "ok" && sources.wonDeals.truncated,
          projects: projectsCapped,
          tickets: ticketsCapped,
        },
      })
    : null;
  const cappedLists = [projectsCapped ? "projects" : null, ticketsCapped ? "open tickets" : null].filter(Boolean);
  const leadIdOf = (key: string) => (key.startsWith("lead:") ? key.slice("lead:".length) : null);
  // A won deal already converted is a record above, archived or not; it is not
  // listed twice. Asked by lead id, so the list's filters and 500-row page do
  // not decide it. Null when client records cannot be read.
  const converted =
    built && records.state === "ok"
      ? await loadConvertedLeads(cv, built.rows.map((r) => leadIdOf(r.key)).filter((x): x is string => x !== null))
      : null;
  const convertedLeads = converted?.state === "ok" ? converted.value : null;
  const derivedRows = built
    ? built.rows.filter((row) => {
        const leadId = leadIdOf(row.key);
        return !(leadId && convertedLeads?.has(leadId));
      })
    : [];
  const derivedFailed = [
    sources.wonDeals.state === "error" ? "won deals from Pipeline" : null,
    sources.projects.state === "error" ? "projects" : null,
    sources.tickets.state === "error" ? "tickets" : null,
    converted?.state === "error" ? "which deals are already client records" : null,
  ].filter(Boolean);
  const deliveryHidden = sources.projects.state === "not_allowed";

  return (
    <PageFrame title="Clients" subtitle="The customers your business serves." actions={actions}>
      <div className="space-y-6">
        {records.state === "not_set_up" && (
          <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
            Client records are not set up in this database yet (migration bravo__188). Until they are, the clients below
            are assembled from Pipeline, projects and tickets.
          </p>
        )}
        {records.state === "error" && (
          <p role="alert" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
            Couldn&rsquo;t load your client records. The error has been logged.
          </p>
        )}

        {records.state === "ok" && (
          <>
            {!filtered && !records.value.truncated && (
              <section className={`grid grid-cols-2 gap-3 ${cv.desk ? "md:grid-cols-4" : "md:grid-cols-2"}`}>
                <KpiTile label="Active" value={byLifecycle("active")} status="live" />
                <KpiTile label="Onboarding" value={byLifecycle("onboarding")} status="live" />
                {/* Desk counts are the owners' and admins' to read; for anyone
                    else the tile is not drawn rather than shown as a 0. */}
                {cv.desk && (
                  <>
                    <KpiTile label="Open tickets" value={sumOrNull((r) => r.open_ticket_count)} status="live" hint="on your support desk" />
                    <KpiTile label="Active projects" value={sumOrNull((r) => r.active_project_count)} status="live" hint="discovery, building or review" />
                  </>
                )}
              </section>
            )}

            <nav aria-label="Client status" className="flex flex-wrap gap-1 border-b border-hairline">
              {[{ key: "", label: "All" }, ...CUSTOMER_LIFECYCLES.map((l) => ({ key: l, label: CUSTOMER_LIFECYCLE_LABELS[l] }))].map((t) => {
                const active = (filters.lifecycle ?? "") === t.key;
                const params = new URLSearchParams();
                if (t.key) params.set("lifecycle", t.key);
                if (filters.q) params.set("q", filters.q);
                if (filters.owner) params.set("owner", filters.owner);
                if (filters.includeArchived) params.set("archived", "1");
                return (
                  <Link
                    key={t.key || "all"}
                    href={`/clients${params.size ? `?${params.toString()}` : ""}`}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${active ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
                  >
                    {t.label}
                  </Link>
                );
              })}
            </nav>

            <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
              {filters.lifecycle && <input type="hidden" name="lifecycle" value={filters.lifecycle} />}
              <label className="min-w-[12rem] flex-1">
                <span className="label">Search</span>
                <input name="q" className="input" defaultValue={filters.q ?? ""} placeholder="Name, company, email or phone" />
              </label>
              <label className="w-48">
                <span className="label">Owner</span>
                <select name="owner" className="select" defaultValue={filters.owner ?? ""}>
                  <option value="">Anyone</option>
                  <option value="unassigned">No owner</option>
                  {owners.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 pb-2 text-[13px] text-fg-muted">
                <input type="checkbox" name="archived" value="1" defaultChecked={filters.includeArchived} />
                Include archived
              </label>
              <button type="submit" className="btn-secondary">Apply</button>
              {filtered && <Link href="/clients" prefetch={false} className="pb-2 text-sm text-fg-muted hover:text-fg">Clear</Link>}
            </form>

            {rows.length === 0 ? (
              <Card>
                <div className="py-6">
                  <p className="text-sm font-medium text-fg">{filtered ? "No clients match these filters." : "No client records yet."}</p>
                  {!filtered && (
                    <p className="mt-1 max-w-prose text-[13px] leading-5 text-fg-muted">
                      {cv.canWrite ? "Add a client you already serve with New client, or" : "A client record is made when an owner adds one or"}{" "}
                      convert a deal once it is won in Pipeline. Each client then carries its tickets, projects, files and
                      activity in one place.
                    </p>
                  )}
                </div>
              </Card>
            ) : (
              <CustomersTable rows={rows} directory={directory} deskKnown={cv.desk !== null} />
            )}
            {records.value.truncated && <p className="text-xs text-fg-dim">Showing the first 500 clients. Narrow the filters to see the rest.</p>}
          </>
        )}

        {derivedApplies && !filtered && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">Not yet client records</h2>
              <p className="mt-0.5 max-w-prose text-[13px] leading-5 text-fg-muted">
                Clients recorded before client records existed: deals won in Pipeline, delivery projects and open tickets.
                {cv.canWrite ? " Convert a won deal to give it a record." : ""}
              </p>
            </div>
            {sources.wonDeals.state === "not_allowed" ? (
              <Card>
                <div className="py-4">
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
            ) : (
              <>
                {derivedFailed.length > 0 && (
                  <p role="alert" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
                    Couldn&rsquo;t load {derivedFailed.join(", ")}. The list below may be incomplete; the error has been logged.
                  </p>
                )}
                {built && derivedRows.length > 0 ? (
                  <ClientsTable
                    rows={derivedRows}
                    deliveryHidden={deliveryHidden}
                    floors={built.floors}
                    convertedLeads={convertedLeads ? Object.fromEntries(convertedLeads) : null}
                    canConvert={cv.canWrite && convertedLeads !== null}
                  />
                ) : built && derivedFailed.length === 0 ? (
                  <Card>
                    <p className="py-4 text-[13px] text-fg-muted">Nothing left to convert: no won deals, projects or open tickets outside client records.</p>
                  </Card>
                ) : null}
                {built && built.unlinkedTickets !== null && built.unlinkedTickets > 0 && (
                  <p className="text-[13px] text-fg-muted">
                    {shownCount(built.unlinkedTickets, built.floors.unlinkedTickets)} open ticket
                    {built.unlinkedTickets === 1 && !built.floors.unlinkedTickets ? " is" : "s are"} not linked to a client yet.{" "}
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
                {built && cappedLists.length > 0 && (
                  <p className="text-xs text-fg-dim">
                    Only the first {CLIENTS_DELIVERY_LIMIT} {cappedLists.join(" and ")} were read, so counts marked + are
                    minimums, not totals.
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </PageFrame>
  );
}

function Count({ value, hidden, floor = false }: { value: number | null; hidden: boolean; floor?: boolean }) {
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

const th = "px-4 py-2 text-left text-xs font-medium text-fg-dim";
const td = "px-4 py-2.5 align-middle";

function latest(...isos: Array<string | null>): string | null {
  let best: string | null = null;
  for (const iso of isos) {
    if (iso && (!best || Date.parse(iso) > Date.parse(best))) best = iso;
  }
  return best;
}

/** The workspace's client records. */
function CustomersTable({
  rows,
  directory,
  deskKnown,
}: {
  rows: readonly CustomerListRow[];
  directory: Parameters<typeof ownerName>[1];
  deskKnown: boolean;
}) {
  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-hairline">
              <th className={th}>Name</th>
              <th className={th}>Status</th>
              <th className={th}>Owner</th>
              <th className={`${th} text-right`}>Open tickets</th>
              <th className={`${th} text-right`}>Active projects</th>
              <th className={`${th} text-right`}>Last touch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => {
              const touch = latest(r.updated_at, r.last_ticket_at);
              const sub = [r.company_name && r.company_name !== r.display_name ? r.company_name : null, r.primary_email]
                .filter(Boolean)
                .join(" · ");
              return (
                <tr key={r.id} className="transition-colors duration-150 hover:bg-active-hover">
                  <td className={td}>
                    <Link href={`/clients/${r.id}`} prefetch={false} className="font-medium text-fg hover:underline">
                      {r.display_name}
                    </Link>
                    {r.archived_at && <span className="ml-2 text-xs text-fg-dim">Archived</span>}
                    {sub && <div className="text-xs text-fg-dim">{sub}</div>}
                    {r.tags.length > 0 && <div className="mt-0.5 text-xs text-fg-dim">{r.tags.join(" · ")}</div>}
                  </td>
                  <td className={`${td} text-fg-muted`}>{CUSTOMER_LIFECYCLE_LABELS[r.lifecycle]}</td>
                  <td className={`${td} text-fg-muted`}>{ownerName(r.owner_user_id, directory) ?? (r.owner_user_id ? "—" : "No owner")}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    <Count value={r.open_ticket_count} hidden={!deskKnown} />
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    <Count value={r.active_project_count} hidden={!deskKnown} />
                  </td>
                  <td className={`${td} whitespace-nowrap text-right tabular-nums text-fg-muted`} title={touch ?? undefined}>
                    {touch ? timeAgo(touch) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** OASIS's pipeline-derived clients, until each is a record. */
function ClientsTable({
  rows,
  deliveryHidden,
  floors,
  convertedLeads,
  canConvert,
}: {
  rows: readonly ClientRow[];
  deliveryHidden: boolean;
  floors: ClientFloors;
  /** lead id → client record id; null when client records could not be read. */
  convertedLeads: Record<string, string> | null;
  canConvert: boolean;
}) {
  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-hairline">
              <th className={th}>Name</th>
              <th className={th}>Status</th>
              <th className={`${th} text-right`}>Open tickets</th>
              <th className={`${th} text-right`}>Active projects</th>
              <th className={`${th} text-right`}>Last touch</th>
              <th className={th}>Client record</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => {
              const leadId = r.key.startsWith("lead:") ? r.key.slice("lead:".length) : null;
              const recordId = leadId && convertedLeads ? convertedLeads[leadId] ?? null : null;
              return (
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
                  <td className={td}>
                    {recordId ? (
                      <Link href={`/clients/${recordId}`} prefetch={false} className="text-[13px] text-accent hover:underline">
                        Open record
                      </Link>
                    ) : leadId && canConvert ? (
                      <ConvertToClientButton leadId={leadId} />
                    ) : (
                      <span className="text-[13px] text-fg-dim">{convertedLeads === null ? "—" : "Not a record yet"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
