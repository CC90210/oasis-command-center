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
 *  3. The pager keeps the filters: a page link carries the tab, track, channel,
 *     brand, lifecycle and view it was drawn under; a filter change goes back to
 *     page 1. Every filter narrows the grid AND its total (?track=paid once lit
 *     the Paid pill over every track's assets). The asset page links back to
 *     the exact view it was opened from, through a validated ?from=.
 *  4. Counts come from COUNT queries - proved from the SQL that ran, not from
 *     matching numbers - and the lifecycle pills and the grid use ONE predicate
 *     that agrees with lifecycleOf() for every status x published_at pair (they
 *     had drifted: "Needs review 50" over a grid of 21). Needs review is draft or
 *     in review, not yet posted: a scheduled asset is in no lifecycle bucket.
 *  5. Studio's "awaiting your verdict" line is the Needs review pill's own COUNT,
 *     so it agrees with the grid it links to.
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
  BRAND_GROUPS,
  DEFAULT_BRAND_GROUP,
  LIBRARY_PAGE_SIZE,
  LIFECYCLE,
  STATUSES,
  assetHref,
  libraryHref,
  libraryReturnPath,
  libraryPageCount,
  libraryPagerItems,
  lifecycleOf,
  parseLibraryPage,
  parseLibraryView,
  type LibraryState,
  type Lifecycle,
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

/**
 * The same database, with every statement the query builder sends recorded.
 * Matching numbers do not prove a COUNT ran - reading every row and counting in
 * JS gives the same numbers - so the count checks assert on the SQL itself.
 */
function recorded(raw: ReturnType<typeof createClient>) {
  const statements: string[] = [];
  const client = new Proxy(raw, {
    get(target, prop) {
      if (prop === "execute") {
        return (stmt: string | { sql: string }) => {
          statements.push(typeof stmt === "string" ? stmt : stmt.sql);
          return target.execute(stmt as never);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: createTursoPostgrest(client) as never, statements };
}

/** A COUNT statement on the asset table, as lib/turso-postgrest.ts compiles one. */
const COUNT_SQL = /^SELECT count\(\*\) AS n FROM "marketing_asset"(?: WHERE |$)/;

/**
 * The bucket an asset belongs in: lifecycleOf(), except that only a draft or
 * in-review asset is waiting on a verdict. A scheduled asset (or a status
 * 'published' row with no published_at) is in NO bucket - it keeps its own place
 * on Studio's stage tiles and in the All view.
 */
function bucketOf(status: string, published: boolean): Lifecycle | null {
  const l = lifecycleOf({ status, published_at: published ? "x" : null });
  if (l === "needs_review" && status !== "draft" && status !== "in_review") return null;
  return l;
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

  await check("a track filter narrows the grid AND its total (?track=paid shows only paid assets)", async () => {
    const { raw: r3, db: d3 } = await makeDb();
    await seed(r3, [
      { id: "paid1", kind: "video", channel: "paid-meta", created: "2026-09-06T00:00:00.000Z" },
      { id: "org2", kind: "image", channel: "organic-tiktok", created: "2026-09-06T00:00:01.000Z" },
      { id: "paid2", kind: "carousel", channel: "paid-meta", created: "2026-09-06T00:00:02.000Z" },
      { id: "org1", kind: "video", channel: "organic-instagram", created: "2026-09-06T00:00:03.000Z" },
    ]);
    const paid = await getMarketingAssets(T, { track: "paid" }, d3);
    assert.deepEqual(paid.assets.map((a) => a.id), ["paid2", "paid1"], "only the paid rows, newest first");
    assert.equal(paid.total, 2, "the total behind the pager counts paid rows only");
    const organic = await getMarketingAssets(T, { track: "organic" }, d3);
    assert.deepEqual(organic.assets.map((a) => a.id), ["org1", "org2"]);
    assert.equal(organic.total, 2);
    // Through the page's own data path too, signing included.
    const s = countingSigner();
    const page = await loadLibraryPage(T, { track: "paid" }, { db: d3, sign: s.sign });
    assert.deepEqual(page.tiles.map((t) => t.asset.id), ["paid2", "paid1"]);
    assert.equal(page.total, 2);
    assert.deepEqual([...s.assets()].sort(), ["paid1", "paid2"], "nothing from another track is signed");
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

  await check("tab counts are COUNT queries over every status, one per tab (the SQL that ran)", async () => {
    const rec = recorded(raw);
    const tabs = await getBrandTabCounts(T, rec.db);
    assert.equal(tabs.degraded, false);
    assert.deepEqual(tabs.counts, { "oasis-ai": 103, conaugh: 1, music: 0, clients: 4 });
    assert.equal(rec.statements.length, BRAND_GROUPS.length, `one statement per tab, ran:\n${rec.statements.join("\n")}`);
    for (const sql of rec.statements) assert.match(sql, COUNT_SQL, `a row read where a COUNT belongs: ${sql}`);
  });

  await check("lifecycle pills are COUNT queries and agree with the grid and with the buckets", async () => {
    const rec = recorded(raw);
    const lc = await getLifecycleCounts(T, "oasis-ai", rec.db);
    assert.equal(lc.degraded, false);
    assert.equal(rec.statements.length, LIFECYCLE.length, `one statement per pill, ran:\n${rec.statements.join("\n")}`);
    for (const sql of rec.statements) assert.match(sql, COUNT_SQL, `a row read where a COUNT belongs: ${sql}`);
    const oasisRows = rows.filter((r) => (r.tenant ?? T) === T && (r.brand ?? "oasis-ai") === "oasis-ai");
    for (const l of LIFECYCLE) {
      const truth = oasisRows.filter((r) => bucketOf(r.status ?? "in_review", !!r.published) === l).length;
      const grid = await getMarketingAssets(T, { lifecycle: l }, db);
      assert.equal(lc.counts[l], truth, `pill ${l}`);
      assert.equal(grid.total, truth, `grid ${l}`);
    }
  });

  await check("Needs review is draft or in review, not yet posted: scheduled assets keep their own place", async () => {
    const oasisRows = rows.filter((r) => (r.tenant ?? T) === T && (r.brand ?? "oasis-ai") === "oasis-ai");
    const scheduled = oasisRows.filter((r) => r.status === "scheduled" && !r.published).map((r) => r.id);
    assert.ok(scheduled.length >= 5, `the seed holds scheduled, unposted assets (${scheduled.length})`);
    const needs = await getMarketingAssets(T, { lifecycle: "needs_review", pageSize: 200 }, db);
    const inNeeds = new Set(needs.assets.map((a) => a.id));
    for (const id of scheduled) assert.ok(!inNeeds.has(id), `${id} is scheduled, not waiting on a verdict`);
    for (const a of needs.assets) {
      assert.ok(a.status === "draft" || a.status === "in_review", `${a.id} is ${a.status}`);
      assert.equal(a.published_at, null, `${a.id} has been posted`);
    }
    // ...and they are not lost: the All view and Studio's ?status=scheduled tile show them.
    const all = await getMarketingAssets(T, { pageSize: 200 }, db);
    const inAll = new Set(all.assets.map((a) => a.id));
    for (const id of scheduled) assert.ok(inAll.has(id), `${id} is in the All view`);
    const stage = await getMarketingAssets(T, { status: "scheduled", pageSize: 200 }, db);
    for (const id of scheduled) assert.ok(stage.assets.some((a) => a.id === id), `${id} is on the Scheduled stage`);
    // "All N" is every asset in the tab - the tab's own COUNT - not the sum of
    // the four pills, which leaves the scheduled assets out.
    const lc = await getLifecycleCounts(T, "oasis-ai", db);
    const tabs = await getBrandTabCounts(T, db);
    const pills = LIFECYCLE.reduce((n, l) => n + lc.counts[l], 0);
    assert.equal(tabs.counts["oasis-ai"], pills + scheduled.length, "the tab holds the bucketed assets and the scheduled ones");
    const library = readFileSync(join(ROOT, "app/founders/marketing/library/page.tsx"), "utf8");
    assert.match(
      library,
      /const lifecycleTotal = tabCounts\.degraded \? 0 : tabCounts\.counts\[group\];/,
      "the All pill reads the tab's COUNT",
    );
  });

  await check("the SQL lifecycle predicate matches the buckets for every status x published_at pair", async () => {
    const { raw: r2, db: d2 } = await makeDb();
    const pairs: Seed[] = [];
    for (const st of STATUSES) {
      for (const pub of [false, true]) {
        pairs.push({ id: `${st}-${pub ? "p" : "n"}`, kind: "copy", status: st, published: pub, created: "2026-09-01T00:00:00.000Z" });
      }
    }
    await seed(r2, pairs);
    const placed = new Map<string, Lifecycle>();
    for (const l of LIFECYCLE) {
      const want = pairs
        .filter((p) => bucketOf(p.status!, !!p.published) === l)
        .map((p) => p.id)
        .sort();
      const got = await getMarketingAssets(T, { lifecycle: l, pageSize: 100 }, d2);
      assert.deepEqual(got.assets.map((a) => a.id).sort(), want, `bucket ${l}`);
      for (const a of got.assets) {
        assert.ok(!placed.has(a.id), `${a.id} is in both ${placed.get(a.id)} and ${l}`);
        placed.set(a.id, l);
      }
    }
    // Exactly the undated scheduled / published rows sit outside every bucket.
    const unplaced = pairs.filter((p) => !placed.has(p.id)).map((p) => p.id).sort();
    assert.deepEqual(unplaced, ["published-n", "scheduled-n"]);
    const lc = await getLifecycleCounts(T, "oasis-ai", d2);
    const sum = LIFECYCLE.reduce((n, l) => n + lc.counts[l], 0);
    assert.equal(sum, pairs.length - unplaced.length, "the pills count exactly the bucketed rows, once each");
  });

  await check("Studio's \"awaiting your verdict\" is the Needs review pill's own COUNT, and its link opens that grid", async () => {
    const studio = readFileSync(join(ROOT, "app/founders/marketing/page.tsx"), "utf8");
    assert.match(
      studio,
      /getLifecycleCounts\(founder\.tenantId, DEFAULT_BRAND_GROUP\)/,
      "Studio reads the Library's own pill counts for the OASIS tab",
    );
    assert.match(
      studio,
      /const awaitingVerdict = lifecycle\.degraded \? 0 : lifecycle\.counts\.needs_review;/,
      "the line is the Needs review count (and no number at all when that read failed)",
    );
    const studioCode = studio.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(studioCode, /by_status\.in_review/, "not a second count over a different set of assets");
    assert.match(studio, /href="\/founders\/marketing\/library\?lifecycle=needs_review"/, "the line opens that grid");
    assert.ok(
      studio.indexOf("lifecycle.degraded || summary.degraded ?") >= 0 &&
        studio.indexOf("lifecycle.degraded || summary.degraded ?") < studio.indexOf('headline="Nothing waiting on you"'),
      "a failed verdict count renders the degraded panel before any 'Nothing waiting on you'",
    );
    // On the data: the default tab IS where the link lands.
    assert.equal(DEFAULT_BRAND_GROUP, "oasis-ai");
    const lc = await getLifecycleCounts(T, DEFAULT_BRAND_GROUP, db);
    const grid = await getMarketingAssets(T, { lifecycle: "needs_review" }, db);
    assert.equal(lc.counts.needs_review, grid.total);
  });

  await check("page links keep every filter; a filter change goes back to page 1", () => {
    const here: LibraryState = {
      group: "clients", track: "organic", channel: "organic-tiktok", brand: "warner", lifecycle: "needs_review", view: "grid",
    };
    const p3 = new URL(libraryHref(here, { page: 3 }), "https://x").searchParams;
    assert.equal(p3.get("page"), "3");
    assert.equal(p3.get("group"), "clients");
    assert.equal(p3.get("track"), "organic", "the track survives a page turn");
    assert.equal(p3.get("channel"), "organic-tiktok");
    assert.equal(p3.get("brand"), "warner");
    assert.equal(p3.get("lifecycle"), "needs_review");
    assert.equal(p3.get("view"), "grid");
    const back = new URL(libraryHref({ ...here }, { lifecycle: "archived" }), "https://x").searchParams;
    assert.equal(back.get("page"), null, "a new filter starts at page 1");
    assert.equal(back.get("group"), "clients");
    assert.equal(back.get("view"), "grid", "the view survives a filter change");
    assert.equal(back.get("track"), "organic", "and so does the track");
    assert.equal(
      libraryHref({ group: "oasis-ai", track: "paid", view: "phone" }, { page: 2 }),
      "/founders/marketing/library?track=paid&page=2",
      "page 2 of the Paid filter is page 2 of the Paid filter",
    );
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

  await check("the asset page's Library link goes back to the view the asset was opened from (validated ?from=)", () => {
    const view = "/founders/marketing/library?group=clients&track=paid&lifecycle=needs_review&view=grid&page=3";
    assert.equal(libraryReturnPath(view), view, "tab, filters, view and page all survive");
    assert.equal(
      assetHref("a1", view),
      `/founders/marketing/asset/a1?from=${encodeURIComponent(view)}`,
      "the tile's link carries the view",
    );
    assert.equal(assetHref("a1", "/founders/marketing/library"), "/founders/marketing/asset/a1", "no view, no from");
    assert.equal(assetHref("a1"), "/founders/marketing/asset/a1");
    // A browser hands `from` back, so it is validated, never trusted.
    for (const hostile of [
      "https://evil.example/founders/marketing/library?page=2",
      "//evil.example/founders/marketing/library",
      "\\\\evil.example/founders/marketing/library",
      "javascript:alert(1)",
      "/founders/marketing/library/../../settings",
      "/founders/marketing/libraryX?view=grid&page=2",
      "/founders/finances?view=grid&page=2",
      "https://evil.example/founders/marketing/library?view=grid",
      "",
      undefined,
      42,
      "x".repeat(5000),
    ]) {
      assert.equal(libraryReturnPath(hostile), "/founders/marketing/library", `accepted ${String(hostile).slice(0, 60)}`);
    }
    assert.equal(
      libraryReturnPath("/founders/marketing/library?page=2&next=https://evil.example#frag"),
      "/founders/marketing/library?page=2",
      "only the Library's own parameters are kept",
    );
    // The wiring: the Library hands each tile its own view; the asset page
    // validates `from`, links back with it, and keeps it across preview toggles.
    const library = readFileSync(join(ROOT, "app/founders/marketing/library/page.tsx"), "utf8");
    assert.match(library, /const thisView = pageHref\(currentPage\);/);
    assert.match(library, /returnTo=\{thisView\}/);
    const detail = readFileSync(join(ROOT, "app/founders/marketing/asset/[id]/page.tsx"), "utf8");
    assert.match(detail, /const libraryBack = libraryReturnPath\(sp\.from\);/);
    assert.match(detail, /<Link\s+href=\{libraryBack\}/, "the Library link uses the validated view");
    assert.match(detail, /q\.set\("from", libraryBack\)/, "a preview toggle keeps the way back");
  });

  await check("the page reaches media ONLY through loadLibraryPage (no second signing path)", () => {
    const page = readFileSync(join(ROOT, "app/founders/marketing/library/page.tsx"), "utf8");
    assert.match(page, /loadLibraryPage\(founder\.tenantId,/);
    assert.doesNotMatch(page, /signMediaUrls|createSignedUrl/, "the page must not sign anything itself");
    assert.doesNotMatch(page, /getMarketingAssets\(/, "rows come through the paged loader only");
    assert.match(page, /pageHref\(currentPage \+ 1\)/, "the pager links through libraryHref");
    // The page signs at most LIBRARY_PAGE_SIZE because it asks for the default
    // page: an override in the call would quietly undo the cap the checks above
    // measure through the loader.
    const call = /loadLibraryPage\(founder\.tenantId,\s*(\{[\s\S]*?\})\s*\)/.exec(page);
    assert.ok(call, "the page's loadLibraryPage call");
    assert.doesNotMatch(call![1], /pageSize/, `the page overrides the page size: ${call![1]}`);
    assert.match(call![1], /\btrack\b/, "and it passes the track filter on");
  });

  console.log(`\nlibrary-paging: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
