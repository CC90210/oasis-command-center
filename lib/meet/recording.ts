/**
 * lib/meet/recording.ts - Oasis Meet's recording relay and its transcripts
 * (migration bravo__231).
 *
 * CC (2026-10-17): no vendor bill for recording, and the recordings live on
 * OASIS's own computer. So the Command Center is a RELAY, never the archive:
 *
 *   1 RECORD      the host's browser records each speaker's voice
 *                 (lib/meet/recorder.ts) and POSTs 10-second chunks to
 *                 /api/meet/<code>/recording/chunk. Each lands in R2 at
 *                 meet-relay/<tenant>/<room>/<participant>/<segment>/<seq> and
 *                 gets a meet_recording_chunks row (acceptChunk).
 *   2 HAND OVER   once the meeting has ended (ensureTranscriptJob): the host's
 *                 browser right after End, or the PC's own claim 10 minutes
 *                 after the end if that browser never said so
 *                 (finalizeDueRooms). A call whose every tab closed without End
 *                 is ended by that same claim first (endAbandonedRooms, in
 *                 meetRelaySweeps). That makes the room's meet_transcripts row
 *                 and a meet_transcribe job for the PC.
 *   3 TRANSCRIBE  OASIS's PC (BEA scripts/meet/runner.py) claims the job. The
 *                 claim fixes exactly which chunks it gets (segments_json,
 *                 meetTranscribeClaim); download-urls signs them; the PC keeps
 *                 the audio in its Meetings folder, transcribes it on the CPU
 *                 and posts the transcript back (complete).
 *   4 FORGET      only then are the relay copies deleted (removeRelayChunks),
 *                 at most RELAY_CLEANUP_BATCH per request: each delete is one
 *                 call to R2 and a Worker request may make only so many. The
 *                 rest go on the next claim, every minute while the PC is on.
 *
 * The audio waits for the PC at most 30 days from the meeting's end
 * (relay_expires_at, expireRelay): a PC that never comes back must not turn the
 * relay into an archive of people's voices. An R2 lifecycle rule on
 * meet-relay/ is the backstop for any object whose row is gone.
 *
 * A SEGMENT is one MediaRecorder run. Its container header is in chunk 0 only,
 * so a segment is usable up to its first missing chunk and no further: the
 * claim hands over each segment's unbroken run from 0 (declareSegments) and
 * counts the rest as missing_chunks, so the panel can say what was not heard.
 *
 * WHO. The host routes (lib/meet/recording-routes.ts) pass requireMeetHost; the
 * runner routes (lib/tools/runner-handlers.ts) pass the signed tools auth and
 * serve OASIS's own workspaces. Every statement names the room's tenant_id.
 * One browser records a room, whichever host's it is: the room's recorder
 * (meet_rooms.recorder_participant_id, lib/meet/participants.ts
 * claimRecorder). A chunk from any other browser still in the call is refused.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client, InStatement, InValue } from "@libsql/client";
import { OASIS_INTERNAL_TENANT_IDS } from "@/lib/ai/tools/client-safe-registry";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";
import { pathBelongsToTenant } from "@/lib/storage-helpers";
import { toolErrorLine } from "@/lib/tools/errors";
import { LEASE_GUARD, inputHashOf, liveRunnerForTool, sqlPlaceholders } from "@/lib/tools/store";
import { MeetNotConfiguredError } from "./access";
import { endAbandonedRooms, forgetSession, roomSessions } from "./participants";
import { readMeetRoom, type MeetRoom } from "./rooms";
import { cutSession, sfuClient, type SfuClient } from "./sfu";

/** The logical bucket the relay copies live in: private (never in PUBLIC_BUCKET_PREFIXES), signed URLs only. */
export const MEET_RELAY_BUCKET = "meet-relay";
/** The largest chunk taken. Ten seconds of speech is a small fraction of it at any browser's default rate. */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** A room's ceiling: eight speakers for four hours is 11,520 chunks of 10 seconds; a ninth or a longer call fits too. */
export const MAX_ROOM_CHUNKS = 15_000;
export const MAX_ROOM_BYTES = 2048 * 1024 * 1024;
/** The highest sequence number one segment's chunk may carry. */
export const MAX_CHUNK_SEQ = 100_000;
/**
 * How long after End a chunk is still taken: a recorder's last uploads finish after the call ends. The same window
 * holds for a recording browser that left the call while others go on: its last chunks are still its own.
 */
export const LATE_CHUNK_MS = 10 * 60_000;
/** How long the relay holds a recording for the PC, counted from the meeting's end. */
export const RELAY_DAYS = 30;
/** Relay objects one runner claim deletes (each delete is one call to R2, and the claim has other work). */
export const RELAY_CLEANUP_BATCH = 100;
/** Relay objects one host Delete, or one relay cron run, deletes before it answers. */
export const RELAY_DELETE_BATCH = 300;
/** How many R2 deletes run at once (a Worker keeps at most six connections open). */
const RELAY_DELETE_CONCURRENCY = 6;
export const FINALIZE_SWEEP_BATCH = 5;
/** How long one chunk's download URL lasts. The PC asks for one page at a time, just before it downloads it. */
export const DOWNLOAD_URL_TTL_SECONDS = 1800;
/** The most chunk URLs one download-urls answer carries: a long meeting is fetched page by page. */
export const DOWNLOAD_PAGE_MAX = 300;
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
export const MAX_TRANSCRIPT_LINES = 20_000;
/**
 * The longest line taken. Generous on purpose: the PC splits a speaker's long
 * run of talk into lines of about 1,500 characters, and one over-long line must
 * never cost the whole transcript (the report is refused as a unit).
 */
export const MAX_LINE_CHARS = 20_000;

