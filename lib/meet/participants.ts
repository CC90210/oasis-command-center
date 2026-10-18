/**
 * lib/meet/participants.ts - who is in an Oasis Meet room, and the room's life.
 *
 * Every write names the room's own tenant_id and room_id. A participant is
 * PRESENT while their browser keeps polling the room's state (last_seen_at within
 * MEET_PRESENCE_MS) and they have neither left nor been removed; a tab that closed
 * without saying so drops out on its own.
 *
 * The cap of MEET_MAX_PARTICIPANTS is taken in the same statement as the join
 * (INSERT ... SELECT ... WHERE present < cap), so two people joining at once
 * cannot both take the last place.
 *
 * A room is `scheduled` until its first host joins, then `live`. It ends when a
 * host ends it, or on its own once no host has been present for
 * MEET_HOST_GRACE_MS (the host's tab died and they did not come back).
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { MeetRole } from "./access";
import { nullableText as text, type MeetEndedReason, type MeetRoom } from "./rooms";

/** The most people in one room at once: a sales call is two or three; this is a ceiling against a leaked link. */
export const MEET_MAX_PARTICIPANTS = 8;
/** A participant not heard from for this long is gone (the room page polls every 2 seconds). */
export const MEET_PRESENCE_MS = 30_000;
/** A live room with no host present for this long ends itself. */
export const MEET_HOST_GRACE_MS = 10 * 60_000;
/** The most tracks one participant publishes: microphone, camera and a shared screen. */
export const MEET_MAX_TRACKS = 3;

const PARTICIPANT_COLUMNS =
  "id, tenant_id, room_id, role, user_id, display_name, consent_at, sfu_session_id, tracks, joined_at, last_seen_at, left_at, removed_at";

export type PublishedTrack = { trackName: string; kind: "audio" | "video"; mid: string };

function parseTracks(raw: unknown): PublishedTrack[] {
  try {
    const list = JSON.parse(String(raw ?? "[]")) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((t) => {
      const o = t as { trackName?: unknown; kind?: unknown; mid?: unknown };
      return typeof o?.trackName === "string" && (o.kind === "audio" || o.kind === "video")
        ? [{ trackName: o.trackName, kind: o.kind, mid: typeof o.mid === "string" ? o.mid : "" }]
        : [];
    });
  } catch {
    return [];
  }
}

/** A participant's row. `tracks` is what they publish on their SFU session: name, kind and the SFU's mid. */
export type MeetPresence = {
  id: string;
  tenantId: string;
  roomId: string;
  role: MeetRole;
  userId: string | null;
  displayName: string;
  consentAt: string | null;
  sfuSessionId: string | null;
  tracks: PublishedTrack[];
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string | null;
  removedAt: string | null;
};

function toPresence(row: Record<string, unknown>): MeetPresence {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    roomId: String(row.room_id),
    role: String(row.role) === "host" ? "host" : "guest",
    userId: text(row.user_id),
    displayName: String(row.display_name),
    consentAt: text(row.consent_at),
    sfuSessionId: text(row.sfu_session_id),
    tracks: parseTracks(row.tracks),
    joinedAt: String(row.joined_at),
    lastSeenAt: String(row.last_seen_at),
    leftAt: text(row.left_at),
    removedAt: text(row.removed_at),
  };
}

const presentSince = (now: Date) => new Date(now.getTime() - MEET_PRESENCE_MS).toISOString();

/**
 * Add a person to a room, unless it already holds MEET_MAX_PARTICIPANTS present people: one statement, so the
 * last place cannot be taken twice. A host's join also opens a scheduled room. Null when the room is full.
 */
