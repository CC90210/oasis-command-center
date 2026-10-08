/** POST /api/skills/computers/{id}/key - issue a new key (after a revoke, or a lost key); shown once. */
import { json, notFoundJson } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { issueKey } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSkillsAdmin(req, true);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const key = await issueKey(gate.db, gate.viewer.userId, id);
  return key ? json({ ok: true, id, key }) : notFoundJson();
}
