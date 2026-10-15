/**
 * GET /api/automations/guided/[id]/runs/[runId]
 *
 * One run's receipt: what it looked up, what it wrote, and why it stopped if it did. Everything in it
 * is redacted before it leaves the server. Read-only, and tied to the automation in the path: a run id
 * of another automation (or workspace) is "not found", said the same way.
 */
import { NextResponse } from "next/server";
import { guidedRoute, isGuidedId } from "@/lib/automations/guided-http";
import { getRunReceipt } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await ctx.params;
  if (!isGuidedId(runId)) {
    return NextResponse.json({ ok: false, error: "not_found", message: "We could not find that run." }, { status: 404 });
  }
  return guidedRoute(req, { write: false, id }, (s) => getRunReceipt(s, id, runId));
}
