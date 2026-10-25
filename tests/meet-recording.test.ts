/**
 * tests/meet-recording.test.ts - Oasis Meet's recording relay end to end
 * (migration bravo__231, lib/meet/recording.ts, lib/meet/recording-routes.ts,
 * and the runner channel's meeting jobs in lib/tools/runner-handlers.ts),
 * against the REAL migrations bravo__206, bravo__230 and bravo__231 in a local
 * libSQL file, with a fake relay store that records every call.
 *
 * Pins:
 *   - a chunk is the host's only, same-origin only, from one of the room's own
 *     participants, under its own workspace's path, named by the participant
 *     ROW (never the request); a retry is a 409 duplicate; every refusal is a
 *     status the recorder will not retry forever (lib/meet/recorder.ts);
 *   - one browser records a room (its recorder, migration bravo__233): another
 *     browser still in the call is 423, one that left or was removed sends its
 *     last chunks for LATE_CHUNK_MS; a room's caps hold inside the INSERT;
 *   - the hand-over is idempotent and waits for the meeting's end; the PC's
 *     claim hands over a meeting nobody finalized, 10 minutes after its end,
 *     and first ends a call whose every tab closed without End (never a
 *     meeting made for later that two hosts only tried out early);
 *   - the claim fixes the segments (each one's unbroken run from chunk 0),
 *     download-urls signs exactly those, a meeting job reports its own stages
 *     for up to four hours, and complete stores the transcript and frees the
 *     relay in batches;
 *   - a meeting job is never failed for an offline PC and never counts toward
 *     the five downloads; it expires after 30 days on the relay instead;
 *   - delete calls off a transcription, tells the PC to delete its copy only
 *     if it may have one, and closes the room to stragglers;
 *   - a video runner never takes a meeting job, and the reverse.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-recording.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLIENT_A,
  ENV,
  OASIS,
  USERS,
  answerOf,
  check,
  fakeStorage,
  finish,
  later,
  minutes,
  queueDownload,
  scalar,
  setupToolsDatabase,
  signedRequest,
} from "./_tools-harness";
import type { InStatement } from "@libsql/client";
import type { MeetStorage } from "../lib/meet/recording";
import type { SfuClient } from "../lib/meet/sfu";
import type { RecordingView } from "../components/meet/recording-view";

const ROOT = join(__dirname, "..");
const ORIGIN = "https://oasisai.work";
const OTHER = "cccccccc-0000-4000-8000-00000000000c";
const CC = USERS.cc.id;
const ADMIN_USER = USERS.admin.id;
const T0 = new Date("2026-10-17T15:00:00.000Z");
const RUNNER = "ccpc-meet";
const MEET_TOOLS = ["meet_delete_local", "meet_transcribe"];

function fakeMeetStorage(o: { putThrows?: boolean; removeFailsAfter?: number } = {}) {
  const objects = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const signed: string[] = [];
  let removals = 0;
  const storage: MeetStorage = {
    async put(path, bytes) {
      if (o.putThrows) throw new Error("R2 is down");
      objects.set(path, bytes);
    },
    async signedGetUrl(path, ttl) {
      signed.push(path);
      return `https://acct.r2.example/bucket/meet-relay/${path}?X-Amz-Expires=${ttl}&X-Amz-Signature=fake`;
    },
    async remove(path) {
      removals += 1;
      if (o.removeFailsAfter !== undefined && removals > o.removeFailsAfter) throw new Error("delete refused");
      removed.push(path);
      objects.delete(path);
    },
  };
  return { storage, objects, removed, signed };
}

/** An SFU that holds one active track per session until it is closed; `fail` refuses every close. */
function fakeSfu(o: { fail?: boolean } = {}) {
  const closed: string[] = [];
  const flight = { now: 0, max: 0 };
  const sfu = {
    async sessionTracks(sessionId: string) {
      flight.now += 1;
      flight.max = Math.max(flight.max, flight.now);
      await new Promise((r) => setTimeout(r, 15));
      flight.now -= 1;
      return closed.includes(sessionId) ? [] : [{ mid: "0", status: "active", location: "local", trackName: "mic" }];
    },
    async close(sessionId: string, mids: string[]) {
      if (o.fail) throw new Error("the SFU is down");
      closed.push(sessionId);
      return { sessionDescription: null, tracks: mids.map((mid) => ({ mid })) };
    },
  };
  return { sfu: sfu as unknown as SfuClient, closed, flight };
}

type Session = () => Promise<{ ok: true; tenantId: string; userId: string; isTrueAdmin: boolean } | { ok: false }>;
const as = (userId: string, o: { tenant?: string; admin?: boolean } = {}): Session =>
  async () => ({ ok: true, tenantId: o.tenant ?? OASIS, userId, isTrueAdmin: o.admin ?? false });
