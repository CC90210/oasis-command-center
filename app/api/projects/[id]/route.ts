/**
 * /api/projects/[id]
 *
 *   GET    the project, its tasks (founders only), its timeline (clients see
 *          client-visible updates only) and its tickets (clients see their own
 *          only). A project outside the viewer's scope is 404, never 403, so the
 *          route cannot confirm another client's project exists.
 *   PATCH  founders only: title, description, stage, priority, assignee, due
 *          date, client fields, lead link, archived.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import {
  DELIVERY_TENANT_ID,
  toClientProject,
  toClientTicket,
  validateAssignee,
  validateProjectPatch,
} from "@/lib/delivery/rules";
import {
  accessDenied,
  deliveryError,
  getDeliveryAccess,
  getDeliveryDb,
  loadAssignmentRoster,
  readJson,
  serverError,
} from "@/lib/delivery/session";
import {
  clientTenantExists,
  getProject,
  listProjectTasks,
  listProjectUpdates,
  listTickets,
  oasisLeadExists,
  profileContact,
  updateProject,
  type ProjectChanges,
} from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const viewer = access.viewer;
    const project = await getProject(db, viewer, id);
    if (!project) return deliveryError(404, "not_found");
    const [tasks, updates, tickets] = await Promise.all([
      listProjectTasks(db, viewer, id),
      listProjectUpdates(db, viewer, id),
      listTickets(db, viewer, { project_id: id, status: "all" }),
    ]);
    if (viewer.kind === "client") {
      return NextResponse.json({
        ok: true,
        project: toClientProject(project),
        updates: updates.map(({ id: uid, body, author_name, created_at }) => ({ id: uid, body, author_name, created_at })),
        tickets: tickets.rows.map(toClientTicket),
      });
    }
    return NextResponse.json({ ok: true, project, tasks, updates, tickets: tickets.rows });
  } catch (err) {
    return serverError("projects.detail", err);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    if (!mayPerform(access.viewer, "project.update")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateProjectPatch(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });

    const { assigned_to, ...rest } = v.value;
    const changes: ProjectChanges = { ...rest };
    if ("assigned_to" in v.value) {
      const a = validateAssignee(assigned_to, await loadAssignmentRoster());
      if (!a.ok) return deliveryError(400, a.error, undefined, { field: "assigned_to" });
      changes.assigned_to = a.value;
    }
    if (changes.client_tenant_id && !(await clientTenantExists(db, changes.client_tenant_id))) {
      return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
    }
    if (changes.lead_id && !(await oasisLeadExists(db, changes.lead_id))) {
      return deliveryError(400, "lead_not_found", undefined, { field: "lead_id" });
    }

    const author = { userId: access.viewer.userId, name: (await profileContact(db, access.viewer.userId, DELIVERY_TENANT_ID)).name };
    const found = await updateProject(db, id, changes, author, new Date());
    if (!found) return deliveryError(404, "not_found");
    return NextResponse.json({ ok: true, project: await getProject(db, access.viewer, id) });
  } catch (err) {
    return serverError("projects.update", err);
  }
}
