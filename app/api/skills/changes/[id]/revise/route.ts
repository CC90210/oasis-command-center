/** POST /api/skills/changes/{id}/revise - edit a HELD change: reject it on that computer and queue the edited ops, in one step. */
import { json, notFoundJson, readJsonObject } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { parseNewChange } from "@/lib/skills/contract";
import { revise } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIELDS = ["computer_id", "description", "ops"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const b = await readJsonObject(req, 64_000);
  if (!b || typeof b.computer_id !== "string" || Object.keys(b).some((k) => !FIELDS.includes(k))) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const parsed = parseNewChange({ description: b.description, scope: b.computer_id, ops: b.ops });
  if (!parsed.ok) return json({ ok: false, error: "bad_request", message: parsed.error }, 400);
  const out = await revise(gate.db, gate.viewer.userId, gate.viewer.actor, id, b.computer_id, { description: parsed.value.description, ops: parsed.value.ops });
  if (!out.ok && out.error === "not_found") return notFoundJson();
  if (!out.ok) return json({ ok: false, error: "not_held", message: "This change is no longer held. Refresh to see where it is now." }, 409);
  return json({ ok: true, id: out.id }, 201);
}
