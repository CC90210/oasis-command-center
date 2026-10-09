/**
 * GET /api/tools/jobs?tool=<key>&limit=5 or ?id=<job id> - the signed-in
 * person's workspace's recent tool runs, newest first, each with its status,
 * result and the plain line for a failure. The Tools section polls it while a
 * run is in flight.
 *
 * lib/tools/session-handlers.ts handleToolJobs does the work; anyone the gate
 * refuses gets 404, for every verb.
 */
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveToolsViewer } from "@/lib/tools/access";
import { r2ToolStorage } from "@/lib/tools/runner-handlers";
import { handleToolJobs } from "@/lib/tools/session-handlers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_set_up", message: "Tools are not set up yet." }, { status: 503 });
  }
  try {
    return await handleToolJobs(req, { db: getTursoClient(), now: () => new Date(), viewer: resolveToolsViewer, storage: r2ToolStorage });
  } catch (err) {
    console.error("[tools.jobs] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "jobs_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const POST = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
