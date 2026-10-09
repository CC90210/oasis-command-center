/**
 * tests/tools-registry.test.ts - the Toolkit's registry is the only door: a
 * key that is not in lib/tools/registry.ts can never run, be queued or be
 * claimed, and each tool's validator decides what it accepts.
 *
 * Pins:
 *   - every worker tool has an executor (lib/tools/worker/index.ts) and every
 *     executor is a worker tool in the registry; the one runner tool is the
 *     video downloader;
 *   - POST /api/tools/run refuses an unknown key with 422 unknown_tool and
 *     writes nothing (through the real founders gate and a local database);
 *   - a runner job with a key outside the registry is never claimed, and a
 *     runner asking for such a key is refused;
 *   - the URL rules: Download takes one Instagram, TikTok or YouTube post,
 *     canonical and https, and nothing else; Learn refuses video links and any
 *     address inside a network.
 *
 * Run: node --conditions=react-server --import tsx tests/tools-registry.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ENV, OASIS, USERS, answerOf, check, fakeStorage, finish, login, queueDownload, scalar, setupToolsDatabase, signedRequest } from "./_tools-harness";

async function main() {
  console.log("tools registry:");
  const db = await setupToolsDatabase();
  const { TOOL_REGISTRY, toolByKey, runnerToolKeys } = await import("../lib/tools/registry");
  const { WORKER_EXECUTORS } = await import("../lib/tools/worker");
  const { handleToolRun } = await import("../lib/tools/session-handlers");
  const { resolveToolsViewer } = await import("../lib/tools/access");
  const { handleToolsClaim } = await import("../lib/tools/runner-handlers");

  await check("every worker tool has an executor, and every executor is a worker tool in the registry", () => {
    const workerKeys = TOOL_REGISTRY.filter((t) => t.runsOn === "worker").map((t) => t.key).sort();
    assert.deepEqual(Object.keys(WORKER_EXECUTORS).sort(), workerKeys);
    assert.deepEqual(runnerToolKeys(), ["video_download"]);
    assert.equal(new Set(TOOL_REGISTRY.map((t) => t.key)).size, TOOL_REGISTRY.length, "no key twice");
    for (const t of TOOL_REGISTRY) {
      assert.ok(t.title && t.description && t.runLabel && t.fields.length > 0, `${t.key} is drawable`);
      assert.equal(toolByKey(t.key), t);
    }
    for (const k of ["", "VIDEO_DOWNLOAD", "toString", "__proto__", null, 7]) assert.equal(toolByKey(k), null, String(k));
  });

  await check("POST /api/tools/run refuses a key outside the registry with 422 unknown_tool, and writes nothing", async () => {
    await login(USERS.cc);
    const before = Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs"));
    for (const tool of ["evil_tool", "", "constructor", "VIDEO_DOWNLOAD"]) {
      const res = await handleToolRun(
        new Request("https://oasisai.work/api/tools/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool, input: { url: "https://www.instagram.com/reel/ABC/" }, idempotency_key: randomUUID() }),
        }),
        { db, now: () => new Date(), viewer: resolveToolsViewer },
      );
      const a = await answerOf(res);
      assert.deepEqual([a.status, a.body.error], [422, "unknown_tool"], tool);
    }
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs")), before);
  });

  await check("a runner job whose key is not a registry runner tool is never claimed, and a runner may not ask for one", async () => {
    const now = new Date("2026-10-09T03:00:00.000Z");
    const evil = await queueDownload(db, OASIS, now, { toolKey: "evil_tool" });
    const a = await answerOf(
      await handleToolsClaim(signedRequest("claim", { runner_id: "ccpc", label: "CC's PC", version: "1.0.0", tools: ["video_download"] }, now), {
        db,
        env: ENV,
        now,
        storage: fakeStorage().storage,
      }),
    );
    assert.equal(a.body.job, null);
    assert.equal(await scalar(db, "SELECT status FROM tool_jobs WHERE id = ?", [evil]), "queued");
    const b = await answerOf(
      await handleToolsClaim(signedRequest("claim", { runner_id: "ccpc", label: "CC's PC", version: "1.0.0", tools: ["evil_tool"] }, now), {
        db,
        env: ENV,
        now,
        storage: fakeStorage().storage,
      }),
    );
    assert.deepEqual([b.status, b.body.field], [422, "tools"]);
  });

  const download = toolByKey("video_download")!;
  const learn = toolByKey("learn_from_link")!;
  const ok = (t: typeof download, url: string) => {
    const v = t.validate({ url });
    assert.ok(v.ok, `${url} should be accepted: ${JSON.stringify(v)}`);
    return v;
  };
  const refused = (t: typeof download, url: string, code?: string) => {
    const v = t.validate({ url });
    assert.equal(v.ok, false, `${url} should be refused`);
    if (!v.ok && code) assert.equal(v.code, code, url);
  };

  await check("Download takes one Instagram, TikTok or YouTube post: canonical, https, tracking stripped", () => {
    const cases: Array<[string, string, string]> = [
      ["https://www.instagram.com/reel/ABC123/?igsh=xyz", "https://www.instagram.com/reel/ABC123/", "instagram"],
      ["http://instagram.com/p/XYZ789", "https://www.instagram.com/p/XYZ789/", "instagram"],
      ["https://www.tiktok.com/@someone/video/7300000000000000000?is_from_webapp=1", "https://www.tiktok.com/@someone/video/7300000000000000000", "tiktok"],
      ["http://vm.tiktok.com/ZMabc123/", "https://vm.tiktok.com/ZMabc123/", "tiktok"],
      ["https://youtu.be/dQw4w9WgXcQ?si=abc", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
      ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
      ["  www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share  ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ];
    for (const [input, url, platform] of cases) {
      const v = ok(download, input);
      if (v.ok) {
        assert.deepEqual(v.value, { url, platform }, input);
        assert.equal(v.dedupeKey, `video_download:${url}`);
      }
    }
  });

  await check("Download refuses everything else: profiles, other hosts, user names, ports, other schemes, overlong links", () => {
    refused(download, "", "required");
    refused(download, "https://www.instagram.com/someone/", "unsupported_url");
    refused(download, "https://www.youtube.com/@channel", "unsupported_url");
    refused(download, "https://vimeo.com/123456", "unsupported_url");
    refused(download, "https://example.com/video.mp4", "unsupported_url");
    refused(download, "https://user:pass@www.instagram.com/reel/ABC/", "invalid_url");
    refused(download, "https://www.instagram.com:8443/reel/ABC/", "invalid_url");
    refused(download, "javascript:alert(1)", "invalid_url");
    refused(download, "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ", "invalid_url");
    refused(download, `https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=${"a".repeat(2100)}`, "too_long");
    refused(download, "https://127.0.0.1/reel/ABC/", "invalid_url");
  });

  await check("Learn takes a web page or a GitHub repo, and refuses video links and addresses inside a network", () => {
    const page = ok(learn, "https://example.com/blog/post?utm_source=x");
    if (page.ok) {
      assert.equal(page.value.url, "https://example.com/blog/post");
      assert.equal(page.value.label, "exemplar", "the default label");
      assert.equal(page.dedupeKey, "learn_from_link:https://example.com/blog/post");
    }
    const repo = learn.validate({ url: "github.com/vercel/next.js", label: "counter_example" });
    assert.ok(repo.ok && repo.value.source_kind === "github" && repo.value.external_id === "vercel/next.js" && repo.value.label === "counter_example");
    for (const v of ["https://www.instagram.com/reel/ABC/", "https://youtu.be/dQw4w9WgXcQ", "https://www.tiktok.com/@a/video/1"]) {
      refused(learn, v, "video_link_not_supported");
    }
    for (const v of ["http://127.0.0.1/", "http://localhost/", "http://10.1.2.3/", "http://169.254.169.254/", "http://[::1]/", "http://intranet/", "https://a:b@example.com/", "https://example.com:8080/"]) {
      refused(learn, v);
    }
    const badLabel = learn.validate({ url: "https://example.com/", label: "favourite" });
    assert.deepEqual(badLabel, { ok: false, field: "label", code: "invalid_choice" });
  });

  await check("Score a hook and Repurpose a post: required, bounded, no control characters", () => {
    const score = toolByKey("score_hook")!;
    const repurpose = toolByKey("repurpose_post")!;
    assert.deepEqual(score.validate({ hook: "  " }), { ok: false, field: "hook", code: "required" });
    assert.deepEqual(score.validate({ hook: "x".repeat(501) }), { ok: false, field: "hook", code: "too_long" });
    assert.deepEqual(score.validate({ hook: "a\u0000b" }), { ok: false, field: "hook", code: "invalid_characters" });
    assert.deepEqual(score.validate({ hook: " Hook ", caption: "line one\nline two" }), { ok: true, value: { hook: "Hook", caption: "line one\nline two" }, dedupeKey: null });
    assert.deepEqual(repurpose.validate({ post: "too short" }), { ok: false, field: "post", code: "too_short" });
    assert.deepEqual(repurpose.validate({ post: "x".repeat(3001) }), { ok: false, field: "post", code: "too_long" });
    assert.equal(repurpose.validate({ post: "A post that is long enough to repurpose." }).ok, true);
  });

  finish("tools registry");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
