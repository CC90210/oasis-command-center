/**
 * POST /api/internal/tools/download-urls - signed GET URLs for a claimed meeting transcription's audio chunks.
 *
 * Called by Oasis Meet's runner on OASIS's PC (BEA scripts/meet/runner.py) with
 * an HMAC over "<timestamp>.<raw body>" (lib/tools/runner-auth.ts), never with a
 * session: middleware lets /api/internal/tools/* through and the handler
 * authenticates first. The work is lib/tools/runner-handlers.ts
 * handleToolsDownloadUrls.
 */
import { r2MeetStorage } from "@/lib/meet/recording";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleToolsDownloadUrls } from "@/lib/tools/runner-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleToolsDownloadUrls(req, {
      db: getTursoClient(),
      env: process.env,
      now: new Date(),
      storage: null,
      meetStorage: r2MeetStorage(),
    });
  } catch (err) {
    console.error("[tools.download-urls] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "download_urls_failed" }, { status: 500 });
  }
}
