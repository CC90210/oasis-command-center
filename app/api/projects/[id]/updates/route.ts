/**
 * POST /api/projects/[id]/updates — add to the project timeline (founders
 * only). `visibility` defaults to "internal"; only "client" updates ever reach
 * the client's portal, so sharing is always a deliberate choice.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import { DELIVERY_TENANT_ID, validateUpdateCreate } from "@/lib/delivery/rules";
import {
  accessDenied,
  deliveryError,
  getDeliveryAccess,
  getDeliveryDb,
  readJson,
  serverError,
} from "@/lib/delivery/session";
import { addProjectUpdate, profileContact } from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    if (!mayPerform(access.viewer, "update.write")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateUpdateCreate(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const author = { userId: access.viewer.userId, name: (await profileContact(db, access.viewer.userId, DELIVERY_TENANT_ID)).name };
    const updateId = await addProjectUpdate(db, id, v.value, author, new Date());
    if (!updateId) return deliveryError(404, "not_found");
    return NextResponse.json({ ok: true, id: updateId }, { status: 201 });
  } catch (err) {
    return serverError("updates.create", err);
  }
}
