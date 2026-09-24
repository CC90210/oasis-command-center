/**
 * /projects/[id] — one project.
 *
 * Founders: overview + controls, tasks, the full timeline (internal and
 * client-visible), linked tickets, client info. Clients: overview, the updates
 * shared with them, and their own tickets on it. A project outside the viewer's
 * scope is a 404 — the same answer as a project that does not exist.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, Tag } from "@/components/Card";
import {
  Field,
  LoadError,
  PriorityTag,
  SeverityTag,
  SlaBadge,
  StageTag,
  TicketStatusTag,
} from "@/components/delivery/badges";
import { ProjectControls, TaskList, UpdateComposer } from "@/components/delivery/ProjectForms";
import { timeAgo } from "@/lib/fmt";
import { memberDisplayName, slaStatus } from "@/lib/delivery/rules";
import { formatForFounders } from "@/lib/delivery/messages";
import { getDeliveryAccess, getDeliveryDb, loadAssignmentRoster, loadMemberDirectory } from "@/lib/delivery/session";
import {
  getProject,
  listClientTenants,
  listProjectTasks,
  listProjectUpdates,
  listTickets,
} from "@/lib/delivery/store";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getDeliveryAccess();
  if (!access.ok) {
    if (access.status === 403) notFound();
    return <Card><EmptyState message="Sign in to see this project." /></Card>;
  }
  const viewer = access.viewer;
  const db = getDeliveryDb();
  if (!db) return <LoadError what="this project" detail="The database is not configured on this deployment." />;

  let data: {
    project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
    tasks: Awaited<ReturnType<typeof listProjectTasks>>;
    updates: Awaited<ReturnType<typeof listProjectUpdates>>;
    tickets: Awaited<ReturnType<typeof listTickets>>["rows"];
  } | null = null;
  try {
    const project = await getProject(db, viewer, id);
    if (project) {
      const [tasks, updates, tickets] = await Promise.all([
        listProjectTasks(db, viewer, id),
        listProjectUpdates(db, viewer, id),
        listTickets(db, viewer, { project_id: id, status: "all" }),
      ]);
      data = { project, tasks, updates, tickets: tickets.rows };
    }
  } catch (err) {
    console.error("[projects.detail.page]", err);
    const detail = viewer.kind === "founder" ? (err instanceof Error ? err.message : String(err)) : undefined;
    return <LoadError what="this project" detail={detail} />;
  }
  if (!data) notFound();
  const { project, tasks, updates, tickets } = data;
  const now = new Date();

  const ticketList = (
    <Card title="Tickets" subtitle={viewer.kind === "client" ? "Your support requests on this project." : "Every ticket linked to this project."}>
      {tickets.length === 0 ? (
        <EmptyState message="No tickets on this project." />
      ) : (
        <ul className="divide-y divide-bg-border">
          {tickets.map((t) => (
            <li key={t.id} className="py-2.5">
              <Link href={`/tickets/${t.id}`} className="flex flex-wrap items-center gap-2 hover:text-accent">
                <span className="font-mono text-xs text-fg-muted">{t.ticket_number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                <SeverityTag severity={t.severity} />
                <TicketStatusTag status={t.status} />
                {viewer.kind === "founder" && <SlaBadge sla={slaStatus(t, now)} />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  if (viewer.kind === "client") {
    return (
      <div className="space-y-6 animate-fade-in">
        <Link href="/projects" className="text-xs text-fg-muted hover:text-fg">Back to your projects</Link>
        <PageHeader
          title={project.title}
          subtitle={<span className="inline-flex items-center gap-2"><StageTag stage={project.stage} />{project.due_date && <span>Target {project.due_date}</span>}</span>}
          action={<a className="btn-secondary" href={SUPPORT_FORM_PATH}>Report an issue</a>}
        />
        {project.description && <Card><p className="whitespace-pre-wrap text-sm text-fg-muted">{project.description}</p></Card>}
        <Card title="Updates">
          {updates.length === 0 ? (
            <EmptyState message="No updates shared yet." />
          ) : (
            <ol className="space-y-4">
              {updates.map((u) => (
                <li key={u.id} className="border-l-2 border-accent/40 pl-4">
                  <p className="whitespace-pre-wrap text-sm text-fg">{u.body}</p>
                  <p className="mt-1 text-xs text-fg-dim">{u.author_name} · {timeAgo(u.created_at)}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
        {ticketList}
      </div>
    );
  }

  let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
  let directory: Awaited<ReturnType<typeof loadMemberDirectory>> = [];
  let tenants: Awaited<ReturnType<typeof listClientTenants>> = [];
  let sideFailure: string | null = null;
  try {
    [roster, directory, tenants] = await Promise.all([loadAssignmentRoster(), loadMemberDirectory(), listClientTenants(db)]);
  } catch (err) {
    console.error("[projects.detail.page.roster]", err);
    sideFailure = err instanceof Error ? err.message : String(err);
  }
  const rosterOptions = roster
    .filter((m) => m.auth_user_id)
    .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }));
  const nameOf = (uid: string | null) => memberDisplayName(uid, directory);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link href="/projects" className="text-xs text-fg-muted hover:text-fg">Back to projects</Link>
      <PageHeader
        title={project.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StageTag stage={project.stage} />
            <PriorityTag priority={project.priority} />
            {project.archived_at && <Tag tone="warm">Archived</Tag>}
            <span>Updated {timeAgo(project.updated_at)}</span>
          </span>
        }
      />

      {sideFailure ? (
        <LoadError what="the team roster (editing is disabled until it loads)" detail={sideFailure} />
      ) : (
        <Card title="Manage">
          <ProjectControls
            project={project}
            roster={rosterOptions}
            clientTenants={tenants.map((t) => ({ value: t.id, label: t.name }))}
          />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Overview">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Assignee">{nameOf(project.assigned_to) ?? "Unassigned"}</Field>
              <Field label="Due">{project.due_date ?? "Not set"}</Field>
              <Field label="Started">{project.started_at ? formatForFounders(project.started_at) : "Not started"}</Field>
              <Field label="Launched">{project.launched_at ? formatForFounders(project.launched_at) : "Not live yet"}</Field>
            </div>
            {project.description && <p className="mt-4 whitespace-pre-wrap text-sm text-fg-muted">{project.description}</p>}
          </Card>

          <Card title="Tasks" subtitle={`${project.tasks_done} of ${project.task_count} done. Internal only.`}>
            {sideFailure ? (
              <ul className="space-y-1 text-sm">
                {tasks.map((t) => <li key={t.id}>{t.title} · {t.status}</li>)}
              </ul>
            ) : (
              <TaskList projectId={project.id} tasks={tasks} roster={rosterOptions} />
            )}
          </Card>

          <Card title="Timeline" subtitle="Internal updates stay here. Updates marked for the client appear in their portal.">
            <UpdateComposer projectId={project.id} />
            {updates.length > 0 && (
              <ol className="mt-5 space-y-4">
                {updates.map((u) => (
                  <li key={u.id} className={`border-l-2 pl-4 ${u.visibility === "client" ? "border-accent/60" : "border-bg-border"}`}>
                    <p className="whitespace-pre-wrap text-sm text-fg">{u.body}</p>
                    <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
                      {u.visibility === "client" ? <Tag tone="accent">Client</Tag> : <Tag>Internal</Tag>}
                      {u.author_name} · {timeAgo(u.created_at)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Client">
            <div className="space-y-3">
              <Field label="Portal workspace">{project.client_tenant_name ?? "None (email only)"}</Field>
              <Field label="Name">{project.client_name ?? "Not set"}</Field>
              <Field label="Email">
                {project.client_email ? <a className="text-accent hover:underline" href={`mailto:${project.client_email}`}>{project.client_email}</a> : "Not set"}
              </Field>
              <Field label="Pipeline lead">
                {project.lead_id ? <Link className="text-accent hover:underline" href={`/pipeline/${project.lead_id}`}>Open the deal</Link> : "Not linked"}
              </Field>
            </div>
          </Card>
          {ticketList}
        </div>
      </div>
    </div>
  );
}
