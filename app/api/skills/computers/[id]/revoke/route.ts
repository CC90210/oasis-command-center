/** POST /api/skills/computers/{id}/revoke - the computer's key stops working at once. */
import { json, notFoundJson } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { revokeComputer } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  return (await revokeComputer(gate.db, gate.viewer.userId, id)) ? json({ ok: true }) : notFoundJson();
}
