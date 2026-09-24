/**
 * GET /api/tickets/[id]/attachments/[index] — download a ticket attachment.
 *
 * The object lives in the PRIVATE `support-attachments` bucket. This route
 * reads the ticket through the viewer's scope first (a client may only open
 * their own ticket's files), then redirects to a five-minute signed URL. The
 * storage path is never taken from the request — only the index into the
 * ticket's own attachment list.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  accessDenied,
  deliveryError,
  getDeliveryAccess,
  getDeliveryDb,
  serverError,
} from "@/lib/delivery/session";
import { getTicket } from "@/lib/delivery/store";
import { SUPPORT_ATTACHMENT_BUCKET } from "@/lib/delivery/support-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const ticket = await getTicket(db, access.viewer, id);
    if (!ticket) return deliveryError(404, "not_found");
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
