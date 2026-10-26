/**
 * tests/meet-copies-backfill.test.ts - migrations bravo__240 and bravo__242 on recordings the code before them made,
 * and the two-computer deletes that run on that data afterwards (lib/meet/recording.ts).
 *
 * The database starts at the schema before bravo__240 (main at 8896d1bb: bravo__206, 230, 231 and 233). Its
 * recordings are made the way the code before bravo__240 made them: the hand-over and Try again by the code that runs
 * today (ensureTranscriptJob, unchanged since), and the claims, the reports, the expiry and the host's Delete by `old`
 * below, which writes what that code wrote (8896d1bb: lib/tools/store.ts claimNextJob and upsertRunner,
 * lib/meet/recording.ts meetTranscribeClaim, meetTranscribeCompleteStatements, deleteMeetRecording, expireRelay and
 * meetDeleteLocalCompleteStatements, lib/tools/runner-handlers.ts handleToolsFail). Then the two files are applied a
 * statement at a time, as the migration tool applies them, and the code under test takes over.
 *
 * Pins (independent review of the two-computer change, 2026-10-26):
 *   - before bravo__240, recording, the hand-over and the panel still work; Delete and a meeting computer's claim
 *     answer "not set up", the room's own Delete keeps the meeting, and the relay cron says on every run that the
 *     computers' deletes cannot run yet;
 *   - bravo__240 is IF NOT EXISTS throughout but for its ALTER, which is last; bravo__242 is the backfill alone,
 *     LOCAL_COPIES_BACKFILL_SQL word for word, and runs again without a change;
 *   - the backfill records one copy per computer that claimed ANY of a room's transcriptions, with that computer's
 *     folder only where it finished, deleted only where the room was stamped, in the room's own workspace; 242's own
 *     query then finds no room with a claimer off the record;
 *   - the backfill for one room (ensureCopiesKnown, run by every Delete) agrees with the migration, row for row;
 *   - (a) a failed claim, Try again, and Delete before anyone took the retry: the Mac takes the older, unaddressed
 *     delete and finds nothing, and the room is NOT stamped deleted while the PC holds the audio; the PC is told, and
 *     its own delete stamps it;
 *   - an older, unaddressed delete never stamps a room, even one with no copy on record (the older code claimed and
 *     deleted it after 242 ran); 242's query finds that room, and its INSERT run again after the deploy records the PC;
 *   - (b) a failed PC claim retried by the Mac: Delete tells both, and the Mac's delete alone never stamps the room,
 *     whether the PC's claim is in the data the backfill read or was made by the older code after it ran;
 *   - with every meeting computer off, the relay cron queues a copy's missing delete and, 30 days on, gives it up.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-copies-backfill.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InStatement } from "@libsql/client";
import {
  ENV,
  MEET_COPIES_BACKFILL_PATH,
  MEET_COPIES_MIGRATION_PATH,
  OASIS,
  USERS,
  WEBDEV,
  answerOf,
  applyMigrationFile,
  check,
  fakeStorage,
  finish,
  later,
  minutes,
  scalar,
  setupToolsDatabase,
  signedRequest,
  splitSql,
} from "./_tools-harness";
import type { MeetStorage } from "../lib/meet/recording";
import type { MeetRoom } from "../lib/meet/rooms";

const ROOT = join(__dirname, "..");
const ORIGIN = "https://oasisai.work";
const CC = USERS.cc.id;
const T0 = new Date("2026-10-17T15:00:00.000Z");
const PC = "bea:oasis-pc-meet";
const MAC = "mac:oasis-mac-meet";
const MAC_SECRET = "mac-meet-runner-test-secret-0123456789abcdefgh";
const MEET_TOOLS = ["meet_delete_local", "meet_transcribe"];
const LABEL: Readonly<Record<string, string>> = { [PC]: "CCPC (Windows)", [MAC]: "CC's Mac" };

type Claimed = { job_id: string; lease_id: string; tool_key: string; input: Record<string, unknown> };
type Recorded = { room: MeetRoom; code: string };

/** The time `hours` after T0, plus `m` minutes: each recording below gets an hour of its own. */
const at = (hours: number, m = 0) => later(T0, minutes(60 * hours + m));

/** Run something and keep what it logged as an error. */
async function errorsOf<T>(run: () => Promise<T>): Promise<{ out: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map((p) => (p instanceof Error ? p.message : String(p))).join(" "));
  };
  try {
    return { out: await run(), errors };
  } finally {
    console.error = original;
  }
}

