/**
 * Pure logic for the founders-portal Marketing hub.
 * Run: npx tsx tests/marketing-core.test.ts
 */
import assert from "node:assert/strict";
import {
  CHANNELS,
  DECISIONS,
  buildMediaPath,
  channelBreadcrumb,
  channelsForTrack,
  countByTrack,
  decisionRequiresNote,
  emptyCounts,
  fmtBytes,
  fmtDuration,
  freshnessLabel,
  isChannel,
  isDecision,
  isProvisional,
  sanitizeStorageFilename,
  statusAfterDecision,
  trackForChannel,
  trainingWeight,
  type Channel,
} from "../lib/founders-marketing-core";

// ── taxonomy is closed and total ─────────────────────────────────────
// Every channel must map to a track. A missing entry would make track
// undefined, which the DB CHECK would then reject at write time.
for (const c of CHANNELS) {
  const t = trackForChannel(c);
  assert.ok(
    ["organic", "paid", "seo", "email"].includes(t),
    `channel ${c} maps to a valid track (got ${t})`,
  );
  assert.ok(channelBreadcrumb(c).includes("·"), `${c} renders a breadcrumb`);
}

assert.equal(trackForChannel("organic-tiktok"), "organic");
assert.equal(trackForChannel("paid-meta"), "paid");
assert.equal(trackForChannel("seo-landing"), "seo");
assert.equal(trackForChannel("email"), "email");

// The four tracks partition the channel set exactly — no channel is orphaned
// and none is double counted.
const partitioned = (["organic", "paid", "seo", "email"] as const).flatMap((t) =>
  channelsForTrack(t),
);
assert.equal(partitioned.length, CHANNELS.length, "tracks partition all channels");
assert.equal(new Set(partitioned).size, CHANNELS.length, "no channel appears twice");

assert.equal(isChannel("organic-instagram"), true);
assert.equal(isChannel("organic-linkedin"), false, "unknown channel refused");
assert.equal(isChannel(null), false);
assert.equal(isChannel(42), false);

// ── review policy ────────────────────────────────────────────────────
// A verdict that rejects or asks for changes without saying why teaches the
// agent nothing. Mirrored by a CHECK constraint in migration 133.
assert.equal(decisionRequiresNote("request_changes"), true);
assert.equal(decisionRequiresNote("reject"), true);
assert.equal(decisionRequiresNote("approve_with_changes"), true);
assert.equal(decisionRequiresNote("approve"), false);
assert.equal(decisionRequiresNote("comment"), false);

for (const d of DECISIONS) assert.equal(isDecision(d), true, `${d} is a decision`);
assert.equal(isDecision("maybe"), false);

assert.equal(statusAfterDecision("approve", "draft"), "approved");
assert.equal(statusAfterDecision("approve_with_changes", "draft"), "approved");
assert.equal(statusAfterDecision("reject", "in_review"), "rejected");
assert.equal(statusAfterDecision("request_changes", "in_review"), "draft");
// A comment is not a verdict — it must not move the asset.
assert.equal(statusAfterDecision("comment", "scheduled"), "scheduled");
assert.equal(statusAfterDecision("comment", "published"), "published");

// ── training weight inverts the naive ranking ────────────────────────
// This is the design thesis: a rejection with a reason is worth more than an
// approval, because it locates a boundary. If this ever flips, the corpus
// starts optimising for agreement instead of learning.
assert.ok(
  trainingWeight("request_changes") > trainingWeight("approve"),
  "a change request outranks an approval",
);
assert.ok(trainingWeight("reject") > trainingWeight("approve"), "a rejection outranks an approval");
assert.ok(
  trainingWeight("request_changes") >= trainingWeight("reject"),
  "the most specific signal ranks highest",
);
assert.equal(
  Math.min(...DECISIONS.map(trainingWeight)),
  trainingWeight("approve"),
  "approval is the weakest signal of all",
);

