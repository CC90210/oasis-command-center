/** GET /api/skills/overview - your computers and their changes; never another owner's. */
import { json } from "@/lib/playbook/http";
import { requireSkillsAdmin } from "@/lib/skills/admin";
import { overview } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSkillsAdmin(null, false);
  if (!gate.ok) return gate.response;
  return json({ ok: true, ...(await overview(gate.db, gate.viewer.userId)) });
}
