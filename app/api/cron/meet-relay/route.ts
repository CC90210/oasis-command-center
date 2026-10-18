/**
 * /api/cron/meet-relay - Oasis Meet's relay upkeep, without OASIS's PC
 * (lib/meet/recording.ts meetRelayCron): a recording the PC never took within
 * its 30 days is expired, and relay audio nobody needs any more (transcribed,
 * expired, deleted by its host, or never handed over and quiet for 30 days) is
 * deleted from R2, up to RELAY_DELETE_BATCH objects per run. A call every tab
 * left without End is ended, and the media sessions ended rooms still hold are
 * cut, in every workspace.
 *
 * Why it exists (Codex on #685, P1): the PC's own claim also does this, but a
 * host's Delete must finish, and a 30-day limit must hold, while that PC is off.
 *
 * Guarded by lib/cron-auth.ts (CRON_SECRET bearer + platform proof). SCHEDULED
 * every 5 minutes, in all three places a cron schedule lives:
 * config/cron-registry.json, workers/oasis-cc-cron/src/index.ts, and the
 * 5-minute group in .github/workflows/cron-driver.yml
 * (tests/cron-driver-coverage.test.ts holds them together). The answer carries
 * counts and stable codes only: no ids, no paths. The work is
 * lib/meet/recording-routes.ts handleMeetRelayCron: a run with no relay storage,
 * a relay delete R2 refused, or an ended room's media session it could not cut
 * (the SFU refused, or no SFU app is set) answers 503, so the driver reports it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { meetSfuIfConfigured, r2MeetStorage } from "@/lib/meet/recording";
import { handleMeetRelayCron } from "@/lib/meet/recording-routes";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleMeetRelayCron({ db: getTursoClient(), storage: r2MeetStorage(), now: () => new Date(), sfu: meetSfuIfConfigured() });
  } catch (err) {
    console.error("[cron.meet-relay]", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "meet_relay_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
