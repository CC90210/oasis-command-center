/**
 * tests/extracted-videos.test.ts - Content > Extracted videos (CC, 2026-10-17:
 * extracted videos are "a separate category ... rather than the main library").
 *
 *   1. extractedVideoFacts reads what the runner's /complete writes into
 *      marketing_asset.meta (platform, creator, the original post, posted date,
 *      metrics, audio, size) and reads anything missing or malformed as null:
 *      a non-web URL never becomes a link.
 *   2. The real page, through the real founder gate and a real libSQL Library:
 *      it shows exactly the workspace's `downloads` rows (never OASIS's own work,
 *      never another workspace's), each card carrying its anchor, Download and
 *      Delete; with none, it says how to extract one.
 *   3. The Content Tools card sends a finished extract to its card on this page,
 *      not to the Library.
 *
 * Run: node --conditions=react-server --import tsx tests/extracted-videos.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { CLIENT_A, OASIS, USERS, check, finish, login, setupToolsDatabase } from "./_tools-harness";

(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

// next/navigation and next/link pull the client router context, which does not
// exist under the react-server condition (same stub as tests/content-hub.test.ts).
function stubModule(id: string, exports: Record<string, unknown>) {
  const path = require.resolve(id);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stubModule("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  useRouter: () => ({ refresh: () => undefined }),
});
const LinkStub = ({ href, children, ...rest }: { href: string; children?: unknown }) =>
  ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode);
stubModule("next/link", { __esModule: true, default: LinkStub });

const root = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(root, rel), "utf8");

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const nodes = (n: unknown): El[] =>
  Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === "object" && "props" in n ? [n as El, ...nodes((n as El).props.children)] : [];

/** What lib/tools/runner-handlers.ts writes for one finished download (CC's first real one, 2026-10-17). */
const RUNNER_META = {
  tool: "video_download",
  tool_job_id: "81d5e580-d7c3-4250-ba1d-77c8e06fd6ea",
  rights_status: "unknown",
  source: {
    platform: "instagram",
    url: "https://www.instagram.com/reel/C43j_8NJFfP/",
    webpage_url: "https://www.instagram.com/reel/C43j_8NJFfP/",
    video_id: "C43j_8NJFfP",
    handle: "ccmusicc03",
    uploader: "CC",
    uploader_url: "https://www.instagram.com/ccmusicc03",
    channel: null,
    title: "Video by ccmusicc03",
    description: null,
    upload_date: "20240402",
    metrics: { view_count: 12400, like_count: 310, comment_count: 12, repost_count: null },
  },
  file: { sha256: "x", md5: "y", bytes: 5_109_047, width: 720, height: 1280, fps: 30, vcodec: "h264", acodec: "aac", has_audio: true },
  extractor: { tool_version: "1.0.0", ytdlp_version: "2026.07.04" },
};

