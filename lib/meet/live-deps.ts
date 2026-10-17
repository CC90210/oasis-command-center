/**
 * lib/meet/live-deps.ts - the real dependencies Oasis Meet's routes run with: the Turso client, the Cloudflare
 * Realtime app, the signed-in session, TURN credentials, the Schedule, the recording (./recording-deps.ts, on e9's
 * lib/meet/recording.ts) and the clock. Kept apart from ./handlers.ts so the tests can run every handler without
 * the session machinery.
 */
import "server-only";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient } from "@/lib/turso";
import type { MeetDeps } from "./handlers";
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
    now: () => new Date(),
  };
}
