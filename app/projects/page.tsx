/**
 * /projects — delivery projects.
 *
 * Founders: the board, one column per stage, with filters (stage, assignee,
 * client/title search, archived) and a create form. Clients: their own
 * workspace's projects only, with the last update shared with them.
 *
 * Who sees what is decided once, in lib/delivery/access.ts. An OASIS
 * non-founder gets a 404 (the route does not confirm it exists), and a failed
 * read renders as an error, never as "no projects yet".
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, Stat } from "@/components/Card";
import { LoadError, PriorityTag, StageTag } from "@/components/delivery/badges";
import { ProjectCreateForm } from "@/components/delivery/ProjectForms";
import { timeAgo } from "@/lib/fmt";
import {
  ACTIVE_PROJECT_STAGES,
  PROJECT_STAGES,
  PROJECT_STAGE_LABELS,
  memberDisplayName,
  type ProjectStage,
} from "@/lib/delivery/rules";
import { getDeliveryAccess, getDeliveryDb, loadAssignmentRoster, loadMemberDirectory } from "@/lib/delivery/session";
import { listClientTenants, listProjects, type Project } from "@/lib/delivery/store";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

type Search = { stage?: string; assignee?: string; q?: string; archived?: string };

function ProjectCard({ p, assignee }: { p: Project; assignee: string | null }) {
  const progress = p.task_count > 0 ? Math.round((p.tasks_done / p.task_count) * 100) : null;
  const client = p.client_tenant_name || p.client_name || p.client_email;
  return (
    <Link
      href={`/projects/${p.id}`}
      className="block rounded-lg border border-bg-border bg-bg-elev p-3.5 transition-colors hover:border-accent/40"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug text-fg">{p.title}</h3>
        <PriorityTag priority={p.priority} />
      </div>
      <div className="mt-1 truncate text-xs text-fg-muted">{client || "No client set"}</div>
      {progress !== null && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[10px] text-fg-dim">
            <span>{p.tasks_done}/{p.task_count} tasks</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-bg">
            <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-dim">
        <span>{assignee ?? "Unassigned"}</span>
        {p.due_date && <span>Due {p.due_date}</span>}
        {p.open_ticket_count > 0 && (
          <span className="font-semibold text-status-warm">
            {p.open_ticket_count} open ticket{p.open_ticket_count === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto">{timeAgo(p.updated_at)}</span>
      </div>
    </Link>
  );
}

export default async function ProjectsPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const access = await getDeliveryAccess();
  if (!access.ok) {
    if (access.status === 403) notFound();
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Projects" />
        <Card><EmptyState message="Sign in to see your projects." /></Card>
      </div>
    );
  }
  const viewer = access.viewer;
  const sp = (await searchParams) ?? {};
  const db = getDeliveryDb();
  if (!db) return <LoadError what="projects" detail="The database is not configured on this deployment." />;

  // ── client view ─────────────────────────────────────────────────────────
  if (viewer.kind === "client") {
    let projects: Project[] = [];
    let failure: string | null = null;
    try {
      projects = (await listProjects(db, viewer)).rows;
    } catch (err) {
      console.error("[projects.page.client]", err);
      failure = err instanceof Error ? err.message : String(err);
    }
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title="Your projects"
          subtitle="Where each of your projects stands, and the latest update from the OASIS team."
          action={<a className="btn-secondary" href={SUPPORT_FORM_PATH}>Report an issue</a>}
        />
        {failure ? (
          <LoadError what="your projects" />
        ) : projects.length === 0 ? (
          <Card><EmptyState message="No projects are linked to your workspace yet." /></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="block rounded-xl border border-bg-border bg-bg-panel p-5 hover:border-accent/40">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-fg">{p.title}</h2>
                  <StageTag stage={p.stage} />
                </div>
                {p.last_client_update_body ? (
                  <p className="mt-3 line-clamp-3 text-sm text-fg-muted">
                    {p.last_client_update_body}
                    <span className="mt-1 block text-xs text-fg-dim">{timeAgo(p.last_client_update_at)}</span>
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-fg-dim">No updates shared yet.</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── founder view ────────────────────────────────────────────────────────
  const stageFilter = PROJECT_STAGES.includes(sp.stage as ProjectStage) ? (sp.stage as ProjectStage) : null;
  let result: Awaited<ReturnType<typeof listProjects>> | null = null;
  let failure: string | null = null;
  let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
  let directory: Awaited<ReturnType<typeof loadMemberDirectory>> = [];
  let tenants: Awaited<ReturnType<typeof listClientTenants>> = [];
  try {
    [result, roster, directory, tenants] = await Promise.all([
      listProjects(db, viewer, {
        stage: stageFilter,
        assignee: sp.assignee || null,
        q: sp.q || null,
        includeArchived: sp.archived === "1",
      }),
      loadAssignmentRoster(),
      loadMemberDirectory(),
      listClientTenants(db),
    ]);
  } catch (err) {
    console.error("[projects.page]", err);
    failure = err instanceof Error ? err.message : String(err);
  }
  const rosterOptions = roster
    .filter((m) => m.auth_user_id)
    .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }));
  const projects = result?.rows ?? [];
  const nameOf = (id: string | null) => memberDisplayName(id, directory);
  const columns = (stageFilter ? [stageFilter] : PROJECT_STAGES).map((stage) => ({
    stage,
    items: projects.filter((p) => p.stage === stage),
  }));
  const active = projects.filter((p) => ACTIVE_PROJECT_STAGES.includes(p.stage)).length;
  const openTickets = projects.reduce((n, p) => n + p.open_ticket_count, 0);
  const filtered = Boolean(stageFilter || sp.assignee || sp.q || sp.archived === "1");

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Projects"
        subtitle={
          failure ? "Delivery projects." : `${active} active project${active === 1 ? "" : "s"}${filtered ? " in this view" : ""}.`
        }
        action={<ProjectCreateForm roster={rosterOptions} clientTenants={tenants.map((t) => ({ value: t.id, label: t.name }))} />}
      />

      {failure ? (
        <LoadError what="projects" detail={failure} />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Active" value={active} accent />
            <Stat label="In client review" value={projects.filter((p) => p.stage === "review").length} />
            <Stat label="Live + maintenance" value={projects.filter((p) => p.stage === "live" || p.stage === "maintenance").length} />
            <Stat label="Open tickets" value={openTickets} hint={openTickets ? "across these projects" : undefined} />
          </section>

          <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-bg-border bg-bg-panel p-4">
            <label className="w-40">
              <span className="label">Stage</span>
              <select name="stage" className="select" defaultValue={stageFilter ?? ""}>
                <option value="">All stages</option>
                {PROJECT_STAGES.map((s) => (
                  <option key={s} value={s}>{PROJECT_STAGE_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label className="w-44">
              <span className="label">Assignee</span>
              <select name="assignee" className="select" defaultValue={sp.assignee ?? ""}>
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {rosterOptions.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[12rem] flex-1">
              <span className="label">Search</span>
              <input name="q" className="input" defaultValue={sp.q ?? ""} placeholder="Title, client or email" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-fg-muted">
              <input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === "1"} />
              Include archived
            </label>
            <button type="submit" className="btn-secondary">Apply</button>
            {filtered && <Link href="/projects" className="pb-2 text-sm text-fg-muted hover:text-fg">Clear</Link>}
          </form>

          {result?.truncated && (
            <p className="text-sm text-status-warm">Showing the first 500 projects. Narrow the filters to see the rest.</p>
          )}

          {projects.length === 0 ? (
            <Card>
              <EmptyState message={filtered ? "No projects match these filters." : "No projects yet. Create the first one above."} />
            </Card>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
              <div className="flex gap-4" style={{ minWidth: stageFilter ? undefined : `${columns.length * 260}px` }}>
                {columns.map(({ stage, items }) => (
                  <section key={stage} className="min-w-[240px] flex-1 space-y-3">
                    <header className="flex items-center gap-2">
                      <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-muted">{PROJECT_STAGE_LABELS[stage]}</h2>
                      <span className="rounded border border-bg-border bg-bg-elev px-1.5 py-0.5 text-[10px] text-fg-muted">{items.length}</span>
                    </header>
                    {items.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-bg-border p-3 text-center text-[11px] text-fg-dim">None</div>
                    ) : (
                      items.map((p) => <ProjectCard key={p.id} p={p} assignee={nameOf(p.assigned_to)} />)
                    )}
                  </section>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
