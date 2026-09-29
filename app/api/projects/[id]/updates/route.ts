/**
 * POST /api/projects/[id]/updates — add to the project timeline (the
 * project's desk team only). `visibility` defaults to "internal"; only
 * "client" updates ever reach the client's portal, so sharing is always a
 * deliberate choice.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import { validateUpdateCreate } from "@/lib/delivery/rules";
import {
  deliveryError,
  getDeliveryDb,
  readJson,
  resolveProjectAccess,
  serverError,
} from "@/lib/delivery/session";
import { addProjectUpdate, profileContact } from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const access = await resolveProjectAccess(db, id);
    if (!access.ok) return deliveryError(access.status, access.error);
    const viewer = access.viewer;
    if (viewer.kind !== "founder" || !mayPerform(viewer, "update.write")) return deliveryError(403, "forbidden");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateUpdateCreate(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const author = { userId: viewer.userId, name: (await profileContact(db, viewer.userId, viewer.tenantId)).name };
    const updateId = await addProjectUpdate(db, viewer.tenantId, id, v.value, author, new Date());
    if (!updateId) return deliveryError(404, "not_found");
    return NextResponse.json({ ok: true, id: updateId }, { status: 201 });
  } catch (err) {
    return serverError("updates.create", err);
  }
}
