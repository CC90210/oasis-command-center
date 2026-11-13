/**
 * POST /api/internal/tools/progress - live lines from a running job (the free scan's matching:
 * category, location, each competitor and prospect as it is found).
 *
 * Called by the tool runner with an HMAC over "<timestamp>.<raw body>" (lib/tools/runner-auth.ts),
 * never with a session: middleware lets /api/internal/tools/* through and the handler
 * authenticates first. The work is lib/tools/runner-handlers.ts handleToolsProgress.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleToolsProgress } from "@/lib/tools/runner-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleToolsProgress(req, { db: getTursoClient(), env: process.env, now: new Date(), storage: null });
  } catch (err) {
    console.error("[tools.progress] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "progress_failed" }, { status: 500 });
  }
}
