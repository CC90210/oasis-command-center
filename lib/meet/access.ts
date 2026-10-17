/**
 * lib/meet/access.ts - who may do what in an Oasis Meet room.
 *
 * HOST: a signed-in member of the room's workspace who made the room, or who
 * owns or administers the workspace by their base role (isTrueAdmin: the
 * admin_access toggle opens screens, it does not make a host). A host starts
 * and ends the meeting, removes people and records everyone's voice, so the
 * bar is the same as deleting a lead's records. requireMeetHost answers that
 * from the session.
 *
 * GUEST: anyone holding the link. Joining with a name gives them a participant
 * token: an HMAC-signed claim (room, participant, role, expiry) under its own
 * secret, MEET_TOKEN_SECRET, never shared with any other signer. It travels as
 * an HttpOnly, Secure, SameSite=Lax cookie whose Path is the room's own API
 * (/api/meet/abc-defg-hjk), so it is sent nowhere else. The token only says
 * which participant row is calling: requireMeetParticipant re-reads that row on
 * every request, so leaving, being removed or the room ending takes effect on
 * the very next call, whatever the token's expiry says.
 *
 * No secret, no meetings: a missing or short MEET_TOKEN_SECRET throws
 * MeetNotConfiguredError on sign and on verify alike, and the routes answer 503.
 * There is no unsigned development mode.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import type { NextResponse } from "next/server";
import { meetError } from "./answers";
import { readPresence, type MeetPresence } from "./participants";
import { displayMeetCode, parseMeetCode, readMeetRoomByCode, wellFormedText, type MeetRoom } from "./rooms";

export type MeetRole = "host" | "guest";

export const MEET_TOKEN_SECRET_ENV = "MEET_TOKEN_SECRET";
/** The cookie holding a participant token. One name serves every room: each room's cookie has its own Path. */
export const MEET_COOKIE = "oasis_meet";
/** How long a participant token lasts: longer than any meeting, and a new join mints a new one. */
export const MEET_TOKEN_TTL_S = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 1024;

/** Meetings cannot run: a secret or the Realtime app is not set. Routes answer 503 meet_not_configured. */
export class MeetNotConfiguredError extends Error {
  constructor(message = `${MEET_TOKEN_SECRET_ENV} is missing or shorter than ${MIN_SECRET_LENGTH} characters`) {
    super(message);
    this.name = "MeetNotConfiguredError";
  }
}

/** A participant token's claims. `role` is what they joined as; the participant row is what counts. */
export type MeetTokenClaims = { roomId: string; participantId: string; role: MeetRole; exp: number };

function secret(): string {
  const value = process.env[MEET_TOKEN_SECRET_ENV];
  if (!value || value.length < MIN_SECRET_LENGTH) throw new MeetNotConfiguredError();
  return value;
}

/** The signature over a token's payload, domain-separated so it can never pass for another signer's. */
function mac(payload: string): string {
  return createHmac("sha256", secret()).update(`oasis-meet.v1.${payload}`).digest("base64url");
}

/** A participant token for a join: base64url(JSON claims) "." base64url(HMAC). */
export function signMeetToken(claims: Omit<MeetTokenClaims, "exp">, nowMs: number = Date.now()): string {
  const body = { v: 1, r: claims.roomId, p: claims.participantId, role: claims.role, exp: Math.floor(nowMs / 1000) + MEET_TOKEN_TTL_S };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** The claims of a token this server signed and that has not expired; null for anything else. */
export function verifyMeetToken(token: string | null | undefined, nowMs: number = Date.now()): MeetTokenClaims | null {
  // The secret is checked first, so a missing one is an outage the route reports, never a quiet "not signed in".
  secret();
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { v, r, p, role, exp } = body ?? {};
  if (v !== 1 || typeof r !== "string" || typeof p !== "string" || (role !== "host" && role !== "guest")) return null;
  if (typeof exp !== "number" || exp * 1000 <= nowMs) return null;
  return { roomId: r, participantId: p, role, exp };
}

/** The room's API path, the participant cookie's Path. Links and calls always use the dashed form. */
export function meetApiPath(code: string): string {
  return `/api/meet/${displayMeetCode(code)}`;
}

/** The cookie a join sets: the token, readable by no script, sent only to this room's API. */
export function meetCookie(code: string, token: string) {
  return {
    name: MEET_COOKIE,
    value: token,
    options: { httpOnly: true, secure: true, sameSite: "lax" as const, path: meetApiPath(code), maxAge: MEET_TOKEN_TTL_S },
  };
}

/**
 * Who a signed-in person is in a room: its host (they made it, or own or administer the workspace by base role),
 * a guest (another member), or no one (another workspace, which is never told the room exists).
 */
export function meetRoleFor(
  session: { tenantId: string; userId: string; isTrueAdmin: boolean },
  room: Pick<MeetRoom, "tenantId" | "hostUserId">,
): MeetRole | null {
  if (session.tenantId !== room.tenantId) return null;
  return session.userId === room.hostUserId || session.isTrueAdmin ? "host" : "guest";
}

/** The longest name a participant shows: it heads their tile and labels their lines in the transcript. */
export const MEET_NAME_MAX = 60;

/**
 * A participant's name as it is kept: control characters and runs of spaces as one space, a broken half of an
 * emoji as U+FFFD, trimmed and capped by characters (never cutting an emoji in two). Null when nothing is left.
 */
export function meetDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const plain = wellFormedText(input).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const name = Array.from(plain).slice(0, MEET_NAME_MAX).join("").trim();
  return name || null;
}

