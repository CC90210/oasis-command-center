/**
 * GET  /api/automations/guided   the workspace's guided automations, with status, next runs and last run.
 * POST /api/automations/guided   save a NEW guided automation, always paused.
 *
 * Who may and what is checked: lib/automations/guided-service.ts. Nothing here reads a tenant or a user
 * from the request.
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { createAutomation, listAutomations } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return guidedRoute(req, { write: false }, (s) => listAutomations(s));
}

export async function POST(req: Request) {
  return guidedRoute(req, { write: true, body: true }, (s, body) => createAutomation(s, { name: body.name, payload: body.payload }));
}