const DAY_MS = 86_400_000;
const IN_FLIGHT = new Set(["queued", "claimed", "running"]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const UNIQUE_FAILED = /UNIQUE constraint failed/i;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The relay's object store, as much of it as this file uses (R2 in production, a fake in tests). */
export type MeetStorage = {
  /** Store one chunk, overwriting a retry of the same chunk. Throws when it could not be stored. */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A short-lived GET URL for one object. */
  signedGetUrl(path: string, ttlSeconds: number): Promise<string>;
  /** Delete one object; one already gone is not an error. Throws when it could not be deleted. */
  remove(path: string): Promise<void>;
};

/** The meet-relay bucket on R2, or null when R2 is not configured (never the Supabase fallback). */
export function r2MeetStorage(): MeetStorage | null {
  if (!r2Configured()) return null;
  const bucket = r2StorageSurface().from(MEET_RELAY_BUCKET);
  return {
    async put(path, bytes, contentType) {
      const r = await bucket.upload(path, bytes, { contentType, upsert: true });
      if (r.error) throw new Error(r.error.message);
    },
    async signedGetUrl(path, ttlSeconds) {
      const r = await bucket.createSignedUrl(path, ttlSeconds);
      if (r.error || !r.data?.signedUrl) throw new Error(r.error?.message || "no signed URL");
      return r.data.signedUrl;
    },
    async remove(path) {
      const r = await bucket.remove([path]);
      if (r.error) throw new Error(r.error.message);
    },
  };
}

/**
 * Whether a workspace's meetings can be recorded at all: only where a PC
 * transcribes them. Today that is OASIS's own workspaces, the ones the `bea`
 * runner serves (lib/tools/runner-handlers.ts PRODUCER_TENANTS, pinned equal by
 * tests/meet-recording.test.ts). Anywhere else the audio would sit on the relay
 * with nothing to take it, so it is never recorded (Codex on #685, P1).
 */
export function meetRecordingServed(tenantId: string): boolean {
  return OASIS_INTERNAL_TENANT_IDS.has(tenantId);
}

/** All three Meet tables present (bravo__230 and bravo__231)? False = not installed; any other error throws. */
export async function meetRecordingTablesInstalled(db: Client): Promise<boolean> {
  try {
    await db.execute(
      "SELECT (SELECT COUNT(*) FROM meet_rooms WHERE 0) AS r, (SELECT COUNT(*) FROM meet_recording_chunks WHERE 0) AS c, (SELECT COUNT(*) FROM meet_transcripts WHERE 0) AS t",
    );
    return true;
  } catch (err) {
    if (/no such table|no such column/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One speaker's one recorder run, as the PC is given it. */
export type DeclaredSegment = {
  participant_id: string;
  display_name: string;
  segment_id: string;
  started_at_ms: number;
  mime_type: string;
  chunk_count: number;
};

/** One line of a transcript, as the PC sends it (BEA scripts/meet/transcript.py). */
export type TranscriptLine = { at_ms: number; end_ms: number; participant_id: string; speaker: string; text: string };

export type TranscriptStatus = "queued" | "transcribing" | "ready" | "expired" | "deleted" | "lost";

export type MeetTranscript = {
  id: string;
  tenantId: string;
  roomId: string;
  status: TranscriptStatus;
  jobId: string | null;
  segments: DeclaredSegment[];
  chunkCount: number;
  audioBytes: number;
  missingChunks: number;
  text: string | null;
  lines: TranscriptLine[];
  model: string | null;
  transcribeSeconds: number | null;
  deviceLabel: string | null;
  localFolder: string | null;
  relayExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  deletedAt: string | null;
  localDeletedAt: string | null;
  /** The recording browser's own count of chunks it could not upload, and of recorder errors. */
  recorderFailed: number;
  recorderErrored: number;
};

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function jsonArray(v: unknown): unknown[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const TRANSCRIPT_COLUMNS =
  "id, tenant_id, room_id, status, job_id, segments_json, chunk_count, audio_bytes, missing_chunks, text, lines_json, model, " +
  "transcribe_seconds, device_label, local_folder, relay_expires_at, created_at, updated_at, ready_at, deleted_at, local_deleted_at, " +
  "recorder_failed, recorder_errored";

function toTranscript(row: Record<string, unknown>): MeetTranscript {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    roomId: String(row.room_id),
    status: String(row.status) as TranscriptStatus,
    jobId: str(row.job_id),
    segments: jsonArray(row.segments_json) as DeclaredSegment[],
    chunkCount: num(row.chunk_count),
    audioBytes: num(row.audio_bytes),
    missingChunks: num(row.missing_chunks),
    text: str(row.text),
    lines: jsonArray(row.lines_json) as TranscriptLine[],
    model: str(row.model),
    transcribeSeconds: row.transcribe_seconds === null || row.transcribe_seconds === undefined ? null : num(row.transcribe_seconds),
    deviceLabel: str(row.device_label),
    localFolder: str(row.local_folder),
    relayExpiresAt: String(row.relay_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    readyAt: str(row.ready_at),
    deletedAt: str(row.deleted_at),
    localDeletedAt: str(row.local_deleted_at),
    recorderFailed: num(row.recorder_failed),
    recorderErrored: num(row.recorder_errored),
  };
}

/** The room's transcript row, or null before its recording was handed over. */
export async function readTranscript(db: Client, tenantId: string, roomId: string): Promise<MeetTranscript | null> {
  const rs = await db.execute({
    sql: `SELECT ${TRANSCRIPT_COLUMNS} FROM meet_transcripts WHERE tenant_id = ? AND room_id = ? LIMIT 1`,
    args: [tenantId, roomId],
  });
  return rs.rows[0] ? toTranscript(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

type JobState = { status: string; stage: string | null; errorCode: string | null; attempts: number; leaseExpiresAt: string | null };

async function jobState(db: Client, tenantId: string, jobId: string): Promise<JobState | null> {
  const rs = await db.execute({
    sql: "SELECT status, stage, error_code, attempts, lease_expires_at FROM tool_jobs WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [tenantId, jobId],
  });
  const r = rs.rows[0];
  return r
    ? { status: String(r.status), stage: str(r.stage), errorCode: str(r.error_code), attempts: num(r.attempts), leaseExpiresAt: str(r.lease_expires_at) }
    : null;
}

async function relayTotals(db: Client, tenantId: string, roomId: string): Promise<{ chunks: number; bytes: number }> {
  const rs = await db.execute({
    sql: "SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?",
    args: [tenantId, roomId],
  });
  return { chunks: num(rs.rows[0]?.n), bytes: num(rs.rows[0]?.b) };
}

// ---------------------------------------------------------------------------
// 1 RECORD: one chunk
// ---------------------------------------------------------------------------

const RECORDING_MIME = /^audio\/(webm|ogg|mp4)(;codecs=[a-z0-9.]+)?$/;

/** A recorder's MIME type as stored ("audio/webm;codecs=opus"), or null for anything that is not one of ours. */
export function normalizeRecordingMime(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const v = raw.toLowerCase().replace(/\s+/g, "").replace(/"/g, "");
  return RECORDING_MIME.test(v) ? v : null;
}

export type ChunkInput = {
  room: MeetRoom;
  /** The signed-in host whose browser sent it. */
  uploadedBy: string;
  /**
   * The browser that sent it: the participant row its room cookie names (a host row of `uploadedBy`), or null when it
   * names none. One browser records a room (lib/meet/participants.ts claimRecorder), and no other browser still in
   * the call is taken.
   */
  uploader: string | null;
  /** The speaker: whose voice this is (one of the room's participant rows), never the browser that sent it. */
  participantId: string;
  /** The participant row's own name (never the request's). */
  displayName: string;
  segmentId: string;
  seq: number;
  segmentStartedMs: number;
  mimeType: string;
  bytes: Uint8Array;
  now: Date;
};

/**
 * 201 stored; 409 duplicate (the recorder counts it done: the same chunk is
 * already here); 410 recording_closed (the PC already took this recording, or
 * it was deleted); 413 room_full; 423 another_recorder (another browser is
 * recording this room); 502 storage_failed (retried by the recorder).
 */
export type ChunkResult = { ok: true; status: 201 } | { ok: false; status: 409 | 410 | 413 | 423 | 502; error: string };

/**
 * The room's recorder is another browser, and the one sending is still in the call: two browsers would record the
 * same voices. A browser that left or was removed sends its last chunks for LATE_CHUNK_MS after (its recorder
 * stopped as it went, and the next host's took over from there); one that names no participant is refused whenever
 * a browser records the room. While none does (a page opened before the room had a recorder), anyone's is taken.
 */
const ANOTHER_RECORDER = `SELECT 1 FROM meet_rooms r
   WHERE r.tenant_id = ? AND r.id = ? AND r.recorder_participant_id IS NOT NULL AND r.recorder_participant_id IS NOT ?
     AND NOT EXISTS (SELECT 1 FROM meet_participants u
                      WHERE u.tenant_id = r.tenant_id AND u.room_id = r.id AND u.id = ? AND (u.left_at > ? OR u.removed_at > ?))`;

function anotherRecorderArgs(c: ChunkInput): InValue[] {
  const lastChunks = new Date(c.now.getTime() - LATE_CHUNK_MS).toISOString();
  return [c.room.tenantId, c.room.id, c.uploader, c.uploader, lastChunks, lastChunks];
}

/** The conditions a chunk row is written under, checked again inside the INSERT itself. */
function chunkGateSql(): string {
  return `(SELECT COUNT(*) FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?) < ?
      AND (SELECT COALESCE(SUM(bytes), 0) FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?) + ? <= ?
      AND NOT EXISTS (${ANOTHER_RECORDER})
      AND NOT EXISTS (SELECT 1 FROM meet_transcripts WHERE tenant_id = ? AND room_id = ? AND status <> 'queued')`;
}

function chunkGateArgs(c: ChunkInput): InValue[] {
  const t = c.room.tenantId;
  const r = c.room.id;
  return [t, r, MAX_ROOM_CHUNKS, t, r, c.bytes.byteLength, MAX_ROOM_BYTES, ...anotherRecorderArgs(c), t, r];
}

/** Why the gate would refuse this chunk now, or null when it would pass. */
async function chunkRefusal(db: Client, c: ChunkInput): Promise<ChunkResult | null> {
  const t = c.room.tenantId;
  const r = c.room.id;
  const rs = await db.execute({
    sql: `SELECT
            (SELECT status FROM meet_transcripts WHERE tenant_id = ? AND room_id = ?) AS transcript,
            (SELECT COUNT(*) FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?) AS n,
            (SELECT COALESCE(SUM(bytes), 0) FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?) AS b,
            EXISTS (${ANOTHER_RECORDER}) AS others`,
    args: [t, r, t, r, t, r, ...anotherRecorderArgs(c)],
  });
  const row = rs.rows[0] ?? {};
  const transcript = str((row as Record<string, unknown>).transcript);
  if (transcript && transcript !== "queued") return { ok: false, status: 410, error: "recording_closed" };
  if (num((row as Record<string, unknown>).others) > 0) return { ok: false, status: 423, error: "another_recorder" };
  if (num((row as Record<string, unknown>).n) >= MAX_ROOM_CHUNKS) return { ok: false, status: 413, error: "room_full" };
  if (num((row as Record<string, unknown>).b) + c.bytes.byteLength > MAX_ROOM_BYTES) return { ok: false, status: 413, error: "room_full" };
  return null;
}

async function chunkExists(db: Client, c: ChunkInput): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 FROM meet_recording_chunks
          WHERE tenant_id = ? AND room_id = ? AND participant_id = ? AND segment_id = ? AND seq = ? LIMIT 1`,
    args: [c.room.tenantId, c.room.id, c.participantId, c.segmentId, c.seq],
  });
  return rs.rows.length > 0;
}

/** The relay path of one chunk, always under its own workspace and room. */
export function chunkPath(tenantId: string, roomId: string, participantId: string, segmentId: string, seq: number): string {
  return `${tenantId}/${roomId}/${participantId}/${segmentId}/${seq}`;
}

/**
 * Keep one chunk: refused up front if the gate says no (nothing is uploaded),
 * stored in R2, then its row written under the same gate, re-checked in the
 * INSERT. A row that loses a race to the gate leaves an object nothing points
 * at, which is deleted again; one that loses to the same chunk (a retry that
 * crossed) is a duplicate, and the object is that chunk's own.
 */
export async function acceptChunk(db: Client, storage: MeetStorage, c: ChunkInput): Promise<ChunkResult> {
  if (await chunkExists(db, c)) return { ok: false, status: 409, error: "duplicate" };
  const refused = await chunkRefusal(db, c);
  if (refused) return refused;

  const path = chunkPath(c.room.tenantId, c.room.id, c.participantId, c.segmentId, c.seq);
  try {
    await storage.put(path, c.bytes, c.mimeType);
  } catch (err) {
    console.error("[meet.recording] could not store a chunk", {
      tenantId: c.room.tenantId,
      roomId: c.room.id,
      seq: c.seq,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, status: 502, error: "storage_failed" };
  }

  const forget = async (why: string) => {
    try {
      await storage.remove(path);
    } catch (err) {
      console.error(`[meet.recording] could not delete ${why}`, { tenantId: c.room.tenantId, path, error: err instanceof Error ? err.message : String(err) });
    }
  };
  let rs;
  try {
    rs = await db.execute({
      sql: `INSERT INTO meet_recording_chunks (id, tenant_id, room_id, participant_id, display_name, segment_id, seq,
                                               segment_started_ms, mime_type, bytes, storage_path, uploaded_by, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${chunkGateSql()}
            ON CONFLICT (tenant_id, room_id, participant_id, segment_id, seq) DO NOTHING`,
      args: [
        randomUUID(), c.room.tenantId, c.room.id, c.participantId, c.displayName, c.segmentId, c.seq,
        c.segmentStartedMs, c.mimeType, c.bytes.byteLength, path, c.uploadedBy, c.now.toISOString(),
        ...chunkGateArgs(c),
      ],
    });
  } catch (err) {
    // The object is stored but no row says so, and every sweep is row-driven: take it back now (the
    // recorder retries the 500 and puts it again), unless a row for this very chunk exists after all.
    if (!(await chunkExists(db, c).catch(() => true))) await forget("a chunk whose row failed");
    throw err;
  }
  if (rs.rowsAffected === 1) return { ok: true, status: 201 };
  if (await chunkExists(db, c)) return { ok: false, status: 409, error: "duplicate" };
  // The gate closed between the check and the write: the object is nobody's.
  await forget("a refused chunk");
  return (await chunkRefusal(db, c)) ?? { ok: false, status: 410, error: "recording_closed" };
}

// ---------------------------------------------------------------------------
// 2 HAND OVER
// ---------------------------------------------------------------------------

export type HandOver =
  | { state: "unavailable" | "not_ended" | "nothing_recorded" | "ready" | "expired" | "deleted" | "lost" }
  | { state: "queued" | "transcribing"; jobId: string };

function handOverStatements(room: MeetRoom, jobId: string, actorUserId: string | null, relayExpiresAt: string, now: Date): InStatement[] {
  const at = now.toISOString();
  const input = { room_id: room.id, title: room.title };
  return [
    {
      // A first hand-over makes the row; a retry after a failed job points it at the new job. A row that is
      // ready, expired or deleted is never touched, so the job below is not written either.
      sql: `INSERT INTO meet_transcripts (id, tenant_id, room_id, status, job_id, relay_expires_at, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
            ON CONFLICT (tenant_id, room_id) DO UPDATE SET status = 'queued', job_id = excluded.job_id, updated_at = excluded.updated_at
            WHERE meet_transcripts.status IN ('queued', 'transcribing')`,
      args: [randomUUID(), room.tenantId, room.id, jobId, relayExpiresAt, at, at],
    },
    {
      // dedupe_key: one transcription of a room in flight at a time (uq_tool_jobs_tenant_inflight).
      sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, idempotency_key,
                                   dedupe_key, created_by, created_by_email, created_at, updated_at)
            SELECT ?, ?, 'meet_transcribe', 'runner', 'queued', ?, ?, NULL, ?, ?, NULL, ?, ?
            WHERE EXISTS (SELECT 1 FROM meet_transcripts WHERE tenant_id = ? AND room_id = ? AND job_id = ? AND status = 'queued')`,
      args: [
        jobId, room.tenantId, JSON.stringify(input), inputHashOf("meet_transcribe", input), `meet_transcribe:${room.id}`,
        actorUserId, at, at, room.tenantId, room.id, jobId,
      ],
    },
  ];
}

function handOverState(t: MeetTranscript | null): HandOver {
  if (!t) return { state: "nothing_recorded" };
  if (t.status === "queued" || t.status === "transcribing") return { state: t.status, jobId: t.jobId ?? "" };
  return { state: t.status };
}

/**
 * Hand an ended meeting's recording to the PC: its transcript row and a
 * meet_transcribe job. Idempotent: a job already in flight is the answer, and a
 * recording that is ready, expired or deleted is left alone. After a failed job
 * this is the retry. The relay window counts from the meeting's end and is never
 * extended by a retry.
 */
export async function ensureTranscriptJob(db: Client, room: MeetRoom, actorUserId: string | null, now: Date): Promise<HandOver> {
  // No PC transcribes this workspace's meetings: a job would wait forever (meetRecordingServed).
  if (!meetRecordingServed(room.tenantId)) return { state: "unavailable" };
  if (room.status !== "ended") return { state: "not_ended" };
  const t = await readTranscript(db, room.tenantId, room.id);
  if (t && t.status !== "queued" && t.status !== "transcribing") return { state: t.status };
  if (t?.jobId) {
    const job = await jobState(db, room.tenantId, t.jobId);
    if (job && IN_FLIGHT.has(job.status)) return handOverState(t);
  }
  if (!t && (await relayTotals(db, room.tenantId, room.id)).chunks === 0) return { state: "nothing_recorded" };

  const endedMs = room.endedAt && Number.isFinite(Date.parse(room.endedAt)) ? Date.parse(room.endedAt) : now.getTime();
  const relayExpiresAt = new Date(endedMs + RELAY_DAYS * DAY_MS).toISOString();
  try {
    await db.batch(handOverStatements(room, randomUUID(), actorUserId, relayExpiresAt, now), "write");
  } catch (err) {
    // Two hand-overs in the same instant: the batch is one transaction, so the loser wrote nothing.
    if (!UNIQUE_FAILED.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return handOverState(await readTranscript(db, room.tenantId, room.id));
}

// ---------------------------------------------------------------------------
// 3 TRANSCRIBE: the claim, the downloads, the report
// ---------------------------------------------------------------------------

type ChunkRow = {
  participant_id: string;
  display_name: string;
  segment_id: string;
  seq: number;
  segment_started_ms: number;
  mime_type: string;
  bytes: number;
};

/**
 * Every segment that can be decoded, oldest first, with ALL of its chunks, and
 * how many chunks are missing. A segment needs its chunk 0 (the container
 * header); after that a lost chunk is a gap, not the end: WebM clusters and
 * fragmented MP4 carry their own timestamps, so the PC joins what arrived and
 * ffmpeg fills the gap with silence (BEA scripts/meet/transcript.py to_wav),
 * keeping every later word at its true time. Cutting at the first gap instead
 * discarded the rest of that speaker's meeting (#685 review, M2). A segment
 * with no chunk 0 cannot be read at all; its chunks count as missing.
 * missingChunks is in chunks of DEFAULT_TIMESLICE (10 s): the panel says how
 * much audio that is.
 */
export function declareSegments(rows: readonly ChunkRow[]): {
  segments: DeclaredSegment[];
  chunkCount: number;
  audioBytes: number;
  missingChunks: number;
} {
  const groups = new Map<string, ChunkRow[]>();
  for (const r of rows) {
    const key = `${r.participant_id}|${r.segment_id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const segments: DeclaredSegment[] = [];
  let chunkCount = 0;
  let audioBytes = 0;
  let missingChunks = 0;
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    const first = sorted[0];
    if (first.seq !== 0) {
      // No header: none of it can be decoded.
      missingChunks += sorted[sorted.length - 1].seq + 1;
      continue;
    }
    missingChunks += sorted[sorted.length - 1].seq + 1 - sorted.length;
    chunkCount += sorted.length;
    audioBytes += sorted.reduce((n, r) => n + r.bytes, 0);
    segments.push({
      participant_id: first.participant_id,
      display_name: first.display_name,
      segment_id: first.segment_id,
      started_at_ms: first.segment_started_ms,
      mime_type: first.mime_type,
      chunk_count: sorted.length,
    });
  }
  segments.sort((a, b) => a.started_at_ms - b.started_at_ms || a.participant_id.localeCompare(b.participant_id));
  return { segments, chunkCount, audioBytes, missingChunks };
}

async function chunkRows(db: Client, tenantId: string, roomId: string): Promise<Array<ChunkRow & { storage_path: string }>> {
  const rs = await db.execute({
    sql: `SELECT participant_id, display_name, segment_id, seq, segment_started_ms, mime_type, bytes, storage_path
          FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?`,
    args: [tenantId, roomId],
  });
  return rs.rows.map((r) => ({
    participant_id: String(r.participant_id),
    display_name: String(r.display_name),
    segment_id: String(r.segment_id),
    seq: num(r.seq),
    segment_started_ms: num(r.segment_started_ms),
    mime_type: String(r.mime_type),
    bytes: num(r.bytes),
    storage_path: String(r.storage_path),
  }));
}

export type MeetClaim = { input: Record<string, unknown>; queueDepth: number };

/**
 * What a claimed meet_transcribe job is given: the room's title and start, and
 * every segment it gets - fixed HERE, at the claim, so a chunk that arrived
 * after the hand-over is still in it, and download-urls signs exactly this.
 * Null when the job is no longer wanted (the room or its recording is gone, or
 * another job replaced it): the caller ends the job.
 */
export async function meetTranscribeClaim(
  db: Client,
  job: { id: string; tenantId: string; input: Record<string, unknown> },
  tenantIds: readonly string[],
  now: Date,
): Promise<MeetClaim | null> {
  const roomId = typeof job.input.room_id === "string" ? job.input.room_id : "";
  const room = roomId ? await readMeetRoom(db, { tenantId: job.tenantId, roomId }) : null;
  if (!room) return null;
  const at = now.toISOString();
  const where = "tenant_id = ? AND room_id = ? AND job_id = ?";
  // CLOSE FIRST, then read. Once the row says transcribing, the chunk gate
  // refuses every new chunk (it takes them only while queued), so the read below
  // is the whole recording. Reading first left a window where a late chunk was
  // answered 201, missed by this read, and deleted with the relay unheard
  // (#685 review, M1).
  const closed = await db.execute({
    sql: `UPDATE meet_transcripts SET status = 'transcribing', updated_at = ? WHERE ${where} AND status IN ('queued', 'transcribing')`,
    args: [at, room.tenantId, room.id, job.id],
  });
  if (closed.rowsAffected !== 1) return null;
  const declared = declareSegments(await chunkRows(db, room.tenantId, room.id));
  const up = await db.execute({
    sql: `UPDATE meet_transcripts SET segments_json = ?, chunk_count = ?, audio_bytes = ?, missing_chunks = ?, updated_at = ?
           WHERE ${where} AND status = 'transcribing'`,
    args: [
      JSON.stringify(declared.segments), declared.chunkCount, declared.audioBytes, declared.missingChunks, at,
      room.tenantId, room.id, job.id,
    ],
  });
  if (up.rowsAffected !== 1) return null;
  const queued = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM tool_jobs
          WHERE tenant_id IN (${sqlPlaceholders(tenantIds.length)}) AND tool_key = 'meet_transcribe' AND status = 'queued'`,
    args: [...tenantIds],
  });
  const started = room.startedAt && Number.isFinite(Date.parse(room.startedAt)) ? Date.parse(room.startedAt) : null;
  const earliest = declared.segments.length ? Math.min(...declared.segments.map((s) => s.started_at_ms)) : null;
  return {
    input: { room_id: room.id, title: room.title, started_at_ms: started ?? earliest, segments: declared.segments },
    queueDepth: num(queued.rows[0]?.n),
  };
}

export type DownloadFile = { participant_id: string; segment_id: string; seq: number; bytes: number; url: string };

export type DownloadPage = { files: DownloadFile[]; total: number; nextOffset: number | null };

/**
 * One page of signed GET URLs for exactly the chunks the claim declared, in a
 * fixed order (participant, segment, seq), from `offset`, at most `limit`
 * (capped at DOWNLOAD_PAGE_MAX). Paged so a long meeting is neither one
 * multi-megabyte answer nor a set of URLs that expire while the PC is still
 * downloading the first ones (Codex on #685, P2): the PC asks for each page
 * just before it fetches it. The order cannot shift under the pages: the
 * declared set is fixed at the claim, and no relay chunk is deleted before the
 * transcript lands. Null when this job no longer holds the room's recording.
 */
export async function meetDownloadFiles(
  db: Client,
  storage: MeetStorage,
  job: { id: string; tenantId: string; input: Record<string, unknown> },
  page: { offset: number; limit: number } = { offset: 0, limit: DOWNLOAD_PAGE_MAX },
): Promise<DownloadPage | null> {
  const roomId = typeof job.input.room_id === "string" ? job.input.room_id : "";
  const t = roomId ? await readTranscript(db, job.tenantId, roomId) : null;
  if (!t || t.status !== "transcribing" || t.jobId !== job.id) return null;
  // Every chunk of every declared segment: the claim closed the room to new chunks before it declared them,
  // so this is exactly what it counted.
  const declared = new Set(t.segments.map((s) => `${s.participant_id}|${s.segment_id}`));
  const rows = (await chunkRows(db, job.tenantId, roomId))
    .filter((r) => declared.has(`${r.participant_id}|${r.segment_id}`))
    .sort((a, b) => a.participant_id.localeCompare(b.participant_id) || a.segment_id.localeCompare(b.segment_id) || a.seq - b.seq);
  const offset = Math.max(0, Math.floor(page.offset));
  const limit = Math.min(Math.max(1, Math.floor(page.limit)), DOWNLOAD_PAGE_MAX);
  const slice = rows.slice(offset, offset + limit);
  const files: DownloadFile[] = [];
  for (const r of slice) {
    if (!pathBelongsToTenant(job.tenantId, r.storage_path)) throw new Error("a relay chunk's path is outside its workspace");
    files.push({
      participant_id: r.participant_id,
      segment_id: r.segment_id,
      seq: r.seq,
      bytes: r.bytes,
      url: await storage.signedGetUrl(r.storage_path, DOWNLOAD_URL_TTL_SECONDS),
    });
  }
  const next = offset + slice.length;
  return { files, total: rows.length, nextOffset: next < rows.length ? next : null };
}

export type TranscriptReport = {
  text: string;
  lines: TranscriptLine[];
  model: string;
  transcribeSeconds: number;
  deviceLabel: string;
  localFolder: string;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function shortText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim().length >= 1 && v.length <= max && !CONTROL.test(v) ? v : null;
}

function nonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** The PC's transcript report (POST complete for meet_transcribe), every field checked. */
export function parseTranscriptReport(b: Record<string, unknown>): Parsed<TranscriptReport> {
  if (typeof b.transcript_text !== "string" || b.transcript_text.length > MAX_TRANSCRIPT_CHARS) return { ok: false, field: "transcript_text" };
  if (!Array.isArray(b.lines) || b.lines.length > MAX_TRANSCRIPT_LINES) return { ok: false, field: "lines" };
  const lines: TranscriptLine[] = [];
  for (const raw of b.lines) {
    const l = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!l) return { ok: false, field: "lines" };
    const participant = shortText(l.participant_id, 64);
    const speaker = shortText(l.speaker, 120);
    if (!nonNegativeInt(l.at_ms) || !nonNegativeInt(l.end_ms) || l.end_ms < l.at_ms) return { ok: false, field: "lines" };
    if (!participant || !speaker || typeof l.text !== "string" || l.text.length > MAX_LINE_CHARS) return { ok: false, field: "lines" };
    lines.push({ at_ms: l.at_ms, end_ms: l.end_ms, participant_id: participant, speaker, text: l.text });
  }
  if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return { ok: false, field: "model" };
  const seconds = b.transcribe_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 2 * 86_400) return { ok: false, field: "transcribe_seconds" };
  const device = shortText(b.device_label, 120);
  if (!device) return { ok: false, field: "device_label" };
  const folder = shortText(b.local_folder, 500);
  if (!folder) return { ok: false, field: "local_folder" };
  return { ok: true, value: { text: b.transcript_text, lines, model: b.model, transcribeSeconds: seconds, deviceLabel: device, localFolder: folder } };
}

export type LeaseHold = { runnerKey: string; leaseId: string; tenantIds: readonly string[] };

function leaseHolds(jobId: string, lease: LeaseHold): { sql: string; args: InValue[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM tool_jobs WHERE ${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(lease.tenantIds.length)}))`,
    args: [jobId, lease.runnerKey, lease.leaseId, ...lease.tenantIds],
  };
}

/**
 * The transcript and the job's "done", in one transaction: the transcript only
 * while this lease holds the job and the row is still this job's, the job last
 * and only if the transcript landed (rowsAffected 1 on the last = both did). A
 * recording deleted meanwhile writes nothing.
 */
export function meetTranscribeCompleteStatements(
  job: { id: string; tenantId: string },
  roomId: string,
  lease: LeaseHold,
  r: TranscriptReport,
  now: Date,
): InStatement[] {
  const at = now.toISOString();
  const holds = leaseHolds(job.id, lease);
  const tin = sqlPlaceholders(lease.tenantIds.length);
  return [
    {
      sql: `UPDATE meet_transcripts
               SET status = 'ready', text = ?, lines_json = ?, model = ?, transcribe_seconds = ?, device_label = ?, local_folder = ?,
                   ready_at = ?, updated_at = ?
             WHERE tenant_id = ? AND room_id = ? AND job_id = ? AND status = 'transcribing' AND ${holds.sql}`,
      args: [r.text, JSON.stringify(r.lines), r.model, r.transcribeSeconds, r.deviceLabel, r.localFolder, at, at, job.tenantId, roomId, job.id, ...holds.args],
    },
    {
      sql: `UPDATE tool_jobs
               SET status = 'done', stage = NULL, result_json = ?, error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
             WHERE ${LEASE_GUARD} AND tenant_id IN (${tin})
               AND EXISTS (SELECT 1 FROM meet_transcripts WHERE tenant_id = ? AND room_id = ? AND job_id = ? AND status = 'ready')`,
      args: [
        JSON.stringify({ room_id: roomId, lines: r.lines.length, model: r.model }), at, at,
        job.id, lease.runnerKey, lease.leaseId, ...lease.tenantIds, job.tenantId, roomId, job.id,
      ],
    },
  ];
}

export type DeleteLocalReport = { removed: string[]; alreadyGone: boolean; deviceLabel: string };

/** The PC's report that it deleted its copy (POST complete for meet_delete_local). */
export function parseDeleteLocalReport(b: Record<string, unknown>): Parsed<DeleteLocalReport> {
  if (!Array.isArray(b.removed) || b.removed.length > 10) return { ok: false, field: "removed" };
  const removed: string[] = [];
  for (const p of b.removed) {
    const s = shortText(p, 500);
    if (!s) return { ok: false, field: "removed" };
    removed.push(s);
  }
  if (typeof b.already_gone !== "boolean") return { ok: false, field: "already_gone" };
  const device = shortText(b.device_label, 120);
  if (!device) return { ok: false, field: "device_label" };
  return { ok: true, value: { removed, alreadyGone: b.already_gone, deviceLabel: device } };
}

/** The device's deletion stamped on the transcript row, and the job's "done" (the commit signal, last). */
export function meetDeleteLocalCompleteStatements(
  job: { id: string; tenantId: string },
  roomId: string,
  lease: LeaseHold,
  r: DeleteLocalReport,
  now: Date,
): InStatement[] {
  const at = now.toISOString();
  const holds = leaseHolds(job.id, lease);
  return [
    {
      sql: `UPDATE meet_transcripts SET local_deleted_at = ?, device_label = ?, updated_at = ?
             WHERE tenant_id = ? AND room_id = ? AND ${holds.sql}`,
      args: [at, r.deviceLabel, at, job.tenantId, roomId, ...holds.args],
    },
    {
      sql: `UPDATE tool_jobs
               SET status = 'done', stage = NULL, result_json = ?, error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
             WHERE ${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(lease.tenantIds.length)})`,
      args: [
        JSON.stringify({ room_id: roomId, removed: r.removed.length, already_gone: r.alreadyGone }), at, at,
        job.id, lease.runnerKey, lease.leaseId, ...lease.tenantIds,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 4 FORGET, and the sweeps
// ---------------------------------------------------------------------------

/**
 * Delete up to `limit` relay chunks nobody needs any more: those of a
 * recording that is ready, expired or deleted. Never a recording still queued
 * or transcribing: the PC does not have it yet. Object first, then its row, so
 * a failed delete leaves the row to be tried again; stops starting new deletes
 * at the first storage failure (R2 is having a moment; the next run goes on).
 * Driven by the recordings not yet cleared (relay_cleared_at, a partial
 * index), so the cost does not grow with every meeting ever held, and a
 * recording is stamped cleared once its last chunk is gone.
 *
 * A room row deleted outright no longer frees its audio here (that deleted
 * untranscribed audio at once and never told the PC, #685 review M8): a
 * feature that deletes rooms calls deleteMeetRecording first, and the R2
 * lifecycle rule on meet-relay/ is the backstop for anything else.
 *
 * Returns how many were deleted; removeRelayChunksReport also says whether a
 * delete failed, which the relay cron must report (Codex on #685, fourth pass).
 */
export async function removeRelayChunks(
  db: Client,
  storage: MeetStorage | null,
  scope: { tenantIds: readonly string[]; roomId?: string },
  limit: number = RELAY_CLEANUP_BATCH,
  now: Date = new Date(),
): Promise<number> {
  return (await removeRelayChunksReport(db, storage, scope, limit, now)).removed;
}

export async function removeRelayChunksReport(
  db: Client,
  storage: MeetStorage | null,
  scope: { tenantIds: readonly string[]; roomId?: string },
  limit: number = RELAY_CLEANUP_BATCH,
  now: Date = new Date(),
): Promise<{ removed: number; failed: boolean }> {
  if (!storage || !scope.tenantIds.length || limit < 1) return { removed: 0, failed: false };
  const tin = sqlPlaceholders(scope.tenantIds.length);
  const room = scope.roomId ? " AND t.room_id = ?" : "";
  const roomArgs = scope.roomId ? [scope.roomId] : [];
  const rs = await db.execute({
    sql: `SELECT c.id, c.tenant_id, c.storage_path FROM meet_transcripts t
          JOIN meet_recording_chunks c ON c.tenant_id = t.tenant_id AND c.room_id = t.room_id
          WHERE t.tenant_id IN (${tin})${room} AND t.status IN ('ready', 'expired', 'deleted') AND t.relay_cleared_at IS NULL
          LIMIT ?`,
    args: [...scope.tenantIds, ...roomArgs, limit],
  });
  const gone: string[] = [];
  const queue = [...rs.rows];
  let failed = false;
  // A few deletes at a time; after the first failure no new one starts (the rest wait for the next run).
  const worker = async () => {
    for (let row = queue.shift(); row && !failed; row = queue.shift()) {
      const tenantId = String(row.tenant_id);
      const path = String(row.storage_path);
      if (!pathBelongsToTenant(tenantId, path)) {
        console.error("[meet.relay] a chunk row's path is outside its workspace; left alone", { tenantId, id: String(row.id) });
        continue;
      }
      try {
        await storage.remove(path);
        gone.push(String(row.id));
      } catch (err) {
        failed = true;
        console.error("[meet.relay] could not delete a relay chunk", { tenantId, path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RELAY_DELETE_CONCURRENCY, queue.length) }, worker));
  if (gone.length) {
    await db.execute({
      sql: `DELETE FROM meet_recording_chunks WHERE tenant_id IN (${tin}) AND id IN (${sqlPlaceholders(gone.length)})`,
      args: [...scope.tenantIds, ...gone],
    });
  }
  // A finished recording with no chunk left is cleared for good: nothing can add one (the chunk gate takes
  // chunks only while a recording is queued), so later runs never look at it again.
  await db.execute({
    sql: `UPDATE meet_transcripts SET relay_cleared_at = ?
           WHERE tenant_id IN (${tin})${scope.roomId ? " AND room_id = ?" : ""}
             AND status IN ('ready', 'expired', 'deleted') AND relay_cleared_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM meet_recording_chunks c
                             WHERE c.tenant_id = meet_transcripts.tenant_id AND c.room_id = meet_transcripts.room_id)`,
    args: [now.toISOString(), ...scope.tenantIds, ...roomArgs],
  });
  return { removed: gone.length, failed };
}

/**
 * A recording the PC did not take within its 30 days is expired: its job fails
 * (relay_expired) and the row is marked expired, so its chunks go on the next
 * cleanup. Only a job the PC holds RIGHT NOW (a lease that has not lapsed) is
 * left to finish; a claim whose PC vanished is no claim, and must not keep
 * people's voices on the relay past the limit (Codex on #685, second pass).
 * Returns how many recordings expired.
 */
export async function expireRelay(db: Client, tenantIds: readonly string[], now: Date): Promise<number> {
  if (!tenantIds.length) return 0;
  const at = now.toISOString();
  const tin = sqlPlaceholders(tenantIds.length);
  const due = await db.execute({
    sql: `SELECT 1 FROM meet_transcripts WHERE tenant_id IN (${tin}) AND status IN ('queued', 'transcribing') AND relay_expires_at < ? LIMIT 1`,
    args: [...tenantIds, at],
  });
  if (!due.rows.length) return 0;
  const results = await db.batch(
    [
      {
        sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'relay_expired', error_message = ?, finished_at = ?, updated_at = ?
               WHERE tenant_id IN (${tin}) AND tool_key = 'meet_transcribe'
                 AND (status = 'queued' OR (status IN ('claimed', 'running') AND lease_expires_at < ?))
                 AND EXISTS (SELECT 1 FROM meet_transcripts t
                             WHERE t.tenant_id = tool_jobs.tenant_id AND t.job_id = tool_jobs.id AND t.relay_expires_at < ?)`,
        args: [toolErrorLine("relay_expired", "runner"), at, at, ...tenantIds, at, at],
      },
      {
        sql: `UPDATE meet_transcripts SET status = 'expired', segments_json = '[]', updated_at = ?
               WHERE tenant_id IN (${tin}) AND status IN ('queued', 'transcribing') AND relay_expires_at < ?
                 AND NOT EXISTS (SELECT 1 FROM tool_jobs j
                                 WHERE j.tenant_id = meet_transcripts.tenant_id AND j.id = meet_transcripts.job_id
                                   AND (j.status = 'queued' OR (j.status IN ('claimed', 'running') AND j.lease_expires_at >= ?)))
               RETURNING tenant_id, room_id, local_folder`,
        args: [at, ...tenantIds, at, at],
      },
    ],
    "write",
  );
  const rows = results[1].rows;
  // A PC that claimed one of these and then vanished may hold a partial copy: tell it to delete that too
  // (only where a transcription was ever claimed; deviceDeleteStatement checks).
  for (const r of rows) {
    await db.execute(
      deviceDeleteStatement({ tenantId: String(r.tenant_id), roomId: String(r.room_id), title: null, localFolder: str(r.local_folder) }, null, now),
    );
  }
  if (rows.length) console.warn("[meet.relay] recordings expired before the PC took them", { count: rows.length });
  return rows.length;
}

