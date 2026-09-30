/**
 * /clients/[id] — one client of the business (a `customers` record): the hub
 * OASIS runs a client from.
 *
 * Header: name, health badge, company, status, owner; "New ticket" for the
 * desk's team; "Mark engagement ended" for owners and admins; the deal it
 * came from. Tabs (?tab=):
 *   Overview       key facts, last touch, contacts, open items, the editor.
 *   Conversations  email, SMS and Slack in one thread, the agents' drafts
 *                  awaiting approval, and a composer that asks before it sends
 *                  (lib/os/customers/conversations.ts).
 *   Tickets        the client's tickets on the workspace's own support desk.
 *   Projects       the client's projects on the workspace's own board.
 *   Money          OASIS's books for this client (OASIS only, founders who
 *                  may open Money): collected, MRR, renewal, overdue, invoices.
 *   Usage          the client's own workspace, once the operator links it.
 *   Activity       ledger facts, and the source deal's interactions labelled
 *                  "inferred from the deal".
 *   Health         the signals behind the badge, and what could not be read.
 *   Files          documents on the source deal and attachments on tickets.
 * Real data only; a tab with nothing says so, a tab that failed says that.
 * Every tab but Overview and Money is the desk team's (owners and admins):
 * they hold every message, document and datum of the client.
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
import { AddContactForm, ClientEditor, EndEngagementButton, RemoveContactButton } from "@/components/os/landings/clients-actions";
import { ClientConversations } from "@/components/os/landings/client-conversations";
import { ClientHealthBadge, ClientHealthBreakdown } from "@/components/os/landings/client-health-badge";
import { ClientMoneyPanel } from "@/components/os/landings/client-money";
import { ClientUsagePanel } from "@/components/os/landings/client-usage";
import { clientsViewerFromSurface, type ClientsViewer } from "@/lib/os/customers/session";
import { CUSTOMER_LIFECYCLE_LABELS } from "@/lib/os/customers/rules";
import { ACTIVE_PROJECT_STAGES, DELIVERY_TENANT_ID, OPEN_TICKET_STATUSES, slaStatus } from "@/lib/delivery/rules";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { mayOpenOsHref } from "@/lib/os/nav";
import { timeAgo } from "@/lib/fmt";
import { loadAssignmentRoster } from "@/lib/delivery/session";
import type { Ticket } from "@/lib/delivery/store";
import type { MemberRow } from "@/lib/team";

/**
 * The desk's assignment roster for "New ticket". A failure does not hide the
 * form: it renders with no assignee choices and a notice says why (OASIS's
 * roster needs both founders active, lib/team.ts).
 */
