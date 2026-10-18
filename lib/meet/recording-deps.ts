/**
 * lib/meet/recording-deps.ts - the recording side of Oasis Meet's routes (MeetDeps["recording"]), on e9's
 * lib/meet/recording.ts: whether a workspace's meetings record, and deleting a meeting's recording. Kept apart from
 * ./live-deps.ts, which carries the session machinery, so tests/meet-delete.test.ts runs exactly this wiring
 * against the real tables.
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { MeetDeps } from "./handlers";
import { deleteMeetRecording, meetRecordingServed, meetRecordingTablesInstalled, type MeetStorage } from "./recording";

export function meetRecordingDeps(db: Client, storage: () => MeetStorage | null): MeetDeps["recording"] {
  return {
    // Until migration bravo__231 is applied the recording routes answer 503: offering to record would be a lie.
    available: async (tenantId) => meetRecordingServed(tenantId) && (await meetRecordingTablesInstalled(db)),
    served: meetRecordingServed,
    remove: async (room, userId, now) => {
      if (!(await meetRecordingTablesInstalled(db))) return null;
      const out = await deleteMeetRecording(db, storage(), room, userId, now);
      return { relayRemaining: out.relayRemaining };
    },
  };
}
