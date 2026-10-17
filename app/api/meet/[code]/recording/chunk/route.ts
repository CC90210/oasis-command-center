/**
 * POST /api/meet/<code>/recording/chunk - one chunk of a speaker's voice from the host's recording browser.
 *
 * The body is the chunk's bytes; x-meet-participant, x-meet-segment, x-meet-seq
 * and x-meet-segment-started-at say whose and where (lib/meet/recorder.ts
 * uploadToRoom). Host only, same-origin only. The work is
 * lib/meet/recording-routes.ts handleMeetChunk.
 */
import { r2MeetStorage } from "@/lib/meet/recording";
import { handleMeetChunk } from "@/lib/meet/recording-routes";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  if (!tursoConfigured()) return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  try {
    const { code } = await ctx.params;
    return await handleMeetChunk(req, code, { db: getTursoClient(), storage: r2MeetStorage(), now: () => new Date() });
  } catch (err) {
    console.error("[meet.recording.chunk] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "chunk_failed" }, { status: 500 });
  }
}
