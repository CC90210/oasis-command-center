/**
 * Pure logic for the founders-portal Marketing hub.
 * Run: npx tsx tests/marketing-core.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getMarketingSummary } from "../lib/founders/marketing-queries";
import { join } from "node:path";
import {
  CHANNELS,
  DECISIONS,
  FOUNDERS_OWN_BRAND,
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
  isOwnBrand,
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

// The library's channel-filter row is driven by channelsForTrack(). A prior
// version hand-rolled `CHANNELS.filter(c => c.startsWith(track))`, which only
// worked because every channel name currently happens to begin with its track
// name. Renaming one channel would have silently emptied a filter row. These
// assertions pin the real mapping as the basis.
assert.deepEqual(channelsForTrack("organic"), [
  "organic-instagram",
  "organic-facebook",
  "organic-tiktok",
  "organic-youtube",
]);
assert.deepEqual(channelsForTrack("paid"), ["paid-meta", "paid-google"]);
assert.deepEqual(channelsForTrack("seo"), ["seo-article", "seo-landing"]);
// email is a single-channel track, which is why the UI shows the channel row
// only when there is more than one option — otherwise it renders a row with one
// pill that does nothing.
assert.deepEqual(channelsForTrack("email"), ["email"]);
assert.equal(channelsForTrack("email").length, 1, "email needs no channel sub-filter");
for (const t of ["organic", "paid", "seo"] as const) {
  assert.ok(channelsForTrack(t).length > 1, `${t} shows a channel sub-filter`);
}
// Drilling into a channel must resolve back to its track, so the track pill
// stays lit and the channel row stays mounted (the dead-end bug: selecting a
// channel used to unmount the row, leaving no way to switch or clear it).
for (const c of CHANNELS) {
  const t = trackForChannel(c);
  assert.ok(
    channelsForTrack(t).includes(c),
    `${c} must appear in its own track's channel list, or drilling in unmounts the filter`,
  );
}

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

// ── the founders portal shows OUR OWN work ───────────────────────────
// docs/PORTALS.md: founders is "OASIS's own tooling. Not a tenant surface."
// The library was rendering every brand on the founders tenant, so four client
// deliverables (Warner x2, Arthrisil, blyss) sat beside OASIS's own nine and CC
// read it as a leak. It was not one — every row is on the founders tenant and
// each reader carries .eq("tenant_id", ...) — but client work is not our own
// marketing, and the portal that promises "not a tenant surface" is the wrong
// place to review a client's ad.
assert.equal(FOUNDERS_OWN_BRAND, "oasis-ai");
assert.ok(isOwnBrand("oasis-ai"), "OASIS AI is our own work");
assert.ok(!isOwnBrand("warner"), "a client brand is not our own work");
assert.ok(!isOwnBrand("arthrisil"), "a client brand is not our own work");
assert.ok(!isOwnBrand("blyss"), "a client brand is not our own work");
assert.ok(!isOwnBrand(null) && !isOwnBrand(undefined) && !isOwnBrand(""),
  "an unbranded row is not assumed to be ours");

// The readers scope on this constant, so a rename that misses marketing-queries
// would silently empty the library rather than fail loudly. Pin the literal.
{
  const queries = readFileSync(
    join(process.cwd(), "lib/founders/marketing-queries.ts"), "utf8");
  assert.ok(queries.includes("FOUNDERS_OWN_BRAND"),
    "marketing-queries must scope to FOUNDERS_OWN_BRAND");
  const scoped = queries.split("from(\"marketing_asset\")").length - 1;
  const guards = queries.split("FOUNDERS_OWN_BRAND").length - 1;
  assert.ok(guards >= scoped - 1,
    `every marketing_asset read should be brand-scoped or explicitly widened ` +
    `(${scoped} reads, ${guards} guards)`);
  // The brand filter must NOT be honoured outside the widened scope, or
  // ?brand=warner walks straight past the boundary.
  assert.ok(queries.includes('if (opts.scope === "all")'),
    "a caller must opt in explicitly to see anything but our own work");
}

// ── the brand boundary, exercised against DATA rather than source text ────────
// The token-counting checks above cannot see WHICH ROWS a count includes, and
// that is exactly where the boundary was half-applied: `total` was scoped to
// oasis-ai while open_reviews / open_requests were scoped only by tenant. The
// founders Studio would have said "9 assets, 3 waiting on you" with the 3 being
// Warner's — worse than unscoped, because it looks right.
//
// getMarketingSummary takes an injectable client for exactly this. The fake below
// records the filter chain and replays fixtures, so these assertions describe
// behaviour rather than spelling.
//
// Wrapped in an async fn, not top-level await: these run as CJS under tsx.
type FakeCall = { table: string; filters: Array<[string, unknown]> };

async function brandBoundaryChecks() {
  const OWN = ["own-1", "own-2"];
  const CLIENT = "warner-1";
  const calls: FakeCall[] = [];

  const fixtures = {
    assets: [
      { id: OWN[0], track: "organic", status: "in_review", brand_slug: "oasis-ai" },
      { id: OWN[1], track: "paid", status: "draft", brand_slug: "oasis-ai" },
      { id: CLIENT, track: "paid", status: "in_review", brand_slug: "warner" },
    ],
    reviews: [
      { asset_id: OWN[0], acted_on_at: null as string | null },
      { asset_id: CLIENT, acted_on_at: null as string | null },      // a client's — not ours
      { asset_id: OWN[1], acted_on_at: "2026-08-01" as string | null }, // already acted on
    ],
    requests: [
      { asset_id: OWN[0] as string | null, status: "open" },
      { asset_id: CLIENT as string | null, status: "open" },   // a client's — not ours
      { asset_id: null as string | null, status: "claimed" },  // unbound: typed into OUR portal
      { asset_id: OWN[1] as string | null, status: "done" },   // closed
    ],
  };

  const makeTable = (table: string) => {
    const call: FakeCall = { table, filters: [] };
    calls.push(call);
    let head = false;
    const has = (k: string) => call.filters.some(([f]) => f === k);
    const val = (k: string) => call.filters.find(([f]) => f === k)?.[1];
    const api: Record<string, unknown> = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        head = Boolean(opts?.head);
        return api;
      },
      eq(col: string, v: unknown) { call.filters.push([`eq:${col}`, v]); return api; },
      is(col: string, v: unknown) { call.filters.push([`is:${col}`, v]); return api; },
      in(col: string, v: unknown) { call.filters.push([`in:${col}`, v]); return api; },
      then(resolve: (v: unknown) => void) {
        let rows: unknown[] = [];
        if (table === "marketing_asset") {
          rows = fixtures.assets.filter((a) => a.brand_slug === val("eq:brand_slug"));
        } else if (table === "marketing_review") {
          rows = fixtures.reviews.filter(
            (r) =>
              r.acted_on_at === null &&
              (!has("in:asset_id") || (val("in:asset_id") as string[]).includes(r.asset_id)),
          );
        } else if (table === "marketing_request") {
          rows = fixtures.requests.filter(
            (r) =>
              ["open", "claimed"].includes(r.status) &&
              (!has("is:asset_id") || r.asset_id === null) &&
              (!has("in:asset_id") ||
                (r.asset_id !== null && (val("in:asset_id") as string[]).includes(r.asset_id))),
          );
        }
        resolve(head ? { error: null, count: rows.length } : { error: null, data: rows });
      },
    };
    return api;
  };

  const db = { from: makeTable } as unknown as Parameters<typeof getMarketingSummary>[1];
  const summary = await getMarketingSummary("tenant-founders", db);

  assert.equal(summary.total, 2, "only OASIS's own assets are counted");
  assert.equal(
    summary.open_reviews,
    1,
    "an open review on a CLIENT asset must not appear in the founders count — " +
      "this is the assertion the source-text checks could not make",
  );
  assert.equal(
    summary.open_requests,
    2,
    "own-asset request + unbound request; a client-asset request is excluded",
  );

  // The scoping must reach the DB, not be applied in JS after an unscoped read.
  const reviewCall = calls.find((c) => c.table === "marketing_review");
  assert.ok(reviewCall, "the summary must query marketing_review");
  assert.ok(
    reviewCall!.filters.some(([f]) => f === "in:asset_id"),
    "the review count must be pushed down as .in(asset_id, ownAssetIds)",
  );
  assert.ok(
    reviewCall!.filters.some(([f, v]) => f === "eq:tenant_id" && v === "tenant-founders"),
    "and must still be tenant-scoped",
  );

  // A tenant with no own-brand assets must not fall back to counting everything.
  // The empty set is a real answer, and an empty `.in()` list is the trap: the
  // guard has to skip the query, not send `.in(asset_id, [])` and hope.
  const emptyDb = {
    from(table: string) {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        is: () => api,
        in: () => api,
        then: (resolve: (v: unknown) => void) =>
          resolve({ error: null, data: [], count: table === "marketing_request" ? 7 : 99 }),
      };
      return api;
    },
  } as unknown as Parameters<typeof getMarketingSummary>[1];

  const empty = await getMarketingSummary("tenant-empty", emptyDb);
  assert.equal(empty.total, 0);
  assert.equal(empty.open_reviews, 0, "no own assets means no own reviews, not every review");
  assert.equal(
    empty.open_requests,
    7,
    "with no own assets only UNBOUND requests remain ours (7 from the stub), " +
      "not the tenant-wide total",
  );
}

brandBoundaryChecks().then(
  () => console.log("marketing-core: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