const signedOut: Session = async () => ({ ok: false });

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  console.log("meet recording:");
  const db = await setupToolsDatabase();
  const migration230 = readFileSync(join(ROOT, "database", "turso", "bravo__230_meet_rooms.sql"), "utf8");
  const migration231 = readFileSync(join(ROOT, "database", "turso", "bravo__231_meet_recordings.sql"), "utf8");
  await db.executeMultiple(migration230);
  await db.executeMultiple(migration231);
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__233_meet_room_recorder.sql"), "utf8"));
  const { createMeetRoom, displayMeetCode } = await import("../lib/meet/rooms");
  const { MEET_TOKEN_SECRET_ENV, signMeetToken } = await import("../lib/meet/access");
  const { MEET_PRESENCE_MS, claimRecorder } = await import("../lib/meet/participants");
  const rec = await import("../lib/meet/recording");
  const routes = await import("../lib/meet/recording-routes");
  const h = await import("../lib/tools/runner-handlers");
  const { insertJob, sweepToolJobs, getJob } = await import("../lib/tools/store");

  // A distinct, valid code per room: the counter written in the code alphabet, padded to ten letters.
  const { MEET_CODE_ALPHABET } = await import("../lib/meet/rooms");
  let codeSeq = 0;
  const nextCode = () => {
    let n = codeSeq++;
    let code = "";
    for (let i = 0; i < 10; i += 1) {
      code = MEET_CODE_ALPHABET[n % MEET_CODE_ALPHABET.length] + code;
      n = Math.floor(n / MEET_CODE_ALPHABET.length);
    }
    return code;
  };
  async function liveRoom(o: { tenant?: string; recordAudio?: boolean; at?: Date } = {}) {
    const at = o.at ?? T0;
    const room = await createMeetRoom(db, {
      tenantId: o.tenant ?? OASIS,
      hostUserId: CC,
      title: "Discovery call",
      recordAudio: o.recordAudio ?? true,
      now: at,
      nextCode,
    });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'live', started_at = ? WHERE id = ?", args: [at.toISOString(), room.id] });
    return { ...room, status: "live" as const, startedAt: at.toISOString() };
  }
  async function endRoom(roomId: string, at: Date) {
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [at.toISOString(), roomId] });
  }
  async function participant(
    room: { id: string; tenantId: string },
    name: string,
    userId: string | null = null,
    consented = true,
    role: "host" | "guest" = userId === CC ? "host" : "guest",
  ) {
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, sfu_session_id, tracks, joined_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?)`,
      args: [id, room.tenantId, room.id, role, userId, name, consented ? T0.toISOString() : null, T0.toISOString(), T0.toISOString()],
    });
    return id;
  }

  const store = fakeMeetStorage();
  const rdeps = (now: Date, session: Session = as(CC), storage: MeetStorage | null = store.storage) => ({
    db,
    storage,
    now: () => now,
    resolveSession: session,
  });
  const chunkReq = (
    code: string,
    f: { participant: string; segment: string; seq: number; startedAt?: number; type?: string; bytes?: number },
    o: { origin?: string | null; name?: string; cookie?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      "x-forwarded-host": "oasisai.work",
      "content-type": f.type ?? "audio/webm;codecs=opus",
      "x-meet-participant": f.participant,
      "x-meet-display-name": encodeURIComponent(o.name ?? "Whatever The Browser Says"),
      "x-meet-segment": f.segment,
      "x-meet-seq": String(f.seq),
      "x-meet-segment-started-at": String(f.startedAt ?? T0.getTime()),
    };
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    // The browser's room cookie (lib/meet/access.ts MEET_COOKIE), among others the browser holds.
    if (o.cookie) headers.cookie = `theme=dark; oasis_meet=${o.cookie}; other=1`;
    return new Request(`${ORIGIN}/api/meet/${code}/recording/chunk`, {
      method: "POST",
      headers,
      body: new Uint8Array(f.bytes ?? 1000).fill(f.seq % 251),
    });
  };
  const upload = async (
    room: { code: string },
    f: Parameters<typeof chunkReq>[1],
    now: Date = later(T0, minutes(1)),
    session: Session = as(CC),
    storage: MeetStorage | null = store.storage,
  ) => routes.handleMeetChunk(chunkReq(displayMeetCode(room.code), f), displayMeetCode(room.code), rdeps(now, session, storage));
  const hostReq = (code: string, method: string, path = "") =>
    new Request(`${ORIGIN}/api/meet/${code}/recording${path}`, { method, headers: { origin: ORIGIN, "x-forwarded-host": "oasisai.work" } });

  const runnerDeps = (now: Date, meet: MeetStorage | null = store.storage) => ({ db, env: ENV, now, storage: fakeStorage().storage, meetStorage: meet });
  const claim = async (now: Date, tools: string[] = MEET_TOOLS, meet: MeetStorage | null = store.storage) =>
    answerOf(await h.handleToolsClaim(signedRequest("claim", { runner_id: RUNNER, label: "CCPC (Windows)", version: "1.0.0", tools }, now), runnerDeps(now, meet)));
  type Claimed = { job_id: string; lease_id: string; tool_key: string; input: Record<string, unknown>; limits: Record<string, number> };
  const ref = (j: Claimed) => ({ runner_id: RUNNER, job_id: j.job_id, lease_id: j.lease_id });
  const transcriptReport = (j: Claimed, o: Record<string, unknown> = {}) => ({
    ...ref(j),
    tool_key: "meet_transcribe",
    transcript_text: "[00:00:01] Conaugh: Thanks for joining.\n[00:00:04] Jordan: Happy to be here.\n",
    lines: [
      { at_ms: T0.getTime() + 1000, end_ms: T0.getTime() + 3000, participant_id: "p-cc", speaker: "Conaugh", text: "Thanks for joining." },
      { at_ms: T0.getTime() + 4000, end_ms: T0.getTime() + 6000, participant_id: "p-guest", speaker: "Jordan", text: "Happy to be here." },
    ],
    model: "small.en",
    transcribe_seconds: 42.5,
    device_label: "CCPC (Windows)",
    local_folder: "C:\\Users\\User\\OASIS\\Meetings\\2026-10-17 Discovery call (abcd1234)",
    ...o,
  });
  const count = async (sql: string, args: Array<string | number | null> = []) => Number(await scalar(db, sql, args));

  await check("the migration is additive and safe to run again", async () => {
    await db.executeMultiple(migration231);
    assert.doesNotMatch(migration231.replace(/--.*$/gm, ""), /\b(drop|alter|delete|update|insert)\b/i, "only CREATE ... IF NOT EXISTS");
    assert.equal(await rec.meetRecordingTablesInstalled(db), true);
  });

  // ---------------------------------------------------------------------
  // RECORD
  // ---------------------------------------------------------------------
  const r1 = await liveRoom();
  const pCc = await participant(r1, "Conaugh", CC);
  const pGuest = await participant(r1, "Jordan");
  const segA = crypto.randomUUID();
  const segB = crypto.randomUUID();

  await check("a chunk is the host's only: signed out 401, another workspace 404, a member who is not the host 403, cross-site 403", async () => {
    const code = displayMeetCode(r1.code);
    const f = { participant: pCc, segment: segA, seq: 0 };
    assert.equal((await routes.handleMeetChunk(chunkReq(code, f), code, rdeps(T0, signedOut))).status, 401);
    assert.equal((await routes.handleMeetChunk(chunkReq(code, f), code, rdeps(T0, as(CC, { tenant: OTHER })))).status, 404);
    assert.equal((await routes.handleMeetChunk(chunkReq(code, f), code, rdeps(T0, as(USERS.rep.id)))).status, 403);
    assert.equal((await routes.handleMeetChunk(chunkReq(code, f, { origin: "https://evil.example" }), code, rdeps(T0))).status, 403);
    assert.equal((await routes.handleMeetChunk(chunkReq(code, f, { origin: null }), code, rdeps(T0))).status, 403);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks"), 0, "nothing was written");
    assert.equal(store.objects.size, 0, "nothing was uploaded");
  });

  await check("a chunk lands under its workspace's own path, named by the participant ROW, and a retry is a 409 duplicate", async () => {
    const res = await upload(r1, { participant: pGuest, segment: segA, seq: 0 });
    assert.equal(res.status, 201, JSON.stringify(await body(res.clone())));
    const path = `${OASIS}/${r1.id}/${pGuest}/${segA}/0`;
    assert.ok(store.objects.has(path), [...store.objects.keys()].join(","));
    const row = (await db.execute({ sql: "SELECT display_name, mime_type, bytes, storage_path, uploaded_by FROM meet_recording_chunks", args: [] })).rows[0];
    assert.deepEqual([row.display_name, row.mime_type, Number(row.bytes), row.storage_path, row.uploaded_by], ["Jordan", "audio/webm;codecs=opus", 1000, path, CC]);
    const again = await upload(r1, { participant: pGuest, segment: segA, seq: 0 });
    assert.deepEqual([again.status, (await body(again)).error], [409, "duplicate"]);
    assert.ok(store.objects.has(path), "a duplicate deleted the chunk it duplicates");
  });

  await check("bad input is refused with a status the recorder will not retry, and nothing is kept", async () => {
    const before = store.objects.size;
    const bad = [
      [{ participant: "../../x", segment: segB, seq: 0 }, 422],
      [{ participant: pCc, segment: "a/b", seq: 0 }, 422],
      [{ participant: pCc, segment: segB, seq: -1 }, 422],
      [{ participant: pCc, segment: segB, seq: 100_001 }, 422],
      [{ participant: pCc, segment: segB, seq: 0, startedAt: T0.getTime() + minutes(60) }, 422],
      [{ participant: pCc, segment: segB, seq: 0, startedAt: T0.getTime() - minutes(2 * 24 * 60) }, 422],
      [{ participant: pCc, segment: segB, seq: 0, type: "video/mp4" }, 415],
      [{ participant: pCc, segment: segB, seq: 0, bytes: 512 * 1024 + 1 }, 413],
      [{ participant: pCc, segment: segB, seq: 0, bytes: 0 }, 422],
      [{ participant: crypto.randomUUID(), segment: segB, seq: 0 }, 422],
    ] as const;
    for (const [f, status] of bad) {
      const res = await upload(r1, f);
      assert.equal(res.status, status, JSON.stringify(f));
    }
    assert.equal(store.objects.size, before);
    for (const type of ["audio/webm", "audio/ogg; codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
      assert.ok(rec.normalizeRecordingMime(type), type);
    }
  });

  // ONE BROWSER RECORDS A ROOM (migration bravo__233; e9's pins). Who sends a chunk is the browser's room cookie (the
  // participant row it joined as), never the speaker header. Each check has a room of its own, taken away after, and
  // the recording changes hands through the real lib/meet/participants.ts claimRecorder.
  const tokenSecret = process.env[MEET_TOKEN_SECRET_ENV];
  process.env[MEET_TOKEN_SECRET_ENV] = "a-test-only-secret-that-is-long-enough-1234";
  const ADMIN_SESSION = as(ADMIN_USER, { admin: true });
  /** A browser's poll: it is heard from at `at`, which is what claimRecorder reads. */
  const seenAt = (id: string, at: Date) => db.execute({ sql: "UPDATE meet_participants SET last_seen_at = ? WHERE id = ?", args: [at.toISOString(), id] });
  const goneAt = (id: string, column: "left_at" | "removed_at", at: Date) =>
    db.execute({ sql: `UPDATE meet_participants SET ${column} = ? WHERE id = ?`, args: [at.toISOString(), id] });
  /** One chunk of the guest's voice, sent by a browser (its room cookie, or none) of the signed-in host `session`. */
  const sendFrom = (room: { id: string; code: string }, speaker: string) => async (browser: string | null, session: Session, at: Date) => {
    const code = displayMeetCode(room.code);
    const cookie = browser ? signMeetToken({ roomId: room.id, participantId: browser, role: "host" }, at.getTime()) : undefined;
    const res = await routes.handleMeetChunk(chunkReq(code, { participant: speaker, segment: crypto.randomUUID(), seq: 0 }, { cookie }), code, rdeps(at, session));
    return res.status === 201 ? 201 : `${res.status} ${(await body(res)).error}`;
  };
  /** A check's own room, taken away again, so the sweeps further down this file never meet it. */
  const dropRoom = async (room: { id: string }) => {
    const paths = (await db.execute({ sql: "SELECT storage_path FROM meet_recording_chunks WHERE room_id = ?", args: [room.id] })).rows;
    for (const p of paths) store.objects.delete(String(p.storage_path));
    for (const sql of ["DELETE FROM meet_recording_chunks WHERE room_id = ?", "DELETE FROM meet_participants WHERE room_id = ?", "DELETE FROM meet_rooms WHERE id = ?"]) {
      await db.execute({ sql, args: [room.id] });
    }
  };

  await check("one browser records a room: its recorder's chunks are taken; another browser still in the call is 423, and so is a chunk naming no browser or someone else's row", async () => {
    const room = await liveRoom();
    try {
      const send = sendFrom(room, await participant(room, "Jordan"));
      const cc = await participant(room, "Conaugh", CC);
      const admin = await participant(room, "Operations Admin", ADMIN_USER, true, "host");
      const phone = await participant(room, "Conaugh", CC);
      const at = later(T0, minutes(2));
      for (const id of [cc, admin, phone]) await seenAt(id, at);
      assert.equal((await claimRecorder(db, room, { id: cc }, at, true)).mine, true);
      assert.equal((await claimRecorder(db, room, { id: admin }, at, true)).mine, false, "CC's browser is there: it keeps the recording");
      assert.equal(await send(cc, as(CC), at), 201, "the room's recorder");
      assert.equal(await send(admin, ADMIN_SESSION, at), "423 another_recorder", "another host's browser, still in the call");
      assert.equal(await send(phone, as(CC), at), "423 another_recorder", "the same host on a second device: one browser, not one person");
      assert.equal(await send(null, as(CC), at), "423 another_recorder", "a chunk that names no browser, while one records");
      assert.equal(await send(cc, ADMIN_SESSION, at), "423 another_recorder", "a cookie naming someone else's row names no one");
    } finally {
      await dropRoom(room);
    }
  });

  await check("the recorder taken over sends its last chunks for LATE_CHUNK_MS, though it went silent rather than leave; then 423", async () => {
    const room = await liveRoom();
    try {
      const send = sendFrom(room, await participant(room, "Jordan"));
      const cc = await participant(room, "Conaugh", CC);
      const admin = await participant(room, "Operations Admin", ADMIN_USER, true, "host");
      const at = later(T0, minutes(2));
      await seenAt(cc, at);
      assert.equal((await claimRecorder(db, room, { id: cc }, at, true)).mine, true);
      // CC's laptop goes quiet past MEET_PRESENCE_MS without leaving (a bad network), and the admin's poll takes over.
      const taken = later(at, MEET_PRESENCE_MS + 1_000);
      await seenAt(admin, taken);
      assert.equal((await claimRecorder(db, room, { id: admin }, taken, true)).mine, true);
      const row = (await db.execute({ sql: "SELECT recorder_previous_id AS p, recorder_changed_at AS c FROM meet_rooms WHERE id = ?", args: [room.id] })).rows[0];
      assert.deepEqual([row.p, row.c], [cc, taken.toISOString()], "the room notes whose recording it took, and when");
      assert.equal(await send(cc, as(CC), later(taken, 5_000)), 201, "CC's browser, back and stopping: its last chunks are kept");
      assert.equal(await send(admin, ADMIN_SESSION, later(taken, 5_000)), 201, "the new recorder's too");
      assert.equal(await send(cc, as(CC), later(taken, rec.LATE_CHUNK_MS + 1_000)), "423 another_recorder", "but only for LATE_CHUNK_MS after the change");
    } finally {
      await dropRoom(room);
    }
  });

  await check("a browser that left or was removed sends its last chunks for LATE_CHUNK_MS, even once the recording has passed on twice; then 423", async () => {
    const room = await liveRoom();
    try {
      const send = sendFrom(room, await participant(room, "Jordan"));
      const cc = await participant(room, "Conaugh", CC);
      const admin = await participant(room, "Operations Admin", ADMIN_USER, true, "host");
      const phone = await participant(room, "Conaugh", CC);
      const tablet = await participant(room, "Conaugh", CC);
      const at = later(T0, minutes(2));
      for (const id of [cc, admin, phone, tablet]) await seenAt(id, at);
      await claimRecorder(db, room, { id: cc }, at, true);
      // CC leaves and the admin's browser takes over; the admin leaves and CC's phone takes over. CC's browser is no longer the
      // one taken over: only having left keeps its last chunks.
      await goneAt(cc, "left_at", at);
      assert.equal((await claimRecorder(db, room, { id: admin }, at, true)).mine, true);
      const next = later(at, 1_000);
      await goneAt(admin, "left_at", next);
      await seenAt(phone, next);
      assert.equal((await claimRecorder(db, room, { id: phone }, next, true)).mine, true);
      await goneAt(tablet, "removed_at", next);
      assert.equal(await send(cc, as(CC), later(at, 30_000)), 201, "CC's browser left: its last chunks are kept");
      assert.equal(await send(tablet, as(CC), later(at, 30_000)), 201, "a removed browser's last chunks too");
      assert.equal(await send(cc, as(CC), later(at, rec.LATE_CHUNK_MS + 1_000)), "423 another_recorder", "but only for LATE_CHUNK_MS after it went");
    } finally {
      await dropRoom(room);
    }
  });

  await check("the recording taken between the gate's read and the INSERT: the INSERT itself refuses it (423), keeps no row and deletes the stored copy", async () => {
    // e9's G8: the pre-check reads that no browser records; another host's browser takes the recording (the real
    // claimRecorder) before the INSERT runs. Only the gate inside the INSERT can refuse it now.
    const room = await liveRoom();
    try {
      const guest = await participant(room, "Jordan");
      const cc = await participant(room, "Conaugh", CC);
      const admin = await participant(room, "Operations Admin", ADMIN_USER, true, "host");
      const code = displayMeetCode(room.code);
      const segment = crypto.randomUUID();
      const at = later(T0, minutes(3));
      let taken = false;
      const racing = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "execute") return typeof value === "function" ? value.bind(target) : value;
          return async (stmt: InStatement) => {
            if (!taken && /INSERT INTO meet_recording_chunks/.test(typeof stmt === "string" ? stmt : stmt.sql)) {
              taken = true;
              assert.equal((await claimRecorder(target, room, { id: admin }, at, true)).mine, true, "the admin's browser takes the recording");
            }
            return target.execute(stmt);
          };
        },
      });
      const cookie = signMeetToken({ roomId: room.id, participantId: cc, role: "host" }, at.getTime());
      const res = await routes.handleMeetChunk(chunkReq(code, { participant: guest, segment, seq: 0 }, { cookie }), code, {
        db: racing, storage: store.storage, now: () => at, resolveSession: as(CC),
      });
      assert.ok(taken, "the recording changed hands between the gate's read and the INSERT");
      assert.deepEqual([res.status, (await body(res)).error], [423, "another_recorder"]);
      assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE segment_id = ?", [segment]), 0, "no row");
      assert.ok(!store.objects.has(`${OASIS}/${room.id}/${guest}/${segment}/0`), "and the stored copy nothing points at is deleted");
    } finally {
      await dropRoom(room);
    }
  });
  if (tokenSecret === undefined) delete process.env[MEET_TOKEN_SECRET_ENV];
  else process.env[MEET_TOKEN_SECRET_ENV] = tokenSecret;

  await check("R2 failing is a 502 the recorder retries, and no row points at nothing", async () => {
    const down = fakeMeetStorage({ putThrows: true });
    const res = await upload(r1, { participant: pCc, segment: segB, seq: 0 }, later(T0, minutes(5)), as(CC), down.storage);
    assert.equal(res.status, 502);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE segment_id = ?", [segB]), 0);
    const notConfigured = await upload(r1, { participant: pCc, segment: segB, seq: 0 }, later(T0, minutes(5)), as(CC), null);
    assert.equal(notConfigured.status, 503);
  });

  // The recording r1 hands over: CC's segment B is whole (0,1,2); the guest's segment A has 0,1 then a gap
  // (3 arrived, 2 never did); segment C of the guest has no chunk 0 (its header never arrived).
  const segD = crypto.randomUUID();
  for (const [p, s, seq, at] of [
    [pCc, segB, 0, T0.getTime() + 500],
    [pCc, segB, 1, T0.getTime() + 500],
    [pCc, segB, 2, T0.getTime() + 500],
    [pGuest, segA, 1, T0.getTime()],
    [pGuest, segA, 3, T0.getTime()],
    [pGuest, segD, 1, T0.getTime() + 60_000],
  ] as const) {
    const res = await upload(r1, { participant: p, segment: s, seq, startedAt: at }, later(T0, minutes(6)));
    assert.equal(res.status, 201, `${s} ${seq}`);
  }

  // ---------------------------------------------------------------------
  // HAND OVER
  // ---------------------------------------------------------------------
  const code1 = displayMeetCode(r1.code);
  await check("finalize waits for the end (409 not_ended), then hands over once: one row, one job, idempotent", async () => {
    const early = await routes.handleMeetFinalize(hostReq(code1, "POST", "/finalize"), code1, rdeps(later(T0, minutes(7))));
    assert.deepEqual([early.status, (await body(early)).error], [409, "not_ended"]);
    await endRoom(r1.id, later(T0, minutes(8)));
    const first = await routes.handleMeetFinalize(hostReq(code1, "POST", "/finalize"), code1, rdeps(later(T0, minutes(8))));
    assert.deepEqual([first.status, (await body(first)).state], [200, "queued"]);
    // The recording browser's own report: 5 chunks it could not upload, 1 recorder error. Kept on the row,
    // because a lost LAST chunk leaves no gap in the rows to infer it from (Codex on #685, second pass).
    const reported = new Request(`${ORIGIN}/api/meet/${code1}/recording/finalize`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-forwarded-host": "oasisai.work", "content-type": "application/json" },
      body: JSON.stringify({ sent: 9, failed: 5, segments: 3, errored: 1 }),
    });
    const second = await routes.handleMeetFinalize(reported, code1, rdeps(later(T0, minutes(9))));
    assert.deepEqual([second.status, (await body(second)).state], [200, "queued"]);
    const kept = await rec.readTranscript(db, OASIS, r1.id);
    assert.deepEqual([kept?.recorderFailed, kept?.recorderErrored], [5, 1]);
    assert.equal(await count("SELECT COUNT(*) FROM tool_jobs WHERE tool_key = 'meet_transcribe'"), 1);
    const t = await rec.readTranscript(db, OASIS, r1.id);
    assert.equal(t?.status, "queued");
    assert.equal(t?.relayExpiresAt, new Date(later(T0, minutes(8)).getTime() + 30 * 86_400_000).toISOString(), "30 days from the meeting's END");
    const job = await getJob(db, OASIS, String(t?.jobId));
    assert.deepEqual([job?.status, job?.runsOn, job?.dedupeKey, job?.createdBy], ["queued", "runner", `meet_transcribe:${r1.id}`, CC]);
  });

  await check("a late chunk within 10 minutes of the end is kept (the claim has not fixed the segments yet); after that, 410", async () => {
    const late = await upload(r1, { participant: pCc, segment: segB, seq: 3, startedAt: T0.getTime() + 500 }, later(T0, minutes(17)));
    assert.equal(late.status, 201);
    const tooLate = await upload(r1, { participant: pCc, segment: segB, seq: 4, startedAt: T0.getTime() + 500 }, later(T0, minutes(19)));
    assert.deepEqual([tooLate.status, (await body(tooLate)).error], [410, "recording_closed"]);
  });

  await check("the Content Tools runner never takes a meeting job, and the meeting runner never takes a download", async () => {
    const dl = await queueDownload(db, OASIS, later(T0, minutes(9)));
    const video = await claim(later(T0, minutes(10)), ["video_download"]);
    assert.equal((video.body.job as Claimed).job_id, dl, "the video runner took the download");
    const nothing = await claim(later(T0, minutes(10)), ["video_download"]);
    assert.equal(nothing.body.job, null, "the video runner took a meeting job");
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'done' WHERE id = ?", args: [dl] });
  });

  // ---------------------------------------------------------------------
  // TRANSCRIBE
  // ---------------------------------------------------------------------
  let job1: Claimed;
  await check("the claim fixes every decodable segment with ALL its chunks (a gap is kept, a headerless segment is not), oldest first", async () => {
    const a = await claim(later(T0, minutes(20)));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    job1 = a.body.job as Claimed;
    assert.equal(job1.tool_key, "meet_transcribe");
    assert.deepEqual(Object.keys(job1.input).sort(), ["room_id", "segments", "started_at_ms", "title"], "nothing but what the PC needs");
    assert.deepEqual([job1.input.room_id, job1.input.title, job1.input.started_at_ms], [r1.id, "Discovery call", T0.getTime()]);
    assert.deepEqual(job1.input.segments, [
      { participant_id: pGuest, display_name: "Jordan", segment_id: segA, started_at_ms: T0.getTime(), mime_type: "audio/webm;codecs=opus", chunk_count: 3 },
      { participant_id: pCc, display_name: "Conaugh", segment_id: segB, started_at_ms: T0.getTime() + 500, mime_type: "audio/webm;codecs=opus", chunk_count: 4 },
    ]);
    assert.equal(job1.limits.max_hold_seconds, 24 * 60 * 60);
    assert.equal(job1.limits.queue_depth, 0);
    const t = await rec.readTranscript(db, OASIS, r1.id);
    // segA: 0, 1 and 3 go to the PC (seq 2 never arrived: one missing). segD has no chunk 0, so its two
    // chunks' worth (seq 0 lost, seq 1 unreadable without it) is missing too. The audio after segA's hole is
    // kept: the PC fills the hole with silence and later words keep their times.
    assert.deepEqual([t?.status, t?.chunkCount, t?.missingChunks], ["transcribing", 7, 3]);
  });

  await check("download-urls signs exactly the declared chunks, in order; another lease is lease_lost; no relay is 503", async () => {
    const before = store.signed.length;
    const a = await answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", ref(job1), later(T0, minutes(21))), runnerDeps(later(T0, minutes(21)))));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const files = a.body.files as Array<{ participant_id: string; segment_id: string; seq: number; url: string }>;
    const got = files.map((f) => `${f.participant_id === pCc ? "cc" : "guest"}:${f.segment_id === segB ? "B" : "A"}:${f.seq}`).sort();
    assert.deepEqual(got, ["cc:B:0", "cc:B:1", "cc:B:2", "cc:B:3", "guest:A:0", "guest:A:1", "guest:A:3"]);
    assert.equal(store.signed.length - before, 7);
    assert.ok(files.every((f) => f.url.startsWith("https://acct.r2.example/bucket/meet-relay/" + OASIS + "/")));
    const lost = await answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", { ...ref(job1), lease_id: "f".repeat(32) }, later(T0, minutes(21))), runnerDeps(later(T0, minutes(21)))));
    assert.deepEqual([lost.status, lost.body.error], [409, "lease_lost"]);
    const none = await answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", ref(job1), later(T0, minutes(21))), runnerDeps(later(T0, minutes(21)), null)));
    assert.deepEqual([none.status, none.body.error, none.body.detail], [503, "not_installed", "storage_not_configured"]);
    assert.deepEqual([a.body.total, a.body.next_offset], [7, null], "one page holds a short meeting whole");
  });

  await check("download-urls pages a long meeting: the same order on every page, the last page says so, a bad offset is 422", async () => {
    const at = later(T0, minutes(22));
    const page = async (body: Record<string, unknown>) =>
      answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", { ...ref(job1), ...body }, at), runnerDeps(at)));
    const whole = (await page({})).body.files as Array<{ participant_id: string; segment_id: string; seq: number }>;
    const first = await page({ limit: 4 });
    const second = await page({ offset: first.body.next_offset, limit: 4 });
    assert.deepEqual([first.body.next_offset, second.body.next_offset, second.body.total], [4, null, 7]);
    const key = (f: { participant_id: string; segment_id: string; seq: number }) => `${f.participant_id}/${f.segment_id}/${f.seq}`;
    assert.deepEqual(
      [...(first.body.files as typeof whole), ...(second.body.files as typeof whole)].map(key),
      whole.map(key),
      "two pages are not the whole, in order",
    );
    for (const bad of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { offset: "4" }]) {
      assert.equal((await page(bad)).status, 422, JSON.stringify(bad));
    }
    const capped = await page({ limit: 1_000_000 });
    assert.equal((capped.body.files as unknown[]).length, 7, "a huge limit is capped, not refused");
  });

  await check("a meeting job reports its own stages for up to 24 hours; a download's stage list is unchanged", async () => {
    for (const stage of ["downloading", "transcribing", "finishing"]) {
      const a = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage }, later(T0, minutes(30))), runnerDeps(later(T0, minutes(30)))));
      assert.equal(a.status, 200, `${stage}: ${JSON.stringify(a.body)}`);
    }
    const uploading = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage: "uploading" }, later(T0, minutes(31))), runnerDeps(later(T0, minutes(31)))));
    assert.deepEqual([uploading.status, uploading.body.error], [422, "invalid_payload"], "a meeting job never uploads");
    // Eight speakers for hours on a CPU: twenty hours into a transcription the lease still extends (a download's
    // limit is 45 minutes, and four hours was shorter than recordings the relay takes).
    const twentyHours = later(T0, minutes(20 + 20 * 60));
    const ok = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage: "transcribing" }, twentyHours), runnerDeps(twentyHours)));
    assert.equal(ok.status, 200, "twenty hours into a transcription the lease no longer extends");
    const bogus = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage: "dancing" }, twentyHours), runnerDeps(twentyHours)));
    assert.equal(bogus.status, 422);
  });

  await check("complete stores the transcript, finishes the job, and deletes the relay copies; a repeat is a duplicate success", async () => {
    const at = later(T0, minutes(200));
    const bad = await answerOf(await h.handleToolsComplete(signedRequest("complete", transcriptReport(job1, { model: "small en; DROP" }), at), runnerDeps(at)));
    assert.deepEqual([bad.status, bad.body.field], [422, "model"]);
    const wrongTool = await answerOf(await h.handleToolsComplete(signedRequest("complete", { ...transcriptReport(job1), tool_key: "video_download" }, at), runnerDeps(at)));
    assert.deepEqual([wrongTool.status, wrongTool.body.field], [422, "tool_key"]);
    const objectsBefore = store.objects.size;
    const a = await answerOf(await h.handleToolsComplete(signedRequest("complete", transcriptReport(job1), at), runnerDeps(at)));
    assert.deepEqual([a.status, a.body.duplicate], [200, false], JSON.stringify(a.body));
    const t = await rec.readTranscript(db, OASIS, r1.id);
    assert.equal(t?.status, "ready");
    assert.equal(t?.lines.length, 2);
    assert.equal(t?.deviceLabel, "CCPC (Windows)");
    assert.equal((await getJob(db, OASIS, job1.job_id))?.status, "done");
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [r1.id]), 0, "every relay chunk of the room went, the missing-run ones too");
    assert.equal(store.objects.size, objectsBefore - 8);
    const again = await answerOf(await h.handleToolsComplete(signedRequest("complete", transcriptReport(job1), at), runnerDeps(at)));
    assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  });

  await check("a transcript bigger than 64 KiB is taken on complete (2 MiB cap), and one past the cap is 413", async () => {
    const big = JSON.stringify({ ...transcriptReport(job1), transcript_text: "x".repeat(200 * 1024) });
    const a = await answerOf(await h.handleToolsComplete(signedRequest("complete", null, later(T0, minutes(201)), { raw: big }), runnerDeps(later(T0, minutes(201)))));
    assert.equal(a.status, 200, "a 200 KiB body was refused");
    const huge = JSON.stringify({ ...transcriptReport(job1), transcript_text: "x".repeat(2 * 1024 * 1024 + 10) });
    const b = await answerOf(await h.handleToolsComplete(signedRequest("complete", null, later(T0, minutes(201)), { raw: huge }), runnerDeps(later(T0, minutes(201)))));
    assert.deepEqual([b.status, b.body.error], [413, "body_too_large"]);
  });

  await check("the panel shows the transcript, where the audio is (the folder's name, never the full path), and closes to stragglers", async () => {
    const res = await routes.handleMeetRecordingGet(hostReq(code1, "GET"), code1, rdeps(later(T0, minutes(202))));
    const view = (await body(res)).recording as Record<string, unknown> & { transcript: Record<string, unknown> };
    assert.equal(view.state, "ready");
    assert.equal(view.transcript.deviceLabel, "CCPC (Windows)");
    assert.equal(view.transcript.folderName, "2026-10-17 Discovery call (abcd1234)");
    assert.doesNotMatch(JSON.stringify(view), /Users\\\\User/, "the full local path reached the page");
    assert.equal(view.transcript.startedAtMs, T0.getTime());
    // 3 chunks are missing by the rows, 5 by the browser's own report: the larger is said.
    assert.deepEqual([view.missingChunks, view.recorderErrored], [5, 1]);
    assert.equal((view.runner as { label: string }).label, "CCPC (Windows)");
    const guest = await routes.handleMeetRecordingGet(hostReq(code1, "GET"), code1, rdeps(later(T0, minutes(202)), as(USERS.rep.id)));
    assert.equal(guest.status, 403, "a member who is not the host read the transcript");
  });

  // ---------------------------------------------------------------------
  // The relay's batches, the sweeps
  // ---------------------------------------------------------------------
  await check("the relay is freed at most 100 objects per request; a failed delete stops the batch and keeps its rows", async () => {
    const r = await liveRoom({ at: later(T0, minutes(300)) });
    const p = await participant(r, "Sam");
    const seg = crypto.randomUUID();
    const at = later(T0, minutes(301));
    const rows = Array.from({ length: 150 }, (_, i) => i);
    await db.batch(
      rows.map((i) => ({
        sql: `INSERT INTO meet_recording_chunks (id, tenant_id, room_id, participant_id, display_name, segment_id, seq, segment_started_ms, mime_type, bytes, storage_path, uploaded_by, created_at)
              VALUES (?, ?, ?, ?, 'Sam', ?, ?, ?, 'audio/webm', 10, ?, ?, ?)`,
        args: [crypto.randomUUID(), OASIS, r.id, p, seg, i, at.getTime(), `${OASIS}/${r.id}/${p}/${seg}/${i}`, CC, at.toISOString()],
      })),
      "write",
    );
    await db.execute({
      sql: `INSERT INTO meet_transcripts (id, tenant_id, room_id, status, relay_expires_at, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?)`,
      args: [crypto.randomUUID(), OASIS, r.id, later(at, minutes(60 * 24 * 30)).toISOString(), at.toISOString(), at.toISOString()],
    });
    const flaky = fakeMeetStorage({ removeFailsAfter: 30 });
    assert.equal(await rec.removeRelayChunks(db, flaky.storage, { tenantIds: [OASIS], roomId: r.id }), 30);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [r.id]), 120, "rows of objects not deleted were dropped");
    const fine = fakeMeetStorage();
    assert.equal(await rec.removeRelayChunks(db, fine.storage, { tenantIds: [OASIS], roomId: r.id }), 100);
    // The PC's next claim takes the rest.
    await claim(later(at, minutes(1)));
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [r.id]), 0);
  });

  await check("a meeting job is never failed as runner_offline and never counts toward the five downloads", async () => {
    const r = await liveRoom({ at: later(T0, minutes(400)) });
    const p = await participant(r, "Lee");
    assert.equal((await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: later(T0, minutes(400)).getTime() }, later(T0, minutes(401)))).status, 201);
    await endRoom(r.id, later(T0, minutes(402)));
    const code = displayMeetCode(r.code);
    assert.equal((await body(await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(T0, minutes(402)))))).state, "queued");
    const jobId = String((await rec.readTranscript(db, OASIS, r.id))?.jobId);
    // Two days later, no runner seen: a download queued at the same time IS failed runner_offline (the
    // control, and what makes the sweep run at all), the meeting is not.
    const download = await queueDownload(db, OASIS, later(T0, minutes(402)), { url: "https://www.instagram.com/reel/OFFLINE1/" });
    const twoDays = later(T0, minutes(402 + 2 * 24 * 60));
    await sweepToolJobs(db, [OASIS], twoDays);
    const control = await getJob(db, OASIS, download);
    assert.deepEqual([control?.status, control?.errorCode], ["failed", "runner_offline"], "control: the sweep did not run");
    assert.equal((await getJob(db, OASIS, jobId))?.status, "queued", "the PC being off failed the meeting");
    for (let i = 0; i < 5; i += 1) {
      await db.execute({
        sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, dedupe_key, created_at, updated_at)
              VALUES (?, ?, 'meet_delete_local', 'runner', 'queued', '{}', 'h', ?, ?, ?)`,
        args: [crypto.randomUUID(), OASIS, `meet_delete_local:fake-${i}`, twoDays.toISOString(), twoDays.toISOString()],
      });
    }
    const inserted = await insertJob(
      db,
      { id: crypto.randomUUID(), tenantId: OASIS, toolKey: "video_download", runsOn: "runner", input: {}, inputHash: "x", idempotencyKey: crypto.randomUUID(), dedupeKey: null, createdBy: null, createdByEmail: null },
      twoDays,
    );
    assert.equal(inserted, "inserted", "queued meeting jobs took a download's place");
    await db.execute({ sql: "DELETE FROM tool_jobs WHERE dedupe_key LIKE 'meet_delete_local:fake-%' OR (tool_key = 'video_download' AND status = 'queued')", args: [] });
  });

  await check("30 days on the relay: the queued job fails relay_expired, the recording is expired and its audio deleted", async () => {
    const r = await db.execute("SELECT room_id, job_id FROM meet_transcripts WHERE status = 'queued' LIMIT 1");
    const roomId = String(r.rows[0].room_id);
    const jobId = String(r.rows[0].job_id);
    const past = later(T0, minutes(402 + 31 * 24 * 60));
    await claim(past);
    const t = await rec.readTranscript(db, OASIS, roomId);
    assert.equal(t?.status, "expired");
    const job = await getJob(db, OASIS, jobId);
    assert.deepEqual([job?.status, job?.errorCode], ["failed", "relay_expired"]);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [roomId]), 0);
  });

  await check("a meeting nobody finalized is handed over by the PC's own claim, 10 minutes after its end, and claimed at once", async () => {
    const r = await liveRoom({ at: later(T0, minutes(50_000)) });
    const p = await participant(r, "Ana");
    assert.equal((await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: later(T0, minutes(50_000)).getTime() }, later(T0, minutes(50_001)))).status, 201);
    await endRoom(r.id, later(T0, minutes(50_002)));
    const early = await claim(later(T0, minutes(50_005)));
    assert.equal(early.body.job, null, "handed over before the late-chunk window closed");
    const a = await claim(later(T0, minutes(50_013)));
    const job = a.body.job as Claimed;
    assert.equal(job?.input.room_id, r.id);
    assert.equal((await getJob(db, OASIS, job.job_id))?.createdBy, null);
    // The runner fails it; the panel then says so and offers Try again.
    const failed = await answerOf(await h.handleToolsFail(signedRequest("fail", { ...ref(job), error_code: "transcribe_failed" }, later(T0, minutes(50_014))), runnerDeps(later(T0, minutes(50_014)))));
    assert.equal(failed.status, 200);
    const code = displayMeetCode(r.code);
    const view = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(T0, minutes(50_015)))))).recording as { state: string; job: { errorCode: string } };
    assert.deepEqual([view.state, view.job.errorCode], ["failed", "transcribe_failed"]);
    const retry = await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(T0, minutes(50_016))));
    assert.equal((await body(retry)).state, "queued");
    assert.equal(await count("SELECT COUNT(*) FROM tool_jobs WHERE tool_key = 'meet_transcribe' AND dedupe_key = ?", [`meet_transcribe:${r.id}`]), 2, "Try again made a new job");
  });

  // ---------------------------------------------------------------------
  // DELETE
  // ---------------------------------------------------------------------
  await check("delete while the PC transcribes: the transcription is called off, the PC is told to delete its copy, stragglers get 410", async () => {
    const t = await db.execute("SELECT room_id FROM meet_transcripts WHERE status = 'queued' LIMIT 1");
    const roomId = String(t.rows[0].room_id);
    const room = (await db.execute({ sql: "SELECT code FROM meet_rooms WHERE id = ?", args: [roomId] })).rows[0];
    const code = displayMeetCode(String(room.code));
    const now = later(T0, minutes(50_020));
    const running = (await claim(now)).body.job as Claimed;
    assert.equal(running.tool_key, "meet_transcribe");
    const cross = await routes.handleMeetRecordingDelete(
      new Request(`${ORIGIN}/api/meet/${code}/recording`, { method: "DELETE", headers: { origin: "https://evil.example", "x-forwarded-host": "oasisai.work" } }),
      code,
      rdeps(now),
    );
    assert.equal(cross.status, 403);
    const del = await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(now));
    const out = await body(del);
    assert.deepEqual([del.status, out.device_delete_queued, out.relay_remaining], [200, true, 0]);
    const pending = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(now)))).recording as {
      state: string;
      deviceDelete: { status: string } | null;
    };
    assert.deepEqual([pending.state, pending.deviceDelete?.status], ["deleted", "waiting"], "the panel called the PC's copy deleted before the PC had");
    assert.equal((await getJob(db, OASIS, running.job_id))?.errorCode, "meeting_deleted");
    const lost = await answerOf(await h.handleToolsComplete(signedRequest("complete", transcriptReport(running), now), runnerDeps(now)));
    assert.deepEqual([lost.status, lost.body.error], [409, "lease_lost"], "a deleted recording's transcript was stored");
    const deleteJob = (await claim(later(now, 1000))).body.job as Claimed;
    assert.deepEqual([deleteJob.tool_key, deleteJob.input.room_id, deleteJob.limits.max_hold_seconds], ["meet_delete_local", roomId, 45 * 60]);
    const done = await answerOf(
      await h.handleToolsComplete(
        signedRequest("complete", { ...ref(deleteJob), tool_key: "meet_delete_local", removed: ["C:\\x"], already_gone: false, device_label: "CCPC (Windows)" }, later(now, 2000)),
        runnerDeps(later(now, 2000)),
      ),
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const after = await rec.readTranscript(db, OASIS, roomId);
    assert.deepEqual([after?.status, after?.text, after?.lines.length, Boolean(after?.localDeletedAt)], ["deleted", null, 0, true]);
    const confirmed = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(now, 2500))))).recording as {
      deviceDelete: { status: string } | null;
    };
    assert.equal(confirmed.deviceDelete?.status, "done");
    // A second delete does not tell the PC again.
    await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(later(now, 3000)));
    assert.equal(await count("SELECT COUNT(*) FROM tool_jobs WHERE tool_key = 'meet_delete_local' AND dedupe_key = ?", [`meet_delete_local:${roomId}`]), 1);
  });

  await check("delete of a recording the PC never took: no job for the PC, and the room can never be handed over again", async () => {
    const r = await liveRoom({ at: later(T0, minutes(60_000)) });
    const p = await participant(r, "Kim");
    assert.equal((await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: later(T0, minutes(60_000)).getTime() }, later(T0, minutes(60_001)))).status, 201);
    await endRoom(r.id, later(T0, minutes(60_002)));
    const code = displayMeetCode(r.code);
    // Handed over, but the PC never claimed it: its job is queued with no attempt, so the PC has no copy.
    assert.equal((await body(await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(T0, minutes(60_002)))))).state, "queued");
    const del = await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(later(T0, minutes(60_003))));
    assert.equal((await body(del)).device_delete_queued, false, "the PC was told to delete a copy it never had");
    assert.equal(await count("SELECT COUNT(*) FROM tool_jobs WHERE tool_key = 'meet_delete_local' AND dedupe_key = ?", [`meet_delete_local:${r.id}`]), 0);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [r.id]), 0);
    const straggler = await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: later(T0, minutes(60_000)).getTime() }, later(T0, minutes(60_004)));
    assert.deepEqual([straggler.status, (await body(straggler)).error], [410, "recording_closed"]);
    assert.equal((await body(await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(T0, minutes(60_005)))))).state, "deleted");
  });

  await check("the PC failing to delete its copy shows as failed, never as deleted, and Delete again tells it again", async () => {
    const at = later(T0, minutes(62_000));
    const r = await liveRoom({ at });
    const p = await participant(r, "Ola");
    assert.equal((await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)))).status, 201);
    await endRoom(r.id, later(at, minutes(2)));
    const code = displayMeetCode(r.code);
    await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(at, minutes(2))));
    assert.equal(((await claim(later(at, minutes(3)))).body.job as Claimed).tool_key, "meet_transcribe");
    await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(later(at, minutes(4))));
    const del = (await claim(later(at, minutes(5)))).body.job as Claimed;
    assert.equal(del.tool_key, "meet_delete_local");
    await h.handleToolsFail(signedRequest("fail", { ...ref(del), error_code: "unsafe_path" }, later(at, minutes(6))), runnerDeps(later(at, minutes(6))));
    const view = async (m: number) =>
      ((await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(at, minutes(m)))))).recording as {
        deviceDelete: { status: string; errorCode: string | null } | null;
      }).deviceDelete;
    assert.deepEqual(await view(7), { status: "failed", errorCode: "unsafe_path", doneAt: null });
    const again = await body(await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(later(at, minutes(8)))));
    assert.equal(again.device_delete_queued, true, "Delete again did not tell the PC again");
    assert.equal((await view(9))?.status, "waiting");
  });

  await check("a recording whose browser uploaded nothing at all is 'lost', never 'Nothing was recorded'", async () => {
    const at = later(T0, minutes(64_000));
    const r = await liveRoom({ at });
    const p = await participant(r, "Offline host");
    await endRoom(r.id, later(at, minutes(30)));
    const code = displayMeetCode(r.code);
    const fin = (body: Record<string, unknown>) =>
      routes.handleMeetFinalize(
        new Request(`${ORIGIN}/api/meet/${code}/recording/finalize`, {
          method: "POST",
          headers: { origin: ORIGIN, "x-forwarded-host": "oasisai.work", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        code,
        rdeps(later(at, minutes(31))),
      );
    // Control: a browser that lost nothing, and no chunk: nothing was recorded, and nothing is written.
    assert.equal((await (await fin({ sent: 0, failed: 0, errored: 0 })).json() as { state: string }).state, "nothing_recorded");
    assert.equal((await (await fin({ sent: 0, failed: 180, errored: 0 })).json() as { state: string }).state, "lost");
    const view = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(at, minutes(32)))))).recording as { state: string };
    assert.equal(view.state, "lost");
    const straggler = await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(33)));
    assert.equal(straggler.status, 410, "a lost recording took a chunk after it was declared lost");
  });

  await check("a workspace no PC transcribes for is never recorded: the chunk is refused, nothing is handed over, the panel says so", async () => {
    const { PRODUCER_TENANTS } = h;
    const { OASIS_INTERNAL_TENANT_IDS } = await import("../lib/ai/tools/client-safe-registry");
    assert.deepEqual([...PRODUCER_TENANTS.bea].sort(), [...OASIS_INTERNAL_TENANT_IDS].sort(), "who may record drifted from who the PC serves");
    const at = later(T0, minutes(65_000));
    const r = await liveRoom({ tenant: CLIENT_A, at });
    const p = await participant(r, "Client guest");
    const client = as(CC, { tenant: CLIENT_A });
    const before = store.objects.size;
    const res = await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)), client);
    assert.deepEqual([res.status, (await body(res)).error], [403, "recording_unavailable"]);
    assert.equal(store.objects.size, before, "a client workspace's audio reached the relay");
    await endRoom(r.id, later(at, minutes(2)));
    const code = displayMeetCode(r.code);
    const fin = await body(await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(at, minutes(3)), client)));
    assert.equal(fin.state, "unavailable");
    assert.equal(await count("SELECT COUNT(*) FROM tool_jobs WHERE tenant_id = ? AND tool_key LIKE 'meet_%'", [CLIENT_A]), 0, "a job nobody can run was queued");
    const view = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(at, minutes(3)), client)))).recording as { state: string };
    assert.equal(view.state, "unavailable");
  });

  await check("with the PC off, the relay cron finishes a host's Delete and expires an overdue recording", async () => {
    const at = later(T0, minutes(90_000));
    const big = await liveRoom({ at });
    const p = await participant(big, "Long talker");
    const seg = "segment-long-0001";
    await db.execute({
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 349)
            INSERT INTO meet_recording_chunks (id, tenant_id, room_id, participant_id, display_name, segment_id, seq, segment_started_ms, mime_type, bytes, storage_path, uploaded_by, created_at)
            SELECT lower(hex(randomblob(16))), ?, ?, ?, 'Long talker', ?, i, ?, 'audio/webm', 10, ? || i, ?, ? FROM n`,
      args: [OASIS, big.id, p, seg, at.getTime(), `${OASIS}/${big.id}/${p}/${seg}/`, CC, at.toISOString()],
    });
    await endRoom(big.id, later(at, minutes(60)));
    const code = displayMeetCode(big.code);
    const first = await body(await routes.handleMeetRecordingDelete(hostReq(code, "DELETE"), code, rdeps(later(at, minutes(61)))));
    assert.equal(first.relay_remaining, 50, "one Delete takes 300 of the 350 relay chunks");
    const mid = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(at, minutes(61)))))).recording as {
      state: string;
      relayChunks: number;
    };
    assert.deepEqual([mid.state, mid.relayChunks], ["deleted", 50], "the panel hid the copies still on the server");

    // An overdue recording, never taken: handed over, then nothing for 31 days.
    const old = await liveRoom({ at });
    const q = await participant(old, "Gone");
    assert.equal((await upload(old, { participant: q, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)))).status, 201);
    await endRoom(old.id, later(at, minutes(2)));
    const oldCode = displayMeetCode(old.code);
    await routes.handleMeetFinalize(hostReq(oldCode, "POST", "/finalize"), oldCode, rdeps(later(at, minutes(3))));

    // A recording NOBODY handed over (the browser closed, the PC was off past the window): no row at all.
    const lost = await liveRoom({ at });
    const lostP = await participant(lost, "Never handed over");
    assert.equal((await upload(lost, { participant: lostP, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)))).status, 201);
    await endRoom(lost.id, later(at, minutes(2)));

    const out = await rec.meetRelayCron(db, store.storage, later(at, minutes(31 * 24 * 60)));
    assert.equal(out.expired, 2, "the overdue recording and the one never handed over");
    assert.ok(out.removed >= 52, JSON.stringify(out));
    assert.equal(
      await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id IN (?, ?, ?)", [big.id, old.id, lost.id]),
      0,
      "audio stayed on the relay with the PC off",
    );
    assert.equal((await rec.readTranscript(db, OASIS, old.id))?.status, "expired");
    assert.equal((await rec.readTranscript(db, OASIS, lost.id))?.status, "expired", "a recording nobody handed over has no way off the relay");
    assert.equal(
      await count("SELECT COUNT(*) FROM meet_transcripts WHERE room_id IN (?, ?, ?) AND relay_cleared_at IS NULL", [big.id, old.id, lost.id]),
      0,
      "a recording with nothing left on the relay is not marked cleared, so every run re-reads it",
    );
    const quiet = await rec.meetRelayCron(db, store.storage, later(at, minutes(31 * 24 * 60 + 5)));
    assert.deepEqual([quiet.expired, quiet.removed], [0, 0], "a second run found work the first should have done");
    // The cron route's answer: a run with no relay storage cannot delete anything, so it fails loudly (503),
    // never a quiet 200 the driver would count as healthy (Codex on #685, third pass).
    const noStorage = await routes.handleMeetRelayCron({ db, storage: null, now: () => later(at, minutes(31 * 24 * 60 + 10)) });
    assert.deepEqual([noStorage.status, (await body(noStorage)).error], [503, "storage_not_configured"]);
    const healthy = await routes.handleMeetRelayCron({ db, storage: store.storage, now: () => later(at, minutes(31 * 24 * 60 + 10)) });
    assert.equal(healthy.status, 200);
    // R2 refusing deletes (bad credentials, an outage) is a failed run too, never a healthy tick (fourth pass).
    const stuck = await liveRoom({ at });
    const stuckP = await participant(stuck, "Stuck");
    assert.equal((await upload(stuck, { participant: stuckP, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)))).status, 201);
    const stuckCode = displayMeetCode(stuck.code);
    await routes.handleMeetRecordingDelete(hostReq(stuckCode, "DELETE"), stuckCode, rdeps(later(at, minutes(2)), as(CC), fakeMeetStorage({ removeFailsAfter: 0 }).storage));
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [stuck.id]), 1, "control: the delete really failed");
    const refusing = await routes.handleMeetRelayCron({ db, storage: fakeMeetStorage({ removeFailsAfter: 0 }).storage, now: () => later(at, minutes(3)) });
    assert.deepEqual([refusing.status, (await body(refusing)).error], [503, "relay_delete_failed"]);
    const retried = await routes.handleMeetRelayCron({ db, storage: store.storage, now: () => later(at, minutes(4)) });
    assert.equal(retried.status, 200);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [stuck.id]), 0);
  });

  await check("the panel says deleted only for what is, keeps reading while anything is left, and a failed action's error outlives the re-read", async () => {
    const v = await import("../components/meet/recording-view");
    const base: RecordingView = {
      state: "deleted", relayChunks: 0, relayBytes: 0, missingChunks: 0, recorderErrored: 0, relayExpiresAt: null,
      job: null, runner: null, transcript: null, deviceDelete: null,
    };
    // Expired is "being deleted" until the last relay copy is gone, and the panel keeps reading until then.
    const expiring = { ...base, state: "expired" as const, relayChunks: 40 };
    assert.match(v.describeRecording(expiring).headline, /is being deleted/);
    assert.equal(v.recordingBusy(expiring), true);
    const expired = { ...base, state: "expired" as const };
    assert.match(v.describeRecording(expired).headline, /was deleted/);
    assert.equal(v.recordingBusy(expired), false);
    // Missing audio is said from the real count; a recorder error with no count still says something may be missing.
    assert.match(v.missingAudioLine({ ...base, missingChunks: 18 }) ?? "", /about 3 minutes/);
    assert.match(v.missingAudioLine({ ...base, recorderErrored: 1 }) ?? "", /may be missing/);
    assert.equal(v.missingAudioLine(base), null);
    const device = (status: "not_needed" | "waiting" | "done" | "failed", errorCode: string | null = null) =>
      ({ status, errorCode, doneAt: status === "done" ? T0.toISOString() : null });
    // Expired, with the PC told to delete its copy: said, watched, and offered again if the PC failed.
    const expiredWaiting = { ...base, state: "expired" as const, deviceDelete: device("waiting") };
    assert.match(v.describeRecording(expiredWaiting).detail ?? "", /Waiting for .+ to delete its copy/);
    assert.equal(v.recordingBusy(expiredWaiting), true);
    assert.equal(v.recordingDeletable({ ...base, state: "expired" as const, deviceDelete: device("failed") }), true);
    assert.match(v.describeRecording({ ...base, state: "lost" as const }).headline, /couldn't upload any of the audio/);
    const waiting = { ...base, deviceDelete: device("waiting") };
    assert.doesNotMatch(JSON.stringify(v.describeRecording(waiting)), /copy was deleted/, "the PC's copy was called deleted while the PC had not");
    assert.match(v.describeRecording(waiting).detail ?? "", /Waiting for .+ to delete its copy/);
    assert.equal(v.recordingBusy(waiting), true, "a pending device delete is not watched");
    const serverLeft = { ...base, relayChunks: 50, deviceDelete: device("not_needed") };
    assert.match(v.describeRecording(serverLeft).headline, /still being removed/);
    assert.equal(v.recordingBusy(serverLeft), true);
    const done = { ...base, deviceDelete: device("done") };
    assert.match(v.describeRecording(done).detail ?? "", /copy was deleted too/);
    assert.deepEqual([v.recordingBusy(done), v.recordingDeletable(done)], [false, false]);
    const failedDevice = { ...base, deviceDelete: device("failed", "unsafe_path") };
    assert.match(v.describeRecording(failedDevice).detail ?? "", /couldn't delete its copy: its folder was not where meetings are kept/);
    assert.equal(v.recordingDeletable(failedDevice), true, "no way to tell the PC again after it failed");
    assert.equal(v.describeRecording({ ...base, state: "unavailable", deviceDelete: null }).headline, "Meetings in this workspace aren't recorded.");

    // Delete asks again while the server says copies are left, and stops when none are (or the panel is gone).
    const calls: string[] = [];
    const left = [300, 50, 0];
    const answering = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ ok: true, relay_remaining: left.shift() }), { status: 200 });
    };
    assert.deepEqual(await v.runRecordingAction("delete", "/api/meet/x/recording", answering), { ok: true });
    assert.deepEqual(calls, ["DELETE /api/meet/x/recording", "DELETE /api/meet/x/recording", "DELETE /api/meet/x/recording"]);
    calls.length = 0;
    left.push(300, 300);
    await v.runRecordingAction("delete", "/api/meet/x/recording", answering, () => false);
    assert.equal(calls.length, 1, "a closed panel kept deleting");
    const refusing = async () => new Response(JSON.stringify({ ok: false, error: "x" }), { status: 500 });
    assert.deepEqual(await v.runRecordingAction("retry", "/b", refusing), { ok: false, error: "Couldn't start the transcript again." });
    const throwing = async () => {
      throw new Error("offline");
    };
    assert.equal((await v.runRecordingAction("delete", "/b", throwing)).ok, false);
    // The screen shows a failure only AFTER it re-read the recording, so the re-read cannot wipe it (Codex on #685).
    const screen = readFileSync(join(ROOT, "components", "meet", "MeetRecording.tsx"), "utf8");
    assert.match(screen, /await load\(\);\s*\n\s*\/\/[^\n]*\n\s*if \(!outcome\.ok[^\n]*setActionError/, "the action's error is set before the re-read");
    // A failed READ is its own state, cleared by the next read that works: one bad poll must not leave
    // "Couldn't load" on a panel that has since loaded (Codex on #685, third pass).
    assert.match(screen, /setLoadError\(null\);\s*\n\s*setView\(body\.recording\)/, "a read that works does not clear the failed read's message");
    assert.doesNotMatch(screen, /setLoadError\(null\)[\s\S]{0,40}setActionError|setActionError\(null\);\s*\n\s*setView/, "a read clears an action's error");
  });

  // ---------------------------------------------------------------------
  // The rules the reviewers found unpinned
  // ---------------------------------------------------------------------
  /**
   * Claim until THIS room's transcription comes up, as the PC would work through what is queued ahead of it:
   * a delete job is done, another meeting's transcription is failed, and "no job, ask again now" (a job the
   * claim ended as meeting_gone) is asked again.
   */
  async function claimTranscription(at: Date, roomId: string, deps = runnerDeps(at)): Promise<Claimed> {
    for (let i = 0; i < 10; i += 1) {
      const answer = (await answerOf(
        await h.handleToolsClaim(signedRequest("claim", { runner_id: RUNNER, label: "CCPC (Windows)", version: "1.0.0", tools: MEET_TOOLS }, at), deps),
      )).body;
      const got = answer.job as Claimed | null;
      if (!got) {
        assert.equal(answer.poll_after_seconds, 0, "no meeting job to claim");
        continue;
      }
      if (got.tool_key === "meet_transcribe" && got.input.room_id === roomId) return got;
      if (got.tool_key === "meet_transcribe") {
        await h.handleToolsFail(signedRequest("fail", { ...ref(got), error_code: "transcribe_failed" }, at), runnerDeps(at));
        continue;
      }
      await h.handleToolsComplete(
        signedRequest("complete", { ...ref(got), tool_key: "meet_delete_local", removed: [], already_gone: true, device_label: "CCPC (Windows)" }, at),
        runnerDeps(at),
      );
    }
    throw new Error("this room's transcription never came up");
  }
  async function endedRecording(at: Date, name: string) {
    const r = await liveRoom({ at });
    const p = await participant(r, name);
    assert.equal((await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)))).status, 201);
    await endRoom(r.id, later(at, minutes(2)));
    const code = displayMeetCode(r.code);
    assert.equal((await body(await routes.handleMeetFinalize(hostReq(code, "POST", "/finalize"), code, rdeps(later(at, minutes(2)))))).state, "queued");
    return { room: r, participant: p, code };
  }

  await check("a chunk that lands while the PC's claim reads the recording is either declared to the PC or refused, never kept and lost", async () => {
    const at = later(T0, minutes(95_000));
    const { room, participant: p } = await endedRecording(at, "Racer");
    let raced: Response | null = null;
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return async (stmt: Parameters<typeof db.execute>[0]) => {
            const out = await target.execute(stmt);
            const sql = typeof stmt === "string" ? stmt : stmt.sql;
            // Right after the claim reads the room's chunks, the host's browser delivers one more.
            const args = typeof stmt === "string" ? [] : ((stmt.args ?? []) as unknown[]);
            if (!raced && /segment_started_ms, mime_type, bytes, storage_path\s+FROM meet_recording_chunks/.test(sql) && args.includes(room.id)) {
              raced = await upload(room, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(3)));
            }
            return out;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const job = await claimTranscription(later(at, minutes(3)), room.id, { ...runnerDeps(later(at, minutes(3))), db: proxy });
    assert.ok(raced, "the race was never staged");
    const declared = (job.input.segments as unknown[]).length;
    const stored = await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [room.id]);
    assert.ok(
      (raced as Response).status !== 201 || declared === stored,
      `a chunk was answered 201 but not given to the PC (declared ${declared} segment(s), ${stored} chunk(s) stored)`,
    );
    assert.equal((raced as Response).status, 410, "after the claim closes the recording, a late chunk is refused");
    // Finish it, so its lease never expires into a later check's claim.
    const done = await answerOf(await h.handleToolsComplete(signedRequest("complete", transcriptReport(job), later(at, minutes(4))), runnerDeps(later(at, minutes(4)))));
    assert.equal(done.status, 200);
  });

  await check("nothing is expired or deleted under the PC, the job is done only with its transcript, and a report must name the job's own tool", async () => {
    const at = later(T0, minutes(100_000));
    const { room } = await endedRecording(at, "Steady");
    const job = await claimTranscription(later(at, minutes(3)), room.id);
    assert.equal(job.input.room_id, room.id, "claimed another meeting's job");
    // 31 days on, still in the PC's hands (its lease live: heartbeats kept it): neither expired nor freed
    // (#685 review M10, M17).
    const late = later(at, minutes(31 * 24 * 60));
    await db.execute({ sql: "UPDATE tool_jobs SET lease_expires_at = ? WHERE id = ?", args: [later(late, minutes(10)).toISOString(), job.job_id] });
    await rec.expireRelay(db, [OASIS], late);
    assert.equal(await rec.removeRelayChunks(db, store.storage, { tenantIds: [OASIS], roomId: room.id }, 300, late), 0);
    assert.equal((await rec.readTranscript(db, OASIS, room.id))?.status, "transcribing");
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [room.id]), 1);
    // The delete job's report on a transcription job: refused by tool (M7).
    const wrong = await answerOf(
      await h.handleToolsComplete(
        signedRequest("complete", { ...ref(job), tool_key: "meet_delete_local", removed: [], already_gone: true, device_label: "CCPC (Windows)" }, later(at, minutes(4))),
        runnerDeps(later(at, minutes(4))),
      ),
    );
    assert.deepEqual([wrong.status, wrong.body.field], [422, "tool_key"]);
    // A line of 5,000 characters is taken (a long monologue must never cost the whole transcript, H3).
    const long = rec.parseTranscriptReport(transcriptReport(job, { lines: [{ at_ms: 1, end_ms: 2, participant_id: "p", speaker: "S", text: "x".repeat(5000) }] }));
    assert.equal(long.ok, true);
    // The job is done only if its transcript landed: a row no longer transcribing makes complete write nothing (M24).
    await db.execute({ sql: "UPDATE meet_transcripts SET status = 'queued' WHERE room_id = ?", args: [room.id] });
    const refused = await answerOf(await h.handleToolsComplete(signedRequest("complete", transcriptReport(job), later(at, minutes(5))), runnerDeps(later(at, minutes(5)))));
    assert.deepEqual([refused.status, refused.body.error], [409, "lease_lost"]);
    assert.notEqual((await getJob(db, OASIS, job.job_id))?.status, "done", "the job was finished without its transcript");
    await db.execute({ sql: "UPDATE meet_transcripts SET status = 'transcribing' WHERE room_id = ?", args: [room.id] });
    // A room row deleted outright frees nothing still waiting for the PC (M8): only a recording that is done with.
    const kept = await endedRecording(later(at, minutes(10)), "Kept");
    await db.execute({ sql: "DELETE FROM meet_rooms WHERE id = ?", args: [kept.room.id] });
    assert.equal(await rec.removeRelayChunks(db, store.storage, { tenantIds: [OASIS], roomId: kept.room.id }, 300, later(at, minutes(11))), 0);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [kept.room.id]), 1);
    // A meeting past its relay window is not handed over (the sweep's bound), one inside it is.
    const old = await liveRoom({ at: later(at, minutes(20)) });
    const oldP = await participant(old, "Old");
    assert.equal((await upload(old, { participant: oldP, segment: crypto.randomUUID(), seq: 0, startedAt: later(at, minutes(20)).getTime() }, later(at, minutes(21)))).status, 201);
    await endRoom(old.id, later(at, minutes(22)));
    assert.equal(await rec.finalizeDueRooms(db, [OASIS], later(at, minutes(22 + 40 * 24 * 60))), 0, "a meeting from 40 days ago was handed over");
    assert.equal(await rec.finalizeDueRooms(db, [OASIS], later(at, minutes(40))), 1, "control: a meeting 18 minutes old was not handed over");
    // A chunk whose row fails to write takes its stored object back with it (M7): no sweep could ever find it.
    const flaky = await liveRoom({ at: later(at, minutes(30)) });
    const flakyP = await participant(flaky, "Flaky");
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return async (stmt: Parameters<typeof db.execute>[0]) => {
            if (/INSERT INTO meet_recording_chunks/.test(typeof stmt === "string" ? stmt : stmt.sql)) throw new Error("libsql: connection reset");
            return target.execute(stmt);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const flakyCode = displayMeetCode(flaky.code);
    await assert.rejects(
      routes.handleMeetChunk(
        chunkReq(flakyCode, { participant: flakyP, segment: "segment-flaky-0001", seq: 0, startedAt: later(at, minutes(30)).getTime() }),
        flakyCode,
        { ...rdeps(later(at, minutes(31))), db: failing },
      ),
    );
    assert.ok(![...store.objects.keys()].some((k) => k.includes(flaky.id)), "an object with no row was left on the relay");
    // A 1.5 MiB report is inside complete's cap (900k characters of text and 600k of lines).
    const bigLines = Array.from({ length: 40 }, (_, i) => ({ at_ms: i * 1000, end_ms: i * 1000 + 900, participant_id: "p", speaker: "S", text: "z".repeat(15_000) }));
    const big = JSON.stringify({ ...transcriptReport(job), transcript_text: "y".repeat(900_000), lines: bigLines });
    assert.ok(big.length > 1.4 * 1024 * 1024, "the report is not as big as the check says");
    const ok = await answerOf(await h.handleToolsComplete(signedRequest("complete", null, later(at, minutes(6)), { raw: big }), runnerDeps(later(at, minutes(6)))));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  await check("a claim whose PC vanished does not hold audio past 30 days: its lapsed lease lets the recording expire", async () => {
    const at = later(T0, minutes(102_000));
    const { room, code } = await endedRecording(at, "Vanished");
    const job = await claimTranscription(later(at, minutes(3)), room.id);
    assert.equal(job.input.room_id, room.id);
    // While the PC holds it, the panel says transcribing; once the lease has lapsed, it is waiting, not
    // "transcribing" for days on a PC that is gone (Codex on #685, third pass).
    const stateAt = async (m: number) =>
      ((await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(at, minutes(m)))))).recording as { state: string }).state;
    assert.equal(await stateAt(5), "transcribing");
    assert.equal(await stateAt(60), "waiting");
    // The PC never heartbeats again: the lease lapsed long before the 30 days ran out.
    const late = later(at, minutes(31 * 24 * 60));
    assert.ok((await rec.expireRelay(db, [OASIS], late)) >= 1);
    assert.equal((await rec.readTranscript(db, OASIS, room.id))?.status, "expired");
    const failed = await getJob(db, OASIS, job.job_id);
    assert.deepEqual([failed?.status, failed?.errorCode], ["failed", "relay_expired"]);
    assert.equal(await rec.removeRelayChunks(db, store.storage, { tenantIds: [OASIS], roomId: room.id }, 300, late), 1);
    // That PC took the audio before it vanished, so it may hold a copy: it is told to delete it, and the panel
    // says it is waiting for that, never that the audio is simply gone (Codex on #685, fourth pass).
    assert.equal(
      await count("SELECT COUNT(*) FROM tool_jobs WHERE tool_key = 'meet_delete_local' AND dedupe_key = ? AND status = 'queued'", [`meet_delete_local:${room.id}`]),
      1,
      "an expired recording the PC had claimed left its copy on the PC",
    );
    const after = (await body(await routes.handleMeetRecordingGet(hostReq(code, "GET"), code, rdeps(later(late, minutes(1)))))).recording as {
      state: string;
      deviceDelete: { status: string } | null;
    };
    assert.deepEqual([after.state, after.deviceDelete?.status], ["expired", "waiting"]);
  });

  await check("a speaker with no consent on record is never recorded; a download is still held 45 minutes at most", async () => {
    const at = later(T0, minutes(105_000));
    const r = await liveRoom({ at });
    const silent = await participant(r, "No consent", null, false);
    const res = await upload(r, { participant: silent, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, minutes(1)));
    assert.deepEqual([res.status, (await body(res)).error], [403, "consent_missing"]);
    assert.equal(await count("SELECT COUNT(*) FROM meet_recording_chunks WHERE room_id = ?", [r.id]), 0);
    // The download's own hold, unchanged by the meeting tools.
    const dl = await queueDownload(db, OASIS, at, { url: "https://www.instagram.com/reel/HOLD45/" });
    const claimed = (await answerOf(
      await h.handleToolsClaim(signedRequest("claim", { runner_id: "video-pc", label: "PC", version: "1.0.0", tools: ["video_download"] }, at), runnerDeps(at)),
    )).body.job as Claimed;
    assert.equal(claimed.job_id, dl);
    const beat = async (m: number) =>
      (await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { runner_id: "video-pc", job_id: claimed.job_id, lease_id: claimed.lease_id, stage: "downloading" }, later(at, minutes(m))), runnerDeps(later(at, minutes(m)))))).status;
    assert.equal(await beat(44), 200);
    assert.equal(await beat(46), 409, "a download was held past 45 minutes");
  });

  // ---------------------------------------------------------------------
  // Caps and the room switches
  // ---------------------------------------------------------------------
  await check("a room's caps hold: 15,000 chunks, then 413 room_full, and nothing is uploaded for the refused one", async () => {
    const r = await liveRoom({ at: later(T0, minutes(70_000)) });
    const p = await participant(r, "Max");
    const at = later(T0, minutes(70_001));
    await db.execute({
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 14999)
            INSERT INTO meet_recording_chunks (id, tenant_id, room_id, participant_id, display_name, segment_id, seq, segment_started_ms, mime_type, bytes, storage_path, uploaded_by, created_at)
            SELECT lower(hex(randomblob(16))), ?, ?, ?, 'Max', 'segment-full', i, ?, 'audio/webm', 1, 'x', ?, ? FROM n`,
      args: [OASIS, r.id, p, at.getTime(), CC, at.toISOString()],
    });
    const before = store.objects.size;
    const res = await upload(r, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: at.getTime() }, later(at, 1000));
    assert.deepEqual([res.status, (await body(res)).error], [413, "room_full"]);
    assert.equal(store.objects.size, before);
  });

  await check("recording off: 403; a room nobody opened yet: 425 (retried briefly by the recorder)", async () => {
    const off = await liveRoom({ recordAudio: false, at: later(T0, minutes(80_000)) });
    const p = await participant(off, "Off");
    assert.equal((await upload(off, { participant: p, segment: crypto.randomUUID(), seq: 0, startedAt: later(T0, minutes(80_000)).getTime() }, later(T0, minutes(80_001)))).status, 403);
    const sched = await liveRoom({ at: later(T0, minutes(80_000)) });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'scheduled' WHERE id = ?", args: [sched.id] });
    const q = await participant(sched, "Early");
    assert.equal((await upload(sched, { participant: q, segment: crypto.randomUUID(), seq: 0, startedAt: later(T0, minutes(80_000)).getTime() }, later(T0, minutes(80_001)))).status, 425);
  });

  await check("the PC's claim ends a recorded call whose every tab closed without End, and hands it over 10 minutes later", async () => {
    // #687 review, Codex P1: such a room stayed live for good, so finalizeDueRooms never saw it and its
    // audio expired untranscribed after 30 days.
    const start = later(T0, minutes(90_000));
    const r = await liveRoom({ at: start });
    const host = await participant(r, "Conaugh", CC);
    const guest = await participant(r, "Jordan");
    // A call happened (the guest was in while the host was), then every tab died two minutes in, each still
    // holding its SFU session.
    await db.execute({
      sql: "UPDATE meet_participants SET joined_at = ?, last_seen_at = ?, sfu_session_id = 'sess-' || id WHERE room_id = ?",
      args: [start.toISOString(), later(start, minutes(2)).toISOString(), r.id],
    });
    const sfu = fakeSfu();
    assert.equal((await upload(r, { participant: guest, segment: crypto.randomUUID(), seq: 0, startedAt: start.getTime() }, later(start, minutes(1)))).status, 201);
    const room = async () => (await db.execute({ sql: "SELECT status, ended_reason FROM meet_rooms WHERE id = ?", args: [r.id] })).rows[0];
    // Inside the host's 10-minute grace it is left alone, media too ...
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(8)), sfu.sfu);
    assert.equal(String((await room()).status), "live", "a call still inside the host's grace was ended");
    assert.deepEqual(sfu.closed, [], "a live call's media was cut");
    // ... past it, the sweep ends it and cuts what its rows still held (Codex on #688: no request ever would) ...
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(13)), sfu.sfu);
    assert.deepEqual([String((await room()).status), String((await room()).ended_reason)], ["ended", "host_left"]);
    assert.deepEqual([...sfu.closed].sort(), [`sess-${guest}`, `sess-${host}`].sort(), "an ended room's sessions were left open");
    assert.equal(await count("SELECT COUNT(*) FROM meet_participants WHERE room_id = ? AND sfu_session_id IS NOT NULL", [r.id]), 0);
    assert.equal(await rec.readTranscript(db, OASIS, r.id), null, "handed over before the late-chunk window closed");
    // ... and a sweep 10 minutes after that hands its recording to the PC.
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(24)));
    assert.equal((await rec.readTranscript(db, OASIS, r.id))?.status, "queued", "the abandoned call's recording was never handed over");
  });

  await check("an ended room's held session: kept with no SFU set or when the cut fails, cut on the next run, left alone after a day", async () => {
    const start = later(T0, minutes(110_000));
    const r = await liveRoom({ at: start });
    const p = await participant(r, "Held");
    const old = await liveRoom({ at: start });
    const q = await participant(old, "Old");
    await db.execute({ sql: "UPDATE meet_participants SET sfu_session_id = 'sess-' || id WHERE id IN (?, ?)", args: [p, q] });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [later(start, minutes(70)).toISOString(), r.id] });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [later(start, minutes(-25 * 60)).toISOString(), old.id] });
    const held = async (id: string) => (await db.execute({ sql: "SELECT sfu_session_id FROM meet_participants WHERE id = ?", args: [id] })).rows[0].sfu_session_id;
    const at = later(start, minutes(72));
    await rec.meetRelaySweeps(db, store.storage, [OASIS], at, null);
    assert.equal(await held(p), `sess-${p}`, "with no SFU set the id was dropped uncut");
    const down = fakeSfu({ fail: true });
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(at, minutes(1)), down.sfu);
    assert.equal(await held(p), `sess-${p}`, "a cut that failed lost its id");
    const up = fakeSfu();
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(at, minutes(2)), up.sfu);
    assert.equal(await held(p), null, "the next run did not cut it");
    assert.ok(up.closed.includes(`sess-${p}`));
    assert.ok(!up.closed.includes(`sess-${q}`), "a room ended over a day ago was swept again");
    assert.equal(await held(q), `sess-${q}`);
  });

  await check("the relay cron cuts an ended room's held session in any workspace, with the PC off; the PC's sweep stays in its own", async () => {
    const start = later(T0, minutes(120_000));
    const r = await liveRoom({ tenant: OTHER, at: start });
    const p = await participant(r, "Elsewhere");
    await db.execute({ sql: "UPDATE meet_participants SET sfu_session_id = 'sess-' || id WHERE id = ?", args: [p] });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [later(start, minutes(1)).toISOString(), r.id] });
    const held = async () => (await db.execute({ sql: "SELECT sfu_session_id FROM meet_participants WHERE id = ?", args: [p] })).rows[0].sfu_session_id;
    const pcs = fakeSfu();
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(2)), pcs.sfu);
    assert.deepEqual(pcs.closed, [], "the PC's sweep reached another workspace's room");
    // No SFU set any more (its secret rotated away): nothing can be cut, and the run says so, never "healthy".
    const noSfu = await routes.handleMeetRelayCron({ db, storage: store.storage, now: () => later(start, minutes(3)), sfu: null });
    const noSfuBody = await body(noSfu);
    assert.deepEqual([noSfu.status, noSfuBody.error, noSfuBody.mediaCutFailed], [503, "media_cut_failed", 1]);
    assert.equal(await held(), `sess-${p}`);
    // The SFU refuses: a failed run (the driver reports it), and the id is kept for the next one.
    const down = fakeSfu({ fail: true });
    const refused = await routes.handleMeetRelayCron({ db, storage: store.storage, now: () => later(start, minutes(3)), sfu: down.sfu });
    const refusedBody = await body(refused);
    assert.deepEqual([refused.status, refusedBody.error, refusedBody.mediaCutFailed], [503, "media_cut_failed", 1]);
    assert.equal(await held(), `sess-${p}`);
    const cron = fakeSfu();
    const res = await routes.handleMeetRelayCron({ db, storage: store.storage, now: () => later(start, minutes(4)), sfu: cron.sfu });
    assert.deepEqual([res.status, (await body(res)).mediaCut], [200, 1]);
    assert.deepEqual(cron.closed, [`sess-${p}`], "the cron left another workspace's ended room holding its session");
    assert.equal(await held(), null);
  });

  await check("with the PC off, the relay cron ends a call every tab left without End, in any workspace, and cuts its media", async () => {
    // Codex on #688, fourth pass: the cron only cut ENDED rooms, so an abandoned one stayed live, media and all.
    const start = later(T0, minutes(125_000));
    const r = await liveRoom({ tenant: OTHER, at: start });
    const host = await participant(r, "Host", CC);
    const guest = await participant(r, "Guest");
    await db.execute({
      sql: "UPDATE meet_participants SET joined_at = ?, last_seen_at = ?, sfu_session_id = 'sess-' || id WHERE room_id = ?",
      args: [start.toISOString(), later(start, minutes(2)).toISOString(), r.id],
    });
    const sfu = fakeSfu();
    const res = await routes.handleMeetRelayCron({ db, storage: store.storage, now: () => later(start, minutes(15)), sfu: sfu.sfu });
    assert.equal(res.status, 200);
    const row = (await db.execute({ sql: "SELECT status, ended_reason FROM meet_rooms WHERE id = ?", args: [r.id] })).rows[0];
    assert.deepEqual([String(row.status), String(row.ended_reason)], ["ended", "host_left"], "the cron left an abandoned call live");
    assert.deepEqual([...sfu.closed].sort(), [`sess-${guest}`, `sess-${host}`].sort());
  });

  await check("a run's cuts go at once, so one SFU that does not answer costs one wait, not one per room", async () => {
    const start = later(T0, minutes(130_000));
    const rooms = await Promise.all([1, 2, 3].map(() => liveRoom({ at: start })));
    for (const r of rooms) {
      const p = await participant(r, "Concurrent");
      await db.execute({ sql: "UPDATE meet_participants SET sfu_session_id = 'sess-' || id WHERE id = ?", args: [p] });
      await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [later(start, minutes(1)).toISOString(), r.id] });
    }
    const sfu = fakeSfu();
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(2)), sfu.sfu);
    assert.equal(sfu.closed.length, 3);
    assert.ok(sfu.flight.max >= 3, `the cuts ran one at a time (at most ${sfu.flight.max} in flight)`);
  });

  await check("a backlog drains oldest first, so a deferred room never ages out before its turn", async () => {
    const start = later(T0, minutes(140_000));
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const r = await liveRoom({ at: start });
      const p = await participant(r, `Backlog ${i}`);
      await db.execute({ sql: "UPDATE meet_participants SET sfu_session_id = 'sess-' || id WHERE id = ?", args: [p] });
      await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [later(start, minutes(i)).toISOString(), r.id] });
      ids.push(p);
    }
    // One more, ended three hours before the run: still inside the day it is retried for.
    const late = await liveRoom({ at: start });
    const lateP = await participant(late, "Three hours ago");
    await db.execute({ sql: "UPDATE meet_participants SET sfu_session_id = 'sess-' || id WHERE id = ?", args: [lateP] });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [later(start, minutes(30 - 180)).toISOString(), late.id] });
    const sfu = fakeSfu();
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(30)), sfu.sfu);
    assert.ok(sfu.closed.includes(`sess-${lateP}`), "a room ended three hours ago was no longer retried");
    assert.ok(sfu.closed.includes(`sess-${ids[0]}`), "the oldest room of the backlog was skipped");
    assert.ok(!sfu.closed.includes(`sess-${ids[10]}`), "the newest went before an older one");
    await rec.meetRelaySweeps(db, store.storage, [OASIS], later(start, minutes(31)), sfu.sfu);
    assert.ok(sfu.closed.includes(`sess-${ids[10]}`), "the next run did not take the rest");
  });

  await check("the claim's sweep leaves tomorrow's meeting alone after two hosts try it out today", async () => {
    // #687 third review, HIGH: CC and an admin are both hosts, so two of them in a room counts as a call. Without the
    // start guard, a try-out today ended tomorrow's room and killed the link its guest already had.
    const today = later(T0, minutes(100_000));
    const r = await liveRoom({ at: today });
    await db.execute({ sql: "UPDATE meet_rooms SET starts_at = ? WHERE id = ?", args: [later(today, minutes(24 * 60)).toISOString(), r.id] });
    await participant(r, "Conaugh", CC);
    const admin = await participant(r, "Operations Admin", ADMIN_USER);
    await db.execute({ sql: "UPDATE meet_participants SET role = 'host' WHERE id = ?", args: [admin] });
    await db.execute({
      sql: "UPDATE meet_participants SET joined_at = ?, last_seen_at = ? WHERE room_id = ?",
      args: [today.toISOString(), later(today, minutes(5)).toISOString(), r.id],
    });
    for (const m of [13, 24, 60]) await rec.meetRelaySweeps(db, store.storage, [OASIS], later(today, minutes(m)));
    const row = (await db.execute({ sql: "SELECT status FROM meet_rooms WHERE id = ?", args: [r.id] })).rows[0];
    assert.equal(String(row.status), "live", "a try-out ended tomorrow's meeting");
  });

  finish("meet recording");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

