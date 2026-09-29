/**
 * POST /api/customers/convert — "Convert to client": a WON deal in this
 * workspace's Pipeline becomes a client record linked to it (source_lead_id).
 *
 * Body: { lead_id }. The lead is read from the SESSION's workspace only; a
 * lead id from another workspace is simply not found. Idempotent: converting a
 * lead that already has a client returns that client (200, created: false),
 * however often it is pressed. Owners and admins only, the same as creating a
 * client by hand. Nothing about the lead or its stage changes.
 */
import { NextRequest, NextResponse } from "next/server";
import { convertLeadToCustomer } from "@/lib/os/customers/store";
import {
  customersError,
  customersServerError,
  getCustomersDb,
  readJsonBody,
  resolveClientsViewer,
} from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(req: NextRequest) {
  try {
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const body = parsed.body && typeof parsed.body === "object" ? (parsed.body as Record<string, unknown>) : {};
    const leadId = typeof body.lead_id === "string" ? body.lead_id.trim() : "";
    if (!leadId) return customersError(400, "lead_id_required", { field: "lead_id" });
    if (!LEAD_ID_RE.test(leadId)) return customersError(400, "lead_id_invalid", { field: "lead_id" });
    const result = await convertLeadToCustomer(db, viewer.tenantId, leadId, viewer.userId, new Date());
    if (!result.ok) return customersError(result.status, result.error, { existing_id: result.existingId ?? null });
    return NextResponse.json(
      { ok: true, id: result.customer.id, created: result.created, linked_by: result.linkedBy, customer: result.customer },
      { status: result.created ? 201 : 200 },
    );
  } catch (err) {
    return customersServerError("convert", err);
  }
}
