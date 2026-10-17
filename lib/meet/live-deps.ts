/**
 * lib/meet/live-deps.ts - the real dependencies Oasis Meet's routes run with: the Turso client, the Cloudflare
 * Realtime app, the signed-in session, TURN credentials and the clock. Kept apart from ./handlers.ts so the
 * tests can run every handler without the session machinery.
 */
import "server-only";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient } from "@/lib/turso";
import type { MeetDeps } from "./handlers";
import { meetIceServers } from "./ice";
import { addMeetingToSchedule } from "./schedule";
import { sfuClient } from "./sfu";

export function liveMeetDeps(): MeetDeps {
  return {
    db: getTursoClient(),
    sfu: () => sfuClient(),
    session: async () => {
      const s = await resolveSessionContext();
      return s.ok ? { ok: true, tenantId: s.tenantId, userId: s.userId, isTrueAdmin: s.isTrueAdmin, email: s.email } : { ok: false };
    },
    ice: () => meetIceServers(),
    schedule: (owner, room, opts) => addMeetingToSchedule(owner, room, opts),
    now: () => new Date(),
  };
}
