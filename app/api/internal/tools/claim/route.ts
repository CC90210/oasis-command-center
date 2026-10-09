/**
 * POST /api/internal/tools/claim - the runner checks in and takes the oldest job of OASIS's own workspaces, with a lease.
 *
 * Called by the tool runner on OASIS's PC with an HMAC over "<timestamp>.<raw
 * body>" (lib/tools/runner-auth.ts), never with a session: middleware lets
 * /api/internal/tools/* through and the handler authenticates first. The work
 * is lib/tools/runner-handlers.ts handleToolsClaim.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleToolsClaim, r2ToolStorage } from "@/lib/tools/runner-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleToolsClaim(req, { db: getTursoClient(), env: process.env, now: new Date(), storage: await r2ToolStorage() });
  } catch (err) {
    console.error("[tools.claim] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "claim_failed" }, { status: 500 });
  }
}
