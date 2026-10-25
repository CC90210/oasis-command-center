/**
 * /projects — active client delivery across the viewer's own workspace.
 *
 * Every workspace runs its own desk (lib/delivery/access.ts, relation "desk"),
 * and this page resolves it first, exactly as /tickets does (Codex, PR #473:
 * a client workspace's owner used to land on OASIS's vendor view here and
 * could neither list their own projects).
 *   - Owners/admins: active-stage projects anchored to an active/onboarding
 *     client record. New projects start from that client's record, never from
 *     this aggregate board.
 *   - Anyone in another workspace ALSO sees "Projects OASIS runs for you":
 *     OASIS's projects about their workspace (relation "vendor"), with the
 *     last update shared with them — the only view for members below
 *     owner/admin.
 *
 * An OASIS non-founder gets a 404 (the route does not confirm it exists), and
 * a failed read renders as an error, never as "no projects yet".
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, Stat } from "@/components/Card";
import { LoadError, PriorityTag, StageTag } from "@/components/delivery/badges";
import { timeAgo } from "@/lib/fmt";
import {
  ACTIVE_PROJECT_STAGES,
  PROJECT_STAGE_LABELS,
  memberDisplayName,
  type ProjectStage,
} from "@/lib/delivery/rules";
import { getDeliveryAccessChain, getDeliveryDb, loadAssignmentRoster, loadMemberDirectory } from "@/lib/delivery/session";
import { listProjects, type Project } from "@/lib/delivery/store";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

type Search = { stage?: string; assignee?: string; q?: string };

function ProjectCard({ p, assignee }: { p: Project; assignee: string | null }) {
  const progress = p.task_count > 0 ? Math.round((p.tasks_done / p.task_count) * 100) : null;
  const client = p.customer_record_name;
  return (
    <Link
      href={`/projects/${p.id}`}
      className="block rounded-lg border border-bg-border bg-bg-elev p-3.5 transition-colors hover:border-accent/40"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug text-fg">{p.title}</h3>
        <PriorityTag priority={p.priority} />
      </div>
      <div className="mt-1 truncate text-xs text-fg-muted">{client}</div>
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

/** OASIS's projects about the viewer's workspace (vendor), read before render. */
type VendorProjects = { ok: true; projects: Project[] } | { ok: false };

async function loadVendorProjects(db: NonNullable<ReturnType<typeof getDeliveryDb>>, viewer: Parameters<typeof listProjects>[1]): Promise<VendorProjects> {
  try {
    return { ok: true, projects: (await listProjects(db, viewer)).rows };
  } catch (err) {
    console.error("[projects.page.vendor]", err);
    return { ok: false };
  }
}

