/**
 * POST /api/internal/support/draft - the reader files one reply draft (it
 * becomes ONE reply_ticket approval in Client Success) or reports that it could
 * not write one (the ticket then says "reply by hand"). Nothing is sent from
 * here. HMAC-authenticated inside the handler; see lib/delivery/support-drafts.ts.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleSupportDraft } from "@/lib/delivery/support-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleSupportDraft(req, { db: getTursoClient(), env: process.env, now: new Date() });
  } catch (err) {
    console.error("[support.draft] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "draft_route_failed" }, { status: 500 });
  }
}
