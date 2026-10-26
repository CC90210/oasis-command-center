/**
 * lib/meet/recording-routes.ts - the host's four recording routes, as plain
 * handlers taking {db, storage, now, resolveSession} so tests drive them on a
 * local database with a fake store. The routes under app/api/meet/[code]/ are
 * thin wrappers.
 *
 *   POST   /api/meet/<code>/recording/chunk     one chunk from the recording browser (lib/meet/recorder.ts)
 *   POST   /api/meet/<code>/recording/finalize  hand the ended meeting's recording to the PC, or retry a failed one
 *   GET    /api/meet/<code>/recording           what the meeting's panel shows: the state and the transcript
 *   DELETE /api/meet/<code>/recording           delete the recording and the transcript, here and on the PC
 *
 * All four are the host's only (requireMeetHost: 401 signed out, 404 another
 * workspace's room or none, 403 a member who is not its host). They sit under
 * /api/meet/, which middleware lets guests through to, so each handler
 * authenticates itself first; the three writes also refuse a cross-site
 * request (sameOrigin).
 *
 * The chunk route's answers are the recorder's contract (lib/meet/recorder.ts
 * uploadToRoom): 2xx and 409 are done, 408/425/429/5xx are retried, any other
 * status is a chunk that will never be kept, counted as failed in its report.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/calendar/http";
import { MEET_COOKIE, meetTokenConfigured, readMeetParticipant, requireMeetHost, verifyMeetToken } from "./access";
import {
  LATE_CHUNK_MS,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_SEQ,
  acceptChunk,
  deleteMeetRecording,
  ensureTranscriptJob,
  meetLocalCopiesInstalled,
  meetRecordingServed,
  meetRecordingTablesInstalled,
  meetRecordingView,
  meetRelayCron,
  normalizeRecordingMime,
  recordRecorderReport,
  recordTotalLoss,
  type MeetStorage,
  type RecorderReport,
} from "./recording";
import type { MeetRoom } from "./rooms";
import type { SfuClient } from "./sfu";

export type RecordingDeps = {
  db: Client;
  /** null: R2 is not configured, so no chunk can be kept. */
  storage: MeetStorage | null;
  now: () => Date;
  /** Tests pass a session; production reads the signed-in one. */
  resolveSession?: Parameters<typeof requireMeetHost>[2];
};

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { ok: false, error, ...extra });
const notInstalled = (detail: string) => refuse(503, "not_installed", { detail });

/** A participant or segment id as the recorder sends it: it becomes part of a storage path, so nothing else. */
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_MS = 86_400_000;
/** How far ahead of the server's clock a recording browser's clock may be. */
const CLOCK_SKEW_MS = 5 * 60_000;
const FINALIZE_BODY_MAX = 4096;

/** The request body as bytes, or null past `max` (the read stops there: the rest is never buffered). */
async function readBytesCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** One cookie's value from the request's Cookie header. */
function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The browser sending a chunk: the participant its room cookie names (the cookie's Path is the room's API, which
 * this route is under), when that row is this signed-in host's own host row in this room. Null for anything else:
 * no cookie, another room's, or another person's row. The chunk gate takes audio only from the room's recorder.
 */
async function sendingBrowser(db: Client, req: Request, room: MeetRoom, userId: string, now: Date): Promise<string | null> {
  if (!meetTokenConfigured()) return null;
  const claims = verifyMeetToken(cookieOf(req, MEET_COOKIE), now.getTime());
  if (!claims || claims.roomId !== room.id) return null;
  const row = await readMeetParticipant(db, { tenantId: room.tenantId, roomId: room.id, participantId: claims.participantId });
  return row && row.role === "host" && row.userId === userId ? row.id : null;
}

/**
 * The host, and the tables the route needs: the three recording tables for recording, the hand-over and the
 * panel; with bravo__240's for Delete only, which tells each computer that holds a copy (meetLocalCopiesInstalled).
 * A deploy that lands before bravo__240 therefore never stops a live meeting's uploads.
 */
async function host(
  req: Request,
  rawCode: string,
  deps: RecordingDeps,
  write: boolean,
  installed: (db: Client) => Promise<boolean> = meetRecordingTablesInstalled,
) {
  if (write && !sameOrigin(req)) return { ok: false as const, response: refuse(403, "cross_origin") };
  const h = await requireMeetHost(deps.db, rawCode, deps.resolveSession);
  if (!h.ok) return h;
  if (!(await installed(deps.db))) return { ok: false as const, response: notInstalled("tables_missing") };
  return h;
}

// ---------------------------------------------------------------------------
// POST /api/meet/<code>/recording/chunk
// ---------------------------------------------------------------------------