/**
 * A recording nobody ever handed over that has been quiet for the relay's 30
 * days (its browser never finalized and no PC's claim took it in time) gets a
 * row of its own, expired, so the cleanup deletes its chunks. Without it such
 * audio had no row to be found by and stayed on the relay for good (Codex on
 * #685, second pass). Measured from its newest chunk, so a room that never
 * ended is covered too. `tenantIds` null: every workspace (the relay cron).
 */
export async function expireUnfinalized(db: Client, tenantIds: readonly string[] | null, now: Date): Promise<number> {
  if (tenantIds && !tenantIds.length) return 0;
  const at = now.toISOString();
  const scope = tenantIds ? ` AND c.tenant_id IN (${sqlPlaceholders(tenantIds.length)})` : "";
  const rs = await db.execute({
    sql: `INSERT OR IGNORE INTO meet_transcripts (id, tenant_id, room_id, status, relay_expires_at, created_at, updated_at)
          SELECT lower(hex(randomblob(16))), c.tenant_id, c.room_id, 'expired', ?, ?, ?
            FROM meet_recording_chunks c
           WHERE NOT EXISTS (SELECT 1 FROM meet_transcripts t WHERE t.tenant_id = c.tenant_id AND t.room_id = c.room_id)${scope}
           GROUP BY c.tenant_id, c.room_id
          HAVING MAX(c.created_at) < ?
           LIMIT 50`,
    args: [at, at, at, ...(tenantIds ?? []), new Date(now.getTime() - RELAY_DAYS * DAY_MS).toISOString()],
  });
  if (rs.rowsAffected) console.warn("[meet.relay] recordings never handed over expired", { count: rs.rowsAffected });
  return rs.rowsAffected;
}