async function seedAsset(
  db: Awaited<ReturnType<typeof setupToolsDatabase>>,
  o: { id: string; tenant: string; brand: string; title: string; meta?: unknown },
) {
  await db.execute({
    sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, status, source, brand_slug, brand_name, asset_type, duration_s, meta)
          VALUES (?, ?, ?, 'organic-instagram', 'video', 'draft', ?, ?, ?, 'video', '25.15', ?)`,
    args: [o.id, o.tenant, o.title, `test:${o.id}`, o.brand, o.brand, JSON.stringify(o.meta ?? {})],
  });
  await db.execute({
    sql: `INSERT INTO marketing_asset_media (tenant_id, asset_id, kind, storage_path, mime, bytes, width, height)
          VALUES (?, ?, 'video', ?, 'video/mp4', 5109047, 720, 1280)`,
    args: [o.tenant, o.id, `${o.tenant}/tool-downloads/${o.id}.mp4`],
  });
}

async function main() {
  console.log("extracted-videos:");
  const lib = await import("../lib/founders/extracted-videos");

  // ── 1. the facts ─────────────────────────────────────────────────────────
  await check("extractedVideoFacts reads the runner's meta: platform, @creator, the post, date, metrics, audio, size", () => {
    const f = lib.extractedVideoFacts(RUNNER_META);
    assert.deepEqual(f, {
      platform: "Instagram",
      creator: "@ccmusicc03",
      creatorUrl: "https://www.instagram.com/ccmusicc03",
      originalUrl: "https://www.instagram.com/reel/C43j_8NJFfP/",
      postTitle: "Video by ccmusicc03",
      postedOn: "2024-04-02",
      views: 12400,
      likes: 310,
      comments: 12,
      hasAudio: true,
      bytes: 5_109_047,
    });
    // The driver may hand meta back as JSON text; the same facts come out.
    assert.deepEqual(lib.extractedVideoFacts(JSON.stringify(RUNNER_META)), f);
  });

  await check("anything missing or malformed reads as null, and only an http(s) address becomes a link", () => {
    for (const raw of [null, undefined, "", "not json", "[]", 7, []]) {
      const f = lib.extractedVideoFacts(raw);
      assert.ok(Object.values(f).every((v) => v === null), `all null for ${JSON.stringify(raw)}`);
    }
    const hostile = lib.extractedVideoFacts({
      source: {
        platform: "tiktok",
        webpage_url: "javascript:alert(1)",
        url: "data:text/html,hi",
        uploader_url: "ftp://x",
        handle: "@@someone",
        upload_date: "2024-01-01",
        metrics: { view_count: -1, like_count: 1.5, comment_count: "9" },
      },
      file: { bytes: "big", has_audio: "yes" },
    });
    assert.equal(hostile.platform, "TikTok");
    assert.equal(hostile.creator, "@someone", "one @, however many were stored");
    assert.equal(hostile.originalUrl, null, "a javascript: or data: URL never becomes a link");
    assert.equal(hostile.creatorUrl, null);
    assert.equal(hostile.postedOn, null, "only yt-dlp's YYYYMMDD is a date");
    assert.deepEqual([hostile.views, hostile.likes, hostile.comments, hostile.bytes, hostile.hasAudio], [null, null, null, null, null]);
    // No handle: the uploader, then the channel.
    assert.equal(lib.extractedVideoFacts({ source: { uploader: "Some Channel" } }).creator, "Some Channel");
    assert.equal(lib.extractedVideoFacts({ source: { channel: "Chan" } }).creator, "Chan");
  });

  await check("the numbers read the way a person says them", () => {
    assert.equal(lib.formatBytes(5_109_047), "4.9 MB");
    assert.equal(lib.formatBytes(2048), "2 KB");
    assert.equal(lib.formatBytes(null), null);
    assert.equal(lib.formatDuration("25.149829"), "0:25");
    assert.equal(lib.formatDuration(3725), "1:02:05");
    assert.equal(lib.formatDuration(null), null);
    assert.equal(lib.formatDuration("0"), null);
    assert.equal(lib.formatCount(999), "999");
    assert.equal(lib.formatCount(12_400), "12K");
    assert.equal(lib.formatCount(1_200), "1.2K");
    assert.equal(lib.formatCount(2_000_000), "2M");
    assert.equal(lib.extractedHref("abc"), "/founders/marketing/extracted#video-abc");
  });

  // ── 2. the page ──────────────────────────────────────────────────────────
  const db = await setupToolsDatabase();
  await check("the page shows exactly this workspace's extracted videos, each with its anchor, Download and Delete", async () => {
    const dl1 = "11111111-1111-4111-8111-111111111111";
    const dl2 = "22222222-2222-4222-8222-222222222222";
    const own = "33333333-3333-4333-8333-333333333333";
    const other = "44444444-4444-4444-8444-444444444444";
    await seedAsset(db, { id: dl1, tenant: OASIS, brand: "downloads", title: "Video by ccmusicc03", meta: RUNNER_META });
    await seedAsset(db, { id: dl2, tenant: OASIS, brand: "downloads", title: "Older download" });
    await seedAsset(db, { id: own, tenant: OASIS, brand: "oasis-ai", title: "OASIS FLEET VSL" });
    await seedAsset(db, { id: other, tenant: CLIENT_A, brand: "downloads", title: "Another workspace's download" });
    await login(USERS.cc);

    const { ExtractedVideoActions } = await import("../components/founders/ExtractedVideoActions");
    const Page = (await import("../app/founders/marketing/extracted/page")).default;
    const tree = await Page({ searchParams: Promise.resolve({}) });
    const all = nodes(tree);
    const actions = all.filter((n) => n.type === ExtractedVideoActions).map((n) => n.props.assetId);
    assert.deepEqual([...actions].sort(), [dl1, dl2].sort(), "the downloads, and only them: not OASIS's own work, not another workspace's");
    const cards = all.filter((n) => n.type === "li" && n.props["data-testid"] === "extracted-video").map((n) => n.props.id);
    assert.deepEqual([...cards].sort(), [`video-${dl1}`, `video-${dl2}`].sort(), "each card is the anchor Content Tools links to");
    const links = all.filter((n) => n.type === "a").map((n) => String(n.props.href));
    assert.ok(links.includes("https://www.instagram.com/reel/C43j_8NJFfP/"), "the original post is linked");
    const count = all.find((n) => n.props["data-testid"] === "extracted-count");
    assert.ok(count && JSON.stringify(count.props.children).includes("2 videos"), "the count is this workspace's");
  });

  await check("with nothing extracted, the page says how to extract a video instead of showing a bare grid", async () => {
    // The same database as above (the harness keeps one file): empty the Library.
    await db.execute("DELETE FROM marketing_asset_media");
    await db.execute("DELETE FROM marketing_asset");
    await login(USERS.cc);
    const Page = (await import("../app/founders/marketing/extracted/page")).default;
    const all = nodes(await Page({ searchParams: Promise.resolve({}) }));
    assert.ok(all.some((n) => n.props["data-testid"] === "extracted-empty"), "the empty state");
    assert.ok(!all.some((n) => n.props["data-testid"] === "extracted-video"));
  });

  await check("the page gates itself, and Delete asks first on the card (no confirm() dialog)", () => {
    assert.match(code("app/founders/marketing/extracted/page.tsx"), /resolveFounder\(\)/);
    const actions = code("components/founders/ExtractedVideoActions.tsx");
    assert.doesNotMatch(actions, /\bconfirm\(/, "the viewer has no confirm() dialog");
    assert.match(actions, /method: "DELETE"/);
    assert.match(actions, /\/download`/);
    assert.match(actions, /router\.refresh\(\)/, "the card goes because the row went");
  });

  // ── 3. Content Tools points here ─────────────────────────────────────────
  await check("a finished extract opens on its card in Extracted videos, not in the Library", () => {
    assert.match(code("components/tools/ToolsSection.tsx"), /assetHrefPrefix = "\/founders\/marketing\/extracted#video-"/);
    const grid = code("components/tools/ToolGrid.tsx");
    assert.doesNotMatch(grid, />\s*Open in Library\s*</);
    assert.equal((grid.match(/Open in Extracted videos/g) || []).length >= 2, true, "latest run and recent runs");
    assert.match(code("lib/tools/registry.ts"), /Content > Extracted videos/);
  });

  finish("extracted-videos");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
