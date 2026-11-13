/**
 * POST /api/internal/tools/scan-pages - a real browser's read of a site the Worker was turned away from.
 *
 * Called by the tool runner with an HMAC over "<timestamp>.<raw body>" (lib/tools/runner-auth.ts),
 * never with a session: middleware lets /api/internal/tools/* through and the handler
 * authenticates first. The work is lib/tools/runner-handlers.ts handleToolsScanPages.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleToolsScanPages } from "@/lib/tools/runner-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleToolsScanPages(req, { db: getTursoClient(), env: process.env, now: new Date(), storage: null });
  } catch (err) {
    console.error("[tools.scan-pages] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "scan_pages_failed" }, { status: 500 });
  }
}
