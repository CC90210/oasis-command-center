/** POST /api/skills/computers - register a computer; the key is shown ONCE (only its hash is kept). */
import { json, readJsonObject } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { createComputer } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const body = await readJsonObject(req, 10_000);
  const name = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  if (!name || name.length > 80) return json({ ok: false, error: "display_name must be 1 to 80 characters" }, 400);
  return json({ ok: true, ...(await createComputer(gate.db, gate.viewer.userId, name)) }, 201);
}
