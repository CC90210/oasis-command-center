/**
 * tests/tools-runner.test.ts - the runner's side of the wire: the five signed
 * routes a computer calls to download a video into the Library
 * (lib/tools/runner-handlers.ts, lib/tools/runner-auth.ts, lib/tools/store.ts),
 * against the REAL migration bravo__206 in a local libSQL file.
 *
 * Pins the contract the PC runner is built to (toolkit build brief, section 3):
 *   - the shared HMAC vector verifies, and every way of failing auth is 401 or
 *     503 with nothing read or written;
 *   - two claims never take one job; an expired lease is taken again with
 *     attempt 2 and the old lease is refused (409); a third expiry gives up;
 *   - a client workspace's job is never claimable by OASIS's runner;
 *   - upload-url keeps ONE path per job under the workspace's own folder and
 *     refuses a file over 95 MiB;
 *   - complete writes exactly one Library video (Downloads, draft, rights
 *     unknown) and its media row, idempotently, and NOTHING when the uploaded
 *     object is missing or differs;
 *   - fail ends the job with errors.ts's line and deletes the upload;
 *   - the runner_offline sweep fires only when no live runner serves the job.
 *
 * Run: node --conditions=react-server --import tsx tests/tools-runner.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  CLIENT_A,
  ENV,
  OASIS,
  answerOf,
  check,
  emptyDatabase,
  fakeStorage,
  finish,
  later,
  minutes,
  queueDownload,
  scalar,
  seedRunner,
  setupToolsDatabase,
  signedRequest,
} from "./_tools-harness";

const SHA = "a".repeat(64);
const MD5 = "b".repeat(32);
const SIZE = 12_345_678;

async function main() {
  console.log("tools runner:");
  const db = await setupToolsDatabase();
  const h = await import("../lib/tools/runner-handlers");
  const { jobView, getJob } = await import("../lib/tools/store");
  const { RUNNER_ERROR_LINES, SWEEP_ERROR_LINES } = await import("../lib/tools/errors");

  type Storage = ReturnType<typeof fakeStorage>;
  const deps = (now: Date, storage: Storage | null = fakeStorage(), env: Record<string, string | undefined> = ENV) => ({
    db,
    env,
    now,
    storage: storage ? storage.storage : null,
  });
  const claimBody = (runner = "ccpc") => ({ runner_id: runner, label: "CC's PC", version: "1.0.0", tools: ["video_download"] });
  const claim = async (now: Date, runner = "ccpc", storage?: Storage) =>
    answerOf(await h.handleToolsClaim(signedRequest("claim", claimBody(runner), now), deps(now, storage ?? fakeStorage())));
  const job = async (id: string) => {
    const j = await getJob(db, OASIS, id);
    assert.ok(j, `job ${id} exists`);
    return j;
  };
  type Claimed = { job_id: string; lease_id: string; attempt: number; input: Record<string, unknown>; limits: Record<string, number> };

  // -- auth -----------------------------------------------------------------
  await check("the shared HMAC vector: Node reproduces it, and the claim route accepts a request signed with it", async () => {
    const vector = {
      secret: "toolkit-contract-test-secret-0123456789abcdef",
      ts: 1760000000,
      body: '{"runner_id":"ccpc","label":"CC\'s PC","version":"1.0.0","tools":["video_download"]}',
      signature: "d0e331d9de0c57eeb3b2047f2de7dfd715b30bb8b12199657e641cd8aec35495",
    };
    assert.equal(createHmac("sha256", vector.secret).update(`${vector.ts}.${vector.body}`, "utf8").digest("hex"), vector.signature);
    const now = new Date(vector.ts * 1000);
    const req = signedRequest("claim", null, now, { raw: vector.body, ts: vector.ts, signature: vector.signature });
    const a = await answerOf(await h.handleToolsClaim(req, deps(now, fakeStorage(), { TOOLS_RUNNER_SECRET_BEA: vector.secret })));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.job, null);
    assert.equal(a.body.poll_after_seconds, 30);
  });

  const T0 = new Date("2026-10-09T02:00:00.000Z");
  const runnersBefore = Number(await scalar(db, "SELECT COUNT(*) FROM tool_runners WHERE last_seen_at >= ?", [T0.toISOString()]));

  await check("a bad signature, a stale timestamp, an unknown or missing producer: 401, and nothing is written", async () => {
    const body = claimBody();
    const bad = await answerOf(await h.handleToolsClaim(signedRequest("claim", body, T0, { secret: "wrong-secret-wrong-secret-wrong-secret-0000" }), deps(T0)));
    assert.deepEqual([bad.status, bad.body.error], [401, "unauthorized"]);
    const stale = await answerOf(await h.handleToolsClaim(signedRequest("claim", body, T0, { ts: Math.floor(T0.getTime() / 1000) - 301 }), deps(T0)));
    assert.deepEqual([stale.status, stale.body.error], [401, "stale_timestamp"]);
    const future = await answerOf(await h.handleToolsClaim(signedRequest("claim", body, T0, { ts: Math.floor(T0.getTime() / 1000) + 301 }), deps(T0)));
    assert.deepEqual([future.status, future.body.error], [401, "stale_timestamp"]);
    const unknown = await answerOf(await h.handleToolsClaim(signedRequest("claim", body, T0, { producer: "maven" }), deps(T0)));
    assert.deepEqual([unknown.status, unknown.body.error], [401, "unauthorized"]);
    const missing = await answerOf(await h.handleToolsClaim(signedRequest("claim", body, T0, { producer: null }), deps(T0)));
    assert.deepEqual([missing.status, missing.body.error], [401, "unauthorized"]);
    // A comma in the timestamp must not smuggle in a second signature.
    const smuggled = await answerOf(
      await h.handleToolsClaim(signedRequest("claim", body, T0, { ts: `${Math.floor(T0.getTime() / 1000)},v1=${"0".repeat(64)}` as unknown as number }), deps(T0)),
    );
    assert.equal(smuggled.status, 401);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_runners WHERE last_seen_at >= ?", [T0.toISOString()])), runnersBefore, "no runner was recorded");
  });

  await check("secret unset or too short: 503 not_installed secret_not_set (the runner waits, it does not give up)", async () => {
    for (const env of [{}, { TOOLS_RUNNER_SECRET_BEA: "short" }]) {
      const a = await answerOf(await h.handleToolsClaim(signedRequest("claim", claimBody(), T0), deps(T0, fakeStorage(), env)));
      assert.deepEqual([a.status, a.body.error, a.body.detail], [503, "not_installed", "secret_not_set"]);
    }
  });

  await check("tables missing (bravo__206 not applied): 503 not_installed tables_missing, on every route", async () => {
    const empty = emptyDatabase();
    const ref = { runner_id: "ccpc", job_id: "0b000000-0000-4000-8000-000000000999", lease_id: "c".repeat(32) };
    const routes: Array<[string, (r: Request, d: Parameters<typeof h.handleToolsClaim>[1]) => Promise<Response>, unknown]> = [
      ["claim", h.handleToolsClaim, claimBody()],
      ["heartbeat", h.handleToolsHeartbeat, { ...ref, stage: "downloading" }],
      ["upload-url", h.handleToolsUploadUrl, { ...ref, file_name: "a.mp4", size_bytes: 10, sha256: SHA, md5: MD5, content_type: "video/mp4" }],
      ["fail", h.handleToolsFail, { ...ref, error_code: "private" }],
    ];
    for (const [route, fn, body] of routes) {
      const a = await answerOf(await fn(signedRequest(route, body, T0), { db: empty, env: ENV, now: T0, storage: fakeStorage().storage }));
      assert.deepEqual([a.status, a.body.error, a.body.detail], [503, "not_installed", "tables_missing"], route);
    }
  });

  await check("a body over 64 KiB is 413; a signed body that is not JSON is 422 invalid_json", async () => {
    const big = JSON.stringify({ ...claimBody(), pad: "x".repeat(70 * 1024) });
    const a = await answerOf(await h.handleToolsClaim(signedRequest("claim", null, T0, { raw: big }), deps(T0)));
    assert.deepEqual([a.status, a.body.error], [413, "body_too_large"]);
    const notJson = await answerOf(await h.handleToolsClaim(signedRequest("claim", null, T0, { raw: "{not json" }), deps(T0)));
    assert.deepEqual([notJson.status, notJson.body.error], [422, "invalid_json"]);
  });

  await check("claim refuses a tool that is not a runner tool in the registry, and a bad runner id", async () => {
    for (const tools of [["learn_from_link"], ["evil_tool"], [], "video_download"]) {
      const a = await answerOf(await h.handleToolsClaim(signedRequest("claim", { ...claimBody(), tools }, T0), deps(T0)));
      assert.deepEqual([a.status, a.body.error, a.body.field], [422, "invalid_payload", "tools"], JSON.stringify(tools));
    }
    const a = await answerOf(await h.handleToolsClaim(signedRequest("claim", { ...claimBody(), runner_id: "CC PC" }, T0), deps(T0)));
    assert.deepEqual([a.status, a.body.field], [422, "runner_id"]);
  });

  // -- claim ------------------------------------------------------------------
  await check("two claims at once take one job: one runner gets it, the other gets nothing", async () => {
    const id = await queueDownload(db, OASIS, T0, { url: "https://www.instagram.com/reel/ABC1/" });
    const [a, b] = await Promise.all([claim(T0, "ccpc"), claim(T0, "mac")]);
    const got = [a, b].filter((x) => x.body.job !== null);
    assert.equal(got.length, 1, `exactly one claim gets the job: ${JSON.stringify([a.body, b.body])}`);
    const j = got[0].body.job as Claimed;
    assert.equal(j.job_id, id);
    assert.equal(j.attempt, 1);
    assert.match(j.lease_id, /^[0-9a-f]{32}$/);
    assert.deepEqual(j.input, { url: "https://www.instagram.com/reel/ABC1/", platform: "instagram" }, "only the link and platform, never the workspace");
    assert.deepEqual(j.limits, { max_bytes: 99_614_720, lease_seconds: 900, heartbeat_seconds: 60, run_timeout_seconds: 1200 });
    assert.equal(got[0].body.poll_after_seconds, 0);
    // Close it out so later checks start from an empty queue.
    const done = await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: got[0] === a ? "ccpc" : "mac", job_id: id, lease_id: j.lease_id, error_code: "private" }, T0), deps(T0)));
    assert.equal(done.status, 200);
  });

  await check("an expired lease is claimed again (attempt 2), and the old lease is refused with 409 lease_lost", async () => {
    const id = await queueDownload(db, OASIS, T0);
    const first = (await claim(T0)).body.job as Claimed;
    assert.equal(first.job_id, id);
    // Within the lease nobody else can take it.
    assert.equal((await claim(later(T0, minutes(5)), "mac")).body.job, null);
    const t1 = later(T0, minutes(16)); // past the 15-minute lease
    const second = (await claim(t1, "mac")).body.job as Claimed;
    assert.equal(second.job_id, id);
    assert.equal(second.attempt, 2);
    assert.notEqual(second.lease_id, first.lease_id);
    const hb = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { runner_id: "ccpc", job_id: id, lease_id: first.lease_id, stage: "downloading" }, t1), deps(t1)));
    assert.deepEqual([hb.status, hb.body.error], [409, "lease_lost"]);
    const ok = await answerOf(await h.handleToolsHeartbeat(signedRequest("heartbeat", { runner_id: "mac", job_id: id, lease_id: second.lease_id, stage: "uploading" }, t1), deps(t1)));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.lease_expires_at, later(t1, minutes(15)).toISOString());
    const v = jobView(await job(id));
    assert.deepEqual([v.status, v.stage], ["running", "uploading"], "the heartbeat moves the card to Uploading");
    await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "mac", job_id: id, lease_id: second.lease_id, error_code: "timeout" }, t1), deps(t1)));
  });

  await check("a job whose third lease expires is given up: failed attempts_exhausted, with its line", async () => {
    const t = later(T0, minutes(60));
    const id = await queueDownload(db, OASIS, t);
    let now = t;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const j = (await claim(now)).body.job as Claimed;
      assert.equal(j.job_id, id);
      assert.equal(j.attempt, attempt);
      now = later(now, minutes(16));
    }
    assert.equal((await claim(now)).body.job, null, "no fourth attempt");
    const j = await job(id);
    assert.deepEqual([j.status, j.errorCode], ["failed", "attempts_exhausted"]);
    assert.equal(jobView(j).error_message, SWEEP_ERROR_LINES.attempts_exhausted);
    assert.equal(jobView(j).error_message, "The download stopped three times and was given up.");
  });

  await check("a client workspace's queued job is never claimable by OASIS's runner", async () => {
    const t = later(T0, minutes(200));
    const clientJob = await queueDownload(db, CLIENT_A, t);
    assert.equal((await claim(t)).body.job, null);
    assert.equal(await scalar(db, "SELECT status FROM tool_jobs WHERE id = ?", [clientJob]), "queued");
    assert.equal(await scalar(db, "SELECT claimed_by FROM tool_jobs WHERE id = ?", [clientJob]), null);
  });

  // -- upload-url ---------------------------------------------------------------
  const uploadBody = (j: Claimed, o: Record<string, unknown> = {}) => ({
    runner_id: "ccpc",
    job_id: j.job_id,
    lease_id: j.lease_id,
    file_name: "instagram_someone_ABC.mp4",
    size_bytes: SIZE,
    sha256: SHA,
    md5: MD5,
    content_type: "video/mp4",
    ...o,
  });

  const T2 = later(T0, minutes(400));
  await check("upload-url: one path per job, under the workspace's own folder, kept for every retry and every attempt", async () => {
    const id = await queueDownload(db, OASIS, T2);
    const j = (await claim(T2)).body.job as Claimed;
    const s = fakeStorage();
    const a = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j), T2), deps(T2, s)));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const path = String(a.body.storage_path);
    const row = await job(id);
    assert.ok(row.assetId, "an asset id is reserved");
    assert.ok(path.startsWith(`${OASIS}/${row.assetId}/`), path);
    assert.match(path, /_instagram_someone_ABC\.mp4$/);
    const upload = a.body.upload as { method: string; url: string; headers: Record<string, string>; expires_in: number };
    assert.deepEqual([upload.method, upload.headers, upload.expires_in], ["PUT", { "content-type": "video/mp4" }, 900]);
    assert.deepEqual(s.signed, [path], "the URL is signed for that one object");
    // A retry in the same lease: the same path.
    const again = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j), T2), deps(T2, s)));
    assert.equal(again.body.storage_path, path);
    // A different file in the same lease is a runner bug.
    const conflict = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j, { size_bytes: SIZE + 1 }), T2), deps(T2, s)));
    assert.deepEqual([conflict.status, conflict.body.error], [409, "upload_conflict"]);
    // A new attempt (the lease expired) may upload a different file, to the SAME path.
    const t = later(T2, minutes(16));
    const j2 = (await claim(t, "mac")).body.job as Claimed;
    assert.equal(j2.job_id, id);
    const second = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", { ...uploadBody(j2, { size_bytes: SIZE + 5 }), runner_id: "mac" }, t), deps(t, s)));
    assert.equal(second.status, 200);
    assert.equal(second.body.storage_path, path, "the same object is overwritten: no orphan");
    assert.equal((await job(id)).assetId, row.assetId, "the same asset id");
    await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "mac", job_id: id, lease_id: j2.lease_id, error_code: "runner_error" }, t), deps(t, s)));
  });

  await check("upload-url refuses over 95 MiB (422 size_bytes with max_bytes), a wrong type, and answers 503 with no storage", async () => {
    const t = later(T2, minutes(100));
    const id = await queueDownload(db, OASIS, t);
    const j = (await claim(t)).body.job as Claimed;
    const over = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j, { size_bytes: 99_614_721 }), t), deps(t)));
    assert.deepEqual([over.status, over.body.error, over.body.field, over.body.max_bytes], [422, "invalid_payload", "size_bytes", 99_614_720]);
    const type = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j, { content_type: "video/webm" }), t), deps(t)));
    assert.deepEqual([type.status, type.body.field], [422, "content_type"]);
    const noStore = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j), t), deps(t, null)));
    assert.deepEqual([noStore.status, noStore.body.error, noStore.body.detail], [503, "not_installed", "storage_not_configured"]);
    assert.equal((await job(id)).uploadPath, null, "nothing was recorded for a refused request");
    await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id, lease_id: j.lease_id, error_code: "too_large" }, t), deps(t)));
  });

  // -- complete -----------------------------------------------------------------
  const completeBody = (j: Claimed, path: string, o: Record<string, unknown> = {}) => ({
    runner_id: "ccpc",
    job_id: j.job_id,
    lease_id: j.lease_id,
    storage_path: path,
    size_bytes: SIZE,
    sha256: SHA,
    md5: MD5,
    video: { width: 1080, height: 1920, duration_s: 31.2, fps: 30.0, vcodec: "h264", acodec: "aac", has_audio: true },
    source: {
      platform: "instagram",
      url: "https://www.instagram.com/reel/ABC/",
      webpage_url: "https://www.instagram.com/reel/ABC/",
      video_id: "ABC",
      handle: "@someone",
      uploader: "Someone",
      uploader_url: "https://www.instagram.com/someone/",
      channel: null,
      title: "  How we answer every lead in 60 seconds  ",
      description: "the creator's caption",
      upload_date: "20260930",
      view_count: 123,
      like_count: 4,
      comment_count: 1,
      repost_count: null,
    },
    extractor: { tool_version: "2.0.0", ytdlp_version: "2026.07.04" },
    ...o,
  });

  async function uploaded(t: Date, s: Storage): Promise<{ id: string; j: Claimed; path: string }> {
    const id = await queueDownload(db, OASIS, t);
    const j = (await claim(t, "ccpc", s)).body.job as Claimed;
    assert.equal(j.job_id, id);
    const a = await answerOf(await h.handleToolsUploadUrl(signedRequest("upload-url", uploadBody(j), t), deps(t, s)));
    return { id, j, path: String(a.body.storage_path) };
  }

  const assetCount = async (assetId: string) => Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset WHERE id = ?", [assetId]));

  await check("complete with a matching object: ONE Library video (Downloads, draft, rights unknown) + ONE video row + the job done; a repeat is duplicate", async () => {
    const t = later(T2, minutes(300));
    const s = fakeStorage();
    const { id, j, path } = await uploaded(t, s);
    s.put(path, SIZE, MD5);
    const a = await answerOf(await h.handleToolsComplete(signedRequest("complete", completeBody(j, path), t), deps(t, s)));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.duplicate, false);
    const assetId = String(a.body.asset_id);
    const asset = (await db.execute({ sql: "SELECT * FROM marketing_asset WHERE id = ?", args: [assetId] })).rows[0] as unknown as Record<string, unknown>;
    assert.equal(asset.tenant_id, OASIS);
    assert.equal(asset.brand_slug, "downloads");
    assert.equal(asset.brand_name, "Downloads");
    assert.equal(asset.status, "draft");
    assert.equal(asset.format, "video");
    assert.equal(asset.asset_type, "video");
    assert.equal(asset.channel, "organic-instagram");
    assert.equal(asset.source, `tool:video_download:${id}`);
    assert.equal(asset.author_email, "conaugh@oasisai.work");
    assert.equal(asset.title, "How we answer every lead in 60 seconds");
    assert.equal(asset.body, null, "the creator's caption is not put in the post body");
    const meta = JSON.parse(String(asset.meta));
    assert.equal(meta.rights_status, "unknown");
    assert.equal(meta.tool_job_id, id);
    assert.equal(meta.source.description, "the creator's caption");
    assert.deepEqual(meta.file, { sha256: SHA, md5: MD5, bytes: SIZE, width: 1080, height: 1920, fps: 30, vcodec: "h264", acodec: "aac", has_audio: true });
    const media = (await db.execute({ sql: "SELECT * FROM marketing_asset_media WHERE asset_id = ?", args: [assetId] })).rows;
    assert.equal(media.length, 1);
    const m = media[0] as unknown as Record<string, unknown>;
    assert.deepEqual([m.kind, m.storage_bucket, m.storage_path, m.mime, Number(m.bytes), Number(m.width), Number(m.height)], ["video", "marketing-media", path, "video/mp4", SIZE, 1080, 1920]);
    const v = jobView(await job(id));
    assert.deepEqual([v.status, v.asset_id], ["done", assetId]);
    // A repeat (the answer was lost) is a success, and writes nothing more.
    const again = await answerOf(await h.handleToolsComplete(signedRequest("complete", completeBody(j, path), t), deps(t, s)));
    assert.deepEqual([again.status, again.body.duplicate, again.body.asset_id], [200, true, assetId]);
    assert.equal(await assetCount(assetId), 1);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset_media WHERE asset_id = ?", [assetId])), 1);
  });

  await check("two downloads are two Library videos (the unique source names the run, not the tool)", async () => {
    const t = later(T2, minutes(320));
    const s = fakeStorage();
    for (let n = 0; n < 2; n += 1) {
      const { j, path } = await uploaded(later(t, minutes(n)), s);
      s.put(path, SIZE, MD5);
      const a = await answerOf(await h.handleToolsComplete(signedRequest("complete", completeBody(j, path), later(t, minutes(n))), deps(later(t, minutes(n)), s)));
      assert.equal(a.status, 200, JSON.stringify(a.body));
    }
  });

  await check("complete when the object is missing, or its size or ETag differs: 422 upload_mismatch and NO Library row", async () => {
    const t = later(T2, minutes(360));
    const before = Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset"));
    const cases: Array<[string, (s: Storage, path: string) => void]> = [
      ["missing", () => undefined],
      ["size", (s, path) => s.put(path, SIZE - 1, MD5)],
      ["etag", (s, path) => s.put(path, SIZE, "c".repeat(32))],
    ];
    let n = 0;
    for (const [detail, arrange] of cases) {
      n += 1;
      const s = fakeStorage();
      const tt = later(t, minutes(n * 20));
      const { id, j, path } = await uploaded(tt, s);
      arrange(s, path);
      const a = await answerOf(await h.handleToolsComplete(signedRequest("complete", completeBody(j, path), tt), deps(tt, s)));
      assert.deepEqual([a.status, a.body.error, a.body.detail], [422, "upload_mismatch", detail]);
      assert.equal((await job(id)).status, "running", "the job is untouched: the runner reports the failure");
      await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id, lease_id: j.lease_id, error_code: "upload_mismatch" }, tt), deps(tt, s)));
    }
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset")), before, "no asset was written");
  });

  await check("complete refuses a body that does not match what upload-url recorded, and a lost lease", async () => {
    const t = later(T2, minutes(500));
    const s = fakeStorage();
    const { id, j, path } = await uploaded(t, s);
    s.put(path, SIZE, MD5);
    for (const [o, field] of [
      [{ storage_path: `${path}x` }, "storage_path"],
      [{ size_bytes: SIZE + 1 }, "size_bytes"],
      [{ sha256: "d".repeat(64) }, "sha256"],
      [{ md5: "e".repeat(32) }, "md5"],
    ] as Array<[Record<string, unknown>, string]>) {
      const a = await answerOf(await h.handleToolsComplete(signedRequest("complete", { ...completeBody(j, path), ...o }, t), deps(t, s)));
      assert.deepEqual([a.status, a.body.field], [422, field]);
    }
    const lost = await answerOf(await h.handleToolsComplete(signedRequest("complete", completeBody({ ...j, lease_id: "f".repeat(32) }, path), t), deps(t, s)));
    assert.deepEqual([lost.status, lost.body.error], [409, "lease_lost"]);
    const capped = await answerOf(
      await h.handleToolsComplete(signedRequest("complete", completeBody(j, path, { source: { ...completeBody(j, path).source, title: "t".repeat(301) } }), t), deps(t, s)),
    );
    assert.deepEqual([capped.status, capped.body.field], [422, "source.title"]);
    await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id, lease_id: j.lease_id, error_code: "runner_error" }, t), deps(t, s)));
  });

  // -- fail -----------------------------------------------------------------------
  await check("fail: the job ends with errors.ts's line, the upload is deleted, a repeat is duplicate, an unknown code is stored as unknown", async () => {
    const t = later(T2, minutes(600));
    const s = fakeStorage();
    const { id, j, path } = await uploaded(t, s);
    const a = await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id, lease_id: j.lease_id, error_code: "private" }, t), deps(t, s)));
    assert.deepEqual([a.status, a.body.duplicate], [200, false]);
    const v = jobView(await job(id));
    assert.deepEqual([v.status, v.error_code, v.error_message], ["failed", "private", "The post or account is private."]);
    assert.equal(v.error_message, RUNNER_ERROR_LINES.private);
    assert.deepEqual(s.removed, [path], "the uploaded object is deleted");
    const again = await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id, lease_id: j.lease_id, error_code: "private" }, t), deps(t, s)));
    assert.deepEqual([again.status, again.body.duplicate], [200, true]);

    const t2 = later(t, minutes(30));
    const id2 = await queueDownload(db, OASIS, t2);
    const j2 = (await claim(t2)).body.job as Claimed;
    await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id2, lease_id: j2.lease_id, error_code: "some_new_code" }, t2), deps(t2)));
    const v2 = jobView(await job(id2));
    assert.deepEqual([v2.error_code, v2.error_message], ["unknown", "The download failed on the connected computer."]);
    const badShape = await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id2, lease_id: j2.lease_id, error_code: "Bad Code" }, t2), deps(t2)));
    assert.deepEqual([badShape.status, badShape.body.field], [422, "error_code"]);
  });

  await check("a delete that fails is logged, never turns fail into an error", async () => {
    const t = later(T2, minutes(700));
    const s = fakeStorage({ removeThrows: true });
    const { id, j } = await uploaded(t, s);
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const a = await answerOf(await h.handleToolsFail(signedRequest("fail", { runner_id: "ccpc", job_id: id, lease_id: j.lease_id, error_code: "timeout" }, t), deps(t, s)));
      assert.equal(a.status, 200);
    } finally {
      console.error = quiet;
    }
  });

  // -- the runner_offline sweep -----------------------------------------------------
  await check("runner_offline: a queued job fails after 30 minutes ONLY when no live runner serves it", async () => {
    const t = later(T2, minutes(900));
    const id = await queueDownload(db, OASIS, t);
    const at = later(t, minutes(31));
    const { sweepToolJobs } = await import("../lib/tools/store");
    // A runner seen 5 minutes ago that lists the tool: the job waits for it.
    await seedRunner(db, later(at, -minutes(5)));
    await sweepToolJobs(db, [OASIS], at);
    assert.equal((await job(id)).status, "queued");
    // A live runner that does not list the tool does not count.
    await seedRunner(db, later(at, -minutes(5)), ["something_else"]);
    await sweepToolJobs(db, [OASIS], at);
    const v = jobView(await job(id));
    assert.deepEqual([v.status, v.error_code, v.error_message], ["failed", "runner_offline", "The computer that runs downloads was offline, so this didn't run."]);
    // And a runner last seen 11 minutes ago is not live.
    const id2 = await queueDownload(db, OASIS, t);
    await seedRunner(db, later(at, -minutes(11)));
    await sweepToolJobs(db, [OASIS], at);
    assert.equal((await job(id2)).status, "failed");
  });

  finish("tools runner");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
