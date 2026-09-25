/**
 * /api/projects — delivery projects.
 *
 *   GET   list. Founders: every project in the OASIS workspace (filters: stage,
 *         assignee, q, archived=1). Clients: only their workspace's projects,
 *         client-safe fields only.
 *   POST  create (founders only). Assignee validated against the live
 *         assignment roster; client workspace and lead must exist.
 *
 * Authorization is lib/delivery/access.ts; every read is scoped in
 * lib/delivery/store.ts. Failures are loud: a broken query is a 500 with the
 * cause, never an empty list.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import {
  DELIVERY_TENANT_ID,
  toClientProject,
  validateAssignee,
  validateProjectCreate,
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
  createProject,
  getProject,
  listProjects,
  oasisLeadExists,
  profileContact,
} from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const sp = req.nextUrl.searchParams;
    const { rows, truncated } = await listProjects(db, access.viewer, {
      stage: sp.get("stage"),
      assignee: sp.get("assignee"),
      q: sp.get("q"),
      includeArchived: sp.get("archived") === "1",
    });
    return NextResponse.json({
      ok: true,
      projects: access.viewer.kind === "founder" ? rows : rows.map(toClientProject),
      truncated,
    });
  } catch (err) {
    return serverError("projects.list", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    if (!mayPerform(access.viewer, "project.create")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateProjectCreate(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const input = v.value;

    const assignee = validateAssignee(input.assigned_to, await loadAssignmentRoster());
    if (!assignee.ok) return deliveryError(400, assignee.error, undefined, { field: "assigned_to" });
    if (input.client_tenant_id && !(await clientTenantExists(db, input.client_tenant_id))) {
      return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
    }
    if (input.lead_id && !(await oasisLeadExists(db, input.lead_id))) {
      return deliveryError(400, "lead_not_found", undefined, { field: "lead_id" });
    }

    const author = { userId: access.viewer.userId, name: (await profileContact(db, access.viewer.userId, DELIVERY_TENANT_ID)).name };
    const id = await createProject(db, { ...input, assigned_to: assignee.value }, author, new Date());
    const project = await getProject(db, access.viewer, id);
    return NextResponse.json({ ok: true, id, project }, { status: 201 });
  } catch (err) {
    return serverError("projects.create", err);
  }
}