/** What the recording browser said about its own losses at the end (lib/meet/recorder.ts StopReport). */
export type RecorderReport = { failed: number; errored: number };

/**
 * The recording browser says it lost audio and not one chunk reached the relay:
 * a row of its own, 'lost', so the panel says the recording failed instead of
 * "Nothing was recorded" (Codex on #685, fourth pass). Only where no chunk
 * exists and no row does yet.
 */
export async function recordTotalLoss(db: Client, room: MeetRoom, report: RecorderReport, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const rs = await db.execute({
    sql: `INSERT INTO meet_transcripts (id, tenant_id, room_id, status, relay_expires_at, created_at, updated_at, recorder_failed, recorder_errored)
          SELECT ?, ?, ?, 'lost', ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?)
          ON CONFLICT (tenant_id, room_id) DO NOTHING`,
    args: [randomUUID(), room.tenantId, room.id, at, at, at, report.failed, report.errored, room.tenantId, room.id],
  });
  return rs.rowsAffected === 1;
}

/**
 * Keep the recording browser's own count of what it lost. Chunks that never
 * reached the server leave a gap in the rows only when later ones did: a lost
 * last chunk or a whole lost segment leaves no trace, so without this the
 * panel would present an incomplete transcript as whole (Codex on #685,
 * second pass). The highest count reported is kept.
 */
