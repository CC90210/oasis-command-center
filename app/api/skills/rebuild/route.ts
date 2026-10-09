/** POST /api/skills/rebuild - ask one of your computers to check in now (it polls about every 5 minutes). */
import { json, notFoundJson, readJsonObject } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { requestRebuild } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const b = await readJsonObject(req, 2_000);
  if (typeof b?.computer_id !== "string") return json({ ok: false, error: "bad_request" }, 400);
  return (await requestRebuild(gate.db, gate.viewer.userId, b.computer_id)) ? json({ ok: true }) : notFoundJson();
}
