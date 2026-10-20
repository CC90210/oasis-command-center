/**
 * lib/meet/live-deps.ts - the real dependencies Oasis Meet's routes run with: the Turso client, the Cloudflare
 * Realtime app, the signed-in session, TURN credentials, the Schedule, the recording (./recording-deps.ts, on e9's
 * lib/meet/recording.ts) and the clock. Kept apart from ./handlers.ts so the tests can run every handler without
 * the session machinery.
 */
import "server-only";
import type { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { keepAlive } from "@/lib/os/runs/keepalive";
import { getTursoClient } from "@/lib/turso";
import type { MeetDeps } from "./handlers";
import { meetFailure } from "./http";
import { meetIceServers } from "./ice";
import { r2MeetStorage } from "./recording";
import { meetRecordingDeps } from "./recording-deps";
import { addMeetingToSchedule, removeMeetingFromSchedule } from "./schedule";
import { sfuClient } from "./sfu";

export function liveMeetDeps(): MeetDeps {
  const db = getTursoClient();
  return {
    db,
    sfu: () => sfuClient(),
    session: async () => {
      const s = await resolveSessionContext();
      return s.ok ? { ok: true, tenantId: s.tenantId, userId: s.userId, isTrueAdmin: s.isTrueAdmin, email: s.email } : { ok: false };
    },
    ice: () => meetIceServers(),
    schedule: (owner, room, opts) => addMeetingToSchedule(owner, room, opts),
    unschedule: (owner, eventId) => removeMeetingFromSchedule(owner, eventId),
    recording: meetRecordingDeps(db, r2MeetStorage),
    // Awaited by the routes: keepAlive resolves once ctx.waitUntil holds the work, before the answer goes.
    later: async (label, work) => {
      await keepAlive(work(), `meet.${label}`);
    },
    now: () => new Date(),
  };
}

/**
 * Run a room route with the live dependencies. Building them can throw (the
 * database client is made here, and getTursoClient throws where Turso is not
 * configured), and out in the route file that was an unhandled 500 with no body
 * and no log of its own, on a route a guest with no account hits. It is answered
 * here as a handler answers any failure (meetFailure): logged under the route's
 * name, one stable JSON answer.
 */
export async function withLiveMeetDeps(
  where: string,
  run: (deps: MeetDeps) => Promise<NextResponse>,
): Promise<NextResponse> {
  let deps: MeetDeps;
  try {
    deps = liveMeetDeps();
  } catch (err) {
    return meetFailure(err, where);
  }
  return run(deps);
}
