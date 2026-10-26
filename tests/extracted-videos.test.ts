/**
 * tests/extracted-videos.test.ts - Content > Extracted videos (CC, 2026-10-17:
 * extracted videos are "a separate category ... rather than the main library").
 *
 *   1. extractedVideoFacts reads what the runner's /complete writes into
 *      marketing_asset.meta (platform, creator, the original post, posted date,
 *      metrics, audio, size) and reads anything missing or malformed as null:
 *      a non-web URL never becomes a link.
 *   2. The real page, through the real founder gate and a real libSQL Library:
 *      exactly the workspace's `downloads` rows, every status (no review
 *      lifecycle here, so the count matches the Overview tile), each card with
 *      its anchor, Download and Delete; ?video=<id> shows that one first; with
 *      none, it says how to extract one. No <video> is in the server markup:
 *      LazyVideo mounts it near the screen.
 *   3. Content Tools, the Overview tile and the asset page lead here, not to the
 *      Library; the asset page offers an extracted video no verdicts and no
 *      posting, and the PATCH route refuses one.
 *   4. The Library never holds them, proven on real rows: no Library tab's grid
 *      (any lifecycle), tab or lifecycle count, audience/pack facet or author
 *      facet includes a `downloads` row, and Clients never takes them. An old
 *      ?group=downloads link redirects here, keeping its page.
 *   5. One slug, spelled the same in the brand groups, this page and the runner's
 *      INSERT; the new files are ASCII.
 *
 * Run: node --conditions=react-server --import tsx tests/extracted-videos.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
});
const LinkStub = ({ href, children, ...rest }: { href: string; children?: unknown }) =>
  ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode);
stubModule("next/link", { __esModule: true, default: LinkStub });

const root = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(root, rel), "utf8");

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/**
 * The element tree with server components expanded (called with their props), so
 * a check sees inside the page's own card component. Client components are left
 * as elements: they need a browser React, and their props are what is checked.
 */
function expandWith(clientTypes: unknown[]) {
  const nodes = (n: unknown): El[] => {
    if (Array.isArray(n)) return n.flatMap(nodes);
    if (!n || typeof n !== "object" || !("props" in n)) return [];
    const el = n as El;
    if (typeof el.type === "function" && !clientTypes.includes(el.type)) {
      return [el, ...nodes((el.type as (p: unknown) => unknown)(el.props))];
    }
    return [el, ...nodes(el.props.children)];
  };
  return nodes;
}

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

type Db = Awaited<ReturnType<typeof setupToolsDatabase>>;