function VendorProjectList({ data }: { data: VendorProjects }) {
  if (!data.ok) return <LoadError what="your projects" />;
  if (data.projects.length === 0) return <Card><EmptyState message="No projects are linked to your workspace yet." /></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data.projects.map((p) => (
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
  );
}

export default async function ProjectsPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const { desk, vendor } = await getDeliveryAccessChain();
  if (!desk.ok && !vendor?.ok) {
    if (desk.status === 403) notFound();
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Projects" />
        <Card><EmptyState message="Sign in to see your projects." /></Card>
      </div>
    );
  }
  const sp = (await searchParams) ?? {};
  const db = getDeliveryDb();
  if (!db) return <LoadError what="projects" detail="The database is not configured on this deployment." />;
  const vendorViewer = vendor?.ok && vendor.viewer.kind === "client" ? vendor.viewer : null;
  const vendorProjects = vendorViewer ? await loadVendorProjects(db, vendorViewer) : null;

  // ── a member below owner/admin in a client workspace: OASIS as vendor only ──
  if (!desk.ok || desk.viewer.kind !== "founder") {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title="Your projects"
          subtitle="Where each of your projects stands, and the latest update from the OASIS team."
          action={<a className="btn-secondary" href={SUPPORT_FORM_PATH}>Report an issue</a>}
        />
        <VendorProjectList data={vendorProjects ?? { ok: true, projects: [] }} />
      </div>
    );
  }

  // ── the viewer's own workspace's board ──────────────────────────────────
  const viewer = desk.viewer;
  const stageFilter = (ACTIVE_PROJECT_STAGES as readonly ProjectStage[]).includes(sp.stage as ProjectStage)
    ? (sp.stage as ProjectStage)
    : null;
  let result: Awaited<ReturnType<typeof listProjects>> | null = null;
  let failure: string | null = null;
  let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
  let directory: Awaited<ReturnType<typeof loadMemberDirectory>> = [];
  // The assignee menu's roster fails on its own (OASIS needs its proprietor
  // active: lib/team.ts getOasisPipelineAssignmentRoster throws otherwise).
  // The board still renders; only the menu degrades, with a notice.
  let rosterNotice: string | null = null;
  try {
    [result, roster, directory] = await Promise.all([
      listProjects(db, viewer, {
        activeClientOnly: true,
        stage: stageFilter,
        assignee: sp.assignee || null,
        q: sp.q || null,
      }),
      loadAssignmentRoster(viewer.tenantId).catch((err: unknown) => {
        console.error("[projects.page.roster]", err);
        const msg = err instanceof Error ? err.message : String(err);
        rosterNotice = msg.includes("oasis_pipeline_assignment_roster_incomplete")
          ? "The assignee filter needs CC as an active member of this workspace. Everything else on the board works."
          : "The assignee filter couldn't be loaded. The error has been logged; everything else on the board works.";
        return [] as Awaited<ReturnType<typeof loadAssignmentRoster>>;
      }),
      loadMemberDirectory(viewer.tenantId),
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
  const columns = (stageFilter ? [stageFilter] : ACTIVE_PROJECT_STAGES).map((stage) => ({
    stage,
    items: projects.filter((p) => p.stage === stage),
  }));
  const active = projects.length;
  const openTickets = projects.reduce((n, p) => n + p.open_ticket_count, 0);
  const filtered = Boolean(stageFilter || sp.assignee || sp.q);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Active projects"
        subtitle={
          failure ? "Current client delivery." : `${active} active client project${active === 1 ? "" : "s"}${filtered ? " in this view" : ""}.`
        }
        action={<Link href="/clients" className="btn-secondary">Choose a client</Link>}
      />

      {failure ? (
        <LoadError what="projects" detail={failure} />
      ) : (
        <>
          {(rosterNotice as string | null) && (
            <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
              {rosterNotice}
            </p>
          )}
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Active" value={active} accent />
            <Stat label="In client review" value={projects.filter((p) => p.stage === "review").length} />
            <Stat label="Building" value={projects.filter((p) => p.stage === "building").length} />
            <Stat label="Open tickets" value={openTickets} hint={openTickets ? "across these projects" : undefined} />
          </section>

          <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-bg-border bg-bg-panel p-4">
            <label className="w-40">
              <span className="label">Stage</span>
              <select name="stage" className="select" defaultValue={stageFilter ?? ""}>
                <option value="">All stages</option>
                {ACTIVE_PROJECT_STAGES.map((s) => (
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
            <button type="submit" className="btn-secondary">Apply</button>
            {filtered && <Link href="/projects" className="pb-2 text-sm text-fg-muted hover:text-fg">Clear</Link>}
          </form>

          {result?.truncated && (
            <p className="text-sm text-status-warm">Showing the first 500 projects. Narrow the filters to see the rest.</p>
          )}

          {projects.length === 0 ? (
            <Card>
              <EmptyState message={filtered ? "No active client projects match these filters." : "No active client projects. Start one from a client record."} />
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

      {vendorProjects && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">Projects OASIS runs for you</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">Where each one stands, and the latest update from the OASIS team.</p>
          </div>
          <VendorProjectList data={vendorProjects} />
        </section>
      )}
    </div>
  );
}