export async function handleMeetChunk(req: Request, rawCode: string, deps: RecordingDeps): Promise<Response> {
  const h = await host(req, rawCode, deps, true);
  if (!h.ok) return h.response;
  const room = h.room;
  // No PC transcribes this workspace's meetings, so its audio would only sit on the relay (meetRecordingServed).
  if (!meetRecordingServed(room.tenantId)) return refuse(403, "recording_unavailable");
  if (!deps.storage) return notInstalled("storage_not_configured");
  if (!room.recordAudio) return refuse(403, "recording_off");

  const now = deps.now();
  // Taken while the meeting is live, and for LATE_CHUNK_MS after it ends (the recorder's last uploads).
  // A room no host has opened yet is not recording: 425, which the recorder retries briefly.
  if (room.status === "scheduled") return refuse(425, "not_live");
  if (room.status === "ended") {
    const ended = room.endedAt ? Date.parse(room.endedAt) : Number.NaN;
    if (!Number.isFinite(ended) || now.getTime() - ended > LATE_CHUNK_MS) return refuse(410, "recording_closed");
  }

  const headers = req.headers;
  const participantId = headers.get("x-meet-participant") ?? "";
  if (!ID_RE.test(participantId)) return refuse(422, "invalid_payload", { field: "participant" });
  const segmentId = headers.get("x-meet-segment") ?? "";
  if (!ID_RE.test(segmentId)) return refuse(422, "invalid_payload", { field: "segment" });
  const seqRaw = headers.get("x-meet-seq") ?? "";
  const seq = /^\d{1,6}$/.test(seqRaw) ? Number(seqRaw) : -1;
  if (seq < 0 || seq > MAX_CHUNK_SEQ) return refuse(422, "invalid_payload", { field: "seq" });
  const startedRaw = headers.get("x-meet-segment-started-at") ?? "";
  const startedMs = /^\d{1,15}$/.test(startedRaw) ? Number(startedRaw) : -1;
  const earliest = Date.parse(room.createdAt) - DAY_MS;
  if (!(startedMs >= earliest && startedMs <= now.getTime() + CLOCK_SKEW_MS)) {
    return refuse(422, "invalid_payload", { field: "segment_started_at" });
  }
  const mimeType = normalizeRecordingMime(headers.get("content-type"));
  if (!mimeType) return refuse(415, "unsupported_type");

  const declared = Number(headers.get("content-length") || "0");
  if (declared > MAX_CHUNK_BYTES) return refuse(413, "chunk_too_large");
  const bytes = await readBytesCapped(req, MAX_CHUNK_BYTES);
  if (bytes === null) return refuse(413, "chunk_too_large");
  if (bytes.byteLength === 0) return refuse(422, "invalid_payload", { field: "body" });

  // The speaker must be one of this room's participants, and the name kept is their row's own (never the
  // request's): it labels their lines in the transcript.
  const participant = await readMeetParticipant(deps.db, { tenantId: room.tenantId, roomId: room.id, participantId });
  if (!participant) return refuse(422, "invalid_payload", { field: "participant" });
  // No voice reaches the relay without its consent on record (Law 25): every row of a recorded room gets
  // consent_at at join, a guest's only after they tick the notice (1c's PR 1), so NULL here is a client
  // that started recording too early, and the answer is final.
  if (!participant.consentAt) return refuse(403, "consent_missing");

  const out = await acceptChunk(deps.db, deps.storage, {
    room,
    uploadedBy: h.userId,
    uploader: await sendingBrowser(deps.db, req, room, h.userId, now),
    participantId,
    displayName: participant.displayName,
    segmentId,
    seq,
    segmentStartedMs: startedMs,
    mimeType,
    bytes,
    now,
  });
  return out.ok ? json(201, { ok: true }) : refuse(out.status, out.error);
}

// ---------------------------------------------------------------------------
// POST /api/meet/<code>/recording/finalize
// ---------------------------------------------------------------------------

/**
 * Hand an ended meeting's recording to the PC. The recording browser calls it
 * right after End, with its recorder's report ({sent, failed, segments,
 * errored}), which is logged when anything was lost; the Retry on a failed
 * transcription calls it too. Answers the recording's state.
 */
export async function handleMeetFinalize(req: Request, rawCode: string, deps: RecordingDeps): Promise<Response> {
  const h = await host(req, rawCode, deps, true);
  if (!h.ok) return h.response;
  const report = recorderReportOf(await readBytesCapped(req, FINALIZE_BODY_MAX));
  if (report.failed > 0 || report.errored > 0) {
    console.warn("[meet.recording] the recorder lost audio", { roomId: h.room.id, ...report });
  }
  const now = deps.now();
  const out = await ensureTranscriptJob(deps.db, h.room, h.userId, now);
  if (out.state === "not_ended") return refuse(409, "not_ended");
  // Nothing reached the relay, but the browser says it lost audio: that is a failed recording, not an empty one.
  if (out.state === "nothing_recorded" && (report.failed > 0 || report.errored > 0)) {
    await recordTotalLoss(deps.db, h.room, report, now);
    return json(200, { ok: true, state: "lost" });
  }
  // Kept on the recording, so the panel can say how much is missing even where the rows show no gap.
  await recordRecorderReport(deps.db, h.room, report, now);
  return json(200, { ok: true, state: out.state });
}