export async function recordRecorderReport(db: Client, room: MeetRoom, report: RecorderReport, now: Date): Promise<void> {
  if (!(report.failed > 0 || report.errored > 0)) return;
  await db.execute({
    sql: `UPDATE meet_transcripts SET recorder_failed = MAX(recorder_failed, ?), recorder_errored = MAX(recorder_errored, ?), updated_at = ?
           WHERE tenant_id = ? AND room_id = ?`,
    args: [report.failed, report.errored, now.toISOString(), room.tenantId, room.id],
  });
}

/**
 * Hand over the recordings of meetings that ended LATE_CHUNK_MS ago or more
 * and were never handed over (the host's browser closed before it could say
 * so). At most `limit` per call. Only meetings that ended within the relay's
 * window: older ones are past their 30 days, and without the bound every claim
 * would re-check every meeting ever held.
 */
export async function finalizeDueRooms(
  db: Client,
  tenantIds: readonly string[],
  now: Date,
  limit: number = FINALIZE_SWEEP_BATCH,
): Promise<number> {
  if (!tenantIds.length) return 0;
  const rs = await db.execute({
    sql: `SELECT r.tenant_id, r.id FROM meet_rooms r
          WHERE r.tenant_id IN (${sqlPlaceholders(tenantIds.length)}) AND r.status = 'ended' AND r.ended_at < ? AND r.ended_at > ?
            AND EXISTS (SELECT 1 FROM meet_recording_chunks c WHERE c.tenant_id = r.tenant_id AND c.room_id = r.id)
            AND NOT EXISTS (SELECT 1 FROM meet_transcripts t WHERE t.tenant_id = r.tenant_id AND t.room_id = r.id)
          ORDER BY r.ended_at ASC LIMIT ?`,
    args: [
      ...tenantIds,
      new Date(now.getTime() - LATE_CHUNK_MS).toISOString(),
      new Date(now.getTime() - RELAY_DAYS * DAY_MS).toISOString(),
      limit,
    ],
  });
  let handed = 0;
  for (const row of rs.rows) {
    const room = await readMeetRoom(db, { tenantId: String(row.tenant_id), roomId: String(row.id) });
    if (!room) continue;
    const out = await ensureTranscriptJob(db, room, null, now);
    if (out.state === "queued") handed += 1;
  }
  return handed;
}

