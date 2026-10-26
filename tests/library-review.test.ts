/**
 * library-review.test.ts - the Content Library's audience and pack filters, the
 * hook comparison, and the review verdicts (Approve / Request changes /
 * Archive / Delete).
 * Run: node --conditions=react-server --import tsx tests/library-review.test.ts
 *
 * WHY THIS EXISTS. CC (2026-10-08, through Maven): the Command Center is the only
 * place he reviews creative, and a pack of hook variants has to be watched side
 * by side and judged there, not in a folder.
 *
 * WHAT IS PINNED
 *  1. Audience (meta.icp_segment) and pack (meta.pack_id) are filters the grid,
 *     its total and the URL all honour; their options are counted for the view
 *     the grid is in; an id this app does not know shows as itself; a bad value
 *     in the URL is ignored; a malformed meta fails loudly, not as "everything".
 *  2. Choosing a pack draws the hook comparison: every variant, in variant order,
 *     with its opening line, style and video, 16:9, preload="none".
 *  3. Approve changes the status and NOTHING else - no schedule, no post, no
 *     publish intent, no other column. (Asked for by CC: posting stays with the
 *     marketing agent's scheduler and the spend gate.)
 *  4. Request changes: gated exactly like Approve, Archive and Delete (anyone
 *     outside the founders portal gets 404, and the marketing seat, which can
 *     pass those verdicts, can send back too); a note is required (refused
 *     before anything is read or written); only in the founder's own workspace;
 *     only while the asset is in review; the note lands in marketing_review
 *     where the marketing agent reads it, the asset goes to draft, and a lost
 *     race or a failed write leaves nothing half-done.
 *  5. Delete is the existing hard delete of rows: it never touches a stored
 *     file, and the button asks first, inside the tile.
 *  6. No blurb QA rejected, no non-ASCII character in what this change added.
 *
 * Real routes, real sessions, a local libSQL file (tests/_offer-pages-harness.ts).
 * The client components are drawn in full React by tests/library-review.render.ts.
 */
import {
  CLIENT_A,
  OASIS,
  USERS,
  check,
  finish,
  login,
  setupOfferDatabase,
} from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  DEGRADED_META_FACETS,
  getMarketingAssets,
  getMarketingFacets,
  getMetaFacets,
  loadLibraryPage,
  loadPackComparison,
} from "../lib/founders/marketing-queries";
import {
  ICP_SEGMENTS,
  PACK_COMPARE_CAP,
  assetMetaView,
  hookStyleLabel,
  hookVariantCards,
  hookVariantLabel,
  hookVariantNumber,
  icpSegmentLabel,
  isPackId,
  isSegmentId,
  packLabel,
  parseAssetMeta,
  sortByHookVariant,
  tallyMetaFacets,
} from "../lib/founders/library-meta";
import {
  REQUEST_CHANGES_NOTE_MAX,
  checkRequestChangesBody,
  requestChanges,
} from "../lib/founders/request-changes";
import { LIBRARY_PAGE_SIZE, LIFECYCLE, STATUSES, libraryHref, libraryReturnPath, type LibraryState } from "../lib/founders-marketing-core";

const ROOT = join(__dirname, "..");
const T = "tenant-review";
const OTHER = "tenant-elsewhere";
const PACK_A = "icp_sales_bottleneck_b2b-operator_leads-left-waiting";
const PACK_B = "icp_ops_bottleneck_b2b-operator_everything-routes-through-you";
// Two packs bigger than one Library page (LIBRARY_PAGE_SIZE = 24): one the comparison
// can read whole, one bigger than the comparison's own cap (PACK_COMPARE_CAP = 60).
const PACK_MID = "icp_ecommerce_shopify-owner_returns-flood";
const PACK_HUGE = "icp_ecommerce_shopify-owner_every-angle";
const MID = 30;
const HUGE = 70;

process.env.FOUNDERS_TENANT_IDS = `${OASIS},${CLIENT_A}`;

