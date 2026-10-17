/**
 * app/meet/[code]/load.ts - what the room page needs from the link, the database and the session, as a plain
 * function so tests/meet-ui.test.ts can run it against a real libSQL file. The page (./page.tsx) only turns the
 * answer into notFound(), redirect() or a screen.
 *
 *   not_found  the link is not a meeting code, or no such room (a signed-in person from another workspace is
 *              never told a room exists: they read it exactly as a visitor does)
 *   redirect   the code is right but not written the way the participant cookie's path is, "abc-defg-hjk"
 *   ended      the meeting is over: one plain page, no title
 *   room       what the client component needs, and nothing more: never the workspace, the host or a lead
 */
import type { Client } from "@libsql/client";
import type { MeetViewer } from "@/components/meet/notice";
import { meetRoleFor, type MeetSession } from "@/lib/meet/access";
import { displayMeetCode, parseMeetCode, readMeetRoomByCode, type MeetRoom, type MeetRoomStatus } from "@/lib/meet/rooms";

type SessionLike = MeetSession;

/**
 * The signed-in person, or a visitor. The page is public, so a storage outage while looking the session up reads
 * as signed out (and is logged): the host then sees the visitor view, and the join call checks the session again.
 */
export async function sessionOrVisitor(
  resolve: () => Promise<SessionLike>,
  log: (message: string, err: unknown) => void = (message, err) => console.error(message, err),
): Promise<SessionLike> {
  try {
    return await resolve();
  } catch (err) {
    log("[meet.page] the session lookup failed; showing the visitor view", err);
    return { ok: false };
  }
}

/** The props of components/meet/MeetRoom.tsx that come from the room. */
export type MeetPageProps = { code: string; title: string; status: MeetRoomStatus; recordAudio: boolean; viewer: MeetViewer };

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

export async function loadMeetPage(
  rawCode: string,
  deps: { db: () => Client; session: () => Promise<SessionLike> },
): Promise<MeetPageData> {
  const code = parseMeetCode(rawCode);
  if (!code) return { kind: "not_found" };
  const dashed = displayMeetCode(code);
  // The participant cookie's Path is the dashed API path, so the page lives at the dashed address only.
  if (rawCode !== dashed) return { kind: "redirect", to: `/meet/${dashed}` };
  const room = await readMeetRoomByCode(deps.db(), code);
  if (!room) return { kind: "not_found" };
  const viewer = meetViewerFor(await deps.session(), room);
  if (room.status === "ended") return { kind: "ended", viewer };
  return { kind: "room", props: { code: dashed, title: room.title, status: room.status, recordAudio: room.recordAudio, viewer } };
}