/**
 * How long after a room ends the sweeps keep cutting the media sessions its rows still hold; how many rooms and
 * sessions a run. A day, oldest first: after an SFU outage a backlog drains in order, so nothing deferred ages out
 * before its turn (Codex on #688, third pass).
 */
export const ENDED_CUT_RETRY_MS = 24 * 60 * 60_000;
const ENDED_CUT_BATCH = 10;
const ENDED_CUT_SESSIONS = 20;
let noSfuLogged = false;

/** This Worker's SFU client, or null when no Realtime app is set (nothing could have been connected through it). */
export function meetSfuIfConfigured(): SfuClient | null {
  try {
    return sfuClient();
  } catch (err) {
    if (err instanceof MeetNotConfiguredError) return null;
    throw err;
  }
}

/**
 * Cut the media sessions still held by the rows of rooms that ended within ENDED_CUT_RETRY_MS (oldest first),
 * whatever ended them:
 * a room this sweep just ended (nobody polls it, so no request ever cuts it), or one whose own cut failed. A browser
 * that stopped polling but kept its WebRTC connection must not go on sending or hearing media in an ended room
 * (Codex on #688, P1). The same steps as lib/meet/handlers.ts cutHeld: forgetSession only after a cut went through,
 * so a cut that fails keeps its id for the next run: the PC's claim every minute (OASIS's workspaces), and the
 * relay cron every 5 minutes for every workspace (`tenantIds` null), with or without the PC.
 *
 * Every cut of a run goes at once (at most ENDED_CUT_SESSIONS): an SFU that does not answer costs one timeout per
 * run, never one per room, so the relay work after it still runs (Codex on #688). Returns how many went through and
 * how many failed, so the cron can say a run that left media open is a failed run.
 *
 * Known limit, chosen: sessions the SFU refuses again and again (not an outage, which every run retries alike) stay
 * at the front of the oldest-first batch, so with more than ENDED_CUT_SESSIONS of them later rooms wait. Every such
 * run answers 503 media_cut_failed, so the driver reports it while it lasts (Codex on #688, fifth pass).
 */
