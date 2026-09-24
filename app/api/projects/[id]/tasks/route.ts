/**
 * POST /api/projects/[id]/tasks — add a task (founders only). Tasks are
 * internal work items; no client surface ever reads them.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import { validateAssignee, validateTaskCreate } from "@/lib/delivery/rules";
import {
  accessDenied,
  deliveryError,
  getDeliveryAccess,
  getDeliveryDb,
  loadAssignmentRoster,
  readJson,
  serverError,
} from "@/lib/delivery/session";
import { createTask } from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    if (!mayPerform(access.viewer, "task.write")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateTaskCreate(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const a = validateAssignee(v.value.assigned_to, await loadAssignmentRoster());
    if (!a.ok) return deliveryError(400, a.error, undefined, { field: "assigned_to" });
    const taskId = await createTask(db, id, { ...v.value, assigned_to: a.value }, new Date());
    if (!taskId) return deliveryError(404, "not_found");
    return NextResponse.json({ ok: true, id: taskId }, { status: 201 });
  } catch (err) {
    return serverError("tasks.create", err);
  }
}
