/**
 * GET /api/automations/guided/[id]/runs
 *
 * The last runs of one automation, newest first: scheduled runs and tests alike, each with one plain
 * sentence. Read-only. Anyone who may see the automation may read this (its owner, or a manager with
 * the department's own access), and nobody else: lib/automations/guided-service.ts decides.
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { listRunHistory } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guidedRoute(req, { write: false, id }, (s) => listRunHistory(s, id));
}
