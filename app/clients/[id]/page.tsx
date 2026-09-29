/**
 * /clients/[id] — one client of the business (a `customers` record).
 *
 * Header: name, company, status, owner, contact details; "New ticket" for the
 * desk's team; the deal it came from. Tabs (?tab=):
 *   Overview   key facts, contacts, open items, and the editor (owners/admins).
 *   Tickets    the client's tickets on the workspace's own support desk.
 *   Projects   the client's projects on the workspace's own board.
 *   Files      documents on the source deal (lead_documents, served by
 *              /api/lead-documents/[id]/content under the lead's own access
 *              rule) and attachments on the client's tickets (served by
 *              /api/tickets/[id]/attachments/[index]).
 *   Activity   lead_interactions of the source deal.
 * Real data only; a tab with nothing says so, a tab that failed says that.
 * Tickets, Projects, Files and Activity are the desk team's (owners and
 * admins) — they hold every message and document of the client.
 *
 * GATE, first statement: requireOsRoute("/clients") — the same rule as the
 * list. A client of another workspace is a 404, the same as no client at all.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, Tag } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { KpiTile } from "@/components/os/KpiTile";
import { floorCount } from "@/lib/os/count";
import { Field, LoadError, SeverityTag, SlaBadge, StageTag, TicketStatusTag } from "@/components/delivery/badges";
import { TicketCreateForm } from "@/components/delivery/TicketForms";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import {
  CLIENT_TABS,
  loadClientRecord,
  loadWorkspaceDirectory,
  ownerName,
  ownerOptions,
  type ClientRecordData,
  type ClientTab,
  type Loaded,
} from "@/components/os/landings/clients-records-data";
import { AddContactForm, ClientEditor, RemoveContactButton } from "@/components/os/landings/clients-actions";
import { clientsViewerFromSurface, type ClientsViewer } from "@/lib/os/customers/session";
import { CUSTOMER_LIFECYCLE_LABELS } from "@/lib/os/customers/rules";
import { ACTIVE_PROJECT_STAGES, OPEN_TICKET_STATUSES, slaStatus } from "@/lib/delivery/rules";
import { mayOpenOsHref } from "@/lib/os/nav";
import { timeAgo } from "@/lib/fmt";
import { loadAssignmentRoster } from "@/lib/delivery/session";
import type { Ticket } from "@/lib/delivery/store";
import type { MemberRow } from "@/lib/team";

/** The desk's assignment roster for "New ticket"; null (form hidden) when it cannot load. */
async function deskRoster(viewer: ClientsViewer): Promise<MemberRow[] | null> {
  if (!viewer.desk) return null;
  try {
    return await loadAssignmentRoster(viewer.tenantId);
  } catch (err) {
    console.error("[os.clients.record.roster]", err);
    return null;
  }
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Client" };

const TAB_KEYS = new Set(CLIENT_TABS.map((t) => t.key));

export default async function ClientRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string }>;
}) {
  const viewer = await requireOsRoute("/clients");
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const tab: ClientTab = TAB_KEYS.has(sp.tab as ClientTab) ? (sp.tab as ClientTab) : "overview";
  const cv = clientsViewerFromSurface(viewer.surface)!;
  const [record, directory, roster] = await Promise.all([
    loadClientRecord(cv, id, tab),
    loadWorkspaceDirectory(cv.tenantId),
    deskRoster(cv),
  ]);

  if (record.state === "not_set_up") {
    return (
      <PageFrame title="Client">
        <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
          Client records are not set up in this database yet (migration bravo__188).
        </p>
      </PageFrame>
    );
  }
  if (record.state === "error") {
    return (
      <PageFrame title="Client">
        <LoadError what="this client" />
      </PageFrame>
    );
  }
  if (record.state !== "ok" || !record.value) notFound();
  const data = record.value;
  const c = data.customer;
  const canOpen = (href: string) => mayOpenOsHref(viewer.navInput, href);
  const owner = ownerName(c.owner_user_id, directory);
  const subtitle = [
    c.company_name && c.company_name !== c.display_name ? c.company_name : null,
    CUSTOMER_LIFECYCLE_LABELS[c.lifecycle],
    owner ? `Owner: ${owner}` : c.owner_user_id ? null : "No owner",
  ]
    .filter(Boolean)
    .join(" · ");
  // A deal in OASIS's pipeline opens at /pipeline/<id>; another workspace's
  // lead page lives in its own manifest, so the deal is named, not linked.
  const dealHref = c.source_lead_id && cv.oasis ? `/pipeline/${c.source_lead_id}` : null;

  return (
    <PageFrame
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {c.display_name}
          {c.archived_at && <Tag>Archived</Tag>}
        </span>
      }
      subtitle={subtitle}
      actions={
        <>
          <Link href="/clients" prefetch={false} className="btn-secondary">
            All clients
          </Link>
          {dealHref && canOpen("/pipeline") && (
            <Link href={dealHref} prefetch={false} className="btn-secondary">
              Open the deal
            </Link>
          )}
          {cv.desk && cv.desk.canAct && roster && (
            <TicketCreateForm
              roster={roster
                .filter((m) => m.auth_user_id)
                .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }))}
              projects={
                data.projects.state === "ok"
                  ? data.projects.value.rows.map((p) => ({ value: p.id, label: p.title, clientTenantId: p.client_tenant_id }))
                  : []
              }
              clientTenants={[]}
              customers={[{ value: c.id, label: c.display_name }]}
              initialCustomerId={c.id}
            />
          )}
        </>
      }
    >
      <div className="space-y-6">
        <nav aria-label="Client record" className="flex flex-wrap gap-1 border-b border-hairline">
          {CLIENT_TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Link
                key={t.key}
                href={t.key === "overview" ? `/clients/${c.id}` : `/clients/${c.id}?tab=${t.key}`}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${active ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>

        {tab === "overview" && <OverviewTab data={data} viewer={cv} owners={ownerOptions(directory)} dealHref={dealHref} />}
        {tab === "tickets" && <TicketsTab state={data.tickets} />}
        {tab === "projects" && <ProjectsTab state={data.projects} />}
        {tab === "files" && <FilesTab state={data.files} hasDeal={Boolean(c.source_lead_id)} />}
        {tab === "activity" && <ActivityTab state={data.activity} hasDeal={Boolean(c.source_lead_id)} />}
      </div>
    </PageFrame>
  );
}