async function seedAsset(
  db: Db,
  o: { id: string; tenant: string; brand: string; title: string; meta?: unknown; status?: string; author?: string },
) {
  await db.execute({
    sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, status, source, brand_slug, brand_name, asset_type, duration_s, meta, author_email)
          VALUES (?, ?, ?, 'organic-instagram', 'video', ?, ?, ?, ?, 'video', '25.15', ?, ?)`,
    args: [o.id, o.tenant, o.title, o.status ?? "draft", `test:${o.id}`, o.brand, o.brand, JSON.stringify(o.meta ?? {}), o.author ?? "conaugh@oasisai.work"],
  });
  await db.execute({
    sql: `INSERT INTO marketing_asset_media (tenant_id, asset_id, kind, storage_path, mime, bytes, width, height)
          VALUES (?, ?, 'video', ?, 'video/mp4', 5109047, 720, 1280)`,
    args: [o.tenant, o.id, `${o.tenant}/tool-downloads/${o.id}.mp4`],
  });
}

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

async function main() {
  console.log("extracted-videos:");
  const lib = await import("../lib/founders/extracted-videos");
  const { ExtractedVideoActions } = await import("../components/founders/ExtractedVideoActions");
  const { LazyVideo } = await import("../components/founders/LazyVideo");
  const nodes = expandWith([ExtractedVideoActions, LazyVideo]);

  // -- 1. the facts ---------------------------------------------------------
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

  await check("the numbers read the way a person says them, and the link names the video", () => {
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
    assert.equal(lib.extractedHref("abc"), "/founders/marketing/extracted?video=abc");
  });

  // -- 2. the page -----------------------------------------------------------
  const db = await setupToolsDatabase();
  const [dl1, dl2, own, other, archivedDl] = [id(1), id(2), id(3), id(4), id(5)];
  await seedAsset(db, { id: dl1, tenant: OASIS, brand: "downloads", title: "Video by ccmusicc03", meta: RUNNER_META });
  await seedAsset(db, { id: dl2, tenant: OASIS, brand: "downloads", title: "Older download" });
  await seedAsset(db, { id: archivedDl, tenant: OASIS, brand: "downloads", title: "Archived before #684", status: "archived" });
  await seedAsset(db, { id: own, tenant: OASIS, brand: "oasis-ai", title: "OASIS FLEET VSL" });
  await seedAsset(db, { id: other, tenant: CLIENT_A, brand: "downloads", title: "Another workspace's download" });
  const Page = (await import("../app/founders/marketing/extracted/page")).default;

  await check("the page shows exactly this workspace's extracted videos, every status, each with its anchor, Download and Delete", async () => {
    await login(USERS.cc);
    const all = nodes(await Page({ searchParams: Promise.resolve({}) }));
    const actions = all.filter((n) => n.type === ExtractedVideoActions).map((n) => n.props.assetId);
    assert.deepEqual(
      [...actions].sort(),
      [dl1, dl2, archivedDl].sort(),
      "the downloads, archived included, and only them: not OASIS's own work, not another workspace's",
    );
    const cards = all.filter((n) => n.type === "li" && n.props["data-testid"] === "extracted-video").map((n) => n.props.id);
    assert.deepEqual([...cards].sort(), [dl1, dl2, archivedDl].map((x) => `video-${x}`).sort());
    const links = all.filter((n) => n.type === "a").map((n) => String(n.props.href));
    assert.ok(links.includes("https://www.instagram.com/reel/C43j_8NJFfP/"), "the original post is linked");
    const count = all.find((n) => n.props["data-testid"] === "extracted-count");
    assert.ok(count && JSON.stringify(count.props.children).includes("3 videos"), "the count is every status, as the Overview tile counts");
  });

  await check("no <video> in the server markup: each card's LazyVideo mounts it near the screen", async () => {
    const all = nodes(await Page({ searchParams: Promise.resolve({}) }));
    assert.equal(all.filter((n) => n.type === "video").length, 0, "the page itself draws no <video>");
    // This harness has no object store, so no media signs and every card says so;
    // where a URL does sign, the card hands it to LazyVideo and nothing else.
    assert.equal(all.filter((n) => n.type === LazyVideo).length, 0);
    const unsigned = all.filter((n) => n.type === "p" && /couldn't be loaded/.test(String(n.props.children)));
    assert.equal(unsigned.length, 3);
    assert.match(
      code("app/founders/marketing/extracted/page.tsx"),
      /\{t\.playbackUrl \? \(\s*<LazyVideo src=\{t\.playbackUrl\}/,
      "a signed video goes through LazyVideo",
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/extracted-videos.render.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(r.status, 0, `render failed: ${r.stderr}`);
    const { markup } = JSON.parse(r.stdout) as { markup: string };
    assert.doesNotMatch(markup, /<video/, "before the observer fires, nothing is fetched");
    assert.match(markup, /data-lazy-video="waiting"/);
    const src = code("components/founders/LazyVideo.tsx");
    assert.match(src, /new IntersectionObserver\(/);
    assert.match(src, /preload="metadata"/);
  });

  await check("?video=<id> shows that video first and the grid never repeats it; another brand's id pins nothing", async () => {
    const pinned = nodes(await Page({ searchParams: Promise.resolve({ video: dl2 }) }));
    const first = pinned.filter((n) => n.props["data-testid"] === "extracted-pinned").map((n) => n.props.id);
    assert.deepEqual(first, [`video-${dl2}`]);
    const grid = pinned.filter((n) => n.props["data-testid"] === "extracted-video").map((n) => n.props.id);
    assert.ok(!grid.includes(`video-${dl2}`), "not twice");
    const none = nodes(await Page({ searchParams: Promise.resolve({ video: own }) }));
    assert.equal(none.filter((n) => n.props["data-testid"] === "extracted-pinned").length, 0, "an OASIS asset is not an extracted video");
    const junk = nodes(await Page({ searchParams: Promise.resolve({ video: "../etc" }) }));
    assert.equal(junk.filter((n) => n.props["data-testid"] === "extracted-pinned").length, 0);
  });

  await check("the page gates itself, and Delete asks first on the card, then never sits on Deleting...", () => {
    assert.match(code("app/founders/marketing/extracted/page.tsx"), /resolveFounder\(\)/);
    const actions = code("components/founders/ExtractedVideoActions.tsx");
    assert.doesNotMatch(actions, /\bconfirm\(/, "the viewer has no confirm() dialog");
    assert.match(actions, /method: "DELETE"/);
    assert.match(actions, /\/download`/);
    assert.match(actions, /finally \{\s*setBusy\(false\);/, "busy always clears");
    assert.match(actions, /role="alert"/);
    assert.match(actions, /the stored file is kept/);
  });

  // -- 3. the ways in, and no verdicts -----------------------------------------
  await check("Content Tools, the Overview tile and the asset page lead to Extracted videos; the list is reached from inside the Video extractor", () => {
    const section = code("components/tools/ToolsSection.tsx");
    assert.match(section, /assetHrefPrefix = "\/founders\/marketing\/extracted\?video="/);
    assert.match(section, /extractedVideosHref = "\/founders\/marketing\/extracted"/, "the card's history drawer leads to the whole list");
    const grid = code("components/tools/ToolGrid.tsx");
    assert.doesNotMatch(grid, />\s*Open in Library\s*</);
    const format = code("components/tools/tool-grid-format.ts");
    assert.match(format, /OPEN_EXTRACTED = "Open in Extracted videos"/);
    assert.ok((grid.match(/\{OPEN_EXTRACTED\}/g) || []).length >= 2, "the finished run and the history drawer both open the video");
    assert.match(format, /ALL_EXTRACTED = "All extracted videos"/);
    assert.match(grid, /\{ALL_EXTRACTED\}/, "the drawer leads to the whole list");
    // CC, 2026-10-25: Extracted videos is no longer a tab; the page leads back into the tool.
    assert.match(code("lib/tools/registry.ts"), /Extracted videos, inside this tool/);
    assert.match(code("app/founders/marketing/extracted/page.tsx"), /tools#video-extractor/, "the list links back to the Video extractor card");
    assert.match(grid, /VIDEO_CARD_ID = "video-extractor"/);
    const overview = code("app/founders/marketing/page.tsx");
    assert.match(overview, /href=\{extracted \? EXTRACTED_ROOT : `\/founders\/marketing\/library\?group=\$\{g\.key\}`\}/);
    assert.match(overview, /label=\{extracted \? EXTRACTED_LABEL : g\.label\}/);
    const detail = code("app/founders/marketing/asset/[id]/page.tsx");
    assert.match(detail, /asset\.brand_slug === EXTRACTED_BRAND_SLUG \? \(\s*<Link\s+href=\{extractedHref\(asset\.id\)\}/);
  });

  await check("an extracted video's asset page has no verdicts and no posting card; the PATCH route refuses a verdict", async () => {
    const detail = code("app/founders/marketing/asset/[id]/page.tsx");
    assert.match(detail, /asset\.brand_slug === EXTRACTED_BRAND_SLUG \? \(\s*<Card title="Extracted video"[\s\S]*?<ExtractedVideoActions[\s\S]*?\) : \(\s*<Card title="Status"/);
    assert.match(detail, /asset\.brand_slug === EXTRACTED_BRAND_SLUG \? null : isOwnBrand\(asset\.brand_slug\)/);
    await login(USERS.cc);
    const route = await import("../app/api/founders/marketing/assets/[id]/route");
    for (const status of ["approved", "in_review", "archived", "rejected"]) {
      const res = await route.PATCH(
        new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ status }), headers: { "content-type": "application/json" } }),
        { params: Promise.resolve({ id: dl1 }) },
      );
      assert.equal(res.status, 409, status);
      assert.equal(((await res.json()) as { error: string }).error, "not_reviewable");
    }
    const row = await db.execute({ sql: "SELECT status FROM marketing_asset WHERE id = ?", args: [dl1] });
    assert.equal(row.rows[0].status, "draft", "untouched");
    // OASIS's own work still takes a verdict.
    const ok = await route.PATCH(
      new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ status: "approved" }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ id: own }) },
    );
    assert.equal(ok.status, 200);
    await db.execute({ sql: "UPDATE marketing_asset SET status = 'draft' WHERE id = ?", args: [own] });
  });

  // -- 4. the Library never holds them (real rows) ------------------------------
  await check("no Library tab's grid, counts, audience/pack facets or author facet ever includes a downloads row", async () => {
    // A download sharing an OASIS row's pack and audience, by an author found nowhere else.
    const sneaky = id(6);
    await seedAsset(db, {
      id: sneaky, tenant: OASIS, brand: "downloads", title: "Download with pack meta",
      meta: { icp_segment: "icp_sales_bottleneck", pack_id: "icp_sales_bottleneck_b2b-operator_leads-left-waiting" },
      author: "someone-else@example.com",
    });
    const personal = id(7);
    const client = id(8);
    await seedAsset(db, { id: personal, tenant: OASIS, brand: "conaugh", title: "Personal" });
    await seedAsset(db, { id: client, tenant: OASIS, brand: "warner", title: "Client work" });
    await db.execute({
      sql: "UPDATE marketing_asset SET meta = ? WHERE id = ?",
      args: [JSON.stringify({ icp_segment: "icp_sales_bottleneck", pack_id: "icp_sales_bottleneck_b2b-operator_leads-left-waiting" }), own],
    });
    const downloads = new Set([dl1, dl2, archivedDl, sneaky]);
    const core = await import("../lib/founders-marketing-core");
    const q = await import("../lib/founders/marketing-queries");
    for (const g of core.LIBRARY_BRAND_GROUPS) {
      for (const lifecycle of [undefined, ...core.LIFECYCLE]) {
        const page = await q.getMarketingAssets(OASIS, { group: g.key, lifecycle, pageSize: 200 });
        const leaked = page.assets.filter((a) => downloads.has(a.id)).map((a) => a.id);
        assert.deepEqual(leaked, [], `${g.key} ${lifecycle ?? "default"} grid`);
      }
      const lc = await q.getLifecycleCounts(OASIS, g.key);
      const total = Object.values(lc.counts).reduce((n, v) => n + v, 0);
      const real = (await q.getMarketingAssets(OASIS, { group: g.key, allStatuses: true, pageSize: 200 })).total;
      assert.equal(total, real, `${g.key} lifecycle counts are its own rows`);
      const meta = await q.getMetaFacets(OASIS, { group: g.key });
      const packCount = meta.packs.reduce((n, p) => n + p.count, 0);
      assert.equal(packCount, g.key === "oasis-ai" ? 1 : 0, `${g.key} pack facet counts no download`);
    }
    const tabs = await q.getBrandTabCounts(OASIS);
    assert.equal(tabs.counts["oasis-ai"], 1);
    assert.equal(tabs.counts.conaugh, 1);
    assert.equal(tabs.counts.clients, 1, "Clients is the residual, and downloads stay claimed out of it");
    const facets = await q.getMarketingFacets(OASIS);
    assert.ok(!facets.authors.some((a) => a.email === "someone-else@example.com"), "a download's author is no Library author");
    assert.ok(facets.authors.some((a) => a.email === "conaugh@oasisai.work"));
  });

  await check("the Library draws no Downloads tab; the slug stays claimed; an old link redirects with its page", async () => {
    const core = await import("../lib/founders-marketing-core");
    assert.deepEqual(core.LIBRARY_BRAND_GROUPS.map((g) => g.key), ["oasis-ai", "conaugh", "clients"]);
    assert.equal(core.isLibraryBrandGroupKey("downloads"), false);
    assert.equal(core.isLibraryBrandGroupKey("oasis-ai"), true);
    assert.equal(core.brandGroupFor("downloads"), "downloads");
    assert.ok(core.claimedBrandSlugs().includes("downloads"));
    const page = code("app/founders/marketing/library/page.tsx");
    assert.match(page, /LIBRARY_BRAND_GROUPS\.map\(\(g\) =>/, "the tab bar draws the Library's own tabs");
    assert.doesNotMatch(page, /[^_]BRAND_GROUPS\.map\(/, "and nowhere the full list");
    assert.match(page, /isLibraryBrandGroupKey\(sp\.group\)/);
    await login(USERS.cc);
    const Library = (await import("../app/founders/marketing/library/page")).default;
    await assert.rejects(
      () => Library({ searchParams: Promise.resolve({ group: "downloads" }) }),
      (e: Error) => e.message === "NEXT_REDIRECT;/founders/marketing/extracted",
    );
    await assert.rejects(
      () => Library({ searchParams: Promise.resolve({ group: "downloads", page: "3" }) }),
      (e: Error) => e.message === "NEXT_REDIRECT;/founders/marketing/extracted?page=3",
    );
  });

  // -- 5. one slug; ASCII --------------------------------------------------------
  await check("one slug everywhere: the brand group, this page's constant and the runner's INSERT", async () => {
    const core = await import("../lib/founders-marketing-core");
    const group = core.BRAND_GROUPS.find((g) => g.key === lib.EXTRACTED_BRAND_GROUP);
    assert.deepEqual(group?.slugs, [lib.EXTRACTED_BRAND_SLUG]);
    assert.match(code("lib/tools/runner-handlers.ts"), new RegExp(`'${lib.EXTRACTED_BRAND_SLUG}', 'Downloads', 'video'`));
  });

  await check("the files this page added are plain ASCII", () => {
    for (const f of [
      "app/founders/marketing/extracted/page.tsx",
      "components/founders/ExtractedVideoActions.tsx",
      "components/founders/LazyVideo.tsx",
      "lib/founders/extracted-videos.ts",
      "tests/extracted-videos.test.ts",
      "tests/extracted-videos.render.ts",
    ]) {
      const bad = [...code(f)].findIndex((c) => c.charCodeAt(0) > 127);
      assert.equal(bad, -1, `${f} has a non-ASCII character at ${bad}`);
    }
  });

  finish("extracted-videos");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