// ── formatting ───────────────────────────────────────────────────────
assert.equal(fmtBytes(0), "");
assert.equal(fmtBytes(null), "");
assert.equal(fmtBytes(2048), "2 KB");
assert.equal(fmtBytes(1_048_576), "1.0 MB");
assert.equal(fmtBytes(1_073_741_824), "1.0 GB");
// A 1-byte file should not render as "0 KB" and read as empty.
assert.equal(fmtBytes(1), "1 KB");

assert.equal(fmtDuration(null), "");
assert.equal(fmtDuration(0), "");
assert.equal(fmtDuration(27), "0:27");
assert.equal(fmtDuration(95), "1:35");
assert.equal(fmtDuration(600), "10:00");
assert.equal(fmtDuration(Number.NaN), "");

// ── freshness ────────────────────────────────────────────────────────
const now = new Date("2026-08-02T12:00:00Z");
assert.equal(freshnessLabel(null, now), "never");
assert.equal(freshnessLabel("not-a-date", now), "unknown");
assert.equal(freshnessLabel("2026-08-02T11:59:30Z", now), "just now");
assert.equal(freshnessLabel("2026-08-02T11:30:00Z", now), "30m ago");
assert.equal(freshnessLabel("2026-08-02T09:00:00Z", now), "3h ago");
assert.equal(freshnessLabel("2026-07-30T12:00:00Z", now), "3d ago");
// Clock skew must not render as a negative age.
assert.equal(freshnessLabel("2026-08-02T12:05:00Z", now), "just now");

// ── GSC provisional window ───────────────────────────────────────────
// Search Console data is not final for 2-4 days. Rendering it as settled is how
// a normal reporting lag gets read as a traffic collapse.
assert.equal(isProvisional("gsc-api", "2026-08-01", now), true, "yesterday is provisional");
assert.equal(isProvisional("gsc-api", "2026-07-20", now), false, "two weeks ago is final");
assert.equal(isProvisional("meta-api", "2026-08-01", now), false, "only GSC has this lag");
assert.equal(isProvisional("gsc-api", "garbage", now), false, "unparseable date is not provisional");

// ── counting ─────────────────────────────────────────────────────────
assert.deepEqual(countByTrack([]), emptyCounts(), "no rows yields all-zero counts");
assert.deepEqual(
  countByTrack([
    { track: "organic" },
    { track: "organic" },
    { track: "paid" },
    { track: "nonsense" },
  ]),
  { organic: 2, paid: 1, seo: 0, email: 0 },
  "unknown tracks are ignored, not counted into a real bucket",
);

// ── storage paths ────────────────────────────────────────────────────
// A client must never be able to steer the path. Traversal, separators and
// control characters all have to be neutralised before they reach Storage.
assert.equal(sanitizeStorageFilename("hook v3.mp4"), "hook_v3.mp4");
assert.equal(sanitizeStorageFilename("../../etc/passwd"), "etc_passwd");
assert.equal(sanitizeStorageFilename("a/b\\c.mov"), "a_b_c.mov");
assert.equal(sanitizeStorageFilename(""), "file");
assert.ok(!sanitizeStorageFilename("...hidden").startsWith("."), "leading dots stripped");
assert.ok(sanitizeStorageFilename("x".repeat(300)).length <= 120, "length is bounded");

const path = buildMediaPath("tenant-1", "asset-9", "My Reel.mp4", 1_700_000_000_000, "uuid");
assert.equal(path, "tenant-1/asset-9/1700000000000_uuid_My_Reel.mp4");
assert.ok(path.startsWith("tenant-1/"), "tenant id is the first path segment");
assert.ok(
  !buildMediaPath("t", "a", "../escape.mp4", 1, "").includes(".."),
  "traversal cannot survive into the storage path",
);

// exhaustiveness guard: a newly added channel with no label will fail the
// breadcrumb assertion above, so this cast is the only place the union is widened
const sample: Channel = "paid-google";
assert.equal(trackForChannel(sample), "paid");

console.log("marketing-core: all assertions passed");
