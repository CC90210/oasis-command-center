/**
 * /api/tickets — support tickets.
 *
 *   GET   list. Founders: the OASIS queue (filters: status = open|closed|all|
 *         <status>, severity, project_id, assignee, q). Clients: ONLY tickets
 *         whose client_tenant_id is their workspace, client-safe fields only.
 *         (Before 2026-09-24 any signed-in user of any workspace could list
 *         every ticket here.)
 *   POST  create. Founders file internal tickets for any client; a client
 *         files a portal ticket for their own workspace only — every client_*
 *         field comes from their session, never the body.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import {
  slaStatus,
  toClientTicket,
  validateAssignee,
  validateTicketCreate,
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
  createTicket,
  getProject,
  getTicket,
  listTickets,
  profileContact,
} from "@/lib/delivery/store";
import { defaultNotifyDeps, runIntakeNotifications, scheduleAfterResponse } from "@/lib/delivery/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const sp = req.nextUrl.searchParams;
    const { rows, truncated } = await listTickets(db, access.viewer, {
      status: sp.get("status"),
      severity: sp.get("severity"),
      project_id: sp.get("project_id"),
      assignee: sp.get("assignee"),
      q: sp.get("q"),
    });
    const now = new Date();
    if (access.viewer.kind === "client") {
      return NextResponse.json({ ok: true, tickets: rows.map(toClientTicket), truncated });
    }
    return NextResponse.json({
      ok: true,
      tickets: rows.map((t) => ({ ...t, sla: slaStatus(t, now) })),
      truncated,
    });
  } catch (err) {
    return serverError("tickets.list", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    const viewer = access.viewer;
    if (!mayPerform(viewer, "ticket.create")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateTicketCreate(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const input = v.value;
    const now = new Date();

    if (viewer.kind === "client") {
      // The client's own workspace, from the session. A project, if named,
      // must be one of THEIR projects — getProject is scoped to them.
      if (input.project_id && !(await getProject(db, viewer, input.project_id))) {
        return deliveryError(400, "project_not_found", undefined, { field: "project_id" });
      }
      const contact = await profileContact(db, viewer.userId, viewer.clientTenantId);
      const { ticket } = await createTicket(
        db,
        {
          title: input.title,
          description: input.description,
          category: input.category,
          severity: input.severity,
          source: "portal",
          project_id: input.project_id,
          client_tenant_id: viewer.clientTenantId,
          client_name: contact.name,
          client_email: contact.email,
          client_company: input.client_company,
          client_match: "session",
          project_hint: null,
          reporter_user_id: viewer.userId,
          assigned_to: null,
        },
        now,
      );
      scheduleAfterResponse(() => runIntakeNotifications(db, ticket.id, defaultNotifyDeps(), now));
      return NextResponse.json({ ok: true, id: ticket.id, ticket: toClientTicket(ticket) }, { status: 201 });
    }

    const assignee = validateAssignee(input.assigned_to, await loadAssignmentRoster());
    if (!assignee.ok) return deliveryError(400, assignee.error, undefined, { field: "assigned_to" });
    if (input.client_tenant_id && !(await clientTenantExists(db, input.client_tenant_id))) {
      return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
    }
    let clientTenant = input.client_tenant_id;
    if (input.project_id) {
      const project = await getProject(db, viewer, input.project_id);
      if (!project) return deliveryError(400, "project_not_found", undefined, { field: "project_id" });
      if (project.client_tenant_id && clientTenant && project.client_tenant_id !== clientTenant) {
        return deliveryError(409, "project_belongs_to_another_client", undefined, { field: "project_id" });
      }
      clientTenant = clientTenant ?? project.client_tenant_id;
    }
    // Internal tickets notify nobody: a founder filed it, and emailing a client
    // about a ticket they did not raise is a decision, not a default.
    const { ticket } = await createTicket(
      db,
      {
        title: input.title,
        description: input.description,
        category: input.category,
        severity: input.severity,
        source: "internal",
        project_id: input.project_id,
        client_tenant_id: clientTenant,
        client_name: input.client_name,
        client_email: input.client_email,
        client_company: input.client_company,
        client_match: clientTenant ? "manual" : "none",
        project_hint: null,
        reporter_user_id: viewer.userId,
        assigned_to: assignee.value,
      },
      now,
    );
    const fresh = await getTicket(db, viewer, ticket.id);
    return NextResponse.json({ ok: true, id: ticket.id, ticket: fresh }, { status: 201 });
  } catch (err) {
    return serverError("tickets.create", err);
  }
}
