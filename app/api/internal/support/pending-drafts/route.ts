/**
 * POST /api/internal/support/pending-drafts — the emails on support@ tickets
 * that want a reply draft, with what the reader needs to write one. Read only.
 * HMAC-authenticated inside the handler; see lib/delivery/support-drafts.ts.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handlePendingDrafts } from "@/lib/delivery/support-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handlePendingDrafts(req, { db: getTursoClient(), env: process.env, now: new Date() });
  } catch (err) {
    console.error("[support.pending_drafts] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "pending_drafts_failed" }, { status: 500 });
  }
}
