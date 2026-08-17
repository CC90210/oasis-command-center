/**
 * A carousel is ONE post with N slides, in order.
 * Run: node --conditions=react-server --import tsx tests/asset-carousel.test.ts
 *
 * WHAT WAS ACTUALLY WRONG (measured, 2026-08-14)
 * Six carousels sat in the Library as one row each with EXACTLY ONE media row.
 * The other four slides of each were rendered and never uploaded — they were on
 * disk at CMO-Agent/output/carousels/<slug>/slide_1..5.png with a manifest
 * listing all five. The "01/05 · swipe →" a reviewer saw was artwork printed on
 * the cover, promising slides the database had never held.
 *
 * NOT "split rows needing grouping". The six 4:5 rows sharing the "OASIS Oasis"
 * title prefix are six DIFFERENT posts — ai-myths, manual-ops-cost,
 * owner-dependency, repetition-01, tried-and-failed, what-we-automate. Grouping
 * by title prefix would have collapsed six campaigns into one and lost five.
 * That is why the migration reads manifests and this test pins the predicate
 * rather than any title rule.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isRenderableCarousel, parseSlideUrls, ASSET_TYPES } from "../lib/founders-marketing-core";

const ROOT = join(__dirname, "..");

// ── claiming to be a carousel is not being one ──────────────────────────────
// This is the exact state the Library was in before the backfill: asset_type
// would say carousel while one slide was registered. Rendering a "carousel" of
// one is how the cover art ends up lying about four missing slides again.
assert.equal(isRenderableCarousel("carousel", ["a", "b"]), true);
assert.equal(
  isRenderableCarousel("carousel", ["a"]),
  false,
  "one slide is not a carousel, whatever the row claims",
);
assert.equal(isRenderableCarousel("carousel", []), false, "zero slides is not a carousel");
assert.equal(isRenderableCarousel("single_image", ["a", "b"]), false, "type must agree too");
assert.equal(isRenderableCarousel("video", ["a", "b"]), false, "a video is never a carousel");
assert.equal(isRenderableCarousel(null, ["a", "b"]), false, "a missing type is not a carousel");

// ── slide order is the payload ──────────────────────────────────────────────
// A carousel read out of order is a different post, so the reader must preserve
// the recorded order exactly — never sort, never dedupe.
{
  const raw = '["t/3.png","t/1.png","t/2.png"]';
  assert.deepEqual(
    parseSlideUrls(raw),
    ["t/3.png", "t/1.png", "t/2.png"],
    "the stored order is the truth — the migration recorded it from the manifest",
  );
  assert.deepEqual(parseSlideUrls(["a", "a"]), ["a", "a"], "duplicates are preserved, not collapsed");
}

// Same tolerance as every other JSON-array column on this backend: Turso hands
// back TEXT, a jsonb path hands back an array, and a malformed value must not
// cost the caller the whole asset.
assert.deepEqual(parseSlideUrls(["x"]), ["x"]);
assert.deepEqual(parseSlideUrls("{not json"), []);
assert.deepEqual(parseSlideUrls(null), []);
assert.deepEqual(parseSlideUrls("[1,2]"), [], "non-string entries are dropped");

// ── the vocabulary is closed here, not in the database ──────────────────────
// marketing_asset.channel's CHECK is the cautionary tale: SQLite cannot widen
// one without a full table rebuild, so asset_type is validated in code where it
// can change with a deploy.
assert.deepEqual([...ASSET_TYPES], ["video", "single_image", "carousel"]);

// ── both surfaces actually render it ────────────────────────────────────────
{
  // MATCH THE CALL, NOT THE IMPORT. `/isRenderableCarousel/` alone passes on a
  // file that only imports it — which it did, when the call was replaced with
  // `false` on purpose to check this test. An identifier in an import list
  // proves nothing about whether anything branches on it.
  const tile = readFileSync(join(ROOT, "components/founders/marketing-shared.tsx"), "utf8");
  assert.match(
    tile,
    /isRenderableCarousel\(\s*assetType\s*,\s*slides\s*\)/,
    "the tile must CALL the predicate with the asset type and its slides, not merely import it",
  );
  assert.match(tile, /<CarouselFrame/, "the tile must render the carousel component");

  const detail = readFileSync(join(ROOT, "app/founders/marketing/asset/[id]/page.tsx"), "utf8");
  assert.match(
    detail,
    /isRenderableCarousel\(\s*asset\.asset_type\s*,\s*slideUrls\s*\)/,
    "the detail page must call it too, with the asset's own type and slides",
  );
  assert.match(detail, /parseSlideUrls\(asset\.media_urls\)/, "the detail page reads media_urls");

  const lib = readFileSync(join(ROOT, "app/founders/marketing/library/page.tsx"), "utf8");
  assert.match(lib, /slideUrls=\{slideUrls\}/, "the library must pass signed slides into the tile");
  assert.match(
    lib,
    /parseSlideUrls\(a\.media_urls\)/,
    "slides come from media_urls — NOT re-derived from media rows, whose order means nothing",
  );

  const frame = readFileSync(join(ROOT, "components/founders/CarouselFrame.tsx"), "utf8");
  assert.ok(
    !/\.sort\(|\.reverse\(/.test(frame),
    "CarouselFrame must never reorder slides — it receives them in order and renders them in order",
  );
  assert.match(frame, /aria-roledescription="carousel"/, "the strip is announced as a carousel");
}

// ── the guard would catch a regression ──────────────────────────────────────
// Existence before order: `indexOf` returning -1 is less than every real index,
// which made an earlier ordering assertion vacuous exactly where it mattered.
{
  const before = "{playbackUrl && format === \"video\" ? (";
  assert.ok(
    !/isRenderableCarousel/.test(before),
    "the pre-fix media branch has no carousel read — the matcher is real",
  );
}

console.log("asset-carousel: ok — one post, N slides, order preserved, claim is not proof");
