/**
 * lib/meet/links.ts - a meeting's link, the one way every place writes it: the Meet panel, the Schedule entry, and a
 * booking's invite, confirmation email and calendar file. From the app's canonical address, never the host a request
 * came in on (a preview deployment, say), so a link sent to a guest always opens the real room.
 */
import "server-only";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { displayMeetCode, type MeetRoom } from "./rooms";

/** The room's path: /meet/abc-defg-hjk. */
export function meetRoomPath(room: Pick<MeetRoom, "code">): string {
  return `/meet/${displayMeetCode(room.code)}`;
}

/** The whole link: https://oasisai.work/meet/abc-defg-hjk. `origin` is for tests; production uses the canonical one. */
export function meetRoomUrl(room: Pick<MeetRoom, "code">, origin: string = publicAppBaseUrl()): string {
  return `${origin.replace(/\/+$/, "")}${meetRoomPath(room)}`;
}
