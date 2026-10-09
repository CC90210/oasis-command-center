/**
 * /api/projects/[id]
 *
 * The project is looked up through the viewer's own desk first, then (outside
 * OASIS) through OASIS as their vendor — lib/delivery/session.ts
 * resolveProjectAccess. Whichever finds it decides the rules below.
 *
 *   GET    the project, its tasks (the desk team only), its timeline (clients
 *          see client-visible updates only) and its tickets (clients see their
 *          own only). A project outside the viewer's scope is 404, never 403,
 *          so the route cannot confirm another client's project exists.
 *   PATCH  the desk team only: title, description, stage, priority, assignee,
 *          due date, client fields, client record, lead link, archived.
 */
import { NextRequest, NextResponse } from "next/server";
import { isOasisDesk, mayPerform } from "@/lib/delivery/access";
import { toClientProject, toClientTicket, validateAssignee, validateProjectPatch } from "@/lib/delivery/rules";
import {
  deliveryError,
  getDeliveryDb,
  loadAssignmentRoster,
  readJson,
  resolveProjectAccess,
  serverError,
} from "@/lib/delivery/session";
import {
  clientTenantChangeAllowed,
  deskCustomerExists,
  deskLeadExists,
  getProject,
  listProjectTasks,
  listProjectUpdates,
  listTickets,
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
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const access = await resolveProjectAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const { viewer, project } = access;
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
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const access = await resolveProjectAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const viewer = access.viewer;
    if (viewer.kind !== "founder" || !mayPerform(viewer, "project.update")) return deliveryError(403, "forbidden");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateProjectPatch(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const desk = viewer.tenantId;

    const { assigned_to, ...rest } = v.value;
    const changes: ProjectChanges = { ...rest };
    if ("assigned_to" in v.value) {
      const a = validateAssignee(assigned_to, await loadAssignmentRoster(desk));
      if (!a.ok) return deliveryError(400, a.error, undefined, { field: "assigned_to" });
      changes.assigned_to = a.value;
    }
    if ("client_tenant_id" in changes && !isOasisDesk(viewer)) {
      return deliveryError(400, "client_workspace_links_are_oasis_only", undefined, { field: "client_tenant_id" });
    }
    if (!(await clientTenantChangeAllowed(db, changes.client_tenant_id, access.project.client_tenant_id))) {
      return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
    }
    if (changes.lead_id && !(await deskLeadExists(db, desk, changes.lead_id))) {
      return deliveryError(400, "lead_not_found", undefined, { field: "lead_id" });
    }
    if (changes.customer_id && !(await deskCustomerExists(db, desk, changes.customer_id))) {
      return deliveryError(400, "customer_not_found", undefined, { field: "customer_id" });
    }

    const author = { userId: viewer.userId, name: (await profileContact(db, viewer.userId, desk)).name };
    const found = await updateProject(db, desk, id, changes, author, new Date());
    if (!found) return deliveryError(404, "not_found");
    return NextResponse.json({ ok: true, project: await getProject(db, viewer, id) });
  } catch (err) {
    return serverError("projects.update", err);
  }
}
