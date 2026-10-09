/** POST /api/skills/checkin/skills - a computer replaces its skill list (allowlisted fields only). */
import { json } from "@/lib/playbook/http";
import { parseSkillsPush } from "@/lib/skills/contract";
import { authenticateComputer, readBoundedJson } from "@/lib/skills/machine-auth";
import { skillsDb, storeSkills } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = skillsDb();
  if (!db) return json({ ok: false, error: "storage_not_ready" }, 503);
  const auth = await authenticateComputer(req, db);
  if (!auth.ok) return auth.response;
  const body = await readBoundedJson(req);
  if (!body.ok) return body.response;
  const push = parseSkillsPush(body.body);
  if (!push.ok) return json({ ok: false, error: "bad_request", message: push.error }, 400);
  return json({ ok: true, stored: await storeSkills(db, auth.computer.id, push.value) });
}
