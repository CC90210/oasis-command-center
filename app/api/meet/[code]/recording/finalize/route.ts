/**
 * POST /api/meet/<code>/recording/finalize - hand an ended meeting's recording to OASIS's PC, or retry a failed one.
 *
 * The recording browser calls it right after End, with its recorder's report;
 * the panel's Try again calls it too. Host only, same-origin only. The work is
 * lib/meet/recording-routes.ts handleMeetFinalize.
 */
import { r2MeetStorage } from "@/lib/meet/recording";
import { handleMeetFinalize } from "@/lib/meet/recording-routes";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  if (!tursoConfigured()) return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  try {
    const { code } = await ctx.params;
    return await handleMeetFinalize(req, code, { db: getTursoClient(), storage: r2MeetStorage(), now: () => new Date() });
  } catch (err) {
    console.error("[meet.recording.finalize] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "finalize_failed" }, { status: 500 });
  }
}
