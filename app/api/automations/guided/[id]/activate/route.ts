/**
 * POST /api/automations/guided/[id]/activate
 *
 * "Turn on". Revalidated on the server with the exact check every scheduled run makes (the owner's
 * seat, the department, the connections, the lookups, the workspace AI account), then switched on in
 * one audited transaction. A refusal says what is missing and links the fix.
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { activateAutomation } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guidedRoute(req, { write: true, id }, (s) => activateAutomation(s, id));
}
