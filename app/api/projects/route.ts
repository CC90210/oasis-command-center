/**
 * /api/projects — delivery projects.
 *
 * `?scope=desk` is the viewer's OWN workspace's board; no scope keeps the
 * pre-desk contract ("vendor": OASIS's board, and a client workspace reading
 * OASIS's projects for it). See lib/delivery/access.ts.
 *
 *   GET   list. The desk team: every project on their desk (filters: stage,
 *         assignee, customer_id, q, archived=1). Clients of OASIS: only their
 *         workspace's projects, client-safe fields only.
 *   POST  create (the desk team only). Assignee validated against the desk's
 *         live assignment roster; a lead must be in the desk's own pipeline, a
 *         client record must be the desk's own, and a client workspace link is
 *         OASIS's desk only.
 *
 * Authorization is lib/delivery/access.ts; every read is scoped in
 * lib/delivery/store.ts. Failures are loud: a broken query is a 500 with the
 * cause, never an empty list.
 */
import { NextRequest, NextResponse } from "next/server";
import { isOasisDesk, mayPerform } from "@/lib/delivery/access";
import { toClientProject, validateAssignee, validateProjectCreate } from "@/lib/delivery/rules";
import {
  accessDenied,
  deliveryError,
  getDeliveryAccess,
  getDeliveryDb,
  loadAssignmentRoster,
  readJson,
  relationFromScope,
  serverError,
} from "@/lib/delivery/session";
import {
  clientTenantExists,
  createProject,
  deskCustomerExists,
  deskLeadExists,
  getProject,
  listProjects,
  profileContact,
} from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const access = await getDeliveryAccess(relationFromScope(sp.get("scope")));
    if (!access.ok) return accessDenied(access);
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const { rows, truncated } = await listProjects(db, access.viewer, {
      stage: sp.get("stage"),
      assignee: sp.get("assignee"),
      customer_id: sp.get("customer_id"),
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
    const access = await getDeliveryAccess(relationFromScope(req.nextUrl.searchParams.get("scope")));
    if (!access.ok) return accessDenied(access);
    const viewer = access.viewer;
    if (viewer.kind !== "founder" || !mayPerform(viewer, "project.create")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateProjectCreate(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const input = v.value;
    const desk = viewer.tenantId;

    const assignee = validateAssignee(input.assigned_to, await loadAssignmentRoster(desk));
    if (!assignee.ok) return deliveryError(400, assignee.error, undefined, { field: "assigned_to" });
    if (input.client_tenant_id) {
      if (!isOasisDesk(viewer)) return deliveryError(400, "client_workspace_links_are_oasis_only", undefined, { field: "client_tenant_id" });
      if (!(await clientTenantExists(db, input.client_tenant_id))) {
        return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
      }
    }
    if (input.lead_id && !(await deskLeadExists(db, desk, input.lead_id))) {
      return deliveryError(400, "lead_not_found", undefined, { field: "lead_id" });
    }
    if (input.customer_id && !(await deskCustomerExists(db, desk, input.customer_id))) {
      return deliveryError(400, "customer_not_found", undefined, { field: "customer_id" });
    }

    const author = { userId: viewer.userId, name: (await profileContact(db, viewer.userId, desk)).name };
    const id = await createProject(db, desk, { ...input, assigned_to: assignee.value }, author, new Date());
    const project = await getProject(db, viewer, id);
    return NextResponse.json({ ok: true, id, project }, { status: 201 });
  } catch (err) {
    return serverError("projects.create", err);
  }
}
