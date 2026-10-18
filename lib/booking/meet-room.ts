import "server-only";

import type { Client } from "@libsql/client";
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

export function liveBookingMeetRooms(db: Client): BookingMeetRooms {
  const meetDeps = liveMeetDeps();
  return {
    ready: () => meetMediaReady(meetDeps),
    create: async (input) => {
      const room = await createMeetRoom(db, {
        tenantId: input.tenantId,
        hostUserId: input.hostUserId,
        leadId: input.leadId,
        startsAt: input.startsAt,
        title: input.title,
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