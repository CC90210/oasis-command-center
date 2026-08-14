/**
 * An asset reports where it ACTUALLY went.
 * Run: node --conditions=react-server --import tsx tests/asset-platforms.test.ts
 *
 * CC, 2026-08-14: *"it's only posting to Instagram."* Every tile read INSTAGRAM
 * because `marketing_asset.channel` holds ONE value and a queue item goes to as
 * many as six platforms — so a six-platform post had no channel it could
 * honestly declare and took 'organic-instagram'. The true list survived only in
 * a media label.
 *
 * `channel` still means the PRIMARY channel and still feeds the generated
 * `track` column the Studio pipeline groups by. `platforms` carries the
 * distribution, stamped by the drain with the platforms that ACCEPTED the post.
 *
 * Widening the channel CHECK was the obvious-looking fix and would not have
 * worked: one column cannot hold six values, so it would have moved the wrong
 * answer rather than corrected it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePlatforms, platformLabel } from "../lib/founders-marketing-core";

const ROOT = join(__dirname, "..");

// ── the reader takes whatever the driver hands back ─────────────────────────
// Turso stores TEXT holding JSON; a jsonb path would hand back a real array.
assert.deepEqual(parsePlatforms('["instagram","linkedin"]'), ["instagram", "linkedin"]);
assert.deepEqual(parsePlatforms(["tiktok", "threads"]), ["tiktok", "threads"]);
assert.deepEqual(parsePlatforms("[]"), []);
assert.deepEqual(parsePlatforms(null), []);
assert.deepEqual(parsePlatforms(undefined), []);
assert.deepEqual(parsePlatforms(""), []);

// Malformed must not throw. Losing the platform list cannot cost the caller the
// whole asset — the same rule the publish-intent reader follows.
assert.deepEqual(parsePlatforms("{not json"), [], "a malformed value degrades to empty, never throws");
assert.deepEqual(parsePlatforms('"instagram"'), [], "a bare JSON string is not a list");
assert.deepEqual(parsePlatforms("[1,2,3]"), [], "non-string entries are dropped, not rendered as numbers");
assert.deepEqual(parsePlatforms('["ok",5,null]'), ["ok"], "mixed arrays keep only the strings");

// ── labels ──────────────────────────────────────────────────────────────────
assert.equal(platformLabel("twitter"), "X");
assert.equal(platformLabel("x"), "X", "both keys render as X — the network renamed, the data did not");
assert.equal(platformLabel("linkedin"), "LinkedIn");
assert.equal(
  platformLabel("some_new_network"),
  "some_new_network",
  "an unknown platform shows its key rather than vanishing — a silent blank is how you " +
    "stop noticing a channel exists",
);

// ── the surfaces actually read it ───────────────────────────────────────────
// Source-level, because the alternative is rendering React in a node test; the
// point is that a future edit cannot quietly go back to channel-only.
{
  const tile = readFileSync(join(ROOT, "components/founders/marketing-shared.tsx"), "utf8");
  assert.match(tile, /parsePlatforms/, "the tile must read the platform list");

  // EXISTENCE BEFORE ORDER. `indexOf` returns -1 when the marker is absent, and
  // -1 is less than every real index — so the ordering check alone PASSED with
  // the bug reintroduced (tile back to channel-only). Caught by breaking it on
  // purpose; the assertion was vacuous exactly where it mattered most.
  const preferIdx = tile.indexOf("platforms.length > 0");
  const fallbackIdx = tile.indexOf("channelLabel(channel)");
  assert.notEqual(
    preferIdx,
    -1,
    "the tile must branch on the platform list — without this it renders the primary " +
      "channel for everything, which is CC's \"it's only posting to Instagram\"",
  );
  assert.notEqual(fallbackIdx, -1, "the tile must still fall back to the channel label");
  assert.ok(
    preferIdx < fallbackIdx,
    "the tile must PREFER the real distribution and fall back to channel, not the reverse",
  );

  const detail = readFileSync(join(ROOT, "app/founders/marketing/asset/[id]/page.tsx"), "utf8");
  assert.match(detail, /parsePlatforms\(asset\.platforms\)/, "the detail page must show where it went");

  const lib = readFileSync(join(ROOT, "app/founders/marketing/library/page.tsx"), "utf8");
  assert.match(lib, /platforms=\{asset\.platforms\}/, "the library must pass platforms into the tile");
}

// ── the rule would catch a regression ───────────────────────────────────────
{
  const before = "{channelLabel(channel)}";
  assert.ok(!/parsePlatforms/.test(before), "the pre-fix markup has no platform read — the matcher is real");
}

console.log("asset-platforms: ok — distribution is reported from platforms, channel is the fallback");
