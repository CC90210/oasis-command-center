/**
 * PATCH /api/projects/[id]/tasks/[taskId] — edit a task (founders only):
 * status, title, notes, due date, order, assignee (roster-validated).
 * There is no delete: a mistaken task is marked cancelled, which keeps the
 * record and drops it out of the progress count.
 */
import { NextRequest, NextResponse } from "next/server";
import { mayPerform } from "@/lib/delivery/access";
import { validateAssignee, validateTaskPatch } from "@/lib/delivery/rules";
import {
  accessDenied,
  deliveryError,
  getDeliveryAccess,
  getDeliveryDb,
  loadAssignmentRoster,
  readJson,
  serverError,
} from "@/lib/delivery/session";
import { updateTask } from "@/lib/delivery/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const { id, taskId } = await params;
    const access = await getDeliveryAccess();
    if (!access.ok) return accessDenied(access);
    if (!mayPerform(access.viewer, "task.write")) return deliveryError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return deliveryError(503, "database_not_configured");
    const parsed = await readJson(req);
    if (!parsed.ok) return deliveryError(400, "invalid_json");
    const v = validateTaskPatch(parsed.body);
    if (!v.ok) return deliveryError(400, v.error, undefined, { field: v.field });
    const { assigned_to, ...changes } = v.value;
    const resolved: Parameters<typeof updateTask>[3] = { ...changes };
    if ("assigned_to" in v.value) {
      const a = validateAssignee(assigned_to, await loadAssignmentRoster());
      if (!a.ok) return deliveryError(400, a.error, undefined, { field: "assigned_to" });
      resolved.assigned_to = a.value;
    }
    const found = await updateTask(db, id, taskId, resolved, new Date());
    if (!found) return deliveryError(404, "not_found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError("tasks.update", err);
  }
}
