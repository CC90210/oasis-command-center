/**
 * app/meet/[code]/load.ts - what the room page needs from the link, the database and the session, as a plain
 * function so tests/meet-ui.test.ts can run it against a real libSQL file. The page (./page.tsx) only turns the
 * answer into notFound(), redirect() or a screen.
 *
 *   not_found  the link is not a meeting code, or no such room (a signed-in person from another workspace is
 *              never told a room exists: they read it exactly as a visitor does)
 *   redirect   the code is right but not written the way the participant cookie's path is, "abc-defg-hjk"
 *   ended      the meeting is over: one plain page, no title
 *   room       what the client component needs, and nothing more: never the workspace or the host, and of a lead only
 *              a booked lead's first name, for the name field (anyone who holds the link sees this page)
 */
import type { Client } from "@libsql/client";
import type { MeetViewer } from "@/components/meet/notice";
import { meetRoleFor, type MeetSession } from "@/lib/meet/access";
import { meetGuestFirstName } from "@/lib/meet/guest-name";
import { displayMeetCode, parseMeetCode, readMeetRoomByCode, type MeetRoom, type MeetRoomStatus } from "@/lib/meet/rooms";

type SessionLike = MeetSession;

/** Signed out, or not known: the lookup failed, so this may be a host whose session the join then finds. */
export type PageSession = SessionLike | { ok: false; lookupFailed: true };

/**
 * The signed-in person, or a visitor. The page is public, so a storage outage while looking the session up reads
 * as signed out (and is logged): the host then sees the visitor view, and the join call checks the session again.
 * It says the lookup failed, so the page never fills a booked lead's name in for someone it could not identify.
 */
export async function sessionOrVisitor(
  resolve: () => Promise<SessionLike>,
  log: (message: string, err: unknown) => void = (message, err) => console.error(message, err),
): Promise<PageSession> {
  try {
    return await resolve();
  } catch (err) {
    log("[meet.page] the session lookup failed; showing the visitor view", err);
    return { ok: false, lookupFailed: true };
  }
}

/**
 * The props of components/meet/MeetRoom.tsx that come from the room. `viewer` decides the name field and the host
 * controls; `creator` decides the recording notice (Quebec Law 25), which is the room's creator's alone to skip.
 * `startsAt` is when a meeting made for a time is for (the page says when it starts, in the viewer's own time zone).
 * `guestName` is the first name of the lead who booked the room, for a visitor's name field to start with: a member
 * or a host uses their account, and a room no lead booked has none.
 */
export type MeetPageProps = {
  code: string;
  title: string;
  status: MeetRoomStatus;
  recordAudio: boolean;
  viewer: MeetViewer;
  creator: boolean;
  startsAt: string | null;
  guestName: string | null;
};

export type MeetPageData =
  | { kind: "not_found" }
  | { kind: "redirect"; to: string }
  | { kind: "ended"; viewer: MeetViewer }
  | { kind: "room"; props: MeetPageProps };

/**
 * The host (they made the room, or own or administer its workspace), a member (signed in to the room's workspace,
 * not its host) or a visitor (everyone else, including someone signed in to another workspace).
 */
export function meetViewerFor(session: SessionLike, room: Pick<MeetRoom, "tenantId" | "hostUserId">): MeetViewer {
  if (!session.ok) return "visitor";
  const role = meetRoleFor(session, room);
  return role === "host" ? "host" : role === "guest" ? "member" : "visitor";
}

/**
 * Did this person make the room? Signed in to the room's own workspace, with the user id that created it. Only
 * they run the recording and skip the recording notice; a second host (another owner or admin) is a host for the
 * controls but ticks the notice like everyone else. The same rule as the server's join (lib/meet/handlers.ts
 * handleJoin), and a user id alone is never enough: the same id signed in to ANOTHER workspace is not the creator.
 */
export function meetCreatorFor(session: SessionLike, room: Pick<MeetRoom, "tenantId" | "hostUserId">): boolean {
  return session.ok && session.tenantId === room.tenantId && session.userId === room.hostUserId;
}

export async function loadMeetPage(
  rawCode: string,
  deps: { db: () => Client; session: () => Promise<PageSession> },
): Promise<MeetPageData> {
  const code = parseMeetCode(rawCode);
  if (!code) return { kind: "not_found" };
  const dashed = displayMeetCode(code);
  // The participant cookie's Path is the dashed API path, so the page lives at the dashed address only.
  if (rawCode !== dashed) return { kind: "redirect", to: `/meet/${dashed}` };
  const db = deps.db();
  const room = await readMeetRoomByCode(db, code);
  if (!room) return { kind: "not_found" };
  const session = await deps.session();
  const viewer = meetViewerFor(session, room);
  if (room.status === "ended") return { kind: "ended", viewer };
  const creator = meetCreatorFor(session, room);
  // Only a visitor is the lead (or a stranger holding the link); anyone signed in to the workspace uses their account
  // name. One who is a visitor only because the session lookup failed may be a host whose session the join then
  // finds: handed the lead's name, they would join, and be transcribed, as the lead.
  const guestName = viewer === "visitor" && !("lookupFailed" in session) ? await meetGuestFirstName(db, room) : null;
  return {
    kind: "room",
    props: { code: dashed, title: room.title, status: room.status, recordAudio: room.recordAudio, viewer, creator, startsAt: room.startsAt, guestName },
  };
}
