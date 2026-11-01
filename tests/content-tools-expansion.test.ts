import assert from "node:assert/strict";
import { ENV, OASIS, CLIENT_A, answerOf, check, fakeStorage, finish, queueDownload, scalar, setupToolsDatabase, signedRequest } from "./_tools-harness";
import { toolByKey } from "../lib/tools/registry";
import { parseContentResult } from "../lib/tools/content-results";

async function main() {
  const db = await setupToolsDatabase();
  const h = await import("../lib/tools/runner-handlers");
  const now = new Date("2026-11-01T18:00:00Z");
  const storage = fakeStorage();
  const deps = { db, env: ENV, now, storage: storage.storage };
  const call = async (route: string, body: Record<string, unknown>) => {
    const fn = { claim: h.handleToolsClaim, "upload-url": h.handleToolsUploadUrl, complete: h.handleToolsComplete, fail: h.handleToolsFail }[route]!;
    return answerOf(await fn(signedRequest(route, { runner_id: "content", ...body }, now), deps));
  };
  const claim = async (key: string) => (await call("claim", { label: "Cloud content", version: "1.1.0", tools: [key] })).body.job;
  const files = [1, 2, 3].map(i => ({ size_bytes: 1000 + i, sha256: String(i).repeat(64), md5: String(i).repeat(32) }));
  const hooks = ["tiktok", "instagram", "youtube", "linkedin", "threads"].map(platform => ({ platform, hook: "A useful question?", script: "A source-grounded script.", caption: "A clear caption." }));

  await check("new tools validate bounded transcripts, supported links and writing approaches", () => {
    assert.equal(toolByKey("video_remix")!.validate({ url: "http://127.0.0.1/private" }).ok, false);
    assert.equal(toolByKey("video_remix")!.validate({ url: "https://www.youtube.com/watch?v=5q_nOvTTvkw" }).ok, true);
    assert.equal(toolByKey("hook_rewriter")!.validate({ transcript: "A factual transcript of a founder discussing a process.", framework: "ceo_log" }).ok, true);
    assert.equal(toolByKey("hook_rewriter")!.validate({ transcript: "x".repeat(30001) }).ok, false);
    assert.equal(toolByKey("hook_rewriter")!.validate({ transcript: "x".repeat(100), framework: "unknown" }).ok, false);
    assert.equal(parseContentResult("hook_rewriter", { hooks: hooks.slice(1) }), null);
    assert.equal(parseContentResult("hook_rewriter", { hooks: Array(5).fill(hooks[0]) }), null);
    assert.equal(parseContentResult("broll_matcher", { matches: [{ keyword: "skyline", title: "private", url: "http://127.0.0.1", license: "CC0", score: 0.4 }] }), null);
  });

  await check("hook claim preserves transcript; invalid result and wrong lease write nothing", async () => {
    const id = await queueDownload(db, OASIS, now, { toolKey: "hook_rewriter" });
    await db.execute({ sql: "UPDATE tool_jobs SET created_by = ?, input_json = ? WHERE id = ? AND tenant_id = ?", args: ["actual-creator", JSON.stringify({ transcript: "A transcript with enough words to rewrite.", framework: "nepq", auth_context: { created_by: "forged-owner", tenant_id: CLIENT_A } }), id, OASIS] });
    const job = await claim("hook_rewriter");
    assert.equal(job.input.framework, "nepq");
    assert.ok(job.input.transcript);
    assert.deepEqual(job.auth_context, { created_by: "actual-creator", tenant_id: OASIS }, "cookie authority comes from the database, never job input");
    assert.equal((await call("complete", { job_id: id, lease_id: "f".repeat(32), tool_key: "hook_rewriter", result: { hooks } })).status, 409);
    const ref = { job_id: id, lease_id: job.lease_id, tool_key: "hook_rewriter" };
    assert.equal((await call("complete", { ...ref, result: { hooks: [] } })).status, 422);
    assert.equal((await call("complete", { ...ref, result: { hooks } })).status, 200);
    assert.equal((await call("complete", { ...ref, result: { hooks } })).body.duplicate, true);
    assert.equal(await scalar(db, "SELECT status FROM tool_jobs WHERE id = ?", [id]), "done");
  });

  await check("three remixed uploads verify checksums and commit three downloadable draft assets atomically", async () => {
    const id = await queueDownload(db, OASIS, now, { toolKey: "video_remix" });
    const job = await claim("video_remix");
    assert.equal(job.limits.run_timeout_seconds, 13500);
    assert.equal(job.limits.max_hold_seconds, 14400);
    const ref = { job_id: id, lease_id: job.lease_id };
    const reservation = await call("upload-url", { ...ref, files });
    assert.equal(reservation.status, 200, JSON.stringify(reservation.body));
    const uploads = reservation.body.uploads as Array<Record<string, any>>;
    assert.equal(uploads.length, 3);
    assert.ok(uploads.every(f => f.storage_path.startsWith(OASIS + "/")));
    assert.equal((await call("upload-url", { ...ref, files: files.map(f => ({ ...f, size_bytes: 42 })) })).status, 409);
    const clips = uploads.map(f => ({ storage_path: f.storage_path, width: 1080, height: 1920, duration_s: 30, captions: true }));
    assert.equal((await call("complete", { ...ref, tool_key: "video_remix", clips })).status, 422);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset")), 0);
    for (const f of uploads) storage.put(f.storage_path, f.size_bytes, f.md5);
    const done = await call("complete", { ...ref, tool_key: "video_remix", clips });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.result.clips.length, 3);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset WHERE tenant_id = ? AND brand_slug = 'downloads' AND status = 'draft'", [OASIS])), 3);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset_media WHERE tenant_id = ?", [OASIS])), 3);
    assert.equal((await call("complete", { ...ref, tool_key: "video_remix", clips })).body.duplicate, true);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_asset WHERE tenant_id = ?", [CLIENT_A])), 0);
  });

  await check("failed remix removes every reserved upload", async () => {
    const id = await queueDownload(db, OASIS, now, { toolKey: "video_remix" });
    const job = await claim("video_remix");
    const ref = { job_id: id, lease_id: job.lease_id };
    const reserved = await call("upload-url", { ...ref, files });
    const paths = reserved.body.uploads.map((f: any) => f.storage_path);
    assert.equal((await call("fail", { ...ref, error_code: "runner_error" })).status, 200);
    assert.ok(paths.every((p: string) => storage.removed.includes(p)));
  });
  await check("reclaimed remix uses new object paths and reaps old signed URLs after expiry", async () => {
    const id = await queueDownload(db, OASIS, now, { toolKey: "video_remix" });
    const oldJob = await claim("video_remix");
    const oldRef = { job_id: id, lease_id: oldJob.lease_id };
    const oldFiles = (await call("upload-url", { ...oldRef, files })).body.uploads;
    await db.execute({ sql: "UPDATE tool_jobs SET lease_expires_at = ? WHERE id = ? AND tenant_id = ?", args: [new Date(now.getTime() - 1).toISOString(), id, OASIS] });
    const newJob = await claim("video_remix");
    const newRef = { job_id: id, lease_id: newJob.lease_id };
    const newFiles = (await call("upload-url", { ...newRef, files })).body.uploads;
    assert.ok(newFiles.every((f: any, i: number) => f.storage_path !== oldFiles[i].storage_path));
    const clips = newFiles.map((f: any) => ({ storage_path: f.storage_path, width: 1080, height: 1920, duration_s: 30, captions: true }));
    for (const f of newFiles) storage.put(f.storage_path, f.size_bytes, f.md5);
    assert.equal((await call("complete", { ...oldRef, tool_key: "video_remix", clips })).status, 409);
    assert.equal((await call("complete", { ...newRef, tool_key: "video_remix", clips })).status, 200);
    const { sweepRetiredContentUploads } = await import("../lib/tools/content-runner");
    for (const f of oldFiles) storage.put(f.storage_path, f.size_bytes, f.md5);
    await sweepRetiredContentUploads(deps, [OASIS]);
    assert.ok(oldFiles.every((f: any) => storage.objects.has(f.storage_path)), "old signatures may still be valid");
    await sweepRetiredContentUploads({ ...deps, now: new Date(now.getTime() + 17 * 60000) }, [OASIS]);
    assert.ok(oldFiles.every((f: any) => !storage.objects.has(f.storage_path)));
    assert.ok(newFiles.every((f: any) => storage.objects.has(f.storage_path)), "current asset objects stay intact");
  });
  db.close();
  finish("content tools expansion");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