/** The recorder's report, as counts the server can trust the shape of: a whole number from 0 to 1,000,000 each, else 0. */
function recorderReportOf(raw: Uint8Array | null): RecorderReport {
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : 0);
  if (!raw || !raw.byteLength) return { failed: 0, errored: 0 };
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    return { failed: count(body?.failed), errored: count(body?.errored) };
  } catch {
    return { failed: 0, errored: 0 };
  }
}

// ---------------------------------------------------------------------------
// GET /api/cron/meet-relay (the route checks the cron auth, then calls this)
// ---------------------------------------------------------------------------

/**
 * The relay's upkeep run (meetRelayCron). With no relay storage nothing can be
 * deleted, so the 30-day promise cannot be kept: that is a failed run the cron
 * driver reports (503), never a quiet 200 (Codex on #685, third pass). Expiry
 * still runs first, so recordings are marked even while storage is missing.
 * A step of the run that threw (relay_sweep_failed, named in failedSweeps;
 * the steps after it still ran) or a sweep of the computers' deletes that
 * threw is a failed run too; one that could not run because bravo__240 is not
 * applied is logged on every run and named in the answer (localDeletes:
 * "not_installed"), not failed, like bravo__231 missing below: before it no
 * copy is tracked, so none can wait.
 */
export async function handleMeetRelayCron(deps: {
  db: Client;
  storage: MeetStorage | null;
  now: () => Date;
  /** The Worker's SFU (meetSfuIfConfigured), to cut what ended rooms still hold; absent or null: none set. */
  sfu?: SfuClient | null;
}): Promise<Response> {
  // Migration bravo__231 not applied yet: nothing to keep, and not a failure.
  if (!(await meetRecordingTablesInstalled(deps.db))) return json(200, { ok: true, skipped: "not_installed" });
  const result = await meetRelayCron(deps.db, deps.storage, deps.now(), deps.sfu ?? null);
  if (!deps.storage) return json(503, { ok: false, error: "storage_not_configured", ...result });
  // R2 refused a delete (credentials, permissions, an outage): audio past its time is still there. A failed
  // run, said as one, so the driver reports it rather than a healthy tick (Codex on #685, fourth pass).
  if (result.deleteFailed) return json(503, { ok: false, error: "relay_delete_failed", ...result });
  // An ended room's media the SFU would not cut is still flowing: a failed run too, so the driver reports it while
  // the next runs retry it (Codex on #688).
  if (result.mediaCutFailed > 0) return json(503, { ok: false, error: "media_cut_failed", ...result });
  // A step of the run threw (logged and named in failedSweeps; the steps after it still ran): a failed run too.
  if (result.failedSweeps.length) return json(503, { ok: false, error: "relay_sweep_failed", ...result });
  // A copy of a deleted meeting left without its delete, or a gone computer's delete never given up: a failed run,
  // so the driver reports it while the next runs retry it.
  if (result.localDeletes === "failed") return json(503, { ok: false, error: "local_delete_sweep_failed", ...result });
  return json(200, { ok: true, ...result });
}

// ---------------------------------------------------------------------------
// GET and DELETE /api/meet/<code>/recording
// ---------------------------------------------------------------------------

export async function handleMeetRecordingGet(req: Request, rawCode: string, deps: RecordingDeps): Promise<Response> {
  const h = await host(req, rawCode, deps, false);
  if (!h.ok) return h.response;
  try {
    return json(200, { ok: true, recording: await meetRecordingView(deps.db, h.room, deps.now()) });
  } catch (err) {
    // A deleted or expired recording's panel reads each computer's copy (bravo__240): before that migration it is
    // "not set up", like Delete, never a 500. Every other failure is still thrown.
    if (!(await meetLocalCopiesInstalled(deps.db))) return notInstalled("tables_missing");
    throw err;
  }
}

export async function handleMeetRecordingDelete(req: Request, rawCode: string, deps: RecordingDeps): Promise<Response> {
  const h = await host(req, rawCode, deps, true, meetLocalCopiesInstalled);
  if (!h.ok) return h.response;
  const out = await deleteMeetRecording(deps.db, deps.storage, h.room, h.userId, deps.now());
  return json(200, { ok: true, relay_remaining: out.relayRemaining, device_delete_queued: out.deviceDeleteQueued });
}
