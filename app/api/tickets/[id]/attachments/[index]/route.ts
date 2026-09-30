/**
 * GET /api/tickets/[id]/attachments/[index] — download a ticket attachment.
 *
 * The object lives in the PRIVATE `support-attachments` bucket, under the
 * ticket's desk tenant. This route reads the ticket through the viewer's own
 * desk first, then (outside OASIS) OASIS as vendor (resolveTicketAccess), so a
 * desk opens only its own tickets' files and a client of OASIS only their own
 * ticket's; then it redirects to a five-minute signed URL. The storage path is
 * never taken from the request — only the index into the ticket's own
 * attachment list.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { deliveryError, getDeliveryDb, resolveTicketAccess, serverError } from "@/lib/delivery/session";
import { SUPPORT_ATTACHMENT_BUCKET } from "@/lib/delivery/support-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const access = await resolveTicketAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const ticket = access.ticket;
    const i = Number(index);
    const file = Number.isInteger(i) && i >= 0 ? ticket.attachments[i] : undefined;
    if (!file || !file.storage_path) return deliveryError(404, "not_found");
    const { data, error } = await getServiceSupabase()
      .storage.from(SUPPORT_ATTACHMENT_BUCKET)
      .createSignedUrl(file.storage_path, 300);
    if (error || !data?.signedUrl) {
      return serverError("tickets.attachment", new Error(error?.message || "signed URL unavailable"));
    }
    return NextResponse.redirect(data.signedUrl, 302);
  } catch (err) {
    return serverError("tickets.attachment", err);
  }
}