async function cutEndedRoomSessions(
  db: Client,
  sfu: SfuClient | null,
  tenantIds: readonly string[] | null,
  now: Date,
): Promise<{ cut: number; failed: number }> {
  const none = { cut: 0, failed: 0 };
  if (tenantIds && !tenantIds.length) return none;
  const scope = tenantIds ? `r.tenant_id IN (${sqlPlaceholders(tenantIds.length)}) AND ` : "";
  const rs = await db.execute({
    sql: `SELECT r.tenant_id, r.id FROM meet_rooms r
           WHERE ${scope}r.status = 'ended' AND r.ended_at > ?
             AND EXISTS (SELECT 1 FROM meet_participants p WHERE p.tenant_id = r.tenant_id AND p.room_id = r.id AND p.sfu_session_id IS NOT NULL)
           ORDER BY r.ended_at ASC LIMIT ?`,
    args: [...(tenantIds ?? []), new Date(now.getTime() - ENDED_CUT_RETRY_MS).toISOString(), ENDED_CUT_BATCH],
  });
  if (!rs.rows.length) return none;
  if (!sfu) {
    // Sessions were opened, so an SFU app was set then: its secret is gone now (a rotation, a lost push). Nothing
    // can be cut until it is back, and the run says so, never "healthy" (Codex on #688, third pass).
    if (!noSfuLogged) console.error("[meet.relay] no SFU app is set; sessions held by ended rooms cannot be cut");
    noSfuLogged = true;
    return { cut: 0, failed: rs.rows.length };
  }
  const rooms = rs.rows.map((row) => ({ tenantId: String(row.tenant_id), id: String(row.id) }));
  const held = (await Promise.all(rooms.map(async (room) => (await roomSessions(db, room)).map((h) => ({ room, h })))))
    .flat()
    .slice(0, ENDED_CUT_SESSIONS);
  const results = await Promise.allSettled(held.map(async ({ room, h }) => {
    if (!(await cutSession(sfu, h.sessionId, "relay.ended_room"))) return false;
    await forgetSession(db, room, h);
    return true;
  }));
  const cut = results.filter((r) => r.status === "fulfilled" && r.value).length;
  return { cut, failed: results.length - cut };
}

/**
 * The sweeps, in the order they feed each other. The runner's claim runs them while it serves meetings. A call
 * left with no host and nobody polling (every tab closed without End) is ended first (lib/meet/participants.ts
 * endAbandonedRooms), so finalizeDueRooms hands its recording over 10 minutes later. Without it such a room stayed
 * live, was never handed over, and its audio expired untranscribed after 30 days (#687 review, Codex P1). The media
 * sessions of ended rooms are cut next (cutEndedRoomSessions), since no request will.
 */
export async function meetRelaySweeps(
  db: Client,
  storage: MeetStorage | null,
  tenantIds: readonly string[],
  now: Date,
  sfu: SfuClient | null = null,
): Promise<void> {
  await endAbandonedRooms(db, tenantIds, now);
  await cutEndedRoomSessions(db, sfu, tenantIds, now);
  await expireUnfinalized(db, tenantIds, now);
  await expireRelay(db, tenantIds, now);
  await finalizeDueRooms(db, tenantIds, now);
  await removeRelayChunks(db, storage, { tenantIds }, RELAY_CLEANUP_BATCH, now);
}

/**
 * The relay's own upkeep, for GET /api/cron/meet-relay (every 5 minutes, from
 * the oasis-cc-cron Worker): expire what is overdue and delete what nobody
 * needs, in every workspace that has any, WITHOUT the PC. A recording the host
 * deleted, or one the PC never came back for, must not wait for the PC to
 * leave the relay (Codex on #685, P1). Handing a recording over stays the PC's
 * claim (finalizeDueRooms): it only means something where a PC takes it. A
 * call every tab left without End is ended here too (endAbandonedRooms), and
 * the media sessions ended rooms still hold are cut, for every workspace:
 * neither may wait for the PC.
 */
export async function meetRelayCron(
  db: Client,
  storage: MeetStorage | null,
  now: Date,
  sfu: SfuClient | null = null,
): Promise<{ tenants: number; expired: number; removed: number; deleteFailed: boolean; mediaCut: number; mediaCutFailed: number }> {
  const at = now.toISOString();
  // A call every tab left without End is ended here too, in every workspace with a live room, so the cut below
  // reaches its media with the PC off (Codex on #688, fourth pass). Handing its recording over stays the PC's claim.
  // Every workspace with a live room, no cap: a capped, unordered list could return the same ones each run and never
  // reach a later workspace's abandoned call (Codex on #688, fifth pass). The workspaces number in the tens.
  const live = await db.execute({ sql: "SELECT DISTINCT tenant_id FROM meet_rooms WHERE status = 'live'", args: [] });
  if (live.rows.length) await endAbandonedRooms(db, live.rows.map((r) => String(r.tenant_id)), now);
  const media = await cutEndedRoomSessions(db, sfu, null, now);
  const cuts = { mediaCut: media.cut, mediaCutFailed: media.failed };
  // First, give a row to every recording nobody handed over that is past its 30 days, so the reads below find it.
  const abandoned = await expireUnfinalized(db, null, now);
  const rs = await db.execute({
    sql: `SELECT DISTINCT tenant_id FROM meet_transcripts
           WHERE (status IN ('ready', 'expired', 'deleted') AND relay_cleared_at IS NULL)
              OR (status IN ('queued', 'transcribing') AND relay_expires_at < ?)
          LIMIT 50`,
    args: [at],
  });
  const tenantIds = rs.rows.map((r) => String(r.tenant_id));
  if (!tenantIds.length) return { tenants: 0, expired: abandoned, removed: 0, deleteFailed: false, ...cuts };
  const expired = abandoned + (await expireRelay(db, tenantIds, now));
  const cleanup = await removeRelayChunksReport(db, storage, { tenantIds }, RELAY_DELETE_BATCH, now);
  return { tenants: tenantIds.length, expired, removed: cleanup.removed, deleteFailed: cleanup.failed, ...cuts };
}

// ---------------------------------------------------------------------------
// The host's delete
// ---------------------------------------------------------------------------

export type DeleteOutcome = { relayRemaining: number; deviceDeleteQueued: boolean };

/**
 * Tell the PC to delete its copy of a meeting (a meet_delete_local job), but
 * only if it may have one: a transcription of this room was ever claimed. Not
 * twice at once, and not again once it has confirmed. Used when the host
 * deletes a recording, and when a recording the PC had claimed expires (its PC
 * vanished mid-way, so a partial copy may sit in its Meetings folder: Codex on
 * #685, fourth pass). The PC finds the folder by `local_folder`, else by room.
 */