// -- the Library's tables, in the columns the readers and routes use ----------------
const DDL = `
  CREATE TABLE marketing_asset (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'paid-meta',
    track TEXT GENERATED ALWAYS AS (CASE channel WHEN 'organic-instagram' THEN 'organic'
      WHEN 'organic-tiktok' THEN 'organic' WHEN 'paid-meta' THEN 'paid' ELSE NULL END) STORED,
    format TEXT NOT NULL DEFAULT 'video', aspect TEXT, status TEXT NOT NULL DEFAULT 'draft', hook TEXT, body TEXT,
    cta TEXT, landing_url TEXT, campaign TEXT, duration_s REAL, author_agent TEXT NOT NULL DEFAULT 'human',
    source TEXT, scheduled_for TEXT, published_at TEXT, external_id TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, brand_slug TEXT NOT NULL DEFAULT 'oasis-ai', brand_name TEXT NOT NULL DEFAULT 'OASIS AI',
    platforms TEXT NOT NULL DEFAULT '[]', asset_type TEXT NOT NULL DEFAULT 'video', media_urls TEXT NOT NULL DEFAULT '[]',
    slide_count INTEGER NOT NULL DEFAULT 1, author_email TEXT NOT NULL DEFAULT 'conaugh@oasisai.work',
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE marketing_asset_media (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL,
    storage_bucket TEXT NOT NULL DEFAULT 'marketing-media', storage_path TEXT NOT NULL,
    mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, label TEXT
  );
  CREATE TABLE marketing_review (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve','approve_with_changes','request_changes','reject','comment')),
    note TEXT, reviewer TEXT NOT NULL DEFAULT 'conaugh', reviewer_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), acted_on_at TEXT,
    CONSTRAINT marketing_review_reason_required CHECK (decision IN ('approve','comment') OR COALESCE(trim(note), '') <> '')
  );
  CREATE TABLE marketing_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), actor TEXT NOT NULL, verb TEXT NOT NULL,
    asset_id TEXT, detail TEXT
  );
  CREATE TABLE marketing_publish_intent (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL,
    platforms TEXT, requested_by TEXT, note TEXT, state TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;

type Seed = {
  id: string;
  tenant?: string;
  status?: string;
  brand?: string;
  created: string;
  title?: string;
  hook?: string | null;
  published?: boolean;
  meta?: Record<string, unknown> | string;
  video?: boolean;
};

async function seed(c: Client, rows: Seed[]) {
  for (const r of rows) {
    const tenant = r.tenant ?? T;
    await c.execute({
      sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, aspect, status, hook, published_at,
              created_at, updated_at, brand_slug, brand_name, asset_type, meta)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        r.id, tenant, r.title ?? `Cut ${r.id}`, "paid-meta", "video", "16:9", r.status ?? "in_review", r.hook ?? null,
        r.published ? r.created : null, r.created, r.created, r.brand ?? "oasis-ai", r.brand ?? "OASIS AI", "video",
        typeof r.meta === "string" ? r.meta : JSON.stringify(r.meta ?? {}),
      ],
    });
    if (r.video !== false) {
      await c.execute({
        sql: `INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path, width, height) VALUES (?,?,?,?,?,?,?)`,
        args: [`m-${r.id}`, tenant, r.id, "video", `${tenant}/${r.id}/cut.mp4`, 1920, 1080],
      });
    }
  }
}

const pack = (pack_id: string, segment: string, n: number, extra: Record<string, unknown> = {}) => ({
  icp_segment: segment,
  pack_id,
  hook: `Opening line ${n}`,
  hook_variant: `variant_${n}`,
  hook_style: n % 2 ? "question" : "pattern_interrupt",
  ...extra,
});

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();

async function main() {
  console.log("library-review");
  // This suite must never reach a real service whatever the developer's shell
  // holds: with no Supabase configured, Turso mode hands back a stub that throws
  // on storage, so media signing fails closed instead of calling out.
  for (const k of ["BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "BRAVO_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    delete process.env[k];
  }

  // ===================================================================== 1. pure
  await check("the segment list: the four known ids with short labels; an unknown id reads as itself", () => {
    assert.deepEqual(
      ICP_SEGMENTS.map((s) => s.id),
      ["icp_ops_bottleneck", "icp_sales_bottleneck", "icp_ecommerce", "brand_vsl"],
    );
    assert.equal(icpSegmentLabel("icp_sales_bottleneck"), "Sales bottleneck");
    assert.equal(icpSegmentLabel("brand_vsl"), "Brand VSL");
    assert.equal(icpSegmentLabel("icp_brand_new_thing"), "icp_brand_new_thing", "a segment Maven registered yesterday shows its id");
    // The registry the ids come from is mirrored, not read: this app cannot see the CMO repo at runtime.
    const shipped = [
      "lib/founders/library-meta.ts",
      "lib/founders/request-changes.ts",
      "components/founders/HookCompare.tsx",
      "components/founders/MetaBadges.tsx",
      "components/founders/AssetActions.tsx",
      "components/founders/marketing-shared.tsx",
      "app/founders/marketing/library/page.tsx",
      "app/api/founders/marketing/assets/[id]/request-changes/route.ts",
    ];
    for (const f of shipped) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // QA rejected these two blurbs as unsourced claims; neither may be a label anywhere.
      assert.doesNotMatch(src, /\$60k Employee|Instant AI SDR|\$60K/i, `${f} carries a blurb QA rejected`);
    }
  });

  await check("ids from the URL are validated before they reach a pill or a query", () => {
    for (const ok of ["icp_ops_bottleneck", "brand_vsl", "icp_x1"]) assert.ok(isSegmentId(ok), ok);
    for (const bad of ["", "Icp_Ops", "icp ops", "icp-ops", "1icp", "icp_ops';--", "x".repeat(65), undefined, 5, null, ["icp"]]) {
      assert.ok(!isSegmentId(bad), String(bad));
    }
    for (const ok of [PACK_A, PACK_B, "pack1"]) assert.ok(isPackId(ok), ok);
    for (const bad of ["", "Pack", "a b", "a/b", "a;b", "-a", "x".repeat(161), undefined, 7]) assert.ok(!isPackId(bad), String(bad));
  });

  await check("meta is read from an object, from JSON text, and never throws", () => {
    assert.deepEqual(parseAssetMeta({ a: 1 }), { a: 1 });
    assert.deepEqual(parseAssetMeta('{"a":1}'), { a: 1 });
    for (const bad of ["not json", "[1]", "null", null, undefined, 4, [1], '"str"']) assert.deepEqual(parseAssetMeta(bad), {}, String(bad));
    const m = assetMetaView({
      icp_segment: " icp_ecommerce ", pack_id: PACK_A, hook: "  Why so slow?  ", hook_variant: "variant_2",
      hook_style: "question", offer_slug: "fleet", burned_captions: true,
    });
    assert.deepEqual(m, {
      icpSegment: "icp_ecommerce", packId: PACK_A, hook: "Why so slow?", hookVariant: "variant_2",
      hookStyle: "question", offerSlug: "fleet", burnedCaptions: true,
    });
    // burned_captions is read the way the offer pages read it: true or 1, nothing looser.
    for (const [v, want] of [[true, true], [1, true], ["true", false], [0, false], [false, false], [undefined, false], ["yes", false]] as const) {
      assert.equal(assetMetaView({ burned_captions: v }).burnedCaptions, want, String(v));
    }
    assert.equal(assetMetaView({ hook: 5, offer_slug: "", icp_segment: {} }).hook, null, "a non-string is no hook");
    assert.equal(assetMetaView({ offer_slug: "  " }).offerSlug, null);
  });

  await check("variants: numbered labels, numbered order, unnumbered after (stable), a style as a phrase", () => {
    assert.equal(hookVariantNumber("variant_3"), 3);
    assert.equal(hookVariantNumber("variant_x"), null);
    assert.equal(hookVariantNumber(null), null);
    assert.equal(hookVariantLabel("variant_3"), "Variant 3");
    assert.equal(hookVariantLabel("angle_b"), "angle b");
    assert.equal(hookVariantLabel(null), "Variant");
    assert.equal(hookStyleLabel("pattern_interrupt"), "pattern interrupt");
    const rows = [
      { id: "u1", v: null }, { id: "v6", v: "variant_6" }, { id: "v2", v: "variant_2" }, { id: "u2", v: "weird" }, { id: "v10", v: "variant_10" },
    ];
    assert.deepEqual(sortByHookVariant(rows, (r) => r.v).map((r) => r.id), ["v2", "v6", "v10", "u1", "u2"]);
  });

  await check("a pack id reads as avatar and concept; anything else reads as itself", () => {
    assert.equal(packLabel(PACK_A), "b2b operator - leads left waiting");
    assert.equal(packLabel(PACK_B), "b2b operator - everything routes through you");
    assert.equal(packLabel("icp_ecommerce_shopify_returns"), "shopify - returns");
    assert.equal(packLabel("brand_vsl_founder_second-shift"), "founder - second shift", "the brand segment's packs read the same way");
    assert.equal(packLabel("brand_vsl"), "brand_vsl");
    assert.equal(packLabel("spring-launch"), "spring-launch");
    assert.equal(packLabel("icp_ops"), "icp_ops");
  });

  await check("facet tally: known segments first in registry order, then by size; junk ids dropped; a pack remembers its audience", () => {
    const t = tallyMetaFacets([
      { icp_segment: "icp_new_thing", pack_id: null }, { icp_segment: "icp_new_thing" },
      { icp_segment: "icp_ecommerce", pack_id: "p1" }, { icp_segment: "icp_sales_bottleneck", pack_id: PACK_A },
      { icp_segment: "icp_sales_bottleneck", pack_id: PACK_A }, { icp_segment: "icp_ops_bottleneck", pack_id: null },
      { icp_segment: "Not A Segment!", pack_id: "Not A Pack!" }, { icp_segment: null, pack_id: PACK_A },
      { icp_segment: 7, pack_id: {} }, {},
    ]);
    assert.deepEqual(t.segments, [
      { id: "icp_ops_bottleneck", count: 1 }, { id: "icp_sales_bottleneck", count: 2 }, { id: "icp_ecommerce", count: 1 },
      { id: "icp_new_thing", count: 2 },
    ]);
    assert.deepEqual(t.packs, [
      { id: PACK_A, icp: "icp_sales_bottleneck", count: 3 }, { id: "p1", icp: "icp_ecommerce", count: 1 },
    ]);
  });

  await check("the cards: variant order, meta.hook then the hook column then the title, a status this app does not know is a draft", () => {
    const cards = hookVariantCards(
      [
        { asset: { id: "c", title: "Third", status: "in_review", hook: "  Column hook  ", meta: { hook_variant: "variant_3" } }, playbackUrl: "u3", posterUrl: null },
        { asset: { id: "a", title: "First", status: "approved", hook: null, meta: JSON.stringify({ hook: "Meta hook", hook_variant: "variant_1", hook_style: "story" }), duration_s: "25.1" }, playbackUrl: null, posterUrl: "p1" },
        { asset: { id: "b", title: "Second", status: "mystery", meta: { hook_variant: "variant_2", offer_slug: "fleet", burned_captions: 1 } }, playbackUrl: "u2", posterUrl: null },
        { asset: { id: "d", title: "No meta at all", status: "archived", published_at: "2026-10-02T00:00:00Z", meta: null }, playbackUrl: null, posterUrl: null },
      ],
      (id) => `/asset/${id}`,
    );
    assert.deepEqual(cards.map((c) => c.id), ["a", "b", "c", "d"]);
    assert.deepEqual(cards.map((c) => c.hook), ["Meta hook", "Second", "Column hook", "No meta at all"]);
    assert.deepEqual(cards.map((c) => c.variantLabel), ["Variant 1", "Variant 2", "Variant 3", "Variant"]);
    assert.equal(cards[0].hookStyle, "story");
    assert.equal(cards[0].durationS, 25.1);
    assert.equal(cards[1].status, "draft");
    assert.equal(cards[1].lifecycle, "needs_review");
    assert.equal(cards[1].offerSlug, "fleet");
    assert.equal(cards[1].burnedCaptions, true);
    assert.equal(cards[3].lifecycle, "archived");
    assert.equal(cards[2].href, "/asset/c");
  });

  await check("the filters live in the URL: kept across a page turn and a pill, cleared with a tab switch, a new audience drops the pack", () => {
    const here: LibraryState = { group: "oasis-ai", icp: "icp_sales_bottleneck", pack: PACK_A, lifecycle: "needs_review", view: "phone" };
    const q = (change: Parameters<typeof libraryHref>[1]) => new URL(libraryHref(here, change), "https://x").searchParams;
    assert.equal(q({ page: 2 }).get("icp"), "icp_sales_bottleneck");
    assert.equal(q({ page: 2 }).get("pack"), PACK_A);
    assert.equal(q({ lifecycle: "approved" }).get("pack"), PACK_A, "a lifecycle pill keeps the pack");
    assert.equal(q({ pack: null }).get("pack"), null);
    assert.equal(q({ pack: null }).get("icp"), "icp_sales_bottleneck", "All packs keeps the audience");
    assert.equal(q({ icp: null, pack: null }).get("icp"), null);
    assert.equal(q({ icp: "icp_ecommerce" }).get("pack"), null, "a pack belongs to one audience");
    assert.equal(q({ icp: "icp_ecommerce", pack: "p1" }).get("pack"), "p1", "unless the same link names one");
    assert.equal(q({ group: "clients" }).get("icp"), null, "a tab switch clears both, as it clears the brand");
    assert.equal(q({ group: "clients" }).get("pack"), null);
    assert.equal(
      libraryHref({ group: "oasis-ai", icp: "brand_vsl", view: "phone" }, {}),
      "/founders/marketing/library?icp=brand_vsl",
    );
    // The asset page's way back keeps them.
    const view = `/founders/marketing/library?icp=icp_sales_bottleneck&pack=${PACK_A}&lifecycle=needs_review`;
    assert.equal(libraryReturnPath(view), view);
    assert.equal(libraryReturnPath("/founders/marketing/library?icp=x&evil=1"), "/founders/marketing/library?icp=x");
  });

  await check("the note rule: a word is required, the cap is 2000, anything but an object body is refused", () => {
    assert.deepEqual(checkRequestChangesBody({ note: "  slow start  " }), { ok: true, note: "slow start" });
    for (const body of [{}, { note: "" }, { note: "  \n\t " }, { note: 5 }, { note: null }, { note: ["x"] }]) {
      assert.deepEqual(checkRequestChangesBody(body), { ok: false, error: "note_required" }, JSON.stringify(body));
    }
    for (const body of [null, "x", 5, [], undefined]) {
      assert.deepEqual(checkRequestChangesBody(body), { ok: false, error: "invalid_body" }, JSON.stringify(body));
    }
    assert.equal(REQUEST_CHANGES_NOTE_MAX, 2000);
    assert.equal(checkRequestChangesBody({ note: "x".repeat(2000) }).ok, true);
    assert.deepEqual(checkRequestChangesBody({ note: "x".repeat(2001) }), { ok: false, error: "note_too_long" });
    assert.equal(checkRequestChangesBody({ note: ` ${"x".repeat(2000)} ` }).ok, true, "the cap is on the trimmed note");
  });

  // ============================================================== 2. the readers
  const mem = createClient({ url: ":memory:" });
  await mem.executeMultiple(DDL);
  const memDb = createTursoPostgrest(mem) as never;
  await seed(mem, [
    // PACK_A: six variants, created newest-first so the comparison has to sort them.
    ...[1, 2, 3, 4, 5, 6].map((n): Seed => ({
      id: `a${n}`, created: day(10 - n), status: n === 6 ? "approved" : "in_review", meta: pack(PACK_A, "icp_sales_bottleneck", n),
    })),
    { id: "a7", created: day(1), status: "archived", meta: pack(PACK_A, "icp_sales_bottleneck", 7) },
    { id: "b1", created: day(11), meta: pack(PACK_B, "icp_ops_bottleneck", 1) },
    { id: "b2", created: day(12), status: "approved", meta: pack(PACK_B, "icp_ops_bottleneck", 2) },
    { id: "e1", created: day(13), meta: { icp_segment: "icp_ecommerce" } },
    { id: "v1", created: day(14), meta: { icp_segment: "brand_vsl", offer_slug: "ai-audit", burned_captions: true }, published: true, status: "published" },
    { id: "n1", created: day(15), meta: {} },
    { id: "j1", created: day(16), meta: { icp_segment: "Not A Segment!", pack_id: "bad id" } },
    { id: "w1", created: day(17), brand: "warner", meta: pack("icp_sales_bottleneck_x_y", "icp_sales_bottleneck", 1) },
    { id: "o1", tenant: OTHER, created: day(18), meta: pack(PACK_A, "icp_sales_bottleneck", 1) },
  ]);

  await check("the audience filter narrows the grid AND its total, inside the tenant", async () => {
    const sales = await getMarketingAssets(T, { icp: "icp_sales_bottleneck", pageSize: 50 }, memDb);
    assert.deepEqual(sales.assets.map((a) => a.id).sort(), ["a1", "a2", "a3", "a4", "a5", "a6"], "archived a7 and the Clients tab's w1 are not in the default OASIS view");
    assert.equal(sales.total, 6);
    const vsl = await getMarketingAssets(T, { icp: "brand_vsl" }, memDb);
    assert.deepEqual(vsl.assets.map((a) => a.id), ["v1"]);
    assert.equal((await getMarketingAssets(T, { icp: "icp_never_registered" }, memDb)).total, 0);
    const other = await getMarketingAssets(OTHER, { icp: "icp_sales_bottleneck" }, memDb);
    assert.deepEqual(other.assets.map((a) => a.id), ["o1"], "another workspace's assets are never mixed in");
    const tab = await getMarketingAssets(T, { group: "clients", icp: "icp_sales_bottleneck" }, memDb);
    assert.deepEqual(tab.assets.map((a) => a.id), ["w1"], "the brand tab still bounds the audience");
  });

  await check("the pack filter composes with audience and lifecycle, and the rows carry their meta", async () => {
    const all = await getMarketingAssets(T, { pack: PACK_A, pageSize: 50 }, memDb);
    assert.equal(all.total, 6);
    for (const a of all.assets) assert.equal(assetMetaView(a.meta).packId, PACK_A, `${a.id}: meta rides along with the row`);
    assert.equal((await getMarketingAssets(T, { icp: "icp_sales_bottleneck", pack: PACK_A }, memDb)).total, 6);
    assert.equal((await getMarketingAssets(T, { icp: "icp_ops_bottleneck", pack: PACK_A }, memDb)).total, 0, "a pack under the wrong audience is nothing, not everything");
    const review = await getMarketingAssets(T, { pack: PACK_A, lifecycle: "needs_review", pageSize: 50 }, memDb);
    assert.deepEqual(review.assets.map((a) => a.id).sort(), ["a1", "a2", "a3", "a4", "a5"]);
    const archived = await getMarketingAssets(T, { pack: PACK_A, lifecycle: "archived" }, memDb);
    assert.deepEqual(archived.assets.map((a) => a.id), ["a7"]);
    // Through the page's own data path, media signed for the pack's page only.
    const signed: string[] = [];
    const page = await loadLibraryPage(T, { pack: PACK_A }, {
      db: memDb,
      sign: async (refs) => {
        signed.push(...refs.map((r) => r.path.split("/")[1]));
        return new Map(refs.map((r) => [`${r.bucket}\n${r.path}`, `https://signed.test/${r.path}`]));
      },
    });
    assert.equal(page.total, 6);
    assert.deepEqual([...new Set(signed)].sort(), ["a1", "a2", "a3", "a4", "a5", "a6"]);
    assert.ok(page.tiles.every((t) => t.playbackUrl), "every variant has its video");
  });

  await check("the options: counted for the view the grid is in - the tab, and archived only when asked for", async () => {
    const f = await getMetaFacets(T, { group: "oasis-ai" }, memDb);
    assert.equal(f.degraded, false);
    assert.deepEqual(f.segments, [
      { id: "icp_ops_bottleneck", count: 2 }, { id: "icp_sales_bottleneck", count: 6 }, { id: "icp_ecommerce", count: 1 }, { id: "brand_vsl", count: 1 },
    ], "archived a7, the Clients tab, the other workspace and the junk ids are all out");
    assert.deepEqual(f.packs, [
      { id: PACK_A, icp: "icp_sales_bottleneck", count: 6 }, { id: PACK_B, icp: "icp_ops_bottleneck", count: 2 },
    ]);
    // Each count is what clicking it shows.
    for (const s of f.segments) assert.equal((await getMarketingAssets(T, { icp: s.id }, memDb)).total, s.count, s.id);
    for (const p of f.packs) assert.equal((await getMarketingAssets(T, { pack: p.id }, memDb)).total, p.count, p.id);
    const archived = await getMetaFacets(T, { group: "oasis-ai", lifecycle: "archived" }, memDb);
    assert.deepEqual(archived.packs, [{ id: PACK_A, icp: "icp_sales_bottleneck", count: 1 }]);
    const clients = await getMetaFacets(T, { group: "clients" }, memDb);
    assert.deepEqual(clients.segments, [{ id: "icp_sales_bottleneck", count: 1 }]);
    const other = await getMetaFacets(OTHER, { group: "oasis-ai" }, memDb);
    assert.deepEqual(other.packs, [{ id: PACK_A, icp: "icp_sales_bottleneck", count: 1 }]);
    assert.deepEqual((await getMetaFacets("", { group: "oasis-ai" }, memDb)).segments, []);
  });

  await check("the options are the grid's own counts under EVERY stage: a Studio ?status= link, each lifecycle, both at once, and the default view", async () => {
    const stageDb = createClient({ url: ":memory:" });
    await stageDb.executeMultiple(DDL);
    // A different number of assets per stage and audience, so a count that ignores
    // the stage cannot match the grid by luck.
    const rows: Seed[] = [];
    STATUSES.forEach((status, i) => {
      for (let n = 0; n <= i; n++) {
        rows.push({ id: `st-${status}-sales-${n}`, status, created: day(i * 10 + n), meta: pack(PACK_A, "icp_sales_bottleneck", n + 1) });
      }
      rows.push({ id: `st-${status}-ops`, status, created: day(i * 10 + 9), meta: pack(PACK_B, "icp_ops_bottleneck", 1) });
    });
    // Posted: approved AND dated, so the lifecycle buckets and the statuses differ.
    rows.push({ id: "st-posted", status: "approved", published: true, created: day(90), meta: pack(PACK_A, "icp_sales_bottleneck", 9) });
    await seed(stageDb, rows);
    const db = createTursoPostgrest(stageDb) as never;

    type View = { status?: (typeof STATUSES)[number]; lifecycle?: (typeof LIFECYCLE)[number] };
    const views: Array<[string, View]> = [
      ["the default view", {}],
      ...STATUSES.map((s): [string, View] => [`?status=${s}`, { status: s }]),
      ...LIFECYCLE.map((l): [string, View] => [`?lifecycle=${l}`, { lifecycle: l }]),
      ["?status=draft&lifecycle=archived (the lifecycle wins)", { status: "draft", lifecycle: "archived" }],
    ];
    for (const [name, view] of views) {
      const f = await getMetaFacets(T, { group: "oasis-ai", ...view }, db);
      assert.equal(f.degraded, false, name);
      const all = await getMarketingAssets(T, { ...view, pageSize: 500 }, db);
      assert.ok(all.total > 0, `${name}: the view holds assets, or this proves nothing`);
      let bySegment = 0;
      for (const s of f.segments) {
        const grid = await getMarketingAssets(T, { ...view, icp: s.id, pageSize: 500 }, db);
        assert.equal(grid.total, s.count, `${name}: the ${s.id} pill says ${s.count} and its grid holds ${grid.total}`);
        bySegment += s.count;
      }
      let byPack = 0;
      for (const p of f.packs) {
        const grid = await getMarketingAssets(T, { ...view, pack: p.id, pageSize: 500 }, db);
        assert.equal(grid.total, p.count, `${name}: the ${p.id} pill says ${p.count} and its grid holds ${grid.total}`);
        byPack += p.count;
      }
      // Every asset in the view carries one audience and one pack: the pills add up to the whole grid.
      assert.equal(bySegment, all.total, `${name}: the audience pills cover the grid, no more and no less`);
      assert.equal(byPack, all.total, `${name}: so do the pack pills`);

      // The brand sub-pills and the By row count the same view (2026-10-26): they
      // used to count every status, archived included, above a grid that hides them.
      const mf = await getMarketingFacets(T, { group: "oasis-ai", ...view }, db);
      assert.equal(mf.degraded, false, name);
      assert.equal(mf.brands.reduce((n, b) => n + b.count, 0), all.total, `${name}: the brand pills add up to the grid`);
      for (const a of mf.authors) {
        const grid = await getMarketingAssets(T, { ...view, author: a.email, pageSize: 500 }, db);
        assert.equal(grid.total, a.count, `${name}: the ${a.email} pill says ${a.count} and its grid holds ${grid.total}`);
      }
      assert.equal(mf.authors.reduce((n, a) => n + a.count, 0), all.total, `${name}: so do the author pills`);
    }
    const everyStatus = await getMarketingFacets(T, undefined, db);
    const defaultView = await getMarketingFacets(T, { group: "oasis-ai" }, db);
    assert.ok(
      everyStatus.brands[0].count > defaultView.brands[0].count,
      "without a view it still spans every status (no caller is left relying on that but the shape stays); the default view hides archived and rejected",
    );

    // Absolute, as well as in agreement: the grid and the options could drift TOGETHER.
    const at = (s: (typeof STATUSES)[number]) => STATUSES.indexOf(s);
    const approved = await getMetaFacets(T, { group: "oasis-ai", status: "approved" }, db);
    assert.deepEqual(
      approved.segments,
      [{ id: "icp_ops_bottleneck", count: 1 }, { id: "icp_sales_bottleneck", count: at("approved") + 1 + 1 }],
      "?status=approved: the approved assets (one is also posted), not every stage's",
    );
    assert.deepEqual(approved.packs.map((p) => p.count), [at("approved") + 2, 1]);
    const scheduled = await getMetaFacets(T, { group: "oasis-ai", status: "scheduled" }, db);
    assert.deepEqual(scheduled.segments, [{ id: "icp_ops_bottleneck", count: 1 }, { id: "icp_sales_bottleneck", count: at("scheduled") + 1 }]);
    const archived = await getMetaFacets(T, { group: "oasis-ai", status: "archived" }, db);
    assert.deepEqual(archived.segments, [{ id: "icp_ops_bottleneck", count: 1 }, { id: "icp_sales_bottleneck", count: at("archived") + 1 }], "an explicit ?status=archived shows archived");
    const def = await getMetaFacets(T, { group: "oasis-ai" }, db);
    const everySales = STATUSES.reduce((n, _s, i) => n + i + 1, 0) + 1;
    assert.equal(
      def.segments.find((s) => s.id === "icp_sales_bottleneck")!.count,
      everySales - (at("archived") + 1) - (at("rejected") + 1),
      "the default view hides archived and rejected",
    );
  });

  await check("a chosen pack is read WHOLE: more than a Library page, up to the cap, never paged, and the total says what was left out", async () => {
    const bigDb = createClient({ url: ":memory:" });
    await bigDb.executeMultiple(DDL);
    const rows: Seed[] = [];
    // Variant n is created on day n, and the Library pages newest first: on a Library
    // page of 24, variants 1 to 6 of the 30 land on page two.
    for (let n = 1; n <= MID; n++) rows.push({ id: `mid-${n}`, created: day(n), meta: pack(PACK_MID, "icp_ecommerce", n) });
    for (let n = 1; n <= HUGE; n++) rows.push({ id: `huge-${n}`, created: day(n), meta: pack(PACK_HUGE, "icp_ecommerce", n) });
    rows.push({ id: "mid-elsewhere", tenant: OTHER, created: day(1), meta: pack(PACK_MID, "icp_ecommerce", 1) });
    await seed(bigDb, rows);
    const db = createTursoPostgrest(bigDb) as never;
    const signedAssets = new Set<string>();
    const deps = {
      db,
      sign: async (refs: Array<{ bucket: string; path: string }>) => {
        for (const r of refs) signedAssets.add(r.path.split("/")[1]);
        return new Map(refs.map((r) => [`${r.bucket}\n${r.path}`, `https://signed.test/${r.path}`]));
      },
    };
    const cardsOf = (page: Awaited<ReturnType<typeof loadPackComparison>>) =>
      hookVariantCards(page.tiles, (id) => `/asset/${id}`);

    assert.equal(PACK_COMPARE_CAP, 60);
    assert.ok(PACK_COMPARE_CAP > LIBRARY_PAGE_SIZE && MID > LIBRARY_PAGE_SIZE && HUGE > PACK_COMPARE_CAP, "the fixtures straddle the page size and the cap");

    // What the Library's own page would do to it: the first 24, newest first.
    const cut = await loadLibraryPage(T, { pack: PACK_MID }, deps);
    assert.equal(cut.tiles.length, LIBRARY_PAGE_SIZE);
    assert.equal(cut.total, MID);
    assert.equal(cardsOf(cut)[0].variantLabel,`Variant ${MID - LIBRARY_PAGE_SIZE + 1}`, "a paged read starts mid-pack: variants 1 to 6 are on page two");

    // The comparison: the whole 30, one page, sorted from variant 1.
    signedAssets.clear();
    const mid = await loadPackComparison(T, { pack: PACK_MID }, deps);
    assert.equal(mid.tiles.length, MID, "every variant of a pack bigger than a Library page");
    assert.equal(mid.total, MID, "another workspace's copy of the pack is not counted");
    assert.equal(mid.page, 1);
    assert.deepEqual(cardsOf(mid).map((c) => c.variantLabel), Array.from({ length: MID }, (_, i) => `Variant ${i + 1}`));
    assert.equal(signedAssets.size, MID, "media is signed for the pack and nothing else");

    // A pack bigger than the cap: the newest PACK_COMPARE_CAP, with the total saying there are more.
    signedAssets.clear();
    const huge = await loadPackComparison(T, { pack: PACK_HUGE }, deps);
    assert.equal(huge.tiles.length, PACK_COMPARE_CAP);
    assert.equal(huge.total, HUGE, "the total is the whole pack, so the page can say 'first 60 of 70'");
    assert.equal(huge.pageSize, PACK_COMPARE_CAP);
    assert.deepEqual(
      cardsOf(huge).map((c) => c.variantLabel),
      Array.from({ length: PACK_COMPARE_CAP }, (_, i) => `Variant ${HUGE - PACK_COMPARE_CAP + 1 + i}`),
      "the newest 60, in variant order",
    );
    assert.equal(signedAssets.size, PACK_COMPARE_CAP, "signing is bounded by the cap");

    // The view's other filters still apply to it.
    assert.equal((await loadPackComparison(T, { pack: PACK_MID, lifecycle: "archived" }, deps)).tiles.length, 0);
    assert.equal((await loadPackComparison(T, { pack: PACK_MID, status: "in_review" }, deps)).total, MID);
  });

  await check("the options read two JSON paths per row, tenant-scoped, and no whole rows", async () => {
    const statements: string[] = [];
    const spy = new Proxy(mem, {
      get(target, prop) {
        if (prop === "execute") {
          return (stmt: string | { sql: string }) => {
            statements.push(typeof stmt === "string" ? stmt : stmt.sql);
            return target.execute(stmt as never);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await getMetaFacets(T, { group: "oasis-ai" }, createTursoPostgrest(spy) as never);
    assert.ok(statements.length >= 1);
    for (const sql of statements) {
      assert.doesNotMatch(sql, /^SELECT \*/, sql);
      assert.match(sql, /json_extract\("meta", '\$\.icp_segment'\)/);
      assert.match(sql, /json_extract\("meta", '\$\.pack_id'\)/);
      assert.match(sql, /"tenant_id" = \?/, `an untenanted read: ${sql}`);
    }
  });

  await check("a malformed meta fails loudly: the filter throws, the options say degraded, nothing shows 'everything'", async () => {
    const bad = createClient({ url: ":memory:" });
    await bad.executeMultiple(DDL);
    await seed(bad, [
      { id: "g1", created: day(1), meta: pack(PACK_A, "icp_sales_bottleneck", 1) },
      { id: "x1", created: day(2), meta: "this is not json" },
    ]);
    const db = createTursoPostgrest(bad) as never;
    await assert.rejects(() => getMarketingAssets(T, { icp: "icp_sales_bottleneck" }, db), /read failed|malformed JSON/i);
    const f = await getMetaFacets(T, { group: "oasis-ai" }, db);
    assert.equal(f.degraded, true, "a failed read is flagged, not painted as 'no audiences'");
    // ...while the unfiltered grid, which never opens meta, still loads, and the row's meta is just empty.
    const plain = await getMarketingAssets(T, {}, db);
    assert.equal(plain.total, 2);
    assert.deepEqual(assetMetaView(plain.assets.find((a) => a.id === "x1")!.meta), assetMetaView({}));
    assert.equal(DEGRADED_META_FACETS.degraded, true);
  });

  // ================================================================ 3. the page
  const db = await setupOfferDatabase({ migrate: false, library: false });
  await db.executeMultiple(DDL);
  const MKT = { id: "0e000000-0000-4000-8000-0000000000a1", email: "schneur@oasisai.work" };
  const MEMBER = { id: "0e000000-0000-4000-8000-0000000000a2", email: "member@oasisai.work" };
  const BUILDER = { id: "0e000000-0000-4000-8000-0000000000a3", email: "builder@oasisai.work" };
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [BUILDER.id, BUILDER.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES ('p-builder', ?, ?, ?, 'builder', 0, '2026-09-01T00:00:00Z', 'Builder', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [BUILDER.id, BUILDER.email, OASIS],
      },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [MKT.id, MKT.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES ('p-mkt', ?, ?, ?, 'marketing', 0, '2026-09-01T00:00:00Z', 'Schneur', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [MKT.id, MKT.email, OASIS],
      },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [MEMBER.id, MEMBER.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES ('p-member', ?, ?, ?, 'member', 0, '2026-09-01T00:00:00Z', 'Member', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [MEMBER.id, MEMBER.email, OASIS],
      },
    ],
    "write",
  );
  const REVIEW_IDS = ["r1", "r2", "r3", "r4", "r5", "r6"].map((s) => `ar-${s}`);
  await seed(db, [
    // Variant 1..6 created so the newest is variant 1: the page has to re-order them.
    ...REVIEW_IDS.map((id, i): Seed => ({
      id, tenant: OASIS, created: day(20 - i), status: "in_review",
      meta: pack(PACK_A, "icp_sales_bottleneck", i + 1, i === 0 ? { offer_slug: "fleet" } : i === 1 ? { burned_captions: true } : {}),
    })),
    { id: "ar-ops", tenant: OASIS, created: day(30), meta: pack(PACK_B, "icp_ops_bottleneck", 1) },
    { id: "ar-plain", tenant: OASIS, created: day(31), meta: {} },
    { id: "ar-client", tenant: OASIS, created: day(32), brand: "warner", meta: pack(PACK_A, "icp_sales_bottleneck", 9) },
    // Another workspace with the very same pack id: must never appear for OASIS.
    { id: "ca-1", tenant: CLIENT_A, created: day(33), meta: pack(PACK_A, "icp_sales_bottleneck", 1) },
    // Two packs bigger than a Library page, on the Clients tab so the OASIS tab the other
    // checks read is untouched. Variant n is created on day n; the Library pages newest first.
    ...Array.from({ length: MID }, (_, i): Seed => ({ id: `mid-${i + 1}`, tenant: OASIS, brand: "warner", created: day(i + 1), meta: pack(PACK_MID, "icp_ecommerce", i + 1) })),
    ...Array.from({ length: HUGE }, (_, i): Seed => ({ id: `huge-${i + 1}`, tenant: OASIS, brand: "warner", created: day(i + 1), meta: pack(PACK_HUGE, "icp_ecommerce", i + 1) })),
    // Assets for the checks that send one back and then settle it with a later verdict.
    ...["approve", "archive", "reject", "restore", "delete", "other"].map((s, i): Seed => ({ id: `vd-${s}`, tenant: OASIS, brand: "warner", created: day(40 + i), meta: {} })),
  ]);

  const { default: LibraryPage } = await import("../app/founders/marketing/library/page");
  const { HookCompare } = await import("../components/founders/HookCompare");
  const { AssetTile } = await import("../components/founders/marketing-shared");

  type Node = { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  const elements = (node: unknown, out: Node[] = [], seen = new Set<unknown>()): Node[] => {
    if (node === null || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) elements(v, out, seen);
      return out;
    }
    const el = node as Node;
    if (el.$$typeof && el.props) {
      out.push(el);
      elements(el.props, out, seen);
      return out;
    }
    for (const v of Object.values(node as Record<string, unknown>)) elements(v, out, seen);
    return out;
  };
  const strings = (node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] => {
    if (typeof node === "string") out.push(node);
    if (node === null || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    for (const v of Object.values(node as Record<string, unknown>)) strings(v, out, seen);
    return out;
  };
  const render = async (sp: Record<string, string>) => {
    const tree = await LibraryPage({ searchParams: Promise.resolve(sp) });
    return {
      tree,
      compare: elements(tree).filter((e) => e.type === HookCompare).map((e) => e.props!),
      tiles: elements(tree).filter((e) => e.type === AssetTile).map((e) => e.props!),
      text: strings(tree),
    };
  };

  await check("?pack= draws the comparison: every variant, in variant order, the grid and the layout toggle gone", async () => {
    await login(USERS.cc);
    const p = await render({ pack: PACK_A });
    assert.equal(p.compare.length, 1);
    assert.equal(p.tiles.length, 0, "no phones: the comparison replaces them");
    const props = p.compare[0] as { heading: string; cards: Array<{ id: string; hook: string; variantLabel: string; hookStyle: string | null; offerSlug: string | null; burnedCaptions: boolean; href: string }> };
    assert.equal(props.heading, "b2b operator - leads left waiting - 6 variants");
    assert.deepEqual(props.cards.map((c) => c.id), REVIEW_IDS, "variant 1..6, not newest-first");
    assert.deepEqual(props.cards.map((c) => c.variantLabel), [1, 2, 3, 4, 5, 6].map((n) => `Variant ${n}`));
    assert.deepEqual(props.cards.map((c) => c.hook), [1, 2, 3, 4, 5, 6].map((n) => `Opening line ${n}`));
    assert.deepEqual(props.cards.map((c) => c.hookStyle), ["question", "pattern_interrupt", "question", "pattern_interrupt", "question", "pattern_interrupt"]);
    assert.equal(props.cards[0].offerSlug, "fleet");
    assert.equal(props.cards[1].burnedCaptions, true);
    assert.ok(!props.cards.some((c) => c.id === "ca-1" || c.id === "ar-client"), "another workspace's pack and another tab's are not in it");
    assert.match(props.cards[0].href, /^\/founders\/marketing\/asset\/ar-r1\?from=/, "each links to its asset page, carrying this view");
    assert.ok(decodeURIComponent(props.cards[0].href).includes(`pack=${PACK_A}`), "and the way back keeps the pack");
    assert.ok(!p.text.includes("Library layout"), "the Phone / Grid toggle has nothing to switch");
  });

  await check("the audience and pack pills: counted options, links that keep the view, the chosen ones lit", async () => {
    await login(USERS.cc);
    const p = await render({ icp: "icp_sales_bottleneck" });
    assert.equal(p.compare.length, 0, "an audience alone is still the phone grid");
    assert.equal(p.tiles.length, 6, "the audience's assets, as phones");
    const links = p.text.filter((s) => s.startsWith("/founders/marketing/library"));
    assert.ok(links.includes(`/founders/marketing/library?icp=icp_sales_bottleneck&pack=${PACK_A}`), `the pack pill keeps the audience: ${links.join(" | ")}`);
    assert.ok(links.includes("/founders/marketing/library?icp=icp_ops_bottleneck"), "another audience's pill");
    assert.ok(links.includes("/founders/marketing/library"), "All clears it");
    assert.ok(p.text.includes("Sales bottleneck 6"), "the label and the count behind it");
    assert.ok(p.text.includes("Ops bottleneck 1"));
    assert.ok(p.text.includes("b2b operator - leads left waiting 6"));
    assert.ok(!p.text.includes("b2b operator - everything routes through you 1"), "with an audience chosen, only its packs");
    const lit = elements(p.tree).filter((e) => e.props && "active" in e.props && e.props.active === true && typeof e.props.label === "string").map((e) => e.props!.label);
    assert.ok(lit.includes("Sales bottleneck 6"), `lit: ${lit.join(" | ")}`);
  });

  await check("under a Studio ?status= link the pills count that stage, and the links keep it", async () => {
    await login(USERS.cc);
    // Every OASIS-tab asset is in review: that stage holds the six sales cuts, the ops one, and the two without an audience.
    const inReview = await render({ status: "in_review" });
    assert.ok(inReview.text.includes("Sales bottleneck 6"), "the in-review stage: six sales cuts");
    assert.ok(inReview.text.includes("Ops bottleneck 1"));
    const links = inReview.text.filter((s) => s.startsWith("/founders/marketing/library"));
    assert.ok(links.includes("/founders/marketing/library?icp=icp_sales_bottleneck&status=in_review"), `the link keeps the stage: ${links.join(" | ")}`);
    // Nothing is approved yet. Before this was fixed the pills still said "Sales bottleneck 6" and their links opened an empty grid.
    const approved = await render({ status: "approved" });
    assert.equal(approved.tiles.length, 0, "no asset is approved");
    assert.ok(!approved.text.some((s) => /^(Sales bottleneck|Ops bottleneck)\b/.test(s)), `a pill promises assets the stage does not hold: ${approved.text.filter((s) => /bottleneck/.test(s)).join(" | ")}`);
    // And each pill's number is what its link opens.
    const sales = await render({ status: "in_review", icp: "icp_sales_bottleneck" });
    assert.equal(sales.tiles.length, 6);
  });

  await check("a chosen pack is compared WHOLE: one bigger than a Library page is not cut, one bigger than the cap says so, and neither is paged", async () => {
    await login(USERS.cc);
    type Props = { heading: string; note?: string; cards: Array<{ id: string; variantLabel: string }> };
    const labels = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `Variant ${from + i}`);

    const mid = await render({ group: "clients", pack: PACK_MID });
    assert.equal(mid.compare.length, 1);
    const midProps = mid.compare[0] as unknown as Props;
    assert.equal(midProps.cards.length, MID, "all 30, though a Library page holds 24");
    assert.deepEqual(midProps.cards.map((c) => c.variantLabel), labels(1, MID), "variant 1 first - the Library would have put 1 to 6 on page two");
    assert.equal(midProps.heading, "shopify owner - returns flood - 30 variants");
    assert.equal(midProps.note, undefined, "a whole pack says nothing about what is left out");
    assert.ok(!mid.text.includes("Library pages"), "no pager under a comparison");
    // ?page= does not slice it either (a bookmark from before, a hand-typed 2).
    const second = await render({ group: "clients", pack: PACK_MID, page: "2" });
    assert.deepEqual((second.compare[0] as unknown as Props).cards.map((c) => c.id), midProps.cards.map((c) => c.id));

    const huge = await render({ group: "clients", pack: PACK_HUGE });
    const hugeProps = huge.compare[0] as unknown as Props;
    assert.equal(hugeProps.cards.length, PACK_COMPARE_CAP, "the cap");
    assert.deepEqual(hugeProps.cards.map((c) => c.variantLabel), labels(HUGE - PACK_COMPARE_CAP + 1, HUGE), "the newest 60, in variant order");
    assert.equal(hugeProps.heading, "shopify owner - every angle - first 60 of 70 variants");
    assert.equal(
      hugeProps.note,
      "Showing the first 60 of 70 variants in this pack, newest first. Archive or delete the ones you are done with to see the rest.",
      "an honest line about what is not shown",
    );
    assert.ok(!huge.text.includes("Library pages"), "no pager, even over the cap: it is one capped page");
    const hugePage2 = await render({ group: "clients", pack: PACK_HUGE, page: "2" });
    assert.deepEqual((hugePage2.compare[0] as unknown as Props).cards.map((c) => c.id), hugeProps.cards.map((c) => c.id), "?page=2 shows the same capped page, not the next 60");
    // The phone grid of the same tab is still paged as ever.
    const grid = await render({ group: "clients" });
    assert.equal(grid.tiles.length, LIBRARY_PAGE_SIZE, "without a pack the Library still reads one page");
    assert.ok(grid.text.includes("Library pages"));
  });

  await check("the offer and captions badges ride on the tiles; nothing else about a tile changes", async () => {
    await login(USERS.cc);
    const p = await render({});
    const byId = (id: string) => p.tiles.find((t) => t.id === id)!;
    assert.equal(byId("ar-r1").offerSlug, "fleet");
    assert.equal(byId("ar-r1").burnedCaptions, false);
    assert.equal(byId("ar-r2").offerSlug, null);
    assert.equal(byId("ar-r2").burnedCaptions, true);
    assert.equal(byId("ar-plain").offerSlug, null);
    assert.equal(byId("ar-plain").burnedCaptions, false);
  });

  await check("every seat the founders portal admits sees the same comparison and tiles - no role switch on the page; an unknown or junk filter value is handled", async () => {
    const seen: string[][] = [];
    for (const user of [USERS.cc, USERS.admin, MKT]) {
      await login(user);
      const p = await render({ pack: PACK_A });
      assert.equal(p.compare.length, 1, user.email);
      const props = p.compare[0] as { cards: Array<{ id: string }> } & Record<string, unknown>;
      seen.push(props.cards.map((c) => c.id));
      assert.deepEqual(
        Object.keys(props).filter((k) => !["cards", "heading", "note"].includes(k)),
        [],
        "the comparison is handed no role flag: the buttons are the verdict buttons, drawn for whoever sees the page",
      );
      const tiles = await render({});
      assert.ok(tiles.tiles.length > 0, user.email);
      for (const t of tiles.tiles) assert.ok(!("canRequestChanges" in t), `${user.email}: a tile carries no role flag`);
    }
    assert.deepEqual(seen[1], seen[0]);
    assert.deepEqual(seen[2], seen[0]);
    await login(USERS.cc);
    // A well-formed id nothing carries: the pill that narrows the grid is lit and can be cleared, in the id's own words.
    const none = await render({ icp: "icp_brand_new_thing" });
    assert.equal(none.tiles.length, 0);
    assert.ok(none.text.includes("Nothing for this audience"));
    assert.ok(none.text.includes("icp_brand_new_thing 0"), "an unknown id shows as itself");
    // Junk is ignored, as if absent.
    const junk = await render({ icp: "x'; DROP TABLE marketing_asset;--", pack: "../etc" });
    assert.equal(junk.compare.length, 0);
    assert.ok(junk.tiles.length >= 8, "the whole OASIS tab");
    const outsider = await (async () => {
      await login(USERS.rep);
      try {
        await render({});
        return "rendered";
      } catch (e) {
        return /NEXT_HTTP_ERROR_FALLBACK;404/.test((e as Error).message) ? "404" : String(e);
      }
    })();
    assert.equal(outsider, "404", "a sales seat never reaches the Library");
  });

  // ============================================================== 4. the routes
  const routes = {
    review: await import("../app/api/founders/marketing/assets/[id]/request-changes/route"),
    asset: await import("../app/api/founders/marketing/assets/[id]/route"),
  };
  const post = (id: string, body: unknown, route: "review" | "asset" = "review", method: "POST" | "PATCH" | "DELETE" = "POST") => {
    const handler = (routes[route] as Record<string, (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>>)[method];
    return handler(
      new Request(`http://localhost/api/founders/marketing/assets/${id}/request-changes`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  };
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const tableNames = (await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)).rows.map((r) => String(r.name));
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of tableNames) out[t] = Number((await db.execute(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
    return out;
  };
  const delta = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.keys(b).filter((k) => b[k] !== a[k]).map((k) => [k, b[k] - a[k]]));
  const rowOf = async (id: string) => (await db.execute({ sql: `SELECT * FROM marketing_asset WHERE id = ?`, args: [id] })).rows[0] as unknown as Record<string, unknown> | undefined;
  const changedColumns = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(b).filter((k) => String(a[k]) !== String(b[k])).sort();
  const reviews = async (assetId: string) => (await db.execute({ sql: `SELECT * FROM marketing_review WHERE asset_id = ? ORDER BY created_at`, args: [assetId] })).rows as unknown as Array<Record<string, unknown>>;

  await check("outside the founders portal there is nothing: signed out, a sales seat, a member - all 404, nothing written", async () => {
    const before = await counts();
    const asset = await rowOf("ar-r3");
    for (const user of [null, USERS.rep, MEMBER]) {
      await login(user);
      const res = await post("ar-r3", { note: "Too slow." });
      assert.equal(res.status, 404, user?.email ?? "signed out");
      assert.equal((await json(res)).error, "not_found");
    }
    assert.deepEqual(delta(before, await counts()), {});
    assert.deepEqual(await rowOf("ar-r3"), asset);
  });

  await check("Request changes is gated exactly like Approve, Archive and Delete: the same callers are let in and the same are 404, for every seat", async () => {
    const before = await counts();
    const outcomes: Record<string, [number, number]> = {};
    for (const [name, user] of [["signed out", null], ["sales seat", USERS.rep], ["member", MEMBER], ["marketing seat", MKT], ["builder seat", BUILDER], ["admin", USERS.admin], ["owner", USERS.cc]] as const) {
      await login(user);
      // Each call is refused for its BODY if the caller gets past the gate (400), so nothing is written either way.
      const sibling = await post("ar-r3", { status: "not-a-status" }, "asset", "PATCH");
      const mine = await post("ar-r3", {});
      outcomes[name] = [sibling.status, mine.status];
      assert.equal(mine.status === 404, sibling.status === 404, `${name}: the sibling verbs answer ${sibling.status} and Request changes ${mine.status}`);
    }
    assert.deepEqual(outcomes, {
      "signed out": [404, 404], "sales seat": [404, 404], member: [404, 404],
      "marketing seat": [400, 400], "builder seat": [400, 400], admin: [400, 400], owner: [400, 400],
    });
    assert.deepEqual(delta(before, await counts()), {}, "nothing written by either probe");
  });

  await check("the marketing seat can send an asset back, with its own name on the note", async () => {
    await login(MKT);
    const before = await counts();
    const asset = (await rowOf("ar-r6"))!;
    const res = await post("ar-r6", { note: "The hook is buried." });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.deepEqual(await json(res), { ok: true, asset: { id: "ar-r6", title: "Cut ar-r6", status: "draft" }, review_recorded: true });
    assert.deepEqual(changedColumns(asset, (await rowOf("ar-r6"))!), ["status", "updated_at"]);
    assert.deepEqual(delta(before, await counts()), { marketing_review: 1, marketing_event: 1 });
    const rv = await reviews("ar-r6");
    assert.equal(rv.length, 1);
    assert.equal(rv[0].decision, "request_changes");
    assert.equal(rv[0].reviewer, "Schneur");
    assert.equal(rv[0].tenant_id, OASIS);
    assert.equal(rv[0].acted_on_at, null);
    // Put the fixture back for the checks that follow.
    await db.execute(`UPDATE marketing_asset SET status = 'in_review' WHERE id = 'ar-r6'`);
    await db.execute(`DELETE FROM marketing_review WHERE asset_id = 'ar-r6'`);
    await db.execute(`DELETE FROM marketing_event WHERE asset_id = 'ar-r6'`);
  });

  await check("a note is required: empty, blank, missing, not a string, not an object, broken JSON - 400, nothing read or written", async () => {
    await login(USERS.cc);
    const before = await counts();
    for (const body of [{}, { note: "" }, { note: "   \n " }, { note: 12 }, { note: null }, { note: ["slow"] }]) {
      const res = await post("ar-r3", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await json(res)).error, "note_required", JSON.stringify(body));
    }
    for (const body of ['"just a string"', "[1]", "null"]) {
      const res = await post("ar-r3", body);
      assert.equal(res.status, 400, body);
      assert.equal((await json(res)).error, "invalid_body", body);
    }
    const broken = await post("ar-r3", "{ not json");
    assert.equal(broken.status, 400);
    assert.equal((await json(broken)).error, "invalid_json");
    const long = await post("ar-r3", { note: "x".repeat(2001) });
    assert.equal(long.status, 400);
    assert.equal((await json(long)).error, "note_too_long");
    assert.deepEqual(delta(before, await counts()), {}, "a refused request leaves no trace");
    assert.equal((await rowOf("ar-r3"))!.status, "in_review");
  });

  await check("an owner and an admin send an asset back: the note is recorded for the marketing agent, the asset goes to draft, nothing else moves", async () => {
    for (const [user, id, name] of [[USERS.cc, "ar-r1", "Conaugh McKenna"], [USERS.admin, "ar-r2", "Operations Admin"]] as const) {
      await login(user);
      const before = await counts();
      const asset = (await rowOf(id))!;
      const others = await Promise.all(REVIEW_IDS.filter((x) => x !== id).map(rowOf));
      const media = (await db.execute({ sql: `SELECT * FROM marketing_asset_media WHERE asset_id = ?`, args: [id] })).rows;
      const res = await post(id, { note: `  The first three seconds are too slow (${name}).  ` });
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      const body = await json(res);
      assert.deepEqual(body, { ok: true, asset: { id, title: `Cut ${id}`, status: "draft" }, review_recorded: true });

      const after = (await rowOf(id))!;
      assert.deepEqual(changedColumns(asset, after), ["status", "updated_at"], "the status, and when it changed, and no other column");
      assert.equal(after.status, "draft");
      assert.equal(after.scheduled_for, null, "nothing is scheduled");
      assert.equal(after.published_at, null, "nothing is posted");
      assert.equal(after.external_id, null);
      assert.deepEqual(delta(before, await counts()), { marketing_review: 1, marketing_event: 1 }, "a note and an activity row, and nothing else anywhere");
      assert.equal(Number((await db.execute(`SELECT count(*) AS n FROM marketing_publish_intent`)).rows[0].n), 0, "no publish intent");
      const rv = await reviews(id);
      assert.equal(rv.length, 1);
      assert.equal(rv[0].decision, "request_changes");
      assert.equal(rv[0].note, `The first three seconds are too slow (${name}).`, "the founder's words, trimmed");
      assert.equal(rv[0].reviewer, name);
      assert.equal(rv[0].reviewer_agent, null);
      assert.equal(rv[0].acted_on_at, null, "OPEN: this is what the marketing agent looks for");
      assert.equal(rv[0].tenant_id, OASIS);
      const ev = (await db.execute({ sql: `SELECT * FROM marketing_event WHERE asset_id = ?`, args: [id] })).rows[0];
      assert.equal(ev.verb, "changes_requested");
      assert.equal(ev.actor, name);
      assert.equal(ev.tenant_id, OASIS);
      assert.deepEqual((await db.execute({ sql: `SELECT * FROM marketing_asset_media WHERE asset_id = ?`, args: [id] })).rows, media, "its media rows are untouched");
      assert.deepEqual(await Promise.all(REVIEW_IDS.filter((x) => x !== id).map(rowOf)), others, "no other asset moved");
    }
  });

  await check("only an asset still in review can be sent back: draft, approved, archived, published - 409, and a second press adds nothing", async () => {
    await login(USERS.cc);
    await db.execute(`UPDATE marketing_asset SET status = 'approved' WHERE id = 'ar-r4'`);
    await db.execute(`UPDATE marketing_asset SET status = 'archived' WHERE id = 'ar-r5'`);
    await db.execute(`UPDATE marketing_asset SET status = 'published', published_at = '2026-10-02T00:00:00Z' WHERE id = 'ar-r6'`);
    const before = await counts();
    for (const [id, status] of [["ar-r1", "draft"], ["ar-r4", "approved"], ["ar-r5", "archived"], ["ar-r6", "published"]] as const) {
      const res = await post(id, { note: "Again." });
      assert.equal(res.status, 409, id);
      assert.deepEqual(await json(res), { ok: false, error: "not_in_review", status }, id);
    }
    assert.deepEqual(delta(before, await counts()), {}, "double presses and stale tiles write nothing");
    assert.equal((await reviews("ar-r1")).length, 1, "the double press did not add a second note");
    await db.execute(`UPDATE marketing_asset SET status = 'in_review', published_at = NULL WHERE id IN ('ar-r4','ar-r5','ar-r6')`);
  });

  await check("only inside the caller's own workspace: another workspace's asset is a 404 and untouched; their own works", async () => {
    await login(USERS.clientA);
    const before = await counts();
    const mine = (await rowOf("ca-1"))!;
    const res = await post("ar-r3", { note: "Reaching into another workspace." });
    assert.equal(res.status, 404);
    assert.equal((await json(res)).error, "not_found");
    assert.deepEqual(delta(before, await counts()), {});
    assert.equal((await rowOf("ar-r3"))!.status, "in_review", "OASIS's asset did not move");
    // The reverse: OASIS cannot reach theirs either.
    await login(USERS.cc);
    assert.equal((await post("ca-1", { note: "Wrong workspace." })).status, 404);
    assert.deepEqual(await rowOf("ca-1"), mine);
    // And a founder-tenant owner in their own workspace is served, with THEIR tenant on every row.
    await login(USERS.clientA);
    const own = await post("ca-1", { note: "Our own asset." });
    assert.equal(own.status, 200);
    assert.equal((await reviews("ca-1"))[0].tenant_id, CLIENT_A);
  });

  await check("an id that is not an id is a 404 before any lookup", async () => {
    await login(USERS.cc);
    const before = await counts();
    for (const id of ["../x", "a b", "x".repeat(65), "a;b", "%00"]) {
      assert.equal((await post(id, { note: "Hi." })).status, 404, id);
    }
    assert.deepEqual(delta(before, await counts()), {});
  });

  await check("a lost race leaves nothing behind: the asset moved first, so the note is taken back and the answer says where it is now", async () => {
    await login(USERS.cc);
    await db.execute(
      `CREATE TRIGGER race_after_note AFTER INSERT ON marketing_review
       BEGIN UPDATE marketing_asset SET status = 'approved' WHERE id = NEW.asset_id; END`,
    );
    try {
      const before = await counts();
      const res = await post("ar-r3", { note: "Racing the approver." });
      assert.equal(res.status, 409);
      assert.deepEqual(await json(res), { ok: false, error: "status_changed", status: "approved" });
      assert.deepEqual(delta(before, await counts()), {}, "the note this call wrote is gone again");
      assert.equal((await rowOf("ar-r3"))!.status, "approved", "the other verdict stands");
    } finally {
      await db.execute(`DROP TRIGGER race_after_note`);
      await db.execute(`UPDATE marketing_asset SET status = 'in_review' WHERE id = 'ar-r3'`);
    }
  });

  await check("a note that cannot be saved changes nothing; a status change that fails with an error keeps the note (it may have committed)", async () => {
    await login(USERS.cc);
    await db.execute(`CREATE TRIGGER no_notes BEFORE INSERT ON marketing_review BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    try {
      const before = await counts();
      const res = await post("ar-r3", { note: "Cannot be saved." });
      assert.equal(res.status, 500);
      assert.equal((await json(res)).error, "review_not_recorded");
      assert.deepEqual(delta(before, await counts()), {});
      assert.equal((await rowOf("ar-r3"))!.status, "in_review", "the asset did not move without its reason");
    } finally {
      await db.execute(`DROP TRIGGER no_notes`);
    }
    await db.execute(`CREATE TRIGGER no_moves BEFORE UPDATE OF status ON marketing_asset BEGIN SELECT RAISE(ABORT, 'locked'); END`);
    try {
      const before = await counts();
      const res = await post("ar-r3", { note: "Cannot move." });
      assert.equal(res.status, 500);
      assert.equal((await json(res)).error, "update_failed");
      // An ERROR from the write is ambiguous (it may have committed, only its answer
      // lost), so the founder's note is never deleted on one: the asset is still in
      // review, and an open note on it is the documented harmless state.
      assert.deepEqual(delta(before, await counts()), { marketing_review: 1 }, "the note stays");
      assert.equal((await rowOf("ar-r3"))!.status, "in_review");
      const rv = await reviews("ar-r3");
      assert.equal(rv.length, 1);
      assert.equal(rv[0].note, "Cannot move.");
      assert.equal(rv[0].acted_on_at, null);
    } finally {
      await db.execute(`DROP TRIGGER no_moves`);
      await db.execute(`DELETE FROM marketing_review WHERE asset_id = 'ar-r3'`);
    }
  });

  await check("a status write that fails AFTER it committed keeps the note and reports success; one that did not commit keeps the note; another verdict's win takes it back", async () => {
    const flakyDb = createClient({ url: ":memory:" });
    await flakyDb.executeMultiple(DDL);
    await seed(flakyDb, ["lost", "refused", "beaten", "blind"].map((id): Seed => ({ id: `fl-${id}`, created: day(1), status: "in_review", meta: {} })));
    const real = createTursoPostgrest(flakyDb);
    /**
     * The adapter's own failure shape ({ error }, lib/turso-postgrest.ts run), at the
     * marketing_asset call numbered by `steps`: 0 is the pre-read, 1 the status write,
     * 2 the re-read.
     *   commit-then-lose   the write COMMITS, then its answer is lost (a timeout after the commit)
     *   lose               the write never reaches the database
     *   approve-then-lose  another verdict lands instead, and the answer is lost
     *   lose-always        every marketing_asset call from this step on fails (the re-read too)
     */
    type Step = "real" | "commit-then-lose" | "lose" | "approve-then-lose" | "lose-always";
    const flaky = (assetId: string, steps: Step[]) => {
      let n = 0;
      let always = false;
      return {
        from(table: string) {
          const builder = real.from(table);
          if (table !== "marketing_asset") return builder;
          const step: Step = always ? "lose" : (steps[n++] ?? "real");
          if (step === "lose-always") always = true;
          if (step === "real") return builder;
          const lost = { data: null, error: { message: "connection reset" }, count: null, status: 400, statusText: "Bad Request" };
          const proxy: unknown = new Proxy(builder, {
            get(target, prop) {
              const value = Reflect.get(target, prop, target);
              if (prop === "then") {
                return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
                  if (step === "commit-then-lose") return Promise.resolve(target.then(() => lost)).then(ok, bad);
                  if (step === "approve-then-lose") {
                    return flakyDb
                      .execute({ sql: `UPDATE marketing_asset SET status = 'approved' WHERE id = ?`, args: [assetId] })
                      .then(() => lost)
                      .then(ok, bad);
                  }
                  return Promise.resolve(lost).then(ok, bad);
                };
              }
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                const out = value.apply(target, args);
                return out === target ? proxy : out;
              };
            },
          });
          return proxy;
        },
      } as never;
    };
    const state = async (id: string) => ({
      status: String((await flakyDb.execute({ sql: `SELECT status FROM marketing_asset WHERE id = ?`, args: [id] })).rows[0].status),
      notes: (await flakyDb.execute({ sql: `SELECT note, acted_on_at FROM marketing_review WHERE asset_id = ? AND decision = 'request_changes'`, args: [id] })).rows.map((r) => ({ note: String(r.note), open: r.acted_on_at === null })),
      events: Number((await flakyDb.execute({ sql: `SELECT count(*) AS n FROM marketing_event WHERE asset_id = ?`, args: [id] })).rows[0].n),
    });
    const ask = (id: string, steps: Step[]) => requestChanges(flaky(id, steps), { tenantId: T, assetId: id, note: `Reason for ${id}.`, reviewer: "Tester" });

    // The write commits and only the answer is lost: a SUCCESS, the note kept, a retry would meet 409.
    const lost = await ask("fl-lost", ["real", "commit-then-lose"]);
    assert.equal(lost.ok, true, JSON.stringify(lost));
    assert.deepEqual(await state("fl-lost"), { status: "draft", notes: [{ note: "Reason for fl-lost.", open: true }], events: 1 }, "a draft WITH its reason, and the activity row");

    // The write never happened and the asset is still in review: 500, the note left open, nothing lost.
    const refused = await ask("fl-refused", ["real", "lose"]);
    assert.deepEqual(refused, { ok: false, http: 500, error: "update_failed" });
    assert.deepEqual(await state("fl-refused"), { status: "in_review", notes: [{ note: "Reason for fl-refused.", open: true }], events: 0 });

    // Another verdict won and the answer was lost: that is a lost race, so the note is taken back.
    const beaten = await ask("fl-beaten", ["real", "approve-then-lose"]);
    assert.deepEqual(beaten, { ok: false, http: 409, error: "status_changed", current: "approved" });
    assert.deepEqual(await state("fl-beaten"), { status: "approved", notes: [], events: 0 });

    // Cannot even look afterwards: the note stays, 500.
    const blind = await ask("fl-blind", ["real", "lose-always"]);
    assert.deepEqual(blind, { ok: false, http: 500, error: "update_failed" });
    assert.deepEqual(await state("fl-blind"), { status: "in_review", notes: [{ note: "Reason for fl-blind.", open: true }], events: 0 });
  });

  await check("requestChanges(): the verdict is the function's own - the same asset, tenant-scoped, through an injected client", async () => {
    const { getServiceSupabase } = await import("../lib/supabase-server");
    const svc = getServiceSupabase();
    const wrong = await requestChanges(svc, { tenantId: CLIENT_A, assetId: "ar-r3", note: "x", reviewer: "t" });
    assert.deepEqual(wrong, { ok: false, http: 404, error: "not_found" });
    const right = await requestChanges(svc, { tenantId: OASIS, assetId: "ar-r3", note: "Cut the intro.", reviewer: "Test" });
    assert.equal(right.ok, true);
    assert.equal((await rowOf("ar-r3"))!.status, "draft");
    // Put the fixture back: the next checks start from an asset in review with no notes.
    await db.execute(`UPDATE marketing_asset SET status = 'in_review' WHERE id = 'ar-r3'`);
    await db.execute(`DELETE FROM marketing_review WHERE asset_id = 'ar-r3'`);
    await db.execute(`DELETE FROM marketing_event WHERE asset_id = 'ar-r3'`);
  });

  await check("Approve (the existing route) changes the status and NOTHING else: no schedule, no post, no publish intent, no other column", async () => {
    await login(USERS.cc);
    const before = await counts();
    const asset = (await rowOf("ar-r3"))!;
    const res = await post("ar-r3", { status: "approved" }, "asset", "PATCH");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.review_recorded, true);
    const after = (await rowOf("ar-r3"))!;
    assert.deepEqual(changedColumns(asset, after), ["status", "updated_at"]);
    assert.equal(after.status, "approved");
    assert.equal(after.scheduled_for, null);
    assert.equal(after.published_at, null);
    assert.equal(after.external_id, null);
    assert.deepEqual(delta(before, await counts()), { marketing_review: 1 }, "its verdict row, and not a row anywhere else");
    const rv = await reviews("ar-r3");
    assert.equal(rv.length, 1);
    assert.equal(rv[0].decision, "approve");
    assert.notEqual(rv[0].acted_on_at, null, "an approval is closed the moment it is made");
    await db.execute(`UPDATE marketing_asset SET status = 'in_review' WHERE id = 'ar-r3'`);
    await db.execute(`DELETE FROM marketing_review WHERE asset_id = 'ar-r3'`);
  });

  await check("a verdict that settles the asset closes the request for changes still open on it (Approve, Archive, Reject, Delete), and touches nothing else", async () => {
    await login(USERS.cc);
    const requests = async (id: string) =>
      (await db.execute({ sql: `SELECT id, tenant_id, note, decision, acted_on_at FROM marketing_review WHERE asset_id = ? AND decision = 'request_changes' ORDER BY note`, args: [id] })).rows as unknown as Array<{ id: string; tenant_id: string; note: string; decision: string; acted_on_at: string | null }>;
    const OLD_CLOSED = "2026-01-01T00:00:00.000Z";
    // Bystanders: a request already closed earlier (its timestamp must not move), another
    // workspace's open request naming the same asset id, an open row of another decision on the
    // same asset, and an open request on another asset.
    await db.batch(
      [
        { sql: `INSERT INTO marketing_review (tenant_id, asset_id, decision, note, acted_on_at) VALUES (?, 'vd-approve', 'request_changes', 'Old, already acted on.', ?)`, args: [OASIS, OLD_CLOSED] },
        { sql: `INSERT INTO marketing_review (tenant_id, asset_id, decision, note, acted_on_at) VALUES (?, 'vd-approve', 'request_changes', 'Foreign workspace.', NULL)`, args: [CLIENT_A] },
        { sql: `INSERT INTO marketing_review (tenant_id, asset_id, decision, note, acted_on_at) VALUES (?, 'vd-approve', 'comment', 'A comment, still open.', NULL)`, args: [OASIS] },
        { sql: `INSERT INTO marketing_review (tenant_id, asset_id, decision, note, acted_on_at) VALUES (?, 'vd-other', 'request_changes', 'Another asset.', NULL)`, args: [OASIS] },
      ],
      "write",
    );
    for (const [id, status, decision] of [["vd-approve", "approved", "approve"], ["vd-archive", "archived", "comment"], ["vd-reject", "rejected", "reject"]] as const) {
      const text = `Send ${id} back.`;
      assert.equal((await post(id, { note: text })).status, 200, id);
      assert.equal((await rowOf(id))!.status, "draft");
      const asked = (await requests(id)).find((r) => r.note === text)!;
      assert.equal(asked.acted_on_at, null, `${id}: open after Request changes - the agent's inbox`);

      // Two sequential clicks, no race: the verdict that follows.
      const res = await post(id, { status }, "asset", "PATCH");
      assert.equal(res.status, 200, `${id}: ${JSON.stringify(await res.clone().json())}`);
      assert.equal((await rowOf(id))!.status, status);
      const closed = (await requests(id)).find((r) => r.note === text)!;
      assert.notEqual(closed.acted_on_at, null, `${id}: the verdict closed the request for changes`);
      assert.equal(closed.id, asked.id, "the same row, closed - not deleted and not replaced");
      assert.equal(closed.decision, "request_changes");
      // ...and the verdict itself is recorded beside it, as before.
      const verdicts = (await db.execute({ sql: `SELECT acted_on_at FROM marketing_review WHERE asset_id = ? AND decision = ?`, args: [id, decision] })).rows;
      assert.equal(verdicts.length, 1, `${id}: its own verdict row`);
    }
    const open = Number((await db.execute({ sql: `SELECT count(*) AS n FROM marketing_review WHERE tenant_id = ? AND decision = 'request_changes' AND acted_on_at IS NULL AND asset_id IN ('vd-approve','vd-archive','vd-reject')`, args: [OASIS] })).rows[0].n);
    assert.equal(open, 0, "nothing settled is still waiting on the agent");

    // The bystanders are exactly as they were.
    assert.equal((await requests("vd-approve")).find((r) => r.note === "Old, already acted on.")!.acted_on_at, OLD_CLOSED, "an already closed request keeps its own time");
    assert.equal((await requests("vd-approve")).find((r) => r.note === "Foreign workspace.")!.acted_on_at, null, "another workspace's request is not ours to close");
    assert.equal((await db.execute(`SELECT acted_on_at FROM marketing_review WHERE note = 'A comment, still open.'`)).rows[0].acted_on_at, null, "only requests for changes are closed");
    assert.equal((await requests("vd-other"))[0].acted_on_at, null, "another asset's request is not touched");

    // A move back to in review is not a verdict: it settles nothing and closes nothing.
    assert.equal((await post("vd-restore", { note: "Needs a tighter cut." })).status, 200);
    assert.equal((await post("vd-restore", { status: "in_review" }, "asset", "PATCH")).status, 200);
    assert.equal((await requests("vd-restore"))[0].acted_on_at, null, "restoring is no verdict");

    // Deleting settles it for good: the request is closed (its row stays), but only
    // once the delete is confirmed, and only that asset's.
    assert.equal((await post("vd-delete", { note: "Never mind the cut, drop it." })).status, 200);
    assert.equal((await requests("vd-delete"))[0].acted_on_at, null);
    const deleted = await post("vd-delete", undefined, "asset", "DELETE");
    assert.equal(deleted.status, 200);
    assert.equal(await rowOf("vd-delete"), undefined, "the asset is gone");
    const afterDelete = await requests("vd-delete");
    assert.equal(afterDelete.length, 1, "its request row is kept as history, not deleted");
    assert.notEqual(afterDelete[0].acted_on_at, null, "and closed: nothing is waiting on a deleted asset");
    assert.equal((await requests("vd-other"))[0].acted_on_at, null, "another asset's request is still open");
  });

  await check("Delete (the existing route) removes the asset's rows and reports its files; it deletes no stored file and stays in the workspace", async () => {
    await login(USERS.clientA);
    const before = await counts();
    assert.equal((await post("ar-r5", undefined, "asset", "DELETE")).status, 404, "another workspace cannot delete it");
    assert.deepEqual(delta(before, await counts()), {});
    await login(USERS.cc);
    const res = await post("ar-r5", undefined, "asset", "DELETE");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.deepEqual(body.orphan, [`marketing-media/${OASIS}/ar-r5/cut.mp4`], "the file is left in storage and named, for a sweep");
    assert.equal(await rowOf("ar-r5"), undefined);
    assert.equal(Number((await db.execute(`SELECT count(*) AS n FROM marketing_asset_media WHERE asset_id = 'ar-r5'`)).rows[0].n), 0);
    assert.notEqual(await rowOf("ar-r4"), undefined, "no other asset went with it");
    const route = readFileSync(join(ROOT, "app/api/founders/marketing/assets/[id]/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(route, /\.storage\b|createSignedUrl|removeObject|r2-storage|deleteObject/, "the delete route reaches no object store");
  });

  // =========================================================== 5. what is on screen
  type RenderReport = {
    compare: string;
    compareNote: string;
    cards: Array<{ id: string; hook: string }>;
    actions: Record<string, string>;
    flow: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the render child's report, asserted field by field below
    hook: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- same
  };
  // The render child runs once; every check below reads its report.
  let rendered: RenderReport | null = null;
  const renderChild = (): RenderReport => {
    if (rendered) return rendered;
    const child = spawnSync(process.execPath, ["--import", "tsx", join("tests", "library-review.render.ts")], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || "").split(/\s+/).filter((t) => t && !/^(--conditions|-C)(=|$)/.test(t) && t !== "react-server").join(" ") },
    });
    assert.equal(child.status, 0, `render child failed:\n${child.stderr}`);
    rendered = JSON.parse(child.stdout) as RenderReport;
    return rendered;
  };

  await check("the client components, drawn and driven in full React", () => {
    const d = renderChild();
    const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
    const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
    const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

    // The comparison.
    const html = d.compare;
    assert.deepEqual(d.cards.map((c) => c.id), ["v1", "v2", "v3", "vx"], "numbered variants first, the unnumbered one last");
    const order = ["First opening", "Second opening", "Third opening"].map((s) => html.indexOf(s));
    assert.ok(order.every((n) => n > 0) && order[0] < order[1] && order[1] < order[2], `hook lines in variant order: ${order}`);
    for (const label of ["Variant 1", "Variant 2", "Variant 3"]) assert.ok(html.includes(label), label);
    assert.ok(html.includes("pattern interrupt") && html.includes("question"), "each variant's style");
    const videos = tags(html, "video");
    assert.equal(videos.length, 3, "a video for each variant that has one (v2's render is not on file)");
    for (const v of videos) {
      assert.equal(attr(v, "preload"), "none", `nothing loads until a play button is pressed: ${v}`);
      assert.match(v, /\scontrols(=|\s|>)/);
      assert.match(v, /\splaysinline/i);
    }
    assert.equal((html.match(/aspect-video/g) ?? []).length, 4, "every variant's media is a 16:9 box");
    assert.ok(html.includes("No render on file yet") === false, "v1, v3 and vx have videos and v2 has a poster");
    assert.ok(html.includes("https://media.test/v2.jpg"), "a variant with no video shows its poster");
    for (const label of ["Play all together", "Play one after another"]) assert.ok(textOf(html).includes(label), label);
    assert.ok(textOf(html).includes("does not schedule or post it"), "the page says what Approve does not do");
    assert.ok(html.includes("Offer: fleet") && html.includes("Captions in picture"), "the read-only badges");
    assert.ok(html.includes("/founders/marketing/asset/v1?from="), "each card links to its asset page");
    // Request changes: drawn with the other verdicts, on the in-review variants only.
    assert.equal((textOf(html).match(/Request changes/g) ?? []).length, 3, "v1, v3 and vx are in review; v2 is approved");
    assert.equal((textOf(html).match(/Approve/g) ?? []).length >= 4, true, "and beside every variant's Approve");

    // The tile's own buttons.
    assert.ok(textOf(d.actions.inReview).includes("Request changes"));
    for (const k of ["approved", "draft", "archived"]) assert.ok(!textOf(d.actions[k]).includes("Request changes"), `${k}: only an asset in review can be sent back`);
    const order4 = ["Approve", "Request changes", "Archive", "Delete"].map((s) => textOf(d.actions.inReview).indexOf(s));
    assert.ok(order4.every((n) => n >= 0) && order4.every((n, i) => i === 0 || order4[i - 1] < n), `Approve / Request changes / Archive / Delete: ${order4}`);

    const f = d.flow;
    const buttons = (s: { buttons: Array<{ text: string; disabled: boolean }> }) => s.buttons.map((b) => b.text);
    // The note box.
    assert.deepEqual(buttons(f.start), ["Approve", "Request changes", "Archive", "Delete"]);
    assert.deepEqual(buttons(f.composer), ["Send back", "Cancel"]);
    assert.ok(f.composer.text.includes('What should change in "Cut a1"?'), f.composer.text);
    assert.equal(f.composer.textarea[0].maxLength, 2000);
    assert.ok(f.composer.text.includes("A note is required."));
    assert.equal(f.composer.buttons.find((b: { text: string }) => b.text === "Send back").disabled, true, "Send back is off until there are words");
    assert.equal(f.blank.buttons.find((b: { text: string }) => b.text === "Send back").disabled, true, "spaces are not words");
    assert.equal(f.blankSendMadeARequest, false, "a blank note never reaches the server");
    assert.ok(f.blankSendError.includes("Add a note saying what should change."), "and the refusal says why");
    // The request.
    assert.deepEqual(f.requestCalls.map((c: { url: string; method: string }) => `${c.method} ${c.url}`), [
      "POST /api/founders/marketing/assets/a1/request-changes",
      "POST /api/founders/marketing/assets/a1/request-changes",
    ]);
    assert.deepEqual(f.requestCalls[0].body, { note: "The first three seconds are too slow." }, "trimmed, and nothing else in the body");
    assert.ok(f.refused.text.includes("no longer in review"), "a refusal is said in words");
    assert.equal(f.refused.textarea[0].value, "  The first three seconds are too slow.  ", "and the founder's note is still in the box");
    assert.deepEqual(buttons(f.refused), ["Send back", "Cancel"]);
    assert.ok(f.sent.text.includes("Sent back. The marketing agent will see your note."));
    assert.deepEqual(buttons(f.sent), ["Approve", "Archive", "Delete"], "a draft cannot be sent back again");
    assert.equal(f.refreshes, 1, "the page is refreshed once, so the counts follow");
    assert.deepEqual(buttons(f.draftTile), ["Approve", "Archive", "Delete"]);
    // Delete asks first, inside the tile, and Keep takes it back without a request.
    assert.ok(f.deleteAsk.text.includes('Delete "Cut a1" for good? It cannot be undone.'), f.deleteAsk.text);
    assert.deepEqual(buttons(f.deleteAsk), ["Delete for good", "Archive instead", "Keep"]);
    assert.equal(f.deleteAskMadeARequest, false, "asking is not deleting");
    assert.deepEqual(buttons(f.deleteKept), ["Approve", "Request changes", "Archive", "Delete"]);
    assert.equal(f.deleteKeptMadeARequest, false);
    assert.deepEqual(f.deleteCalls.map((c: { method: string; url: string }) => `${c.method} ${c.url}`), ["DELETE /api/founders/marketing/assets/a1"]);
    assert.ok(f.deleteDone.text.includes("Deleted. It is gone from the Library for good."));
    // Approve sends the status and nothing else.
    assert.deepEqual(f.approveCalls, [{ url: "/api/founders/marketing/assets/a1", method: "PATCH", body: { status: "approved" } }]);
    assert.deepEqual(buttons(f.approveAfter), ["Approved", "Archive", "Delete"], "approved is a state, not a request to post");
    // Sent back, then approved from the same tile: Approve is live on the draft and is a plain verdict.
    const before = f.sentBackThenApproveBefore;
    assert.ok(before.text.includes("Sent back. The marketing agent will see your note."));
    assert.deepEqual(buttons(before), ["Approve", "Archive", "Delete"]);
    assert.equal(before.buttons.find((b: { text: string }) => b.text === "Approve").disabled, false, "Approve works on a sent-back tile");
    assert.deepEqual(
      f.sentBackThenApprove.calls,
      [{ url: "/api/founders/marketing/assets/a1", method: "PATCH", body: { status: "approved" } }],
      "the same verdict request as ever; closing the open request for changes is the server's job",
    );
    assert.ok(!f.sentBackThenApprove.after.text.includes("Sent back."), "the notice does not outlive the next verdict");
    assert.deepEqual(buttons(f.sentBackThenApprove.after), ["Approved", "Archive", "Delete"]);
  });

  await check("the comparison says what it left out: a pack larger than the cap gets its 'showing the first N of M' line, a whole pack gets none", () => {
    const d = renderChild();
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.ok(text(d.compareNote).includes("Showing the first 4 of 9 variants in this pack, newest first."));
    assert.ok(!text(d.compare).includes("Showing the first"), "a whole pack says nothing about what is left out");
  });

  await check("the comparison follows its cards by id: a card that leaves mid-sequence never throws or points at the wrong clip", () => {
    const h = renderChild().hook;
    const playing = (s: { status: string; stop: boolean; order: boolean; together: boolean }, status: string) => {
      assert.equal(s.status, status);
      assert.equal(s.stop, true, "Stop is offered while something plays");
      assert.equal(s.order, true);
      assert.equal(s.together, false);
    };
    const idle = (s: { status: string; stop: boolean; order: boolean; together: boolean }, why: string) => {
      assert.equal(s.status, "", `${why}: the status line is empty`);
      assert.equal(s.stop, false, `${why}: no Stop over a page where nothing plays`);
      assert.equal(s.order, false, why);
      assert.equal(s.together, false, why);
    };
    // A sequence of four. A card AFTER the playing one leaves, then one BEFORE it: the position is the playing card's, looked up by id.
    playing(h.seqStart, "Playing Variant 1 (1 of 4).");
    assert.deepEqual(h.seqStart.log, ["play v1"]);
    playing(h.seqAfterLaterCardLeft, "Playing Variant 1 (1 of 3).");
    assert.deepEqual(h.seqAfterLaterCardLeft.videos, ["v1", "v2", "v4"]);
    playing(h.seqSecond, "Playing Variant 2 (2 of 3).");
    assert.ok(h.seqSecond.log.includes("play v2") && !h.seqSecond.log.some((l: string) => l.startsWith("play v3")), `the card that left is not played: ${h.seqSecond.log}`);
    playing(h.seqAfterEarlierCardLeft, "Playing Variant 2 (1 of 2).");
    playing(h.seqLast, "Playing Variant 4 (2 of 2).");
    assert.ok(h.seqLast.log.includes("play v4"));
    idle(h.seqDone, "the last clip ended");
    // The PLAYING card leaves: the sequence is over, and the page can start it again from the top.
    playing(h.gonePlaying, "Playing Variant 2 (2 of 4).");
    assert.equal(h.goneAfter.threw, null, "removing the playing card must not throw");
    idle(h.goneAfter, "the playing card left");
    assert.deepEqual(h.goneAfter.videos, ["v1", "v3", "v4"]);
    playing(h.goneRestart, "Playing Variant 1 (1 of 3).");
    // The last card plays and leaves: its old position is past the end of the list.
    assert.equal(h.lastGone.threw, null, "a position past the end of the list must not throw");
    idle(h.lastGone, "the last card left");
    // A card with no video is skipped, and the sequence ends after the last clip.
    playing(h.skipsNoVideo, "Playing Variant 3 (3 of 3).");
    assert.ok(h.skipsNoVideo.log.includes("play v3"));
    idle(h.skipEnd, "the last clip ended");
  });

  await check("'Play all together' is over when every clip has ended, or refused to play, or left the page", () => {
    const h = renderChild().hook;
    const together = "Playing all together, muted. Unmute one to hear it.";
    assert.deepEqual(h.togetherStart.log, ["play v1 muted", "play v2 muted", "play v3 muted"], "every clip that has a video starts, muted");
    assert.equal(h.togetherStart.status, together);
    assert.equal(h.togetherStart.stop, true);
    assert.equal(h.togetherStart.together, true);
    assert.equal(h.togetherStart.order, false);
    // Two of three ended: still going.
    assert.equal(h.togetherTwoEnded.status, together);
    assert.equal(h.togetherTwoEnded.stop, true);
    // The last one ended: idle, with the controls to match.
    assert.equal(h.togetherAllEnded.status, "", "nothing is playing, so the line says nothing");
    assert.equal(h.togetherAllEnded.stop, false, "no Stop once every clip has ended");
    assert.equal(h.togetherAllEnded.together, false, "and the button is no longer pressed");
    // It can be started again, and Stop ends it.
    assert.equal(h.togetherAgain.status, together);
    assert.deepEqual(h.togetherAgain.log, ["play v1 muted", "play v2 muted", "play v3 muted"]);
    assert.equal(h.togetherStopped.status, "");
    assert.equal(h.togetherStopped.stop, false);
    assert.ok(h.togetherStopped.log.includes("pause v1"), `Stop pauses what plays: ${h.togetherStopped.log}`);
    // A clip that refuses to play counts as done, so the others can finish the run.
    assert.equal(h.refusedStart.status, together, "the other two are still playing");
    assert.equal(h.refusedEnd.status, "", "v1 and v3 ended; v2 was refused and is not waited for");
    assert.equal(h.refusedEnd.stop, false);
    // A clip's card leaves the page: it is no longer waited for.
    assert.equal(h.togetherCardLeft.status, together);
    assert.equal(h.togetherCardLeftEnd.status, "");
    assert.equal(h.togetherCardLeftEnd.stop, false);
    // Every card leaves: nothing to wait for, nothing thrown.
    assert.equal(h.togetherEmpty.threw, null);
    assert.equal(h.togetherEmpty.status, "");
    assert.equal(h.togetherEmpty.stop, false);
  });

  await check("a clip whose link fails mid-run: renewed, it stays in the run; with no working link left, the run moves on (Codex on #706)", () => {
    const h = renderChild().hook;
    const together = "Playing all together, muted. Unmute one to hear it.";
    // A sequence: v1's link cannot be renewed, so v2 plays, never "Playing Variant 1" forever.
    assert.equal(h.linkGoneSeq.status, "Playing Variant 2 (2 of 3).");
    assert.ok(h.linkGoneSeq.log.includes("play v2"), `the next clip starts: ${h.linkGoneSeq.log}`);
    assert.ok(!h.linkGoneSeq.videos.includes("v1"), "v1 shows the plain line instead of a player");
    // All together: v2's first play failed on its link; renewed, it plays and the run waits for it.
    assert.ok(h.renewedTogetherStart.log.includes("play v2 muted"), `the renewed clip plays: ${h.renewedTogetherStart.log}`);
    assert.equal(h.renewedTogetherOneLeft.status, together, "v1 ended; the renewed v2 is still playing and still waited for");
    assert.equal(h.renewedTogetherOneLeft.stop, true);
    assert.equal(h.renewedTogetherEnd.status, "");
    assert.equal(h.renewedTogetherEnd.stop, false);
    // All together: v2's link has no working version left, so v1 ending ends the run.
    assert.equal(h.goneTogetherEnd.status, "");
    assert.equal(h.goneTogetherEnd.stop, false);
  });

  await check("wiring: no confirm(), no button reaches a publish or schedule endpoint, no video loads on arrival, nothing non-ASCII was added", () => {
    const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["components/founders/AssetActions.tsx", "components/founders/HookCompare.tsx"]) {
      assert.doesNotMatch(code(f), /\bconfirm\(|window\.confirm|\balert\(/, `${f}: the browser's own dialog does not work in this app's views`);
      const urls = [...code(f).matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
      for (const u of urls) {
        assert.match(u, /^\/api\/founders\/marketing\/assets\/\$\{id\}(\/request-changes)?$/, `${f}: ${u}`);
      }
      assert.doesNotMatch(code(f), /from "[^"]*(publish|schedul|late|zernio)[^"]*"/i, `${f}: a verdict never imports anything that posts or books`);
    }
    assert.ok([...code("components/founders/AssetActions.tsx").matchAll(/fetch\(/g)].length === 3, "approve/archive/restore, delete, request changes - and no other request");
    const compare = code("components/founders/HookCompare.tsx");
    assert.equal((compare.match(/<video\b/g) ?? []).length, 1);
    assert.match(compare, /preload="none"/);
    assert.doesNotMatch(compare, /preload="(metadata|auto)"/);
    // Text that cannot break (a pack id with no spaces, a hook with none) wraps instead of pushing a phone-width page wider.
    assert.match(compare, /<h2 className="[^"]*\bbreak-words\b/, "the heading wraps");
    assert.match(compare, /<blockquote className="[^"]*\bbreak-words\b/, "the hook line wraps");
    assert.match(code("app/founders/marketing/library/page.tsx"), /const base = "[^"]*\bmax-w-full \[overflow-wrap:anywhere\]/, "the pills wrap, flex items included");
    // The route's guards, in the order they must run: the founders gate, the id, the body, the note.
    const route = code("app/api/founders/marketing/assets/[id]/request-changes/route.ts");
    const at = (re: RegExp) => route.search(re);
    const gate = /const founder = await resolveFounder\(\);\s*if \(!founder\) return notFound\(\);/;
    assert.match(route, gate, "the founders gate, answering 404");
    assert.match(code("app/api/founders/marketing/assets/[id]/route.ts"), gate, "and it is the very gate the sibling verbs open with");
    assert.ok(at(gate) >= 0 && at(gate) < at(/req\.json\(\)/), "the founders gate runs before the body is read");
    assert.doesNotMatch(route, /api-auth|role-surfaces|resolvePersona|resolveSessionContext|isTrueAdmin|forbidden|403/, "no check beyond the siblings' own gate");
    assert.ok(at(/req\.json\(\)/) < at(/checkRequestChangesBody\(/) && at(/checkRequestChangesBody\(/) < at(/requestChanges\(\s*getServiceSupabase/), "the note is checked before any database work");
    assert.match(route, /tenantId: founder\.tenantId/, "the workspace comes from the verified founder, never from the request");
    const lib = code("lib/founders/request-changes.ts");
    const reads = [...lib.matchAll(/\.from\("(marketing_[a-z_]+)"\)([\s\S]*?)(?=\n\s*(?:const|if|return|\}|\/\/)|$)/g)];
    assert.ok(reads.length >= 5, `found ${reads.length} statements`);
    for (const [stmt, table] of reads) {
      if (table === "marketing_event") assert.match(stmt, /tenant_id: tenantId/, "the activity row carries its workspace");
      else assert.match(stmt, /\.eq\("tenant_id", tenantId\)|tenant_id: tenantId/, `${table}: a statement with no workspace\n${stmt}`);
    }
    // What this change added is ASCII: no em dash, no arrow, no smart quote.
    for (const f of [
      "lib/founders/library-meta.ts", "lib/founders/request-changes.ts", "components/founders/HookCompare.tsx",
      "components/founders/MetaBadges.tsx", "app/api/founders/marketing/assets/[id]/request-changes/route.ts",
      "tests/library-review.test.ts", "tests/library-review.render.ts",
    ]) {
      assert.doesNotMatch(read(f), /[^\x00-\x7F]/, `${f} holds a non-ASCII character`);
    }
  });

  finish("library-review");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
