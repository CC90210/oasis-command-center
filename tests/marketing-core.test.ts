/**
 * Pure logic for the founders-portal Marketing hub.
 * Run: npx tsx tests/marketing-core.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEGRADED_MARKETING_SUMMARY,
  EMPTY_MARKETING_SUMMARY,
  getMarketingSummary,
} from "../lib/founders/marketing-queries";
import { join } from "node:path";
import {
  BRAND_GROUPS,
  CHANNELS,
  DECISIONS,
  LIFECYCLE,
  distributionOf,
  isLifecycle,
  lifecycleHint,
  lifecycleLabel,
  lifecycleOf,
  postPermalink,
  DEFAULT_BRAND_GROUP,
  FOUNDERS_OWN_BRAND,
  PUBLISH_STALE_AFTER_MINUTES,
  brandFilterAllowed,
  brandGroup,
  brandGroupFor,
  claimedBrandSlugs,
  isBrandGroupKey,
  stalePublishWarning,
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
  // Every row-returning read must route through the ONE scoping helper rather
  // than hand-rolling a `.eq("brand_slug", ...)`. That is what makes the
  // behavioural assertions further down cover all of them at once.
  assert.ok(queries.includes("function scopeToBrandGroup"),
    "the brand boundary must live in one helper, not be re-derived per call site");
  assert.ok(queries.includes("scopeToBrandGroup(q, group)"),
    "getMarketingAssets must scope rows through the helper");
  // The sub-filter must be gated. A bare `if (opts.brand) q = q.eq(...)` is the
  // hole: ?group=oasis-ai&brand=warner would then put a client's ad on our tab.
  assert.ok(queries.includes("brandFilterAllowed(opts.brand, group)"),
    "the ?brand= sub-filter must be checked against the active tab before it is applied");

  // `status` and `lifecycle` filter the SAME column with different vocabularies.
  // Applying both ANDs them into a contradiction that matches nothing, so the
  // grid reads "Nothing at this stage" beneath pills showing real counts — and
  // it is two clicks away (arrive from a Studio pipeline tile, press a pill).
  assert.ok(queries.includes("if (opts.status && !opts.lifecycle)"),
    "status must yield to lifecycle — ANDing two vocabularies for one column " +
    "produces an unreachable-empty grid with no visible cause");
}

// ── brand GROUPS: the tab taxonomy CC asked for on 2026-08-16 ────────────────
{
  // Every named group's own slugs must resolve back to it, or a tab shows rows
  // from somewhere else.
  for (const g of BRAND_GROUPS) {
    for (const slug of g.slugs || []) {
      assert.equal(brandGroupFor(slug), g.key, `${slug} must resolve to the ${g.key} tab`);
    }
  }

  // Exactly one residual group. Two would make brandGroupFor order-dependent;
  // none would let an unclaimed slug fall through to no tab at all, which is the
  // invisible-asset bug this taxonomy exists to prevent.
  assert.equal(
    BRAND_GROUPS.filter((g) => g.slugs === null).length,
    1,
    "exactly one residual group, or an unclaimed brand renders in zero tabs (or two)",
  );

  // No slug may be claimed twice — brandGroupFor takes the first match, so a
  // duplicate would silently hide rows in whichever tab lost the race.
  const claimed = claimedBrandSlugs();
  assert.equal(new Set(claimed).size, claimed.length, "no brand slug may be claimed by two groups");

  // THE RESIDUAL PROPERTY, which is the whole reason Clients is not a list.
  // A client Maven registers tomorrow must land in a tab WITHOUT a deploy here.
  // If someone later "tidies" this into slugs: ["warner","blyss","arthrisil"],
  // this is the assertion that stops them.
  assert.equal(brandGroupFor("warner"), "clients");
  assert.equal(brandGroupFor("blyss"), "clients");
  assert.equal(brandGroupFor("arthrisil"), "clients");
  assert.equal(brandGroupFor("a-client-registered-tomorrow"), "clients",
    "an unknown brand must fall into the residual tab, never into none");
  assert.equal(brandGroupFor(null), "clients");
  assert.equal(brandGroupFor(undefined), "clients");
  assert.equal(brandGroupFor(""), "clients");

  // The default tab is OASIS's own work — widening the taxonomy must not change
  // what the page opens on.
  assert.equal(DEFAULT_BRAND_GROUP, FOUNDERS_OWN_BRAND);
  assert.ok(isBrandGroupKey("clients") && isBrandGroupKey("oasis-ai"));
  assert.ok(!isBrandGroupKey("warner"), "a brand slug is not a group key");
  assert.ok(!isBrandGroupKey("") && !isBrandGroupKey(null) && !isBrandGroupKey(undefined));

  // ── the sub-filter may narrow a tab, never cross one ───────────────────────
  // This is the security-shaped half. ?brand= arrives from the URL and a founder
  // can type anything into it.
  assert.ok(brandFilterAllowed("warner", "clients"), "a client narrows the Clients tab");
  assert.ok(brandFilterAllowed("oasis-ai", "oasis-ai"));
  assert.equal(brandFilterAllowed("warner", "oasis-ai"), false,
    "?group=oasis-ai&brand=warner must NOT put a client's ad on the OASIS tab");
  assert.equal(brandFilterAllowed("oasis-ai", "clients"), false,
    "and the reverse must not pull our own work onto the Clients tab");
  assert.equal(brandFilterAllowed("conaugh", "music"), false);

  // Every group must be renderable: a tab with no label or no empty-state copy
  // ships a blank string to the screen.
  for (const g of BRAND_GROUPS) {
    assert.ok(g.label.trim().length > 0, `${g.key} needs a label`);
    assert.ok(g.empty.trim().length > 0, `${g.key} needs empty-state copy`);
    assert.equal(brandGroup(g.key), g, "brandGroup must round-trip its own key");
  }
}

// ── lifecycle: review state and distribution state are different questions ───
// CC, 2026-08-16: "Are these videos that we haven't posted yet? ... Have they
// not been posted at all, ever?" He could not tell, because `status` conflates
// "has CC ruled on it" with "did it go out".
{
  // DISTRIBUTION IS EVIDENCE-ONLY. `platforms` was backfilled from `channel` and
  // holds single-element copies of it, so it records intent and must never count
  // as proof of delivery. This is the assertion that stops someone "improving"
  // lifecycleOf by reading it.
  assert.equal(distributionOf({ published_at: null }), "never_posted");
  assert.equal(distributionOf({ published_at: "2026-08-01T00:00:00Z" }), "live");
  assert.equal(distributionOf({ published_at: null, analytics_posts: 3 }), "live",
    "a linked analytics row is proof a platform accepted it");
  assert.equal(distributionOf({ published_at: null, analytics_posts: 0 }), "never_posted");

  // THE WORLD OUTRANKS THE BOOKKEEPING. An asset that demonstrably went out is
  // Posted even while its status column still says in_review — which is the
  // exact state library_sync.py leaves rows in.
  assert.equal(lifecycleOf({ status: "in_review", published_at: "2026-08-01T00:00:00Z" }), "live");
  assert.equal(lifecycleOf({ status: "draft", published_at: null, analytics_posts: 2 }), "live");

  assert.equal(lifecycleOf({ status: "in_review", published_at: null }), "needs_review");
  assert.equal(lifecycleOf({ status: "draft", published_at: null }), "needs_review");
  assert.equal(lifecycleOf({ status: "approved", published_at: null }), "approved");

  // Archived and rejected both mean "shelved", and both must be REACHABLE.
  // CC archived a video and reported it "completely gone" — it was in the table
  // the whole time with no bucket that could show it.
  assert.equal(lifecycleOf({ status: "archived", published_at: null }), "archived");
  assert.equal(lifecycleOf({ status: "rejected", published_at: null }), "archived");
  // Archived outranks even a publish: something taken down is not "Posted" work
  // you are still running.
  assert.equal(
    lifecycleOf({ status: "archived", published_at: "2026-08-01T00:00:00Z" }),
    "archived",
    "an archived asset stays archived — shelving is a decision, not a metric",
  );

  // Every bucket must be renderable and reachable from the URL.
  for (const l of LIFECYCLE) {
    assert.ok(isLifecycle(l));
    assert.ok(lifecycleLabel(l).trim().length > 0, `${l} needs a label`);
    assert.ok(lifecycleHint(l).trim().length > 0, `${l} needs a hint`);
  }
  assert.ok(!isLifecycle("published"), "the raw status vocabulary is not the lifecycle vocabulary");
  assert.ok(!isLifecycle("") && !isLifecycle(null) && !isLifecycle(undefined));
}

// ── permalinks: click a metric, reach the post ───────────────────────────────
// CC: "it should be a clickable link that takes me to that Instagram post."
{
  assert.equal(
    postPermalink("youtube", "-5huRgnq-Qk"),
    "https://www.youtube.com/watch?v=-5huRgnq-Qk",
  );
  assert.equal(
    postPermalink("tiktok", "7665918344775699729", "ccmckennaa"),
    "https://www.tiktok.com/@ccmckennaa/video/7665918344775699729",
  );
  assert.equal(
    postPermalink("linkedin", "urn:li:ugcPost:7487100000000000000"),
    "https://www.linkedin.com/feed/update/urn:li:ugcPost:7487100000000000000/",
  );

  // INSTAGRAM IS THE TRAP. post_analytics stores a NUMERIC media id, and
  // /p/<id> needs the base64 shortcode — building one from the number yields a
  // 404 that looks like working accounting. Link the account instead.
  assert.equal(
    postPermalink("instagram", "17874750624553086", "oasisaisolutions"),
    "https://www.instagram.com/oasisaisolutions/",
    "a numeric IG media id must NOT be pasted into /p/ — it does not resolve",
  );
  assert.ok(
    !postPermalink("instagram", "17874750624553086")?.includes("/p/"),
    "and with no account to fall back to, no link at all beats a broken one",
  );

  // Never invent a URL from nothing.
  assert.equal(postPermalink("instagram", null), null);
  assert.equal(postPermalink("youtube", ""), null);
  assert.equal(postPermalink("threads", "123"), null, "no account, no link");
  assert.equal(postPermalink("some-new-network", "abc"), null);
}

// ── a publish request nothing ever collected ─────────────────────────────────
// The Post panel claimed "the publisher picks it up within a minute". The drain
// exists and is healthy, but it runs on the OPERATOR'S MACHINE — so whenever
// that machine is off, the row waits indefinitely under a green success message
// and the panel cannot tell that state from a publish in flight. These pin the
// replacement: the page notices, from the row's own age, that nothing came.
{
  const T0 = new Date("2026-08-16T12:00:00Z");
  const at = (mins: number) =>
    new Date(T0.getTime() + mins * 60_000);
  const queued = { state: "queued", created_at: T0.toISOString() };

  assert.equal(stalePublishWarning(queued, at(1)), null, "a fresh request is just a fresh request");
  assert.equal(stalePublishWarning(queued, at(PUBLISH_STALE_AFTER_MINUTES - 1)), null,
    "inside the window, silence — a real drain can legitimately take minutes");

  const warned = stalePublishWarning(queued, at(PUBLISH_STALE_AFTER_MINUTES));
  assert.ok(warned, "past the window, the operator must be told nothing collected it");
  assert.match(warned!, /nothing has been posted/i,
    "the warning must state the consequence, not just the age");

  // Terminal and in-flight states mean SOMETHING saw the row, which is the fact
  // this warning exists to establish. Warning about them would cry wolf.
  for (const state of ["running", "done", "failed"]) {
    assert.equal(
      stalePublishWarning({ state, created_at: T0.toISOString() }, at(60 * 24 * 7)),
      null,
      `${state} means a consumer picked it up — no warning`,
    );
  }

  // Units read correctly at each scale; "Queued 180 minutes ago" is worse copy
  // than "3 hours ago" and this is where an off-by-60 would hide.
  assert.match(stalePublishWarning(queued, at(30))!, /30 minutes ago/);
  assert.match(stalePublishWarning(queued, at(60))!, /1 hour ago/);
  assert.match(stalePublishWarning(queued, at(180))!, /3 hours ago/);
  assert.match(stalePublishWarning(queued, at(60 * 24 * 2))!, /2 days ago/);

  // Never throw on bad input: this renders inside a panel, and a crash here
  // would take the whole detail page with it.
  assert.equal(stalePublishWarning({ state: "queued", created_at: "not-a-date" }), null);
  assert.equal(stalePublishWarning(null), null);
  assert.equal(stalePublishWarning(undefined), null);
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
      order(col: string) { call.filters.push(["order", col]); return api; },
      range(from: number, to: number) { call.filters.push(["range", [from, to]]); return api; },
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
        const range = call.filters.find(([f]) => f === "range")?.[1] as [number, number] | undefined;
        if (range) rows = rows.slice(range[0], range[1] + 1);
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

  // THE TRAINING CORPUS IS DELIBERATELY *NOT* BRAND-SCOPED, and this pins that so
  // the next person tidying for consistency has to read the reason first.
  // marketing_corpus is what Maven LEARNS FROM, not what OASIS has shipped — a
  // client ad that performed is training signal exactly like our own. The brand
  // boundary governs the founders LIBRARY, not the training set.
  // marketing_corpus.asset_id IS nullable, so scoping it would be possible; that
  // is why an explicit assertion is worth more than the absence of one.
  const corpusCall = calls.find((c) => c.table === "marketing_corpus");
  assert.ok(corpusCall, "the summary must read marketing_corpus");
  assert.ok(
    corpusCall!.filters.some(([f]) => f === "eq:tenant_id"),
    "the corpus read is still tenant-scoped",
  );
  assert.equal(
    corpusCall!.filters.some(([f]) => f === "in:asset_id" || f === "eq:brand_slug"),
    false,
    "marketing_corpus must NOT be brand-scoped — Maven learns from every asset we have " +
      "produced, including client work. If you are here because you scoped it for " +
      "consistency with open_reviews/open_requests, that is the bug this catches.",
  );

  // The asset read must PAGE, not issue one unbounded select. PostgREST returns a
  // short page at max-rows (1,000 on Supabase) with NO error, while the Turso
  // bridge applies no cap — so an unpaginated read gives two different answers for
  // the same tenant and the Supabase one is silently low. Worse, ownAssetIds is the
  // allowlist for the counts above, so a short read also drops real work off
  // "waiting on you". getMarketingBrands in the same file already pages this way.
  const assetCall = calls.find((c) => c.table === "marketing_asset");
  assert.ok(assetCall, "the summary must read marketing_asset");
  assert.ok(
    assetCall!.filters.some(([f]) => f === "range"),
    "the own-brand asset read must page with .range(), like getMarketingBrands",
  );

  // ORDER BEFORE RANGE. `.range()` on an unordered query has no stable row order,
  // so page 2 may repeat or skip rows from page 1 — silently, and in either
  // direction. ownAssetIds is built from these pages and scopes the counts, so a
  // wobbly order corrupts those too. Caught by CodeRabbit: the paging loop was
  // copied from getMarketingBrands without its .order().
  assert.ok(
    assetCall!.filters.some(([f, v]) => f === "order" && v === "id"),
    "the paged asset read must .order() by a unique key before .range(), or pages can overlap or skip",
  );
  {
    const fs = assetCall!.filters.map(([f]) => f);
    assert.ok(
      fs.indexOf("order") < fs.indexOf("range"),
      "the order must be applied before the range",
    );
  }

  // Exercised past the page boundary, so paging is proven rather than assumed.
  {
    const PAGE = 1000;
    const many = Array.from({ length: PAGE + 7 }, (_, i) => ({
      id: `own-${i}`,
      track: "organic",
      status: "draft",
      brand_slug: "oasis-ai",
    }));
    const reviewsForAll = many.map((a) => ({ asset_id: a.id, acted_on_at: null as string | null }));
    const inChunks: number[] = [];

    const pagedDb = {
      from(table: string) {
        let head = false;
        let range: [number, number] | undefined;
        let ids: string[] | undefined;
        const api: Record<string, unknown> = {
          select(_c: string, opts?: { head?: boolean }) { head = Boolean(opts?.head); return api; },
          eq: () => api,
          is: () => api,
          in(col: string, v: string[]) {
            if (col === "asset_id") { ids = v; inChunks.push(v.length); }
            return api;
          },
          order: () => api,
          range(a: number, b: number) { range = [a, b]; return api; },
          then(resolve: (v: unknown) => void) {
            if (table === "marketing_asset") {
              const page = range ? many.slice(range[0], range[1] + 1) : many;
              return resolve({ error: null, data: page });
            }
            if (table === "marketing_review") {
              const n = reviewsForAll.filter((r) => !ids || ids.includes(r.asset_id)).length;
              return resolve({ error: null, count: n });
            }
            return resolve(head ? { error: null, count: 0 } : { error: null, data: [] });
          },
        };
        return api;
      },
    } as unknown as Parameters<typeof getMarketingSummary>[1];

    const big = await getMarketingSummary("tenant-big", pagedDb);
    assert.equal(
      big.total,
      PAGE + 7,
      "assets past the first page must still be counted — an unpaginated read would report exactly 1000",
    );
    assert.equal(
      big.open_reviews,
      PAGE + 7,
      "reviews for assets past the first page must be counted too; ownAssetIds is the allowlist",
    );
    assert.ok(
      inChunks.length > 1 && inChunks.every((n) => n <= 500),
      `the id-scoped counts must be chunked to keep the URL bounded (saw chunks: ${inChunks.join(",")})`,
    );
  }

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
        order: () => api,
        range: () => api,
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

// ── failure paths: a broken query must never render as an empty dashboard ─────
// Codex, reviewing this PR: "the current hand-written fake only returns successful
// responses." Correct, and it hid the worst defect in the file — every error path
// collapsed into EMPTY_MARKETING_SUMMARY, so a timeout on page two of the asset
// read painted "nothing registered yet" and "Nothing waiting on you" over a
// library with real work in it. Zero and "I could not find out" are different
// facts; these pin that they render differently.
async function degradedChecks() {
  const BROKEN = { code: "57014", message: "canceling statement due to statement timeout" };
  const ABSENT = { code: "42P01", message: 'relation "marketing_asset" does not exist' };

  /** Fails the Nth call to `table`, succeeds otherwise. */
  function dbFailing(opts: { table: string; onCall: number; err: Record<string, string>; assets?: number }) {
    const assetCount = opts.assets ?? 3;
    const assets = Array.from({ length: assetCount }, (_, i) => ({
      id: `own-${i}`,
      track: "organic",
      status: "in_review",
      brand_slug: "oasis-ai",
    }));
    const seen: Record<string, number> = {};
    return {
      from(table: string) {
        seen[table] = (seen[table] || 0) + 1;
        const nth = seen[table];
        let head = false;
        let range: [number, number] | undefined;
        const api: Record<string, unknown> = {
          select(_c: string, o?: { head?: boolean }) { head = Boolean(o?.head); return api; },
          eq: () => api,
          is: () => api,
          in: () => api,
          order: () => api,
          range(a: number, b: number) { range = [a, b]; return api; },
          then(resolve: (v: unknown) => void) {
            if (table === opts.table && nth === opts.onCall) {
              return resolve({ error: opts.err, data: null, count: null });
            }
            if (table === "marketing_asset") {
              const page = range ? assets.slice(range[0], range[1] + 1) : assets;
              return resolve({ error: null, data: page });
            }
            return resolve(head ? { error: null, count: 2 } : { error: null, data: [] });
          },
        };
        return api;
      },
    } as unknown as Parameters<typeof getMarketingSummary>[1];
  }

  // A MISSING TABLE is pre-migration: empty is the honest answer, and quiet.
  const absent = await getMarketingSummary(
    "t", dbFailing({ table: "marketing_asset", onCall: 1, err: ABSENT }),
  );
  assert.equal(absent.degraded, false, "a missing table is not a degraded read — it is genuinely empty");
  assert.equal(absent.total, 0);

  // A BROKEN asset read must NOT come back as a confident empty dashboard.
  const broken = await getMarketingSummary(
    "t", dbFailing({ table: "marketing_asset", onCall: 1, err: BROKEN }),
  );
  assert.equal(
    broken.degraded,
    true,
    "a query TIMEOUT must be reported as degraded, not rendered as 'nothing registered yet'",
  );

  // A broken REVIEW count must degrade rather than silently read zero — this is
  // the one that would have printed "Nothing waiting on you" over real work.
  const brokenReviews = await getMarketingSummary(
    "t", dbFailing({ table: "marketing_review", onCall: 1, err: BROKEN }),
  );
  assert.equal(brokenReviews.degraded, true, "a failed review count degrades the summary");
  assert.equal(
    brokenReviews.total,
    3,
    "the assets that DID load are still reported — degrading is not blanking the screen",
  );

  // Same for the unbound-request count and the corpus read.
  for (const table of ["marketing_request", "marketing_corpus"]) {
    const r = await getMarketingSummary("t", dbFailing({ table, onCall: 1, err: BROKEN }));
    assert.equal(r.degraded, true, `a failed ${table} read must degrade the summary`);
  }

  // A healthy read is NOT degraded — otherwise the flag is just always-on noise
  // and the honest empty state becomes unreachable.
  const healthy = await getMarketingSummary(
    "t", dbFailing({ table: "nothing-fails", onCall: 99, err: BROKEN }),
  );
  assert.equal(healthy.degraded, false, "a clean read must not be flagged degraded");
  assert.equal(healthy.total, 3);
}

