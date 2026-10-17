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
 *   - one browser records a room; a room's caps hold inside the INSERT;
 *   - the hand-over is idempotent and waits for the meeting's end; the PC's
 *     claim hands over a meeting nobody finalized, 10 minutes after its end;
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
import type { MeetStorage } from "../lib/meet/recording";

const ROOT = join(__dirname, "..");
const ORIGIN = "https://oasisai.work";
const OTHER = "cccccccc-0000-4000-8000-00000000000c";
const CC = USERS.cc.id;
const ADON = USERS.adon.id;
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
  const { createMeetRoom, displayMeetCode } = await import("../lib/meet/rooms");
  const rec = await import("../lib/meet/recording");
  const routes = await import("../lib/meet/recording-routes");
  const h = await import("../lib/tools/runner-handlers");
  const { insertJob, sweepToolJobs, getJob } = await import("../lib/tools/store");

  let codeSeq = 0;
  const codes = ["abcdefghjk", "bcdefghjkm", "cdefghjkmn", "defghjkmnp", "efghjkmnpq", "fghjkmnpqr", "ghjkmnpqrs", "hjkmnpqrst"];
  async function liveRoom(o: { tenant?: string; recordAudio?: boolean; at?: Date } = {}) {
    const at = o.at ?? T0;
    const room = await createMeetRoom(db, {
      tenantId: o.tenant ?? OASIS,
      hostUserId: CC,
      title: "Discovery call",
      recordAudio: o.recordAudio ?? true,
      now: at,
      nextCode: () => codes[codeSeq++],
    });
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'live', started_at = ? WHERE id = ?", args: [at.toISOString(), room.id] });
    return { ...room, status: "live" as const, startedAt: at.toISOString() };
  }
  async function endRoom(roomId: string, at: Date) {
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE id = ?", args: [at.toISOString(), roomId] });
  }
  async function participant(room: { id: string; tenantId: string }, name: string, userId: string | null = null) {
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, sfu_session_id, tracks, joined_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?)`,
      args: [id, room.tenantId, room.id, userId === CC ? "host" : "guest", userId, name, T0.toISOString(), T0.toISOString(), T0.toISOString()],
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
    o: { origin?: string | null; name?: string } = {},
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
  const segC = crypto.randomUUID();

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

  await check("one browser records a room: another host is 423 while the first is sending, and may take over after 2 minutes", async () => {
    const adon = as(ADON, { admin: true });
    const blocked = await upload(r1, { participant: pCc, segment: segC, seq: 0 }, later(T0, minutes(2)), adon);
    assert.deepEqual([blocked.status, (await body(blocked)).error], [423, "another_recorder"]);
    // CC's last chunk was at T0+1min; three minutes later Adon's browser may record.
    const taken = await upload(r1, { participant: pCc, segment: segC, seq: 0 }, later(T0, minutes(4)), adon);
    assert.equal(taken.status, 201);
    await db.execute({ sql: "DELETE FROM meet_recording_chunks WHERE segment_id = ?", args: [segC] });
  });

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
    const second = await routes.handleMeetFinalize(hostReq(code1, "POST", "/finalize"), code1, rdeps(later(T0, minutes(9))));
    assert.deepEqual([second.status, (await body(second)).state], [200, "queued"]);
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
  await check("the claim fixes each segment's unbroken run from chunk 0, oldest first, and counts the rest as missing", async () => {
    const a = await claim(later(T0, minutes(20)));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    job1 = a.body.job as Claimed;
    assert.equal(job1.tool_key, "meet_transcribe");
    assert.deepEqual(Object.keys(job1.input).sort(), ["room_id", "segments", "started_at_ms", "title"], "nothing but what the PC needs");
    assert.deepEqual([job1.input.room_id, job1.input.title, job1.input.started_at_ms], [r1.id, "Discovery call", T0.getTime()]);
    assert.deepEqual(job1.input.segments, [
      { participant_id: pGuest, display_name: "Jordan", segment_id: segA, started_at_ms: T0.getTime(), mime_type: "audio/webm;codecs=opus", chunk_count: 2 },
      { participant_id: pCc, display_name: "Conaugh", segment_id: segB, started_at_ms: T0.getTime() + 500, mime_type: "audio/webm;codecs=opus", chunk_count: 4 },
    ]);
    assert.equal(job1.limits.max_hold_seconds, 4 * 60 * 60);
    assert.equal(job1.limits.queue_depth, 0);
    const t = await rec.readTranscript(db, OASIS, r1.id);
    assert.deepEqual([t?.status, t?.chunkCount, t?.missingChunks], ["transcribing", 6, 2], "segA's seq 3 and segD's seq 1 are missing");
  });

  await check("download-urls signs exactly the declared chunks, in order; another lease is lease_lost; no relay is 503", async () => {
    const before = store.signed.length;
    const a = await answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", ref(job1), later(T0, minutes(21))), runnerDeps(later(T0, minutes(21)))));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const files = a.body.files as Array<{ participant_id: string; segment_id: string; seq: number; url: string }>;
    const got = files.map((f) => `${f.participant_id === pCc ? "cc" : "guest"}:${f.segment_id === segB ? "B" : "A"}:${f.seq}`).sort();
    assert.deepEqual(got, ["cc:B:0", "cc:B:1", "cc:B:2", "cc:B:3", "guest:A:0", "guest:A:1"]);
    assert.equal(store.signed.length - before, 6);
    assert.ok(files.every((f) => f.url.startsWith("https://acct.r2.example/bucket/meet-relay/" + OASIS + "/")));
    const lost = await answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", { ...ref(job1), lease_id: "f".repeat(32) }, later(T0, minutes(21))), runnerDeps(later(T0, minutes(21)))));
    assert.deepEqual([lost.status, lost.body.error], [409, "lease_lost"]);
    const none = await answerOf(await h.handleToolsDownloadUrls(signedRequest("download-urls", ref(job1), later(T0, minutes(21))), runnerDeps(later(T0, minutes(21)), null)));
    assert.deepEqual([none.status, none.body.error, none.body.detail], [503, "not_installed", "storage_not_configured"]);
  });

  await check("a meeting job reports its own stages for up to four hours; a download's stage list is unchanged", async () => {
    for (const stage of ["downloading", "transcribing", "finishing"]) {
      const a = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage }, later(T0, minutes(30))), runnerDeps(later(T0, minutes(30)))));
      assert.equal(a.status, 200, `${stage}: ${JSON.stringify(a.body)}`);
    }
    const uploading = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage: "uploading" }, later(T0, minutes(31))), runnerDeps(later(T0, minutes(31)))));
    assert.deepEqual([uploading.status, uploading.body.error], [422, "invalid_payload"], "a meeting job never uploads");
    const threeHours = later(T0, minutes(20 + 180));
    const ok = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage: "transcribing" }, threeHours), runnerDeps(threeHours)));
    assert.equal(ok.status, 200, "three hours into a transcription the lease still extends (a download's limit is 45 minutes)");
    const bogus = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { ...ref(job1), stage: "dancing" }, threeHours), runnerDeps(threeHours)));
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

  // ---------------------------------------------------------------------
  // Caps and the room switches
  // ---------------------------------------------------------------------
  await check("a room's caps hold: 12,000 chunks, then 413 room_full, and nothing is uploaded for the refused one", async () => {
    const r = await liveRoom({ at: later(T0, minutes(70_000)) });
    const p = await participant(r, "Max");
    const at = later(T0, minutes(70_001));
    await db.execute({
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 11999)
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

  finish("meet recording");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

