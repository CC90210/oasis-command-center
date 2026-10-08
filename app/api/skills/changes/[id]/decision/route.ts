/** POST /api/skills/changes/{id}/decision - accept anyway or reject a HELD change on one of your computers. */
import { json, notFoundJson, readJsonObject } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { DECISIONS } from "@/lib/skills/contract";
import { decide } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const b = await readJsonObject(req, 2_000);
  const decision = DECISIONS.find((d) => d === b?.decision);
  if (!decision || typeof b?.computer_id !== "string") return json({ ok: false, error: "bad_request" }, 400);
  const out = await decide(gate.db, gate.viewer.userId, gate.viewer.actor, id, b.computer_id, decision);
  if (out === "not_found") return notFoundJson();
  if (out === "not_held") return json({ ok: false, error: "not_held", message: "Only a held change can be accepted or rejected." }, 409);
  return json({ ok: true });
}
