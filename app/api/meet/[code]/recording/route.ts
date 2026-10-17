/**
 * GET    /api/meet/<code>/recording - the meeting's recording as its panel shows it: the state and the transcript.
 * DELETE /api/meet/<code>/recording - delete the recording and the transcript, here and on OASIS's PC.
 *
 * Host only (the DELETE same-origin only). The work is
 * lib/meet/recording-routes.ts handleMeetRecordingGet / handleMeetRecordingDelete.
 */
import { r2MeetStorage } from "@/lib/meet/recording";
import { handleMeetRecordingDelete, handleMeetRecordingGet } from "@/lib/meet/recording-routes";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

const notConfigured = () => Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  if (!tursoConfigured()) return notConfigured();
  try {
    const { code } = await ctx.params;
    return await handleMeetRecordingGet(req, code, { db: getTursoClient(), storage: r2MeetStorage(), now: () => new Date() });
  } catch (err) {
    console.error("[meet.recording.get] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "recording_read_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  if (!tursoConfigured()) return notConfigured();
  try {
    const { code } = await ctx.params;
    return await handleMeetRecordingDelete(req, code, { db: getTursoClient(), storage: r2MeetStorage(), now: () => new Date() });
  } catch (err) {
    console.error("[meet.recording.delete] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "recording_delete_failed" }, { status: 500 });
  }
}
