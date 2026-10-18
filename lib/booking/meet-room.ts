import "server-only";

import type { Client } from "@libsql/client";
import { meetGuestFirstName } from "@/lib/meet/guest-name";
import { deleteMeetRoom, meetMediaReady } from "@/lib/meet/handlers";
import { meetRoomUrl } from "@/lib/meet/links";
import { liveMeetDeps } from "@/lib/meet/live-deps";
import {
  createMeetRoom,
  readMeetRoom,
  rescheduleMeetRoom,
} from "@/lib/meet/rooms";

export type BookingMeetRooms = {
  ready(): boolean;
  create(input: {
    tenantId: string;
    hostUserId: string;
    leadId: string | null;
    startsAt: string;
    title: string;
  }): Promise<{ id: string; url: string }>;
  find(
    tenantId: string,
    roomId: string,
  ): Promise<{ id: string; url: string; status: string } | null>;
  reschedule(tenantId: string, roomId: string, startsAt: string): Promise<boolean>;
  remove(tenantId: string, roomId: string, actorUserId: string | null): Promise<void>;
};

/** No cut here: createMeetRoom keeps a title by characters (meetTitle), and a cut by UTF-16 units could split one. */
export function bookingMeetRoomTitle(firstName: string | null, fallback: string): string {
  return firstName ? `OASIS call with ${firstName}` : fallback;
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
      return { id: room.id, url: meetRoomUrl(room) };
    },
    find: async (tenantId, roomId) => {
      const room = await readMeetRoom(db, { tenantId, roomId });
      return room ? { id: room.id, url: meetRoomUrl(room), status: room.status } : null;
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