// ── the honest fallback must survive a THROW, not just a query error ─────────
// The degraded flag was half-wired: getMarketingSummary set it correctly, but the
// page hands safe() a fallback for the throw case and that fallback was
// EMPTY_MARKETING_SUMMARY (degraded: false). So any unexpected exception —
// network, malformed response, a client blowing up — landed back on "Nothing
// waiting on you". A mechanism that is right in the library and wrong at the call
// site is worse than none: it reads as covered.
async function fallbackChecks() {
  assert.equal(
    DEGRADED_MARKETING_SUMMARY.degraded,
    true,
    "the fallback handed to safe() must be flagged degraded",
  );
  assert.equal(EMPTY_MARKETING_SUMMARY.degraded, false, "the pre-migration empty is NOT degraded");

  // An exception inside the reader must come back degraded, not empty.
  const throwingDb = {
    from() {
      throw new Error("connection reset by peer");
    },
  } as unknown as Parameters<typeof getMarketingSummary>[1];
  const thrown = await getMarketingSummary("t", throwingDb);
  assert.equal(
    thrown.degraded,
    true,
    "an unexpected throw must return the DEGRADED summary — a throw is never evidence of absence",
  );

  // And the page must actually pass that fallback in.
  const page = readFileSync(join(process.cwd(), "app/founders/marketing/page.tsx"), "utf8");
  assert.ok(
    /safe\(\s*\n?\s*"marketing\.summary",[\s\S]{0,140}?DEGRADED_MARKETING_SUMMARY/.test(page),
    "the Studio page must hand safe() the DEGRADED fallback, not the empty one",
  );

  // The library reader distinguishes the two the same way, via null.
  const lib = readFileSync(join(process.cwd(), "app/founders/marketing/library/page.tsx"), "utf8");
  assert.ok(
    lib.includes("const libraryDegraded = assetsOrNull === null;"),
    "the library must tell 'empty' apart from 'could not load' — an [] fallback cannot",
  );
  assert.ok(
    lib.includes('"Couldn\'t load the library"'),
    "and must render distinct copy when the read failed",
  );

  const queries = readFileSync(join(process.cwd(), "lib/founders/marketing-queries.ts"), "utf8");
  assert.ok(
    /if \(verdict === "broken"\) throw new Error\(`marketing_asset read failed/.test(queries),
    "getMarketingAssets must THROW on a broken read rather than returning [] — " +
      "returning [] is how 'the query failed' became 'the library is empty'",
  );
}

// ── "needs you" means needs CC ────────────────────────────────────────────────
// The headline was open_reviews + open_requests + awaitingVerdict, which
// double-counted an in_review asset that also had an open review row, and folded
// in two queues that 133_marketing_hub.sql says are waiting on the AGENT, not the
// operator. Pinned as source text because the sum lives in the page component.
{
  const page = readFileSync(join(process.cwd(), "app/founders/marketing/page.tsx"), "utf8");
  assert.ok(
    /const needsYou = awaitingVerdict;/.test(page),
    "needsYou must be the assets awaiting CC's verdict — not a sum that double-counts an " +
      "in_review asset carrying an open review, and not one that folds in Maven's own queues",
  );
  assert.ok(
    page.includes("summary.degraded ?"),
    "the page must render the degraded state BEFORE the 'Nothing waiting on you' empty state, " +
      "or a broken query still reads as good news",
  );
  assert.ok(
    page.indexOf("summary.degraded ?") < page.indexOf('headline="Nothing waiting on you"'),
    "the degraded branch must come first — otherwise needsYou === 0 wins and says 'nothing'",
  );
}

brandBoundaryChecks()
  .then(degradedChecks)
  .then(fallbackChecks)
  .then(
  () => console.log("marketing-core: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

