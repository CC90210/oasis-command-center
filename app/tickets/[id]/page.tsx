/**
 * /tickets/[id] — one ticket.
 *
 * Founders: the SLA clock, triage controls, client details (including how the
 * client link was made and whether it was inferred from an unverified email),
 * notification outcomes, attachments, and the full thread with internal notes
 * set apart. Clients: their own ticket's public thread and a reply box. Out of
 * scope is a 404, the same as a ticket that does not exist.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, Tag } from "@/components/Card";
import {
  CategoryTag,
  Field,
  LoadError,
  SeverityTag,
  SlaBadge,
  TicketStatusTag,
} from "@/components/delivery/badges";
import { TicketComposer, TicketControls } from "@/components/delivery/TicketForms";
import { timeAgo } from "@/lib/fmt";
import { formatForFounders } from "@/lib/delivery/messages";
import { memberDisplayName, slaStatus } from "@/lib/delivery/rules";
import { getDeliveryAccess, getDeliveryDb, loadAssignmentRoster, loadMemberDirectory } from "@/lib/delivery/session";
import {
  getTicket,
  listClientTenants,
  listProjects,
  listTicketComments,
  type Ticket,
  type TicketComment,
} from "@/lib/delivery/store";

export const dynamic = "force-dynamic";

const MATCH_LABEL: Record<string, string> = {
  session: "Filed from their signed-in portal",
  email_project: "Matched to a project by their email (unverified)",
  email_tenant: "Matched to a portal workspace by their email (unverified)",
  manual: "Linked by the team",
  none: "Not matched to a client",
  lookup_failed: "Client lookup FAILED at intake — link it by hand",
};

function Thread({ comments, founder }: { comments: TicketComment[]; founder: boolean }) {
  if (comments.length === 0) return <EmptyState message="No replies yet." />;
  return (
    <ol className="space-y-3">
      {comments.map((c) => {
        const system = c.author_type === "system";
        const internal = c.is_internal && !system;
        return (
          <li
            key={c.id}
            className={
              system
                ? "px-1 text-xs text-fg-dim"
                : `rounded-lg border p-3.5 ${
                    internal
                      ? "border-status-warm/30 bg-status-warm/5"
                      : c.author_type === "client"
                        ? "border-bg-border bg-bg-elev"
                        : "border-accent/30 bg-accent-soft"
                  }`
            }
          >
            {system ? (
              <span>{c.body} · {c.author_name} · {timeAgo(c.created_at)}</span>
            ) : (
              <>
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  <span className="font-semibold text-fg">{c.author_name}</span>
                  {c.author_type === "client" ? <Tag>Client</Tag> : internal ? <Tag tone="warm">Internal note</Tag> : <Tag tone="accent">Reply</Tag>}
                  <span>{timeAgo(c.created_at)}</span>
                  {founder && !internal && c.author_type === "team" && c.email_status && (
                    <span className={c.email_status.includes("FAILED") || c.email_status.includes("not sent") ? "text-status-hot" : "text-fg-dim"}>
                      {c.email_status}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm text-fg">{c.body}</p>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getDeliveryAccess();
  if (!access.ok) {
    if (access.status === 403) notFound();
    return <Card><EmptyState message="Sign in to see this ticket." /></Card>;
  }
  const viewer = access.viewer;
  const db = getDeliveryDb();
  if (!db) return <LoadError what="this ticket" detail="The database is not configured on this deployment." />;

  let ticket: Ticket | null = null;
  let comments: TicketComment[] = [];
  try {
    ticket = await getTicket(db, viewer, id);
    if (ticket) comments = await listTicketComments(db, viewer, id);
  } catch (err) {
    console.error("[tickets.detail.page]", err);
    return <LoadError what="this ticket" detail={err instanceof Error ? err.message : String(err)} />;
  }
  if (!ticket) notFound();
  const now = new Date();
  const closed = ticket.status === "closed";

  if (viewer.kind === "client") {
    return (
      <div className="space-y-6 animate-fade-in">
        <Link href="/tickets" className="text-xs text-fg-muted hover:text-fg">Back to your tickets</Link>
        <PageHeader
          title={ticket.title}
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-mono">{ticket.ticket_number}</span>
              <TicketStatusTag status={ticket.status} />
              <span>Opened {timeAgo(ticket.created_at)}</span>
            </span>
          }
        />
        {ticket.description && (
          <Card title="Your request"><p className="whitespace-pre-wrap text-sm text-fg">{ticket.description}</p></Card>
        )}
        {ticket.resolution && (
          <Card title="Resolution"><p className="whitespace-pre-wrap text-sm text-fg">{ticket.resolution}</p></Card>
        )}
        <Card title="Conversation">
          <Thread comments={comments} founder={false} />
          <div className="mt-5 border-t border-bg-border pt-5">
            <TicketComposer ticketId={ticket.id} mode="client" closed={closed} />
          </div>
        </Card>
      </div>
    );
  }

  let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
  let directory: Awaited<ReturnType<typeof loadMemberDirectory>> = [];
  let projects: Awaited<ReturnType<typeof listProjects>>["rows"] = [];
  let tenants: Awaited<ReturnType<typeof listClientTenants>> = [];
  let sideFailure: string | null = null;
  try {
    const [ro, dir, pr, te] = await Promise.all([
      loadAssignmentRoster(),
      loadMemberDirectory(),
      listProjects(db, viewer, { includeArchived: false }),
      listClientTenants(db),
    ]);
    roster = ro;
    directory = dir;
    projects = pr.rows;
    tenants = te;
  } catch (err) {
    console.error("[tickets.detail.page.side]", err);
    sideFailure = err instanceof Error ? err.message : String(err);
  }
  const rosterOptions = roster
    .filter((m) => m.auth_user_id)
    .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }));
  // A linked project that is archived is not in the option list; keep it selectable.
  const projectOptions = projects.map((p) => ({ value: p.id, label: p.title, clientTenantId: p.client_tenant_id }));
  if (ticket.project_id && !projectOptions.some((p) => p.value === ticket.project_id)) {
    projectOptions.unshift({ value: ticket.project_id, label: ticket.project_title ?? "Linked project", clientTenantId: ticket.client_tenant_id });
  }
  const sla = slaStatus(ticket, now);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link href="/tickets" className="text-xs text-fg-muted hover:text-fg">Back to tickets</Link>
      <PageHeader
        title={ticket.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono">{ticket.ticket_number}</span>
            <SeverityTag severity={ticket.severity} />
            <TicketStatusTag status={ticket.status} />
            <CategoryTag category={ticket.category} />
            <span>via {ticket.source}</span>
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {ticket.description && (
            <Card title="Request"><p className="whitespace-pre-wrap text-sm text-fg">{ticket.description}</p></Card>
          )}
          {ticket.attachments.length > 0 && (
            <Card title="Attachments">
              <ul className="space-y-2 text-sm">
                {ticket.attachments.map((a, i) => (
                  <li key={`${a.filename}-${i}`}>
                    {a.storage_path ? (
                      <a className="text-accent hover:underline" href={`/api/tickets/${ticket.id}/attachments/${i}`} target="_blank" rel="noreferrer">
                        {a.filename}
                      </a>
                    ) : (
                      <span className="text-status-hot">{a.filename}: not stored ({a.error ?? "unknown error"})</span>
                    )}
                    <span className="ml-2 text-xs text-fg-dim">{Math.max(1, Math.round(a.size_bytes / 1024))} KB</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Thread" subtitle="Replies are emailed to the client. Internal notes never leave this page.">
            <Thread comments={comments} founder />
            <div className="mt-5 border-t border-bg-border pt-5">
              <TicketComposer ticketId={ticket.id} mode="founder" closed={closed} />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="First response">
            <div className="space-y-3">
              <SlaBadge sla={sla} />
              <Field label="Due">{formatForFounders(ticket.sla_target)}</Field>
              <Field label="Answered">{ticket.first_response_at ? formatForFounders(ticket.first_response_at) : "Not yet"}</Field>
              {ticket.sla_breached_at && (
                <Field label="Breach alert">{ticket.sla_breach_alert_status ?? (ticket.sla_breach_alert_at ? "Claimed, no outcome recorded" : "Pending the next SLA check")}</Field>
              )}
            </div>
          </Card>
          {sideFailure ? (
            <LoadError what="the team roster (triage is disabled until it loads)" detail={sideFailure} />
          ) : (
            <Card title="Triage">
              <TicketControls
                ticket={ticket}
                roster={rosterOptions}
                projects={projectOptions}
                clientTenants={tenants.map((t) => ({ value: t.id, label: t.name }))}
              />
            </Card>
          )}
          <Card title="Client">
            <div className="space-y-3">
              <Field label="Name">{ticket.client_name ?? "Unknown"}</Field>
              <Field label="Email">
                {ticket.client_email ? <a className="text-accent hover:underline" href={`mailto:${ticket.client_email}`}>{ticket.client_email}</a> : "None"}
              </Field>
              {ticket.client_company && <Field label="Company">{ticket.client_company}</Field>}
              <Field label="Portal workspace">{ticket.client_tenant_name ?? "None"}</Field>
              <Field label="Project">
                {ticket.project_id ? <Link className="text-accent hover:underline" href={`/projects/${ticket.project_id}`}>{ticket.project_title ?? "Open project"}</Link> : "Not linked"}
              </Field>
              {ticket.project_hint && !ticket.project_id && <Field label="They said the project is">{ticket.project_hint}</Field>}
              <Field label="How it was linked">{MATCH_LABEL[ticket.client_match ?? "none"] ?? ticket.client_match}</Field>
              <Field label="Assignee">{memberDisplayName(ticket.assigned_to, directory) ?? "Unassigned"}</Field>
            </div>
          </Card>
          {(ticket.source === "form" || ticket.source === "portal") && (
            <Card title="Notifications">
              <div className="space-y-3">
                <Field label="Founders">{ticket.founder_alert_status ?? (ticket.founder_alert_at ? "Claimed, no outcome recorded" : "Not sent yet")}</Field>
                <Field label="Client confirmation">{ticket.client_ack_status ?? (ticket.client_ack_at ? "Claimed, no outcome recorded" : "Not sent yet")}</Field>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
