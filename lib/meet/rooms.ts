/**
 * lib/meet/rooms.ts - Oasis Meet's rooms (migration bravo__230): the code in a
 * meeting link, and creating and reading a room.
 *
 * CC (2026-10-17): our own Google Meet, started from the Schedule page and
 * joined by a link. The link is oasisai.work/meet/abc-defg-hjk: ten random
 * letters, read out as 3-4-3 like Google's. The code is the only thing a guest
 * holds, so it is the one lookup that is not by workspace (readMeetRoomByCode);
 * every read and write after it uses the room's own tenant_id.
 *
 * Raw SQL on the libSQL client (lib/turso.ts getTursoClient), like the booking
 * cap: one statement per step, tenant_id in every query but the code lookup.
 */
import "server-only";
import type { Client } from "@libsql/client";

/** The letters a code is made of: a to z without "l", which reads as "1" or "I" when a link is read out. */
export const MEET_CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz";
export const MEET_CODE_LENGTH = 10;
/** The longest title kept; the Schedule panel and the room header show it on one line. */
export const MEET_TITLE_MAX = 120;
/** The title a room gets when its host gives none. */
export const MEET_DEFAULT_TITLE = "Meeting";

export type MeetRoomStatus = "scheduled" | "live" | "ended";
export type MeetEndedReason = "host_ended" | "host_left" | "expired";

export type MeetRoom = {
  id: string;
  tenantId: string;
  /** Stored without dashes ("abcdefghjk"); displayMeetCode adds them. */
  code: string;
  title: string;
  hostUserId: string;
  status: MeetRoomStatus;
  recordAudio: boolean;
  startsAt: string | null;
  calendarEventId: string | null;
  leadId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: MeetEndedReason | null;
};

/**
 * Ten random letters. A byte from 250 up is drawn again rather than folded in:
 * 256 is not a multiple of 25, and folding would make the first six letters
 * a little likelier than the rest.
 */
export function newMeetCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const size = MEET_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let code = "";
  while (code.length < MEET_CODE_LENGTH) {
    for (const byte of randomBytes(MEET_CODE_LENGTH)) {
      if (byte < limit && code.length < MEET_CODE_LENGTH) code += MEET_CODE_ALPHABET[byte % size];
    }
  }
  return code;
}

/** The code as a link and the room show it: "abc-defg-hjk". */
export function displayMeetCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}

/** The stored code for a link or what someone typed: dashes and spaces dropped, lower case. Null when it cannot be a code. */
export function parseMeetCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = input.trim().toLowerCase().replace(/[-\s]/g, "");
  if (code.length !== MEET_CODE_LENGTH) return null;
  for (const ch of code) if (!MEET_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** U+FFFD, built from its code so this file stays ASCII (tests/worker-source-one-byte.test.ts). */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** Text with any lone UTF-16 surrogate (half an emoji) replaced by U+FFFD, so it encodes, stores and prints. */
export function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT_CHARACTER);
}

/** A title as it is kept: control characters as spaces, a broken half of an emoji as U+FFFD, trimmed, capped by characters; none at all is "Meeting". */
export function meetTitle(input: unknown): string {
  const text =
    typeof input === "string"
      ? wellFormedText(input)

          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
      : "";
  return Array.from(text).slice(0, MEET_TITLE_MAX).join("").trim() || MEET_DEFAULT_TITLE;
}

const ROOM_COLUMNS =
  "id, tenant_id, code, title, host_user_id, status, record_audio, starts_at, calendar_event_id, lead_id, created_at, started_at, ended_at, ended_reason";

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** A row as a room. libSQL over HTTP can hand integers back as strings, so the flag is compared as a number. */
function toRoom(row: Record<string, unknown>): MeetRoom {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    code: String(row.code),
    title: String(row.title),
    hostUserId: String(row.host_user_id),
    status: String(row.status) as MeetRoomStatus,
    recordAudio: Number(row.record_audio) === 1,
    startsAt: text(row.starts_at),
    calendarEventId: text(row.calendar_event_id),
    leadId: text(row.lead_id),
    createdAt: String(row.created_at),
    startedAt: text(row.started_at),
    endedAt: text(row.ended_at),
    endedReason: text(row.ended_reason) as MeetEndedReason | null,
  };
}

export type NewMeetRoom = {
  tenantId: string;
  hostUserId: string;
  title?: unknown;
  recordAudio?: boolean;
  /** When the meeting is planned for, if it was made for later (ISO). */
  startsAt?: string | null;
  calendarEventId?: string | null;
  leadId?: string | null;
  now?: Date;
  /** Tests pass their own codes; production draws them at random. */
  nextCode?: () => string;
};

/** How many codes are drawn before giving up: two clashes in a row among 25^10 codes means something else is wrong. */
const CODE_ATTEMPTS = 3;

/** Make a room. A code that is already taken (the unique index says so) is drawn again. */
export async function createMeetRoom(db: Client, input: NewMeetRoom): Promise<MeetRoom> {
  const startsAt = input.startsAt && Number.isFinite(Date.parse(input.startsAt)) ? new Date(input.startsAt).toISOString() : null;
  const nextCode = input.nextCode ?? (() => newMeetCode());
  for (let attempt = 1; ; attempt += 1) {
    const room: MeetRoom = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      code: nextCode(),
      title: meetTitle(input.title),
      hostUserId: input.hostUserId,
      status: "scheduled",
      recordAudio: input.recordAudio ?? true,
      startsAt,
      calendarEventId: input.calendarEventId ?? null,
      leadId: input.leadId ?? null,
      createdAt: (input.now ?? new Date()).toISOString(),
      startedAt: null,
      endedAt: null,
      endedReason: null,
    };
    try {
      await db.execute({
        sql: `INSERT INTO meet_rooms (${ROOM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          room.id, room.tenantId, room.code, room.title, room.hostUserId, room.status, room.recordAudio ? 1 : 0,
          room.startsAt, room.calendarEventId, room.leadId, room.createdAt, null, null, null,
        ],
      });
      return room;
    } catch (err) {
      const clash = /UNIQUE constraint failed: meet_rooms\.code/i.test(err instanceof Error ? err.message : String(err));
      if (!clash || attempt >= CODE_ATTEMPTS) throw err;
    }
  }
}

/** The room a link names, in whatever workspace it is. Only for the code a person holds: use the room's tenantId from here on. */
export async function readMeetRoomByCode(db: Client, code: string): Promise<MeetRoom | null> {
  const rs = await db.execute({ sql: `SELECT ${ROOM_COLUMNS} FROM meet_rooms WHERE code = ? LIMIT 1`, args: [code] });
  return rs.rows[0] ? toRoom(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

/** One of a workspace's rooms by id; another workspace's id reads as no room. */
export async function readMeetRoom(db: Client, where: { tenantId: string; roomId: string }): Promise<MeetRoom | null> {
  const rs = await db.execute({
    sql: `SELECT ${ROOM_COLUMNS} FROM meet_rooms WHERE tenant_id = ? AND id = ? LIMIT 1`,
    args: [where.tenantId, where.roomId],
  });
  return rs.rows[0] ? toRoom(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

/** A workspace's rooms, newest first, for the Schedule's Meet panel. */
export async function listMeetRooms(db: Client, where: { tenantId: string; limit?: number }): Promise<MeetRoom[]> {
  const limit = Math.min(Math.max(1, Math.floor(where.limit ?? 20)), 100);
  const rs = await db.execute({
    sql: `SELECT ${ROOM_COLUMNS} FROM meet_rooms WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [where.tenantId, limit],
  });
  return rs.rows.map((row) => toRoom(row as unknown as Record<string, unknown>));
}
