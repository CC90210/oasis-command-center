/**
 * web-leads-scores.test.ts — the list-view score, and the two ways it could lie.
 *
 * The website score now appears in two places that are read seconds apart: the
 * results table (bulk, lib/web-leads/scores.ts) and the detail panel (per lead,
 * lib/web-leads/audit.ts). They read different columns of different tables. If
 * they ever disagree, a rep reads one number off the list, opens the lead, sees
 * another, and has no way to know which one they just said out loud.
 *
 * So these tests are not about arithmetic. They are about the two specific ways
 * the bulk path could produce a number the panel would not:
 *
 *   1. by scoring something the panel refuses to score (unreachable sites, rows
 *      whose profile never landed), and
 *   2. by reading a different audit row than the panel would (an older crawl, a
 *      different model version).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveScore, EMPTY_SCORE_INDEX, type ScoreIndex } from "../lib/web-leads/scores";
import { parseFilters, filtersToParams, EMPTY_FILTERS } from "../lib/web-leads/filters";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// 1. resolveScore applies audit.ts's precedence, not a convenient one.
// ---------------------------------------------------------------------------

const index: ScoreIndex = {
  scored: new Map([["biz-scored", 34], ["biz-both", 71], ["biz-zero", 0]]),
  unreachable: new Set(["biz-unreachable", "biz-both"]),
};

assert.deepEqual(
  resolveScore("https://example.com", "biz-scored", index),
  { score: 34, scoreState: "scored" },
  "a measured site returns its measured number",
);

// A zero is a REAL measured score and must survive. The bug this guards is a
// truthiness check (`if (!score)`) that silently converts a genuine 0 into
// "not scored" -- which would quietly drop the worst sites in the corpus, i.e.
// exactly the best prospects, out of every score-band queue.
assert.deepEqual(
  resolveScore("https://example.com", "biz-zero", index),
  { score: 0, scoreState: "scored" },
  "a measured zero is a score, not an absence of one",
);

assert.deepEqual(
  resolveScore(null, "biz-scored", index),
  { score: null, scoreState: "no_website" },
  "no website on the lead outranks any audit row that may exist",
);

assert.deepEqual(
  resolveScore("https://example.com", "biz-unreachable", index),
  { score: null, scoreState: "unreachable" },
  "a site we could not reach is named, never scored",
);

// THE LOAD-BEARING ONE. A business with BOTH an audit row and an unreachable
// row must resolve to unreachable, because audit.ts checks unreachable first.
// If this flips, the table shows 71 for a business whose panel says "We could
// not check this site" -- the two surfaces contradicting each other about a
// stranger's business, on a live call.
assert.deepEqual(
  resolveScore("https://example.com", "biz-both", index),
  { score: null, scoreState: "unreachable" },
  "unreachable outranks a stored score, matching audit.ts's precedence exactly",
);

assert.deepEqual(
  resolveScore("https://example.com", "biz-unknown", index),
  { score: null, scoreState: "not_scored" },
  "a site with no audit row is not scored -- never a zero",
);

assert.deepEqual(
  resolveScore("https://example.com", null, index),
  { score: null, scoreState: "not_scored" },
  "a lead with no source business id has nothing to look up, and that is not a verdict",
);

assert.deepEqual(
  resolveScore("https://example.com", "biz-scored", EMPTY_SCORE_INDEX),
  { score: null, scoreState: "not_scored" },
  "an empty index degrades to not_scored, never to a number",
);

// ---------------------------------------------------------------------------
// 2. The bulk read cannot outrun the panel's own restrictions.
// ---------------------------------------------------------------------------

{
  const src = read("lib/web-leads/scores.ts");

  // Rows whose profile never landed are `not_scored` to the panel (audit.ts
  // rule 3). Without this filter the table would show a number for a lead whose
  // panel says "Not scored yet" -- and all tests would still pass, because both
  // statements are individually defensible.
  assert.match(
    src,
    /\.is\("profile",\s*"not\.null"\)/,
    "the bulk audit read must exclude profile-less rows, which the panel treats as not_scored",
  );

  // Same model version as the panel, or the list is scored by a different model.
  assert.match(
    src,
    /\.eq\("audit_version",\s*MODEL_VERSION\)/,
    "the bulk audit read must pin MODEL_VERSION, as audit.ts does",
  );

  // Tenant pin. libSQL has no row-level security; this read is not scoped by a
  // viewer at all (it maps ids to numbers), so the tenant pin is what keeps it
  // from indexing another tenant's audits.
  assert.match(
    src,
    /\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/,
    "every bulk read must pin the tenant -- libSQL has no row-level security",
  );

  // Truncation must throw, never degrade. A short read here does not blank the
  // page: it quietly demotes real scored leads to "not scored" and drops them
  // out of every band filter, handing a rep a queue that looks complete.
  assert.match(
    src,
    /score_index_truncated/,
    "a truncated score read must throw, not serve a silently incomplete index",
  );

  // Never invent a number for a null column.
  assert.match(
    src,
    /typeof r\.quality_score !== "number"/,
    "a null quality_score must be skipped, not coerced to 0",
  );
}

// ---------------------------------------------------------------------------
// 3. Ordering: a missing score is not a low score.
// ---------------------------------------------------------------------------

{
  const src = read("lib/web-leads/data.ts");
  const cmp = src.match(/function comparatorFor\([\s\S]*?\n\}/);
  assert.ok(cmp, "comparatorFor must exist in lib/web-leads/data.ts");

  // Unscored leads sort after every scored lead in BOTH score orders. Treating
  // "we never measured this" as a 0 would fill the top of the "lowest score
  // first" queue with businesses whose problems a rep cannot name -- the worst
  // possible first call of the day.
  assert.match(
    cmp[0],
    /aHas !== bHas/,
    "the score comparator must separate scored from unscored rather than ranking null as a number",
  );

  // Total order, so paging is stable. Without a tiebreak, two leads on the same
  // score can swap between requests: a rep sees one business twice across two
  // pages and never sees another at all.
  assert.match(cmp[0], /byName\(a, b\)/, "the score comparator must break ties on name for stable paging");
}

// ---------------------------------------------------------------------------
// 4. Band and sort survive the URL, and garbage does not become a filter.
// ---------------------------------------------------------------------------

{
  const round = (qs: string) => parseFilters(new URLSearchParams(qs));

  assert.equal(round("").band, "all", "no band param means every lead");
  assert.equal(round("").sort, "opportunity", "the default order is a sales queue, not an alphabet");

  assert.equal(round("band=under40").band, "under40");
  assert.equal(round("sort=name").sort, "name");

  // A hand-edited URL or a stale bookmark must fall back, not 500. A filter
  // page that dies on a typo is worse than one that shows everything.
  assert.equal(round("band=weak").band, "all", "an unknown band falls back to all");
  assert.equal(round("sort=whatever").sort, "opportunity", "an unknown sort falls back to the default");

  // Defaults stay out of the URL, matching view/page convention.
  const clean = filtersToParams({ ...EMPTY_FILTERS, band: "all", sort: "opportunity" }).toString();
  assert.equal(clean.includes("band="), false, "the default band must not appear in the URL");
  assert.equal(clean.includes("sort="), false, "the default sort must not appear in the URL");

  const dirty = filtersToParams({ ...EMPTY_FILTERS, band: "under40", sort: "name" });
  assert.equal(dirty.get("band"), "under40");
  assert.equal(dirty.get("sort"), "name");

  // Round-trip: what the UI writes, parseFilters reads back identically.
  const back = parseFilters(new URLSearchParams(dirty.toString()));
  assert.equal(back.band, "under40");
  assert.equal(back.sort, "name");
}

// ---------------------------------------------------------------------------
// 5. Call Mode cannot advance past a call it failed to record.
// ---------------------------------------------------------------------------

{
  const src = read("components/web-leads/CallMode.tsx");

  // Advancing on a failed write loses the call silently: the rep sees the queue
  // move, believes it was logged, and it was not. The failure branch must
  // return before next() is reached.
  const logFn = src.match(/const log = useCallback\([\s\S]*?\n {4}\[lead, note, pending, next\],/);
  assert.ok(logFn, "CallMode must have its log() callback");
  const failureBranch = logFn[0].match(/if \(!r\.ok\)[\s\S]*?\n {8}\}/);
  assert.ok(failureBranch, "log() must handle a non-ok response");
  assert.match(failureBranch[0], /return;/, "a failed outcome write must return, never fall through to next()");
  assert.doesNotMatch(failureBranch[0], /next\(\)/, "a failed outcome write must not advance the queue");

  // Typing a note must never fire a disposition. Without this guard, writing
  // "no answer, call back" into the note box logs four outcomes and skips four
  // leads.
  assert.match(
    src,
    /t\.tagName === "TEXTAREA"/,
    "the keyboard handler must ignore keystrokes aimed at a text field",
  );

  // The queue resets when it becomes a different queue -- otherwise "load the
  // next page" leaves the cursor past the end of the fresh array and the button
  // looks broken.
  assert.match(src, /\}, \[queueKey\]\);/, "CallMode must reset its cursor when the queue changes");
}

console.log("web-leads-scores ok");
