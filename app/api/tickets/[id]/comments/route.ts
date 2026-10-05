/**
 * POST /api/tickets/[id]/comments — add to a ticket's thread.
 *
 * The ticket is found through the viewer's own desk first, then (outside
 * OASIS) through OASIS as vendor (lib/delivery/session.ts resolveTicketAccess).
 *
 *   The desk team: `is_internal` true (the default) writes a note only the
 *   team sees; false writes a public reply that, on OASIS's desk, is emailed to
 *   the client from the OASIS mailbox (another desk records that no mailbox is
 *   connected yet — lib/delivery/notify.ts) and, if it is the first, stops the
 *   first-response SLA clock. The email outcome is returned and stored on the
 *   comment.
 *
 *   Clients of OASIS: always a public comment, only on their own ticket
 *   (anything else is 404), never on a closed ticket. It reopens a ticket that
 *   was waiting on them or resolved, and pings the founders' Telegram.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import { DELIVERY_TENANT_ID, validateCommentCreate } from "@/lib/delivery/rules";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import {
  deliveryError,
  getDeliveryDb,
  readJson,
  resolveTicketAccess,
  serverError,
} from "@/lib/delivery/session";
import { addTicketComment, getProject, profileContact } from "@/lib/delivery/store";
import {
  defaultNotifyDeps,
  emailClientReply,
  scheduleAfterResponse,
  ticketUrl,
} from "@/lib/delivery/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A public reply waits for the SMTP send so the founder sees whether it went.
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    // Scoped read first: a client asking about someone else's ticket learns nothing.
    const access = await resolveTicketAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const { viewer, ticket } = access;
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const authorType = viewer.kind === "founder" ? "team" : "client";
    const v = validateCommentCreate(parsed.body, authorType);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const action = authorType === "team" && v.value.is_internal ? "ticket.comment.internal" : "ticket.comment.public";
    if (!mayPerform(viewer, action)) return deliveryError(403, "forbidden");

    // The desk the ticket lives on, and the workspace the author's profile is in.
    const deskTenant = viewer.kind === "founder" ? viewer.tenantId : DELIVERY_TENANT_ID;
    const contact = await profileContact(
      db,
      viewer.userId,
      viewer.kind === "founder" ? viewer.tenantId : viewer.clientTenantId,
    );
    const result = await addTicketComment(
      db,
      deskTenant,
      id,
      {
        body: v.value.body,
        is_internal: v.value.is_internal,
        author_type: authorType,
        author: { userId: viewer.userId, name: contact.name },
      },
      new Date(),
    );
    if (!result.ok) return deliveryError(result.status, result.error);

    const deps = defaultNotifyDeps();
    if (authorType === "team" && !result.comment.is_internal) {
      // A ticket a founder filed may carry no email of its own; the linked
      // project's client email is who the reply is for.
      const clientEmail =
        ticket.client_email ??
        (ticket.project_id ? (await getProject(db, viewer, ticket.project_id))?.client_email ?? null : null);
      const status = await emailClientReply(
        db,
        deskTenant,
        { ...ticket, client_email: clientEmail },
        { id: result.comment.id, body: result.comment.body, authorName: contact.name },
        deps,
      );
      return NextResponse.json(
        { ok: true, comment: { ...result.comment, email_status: status }, first_response: result.firstResponse },
        { status: 201 },
      );
    }
    if (authorType === "client") {
      scheduleAfterResponse(async () => {
        const e = escapeTelegramHtml;
        const r = await deps.telegram(
          [
            `<b>Client replied on ${e(ticket.ticket_number)}</b>${result.reopened ? " (ticket reopened)" : ""}`,
            e(result.comment.body.slice(0, 600)),
            e(ticketUrl(deps, id)),
          ].join("\n"),
        );
        if (!r.ok) console.error("[delivery.comment.client_ping]", { ticket: ticket.ticket_number, reason: r.reason });
      });
      return NextResponse.json(
        {
          ok: true,
          comment: {
            id: result.comment.id,
            author_type: result.comment.author_type,
            author_name: result.comment.author_name,
            body: result.comment.body,
            created_at: result.comment.created_at,
          },
        },
        { status: 201 },
      );
    }
    return NextResponse.json({ ok: true, comment: result.comment }, { status: 201 });
  } catch (err) {
    return serverError("tickets.comment", err);
  }
}