function OwnersOnly({ what }: { what: string }) {
  return (
    <Card>
      <p className="py-4 text-[13px] text-fg-muted">
        {what} are for the workspace&rsquo;s owners and admins: they hold every message and document of the client.
      </p>
    </Card>
  );
}

function NotLoaded({ state, what }: { state: Loaded<unknown>["state"]; what: string }) {
  if (state === "not_allowed") return <OwnersOnly what={what} />;
  if (state === "not_set_up") {
    return (
      <p role="status" className="text-[13px] text-status-warm">
        {what} for client records need migration bravo__188, which is not applied to this database yet.
      </p>
    );
  }
  return <LoadError what={what.toLowerCase()} />;
}

function OverviewTab({
  data,
  viewer,
  owners,
  dealHref,
}: {
  data: ClientRecordData;
  viewer: ClientsViewer;
  owners: Array<{ value: string; label: string }>;
  dealHref: string | null;
}) {
  const c = data.customer;
  const now = new Date();
  const openTickets = data.tickets.state === "ok"
    ? data.tickets.value.rows.filter((t) => (OPEN_TICKET_STATUSES as readonly string[]).includes(t.status))
    : null;
  const breaching = openTickets ? openTickets.filter((t) => slaStatus(t, now).state === "breached").length : null;
  const activeProjects = data.projects.state === "ok"
    ? data.projects.value.rows.filter((p) => !p.archived_at && (ACTIVE_PROJECT_STAGES as readonly string[]).includes(p.stage)).length
    : null;
  // Counted from reads capped at 500 rows: a capped read's counts are floors
  // ("500+"), never exact-looking totals (lib/os/count.ts; Codex, PR #473).
  const ticketsCapped = data.tickets.state === "ok" && data.tickets.value.truncated;
  const projectsCapped = data.projects.state === "ok" && data.projects.value.truncated;
  const shown = (n: number | null, capped: boolean) => (n === null ? null : floorCount(n, capped));
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {viewer.desk && (
          <section className="grid grid-cols-3 gap-3">
            <KpiTile
              label="Open tickets"
              value={shown(openTickets?.length ?? null, ticketsCapped)}
              status={openTickets ? "live" : "error"}
              hint={ticketsCapped ? "at least: the first 500 tickets were read" : undefined}
            />
            <KpiTile
              label="Breaching"
              value={shown(breaching, ticketsCapped)}
              status={breaching === null ? "error" : "live"}
              hint={ticketsCapped ? "at least: the first 500 tickets were read" : "unanswered past target"}
            />
            <KpiTile
              label="Active projects"
              value={shown(activeProjects, projectsCapped)}
              status={activeProjects === null ? "error" : "live"}
              hint={projectsCapped ? "at least: the first 500 projects were read" : undefined}
            />
          </section>
        )}
        {openTickets && openTickets.length > 0 && (
          <Card title="Open items" noPadding>
            <TicketList tickets={openTickets} />
          </Card>
        )}
        <Card title="Contacts" subtitle="The people at this client, besides the main address.">
          {data.contacts.state !== "ok" ? (
            <NotLoaded state={data.contacts.state} what="Contacts" />
          ) : data.contacts.value.length === 0 ? (
            <p className="text-[13px] text-fg-muted">No other contacts yet.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {data.contacts.value.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-fg">
                      {p.name ?? p.email ?? p.phone}
                      {p.role && <span className="ml-2 text-xs text-fg-dim">{p.role}</span>}
                    </div>
                    <div className="text-xs text-fg-dim">{[p.email, p.phone].filter(Boolean).join(" · ")}</div>
                  </div>
                  {viewer.canWrite && <RemoveContactButton customerId={c.id} contactId={p.id} />}
                </li>
              ))}
            </ul>
          )}
          {viewer.canWrite && data.contacts.state === "ok" && (
            <div className="mt-3 border-t border-hairline pt-3">
              <AddContactForm customerId={c.id} />
            </div>
          )}
        </Card>
      </div>
      <div className="space-y-6">
        <Card title="Details">
          <div className="space-y-3">
            <Field label="Email">
              {c.primary_email ? <a className="text-accent hover:underline" href={`mailto:${c.primary_email}`}>{c.primary_email}</a> : "None"}
            </Field>
            <Field label="Phone">{c.primary_phone ?? "None"}</Field>
            {c.company_name && <Field label="Company">{c.company_name}</Field>}
            <Field label="Status">{CUSTOMER_LIFECYCLE_LABELS[c.lifecycle]}</Field>
            {c.tags.length > 0 && <Field label="Tags">{c.tags.join(", ")}</Field>}
            {c.stripe_customer_id && <Field label="Stripe customer"><span className="font-mono text-xs">{c.stripe_customer_id}</span></Field>}
            <Field label="Came from">
              {c.source_lead_id ? (
                dealHref ? (
                  <Link className="text-accent hover:underline" href={dealHref} prefetch={false}>A won deal in Pipeline</Link>
                ) : (
                  "A won deal in Pipeline"
                )
              ) : (
                "Added by hand"
              )}
            </Field>
            <Field label="Client since">{timeAgo(c.created_at)}</Field>
          </div>
        </Card>
        {viewer.canWrite && (
          <Card title="Edit">
            <ClientEditor
              client={{
                id: c.id,
                display_name: c.display_name,
                company_name: c.company_name,
                primary_email: c.primary_email,
                primary_phone: c.primary_phone,
                lifecycle: c.lifecycle,
                owner_user_id: c.owner_user_id,
                stripe_customer_id: c.stripe_customer_id,
                tags: c.tags,
                archived_at: c.archived_at,
              }}
              owners={owners}
            />
          </Card>
        )}
      </div>
    </div>
  );
}

