/**
 * lib/meet/live-deps.ts - the real dependencies Oasis Meet's routes run with: the Turso client, the Cloudflare
 * Realtime app, the signed-in session, TURN credentials, the Schedule, the recording (lib/meet/recording.ts, e9)
 * and the clock. Kept apart from ./handlers.ts so the tests can run every handler without the session machinery.
 */
import "server-only";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient } from "@/lib/turso";
import type { MeetDeps } from "./handlers";
import { meetIceServers } from "./ice";
import { deleteMeetRecording, meetRecordingServed, meetRecordingTablesInstalled, r2MeetStorage } from "./recording";
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
    recording: {
      // Until migration bravo__231 is applied the recording routes answer 503: offering to record would be a lie.
      available: async (tenantId) => meetRecordingServed(tenantId) && (await meetRecordingTablesInstalled(db)),
      served: (tenantId) => meetRecordingServed(tenantId),
      remove: async (room, userId, now) => {
        if (!(await meetRecordingTablesInstalled(db))) return null;
        const out = await deleteMeetRecording(db, r2MeetStorage(), room, userId, now);
        return { relayRemaining: out.relayRemaining };
      },
    },
    now: () => new Date(),
  };
}