export async function joinMeetRoom(
  db: Client,
  input: { room: MeetRoom; role: MeetRole; userId: string | null; displayName: string; consentAt: string | null; now?: Date },
): Promise<MeetPresence | null> {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const id = crypto.randomUUID();
  const { room } = input;
  const rs = await db.execute({
    sql: `INSERT INTO meet_participants (${PARTICIPANT_COLUMNS})
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, NULL, NULL
          WHERE (SELECT count(*) FROM meet_participants
                 WHERE tenant_id = ? AND room_id = ? AND left_at IS NULL AND removed_at IS NULL AND last_seen_at > ?) < ?`,
    args: [
      id, room.tenantId, room.id, input.role, input.userId, input.displayName, input.consentAt, at, at,
      room.tenantId, room.id, presentSince(now), MEET_MAX_PARTICIPANTS,
    ],
  });
  if (rs.rowsAffected === 0) return null;
  if (input.role === "host") {
    await db.execute({
      sql: "UPDATE meet_rooms SET status = 'live', started_at = ? WHERE tenant_id = ? AND id = ? AND status = 'scheduled'",
      args: [at, room.tenantId, room.id],
    });
  }
  return {
    id, tenantId: room.tenantId, roomId: room.id, role: input.role, userId: input.userId, displayName: input.displayName,
    consentAt: input.consentAt, sfuSessionId: null, tracks: [], joinedAt: at, lastSeenAt: at, leftAt: null, removedAt: null,
  };
}

/** The people present in a room now, in the order they joined. */
export async function presentParticipants(db: Client, room: Pick<MeetRoom, "tenantId" | "id">, now: Date = new Date()): Promise<MeetPresence[]> {
  const rs = await db.execute({
    sql: `SELECT ${PARTICIPANT_COLUMNS} FROM meet_participants
          WHERE tenant_id = ? AND room_id = ? AND left_at IS NULL AND removed_at IS NULL AND last_seen_at > ?
          ORDER BY joined_at, id`,
    args: [room.tenantId, room.id, presentSince(now)],
  });
  return rs.rows.map((row) => toPresence(row as unknown as Record<string, unknown>));
}

