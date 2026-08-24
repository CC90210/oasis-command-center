/**
 * web-leads-battlecard.test.ts — the numbers a rep says out loud.
 *
 * The battle card exists to convert a measurement into a sentence: *"you score
 * lower than 91% of 218 hair salons in Mississauga."* That sentence is said to
 * a stranger, on a live call, by someone who cannot check it. So the tests here
 * are not about rendering. They are about the four ways this feature could
 * hand a rep something false:
 *
 *   1. THE PERCENTILE COULD OVERSTATE. Counting ties as "worse than" turns a
 *      site level with its peers into the worst in town.
 *   2. THE PEER GROUP COULD BE TOO SMALL, OR SILENTLY SWAPPED. "Worse than 88%
 *      of them" against four businesses is arithmetic pretending to be
 *      evidence, and a percentile that quietly widened from "salons in
 *      Mississauga" to "every site in Canada" is a rep saying one thing while
 *      the number means another.
 *   3. THE EVIDENCE COULD INVENT A MEASUREMENT. A signal the crawler never
 *      recorded, printed as "0" or "No", is a fabricated finding.
 *   4. THE CARD COULD SCORE AN UNSCORED SITE. A radar with seven axes at the
 *      origin, for a site our crawler was simply blocked from, is an accusation
 *      with a chart around it.
 *
 * Plus the standing structural guards: the new endpoint is a new door onto the
 * same tenant_records table and must carry the identical auth gate, and the
 * competitor panel must never become a second way to read another rep's book.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  percentileAmong, median, groupStats, bucketOf, distributionOf, chooseSlice, labelFor, MIN_SLICE, TOP_N,
} from "../lib/web-leads/competitors";
import { ANGLES, selectAngle, recoverablePoints } from "../lib/web-leads/angles";
import { evidenceFrom } from "../lib/web-leads/evidence";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
/** Assertions about CODE must not trip on the prose explaining the code. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 1. The percentile understates, always.
// ---------------------------------------------------------------------------

assert.deepEqual(
  percentileAmong([80, 70, 60], 50),
  { lowerThanPct: 100, rank: 4, outOf: 4 },
  "a site below every peer is below 100% of them, ranked last",
);

assert.deepEqual(
  percentileAmong([10, 20, 30], 50),
  { lowerThanPct: 0, rank: 1, outOf: 4 },
  "a site above every peer is below none of them",
);

// THE TIE RULE, and the reason it is written the way it is. `>` not `>=`: four
// peers tied with the lead means nobody is beating them, which is what a rep
// can defend. Counting ties as "higher" would produce "lower than 100% of the
// salons in your area" for a business that is exactly average -- true of
// nothing, said aloud, unrecoverable.
assert.deepEqual(
  percentileAmong([50, 50, 50, 50], 50),
  { lowerThanPct: 0, rank: 1, outOf: 5 },
  "peers tied with the lead do not count as scoring higher",
);

// One peer higher out of four is 25%, not 20% and not 33%: the denominator is
// the peer group, and the lead is not its own competitor.
assert.deepEqual(percentileAmong([90, 40, 30, 20], 50), { lowerThanPct: 25, rank: 2, outOf: 5 });

// An empty peer group must not divide by zero and must not fabricate a rank.
assert.deepEqual(percentileAmong([], 50), { lowerThanPct: 0, rank: 1, outOf: 1 });

assert.equal(median([1, 2, 3]), 2);
assert.equal(median([1, 2, 3, 4]), 3, "an even split rounds rather than returning a fraction of a point");
assert.equal(median([]), 0);

// THE EXTREMA DESCRIBE THE GROUP THE LEAD IS RANKED IN, not the peers alone.
// The card renders "Rank 1 of 5. Best in that group scores 86" off these two
// side by side; computed over peers only, a lead scoring 90 against a best peer
// of 86 renders exactly that -- ranked first in a group whose stated best is
// lower than it is. A prospect spots that without knowing any statistics.
// (Codex review, 2026-08-24.)
{
  const peers = [86, 60, 40, 20];
  const stats = groupStats(peers, 90);
  assert.equal(stats.best, 90, "a lead above every peer IS the best of the group it is ranked in");
  assert.equal(percentileAmong(peers, 90).rank, 1);
  assert.ok(
    stats.best >= 90,
    "rank 1 with a stated group best below the lead's own score is a self-contradiction on screen",
  );

  const low = groupStats(peers, 5);
  assert.equal(low.worst, 5, "a lead below every peer IS the lowest of the group it is ranked in");
  assert.equal(low.best, 86);
}

// ---------------------------------------------------------------------------
// 2. Bucketing, and the eleventh-bucket artefact it avoids.
// ---------------------------------------------------------------------------

assert.equal(bucketOf(0), 0);
assert.equal(bucketOf(9), 0);
assert.equal(bucketOf(10), 1);
assert.equal(bucketOf(99), 9);
// 100 shares the top band rather than getting a bucket of its own: an eleventh
// bucket holding only perfect scores renders as a spike that is an artefact of
// the bucketing, not a fact about the corpus.
assert.equal(bucketOf(100), 9);

{
  const { buckets, leadBucket } = distributionOf([5, 15, 95], 45);
  assert.equal(buckets.length, 10);
  assert.equal(buckets[0], 1);
  assert.equal(buckets[1], 1);
  assert.equal(buckets[4], 1, "the lead itself is one of the measured sites in its own distribution");
  assert.equal(buckets[9], 1);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 4);
  assert.equal(leadBucket, 4);
}

// ---------------------------------------------------------------------------
// 3. The fallback ladder never quotes a group too small, and never quotes one
//    silently.
// ---------------------------------------------------------------------------

assert.equal(MIN_SLICE, 8, "the floor a percentile may be quoted against");
assert.ok(TOP_N >= 1 && TOP_N <= 5, "a rep mid-call reads the top of a list, not a list");

{
  const thin = new Array(3).fill(0);
  const wide = new Array(12).fill(0);
  const { chosen, rejected } = chooseSlice([
    { kind: "industry_city", label: "Hair salon sites in Mississauga", peers: thin },
    { kind: "industry_province", label: "Hair salon sites in Ontario", peers: wide },
    { kind: "national", label: "Canadian sites", peers: new Array(500).fill(0) },
  ]);
  assert.equal(chosen?.kind, "industry_province", "a slice under MIN_SLICE is skipped");
  // The rejected slice is RETURNED, not discarded. This is what lets the card
  // say which comparison it actually made -- a percentile that widened without
  // saying so is the failure mode this whole ladder exists to avoid.
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], {
    kind: "industry_city",
    label: "Hair salon sites in Mississauga",
    peerCount: 3,
  });
}

{
  // Exactly MIN_SLICE qualifies -- the floor is inclusive, or the boundary is
  // untested and the real threshold is 9.
  const { chosen } = chooseSlice([
    { kind: "industry_city", label: "x", peers: new Array(MIN_SLICE).fill(0) },
  ]);
  assert.equal(chosen?.kind, "industry_city");
}

{
  // Nothing wide enough anywhere: no percentile at all, rather than one against
  // seven sites with a hope that nobody asks.
  const { chosen, rejected } = chooseSlice([
    { kind: "industry_city", label: "a", peers: [1] },
    { kind: "national", label: "b", peers: [1, 2] },
  ]);
  assert.equal(chosen, null);
  assert.equal(rejected.length, 2);
}

assert.equal(
  labelFor("industry_city", { industry: "Hair Salon", city: "Mississauga", province: "Ontario" }),
  "Hair Salon sites in Mississauga",
);
assert.equal(
  labelFor("industry_province", { industry: "Hair Salon", city: "Mississauga", province: "Ontario" }),
  "Hair Salon sites in Ontario",
);
assert.equal(
  labelFor("industry_national", { industry: "Hair Salon", city: null, province: null }),
  "Hair Salon sites in Canada",
);
assert.equal(labelFor("national", { industry: null, city: null, province: null }), "Canadian sites");

// EVERY label must read correctly in EVERY sentence the card puts it in, not
// just the one it was written against. The national label used to be "sites we
// have measured across Canada", which produced "the 17,052 sites we have
// measured across Canada we have measured" in two of the three sentences below.
for (const kind of ["industry_city", "industry_province", "industry_national", "national"] as const) {
  const label = labelFor(kind, { industry: "Hair Salon", city: "Mississauga", province: "Ontario" });
  for (const sentence of [
    `Scores lower than 78% of the 218 ${label} we have measured.`,
    `The best-scoring ${label} we have measured.`,
    `Score bands across the ${label} we have measured`,
  ]) {
    assert.doesNotMatch(sentence, /we have measured[\s\S]*we have measured/, `${kind}: doubled phrasing in "${sentence}"`);
    assert.doesNotMatch(sentence, /across[\s\S]*across/, `${kind}: doubled "across" in "${sentence}"`);
  }
}
// The industry string is the tenant's own free text and is rendered as stored.
// Normalising it here is how "Health & Medical" reaches a prospect's screen as
// "health and medical".
assert.match(
  labelFor("industry_city", { industry: "Restaurants & Bars", city: "Québec", province: "QC" }),
  /Restaurants & Bars sites in Québec/,
);

// ---------------------------------------------------------------------------
// 4. The angles: complete, weighted, and hand-written.
// ---------------------------------------------------------------------------

const DIMENSION_KEYS = ["conversion", "trust", "design", "mobile", "content", "performance", "discoverability"];
for (const key of DIMENSION_KEYS) {
  const a = ANGLES[key];
  assert.ok(a, `no angle for ${key} -- a dimension with no angle is a hole in the product`);
  assert.ok(a.opener.length >= 40, `${key}: opener is a stub`);
  assert.ok(a.cost.length >= 40, `${key}: cost is a stub`);
  assert.ok(a.objection.says.length >= 8, `${key}: objection is a stub`);
  assert.ok(a.objection.response.length >= 30, `${key}: objection response is a stub`);
  assert.ok(a.build.length >= 30, `${key}: build is a stub`);
}
assert.equal(Object.keys(ANGLES).length, DIMENSION_KEYS.length, "one angle per dimension, no extras");

{
  // House rule for anything read aloud to a customer, same as remedies.ts.
  const all = Object.values(ANGLES)
    .map((a) => `${a.opener}${a.cost}${a.objection.says}${a.objection.response}${a.build}`)
    .join(" ");
  assert.ok(!all.includes("—"), "no em dashes in anything a rep reads aloud");
  // A rep says these to a plumber, not to an engineer.
  assert.doesNotMatch(all, /viewport|schema\.org|\bDOM\b|render-block|\bLCP\b|\bTTFB\b|\bCTA\b/i, "jargon in an angle");
  // NOT ONE ANGLE QUOTES A MEASUREMENT. Copy that names a number is copy that
  // can be wrong about a specific business; the measured numbers are rendered
  // beside this, from the audit, where they are true by construction.
  assert.doesNotMatch(all, /\b\d+(\.\d+)?\s?(seconds?|MB|KB|ms|%)\b/i, "an angle quotes a measurement it cannot know");
}

// Weighted, not raw. A conversion 50 (weight 0.28) is losing 14 composite
// points; a discoverability 0 (weight 0.05) is losing 5. Ranking on the raw
// score sends a rep into the smaller conversation and the smaller build.
{
  const picked = selectAngle([
    { key: "conversion", label: "Turning visitors into calls", score: 50, weight: 0.28 },
    { key: "discoverability", label: "Being found", score: 0, weight: 0.05 },
  ]);
  assert.equal(picked?.key, "conversion", "the angle follows weighted points, not the lowest raw score");
}

// Floating point, so compared within a tolerance rather than exactly: 50 * 0.28
// is 14.000000000000002 in IEEE 754, and the card renders it to one decimal.
assert.ok(Math.abs(recoverablePoints({ score: 50, weight: 0.28 }) - 14) < 1e-9);
assert.equal(recoverablePoints({ score: 100, weight: 0.28 }), 0, "a full-marks dimension has nothing to recover");
assert.equal(recoverablePoints({ score: 120, weight: 0.28 }), 0, "never a negative recoverable amount");

{
  // A genuine tie resolves toward conversion, then trust -- the two that
  // convert into money fastest for the prospect and are cheapest for us.
  const tie = [
    { key: "content", label: "Explaining the service", score: 50, weight: 0.1 },
    { key: "trust", label: "Looking credible", score: 50, weight: 0.1 },
    { key: "conversion", label: "Turning visitors into calls", score: 50, weight: 0.1 },
  ];
  assert.equal(selectAngle(tie)?.key, "conversion");
  assert.equal(selectAngle(tie.filter((d) => d.key !== "conversion"))?.key, "trust");
}

// An unknown dimension key must not produce an angle, and must not throw: a
// future model version adding a dimension must degrade to "no angle", never to
// a card that renders `undefined` at a prospect.
assert.equal(selectAngle([{ key: "not_a_dimension", label: "x", score: 0, weight: 1 }]), null);
assert.equal(selectAngle([]), null);

// ---------------------------------------------------------------------------
// 5. The evidence never invents a measurement.
// ---------------------------------------------------------------------------

assert.deepEqual(evidenceFrom(null), []);
assert.deepEqual(evidenceFrom(undefined), []);
assert.deepEqual(evidenceFrom({}), [], "an empty signal blob renders no headings, not empty ones");

{
  // A MEASURED ZERO IS A MEASUREMENT and must render. This is the mirror of the
  // rule below it, and the two are easy to conflate: "we looked and found none"
  // is a finding, "we never looked" is not.
  const groups = evidenceFrom({ telLinks: 0 });
  const flat = groups.flatMap((g) => g.rows);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].value, "0");
  assert.match(flat[0].label, /Tap-to-call/);
  // A key the crawler never wrote is absent, not a zero and not a "No".
  assert.ok(
    !groups.some((g) => g.rows.some((r) => /Viewport/.test(r.label))),
    "a signal we did not measure must not render as an absence we did measure",
  );
}

{
  const rows = evidenceFrom({ hasViewportMeta: false, isHttps: true }).flatMap((g) => g.rows);
  assert.deepEqual(
    rows.map((r) => r.value).sort(),
    ["Not found", "Yes"],
    "booleans render as what the crawler saw, never as a verdict like 'Missing'",
  );
}

{
  // Formatting is for reading aloud. 4,404,019 is unreadable; 4.2 MB is a
  // sentence a rep can say.
  const rows = evidenceFrom({ bytes: 4_404_019, ttfbMs: 412, wordCount: 128 }).flatMap((g) => g.rows);
  const values = rows.map((r) => r.value);
  assert.ok(values.includes("4.2 MB"), `expected a human page weight, got ${values.join(", ")}`);
  assert.ok(values.includes("412 ms"));
  assert.ok(values.includes("128 words"));
}

// A signal of the wrong TYPE is dropped rather than coerced. `String(raw)` here
// would print "many" as though we had counted it.
assert.deepEqual(evidenceFrom({ telLinks: "many" }), []);
assert.deepEqual(evidenceFrom({ hasViewportMeta: "sort of" }), []);

// ---------------------------------------------------------------------------
// 6. The endpoint is a NEW DOOR onto tenant_records and carries the same gate.
//
// libSQL has no row-level security, so the route IS the authorization boundary.
// The sibling routes ACTUALLY leaked every Web Studio lead to any authenticated
// user of any tenant by resolving session.tenantId and never reading it, and a
// presence-only grep for `status: 401` passed the entire time that was broken.
// ---------------------------------------------------------------------------

{
  const route = "app/api/web-leads/[id]/battlecard/route.ts";
  const src = read(route);
  assert.match(src, /resolveSessionContext/, `${route} must resolve the caller`);
  assert.match(
    src,
    /if\s*\(\s*!\s*session\.ok\s*\)/,
    `${route} must branch on session.ok -- resolveSessionContext returns a union that is always truthy`,
  );
  assert.match(src, /status:\s*401/, `${route} must fail closed on an unresolved caller`);
  assert.match(src, /session\.tenantId\s*!==\s*WEBDEV_TENANT_ID/, `${route} must constrain the caller to the tenant`);
  assert.match(src, /status:\s*403/, `${route} must refuse a caller from another tenant`);
  // The outside-contractor role lives INSIDE this tenant (#237), so a tenant
  // match is not proof a caller may see every lead in it.
  assert.match(src, /session\.teamRole/, `${route} must build a viewer carrying the caller's role`);
  assert.match(src, /session\.isAdmin/, `${route} must build a viewer carrying the caller's admin flag`);
  // An id outside the viewer's scope must read exactly like an id that does not
  // exist, or the endpoint becomes a way to probe which leads exist.
  assert.match(src, /fetchLead\(id, viewer\)[\s\S]{0,200}?status:\s*404/, `${route} must 404 an out-of-scope id`);

  // RULE 4: competitor data is only ever attached to a SCORED audit. Treating
  // "we could not reach the site" as a zero would rank a business dead last in
  // its own city on the strength of a failed crawl.
  assert.match(
    src,
    /audit\.state !== "scored"[\s\S]{0,240}?competitors: null/,
    `${route} must not attach a percentile, a rank or a head-to-head to a non-scored audit`,
  );
}

// ---------------------------------------------------------------------------
// 7. The competitor read: complete, tenant-pinned, and not a second door onto
//    another rep's book.
// ---------------------------------------------------------------------------

{
  const src = read("lib/web-leads/competitors.ts");
  const code = stripComments(src);

  const froms = (code.match(/\.from\(/g) || []).length;
  const pins = (code.match(/\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/g) || []).length;
  assert.ok(froms > 0, "competitors.ts must actually read something");
  assert.equal(pins, froms, `every read must pin the tenant (${froms} reads, ${pins} pinned)`);

  // A short read here does not blank the card. It quietly SHRINKS the peer
  // group, and a percentile computed against a silently-truncated slice is a
  // wrong number a rep reads aloud. Proved against the read's own match count,
  // never against our cap -- PostgREST enforces a server-side max-rows a cap
  // comparison never sees.
  assert.match(code, /\{ count: "exact" \}/, "the corpus scan must request an exact count");
  assert.match(code, /assertCompleteRead\(/, "the corpus scan must prove it was not truncated");
  assert.match(code, /memo\(/, "the corpus must be memoised -- it is a whole-table read");
  assert.match(code, /TTL\.CORPUS/, "the corpus TTL must be its own, not the ten-second leads TTL");

  // `.is("profile", "not.null")` reads better and only works on our Turso
  // adapter: real supabase-js serialises it to `profile=is.not.null`, which
  // PostgREST rejects outright, so every request 500s on that path. Banned by
  // name here so it cannot creep back in through this module.
  assert.doesNotMatch(
    code,
    /\.is\(\s*["']profile["']\s*,\s*["']not\.null["']\s*\)/,
    'the adapter-only `.is("profile","not.null")` form must never appear -- use .not("profile","is",null)',
  );

  // NOTHING FROM ANOTHER REP'S BOOK. A competitor is a public business name, a
  // location, a public URL and OUR measurement. No lead id, no phone, no
  // address, no owner, no stage, no claim state -- otherwise this panel becomes
  // a way to enumerate somebody else's pipeline, which is exactly what PR #237
  // closed.
  for (const forbidden of ["phone", "assigned_to", "assignedTo", "business_address", "lastCallAt"]) {
    assert.doesNotMatch(
      code,
      new RegExp(`\\b${forbidden}\\b`),
      `competitors.ts must never surface ${forbidden} -- a competitor is a measurement, not a lead`,
    );
  }
  // `stage` guarded separately: the word appears in no code path here, and if
  // one is ever added it must be caught by the same rule.
  assert.doesNotMatch(code, /\bstage\b/, "competitors.ts must never surface a lead's pipeline stage");
}

// ---------------------------------------------------------------------------
// 8. The card itself: sentences for the three non-scored states, safe external
//    links, and no chart library.
// ---------------------------------------------------------------------------

{
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);

  // The three honest states, VERBATIM. A radar with all seven axes at the
  // origin for a site our crawler was blocked from is a fabricated accusation
  // with a gradient on it.
  assert.match(src, /No website found yet, needs checking/, `${view} must render the hedged no-website sentence`);
  assert.match(src, /We could not check this site\./, `${view} must render a sentence for the unreachable state`);
  assert.match(src, /Not scored yet\./, `${view} must render a sentence for the never-scored state`);
  assert.doesNotMatch(src, /"No website"/, `${view} must not render a bare "No website" verdict`);

  // The gate itself, not just the sentences: no chart may render for a
  // non-scored lead.
  assert.match(
    src,
    /audit\.state !== "scored"[\s\S]{0,160}?<NotScored/,
    `${view} must route every non-scored state to the sentence renderer before any chart`,
  );

  // Every external link goes through preferredSiteUrl (bare domains navigate
  // inside our own dashboard; these URLs come from OpenStreetMap, which anyone
  // can edit) and carries rel="noopener noreferrer" (without it the opened tab
  // reaches back through window.opener). Twice: the prospect's site, and the
  // competitor's -- the second is the one a refactor forgets.
  const preferred = (src.match(/preferredSiteUrl\(/g) || []).length;
  assert.ok(preferred >= 2, `${view} must resolve BOTH the prospect's and the competitors' URLs safely`);
  const externals = (src.match(/target="_blank"[\s\S]{0,160}?rel="noopener noreferrer"/g) || []).length;
  const blanks = (src.match(/target="_blank"/g) || []).length;
  assert.equal(externals, blanks, `every target="_blank" in ${view} must carry rel="noopener noreferrer"`);

  // prefers-reduced-motion disables all of it. Non-negotiable: a rep on a call
  // does not need things moving.
  assert.match(src, /prefers-reduced-motion/, `${view} must honour prefers-reduced-motion`);

  // "The best-scoring" is only ever said about the actual best-scoring site.
  // buildHeadToHead falls through to the next candidate when the top one has no
  // readable profile, and the card previously described whatever came back as
  // the best in the slice -- a false claim about a named business, on a live
  // call, in exactly the case the fallback exists to handle. (Codex review,
  // 2026-08-24.) The superlative must sit behind the rank check.
  assert.match(
    src,
    /headToHead\.rankInSlice === 1[\s\S]{0,200}?The best-scoring/,
    `${view} must gate the "best-scoring" claim on the competitor actually being ranked first`,
  );
  const superlatives = (src.match(/The best-scoring of the/g) || []).length;
  assert.equal(superlatives, 1, `${view} must not repeat the superlative outside the rank check`);

  // Hand-rolled SVG, on purpose. A chart library ships its own colour defaults
  // into a surface whose central rule is that no colour may be keyed to a
  // score. (recharts IS in package.json for other surfaces, which is exactly
  // why this is asserted rather than assumed.)
  for (const lib of ["recharts", "chart.js", "d3", "victory", "nivo"]) {
    assert.doesNotMatch(src, new RegExp(`from ["']${lib.replace(".", "\\.")}`), `${view} must not import ${lib}`);
  }

  // Copy is hand-written and rendered verbatim. Nothing on this page is
  // generated per lead, ever.
  assert.doesNotMatch(src, /claudeMessages|anthropic|openai|generateText/i, `${view} must never generate copy per lead`);
  assert.match(src, /remedyFor/, `${view} must render the hand-written remedy copy`);
  assert.match(src, /selectAngle/, `${view} must render the hand-written angle copy`);
}

// ---------------------------------------------------------------------------
// 9. It is actually reachable. A page nobody can navigate to is not shipped.
// ---------------------------------------------------------------------------

{
  const page = read("app/web-leads/[id]/page.tsx");
  assert.match(page, /BattleCard/, "the dynamic lead route must render the battle card");

  assert.match(
    read("components/web-leads/LeadsTable.tsx"),
    /href=\{`\/web-leads\/\$\{encodeURIComponent\(id\)\}`\}/,
    "LeadsTable must link each row to its battle card",
  );
  assert.match(
    read("components/web-leads/CallMode.tsx"),
    /href=\{`\/web-leads\/\$\{encodeURIComponent\(lead\.id\)\}`\}/,
    "Call Mode's 'Full detail' must lead to the battle card",
  );
}

console.log("web-leads-battlecard ok");
