/**
 * /api/cron/meet-relay - Oasis Meet's relay upkeep, without OASIS's PC
 * (lib/meet/recording.ts meetRelayCron): a recording the PC never took within
 * its 30 days is expired, and relay audio nobody needs any more (transcribed,
 * expired, deleted by its host, or its room gone) is deleted from R2, up to
 * RELAY_DELETE_BATCH objects per run.
 *
 * Why it exists (Codex on #685, P1): the PC's own claim also does this, but a
 * host's Delete must finish, and a 30-day limit must hold, while that PC is off.
 *
 * Guarded by lib/cron-auth.ts (CRON_SECRET bearer + platform proof). SCHEDULED
 * every 5 minutes, in all three places a cron schedule lives:
 * config/cron-registry.json, workers/oasis-cc-cron/src/index.ts, and the
 * 5-minute group in .github/workflows/cron-driver.yml
 * (tests/cron-driver-coverage.test.ts holds them together). The answer carries
 * counts and stable codes only: no ids, no paths.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { meetRecordingTablesInstalled, meetRelayCron, r2MeetStorage } from "@/lib/meet/recording";
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
    const db = getTursoClient();
    // Migration bravo__231 not applied yet: nothing to keep, and not a failure.
    if (!(await meetRecordingTablesInstalled(db))) return NextResponse.json({ ok: true, skipped: "not_installed" });
    const storage = r2MeetStorage();
    const result = await meetRelayCron(db, storage, new Date());
    return NextResponse.json({ ok: true, storage: storage ? "r2" : "not_configured", ...result });
  } catch (err) {
    console.error("[cron.meet-relay]", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "meet_relay_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
