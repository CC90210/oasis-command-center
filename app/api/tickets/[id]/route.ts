/**
 * /api/tickets/[id]
 *
 *   GET    the ticket and its thread. Clients: their own ticket only (anything
 *          else is 404), public comments only, client-safe fields only.
 *   PATCH  founders only: status (checked against the allowed transitions),
 *          severity (re-targets the SLA while unanswered), category, title,
 *          description, resolution, assignee (roster-validated), client
 *          workspace, and the project link (a project of a different client is
 *          refused).
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import {
  memberDisplayName,
  slaStatus,
  toClientTicket,
  validateAssignee,
  validateTicketPatch,
  DELIVERY_TENANT_ID,
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
  getTicket,
  listTicketComments,
  profileContact,
  updateTicket,
  type TicketChanges,
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
    const ticket = await getTicket(db, access.viewer, id);
    if (!ticket) return deliveryError(404, "not_found");
    const comments = await listTicketComments(db, access.viewer, id);
    if (access.viewer.kind === "client") {
      return NextResponse.json({
        ok: true,
        ticket: toClientTicket(ticket),
        comments: comments.map((c) => ({
          id: c.id,
          author_type: c.author_type,
          author_name: c.author_name,
          body: c.body,
          created_at: c.created_at,
        })),
      });
    }
    return NextResponse.json({ ok: true, ticket: { ...ticket, sla: slaStatus(ticket, new Date()) }, comments });
  } catch (err) {
    return serverError("tickets.detail", err);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    if (!mayPerform(access.viewer, "ticket.update")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateTicketPatch(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });

    const { assigned_to, ...rest } = v.value;
    const changes: TicketChanges = { ...rest };
    let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
    if ("assigned_to" in v.value) {
      roster = await loadAssignmentRoster();
      const a = validateAssignee(assigned_to, roster);
      if (!a.ok) return deliveryError(400, a.error, undefined, { field: "assigned_to" });
      changes.assigned_to = a.value;
    }
    if (changes.client_tenant_id && !(await clientTenantExists(db, changes.client_tenant_id))) {
      return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
    }
    const author = { userId: access.viewer.userId, name: (await profileContact(db, access.viewer.userId, DELIVERY_TENANT_ID)).name };
    const result = await updateTicket(db, id, changes, author, new Date(), {
      assignee: (uid) => memberDisplayName(uid, roster),
    });
    if (!result.ok) return deliveryError(result.status, result.error);
    const ticket = await getTicket(db, access.viewer, id);
    return NextResponse.json({ ok: true, changed: result.changed, ticket: ticket ? { ...ticket, sla: slaStatus(ticket, new Date()) } : null });
  } catch (err) {
    return serverError("tickets.update", err);
  }
}
