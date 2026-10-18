import "server-only";

import type { Client } from "@libsql/client";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { meetGuestFirstName } from "@/lib/meet/guest-name";
import { deleteMeetRoom, meetMediaReady } from "@/lib/meet/handlers";
import { meetRoomUrl } from "@/lib/meet/links";
import { liveMeetDeps } from "@/lib/meet/live-deps";
import {
  createMeetRoom,
  parseMeetCode,
  readMeetRoom,
  rescheduleMeetRoom,
} from "@/lib/meet/rooms";

export type BookingMeetRooms = {
  ready(): boolean;
  /** `recorded`: the room records the call (meet_rooms.record_audio), so the invite carries the recording notice. */
  create(input: {
    tenantId: string;
    hostUserId: string;
    leadId: string | null;
    startsAt: string;
    title: string;
  }): Promise<{ id: string; url: string; recorded: boolean }>;
  find(
    tenantId: string,
    roomId: string,
  ): Promise<{ id: string; url: string; status: string; recorded: boolean } | null>;
  reschedule(tenantId: string, roomId: string, startsAt: string): Promise<boolean>;
  remove(tenantId: string, roomId: string, actorUserId: string | null): Promise<void>;
};

/** No cut here: createMeetRoom keeps a title by characters (meetTitle), and a cut by UTF-16 units could split one. */
export function bookingMeetRoomTitle(firstName: string | null, fallback: string): string {
  return firstName ? `OASIS call with ${firstName}` : fallback;
}

/**
 * The founder-meeting service's room dependency for a route: the live port when appointments live on Turso (the
 * same test as getServiceSupabase), nothing otherwise. Without the port a booking takes the Google Meet path, which
 * needs no Turso. Turso configured is not enough: on a Supabase rollback the appointments have no meet_room_id
 * column (Codex on the booking PR).
 */
export function bookingMeetRoomDeps(): { meetRooms?: BookingMeetRooms } {
  return process.env.EMPIRE_DATA_BACKEND === "turso_cloud" && tursoConfigured()
    ? { meetRooms: liveBookingMeetRooms(getTursoClient()) }
    : {};
}

/**
 * Does this booked call's link open an Oasis Meet room of this workspace that records? Read from the room itself
 * (meet_rooms.record_audio), so a confirmation shows the recording notice (lib/meet/recording-notice.ts) exactly when
 * the room page will ask for consent. False for a Google Meet link, another workspace's room, no room port (off the
 * Turso data plane), or a read that fails: the notice is left off rather than promised.
 */
export async function bookingCallRecorded(tenantId: string, meetUrl: string | null | undefined): Promise<boolean> {
  if (!bookingMeetRoomDeps().meetRooms) return false;
  return meetLinkRecords(getTursoClient(), tenantId, meetUrl);
}

/**
 * The read behind bookingCallRecorded, on a given client. The workspace is in the query itself (every Turso query
 * names its tenant), so another workspace's room is never read at all (Codex on the booking agent PR).
 */
export async function meetLinkRecords(db: Client, tenantId: string, meetUrl: string | null | undefined): Promise<boolean> {
  let code: string | null = null;
  try {
    const parts = new URL(String(meetUrl || "")).pathname.split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] === "meet") code = parseMeetCode(parts[1]);
  } catch {
    return false;
  }
  if (!code) return false;
  try {
    const rs = await db.execute({
      sql: "SELECT record_audio FROM meet_rooms WHERE tenant_id = ? AND code = ? LIMIT 1",
      args: [tenantId, code],
    });
    return Number(rs.rows[0]?.record_audio) === 1;
  } catch (error) {
    console.error("[booking.call-recorded] room read failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function liveBookingMeetRooms(db: Client): BookingMeetRooms {
  const meetDeps = liveMeetDeps();
  return {
    ready: () => meetMediaReady(meetDeps),
    create: async (input) => {
      // The title names the lead as the room page's prefill does (one rule, so they never disagree); the booking's
      // own title is the fallback for a lead record with no name.
      const firstName = input.leadId ? await meetGuestFirstName(db, { tenantId: input.tenantId, leadId: input.leadId }) : null;
      const room = await createMeetRoom(db, {
        tenantId: input.tenantId,
        hostUserId: input.hostUserId,
        leadId: input.leadId,
        startsAt: input.startsAt,
        title: bookingMeetRoomTitle(firstName, input.title),
        calendarEventId: null,
        recordAudio: await meetDeps.recording.available(input.tenantId),
      });
      return { id: room.id, url: meetRoomUrl(room), recorded: room.recordAudio };
    },
    find: async (tenantId, roomId) => {
      const room = await readMeetRoom(db, { tenantId, roomId });
      return room ? { id: room.id, url: meetRoomUrl(room), status: room.status, recorded: room.recordAudio } : null;
    },
    reschedule: (tenantId, roomId, startsAt) =>
      rescheduleMeetRoom(db, { tenantId, id: roomId }, startsAt),
    remove: async (tenantId, roomId, actorUserId) => {
      const room = await readMeetRoom(db, { tenantId, roomId });
      if (!room) return;
      await deleteMeetRoom(meetDeps, room, actorUserId || room.hostUserId, meetDeps.now());
    },
  };
}