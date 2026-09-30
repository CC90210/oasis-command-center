/**
 * /api/tickets/[id]
 *
 * The ticket is looked up through the viewer's own desk first, then (outside
 * OASIS) through OASIS as their vendor — lib/delivery/session.ts
 * resolveTicketAccess. Whichever finds it decides the rules below.
 *
 *   GET    the ticket and its thread. Clients of OASIS: their own ticket only
 *          (anything else is 404), public comments only, client-safe fields.
 *   PATCH  the desk team only: status (checked against the allowed
 *          transitions), severity (re-targets the SLA while unanswered),
 *          category, title, description, resolution, assignee (roster-
 *          validated), client record (one of the desk's own), client workspace
 *          (OASIS's desk only), and the project link (a project of a different
 *          client is refused).
 */
import { NextRequest, NextResponse } from "next/server";
import { isOasisDesk, mayPerform } from "@/lib/delivery/access";
import {
  memberDisplayName,
  slaStatus,
  toClientTicket,
  validateAssignee,
  validateTicketPatch,
} from "@/lib/delivery/rules";
import {
  deliveryError,
  getDeliveryDb,
  loadAssignmentRoster,
  readJson,
  resolveTicketAccess,
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
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const access = await resolveTicketAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const { viewer, ticket } = access;
    const comments = await listTicketComments(db, viewer, id);
    if (viewer.kind === "client") {
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
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const access = await resolveTicketAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const viewer = access.viewer;
    if (viewer.kind !== "founder" || !mayPerform(viewer, "ticket.update")) return deliveryError(403, "forbidden");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateTicketPatch(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });

    const { assigned_to, ...rest } = v.value;
    const changes: TicketChanges = { ...rest };
    let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
    if ("assigned_to" in v.value) {
      roster = await loadAssignmentRoster(viewer.tenantId);
      const a = validateAssignee(assigned_to, roster);
      if (!a.ok) return deliveryError(400, a.error, undefined, { field: "assigned_to" });
      changes.assigned_to = a.value;
    }
    if ("client_tenant_id" in changes || changes.confirm_client_link) {
      // Client workspaces are OASIS's vendor relationship; no other desk has them.
      if (!isOasisDesk(viewer)) return deliveryError(400, "client_workspace_links_are_oasis_only", undefined, { field: "client_tenant_id" });
    }
    if (changes.client_tenant_id && !(await clientTenantExists(db, changes.client_tenant_id))) {
      return deliveryError(400, "client_tenant_not_found", undefined, { field: "client_tenant_id" });
    }
    const author = { userId: viewer.userId, name: (await profileContact(db, viewer.userId, viewer.tenantId)).name };
    const result = await updateTicket(db, viewer.tenantId, id, changes, author, new Date(), {
      assignee: (uid) => memberDisplayName(uid, roster),
    });
    if (!result.ok) return deliveryError(result.status, result.error);
    const ticket = await getTicket(db, viewer, id);
    return NextResponse.json({ ok: true, changed: result.changed, ticket: ticket ? { ...ticket, sla: slaStatus(ticket, new Date()) } : null });
  } catch (err) {
    return serverError("tickets.update", err);
  }
}