function TicketList({ tickets }: { tickets: readonly Ticket[] }) {
  const now = new Date();
  return (
    <ul className="divide-y divide-hairline">
      {tickets.map((t) => (
        <li key={t.id}>
          <Link href={`/tickets/${t.id}`} prefetch={false} className="flex flex-col gap-1 px-4 py-3 hover:bg-active-hover sm:flex-row sm:items-center sm:gap-3">
            <span className="font-mono text-xs text-fg-muted">{t.ticket_number}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.title}</span>
            <SeverityTag severity={t.severity} />
            <TicketStatusTag status={t.status} />
            <span className="sm:w-36"><SlaBadge sla={slaStatus(t, now)} /></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TicketsTab({ state }: { state: ClientRecordData["tickets"] }) {
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Tickets" />;
  if (state.value.rows.length === 0) {
    return <Card><EmptyState message="No tickets from this client. Tickets from their email address, or linked on the ticket, appear here." /></Card>;
  }
  return (
    <>
      <Card noPadding>
        <TicketList tickets={state.value.rows} />
      </Card>
      {state.value.truncated && <p className="text-xs text-fg-dim">Showing the first 500 tickets.</p>}
    </>
  );
}

function ProjectsTab({ state }: { state: ClientRecordData["projects"] }) {
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Projects" />;
  if (state.value.rows.length === 0) {
    return <Card><EmptyState message="No projects for this client. A project from the deal this client came from, or linked on the project, appears here." /></Card>;
  }
  return (
    <Card noPadding>
      <ul className="divide-y divide-hairline">
        {state.value.rows.map((p) => (
          <li key={p.id}>
            <Link href={`/projects/${p.id}`} prefetch={false} className="flex flex-col gap-1 px-4 py-3 hover:bg-active-hover sm:flex-row sm:items-center sm:gap-3">
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{p.title}</span>
              {p.archived_at && <Tag>Archived</Tag>}
              <StageTag stage={p.stage} />
              <span className="text-xs text-fg-dim sm:w-40 sm:text-right">
                {p.task_count > 0 ? `${p.tasks_done}/${p.task_count} tasks` : "No tasks"} · {p.open_ticket_count} open
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {state.value.truncated && <p className="px-4 pb-3 text-xs text-fg-dim">Showing the first 500 projects.</p>}
    </Card>
  );
}

function kb(bytes: number | null): string {
  return bytes === null ? "" : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function FilesTab({ state, hasDeal }: { state: ClientRecordData["files"]; hasDeal: boolean }) {
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Files" />;
  const { leadFiles, ticketFiles, ticketsTruncated } = state.value;
  const cutOff = ticketsTruncated ? <p className="text-xs text-fg-dim">Only attachments on the first 500 tickets are listed.</p> : null;
  const none = (leadFiles ?? []).length === 0 && ticketFiles.length === 0;
  if (none) {
    return (
      <Card>
        <EmptyState
          message={
            hasDeal
              ? "No files yet. Documents on the deal this client came from, and attachments on their tickets, appear here."
              : "No files yet. Attachments on this client's tickets appear here."
          }
        />
        {cutOff}
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      {leadFiles && leadFiles.length > 0 && (
        <Card title="From the deal" noPadding>
          <ul className="divide-y divide-hairline">
            {leadFiles.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <a className="min-w-0 truncate text-sm text-accent hover:underline" href={`/api/lead-documents/${f.id}/content`} target="_blank" rel="noreferrer">
                  {f.filename}
                </a>
                <span className="text-xs text-fg-dim">{[f.doc_type, kb(f.size_bytes), timeAgo(f.uploaded_at)].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {ticketFiles.length > 0 && (
        <Card title="From tickets" noPadding>
          <ul className="divide-y divide-hairline">
            {ticketFiles.map((f) => (
              <li key={`${f.ticketId}-${f.index}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                {f.stored ? (
                  <a className="min-w-0 truncate text-sm text-accent hover:underline" href={`/api/tickets/${f.ticketId}/attachments/${f.index}`} target="_blank" rel="noreferrer">
                    {f.filename}
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-sm text-status-hot">{f.filename}: not stored</span>
                )}
                <span className="text-xs text-fg-dim">
                  <Link href={`/tickets/${f.ticketId}`} prefetch={false} className="font-mono hover:underline">{f.ticketNumber}</Link> · {kb(f.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {cutOff}
    </div>
  );
}

function ActivityTab({ state, hasDeal }: { state: ClientRecordData["activity"]; hasDeal: boolean }) {
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Activity" />;
  if (!hasDeal || state.value === null) {
    return <Card><EmptyState message="This client was added by hand, so there is no deal history to show." /></Card>;
  }
  if (state.value.length === 0) return <Card><EmptyState message="No calls, emails or messages recorded on the deal yet." /></Card>;
  return (
    <Card noPadding>
      <ol className="divide-y divide-hairline">
        {state.value.map((a) => (
          <li key={a.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-dim">
              <span className="font-medium text-fg-muted">{[a.channel ?? a.type, a.direction].filter(Boolean).join(" · ") || "Activity"}</span>
              <span title={a.created_at}>{timeAgo(a.created_at)}</span>
            </div>
            {a.subject && <div className="mt-1 text-sm text-fg">{a.subject}</div>}
            {a.preview && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-fg-muted">{a.preview}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