const answer = (status: number, error: string, extra: Record<string, unknown> = {}) => ({
  ok: false as const,
  response: meetError(status, error, extra),
});

/** The signed-in person as Meet needs them (lib/api-auth.ts resolveSessionContext, narrowed). */
export type MeetSession = { ok: true; tenantId: string; userId: string; isTrueAdmin: boolean; email?: string | null } | { ok: false };

export type MeetHostResult = { ok: true; tenantId: string; userId: string; room: MeetRoom } | { ok: false; response: NextResponse };

/**
 * The signed-in host of the room a link names, or the answer to send: 401 not signed in, 404 no such room (also
 * another workspace's), 403 a member who is not its host. An ended room is still returned: a recording's last
 * chunks arrive after the host ends the call, so each route decides what an ended room allows.
 */
export async function requireMeetHost(
  db: Client,
  rawCode: string,
  resolveSession: () => Promise<MeetSession> = async () => (await import("@/lib/api-auth")).resolveSessionContext(),
): Promise<MeetHostResult> {
  const session = await resolveSession();
  if (!session.ok) return answer(401, "sign_in_required");
  const code = parseMeetCode(rawCode);
  const room = code ? await readMeetRoomByCode(db, code) : null;
  const role = room ? meetRoleFor(session, room) : null;
  if (!room || role === null) return answer(404, "room_not_found");
  if (role !== "host") return answer(403, "host_only");
  return { ok: true, tenantId: room.tenantId, userId: session.userId, room };
}

/** A participant as the room's API sees them: their row, with what they publish (lib/meet/participants.ts). */
export type MeetParticipant = MeetPresence;

/** One participant of one room, read in the room's own workspace (the recording routes import it from here). */
export { readPresence as readMeetParticipant };

export type MeetParticipantResult =
  | { ok: true; room: MeetRoom; participant: MeetParticipant }
  | { ok: false; response: NextResponse };

/**
 * The participant calling this room's API, from their cookie, re-read from their row. The answer otherwise:
 * 404 no such room, 401 no valid token for THIS room (or they left), 403 removed by the host, 410 the room ended.
 * MeetNotConfiguredError propagates: the route answers 503.
 */
export async function requireMeetParticipant(
  db: Client,
  req: { cookies: { get(name: string): { value: string } | undefined } },
  rawCode: string,
  nowMs: number = Date.now(),
): Promise<MeetParticipantResult> {
  const code = parseMeetCode(rawCode);
  const room = code ? await readMeetRoomByCode(db, code) : null;
  if (!room) return answer(404, "room_not_found");
  const claims = verifyMeetToken(req.cookies.get(MEET_COOKIE)?.value, nowMs);
  if (!claims || claims.roomId !== room.id) return answer(401, "not_in_room");
  // Why it ended (host_ended, host_left, expired), so the page can say "the host ended it" only when one did.
  if (room.status === "ended") return answer(410, "room_ended", { reason: room.endedReason });
  const participant = await readPresence(db, { tenantId: room.tenantId, roomId: room.id, participantId: claims.participantId });
  if (!participant || participant.leftAt) return answer(401, "not_in_room");
  if (participant.removedAt) return answer(403, "removed");
  return { ok: true, room, participant };
}
