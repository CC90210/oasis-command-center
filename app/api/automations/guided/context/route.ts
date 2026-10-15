/**
 * GET /api/automations/guided/context
 *
 * What the builder needs to know about this workspace and this person: the departments they may build
 * for, whether they may see company financials, whether Cloud can run right now, and the state of every
 * connection a template can need (each with its repair link). Read once when the builder opens.
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { getContext } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return guidedRoute(req, { write: false }, (s) => getContext(s));
}
