/** GET /api/skills/checkin/changes - this computer's changes waiting to be checked or accepted anyway. */
import { json } from "@/lib/playbook/http";
import { authenticateComputer } from "@/lib/skills/machine-auth";
import { pendingChanges, skillsDb } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = skillsDb();
  if (!db) return json({ ok: false, error: "storage_not_ready" }, 503);
  const auth = await authenticateComputer(req, db);
  if (!auth.ok) return auth.response;
  return json({ ok: true, changes: await pendingChanges(db, auth.computer.id) });
}