/** One participant, present or not, with their published tracks. */
export async function readPresence(db: Client, where: { tenantId: string; roomId: string; participantId: string }): Promise<MeetPresence | null> {
  const rs = await db.execute({
    sql: `SELECT ${PARTICIPANT_COLUMNS} FROM meet_participants WHERE tenant_id = ? AND room_id = ? AND id = ? LIMIT 1`,
    args: [where.tenantId, where.roomId, where.participantId],
  });
  return rs.rows[0] ? toPresence(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

const scoped = (p: Pick<MeetPresence, "tenantId" | "roomId" | "id">) => [p.tenantId, p.roomId, p.id];

/** They are still here (the room page's poll). */
export async function touchParticipant(db: Client, p: Pick<MeetPresence, "tenantId" | "roomId" | "id">, now: Date = new Date()): Promise<void> {
  await db.execute({
    sql: "UPDATE meet_participants SET last_seen_at = ? WHERE tenant_id = ? AND room_id = ? AND id = ? AND left_at IS NULL AND removed_at IS NULL",
    args: [now.toISOString(), ...scoped(p)],
  });
}

/** Their browser's SFU session. A reconnect replaces it, and what they published on the old one is gone with it. */
export async function setParticipantSession(db: Client, p: Pick<MeetPresence, "tenantId" | "roomId" | "id">, sessionId: string): Promise<void> {
  await db.execute({
    sql: "UPDATE meet_participants SET sfu_session_id = ?, tracks = '[]' WHERE tenant_id = ? AND room_id = ? AND id = ?",
    args: [sessionId, ...scoped(p)],
  });
}

export async function setParticipantTracks(db: Client, p: Pick<MeetPresence, "tenantId" | "roomId" | "id">, tracks: PublishedTrack[]): Promise<void> {
  await db.execute({
    sql: "UPDATE meet_participants SET tracks = ? WHERE tenant_id = ? AND room_id = ? AND id = ?",
    args: [JSON.stringify(tracks.slice(0, MEET_MAX_TRACKS)), ...scoped(p)],
  });
}

/** They left. Their token stops working on its next use (requireMeetParticipant reads left_at). */
export async function leaveMeet(db: Client, p: Pick<MeetPresence, "tenantId" | "roomId" | "id">, now: Date = new Date()): Promise<void> {
  await db.execute({
    sql: "UPDATE meet_participants SET left_at = ? WHERE tenant_id = ? AND room_id = ? AND id = ? AND left_at IS NULL",
    args: [now.toISOString(), ...scoped(p)],
  });
}

/** A host removed them. Returns who was removed (to close their media), or null if they were not in the room. */
export async function removeParticipant(
  db: Client,
  room: Pick<MeetRoom, "tenantId" | "id">,
  participantId: string,
  now: Date = new Date(),
): Promise<MeetPresence | null> {
  const before = await readPresence(db, { tenantId: room.tenantId, roomId: room.id, participantId });
  if (!before || before.removedAt || before.leftAt) return null;
  await db.execute({
    sql: "UPDATE meet_participants SET removed_at = ? WHERE tenant_id = ? AND room_id = ? AND id = ? AND removed_at IS NULL",
    args: [now.toISOString(), room.tenantId, room.id, participantId],
  });
  return before;
}

/** A participant's SFU session that has not been cut yet: a row keeps its session id until a cut goes through. */
export type HeldSession = { participantId: string; sessionId: string };

const heldSessions = (rows: Array<Record<string, unknown>>): HeldSession[] =>
  rows.map((row) => ({ participantId: String(row.id), sessionId: String(row.sfu_session_id) }));

/** Every SFU session the room's rows still hold, present or not: what ending or deleting the room must cut. */
export async function roomSessions(db: Client, room: Pick<MeetRoom, "tenantId" | "id">): Promise<HeldSession[]> {
  const rs = await db.execute({
    sql: "SELECT id, sfu_session_id FROM meet_participants WHERE tenant_id = ? AND room_id = ? AND sfu_session_id IS NOT NULL",
    args: [room.tenantId, room.id],
  });
  return heldSessions(rs.rows as unknown as Array<Record<string, unknown>>);
}

/** How long after someone left or was removed a cut of their session that failed is still tried again. */
export const MEET_CUT_RETRY_MS = 60 * 60_000;

/**
 * Sessions of people who left or were removed whose cut has not gone through (the SFU did not answer): newest
 * first, at most `limit`, and only within MEET_CUT_RETRY_MS. A removed guest whose cut failed would otherwise
 * keep receiving the room, with no row left on the host's screen to try again from.
 */
export async function pendingCuts(db: Client, room: Pick<MeetRoom, "tenantId" | "id">, now: Date, limit = 3): Promise<HeldSession[]> {
  const rs = await db.execute({
    sql: `SELECT id, sfu_session_id FROM meet_participants
          WHERE tenant_id = ? AND room_id = ? AND sfu_session_id IS NOT NULL AND (removed_at IS NOT NULL OR left_at IS NOT NULL)
            AND COALESCE(removed_at, left_at) > ?
          ORDER BY COALESCE(removed_at, left_at) DESC LIMIT ?`,
    args: [room.tenantId, room.id, new Date(now.getTime() - MEET_CUT_RETRY_MS).toISOString(), limit],
  });
  return heldSessions(rs.rows as unknown as Array<Record<string, unknown>>);
}

/** A cut went through: the row lets go of that session and what it published there (unless a reconnect replaced it). */
export async function forgetSession(db: Client, room: Pick<MeetRoom, "tenantId" | "id">, held: HeldSession): Promise<void> {
  await db.execute({
    sql: "UPDATE meet_participants SET sfu_session_id = NULL, tracks = '[]' WHERE tenant_id = ? AND room_id = ? AND id = ? AND sfu_session_id = ?",
    args: [room.tenantId, room.id, held.participantId, held.sessionId],
  });
}

/**
 * Delete a room and everyone's row in it (the host's "Delete meeting"). The recording goes first, through
 * lib/meet/recording.ts deleteMeetRecording, which keeps its own tombstone rows: never delete those here.
 */
export async function deleteMeetRoomRows(db: Client, room: Pick<MeetRoom, "tenantId" | "id">): Promise<void> {
  await db.execute({ sql: "DELETE FROM meet_participants WHERE tenant_id = ? AND room_id = ?", args: [room.tenantId, room.id] });
  await db.execute({ sql: "DELETE FROM meet_rooms WHERE tenant_id = ? AND id = ?", args: [room.tenantId, room.id] });
}

/** End a room once. True when this call ended it; false when it had already ended. */
export async function endMeetRoom(db: Client, room: Pick<MeetRoom, "tenantId" | "id">, reason: MeetEndedReason, now: Date = new Date()): Promise<boolean> {
  const rs = await db.execute({
    sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = ? WHERE tenant_id = ? AND id = ? AND status != 'ended'",
    args: [now.toISOString(), reason, room.tenantId, room.id],
  });
  return rs.rowsAffected > 0;
}

/**
 * A live room ends on its own (host_left) once its hosts have all been gone for MEET_HOST_GRACE_MS AND a call
 * happened in it: some guest was in the room while a host was. A host who opened the room alone (to test their
 * camera, or early) leaves it waiting for its meeting, so the first guest to arrive is never shown "ended".
 * `?` is the cutoff (now - MEET_HOST_GRACE_MS). A host's last sighting is their last poll; with none, the start.
 */
const HOSTS_GONE_AFTER_A_CALL = `r.status = 'live'
  AND COALESCE(
        (SELECT max(h.last_seen_at) FROM meet_participants h
          WHERE h.tenant_id = r.tenant_id AND h.room_id = r.id AND h.role = 'host' AND h.removed_at IS NULL),
        r.started_at, r.created_at) <= ?
  AND EXISTS (
        SELECT 1 FROM meet_participants g
          JOIN meet_participants h ON h.tenant_id = g.tenant_id AND h.room_id = g.room_id AND h.role = 'host'
         WHERE g.tenant_id = r.tenant_id AND g.room_id = r.id AND g.role = 'guest'
           AND g.joined_at <= h.last_seen_at AND h.joined_at <= g.last_seen_at)`;

const graceCutoff = (now: Date) => new Date(now.getTime() - MEET_HOST_GRACE_MS).toISOString();

/** The state poll's check: end this room if its call has been left without a host. True when this call ended it. */
export async function expireIfHostGone(db: Client, room: MeetRoom, now: Date = new Date()): Promise<boolean> {
  if (room.status !== "live") return false;
  const rs = await db.execute({
    sql: `UPDATE meet_rooms AS r SET status = 'ended', ended_at = ?, ended_reason = 'host_left'
           WHERE r.tenant_id = ? AND r.id = ? AND ${HOSTS_GONE_AFTER_A_CALL}`,
    args: [now.toISOString(), room.tenantId, room.id, graceCutoff(now)],
  });
  return rs.rowsAffected > 0;
}

/**
 * The same rule for rooms nobody polls any more: a call whose host's tab died after everyone else left would stay
 * live forever, and its recording would never be handed over (lib/meet/recording.ts finalizeDueRooms takes ended
 * rooms only). Run when a host opens the Schedule's meetings and by the recording relay's sweep. Returns the rooms
 * it ended, for the caller to cut their media.
 */
export async function endAbandonedRooms(db: Client, tenantIds: readonly string[], now: Date = new Date()): Promise<Array<Pick<MeetRoom, "tenantId" | "id">>> {
  if (!tenantIds.length) return [];
  const rs = await db.execute({
    sql: `UPDATE meet_rooms AS r SET status = 'ended', ended_at = ?, ended_reason = 'host_left'
           WHERE r.tenant_id IN (${tenantIds.map(() => "?").join(", ")}) AND ${HOSTS_GONE_AFTER_A_CALL}
       RETURNING tenant_id, id`,
    args: [now.toISOString(), ...tenantIds, graceCutoff(now)],
  });
  return rs.rows.map((row) => ({ tenantId: String(row.tenant_id), id: String(row.id) }));
}
