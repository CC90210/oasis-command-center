/**
 * /api/projects — CRUD for delivery projects.
 *
 * POST: Create a new project.
 * GET: List projects for the current tenant (founders see all).
 * PATCH: Update a project (stage, priority, etc).
 */
import { NextRequest, NextResponse } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { getActiveProfile } from "@/lib/queries";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";

const VALID_STAGES = ["discovery", "blueprint", "development", "qa", "deployment", "live"];
const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];

export async function GET() {
  if (!tursoConfigured()) {
    return NextResponse.json({ projects: [] });
  }

  const profile = await getActiveProfile();
  const surface = await resolveViewerSurface();
  const isFounder = surface.ok && surface.capabilities.canSeeAllPipeline;
  const tenantId = isFounder ? undefined : profile?.tenant_id || "";

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
            ORDER BY p.updated_at DESC`,
      args,
    });
    return NextResponse.json({ projects: r.rows });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to load projects", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!tursoConfigured()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const surface = await resolveViewerSurface();
  if (!surface.ok || !surface.capabilities.canSeeSystemSurfaces) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    tenant_id,
    title,
    description,
    stage = "discovery",
    priority = "medium",
    assigned_to,
    due_date,
  } = body;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!tenant_id) {
    return NextResponse.json({ error: "tenant_id is required" }, { status: 400 });
  }
  if (!VALID_STAGES.includes(stage)) {
    return NextResponse.json({ error: `Invalid stage. Must be one of: ${VALID_STAGES.join(", ")}` }, { status: 400 });
  }

  try {
    const db = getTursoClient();
    const r = await db.execute({
      sql: `INSERT INTO delivery_projects
            (tenant_id, title, description, stage, priority, assigned_to, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING *`,
      args: [
        tenant_id,
        title.trim(),
        description || null,
        stage,
        priority,
        assigned_to || null,
        due_date || null,
      ],
    });

    // Log a delivery update for the timeline
    const project = r.rows[0];
    if (project?.id) {
      await db.execute({
        sql: `INSERT INTO delivery_updates (project_id, tenant_id, author, body)
              VALUES (?, ?, 'system', ?)`,
        args: [
          String(project.id),
          tenant_id,
          `Project "${title.trim()}" created in ${stage} stage.`,
        ],
      });
    }

    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to create project", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  if (!tursoConfigured()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const surface = await resolveViewerSurface();
  if (!surface.ok || !surface.capabilities.canSeeSystemSurfaces) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const allowedFields = ["title", "description", "stage", "priority", "assigned_to", "due_date"];
  const sets: string[] = [];
  const args: (string | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!allowedFields.includes(key)) continue;
    if (key === "stage" && !VALID_STAGES.includes(value as string)) {
      return NextResponse.json({ error: `Invalid stage` }, { status: 400 });
    }
    if (key === "priority" && !VALID_PRIORITIES.includes(value as string)) {
      return NextResponse.json({ error: `Invalid priority` }, { status: 400 });
    }
    sets.push(`${key} = ?`);
    args.push((value as string) || null);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  sets.push("updated_at = datetime('now')");
  args.push(id);

  try {
    const db = getTursoClient();
    const r = await db.execute({
      sql: `UPDATE delivery_projects SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
      args,
    });

    // Log the stage change
    if (updates.stage) {
      await db.execute({
        sql: `INSERT INTO delivery_updates (project_id, tenant_id, author, body)
              VALUES (?, (SELECT tenant_id FROM delivery_projects WHERE id = ?), 'system', ?)`,
        args: [id, id, `Moved to ${updates.stage} stage.`],
      });
    }

    return NextResponse.json({ project: r.rows[0] });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to update project", detail: String(err) },
      { status: 500 },
    );
  }
}
