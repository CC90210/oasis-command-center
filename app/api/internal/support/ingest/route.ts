/**
 * POST /api/internal/support/ingest - one email from support@, posted by the
 * reader on CC's PC (BEA scripts/support/). Authenticated by an HMAC inside
 * the handler, not by a session, so middleware.ts lists the
 * /api/internal/support/ prefix as public. Everything else, including every
 * status code and what is written, is in lib/delivery/email-intake.ts.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleSupportIngest } from "@/lib/delivery/email-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleSupportIngest(req, { db: getTursoClient(), env: process.env, now: new Date() });
  } catch (err) {
    // A 500 makes the reader keep the email and retry it. The claim makes the
    // retry finish what this attempt planned, never file it twice.
    console.error("[support.ingest] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "ingest_failed" }, { status: 500 });
  }
}
