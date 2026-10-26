/**
 * lib/meet/recording-deps.ts - the recording side of Oasis Meet's routes (MeetDeps["recording"]), on e9's
 * lib/meet/recording.ts: whether a workspace's meetings record, and deleting a meeting's recording. Kept apart from
 * ./live-deps.ts, which carries the session machinery, so tests/meet-delete.test.ts runs exactly this wiring
 * against the real tables.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { MeetNotConfiguredError } from "./access";
import type { MeetDeps } from "./handlers";
import { deleteMeetRecording, meetLocalCopiesInstalled, meetRecordingServed, meetRecordingTablesInstalled, type MeetStorage } from "./recording";

export function meetRecordingDeps(db: Client, storage: () => MeetStorage | null): MeetDeps["recording"] {
  return {
    // Until migration bravo__231 is applied the recording routes answer 503: offering to record would be a lie.
    available: async (tenantId) => meetRecordingServed(tenantId) && (await meetRecordingTablesInstalled(db)),
    served: meetRecordingServed,
    remove: async (room, userId, now) => {
      if (!(await meetRecordingTablesInstalled(db))) return null;
      // A recording is deleted from each computer that holds it through bravo__240's tables. Without them it cannot
      // be deleted whole, so it is not deleted at all: deleteMeetRoom keeps the meeting when this throws (503).
      if (!(await meetLocalCopiesInstalled(db))) {
        throw new MeetNotConfiguredError("migration bravo__240 is not applied, so a recording cannot be deleted from its computers");
      }
      const out = await deleteMeetRecording(db, storage(), room, userId, now);
      return { relayRemaining: out.relayRemaining };
    },
  };
}
