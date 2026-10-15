/**
 * POST /api/automations/guided/[id]/pause
 *
 * Switch an automation off. Anyone who manages the workspace may (the same rule as every scheduled
 * job: someone else may switch it off, never on). Audited.
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { pauseAutomation } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guidedRoute(req, { write: true, id }, (s) => pauseAutomation(s, id));
}
