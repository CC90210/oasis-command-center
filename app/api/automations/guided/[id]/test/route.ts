/**
 * POST /api/automations/guided/[id]/test
 *
 * "Test now": one preview run. It reads exactly what the live run would read and writes the run's
 * receipt, but it never sends, posts, charges or files an approval: a draft comes back as "would
 * draft" with its text. Capped per person per hour because each test calls the workspace AI account.
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { testAutomation } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A test can take as long as the template's time limit (at most 300 seconds).
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return guidedRoute(req, { write: true, id }, (s) => testAutomation(s, id));
}