async function main() {
  console.log("meet copies backfill:");
  // The schema before bravo__240: the Toolkit's bravo__206 and Meet's own 230, 231 and 233.
  const db = await setupToolsDatabase({ meetCopies: false });
  for (const f of ["bravo__230_meet_rooms.sql", "bravo__231_meet_recordings.sql", "bravo__233_meet_room_recorder.sql"]) {
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", f), "utf8"));
  }
  const rooms = await import("../lib/meet/rooms");
  const rec = await import("../lib/meet/recording");
  const routes = await import("../lib/meet/recording-routes");
  const { meetRecordingDeps } = await import("../lib/meet/recording-deps");
  const h = await import("../lib/tools/runner-handlers");
  const { inputHashOf } = await import("../lib/tools/store");
  const { toolErrorLine } = await import("../lib/tools/errors");
  const { LEASE_SECONDS } = await import("../lib/tools/limits");

  // A distinct, valid code per room: the counter written in the code alphabet, padded to ten letters.
  let codeSeq = 0;
  const nextCode = () => {
    let n = codeSeq++;
    let code = "";
    for (let i = 0; i < 10; i += 1) {
      code = rooms.MEET_CODE_ALPHABET[n % rooms.MEET_CODE_ALPHABET.length] + code;
      n = Math.floor(n / rooms.MEET_CODE_ALPHABET.length);
    }
    return code;
  };
  const relay = new Map<string, Uint8Array>();
  const meetStorage: MeetStorage = {
    async put(path, bytes) {
      relay.set(path, bytes);
    },
    async signedGetUrl(path, ttl) {
      return `https://acct.r2.example/bucket/meet-relay/${path}?X-Amz-Expires=${ttl}&X-Amz-Signature=fake`;
    },
    async remove(path) {
      relay.delete(path);
    },
  };
  const session = async () => ({ ok: true as const, tenantId: OASIS, userId: CC, isTrueAdmin: false });
  const rdeps = (now: Date) => ({ db, storage: meetStorage, now: () => now, resolveSession: session });
  const hostReq = (code: string, method: string, path = "") =>
    new Request(`${ORIGIN}/api/meet/${code}/recording${path}`, { method, headers: { origin: ORIGIN, "x-forwarded-host": "oasisai.work" } });
  const body = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const count = async (sql: string, args: Array<string | number | null> = []) => Number(await scalar(db, sql, args));

  // The meeting computers, through the signed runner routes: the PC signs as `bea`, the Mac as `mac`.
  const runnerDeps = (who: string, now: Date) => ({
    db,
    env: who === MAC ? { ...ENV, TOOLS_RUNNER_SECRET_MAC: MAC_SECRET } : ENV,
    now,
    storage: fakeStorage().storage,
    meetStorage,
  });
  const sign = (who: string, route: string, payload: Record<string, unknown>, now: Date) =>
    signedRequest(route, { runner_id: who.split(":")[1], ...payload }, now, who === MAC ? { producer: "mac", secret: MAC_SECRET } : {});
  async function claimAs(who: string, now: Date): Promise<Claimed | null> {
    const res = await answerOf(await h.handleToolsClaim(sign(who, "claim", { label: LABEL[who], version: "1.0.0", tools: MEET_TOOLS }, now), runnerDeps(who, now)));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.job as Claimed | null;
  }
  async function reportGone(who: string, job: Claimed, now: Date, removed: string[]) {
    const res = await answerOf(
      await h.handleToolsComplete(
        sign(who, "complete", { job_id: job.job_id, lease_id: job.lease_id, tool_key: "meet_delete_local", removed, already_gone: removed.length === 0, device_label: LABEL[who] }, now),
        runnerDeps(who, now),
      ),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const targetOf = async (jobId: string) => {
    const v = await scalar(db, "SELECT target_runner FROM tool_jobs WHERE tenant_id IN (?, ?) AND id = ?", [OASIS, WEBDEV, jobId]);
    return v === null || v === undefined ? null : String(v);
  };
  const stampOf = async (r: Recorded) => {
    const v = await scalar(db, "SELECT local_deleted_at FROM meet_transcripts WHERE tenant_id = ? AND room_id = ?", [r.room.tenantId, r.room.id]);
    return v === null || v === undefined ? null : String(v);
  };
  const deviceDeleteOf = async (r: Recorded, now: Date) =>
    ((await body(await routes.handleMeetRecordingGet(hostReq(r.code, "GET"), r.code, rdeps(now)))).recording as {
      deviceDelete: { status: string; devices: string[] } | null;
    }).deviceDelete;
  /** Every copy on record, both workspaces, in a fixed order. */
  const allCopies = async () =>
    (await db.execute({ sql: "SELECT * FROM meet_local_copies WHERE tenant_id IN (?, ?) ORDER BY tenant_id, room_id, runner_key", args: [OASIS, WEBDEV] })).rows;
  /** Each copy of a room on record: "<runner>|<its folder or ->|open or deleted", in a fixed order. */
  const copiesOf = async (r: Recorded) =>
    (
      await db.execute({
        sql: "SELECT runner_key, local_folder, deleted_at FROM meet_local_copies WHERE tenant_id = ? AND room_id = ? ORDER BY runner_key",
        args: [r.room.tenantId, r.room.id],
      })
    ).rows.map((c) => `${String(c.runner_key)}|${c.local_folder === null ? "-" : String(c.local_folder)}|${c.deleted_at === null ? "open" : "deleted"}`);
  /** The folder a computer names a meeting's copy by (BEA scripts/meet/runner.py meeting_folder). */
  const folderOf = (r: Recorded, who: string) => {
    const name = `2026-10-17 ${r.room.title} (${r.room.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)})`;
    return who === PC ? `C:\\Users\\User\\OASIS\\Meetings\\${name}` : `/Users/conaugh/OASIS/Meetings/${name}`;
  };

  /** An ended meeting with one recorded chunk, handed over: a transcription queued for the meeting computers. */
  async function recorded(start: Date, title: string, tenantId = OASIS): Promise<Recorded> {
    const made = await rooms.createMeetRoom(db, { tenantId, hostUserId: CC, title, recordAudio: true, now: start, nextCode });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'live', started_at = ? WHERE tenant_id = ? AND id = ?", args: [start.toISOString(), tenantId, made.id] });
    const speaker = randomUUID();
    const segment = randomUUID();
    await db.execute({
      sql: `INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, sfu_session_id, tracks, joined_at, last_seen_at)
            VALUES (?, ?, ?, 'guest', NULL, 'Guest', ?, NULL, '[]', ?, ?)`,
      args: [speaker, tenantId, made.id, start.toISOString(), start.toISOString(), start.toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO meet_recording_chunks (id, tenant_id, room_id, participant_id, display_name, segment_id, seq, segment_started_ms, mime_type, bytes,
                                               storage_path, uploaded_by, created_at)
            VALUES (?, ?, ?, ?, 'Guest', ?, 0, ?, 'audio/webm;codecs=opus', 1000, ?, ?, ?)`,
      args: [randomUUID(), tenantId, made.id, speaker, segment, start.getTime(), rec.chunkPath(tenantId, made.id, speaker, segment, 0), CC, later(start, minutes(1)).toISOString()],
    });
    const ended = later(start, minutes(2));
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE tenant_id = ? AND id = ?", args: [ended.toISOString(), tenantId, made.id] });
    const room = (await rooms.readMeetRoom(db, { tenantId, roomId: made.id }))!;
    assert.equal((await rec.ensureTranscriptJob(db, room, null, ended)).state, "queued");
    return { room, code: rooms.displayMeetCode(room.code) };
  }
  /** The host's Try again after a failed transcription (finalize): a new job for the same room. */
  async function retry(r: Recorded, now: Date) {
    assert.equal((await rec.ensureTranscriptJob(db, r.room, CC, now)).state, "queued");
  }

  // The code before bravo__240, statement for statement (see the header). It never wrote a copy or an addressed job.
  const old = {
    /** claimNextJob for one job, after the runner checked in (upsertRunner, in every workspace it serves). */
    async take(tenantId: string, jobId: string, who: string, now: Date) {
      const iso = now.toISOString();
      for (const t of [OASIS, WEBDEV]) {
        await db.execute({
          sql: `INSERT INTO tool_runners (tenant_id, runner_key, label, tools_json, version, last_seen_at) VALUES (?, ?, ?, ?, '1.0.0', ?)
                ON CONFLICT (tenant_id, runner_key) DO UPDATE SET label = excluded.label, last_seen_at = excluded.last_seen_at`,
          args: [t, who, LABEL[who], JSON.stringify(MEET_TOOLS), iso],
        });
      }
      const taken = await db.execute({
        sql: `UPDATE tool_jobs
                 SET status = 'claimed', claimed_by = ?, lease_id = ?, claimed_at = ?, heartbeat_at = ?, lease_expires_at = ?,
                     attempts = attempts + 1, stage = NULL, upload_bytes = NULL, upload_sha256 = NULL, upload_md5 = NULL, updated_at = ?
               WHERE tenant_id = ? AND id = ? AND (status = 'queued' OR (status IN ('claimed', 'running') AND lease_expires_at < ?))`,
        args: [who, randomBytes(16).toString("hex"), iso, iso, later(now, LEASE_SECONDS * 1000).toISOString(), iso, tenantId, jobId, iso],
      });
      assert.equal(taken.rowsAffected, 1, "the older claim took nothing");
    },
    /** A transcription's claim (meetTranscribeClaim): its job taken, its recording closed to new chunks. */
    async claim(r: Recorded, who: string, now: Date): Promise<string> {
      const jobId = (await rec.readTranscript(db, r.room.tenantId, r.room.id))!.jobId!;
      await old.take(r.room.tenantId, jobId, who, now);
      await db.execute({
        sql: "UPDATE meet_transcripts SET status = 'transcribing', updated_at = ? WHERE tenant_id = ? AND room_id = ? AND job_id = ? AND status IN ('queued', 'transcribing')",
        args: [now.toISOString(), r.room.tenantId, r.room.id, jobId],
      });
      return jobId;
    },
    /** The transcript reported (meetTranscribeCompleteStatements): the row ready with that computer's folder, the job done. */
    async finish(r: Recorded, jobId: string, who: string, now: Date) {
      const iso = now.toISOString();
      await db.batch(
        [
          {
            sql: `UPDATE meet_transcripts SET status = 'ready', text = '[00:00:01] Guest: hello', lines_json = '[]', model = 'small.en', transcribe_seconds = 1,
                         device_label = ?, local_folder = ?, ready_at = ?, updated_at = ?
                   WHERE tenant_id = ? AND room_id = ? AND job_id = ? AND status = 'transcribing'`,
            args: [LABEL[who], folderOf(r, who), iso, iso, r.room.tenantId, r.room.id, jobId],
          },
          {
            sql: `UPDATE tool_jobs SET status = 'done', stage = NULL, result_json = '{}', error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
                   WHERE tenant_id = ? AND id = ?`,
            args: [iso, iso, r.room.tenantId, jobId],
          },
        ],
        "write",
      );
    },
    /** A job its computer failed (handleToolsFail). */
    async fail(r: Recorded, jobId: string, code: string, now: Date) {
      await db.execute({
        sql: "UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = ?, error_message = ?, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
        args: [code, toolErrorLine(code, "runner"), now.toISOString(), now.toISOString(), r.room.tenantId, jobId],
      });
    },
    /** The computer went off mid-way: its lease lapsed, so the job is claimable again. */
    async lapse(r: Recorded, jobId: string, now: Date) {
      await db.execute({ sql: "UPDATE tool_jobs SET lease_expires_at = ? WHERE tenant_id = ? AND id = ?", args: [now.toISOString(), r.room.tenantId, jobId] });
    },
    /** ONE unaddressed "delete your copy" for whichever computer asks first, if a transcription was ever claimed (deviceDeleteStatement). */
    deviceDelete(r: Recorded, title: string | null, localFolder: string | null, actor: string | null, now: Date): InStatement {
      const iso = now.toISOString();
      const input = { room_id: r.room.id, title, local_folder: localFolder };
      const t = r.room.tenantId;
      return {
        sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, idempotency_key,
                                     dedupe_key, created_by, created_by_email, created_at, updated_at)
              SELECT ?, ?, 'meet_delete_local', 'runner', 'queued', ?, ?, NULL, ?, ?, NULL, ?, ?
              WHERE EXISTS (SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'meet_transcribe' AND dedupe_key = ? AND attempts > 0)
                AND NOT EXISTS (SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('queued', 'claimed', 'running'))
                AND NOT EXISTS (SELECT 1 FROM meet_transcripts WHERE tenant_id = ? AND room_id = ? AND local_deleted_at IS NOT NULL)`,
        args: [
          randomUUID(), t, JSON.stringify(input), inputHashOf("meet_delete_local", input), `meet_delete_local:${r.room.id}`, actor, iso, iso,
          t, `meet_transcribe:${r.room.id}`, t, `meet_delete_local:${r.room.id}`, t, r.room.id,
        ],
      };
    },
    /** The host's Delete (deleteMeetRecording): the tombstone, a transcription in flight called off, the one delete, the relay freed. */
    async del(r: Recorded, now: Date) {
      const iso = now.toISOString();
      const t = await rec.readTranscript(db, r.room.tenantId, r.room.id);
      await db.batch(
        [
          {
            sql: `INSERT INTO meet_transcripts (id, tenant_id, room_id, status, relay_expires_at, created_at, updated_at, deleted_at)
                  VALUES (?, ?, ?, 'deleted', ?, ?, ?, ?)
                  ON CONFLICT (tenant_id, room_id) DO UPDATE SET
                    status = 'deleted', text = NULL, lines_json = NULL, segments_json = '[]',
                    deleted_at = COALESCE(meet_transcripts.deleted_at, excluded.deleted_at), updated_at = excluded.updated_at`,
            args: [randomUUID(), r.room.tenantId, r.room.id, iso, iso, iso, iso],
          },
          {
            sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'meeting_deleted', error_message = ?, finished_at = ?, updated_at = ?
                   WHERE tenant_id = ? AND tool_key = 'meet_transcribe' AND dedupe_key = ? AND status IN ('queued', 'claimed', 'running')`,
            args: [toolErrorLine("meeting_deleted", "runner"), iso, iso, r.room.tenantId, `meet_transcribe:${r.room.id}`],
          },
          old.deviceDelete(r, r.room.title, t?.localFolder ?? null, CC, now),
        ],
        "write",
      );
      await rec.removeRelayChunks(db, meetStorage, { tenantIds: [r.room.tenantId], roomId: r.room.id }, 300, now);
    },
    /** Past the relay's 30 days with its computer gone (expireRelay): the job failed, the recording expired, the one delete. */
    async expire(r: Recorded, jobId: string, now: Date) {
      const iso = now.toISOString();
      await db.execute({
        sql: "UPDATE meet_transcripts SET relay_expires_at = ? WHERE tenant_id = ? AND room_id = ?",
        args: [later(now, -minutes(1)).toISOString(), r.room.tenantId, r.room.id],
      });
      await db.batch(
        [
          {
            sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'relay_expired', error_message = ?, finished_at = ?, updated_at = ?
                   WHERE tenant_id = ? AND id = ? AND (status = 'queued' OR (status IN ('claimed', 'running') AND lease_expires_at < ?))`,
            args: [toolErrorLine("relay_expired", "runner"), iso, iso, r.room.tenantId, jobId, iso],
          },
          {
            sql: "UPDATE meet_transcripts SET status = 'expired', segments_json = '[]', updated_at = ? WHERE tenant_id = ? AND room_id = ? AND status IN ('queued', 'transcribing')",
            args: [iso, r.room.tenantId, r.room.id],
          },
          old.deviceDelete(r, null, null, null, now),
        ],
        "write",
      );
    },
    /** A computer's report that its copy is gone (meetDeleteLocalCompleteStatements): the room stamped, the job done. */
    async deleted(r: Recorded, jobId: string, who: string, now: Date) {
      const iso = now.toISOString();
      await db.batch(
        [
          {
            sql: "UPDATE meet_transcripts SET local_deleted_at = ?, device_label = ?, updated_at = ? WHERE tenant_id = ? AND room_id = ?",
            args: [iso, LABEL[who], iso, r.room.tenantId, r.room.id],
          },
          {
            sql: `UPDATE tool_jobs SET status = 'done', stage = NULL, result_json = '{}', error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
                   WHERE tenant_id = ? AND id = ?`,
            args: [iso, iso, r.room.tenantId, jobId],
          },
        ],
        "write",
      );
    },
  };
  /** The rooms 242's own query finds (the one its header says to run after applying it, and after the deploy). */
  const exposed = async () => {
    const line = readFileSync(MEET_COPIES_BACKFILL_PATH, "utf8").split("\n").find((l) => /^--\s+SELECT DISTINCT t\.room_id/.test(l));
    assert.ok(line, "bravo__242 lost the query to run after it");
    return (await db.execute(line.replace(/^--\s+/, "").replace(/;\s*$/, ""))).rows.map((x) => String(x.room_id));
  };
  const olderDeleteOf = async (r: Recorded) =>
    String(await scalar(db, "SELECT id FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ? AND status = 'queued'", [r.room.tenantId, `meet_delete_local:${r.room.id}`]));

  // ---------------------------------------------------------------------
  // Before bravo__240: the deploy that lands first
  // ---------------------------------------------------------------------
  let early: Recorded | null = null;
  await check("before bravo__240: recording, the hand-over and the panel work; Delete and a meeting computer's claim are 'not set up'", async () => {
    assert.deepEqual([await rec.meetRecordingTablesInstalled(db), await rec.meetLocalCopiesInstalled(db)], [true, false]);
    const made = await rooms.createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Before the migration", recordAudio: true, now: T0, nextCode });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'live', started_at = ? WHERE tenant_id = ? AND id = ?", args: [T0.toISOString(), OASIS, made.id] });
    const speaker = randomUUID();
    await db.execute({
      sql: `INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, sfu_session_id, tracks, joined_at, last_seen_at)
            VALUES (?, ?, ?, 'guest', NULL, 'Jordan', ?, NULL, '[]', ?, ?)`,
      args: [speaker, OASIS, made.id, T0.toISOString(), T0.toISOString(), T0.toISOString()],
    });
    const code = rooms.displayMeetCode(made.code);
    // A live meeting's chunk is still taken (the recorder would give up on a 503 after its retries).
    const chunk = await routes.handleMeetChunk(
      new Request(`${ORIGIN}/api/meet/${code}/recording/chunk`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "x-forwarded-host": "oasisai.work",
          "content-type": "audio/webm;codecs=opus",
          "x-meet-participant": speaker,
          "x-meet-segment": randomUUID(),
          "x-meet-seq": "0",
          "x-meet-segment-started-at": String(T0.getTime()),
        },
        body: new Uint8Array(1000).fill(7),
      }),
      code,
      rdeps(later(T0, minutes(1))),
    );
    assert.equal(chunk.status, 201, JSON.stringify(await body(chunk.clone())));
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE tenant_id = ? AND id = ?", args: [later(T0, minutes(2)).toISOString(), OASIS, made.id] });
    const handed = await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(T0, minutes(2))));
    assert.deepEqual([handed.status, (await body(handed)).state], [200, "queued"]);
    // Kept for the check after the migration, which deletes it (so no later claim is handed its transcription).
    const room = (await rooms.readMeetRoom(db, { tenantId: OASIS, roomId: made.id }))!;
    early = { room, code };
    const panel = await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(T0, minutes(3))));
    assert.deepEqual([panel.status, ((await body(panel)).recording as { state: string }).state], [200, "waiting"]);
    // Only what tracks each computer's copy waits for the migration.
    const del = await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(later(T0, minutes(4))));
    assert.deepEqual([del.status, (await body(del)).error], [503, "not_installed"]);
    const claimed = await h.handleToolsClaim(sign(PC, "claim", { label: LABEL[PC], version: "1.0.0", tools: MEET_TOOLS }, later(T0, minutes(4))), runnerDeps(PC, later(T0, minutes(4))));
    assert.deepEqual([claimed.status, (await body(claimed)).error], [503, "not_installed"]);
    // The meeting's own Delete keeps the meeting rather than leave its recording on a computer (deleteMeetRoom keeps it when this throws).
    await assert.rejects(meetRecordingDeps(db, () => meetStorage).remove(room, CC, later(T0, minutes(4))), /bravo__240/);
    // The relay cron still keeps the relay, and says on every run that the computers' deletes cannot run yet.
    const cron = await errorsOf(async () => routes.handleMeetRelayCron({ db, storage: meetStorage, now: () => later(T0, minutes(5)) }));
    assert.deepEqual([cron.out.status, (await body(cron.out)).localDeletes], [200, "not_installed"]);
    assert.ok(cron.errors.some((e) => /bravo__240/.test(e)), `the cron skipped the computers' deletes in silence: ${JSON.stringify(cron.errors)}`);
  });

  // ---------------------------------------------------------------------
  // What the code before bravo__240 left: one recording per kind the backfill must read right
  // ---------------------------------------------------------------------
  // The PC transcribed it.
  const done = await recorded(at(1), "Done");
  await old.finish(done, await old.claim(done, PC, at(1, 3)), PC, at(1, 10));
  // The PC's transcription failed, and nobody tried again.
  const failed = await recorded(at(2), "Failed");
  await old.fail(failed, await old.claim(failed, PC, at(2, 3)), "transcribe_failed", at(2, 10));
  // The PC failed it; Try again; the Mac took the retry and finished it.
  const retriedByMac = await recorded(at(3), "Retried by the Mac");
  await old.fail(retriedByMac, await old.claim(retriedByMac, PC, at(3, 3)), "transcribe_failed", at(3, 10));
  await retry(retriedByMac, at(3, 20));
  await old.finish(retriedByMac, await old.claim(retriedByMac, MAC, at(3, 25)), MAC, at(3, 30));
  // The PC failed it; Try again; deleted before anyone took the retry (scenario a).
  const retryDeleted = await recorded(at(4), "Retry deleted");
  await old.fail(retryDeleted, await old.claim(retryDeleted, PC, at(4, 3)), "transcribe_failed", at(4, 10));
  await retry(retryDeleted, at(4, 20));
  await old.del(retryDeleted, at(4, 30));
  // The PC went off mid-way, its lease lapsed, and it took the same job again and finished it.
  const reclaimed = await recorded(at(5), "Reclaimed");
  const firstTry = await old.claim(reclaimed, PC, at(5, 3));
  await old.lapse(reclaimed, firstTry, at(5, 4));
  await old.finish(reclaimed, await old.claim(reclaimed, PC, at(5, 25)), PC, at(5, 30));
  // The PC claimed it and vanished: the relay's 30 days ran out.
  const expired = await recorded(at(6), "Expired");
  const vanished = await old.claim(expired, PC, at(6, 3));
  await old.lapse(expired, vanished, at(6, 4));
  await old.expire(expired, vanished, at(6, 30));
  // Transcribed, deleted, and the PC's delete done: the room is stamped.
  const deletedDone = await recorded(at(7), "Deleted and done");
  await old.finish(deletedDone, await old.claim(deletedDone, PC, at(7, 3)), PC, at(7, 10));
  await old.del(deletedDone, at(7, 20));
  const doneDelete = await olderDeleteOf(deletedDone);
  await old.take(OASIS, doneDelete, PC, at(7, 21));
  await old.deleted(deletedDone, doneDelete, PC, at(7, 22));
  // Transcribed, then deleted while the PC was off: its delete still waits.
  const deletedWaiting = await recorded(at(8), "Deleted with the PC off");
  await old.finish(deletedWaiting, await old.claim(deletedWaiting, PC, at(8, 3)), PC, at(8, 10));
  await old.del(deletedWaiting, at(8, 20));
  // Deleted while the PC was transcribing it.
  const deletedMid = await recorded(at(9), "Deleted mid transcription");
  await old.claim(deletedMid, PC, at(9, 3));
  await old.del(deletedMid, at(9, 10));
  // Deleted before any computer took it: none has a copy.
  const neverClaimed = await recorded(at(10), "Never claimed");
  await old.del(neverClaimed, at(10, 10));
  // Another OASIS workspace's meeting, transcribed by the same PC.
  const otherWorkspace = await recorded(at(11), "Web dev", WEBDEV);
  await old.finish(otherWorkspace, await old.claim(otherWorkspace, PC, at(11, 3)), PC, at(11, 10));
  const everyRoom = [done, failed, retriedByMac, retryDeleted, reclaimed, expired, deletedDone, deletedWaiting, deletedMid, neverClaimed, otherWorkspace];

  // ---------------------------------------------------------------------
  // The migration
  // ---------------------------------------------------------------------
  await check("bravo__240 runs again up to its ALTER, which is last; bravo__242 is the backfill alone, word for word what the code runs", async () => {
    const s240 = splitSql(readFileSync(MEET_COPIES_MIGRATION_PATH, "utf8"));
    assert.equal(s240[s240.length - 1], "ALTER TABLE tool_jobs ADD COLUMN target_runner TEXT", "the ALTER, which cannot run twice, is the last statement");
    for (const st of s240.slice(0, -1)) assert.match(st, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, "a statement before the ALTER cannot run twice");
    assert.doesNotMatch(readFileSync(MEET_COPIES_MIGRATION_PATH, "utf8").replace(/--.*$/gm, ""), /\b(insert|update|delete|drop)\b/i, "bravo__240 reads or writes data");
    const s242 = splitSql(readFileSync(MEET_COPIES_BACKFILL_PATH, "utf8"));
    const words = (sql: string) => sql.replace(/\s+/g, " ").trim();
    assert.deepEqual(s242.map(words), [words(rec.LOCAL_COPIES_BACKFILL_SQL)], "bravo__242 and LOCAL_COPIES_BACKFILL_SQL say different things");
  });

  await applyMigrationFile(db, MEET_COPIES_MIGRATION_PATH);
  await applyMigrationFile(db, MEET_COPIES_BACKFILL_PATH);

  await check("the backfill records every computer that claimed a room's transcription: its folder where it finished, deleted where the room was stamped", async () => {
    const pcFolder = (r: Recorded) => `${PC}|${folderOf(r, PC)}`;
    const expected: Array<[string, Recorded, string[]]> = [
      ["transcribed", done, [`${pcFolder(done)}|open`]],
      ["failed", failed, [`${PC}|-|open`]],
      ["failed, then retried by the Mac", retriedByMac, [`${PC}|-|open`, `${MAC}|${folderOf(retriedByMac, MAC)}|open`]],
      ["retried, then deleted before the retry was taken", retryDeleted, [`${PC}|-|open`]],
      ["re-claimed by the same PC", reclaimed, [`${pcFolder(reclaimed)}|open`]],
      ["expired after its claim", expired, [`${PC}|-|open`]],
      ["deleted, and the PC's delete done", deletedDone, [`${pcFolder(deletedDone)}|deleted`]],
      ["deleted while the PC was off", deletedWaiting, [`${pcFolder(deletedWaiting)}|open`]],
      ["deleted mid-transcription", deletedMid, [`${PC}|-|open`]],
      ["never claimed", neverClaimed, []],
      ["another workspace's", otherWorkspace, [`${pcFolder(otherWorkspace)}|open`]],
    ];
    for (const [kind, r, copies] of expected) assert.deepEqual(await copiesOf(r), copies, kind);
    assert.equal(
      await count("SELECT COUNT(*) FROM meet_local_copies WHERE tenant_id = ? AND room_id = ?", [OASIS, otherWorkspace.room.id]),
      0,
      "a copy recorded in another workspace",
    );
    // 242's own query, as an operator runs it after applying it.
    assert.deepEqual(await exposed(), [], "a room has a computer that claimed it and is not on record");
    // Safe to run again: nothing changes.
    const before = await allCopies();
    await applyMigrationFile(db, MEET_COPIES_BACKFILL_PATH);
    assert.deepEqual(await allCopies(), before);
  });

  await check("the backfill for one room, run by every Delete, agrees with the migration row for row", async () => {
    const migrated = await allCopies();
    assert.equal(migrated.length, 11, "the rows the migration made");
    await db.execute({ sql: "DELETE FROM meet_local_copies WHERE tenant_id IN (?, ?)", args: [OASIS, WEBDEV] });
    for (const r of everyRoom) await rec.ensureCopiesKnown(db, r.room.tenantId, r.room.id);
    assert.deepEqual(await allCopies(), migrated);
    // Again: a copy already on record is never changed, and none is added twice.
    for (const r of everyRoom) await rec.ensureCopiesKnown(db, r.room.tenantId, r.room.id);
    assert.deepEqual(await allCopies(), migrated);
  });

  await check("once bravo__240 is in, the recording made before it deletes like any other", async () => {
    assert.ok(early, "the first check made no recording");
    const r = early as Recorded;
    const del = await routes.handleMeetRecordingDelete(hostReq(r.code, "DELETE"), r.code, rdeps(at(20)));
    const out = await body(del);
    assert.deepEqual([del.status, out.device_delete_queued], [200, false], "no computer ever took it");
    assert.equal(await scalar(db, "SELECT error_code FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ?", [OASIS, `meet_transcribe:${r.room.id}`]), "meeting_deleted");
  });

  // ---------------------------------------------------------------------
  // The deletes on that data, by the code under test
  // ---------------------------------------------------------------------
  await check("(a) a retry deleted before anyone took it: the Mac's older delete never stamps a room the PC still holds; the PC's own delete does", async () => {
    const now = at(30);
    const older = new Set(
      (await db.execute({ sql: "SELECT id FROM tool_jobs WHERE tenant_id IN (?, ?) AND tool_key = 'meet_delete_local' AND target_runner IS NULL AND status = 'queued'", args: [OASIS, WEBDEV] })).rows.map((x) => String(x.id)),
    );
    assert.equal(older.size, 4, "the unaddressed deletes left waiting: the retry deleted, the expired, the deleted with the PC off, and mid-transcription");
    // The Mac asks first: it is handed every older delete (whichever computer asked first used to get it), never one
    // addressed to the PC, finds nothing, and reports so.
    for (let i = 0; i < 10; i += 1) {
      const job = await claimAs(MAC, later(now, i * 1000));
      if (!job) break;
      assert.ok(older.delete(job.job_id), `the Mac was handed ${job.tool_key} for ${String(job.input.room_id)}, addressed to ${await targetOf(job.job_id)}`);
      await reportGone(MAC, job, later(now, i * 1000 + 500), []);
      const r = everyRoom.find((x) => x.room.id === job.input.room_id)!;
      assert.equal(await stampOf(r), null, "a computer that never had the audio stamped the room deleted");
    }
    assert.equal(older.size, 0, "an older delete was left");
    // The PC still holds the audio: the Mac's claim queued its delete, and the panel waits for it by name.
    const waiting = await deviceDeleteOf(retryDeleted, later(now, minutes(1)));
    assert.deepEqual([waiting?.status, waiting?.devices], ["waiting", [LABEL[PC]]]);
    const taken: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const job = await claimAs(PC, later(now, minutes(2) + i * 1000));
      if (!job) break;
      assert.equal(await targetOf(job.job_id), PC, "the PC was handed a delete that is not its own");
      taken.push(String(job.input.room_id));
      const r = everyRoom.find((x) => x.room.id === job.input.room_id)!;
      await reportGone(PC, job, later(now, minutes(2) + i * 1000 + 500), [folderOf(r, PC)]);
    }
    assert.deepEqual(taken.sort(), [retryDeleted, expired, deletedWaiting, deletedMid].map((x) => x.room.id).sort());
    for (const r of [retryDeleted, expired, deletedWaiting, deletedMid]) assert.ok(await stampOf(r), `${String(r.room.title)}: the PC's own delete did not stamp it`);
    assert.equal((await deviceDeleteOf(retryDeleted, later(now, minutes(3))))?.status, "done");
  });

  await check("an older delete never stamps a room, even with no copy on record; 242 run again after the deploy finds the PC, and the PC's delete does", async () => {
    // The older code, after bravo__242 ran and before the deploy: the PC's claim failed, Try again, Delete before
    // the retry was taken. No copy on record, one unaddressed delete.
    const r = await recorded(at(35), "Deleted after the backfill");
    await old.fail(r, await old.claim(r, PC, at(35, 3)), "transcribe_failed", at(35, 10));
    await retry(r, at(35, 20));
    await old.del(r, at(35, 30));
    assert.deepEqual(await copiesOf(r), []);
    // The deploy. The Mac asks first, is handed the unaddressed delete, and finds nothing: nothing tells the room
    // the PC's copy is gone, so it is not stamped.
    const job = await claimAs(MAC, at(36));
    assert.deepEqual([job?.tool_key, job?.input.room_id, await targetOf(job!.job_id)], ["meet_delete_local", r.room.id, null]);
    await reportGone(MAC, job!, at(36, 1), []);
    assert.equal(await stampOf(r), null, "an unaddressed delete stamped the room deleted while the PC holds its audio");
    // 242's query, run after the deploy as its header says, finds the room; its INSERT run again records the PC.
    assert.deepEqual(await exposed(), [r.room.id]);
    await applyMigrationFile(db, MEET_COPIES_BACKFILL_PATH);
    assert.deepEqual([await copiesOf(r), await exposed()], [[`${PC}|-|open`], []]);
    // The next meeting computer's claim queues the PC's own delete, and the PC's report stamps the room.
    const pcJob = await claimAs(PC, at(37));
    assert.deepEqual([pcJob?.tool_key, pcJob?.input.room_id, await targetOf(pcJob!.job_id)], ["meet_delete_local", r.room.id, PC]);
    await reportGone(PC, pcJob!, at(37, 1), []);
    assert.ok(await stampOf(r), "every copy is gone, yet the room is not stamped");
  });

  await check("(b) a failed PC claim retried by the Mac: Delete tells both, and the Mac's delete alone never stamps the room", async () => {
    // b1: the PC's claim is in the data the backfill read.
    // b2: the older code made it after bravo__242 ran, before the deploy: no copy on record until a Delete looks.
    const late = await recorded(at(40), "Claimed after the backfill");
    await old.fail(late, await old.claim(late, PC, at(40, 3)), "transcribe_failed", at(40, 10));
    await retry(late, at(40, 20));
    const mac = await claimAs(MAC, at(40, 25));
    assert.deepEqual([mac?.tool_key, mac?.input.room_id], ["meet_transcribe", late.room.id]);
    const report = await answerOf(
      await h.handleToolsComplete(
        sign(MAC, "complete", {
          job_id: mac!.job_id, lease_id: mac!.lease_id, tool_key: "meet_transcribe", transcript_text: "[00:00:01] Guest: hello", lines: [],
          model: "small.en", transcribe_seconds: 2, device_label: LABEL[MAC], local_folder: folderOf(late, MAC),
        }, at(40, 30)),
        runnerDeps(MAC, at(40, 30)),
      ),
    );
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.deepEqual(await copiesOf(late), [`${MAC}|${folderOf(late, MAC)}|open`], "the older code's claim is not on record yet");

    for (const [r, when] of [[retriedByMac, at(41)], [late, at(42)]] as const) {
      const del = await routes.handleMeetRecordingDelete(hostReq(r.code, "DELETE"), r.code, rdeps(when));
      assert.equal((await body(del)).device_delete_queued, true);
      const told = (
        await db.execute({
          sql: "SELECT target_runner, input_json FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'meet_delete_local' AND dedupe_key LIKE ? ORDER BY target_runner",
          args: [OASIS, `meet_delete_local:${r.room.id}:%`],
        })
      ).rows.map((x) => [String(x.target_runner), (JSON.parse(String(x.input_json)) as { local_folder: string | null }).local_folder]);
      assert.deepEqual(told, [[PC, null], [MAC, folderOf(r, MAC)]], `${String(r.room.title)}: Delete did not tell both computers, each with only its own folder`);
      // The Mac deletes its copy: the PC still holds one, so the room is not deleted yet.
      const macJob = await claimAs(MAC, later(when, minutes(1)));
      assert.deepEqual([macJob?.tool_key, macJob?.input.room_id], ["meet_delete_local", r.room.id]);
      await reportGone(MAC, macJob!, later(when, minutes(2)), [folderOf(r, MAC)]);
      assert.equal(await stampOf(r), null, `${String(r.room.title)}: the Mac's delete stamped a room the PC still holds`);
      const half = await deviceDeleteOf(r, later(when, minutes(3)));
      assert.deepEqual([half?.status, half?.devices], ["waiting", [LABEL[PC]]]);
      // The PC deletes its own: now it is done.
      const pcJob = await claimAs(PC, later(when, minutes(4)));
      assert.deepEqual([pcJob?.tool_key, pcJob?.input.room_id], ["meet_delete_local", r.room.id]);
      await reportGone(PC, pcJob!, later(when, minutes(5)), []);
      assert.ok(await stampOf(r), `${String(r.room.title)}: every copy is gone, yet the room is not stamped`);
      assert.equal((await deviceDeleteOf(r, later(when, minutes(6))))?.status, "done");
    }
  });

  await check("with every meeting computer off, the relay cron queues a copy's missing delete, then gives it up once the PC is gone 30 days", async () => {
    // The older code deleted it while the PC was off; 242, run again after the deploy, records the PC's copy.
    const r = await recorded(at(50), "Only the cron is on");
    await old.claim(r, PC, at(50, 3));
    await old.del(r, at(50, 10));
    await applyMigrationFile(db, MEET_COPIES_BACKFILL_PATH);
    assert.deepEqual(await copiesOf(r), [`${PC}|-|open`]);
    const own = rec.deleteLocalKey(r.room.id, PC);
    const job = async () =>
      (await db.execute({ sql: "SELECT status, error_code FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ? AND target_runner = ?", args: [OASIS, own, PC] })).rows.map((x) => [
        String(x.status),
        x.error_code === null ? null : String(x.error_code),
      ]);
    // No meeting computer polls: the cron alone queues the PC's own delete...
    const first = await routes.handleMeetRelayCron({ db, storage: meetStorage, now: () => at(51) });
    assert.deepEqual([first.status, (await body(first)).localDeletes], [200, "ok"]);
    assert.deepEqual(await job(), [["queued", null]], "the cron left a copy of a deleted meeting without its delete");
    // ...and, with the PC still not seen 30 days on, gives it up, so the panel says so instead of waiting for good.
    const month = later(at(51), 31 * 86_400_000);
    const second = await routes.handleMeetRelayCron({ db, storage: meetStorage, now: () => month });
    assert.deepEqual([second.status, (await body(second)).localDeletes], [200, "ok"]);
    assert.deepEqual(await job(), [["failed", "runner_gone"]]);
    const panel = (await body(await routes.handleMeetRecordingGet(hostReq(r.code, "GET"), r.code, rdeps(month)))).recording as {
      deviceDelete: { status: string; errorCode: string | null; devices: string[] } | null;
    };
    assert.deepEqual([panel.deviceDelete?.status, panel.deviceDelete?.errorCode, panel.deviceDelete?.devices], ["failed", "runner_gone", [LABEL[PC]]]);
    assert.equal(await stampOf(r), null, "a computer that never answered counted as deleted");
  });

  finish("meet copies backfill");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
