/**
 * Every guided-automation request, in ONE route module:
 *
 *   GET    /api/automations/guided                       the workspace's guided automations (status, next runs, last run)
 *   POST   /api/automations/guided                       save a NEW one, always paused
 *   GET    /api/automations/guided/context               what the builder needs: departments, the AI account, connections
 *   PATCH  /api/automations/guided/<id>                  change one; a turned-on one is switched off until tested again
 *   DELETE /api/automations/guided/<id>                  delete one (its past runs and receipts stay)
 *   POST   /api/automations/guided/<id>/test             Test now: one preview run that sends, posts and files nothing
 *   POST   /api/automations/guided/<id>/activate         Turn on, after the same checks every scheduled run makes
 *   POST   /api/automations/guided/<id>/pause            switch it off (anyone who manages the workspace may)
 *   GET    /api/automations/guided/<id>/runs             its last runs, newest first
 *   GET    /api/automations/guided/<id>/runs/<runId>     one run's receipt
 *
 * One module, not nine: each Next route compiles to its own server bundle (about 75 KiB each here), and
 * the Worker is near Cloudflare's size limit. What is allowed is decided in lib/automations/guided-service.ts;
 * the edges every request shares (same-origin writes, the session gate, the body cap, the id shape) are in
 * lib/automations/guided-http.ts. An unknown path or method is a 404, said the same way.
 */
import { NextResponse } from "next/server";
import { guidedRoute, isGuidedId } from "@/lib/automations/guided-http";
import {
  activateAutomation,
  createAutomation,
  getContext,
  getRunReceipt,
  listAutomations,
  listRunHistory,
  pauseAutomation,
  removeAutomation,
  testAutomation,
  updateAutomation,
} from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A test can take as long as the template's time limit (at most 300 seconds).
export const maxDuration = 300;

type Ctx = { params: Promise<{ path?: string[] }> };

const segments = async (ctx: Ctx): Promise<string[]> => (await ctx.params).path ?? [];

const notFound = (message = "We could not find that automation.") =>
  NextResponse.json({ ok: false, error: "not_found", message }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(req: Request, ctx: Ctx) {
  const p = await segments(ctx);
  if (p.length === 0) return guidedRoute(req, { write: false }, (s) => listAutomations(s));
  if (p.length === 1 && p[0] === "context") return guidedRoute(req, { write: false }, (s) => getContext(s));
  if (p.length === 2 && p[1] === "runs") return guidedRoute(req, { write: false, id: p[0] }, (s) => listRunHistory(s, p[0]));
  if (p.length === 3 && p[1] === "runs") {
    if (!isGuidedId(p[2])) return notFound("We could not find that run.");
    return guidedRoute(req, { write: false, id: p[0] }, (s) => getRunReceipt(s, p[0], p[2]));
  }
  return notFound();
}

export async function POST(req: Request, ctx: Ctx) {
  const p = await segments(ctx);
  if (p.length === 0) {
    return guidedRoute(req, { write: true, body: true }, (s, body) => createAutomation(s, { name: body.name, payload: body.payload }));
  }
  if (p.length === 2) {
    const id = p[0];
    if (p[1] === "test") return guidedRoute(req, { write: true, id }, (s) => testAutomation(s, id));
    if (p[1] === "activate") return guidedRoute(req, { write: true, id }, (s) => activateAutomation(s, id));
    if (p[1] === "pause") return guidedRoute(req, { write: true, id }, (s) => pauseAutomation(s, id));
  }
  return notFound();
}

export async function PATCH(req: Request, ctx: Ctx) {
  const p = await segments(ctx);
  if (p.length !== 1) return notFound();
  const id = p[0];
  return guidedRoute(req, { write: true, id, body: true }, (s, body) => updateAutomation(s, id, { name: body.name, payload: body.payload }));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const p = await segments(ctx);
  if (p.length !== 1) return notFound();
  const id = p[0];
  return guidedRoute(req, { write: true, id }, (s) => removeAutomation(s, id));
}
