/**
 * The Library reads, signs and links ONE PAGE at a time.
 * Run: node --conditions=react-server --import tsx tests/library-paging.test.ts
 *
 * WHY THIS EXISTS
 * CC, 2026-10-01: "clicking on the library takes way too long... after
 * minutes, it's not in the preferred iPhone view". The server answered in about
 * a second (Workers Logs); the minutes were in the browser. The page read up to
 * 200 assets, SIGNED media for every one, and rendered every tile at once, and
 * each tile then fetched its media. Measured locally with the production
 * composition (100 assets): 160 media requests and 65-95 MB before the page
 * settled.
 *
 * WHAT IS PINNED
 *  1. The page's data path (loadLibraryPage, the only thing the page calls)
 *     signs media for at most LIBRARY_PAGE_SIZE assets - counted at the signer,
 *     against real SQLite through the real query builder.
 *  2. Pages are stable: every asset appears on exactly one page, even when
 *     created_at ties across a page boundary, and a page past the end lands on
 *     the last page instead of an empty grid.
 *  3. The pager keeps the filters: a page link carries the tab, channel, brand,
 *     lifecycle and view it was drawn under; a filter change goes back to page 1.
 *  4. Counts come from COUNT queries, and the lifecycle pills and the grid use
 *     ONE predicate that agrees with lifecycleOf() for every status x
 *     published_at pair (they had drifted: "Needs review 50" over a grid of 21).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  getBrandTabCounts,
  getLifecycleCounts,
  getMarketingAssets,
  loadLibraryPage,
} from "../lib/founders/marketing-queries";
import {
  LIBRARY_PAGE_SIZE,
  LIFECYCLE,
  STATUSES,
  libraryHref,
  libraryPageCount,
  libraryPagerItems,
  lifecycleOf,
  parseLibraryPage,
  parseLibraryView,
  type LibraryState,
} from "../lib/founders-marketing-core";

const ROOT = join(__dirname, "..");
const T = "tenant-library";
const OTHER = "tenant-other";

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(e as Error).message.split("\n").join("\n       ")}`);
  }
}

type Seed = {
  id: string;
  tenant?: string;
  brand?: string;
  status?: string;
  published?: boolean;
  kind: "video" | "carousel" | "image" | "copy";
  created: string;
  channel?: string;
  author?: string;
};

async function makeDb() {
  const raw = createClient({ url: ":memory:" });
  await raw.executeMultiple(`
    CREATE TABLE marketing_asset (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL,
      track TEXT GENERATED ALWAYS AS (CASE channel WHEN 'organic-instagram' THEN 'organic'
        WHEN 'organic-tiktok' THEN 'organic' WHEN 'paid-meta' THEN 'paid' ELSE NULL END) STORED,
      format TEXT NOT NULL, aspect TEXT, status TEXT NOT NULL DEFAULT 'draft', hook TEXT, body TEXT, cta TEXT,
      landing_url TEXT, campaign TEXT, duration_s TEXT, author_agent TEXT NOT NULL DEFAULT 'human', source TEXT,
      scheduled_for TEXT, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      brand_slug TEXT NOT NULL DEFAULT 'oasis-ai', brand_name TEXT NOT NULL DEFAULT 'OASIS AI',
      platforms TEXT NOT NULL DEFAULT '[]', asset_type TEXT NOT NULL DEFAULT 'single_image',
      media_urls TEXT NOT NULL DEFAULT '[]', slide_count INTEGER NOT NULL DEFAULT 1,
      author_email TEXT NOT NULL DEFAULT 'conaugh@oasisai.work'
    );
    CREATE TABLE marketing_asset_media (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL,
      storage_bucket TEXT NOT NULL DEFAULT 'marketing-media', storage_path TEXT NOT NULL,
      mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, label TEXT
    );
    CREATE TABLE marketing_review (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, decision TEXT NOT NULL,
      acted_on_at TEXT
    );
  `);
  return { raw, db: createTursoPostgrest(raw) as never };
}

async function seed(raw: ReturnType<typeof createClient>, rows: Seed[]) {
  for (const r of rows) {
    const tenant = r.tenant ?? T;
    const slides = r.kind === "carousel" ? [1, 2, 3, 4].map((n) => `${tenant}/${r.id}/slide_${n}.png`) : [];
    const format = r.kind === "carousel" ? "image" : r.kind;
    const assetType = r.kind === "carousel" ? "carousel" : r.kind === "video" ? "video" : "single_image";
    await raw.execute({
      sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, aspect, status, hook, author_agent,
              published_at, created_at, updated_at, brand_slug, brand_name, asset_type, media_urls, slide_count, author_email)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.id, tenant, `Asset ${r.id}`, r.channel ?? "organic-instagram", format,
        r.kind === "video" ? "9:16" : "4:5", r.status ?? "in_review", `Hook ${r.id}`, r.author ?? "maven",
        r.published ? r.created : null, r.created, r.created, r.brand ?? "oasis-ai", r.brand ?? "OASIS AI",
        assetType, JSON.stringify(slides), Math.max(1, slides.length), "conaugh@oasisai.work"],
    });
    const media: Array<[string, string, number, number]> = [];
    if (r.kind === "video") {
      media.push(["video", `${tenant}/${r.id}/reel.mp4`, 1080, 1920]);
      media.push(["poster", `${tenant}/${r.id}/poster.jpg`, 1080, 1920]);
    } else if (r.kind === "carousel") {
      for (const p of slides) media.push(["image", p, 1080, 1350]);
    } else if (r.kind === "image") {
      media.push(["image", `${tenant}/${r.id}/card.png`, 1080, 1350]);
    }
    for (const [kind, path, w, h] of media) {
      await raw.execute({
        sql: `INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_bucket, storage_path, width, height)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [`m-${path}`, tenant, r.id, kind, "marketing-media", path, w, h],
      });
    }
  }
}

/** A signer that records every object it is asked to sign. */
function countingSigner() {
  const refs: Array<{ bucket: string; path: string }> = [];
  const sign = async (rs: Array<{ bucket: string; path: string }>) => {
    refs.push(...rs);
    return new Map(rs.map((r) => [`${r.bucket}\n${r.path}`, `https://signed.test/${r.path}`]));
  };
  /** Distinct assets whose media was signed: the path is <tenant>/<asset>/<file>. */
  const assets = () => new Set(refs.map((r) => r.path.split("/")[1]));
  return { sign, refs, assets };
}

