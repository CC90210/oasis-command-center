/** POST /api/skills/changes - queue a label change; it is checked on the computer's next check-in. */
import { json, readJsonObject } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { parseNewChange } from "@/lib/skills/contract";
import { createChange } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const parsed = parseNewChange(await readJsonObject(req, 50_000));
  if (!parsed.ok) return json({ ok: false, error: "bad_request", message: parsed.error }, 400);
  const out = await createChange(gate.db, gate.viewer.userId, gate.viewer.actor, parsed.value);
  if (!out.ok) return json({ ok: false, error: out.error, message: "Only the main computer's owner changes the shared labels; a computer's own changes need its owner." }, 403);
  return json({ ok: true, id: out.id }, 201);
}