function deviceDeleteStatement(
  rec: { tenantId: string; roomId: string; title: string | null; localFolder: string | null },
  actorUserId: string | null,
  now: Date,
): InStatement {
  const at = now.toISOString();
  const transcribeKey = `meet_transcribe:${rec.roomId}`;
  const deleteKey = `meet_delete_local:${rec.roomId}`;
  const input = { room_id: rec.roomId, title: rec.title, local_folder: rec.localFolder };
  return {
    sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, idempotency_key,
                                 dedupe_key, created_by, created_by_email, created_at, updated_at)
          SELECT ?, ?, 'meet_delete_local', 'runner', 'queued', ?, ?, NULL, ?, ?, NULL, ?, ?
          WHERE EXISTS (SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'meet_transcribe' AND dedupe_key = ? AND attempts > 0)
            AND NOT EXISTS (SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('queued', 'claimed', 'running'))
            AND NOT EXISTS (SELECT 1 FROM meet_transcripts WHERE tenant_id = ? AND room_id = ? AND local_deleted_at IS NOT NULL)`,
    args: [
      randomUUID(), rec.tenantId, JSON.stringify(input), inputHashOf("meet_delete_local", input), deleteKey, actorUserId, at, at,
      rec.tenantId, transcribeKey, rec.tenantId, deleteKey, rec.tenantId, rec.roomId,
    ],
  };
}

/**
 * Delete a meeting's recording and transcript, for good: the transcript text
 * goes now, a transcription in flight is called off (meeting_deleted), the PC is
 * told to delete its own copy if it may have one (a transcription of this room
 * was ever claimed), and the relay chunks go - the first batch here, the rest
 * on the next sweeps. The row stays, as status 'deleted', so the recording can
 * never be handed over again.
 */
export async function deleteMeetRecording(
  db: Client,
  storage: MeetStorage | null,
  room: MeetRoom,
  actorUserId: string,
  now: Date,
): Promise<DeleteOutcome> {
  const at = now.toISOString();
  const t = await readTranscript(db, room.tenantId, room.id);
  const transcribeKey = `meet_transcribe:${room.id}`;
  const deleteKey = `meet_delete_local:${room.id}`;
  await db.batch(
    [
      {
        sql: `INSERT INTO meet_transcripts (id, tenant_id, room_id, status, relay_expires_at, created_at, updated_at, deleted_at)
              VALUES (?, ?, ?, 'deleted', ?, ?, ?, ?)
              ON CONFLICT (tenant_id, room_id) DO UPDATE SET
                status = 'deleted', text = NULL, lines_json = NULL, segments_json = '[]',
                deleted_at = COALESCE(meet_transcripts.deleted_at, excluded.deleted_at), updated_at = excluded.updated_at`,
        args: [randomUUID(), room.tenantId, room.id, at, at, at, at],
      },
      {
        sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'meeting_deleted', error_message = ?, finished_at = ?, updated_at = ?
               WHERE tenant_id = ? AND tool_key = 'meet_transcribe' AND dedupe_key = ? AND status IN ('queued', 'claimed', 'running')`,
        args: [toolErrorLine("meeting_deleted", "runner"), at, at, room.tenantId, transcribeKey],
      },
      deviceDeleteStatement({ tenantId: room.tenantId, roomId: room.id, title: room.title, localFolder: t?.localFolder ?? null }, actorUserId, now),
    ],
    "write",
  );
  // The first RELAY_DELETE_BATCH go now; the panel asks again while any are left, and the relay cron
  // (every 5 minutes) finishes the rest whether or not anyone is watching.
  await removeRelayChunks(db, storage, { tenantIds: [room.tenantId], roomId: room.id }, RELAY_DELETE_BATCH, now);
  const left = await relayTotals(db, room.tenantId, room.id);
  const queued = await db.execute({
    sql: "SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('queued', 'claimed', 'running') LIMIT 1",
    args: [room.tenantId, deleteKey],
  });
  return { relayRemaining: left.chunks, deviceDeleteQueued: queued.rows.length > 0 };
}

// ---------------------------------------------------------------------------
// What the meeting's panel shows
// ---------------------------------------------------------------------------

export type MeetRecordingState =
  | "lost"
  | "unavailable"
  | "off"
  | "none"
  | "recording"
  | "waiting"
  | "transcribing"
  | "ready"
  | "failed"
  | "expired"
  | "deleted";

export type MeetRecordingView = {
  state: MeetRecordingState;
  /** Chunks and bytes still on the relay. */
  relayChunks: number;
  relayBytes: number;
  /**
   * Chunks of audio missing from the transcript: the larger of the gaps the
   * rows show and the count the recording browser reported (a lost last chunk
   * or a whole lost segment shows in the report only).
   */
  missingChunks: number;
  /** Recorder errors the browser reported: part of the audio may be missing, by an amount nobody can count. */
  recorderErrored: number;
  relayExpiresAt: string | null;
  job: JobState | null;
  /** The PC that transcribes meetings, when it checked in during the last 10 minutes. */
  runner: { label: string; lastSeenAt: string } | null;
  transcript: {
    /** Each line's at_ms and end_ms are on the meeting's wall clock (ms since the epoch). */
    lines: TranscriptLine[];
    /** The PC's own rendering, "[hh:mm:ss] Name: words" per line, timed from startedAtMs. */
    text: string | null;
    /** When the meeting started, the zero of the [hh:mm:ss] times. */
    startedAtMs: number | null;
    model: string | null;
    deviceLabel: string | null;
    /** The folder's own name only: the full path names the PC's user account. */
    folderName: string | null;
    readyAt: string | null;
    transcribeSeconds: number | null;
  } | null;
  /**
   * After a delete, the PC's own copy: not_needed (the PC never took this
   * recording), waiting (told, not done yet: it does it when it is next on),
   * done, or failed (errorCode says why; Delete again tells it again). Null
   * until the recording is deleted. The panel says "deleted" only for what is.
   */
  deviceDelete: { status: "not_needed" | "waiting" | "done" | "failed"; errorCode: string | null; doneAt: string | null } | null;
};

/** The recording of one room, as its host sees it. Expires an overdue recording first, so the panel never shows a stale wait. */
export async function meetRecordingView(db: Client, room: MeetRoom, now: Date): Promise<MeetRecordingView> {
  let t = await readTranscript(db, room.tenantId, room.id);
  if (t && (t.status === "queued" || t.status === "transcribing") && t.relayExpiresAt < now.toISOString()) {
    await expireRelay(db, [room.tenantId], now);
    t = await readTranscript(db, room.tenantId, room.id);
  }
  const relay = await relayTotals(db, room.tenantId, room.id);
  const job = t?.jobId ? await jobState(db, room.tenantId, t.jobId) : null;
  const live = await liveRunnerForTool(db, room.tenantId, "meet_transcribe", now);

  let state: MeetRecordingState;
  if (!t && relay.chunks === 0 && !meetRecordingServed(room.tenantId)) state = "unavailable";
  else if (!t) state = relay.chunks > 0 ? (room.status === "ended" ? "waiting" : "recording") : room.recordAudio ? "none" : "off";
  else if (t.status === "queued" || t.status === "transcribing") {
    // Transcribing only while a PC holds it now: a claim whose lease lapsed (the PC crashed or went off) is
    // waiting to be taken again, not being worked on (Codex on #685, third pass).
    const held = (job?.status === "claimed" || job?.status === "running") && !!job.leaseExpiresAt && job.leaseExpiresAt >= now.toISOString();
    state = !job || job.status === "failed" ? "failed" : held ? "transcribing" : "waiting";
  } else state = t.status;

  const folderName = t?.localFolder ? (t.localFolder.split(/[\\/]/).filter(Boolean).pop() ?? null) : null;
  return {
    state,
    relayChunks: relay.chunks,
    relayBytes: relay.bytes,
    missingChunks: Math.max(t?.missingChunks ?? 0, t?.recorderFailed ?? 0),
    recorderErrored: t?.recorderErrored ?? 0,
    relayExpiresAt: t?.relayExpiresAt ?? null,
    job,
    runner: live ? { label: live.label, lastSeenAt: live.lastSeenAt } : null,
    transcript:
      t && t.status === "ready"
        ? {
            lines: t.lines,
            text: t.text,
            startedAtMs: room.startedAt && Number.isFinite(Date.parse(room.startedAt)) ? Date.parse(room.startedAt) : null,
            model: t.model,
            deviceLabel: t.deviceLabel,
            folderName,
            readyAt: t.readyAt,
            transcribeSeconds: t.transcribeSeconds,
          }
        : null,
    // A deleted recording, and an expired one the PC had claimed, each tell the PC to delete its copy.
    deviceDelete: t?.status === "deleted" || t?.status === "expired" ? await deviceDeleteState(db, room, t) : null,
  };
}

async function deviceDeleteState(db: Client, room: MeetRoom, t: MeetTranscript): Promise<NonNullable<MeetRecordingView["deviceDelete"]>> {
  if (t.localDeletedAt) return { status: "done", errorCode: null, doneAt: t.localDeletedAt };
  const rs = await db.execute({
    sql: `SELECT status, error_code FROM tool_jobs
          WHERE tenant_id = ? AND tool_key = 'meet_delete_local' AND dedupe_key = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
    args: [room.tenantId, `meet_delete_local:${room.id}`],
  });
  const job = rs.rows[0];
  if (!job) return { status: "not_needed", errorCode: null, doneAt: null };
  const status = String(job.status);
  if (status === "failed") return { status: "failed", errorCode: str(job.error_code), doneAt: null };
  // "done" with no stamp cannot happen (the stamp and the done commit together); read it as still waiting.
  return { status: "waiting", errorCode: null, doneAt: null };
}
