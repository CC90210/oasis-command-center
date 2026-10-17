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
import type { MeetEndedReason, MeetRoom } from "./rooms";

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

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

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

/** Every SFU session anyone in the room has had, present or not: what ending the room must cut. */
export async function roomSessions(db: Client, room: Pick<MeetRoom, "tenantId" | "id">): Promise<string[]> {
  const rs = await db.execute({
    sql: "SELECT DISTINCT sfu_session_id AS s FROM meet_participants WHERE tenant_id = ? AND room_id = ? AND sfu_session_id IS NOT NULL",
    args: [room.tenantId, room.id],
  });
  return rs.rows.map((row) => String(row.s));
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
 * A live room whose hosts have all been gone for MEET_HOST_GRACE_MS ends itself (ended_reason host_left). Read
 * on each state poll, so it needs no scheduler. True when this call ended it.
 */
export async function expireIfHostGone(db: Client, room: MeetRoom, now: Date = new Date()): Promise<boolean> {
  if (room.status !== "live") return false;
  const rs = await db.execute({
    sql: "SELECT max(last_seen_at) AS seen FROM meet_participants WHERE tenant_id = ? AND room_id = ? AND role = 'host' AND removed_at IS NULL",
    args: [room.tenantId, room.id],
  });
  const seen = rs.rows[0]?.seen ? Date.parse(String(rs.rows[0].seen)) : NaN;
  const since = Number.isFinite(seen) ? seen : Date.parse(room.startedAt ?? room.createdAt);
  if (now.getTime() - since < MEET_HOST_GRACE_MS) return false;
  return endMeetRoom(db, room, "host_left", now);
}
