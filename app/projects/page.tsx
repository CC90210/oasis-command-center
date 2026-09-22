import { Card, PageHeader, Stat, Tag, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { timeAgo } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const STAGES = [
  "discovery",
  "blueprint",
  "development",
  "qa",
  "deployment",
  "live",
] as const;

const STAGE_LABELS: Record<string, string> = {
  discovery: "Discovery",
  blueprint: "Blueprint",
  development: "Development",
  qa: "QA",
  deployment: "Deployment",
  live: "Live",
};

const STAGE_COLORS: Record<string, string> = {
  discovery: "bg-blue-500/20 text-blue-400",
  blueprint: "bg-purple-500/20 text-purple-400",
  development: "bg-amber-500/20 text-amber-400",
  qa: "bg-orange-500/20 text-orange-400",
  deployment: "bg-emerald-500/20 text-emerald-400",
  live: "bg-green-500/20 text-green-400",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/20 text-slate-400",
  medium: "bg-blue-500/20 text-blue-400",
  high: "bg-amber-500/20 text-amber-400",
  urgent: "bg-red-500/20 text-red-400",
};

type Project = {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  stage: string;
  priority: string;
  assigned_to: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  task_count: number;
  tasks_done: number;
};

async function getProjects(tenantId?: string): Promise<Project[]> {
  if (!tursoConfigured()) return [];
  try {
    const db = getTursoClient();
    const tenantFilter = tenantId ? "WHERE p.tenant_id = ?" : "";
    const args = tenantId ? [tenantId] : [];
    const r = await db.execute({
      sql: `SELECT p.*,
                   COUNT(t.id) as task_count,
                   SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as tasks_done
            FROM delivery_projects p
            LEFT JOIN delivery_tasks t ON t.project_id = p.id
            ${tenantFilter}
            GROUP BY p.id
            ORDER BY
              CASE p.priority
                WHEN 'urgent' THEN 0
                WHEN 'high'   THEN 1
                WHEN 'medium' THEN 2
                ELSE 3
              END,
              p.updated_at DESC`,
      args,
    });
    return r.rows.map((row) => ({
      id: String(row.id ?? ""),
      tenant_id: String(row.tenant_id ?? ""),
      title: String(row.title ?? ""),
      description: row.description ? String(row.description) : null,
      stage: String(row.stage ?? "discovery"),
      priority: String(row.priority ?? "medium"),
      assigned_to: row.assigned_to ? String(row.assigned_to) : null,
      due_date: row.due_date ? String(row.due_date) : null,
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
      task_count: Number(row.task_count ?? 0),
      tasks_done: Number(row.tasks_done ?? 0),
    }));
  } catch {
    return [];
  }
}

function ProjectCard({ project }: { project: Project }) {
  const progress =
    project.task_count > 0
      ? Math.round((project.tasks_done / project.task_count) * 100)
      : 0;

  return (
    <div className="p-4 bg-bg-elev rounded-lg border border-bg-border hover:border-accent/30 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-bold text-sm">{project.title}</h3>
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
            PRIORITY_COLORS[project.priority] || PRIORITY_COLORS.medium
          }`}
        >
          {project.priority}
        </span>
      </div>

      {project.description && (
        <p className="text-xs text-fg-muted mb-3 line-clamp-2">
          {project.description}
        </p>
      )}

      <div className="flex items-center gap-2 mb-2">
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
            STAGE_COLORS[project.stage] || ""
          }`}
        >
          {STAGE_LABELS[project.stage] || project.stage}
        </span>
      </div>

      {project.task_count > 0 && (
        <div className="mb-2">
          <div className="flex justify-between text-[10px] text-fg-muted mb-1">
            <span>
              {project.tasks_done}/{project.task_count} tasks
            </span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-fg-muted">
        {project.due_date && <span>Due {project.due_date}</span>}
        <span>{timeAgo(project.updated_at)}</span>
      </div>
    </div>
  );
}

export default async function ProjectsPage() {
  const profile = await safe("projects.profile", getActiveProfile(), null);
  const surface = await resolveViewerSurface();
  const isFounder = surface.ok && surface.capabilities.canSeeAllPipeline;

  // Founders see all projects; clients see only their tenant's
  const tenantId = isFounder ? undefined : profile?.tenant_id || "";
  const projects = await safe(
    "projects.list",
    getProjects(tenantId),
    [],
  );

  const byStage = STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    projects: projects.filter((p) => p.stage === stage),
  }));

  const activeCount = projects.filter((p) => p.stage !== "live").length;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={isFounder ? "Projects" : "Project Status"}
        subtitle={
          isFounder
            ? `${activeCount} active project${activeCount !== 1 ? "s" : ""} across all clients.`
            : "Track the progress of your AI implementation."
        }
      />

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Stat label="Active" value={activeCount} accent />
        <Stat
          label="Completed"
          value={projects.filter((p) => p.stage === "live").length}
        />
        <Stat label="Total Tasks" value={projects.reduce((s, p) => s + p.task_count, 0)} />
      </section>

      {projects.length === 0 ? (
        <Card title="No projects yet">
          <EmptyState message="Projects will appear here once a delivery engagement begins." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {byStage.map(({ stage, label, projects: stageProjects }) => (
            <div key={stage} className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
                  {label}
                </h2>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elev text-fg-muted border border-bg-border">
                  {stageProjects.length}
                </span>
              </div>
              {stageProjects.length === 0 ? (
                <div className="p-3 bg-bg-elev/50 rounded-lg border border-bg-border border-dashed text-[10px] text-fg-muted text-center">
                  No projects
                </div>
              ) : (
                stageProjects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