async function deskRoster(viewer: ClientsViewer): Promise<{ rows: MemberRow[]; notice: string | null } | null> {
  if (!viewer.desk) return null;
  try {
    return { rows: await loadAssignmentRoster(viewer.tenantId), notice: null };
  } catch (err) {
    console.error("[os.clients.record.roster]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rows: [],
      notice: msg.includes("oasis_pipeline_assignment_roster_incomplete")
        ? "New tickets can't be assigned from here right now: the assignment roster needs both founders as active members."
        : "The assignee list couldn't be loaded, so new tickets start unassigned. The error has been logged.",
    };
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
    loadClientRecord(cv, id, tab, { isOperator: viewer.navInput.isOperator }),
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
          {cv.desk && <ClientHealthBadge health={data.health} />}
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
          {cv.desk && tab !== "conversations" && (
            <Link href={`/clients/${c.id}?tab=conversations`} prefetch={false} className="btn-secondary">
              Write to client
            </Link>
          )}
          {cv.canWrite && c.lifecycle !== "churned" && <EndEngagementButton customerId={c.id} clientName={c.display_name} />}
          {cv.desk && cv.desk.canAct && roster && (
            <TicketCreateForm
              roster={roster.rows
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
        {roster?.notice && (
          <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
            {roster.notice}
          </p>
        )}
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
        {tab === "conversations" && <ConversationsTab data={data} viewer={cv} />}
        {tab === "tickets" && <TicketsTab state={data.tickets} />}
        {tab === "projects" && <ProjectsTab state={data.projects} />}
        {tab === "money" && <MoneyTab state={data.money} canOpenMoney={canOpen("/money")} />}
        {tab === "usage" && <UsageTab state={data.usage} customerId={c.id} linkable={data.linkableWorkspaces} />}
        {tab === "files" && <FilesTab state={data.files} hasDeal={Boolean(c.source_lead_id)} />}
        {tab === "activity" && <ActivityTab state={data.activity} hasDeal={Boolean(c.source_lead_id)} />}
        {tab === "health" &&
          (cv.desk ? (
            <Card>
              <ClientHealthBreakdown health={data.health} moneyTracked={data.moneyAccess !== "not_tracked"} />
            </Card>
          ) : (
            <OwnersOnly what="Health signals" />
          ))}
      </div>
    </PageFrame>
  );
}

function ConversationsTab({ data, viewer }: { data: ClientRecordData; viewer: ClientsViewer }) {
  const state = data.conversation;
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Conversations" />;
  const oasis = viewer.tenantId === DELIVERY_TENANT_ID;
  // The same fail-closed identity the send route checks first
  // (lib/os/customers/conversations.ts resolveClientMailbox): a workspace
  // without one cannot send, whatever mailbox it connects, and is told so
  // BEFORE anyone writes a message.
  const identity = oasis || brandForTenant({ tenantId: viewer.tenantId, tenantSlug: viewer.tenantSlug }) !== null;
  return (
    <ClientConversations
      customerId={data.customer.id}
      clientName={data.customer.display_name}
      messages={state.value.messages}
      drafts={state.value.drafts}
      truncated={state.value.truncated}
      recipients={state.value.addresses.recipients}
      mailboxNote={
        oasis
          ? "Sends from the OASIS mailbox, with you in copy. It is recorded in this conversation."
          : "Sends from your own mailbox connected in this workspace (never from OASIS's). It is recorded in this conversation."
      }
      sendBlocked={
        identity
          ? null
          : "Email can't be sent from this workspace yet: it has no registered business identity to send client email as. OASIS has to set that up; connecting a mailbox alone does not. The conversation above still collects every message."
      }
      canSend={Boolean(viewer.desk?.canAct)}
    />
  );
}

function MoneyTab({ state, canOpenMoney }: { state: ClientRecordData["money"]; canOpenMoney: boolean }) {
  if (state.state === "not_tracked") {
    return (
      <Card>
        <EmptyState message="This workspace's payments and invoices are not kept in the app yet, so there is no money to show for its clients." />
      </Card>
    );
  }
  if (state.state === "not_allowed") {
    return (
      <Card>
        <p className="py-4 text-[13px] text-fg-muted">A client&rsquo;s money is for the founders who can open Money.</p>
      </Card>
    );
  }
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Money" />;
  return <ClientMoneyPanel money={state.value} canOpenMoney={canOpenMoney} />;
}

function UsageTab({
  state,
  customerId,
  linkable,
}: {
  state: ClientRecordData["usage"];
  customerId: string;
  linkable: ClientRecordData["linkableWorkspaces"];
}) {
  if (state.state === "not_applicable") {
    return (
      <Card>
        <EmptyState message="Usage is how OASIS sees its clients' own workspaces, so it is shown on OASIS's client records only." />
      </Card>
    );
  }
  if (state.state !== "ok") return <NotLoaded state={state.state} what="Usage" />;
  return (
    <div className="space-y-4">
      {linkable && linkable.state !== "ok" && (
        <p role="alert" className="text-[13px] text-status-warm">
          Couldn&rsquo;t load the list of workspaces, so the link can&rsquo;t be changed right now. The error has been logged.
        </p>
      )}
      <ClientUsagePanel customerId={customerId} usage={state.value} linkable={linkable && linkable.state === "ok" ? linkable.value : null} />
    </div>
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
              {c.primary_email ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="text-fg">{c.primary_email}</span>
                  {viewer.desk && (
                    <Link className="text-accent hover:underline" href={`/clients/${c.id}?tab=conversations`} prefetch={false}>
                      Write from here
                    </Link>
                  )}
                </span>
              ) : (
                "None"
              )}
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
            <Field label="Last touch">
              {data.lastTouch.state === "ok"
                ? data.lastTouch.value
                  ? <span title={data.lastTouch.value}>{timeAgo(data.lastTouch.value)}</span>
                  : "No contact recorded yet"
                : data.lastTouch.state === "not_allowed"
                  ? "Owners and admins only"
                  : "Couldn't load"}
            </Field>
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
  if (state.value.entries.length === 0) {
    return (
      <Card>
        <EmptyState
          message={
            hasDeal
              ? "Nothing recorded for this client yet. Tickets, payments, status changes and the deal's calls and emails appear here."
              : "Nothing recorded for this client yet. Tickets, payments and status changes appear here as they happen."
          }
        />
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <Card noPadding>
        <ol className="divide-y divide-hairline">
          {state.value.entries.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-dim">
                <span className="font-medium text-fg-muted">{a.label}</span>
                <span title={a.at}>{timeAgo(a.at)}</span>
                {a.basis === "inferred" && (
                  <span className="rounded border border-hairline px-1 py-px text-[10px] text-fg-dim">inferred from the deal</span>
                )}
                {a.href && (
                  <Link href={a.href} prefetch={false} className="text-accent hover:underline">
                    Open
                  </Link>
                )}
              </div>
              {a.detail && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-fg-muted">{a.detail}</p>}
            </li>
          ))}
        </ol>
      </Card>
      {state.value.truncated && <p className="text-xs text-fg-dim">Showing the latest 200 of each kind of activity.</p>}
    </div>
  );
}
