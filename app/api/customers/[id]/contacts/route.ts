/**
 * /api/customers/[id]/contacts — the other people at a client.
 *
 *   POST    add a contact (owners and admins). 404 when the client is not one
 *           of this workspace's.
 *   DELETE  ?contact_id=<id> — remove one (owners and admins). 404 when that
 *           contact is not on this client in this workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { validateContactCreate } from "@/lib/os/customers/rules";
import { addContact, removeContact } from "@/lib/os/customers/store";
import {
  customersError,
  customersServerError,
  getCustomersDb,
  readJsonBody,
  resolveClientsViewer,
} from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const v = validateContactCreate(parsed.body);
    if (!v.ok) return customersError(400, v.error, { field: v.field });
    const contact = await addContact(db, viewer.tenantId, id, v.value, new Date());
    if (!contact) return customersError(404, "not_found");
    return NextResponse.json({ ok: true, contact }, { status: 201 });
  } catch (err) {
    return customersServerError("contacts.create", err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const contactId = req.nextUrl.searchParams.get("contact_id");
    if (!contactId) return customersError(400, "contact_id_required", { field: "contact_id" });
    const removed = await removeContact(db, viewer.tenantId, id, contactId);
    if (!removed) return customersError(404, "not_found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return customersServerError("contacts.delete", err);
  }
}