const pad = (n: number) => String(n).padStart(3, "0");

async function main() {
  const { raw, db } = await makeDb();

  // 100 working assets on the OASIS tab, the production composition on
  // 2026-10-01 (66 carousels, 33 videos, 1 single image). Ten pairs share a
  // created_at second ACROSS what would be page boundaries, the case that
  // repeats or skips a row when the order is not total.
  const kinds: Seed["kind"][] = [
    ...Array<Seed["kind"]>(66).fill("carousel"),
    ...Array<Seed["kind"]>(33).fill("video"),
    "image",
  ];
  const rows: Seed[] = kinds.map((kind, i) => {
    const second = i < 20 ? Math.floor(i / 2) : i; // 0,0,1,1,...,9,9 then unique
    return {
      id: `a${pad(i)}`,
      kind,
      status: i % 5 === 0 ? "scheduled" : i % 7 === 0 ? "published" : "in_review",
      published: i % 7 === 0 || i % 11 === 0,
      created: new Date(Date.UTC(2026, 8, 1) + second * 1000).toISOString(),
    };
  });
  // Three archived on the same tab: hidden from the default view, counted in Archived.
  rows.push(
    { id: "x001", kind: "video", status: "archived", created: "2026-09-02T00:00:00.000Z" },
    { id: "x002", kind: "image", status: "rejected", published: true, created: "2026-09-02T00:00:01.000Z" },
    { id: "x003", kind: "carousel", status: "archived", published: true, created: "2026-09-02T00:00:02.000Z" },
  );
  // Other tabs, and a second tenant that must never appear.
  rows.push(
    { id: "c001", kind: "video", brand: "warner", created: "2026-09-03T00:00:00.000Z", channel: "organic-tiktok" },
    { id: "c002", kind: "video", brand: "warner", created: "2026-09-03T00:00:01.000Z" },
    { id: "c003", kind: "video", brand: "arthrisil", created: "2026-09-03T00:00:02.000Z" },
    { id: "c004", kind: "copy", brand: "blyss", status: "draft", created: "2026-09-03T00:00:03.000Z", author: "marketing-agent" },
    { id: "p001", kind: "image", brand: "conaugh", status: "archived", published: true, created: "2026-09-04T00:00:00.000Z" },
    { id: "o001", kind: "video", tenant: OTHER, created: "2026-09-05T00:00:00.000Z" },
  );
  await seed(raw, rows);

  console.log("library-paging");

  await check("the page signs media for at most LIBRARY_PAGE_SIZE assets (counted at the signer)", async () => {
    assert.equal(LIBRARY_PAGE_SIZE, 24, "the page size the spec asked for");
    const s = countingSigner();
    const page = await loadLibraryPage(T, {}, { db, sign: s.sign });
    assert.equal(page.total, 100, "the default view counts every working OASIS asset, archived excluded");
    assert.equal(page.tiles.length, LIBRARY_PAGE_SIZE);
    assert.ok(s.assets().size <= LIBRARY_PAGE_SIZE, `signed media for ${s.assets().size} assets`);
    assert.deepEqual(
      [...s.assets()].sort(),
      page.tiles.map((t) => t.asset.id).sort(),
      "exactly the assets on the page were signed - nothing from page 2",
    );
    // Every tile got what it needs from that one signing pass.
    for (const t of page.tiles) {
      if (t.asset.asset_type === "video") {
        assert.ok(t.playbackUrl && t.posterUrl, `${t.asset.id}: video and poster signed`);
        assert.equal(t.mediaW, 1080);
      }
      if (t.asset.asset_type === "carousel") {
        assert.equal(t.slideUrls.length, 4, `${t.asset.id}: all four slides, in order`);
        assert.ok(t.slideUrls[0].endsWith("slide_1.png") && t.slideUrls[3].endsWith("slide_4.png"));
      }
    }
  });

  await check("the reader returns one page, not the tab: 24 rows of 100, media for those rows only", async () => {
    const got = await getMarketingAssets(T, {}, db);
    assert.equal(got.assets.length, 24);
    assert.equal(got.total, 100);
    assert.equal(got.page, 1);
    const withMedia = got.assets.filter((a) => (a.media || []).length > 0).length;
    assert.equal(withMedia, 24, "media is attached to the page's rows");
  });

  await check("pages 1..5 hold every asset exactly once, ties on created_at included", async () => {
    const seen: string[] = [];
    const pages = libraryPageCount(100);
    assert.equal(pages, 5);
    for (let p = 1; p <= pages; p++) {
      const got = await getMarketingAssets(T, { page: p }, db);
      assert.equal(got.page, p);
      seen.push(...got.assets.map((a) => a.id));
    }
    assert.equal(seen.length, 100, "4 full pages and a last page of 4");
    assert.equal(new Set(seen).size, 100, "no asset repeats across pages");
  });

  await check("a page past the end lands on the last page, not an empty grid", async () => {
    const s = countingSigner();
    const got = await loadLibraryPage(T, { page: 99 }, { db, sign: s.sign });
    assert.equal(got.page, 5);
    assert.equal(got.tiles.length, 4);
    assert.ok(s.assets().size <= 4);
  });

  await check("filters page too: the Clients tab, the brand sub-filter, a lifecycle, the second tenant", async () => {
    const clients = await getMarketingAssets(T, { group: "clients" }, db);
    assert.equal(clients.total, 4);
    assert.deepEqual(clients.assets.map((a) => a.id).sort(), ["c001", "c002", "c003", "c004"]);
    const warner = await getMarketingAssets(T, { group: "clients", brand: "warner" }, db);
    assert.equal(warner.total, 2);
    const archived = await getMarketingAssets(T, { lifecycle: "archived" }, db);
    assert.deepEqual(archived.assets.map((a) => a.id).sort(), ["x001", "x002", "x003"]);
    const other = await getMarketingAssets(OTHER, {}, db);
    assert.deepEqual(other.assets.map((a) => a.id), ["o001"], "tenant scoping survives paging");
  });

  await check("chat- and agent-made rows are on the page like any other (author_agent is not a filter)", async () => {
    const s = countingSigner();
    const got = await loadLibraryPage(T, { group: "clients" }, { db, sign: s.sign });
    const copy = got.tiles.find((t) => t.asset.id === "c004");
    assert.ok(copy, "a copy-only asset drafted by an agent is listed");
    assert.equal(copy!.asset.author_agent, "marketing-agent");
    assert.equal(copy!.playbackUrl, null);
    assert.equal(copy!.posterUrl, null, "no media, nothing signed - the tile draws its copy instead");
  });

  await check("tab counts are COUNT queries over every status, one per tab", async () => {
    const tabs = await getBrandTabCounts(T, db);
    assert.equal(tabs.degraded, false);
    assert.deepEqual(tabs.counts, { "oasis-ai": 103, conaugh: 1, music: 0, clients: 4 });
  });

  await check("lifecycle pills and the grid agree, and both agree with lifecycleOf()", async () => {
    const lc = await getLifecycleCounts(T, "oasis-ai", db);
    assert.equal(lc.degraded, false);
    const oasisRows = rows.filter((r) => (r.tenant ?? T) === T && (r.brand ?? "oasis-ai") === "oasis-ai");
    for (const l of LIFECYCLE) {
      const truth = oasisRows.filter((r) => lifecycleOf({ status: r.status ?? "in_review", published_at: r.published ? "x" : null }) === l).length;
      const grid = await getMarketingAssets(T, { lifecycle: l }, db);
      assert.equal(lc.counts[l], truth, `pill ${l}`);
      assert.equal(grid.total, truth, `grid ${l}`);
    }
  });

  await check("the SQL lifecycle predicate matches lifecycleOf() for every status x published_at pair", async () => {
    const { raw: r2, db: d2 } = await makeDb();
    const pairs: Seed[] = [];
    for (const st of STATUSES) {
      for (const pub of [false, true]) {
        pairs.push({ id: `${st}-${pub ? "p" : "n"}`, kind: "copy", status: st, published: pub, created: "2026-09-01T00:00:00.000Z" });
      }
    }
    await seed(r2, pairs);
    for (const l of LIFECYCLE) {
      const want = pairs
        .filter((p) => lifecycleOf({ status: p.status!, published_at: p.published ? "x" : null }) === l)
        .map((p) => p.id)
        .sort();
      const got = await getMarketingAssets(T, { lifecycle: l, pageSize: 100 }, d2);
      assert.deepEqual(got.assets.map((a) => a.id).sort(), want, `bucket ${l}`);
    }
    const lc = await getLifecycleCounts(T, "oasis-ai", d2);
    const sum = LIFECYCLE.reduce((n, l) => n + lc.counts[l], 0);
    assert.equal(sum, pairs.length, "every row lands in exactly one bucket");
  });

  await check("page links keep every filter; a filter change goes back to page 1", () => {
    const here: LibraryState = {
      group: "clients", channel: "organic-tiktok", brand: "warner", lifecycle: "needs_review", view: "grid",
    };
    const p3 = new URL(libraryHref(here, { page: 3 }), "https://x").searchParams;
    assert.equal(p3.get("page"), "3");
    assert.equal(p3.get("group"), "clients");
    assert.equal(p3.get("channel"), "organic-tiktok");
    assert.equal(p3.get("brand"), "warner");
    assert.equal(p3.get("lifecycle"), "needs_review");
    assert.equal(p3.get("view"), "grid");
    const back = new URL(libraryHref({ ...here }, { lifecycle: "archived" }), "https://x").searchParams;
    assert.equal(back.get("page"), null, "a new filter starts at page 1");
    assert.equal(back.get("group"), "clients");
    assert.equal(back.get("view"), "grid", "the view survives a filter change");
    assert.equal(libraryHref({ group: "oasis-ai", view: "phone" }, { page: 1 }), "/founders/marketing/library");
    assert.equal(parseLibraryPage("3"), 3);
    assert.equal(parseLibraryPage("0"), 1);
    assert.equal(parseLibraryPage("-2"), 1);
    assert.equal(parseLibraryPage("abc"), 1);
    assert.equal(parseLibraryPage(undefined), 1);
    assert.equal(parseLibraryView("grid"), "grid");
    assert.equal(parseLibraryView("anything"), "phone", "the phone view is the default");
    assert.deepEqual(libraryPagerItems(1, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(libraryPagerItems(10, 40), [1, "gap", 8, 9, 10, 11, 12, "gap", 40]);
  });

  await check("the page reaches media ONLY through loadLibraryPage (no second signing path)", () => {
    const page = readFileSync(join(ROOT, "app/founders/marketing/library/page.tsx"), "utf8");
    assert.match(page, /loadLibraryPage\(founder\.tenantId,/);
    assert.doesNotMatch(page, /signMediaUrls|createSignedUrl/, "the page must not sign anything itself");
    assert.doesNotMatch(page, /getMarketingAssets\(/, "rows come through the paged loader only");
    assert.match(page, /pageHref\(currentPage \+ 1\)/, "the pager links through libraryHref");
  });

  console.log(`\nlibrary-paging: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
