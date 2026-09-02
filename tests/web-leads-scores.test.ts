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
import { assertCompleteRead } from "../lib/web-leads/tenant";
import { parseFilters, filtersToParams, EMPTY_FILTERS } from "../lib/web-leads/filters";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// 1. resolveScore applies audit.ts's precedence, not a convenient one.
// ---------------------------------------------------------------------------

const index: ScoreIndex = {
  scored: new Map([["biz-scored", 34], ["biz-both", 71], ["biz-zero", 0], ["biz-parked-and-scored", 82]]),
  unreachable: new Set(["biz-unreachable", "biz-both"]),
  // `biz-parked-and-scored` carries BOTH a score and a parked mark on purpose.
  // That is not a contrived case: every one of the 53 parking pages in the
  // corpus WAS scored, at exactly 82, which is how two of them reached a
  // prospect as "best-scoring competitors" (2026-08-25). The precedence
  // assertions below are the thing that stops that number being shown.
  parked: new Set(["biz-parked", "biz-parked-and-scored"]),
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

// THE OTHER LOAD-BEARING ONE, added 2026-08-25 after it reached a prospect.
//
// `biz-parked-and-scored` holds a score of 82 AND a parked mark. That is the
// real shape, not a contrived one: all 53 HugeDomains parking pages in the
// corpus were scored, every one at exactly 82, and every one landed in the top
// tier -- because a parking page genuinely is fast, HTTPS, mobile-friendly and
// full of CTAs, which is what the 49 checks measure.
//
// Competitor selection takes the BEST-scoring peers, so an 82 outranked almost
// every real business. Two of them were shown to Adon on a live battle card as
// "best-scoring competitors", with links that opened hugedomains.com.
assert.deepEqual(
  resolveScore("https://example.com", "biz-parked-and-scored", index),
  { score: null, scoreState: "parked" },
  "a domain listed for sale must never carry its 82 -- that number describes a broker's landing page",
);

// Parked outranks unreachable too, and the order matters. We did not fail to
// reach a parked domain; we reached it perfectly and got a sales listing.
// Reporting "we could not check this site" swaps one false statement for
// another and throws away the strongest opener a rep has.
assert.deepEqual(
  resolveScore("https://example.com", "biz-parked", index),
  { score: null, scoreState: "parked" },
  "a parked domain names what it is",
);

assert.deepEqual(
  resolveScore(null, "biz-parked", index),
  { score: null, scoreState: "no_website" },
  "no website on the lead still outranks everything, parked included",
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
    /\.not\("profile",\s*"is",\s*null\)/,
    "the bulk audit read must exclude profile-less rows, which the panel treats as not_scored",
  );

  // PORTABILITY, not style. `.is("profile", "not.null")` works only against our
  // Turso adapter; real supabase-js serialises it to `profile=is.not.null`,
  // which PostgREST rejects, so every /api/web-leads request would 500 on that
  // backend. (Codex review, 2026-08-23.) Both backends are on the supported
  // production path, so a filter that compiles on only one of them is a bug
  // that no local test would ever surface.
  // Checked against CODE with comments stripped: the ban is on the call, and
  // the comment right above it necessarily quotes the wrong form to explain why
  // it is wrong.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    codeOnly,
    /\.is\([^)]*"not\.null"\)/,
    "adapter-only `is.not.null` syntax must not be used -- it breaks against real supabase-js",
  );

  // Same model version as the panel, or the list is scored by a different model.
  assert.match(
    src,
    /\.eq\("audit_version",\s*MODEL_VERSION\)/,
    "the bulk audit read must pin MODEL_VERSION, as audit.ts does",
  );

  // ONE definition of it, shared. Two constants that both say 1 today diverge
  // the moment someone bumps one of them, and the symptom is the list and the
  // panel silently selecting different audit versions -- the exact disagreement
  // these modules exist to prevent. (Codex review, 2026-08-23.)
  const declarations = [read("lib/web-leads/tenant.ts"), read("lib/web-leads/audit.ts"), src]
    .join("\n")
    .match(/^\s*(?:export\s+)?const MODEL_VERSION\s*=/gm) || [];
  assert.equal(
    declarations.length,
    1,
    `MODEL_VERSION must be declared exactly once and imported everywhere else, found ${declarations.length} declarations`,
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
  //
  // And it must be proved, not guessed at. A `rows.length >= LEAD_READ_CAP`
  // check only catches truncation by OUR cap; PostgREST enforces its own
  // server-side max-rows regardless of what `.limit()` asks for, and on that
  // path the check passes while most of the ~23K audits go missing. (Codex
  // review, 2026-08-23.) `count: "exact"` is computed by a separate COUNT(*)
  // with no limit applied, so comparing rows-returned against rows-matched
  // detects truncation from any source.
  //
  // TEN: five tenant-wide reads for the Leads pool and the same five
  // completeness-proved, business-id-bounded reads for the Pipeline. The
  // count is asserted exactly, not as a minimum, precisely so that adding a
  // read forces someone to come here and decide whether it needs the same
  // completeness proof. It did -- a truncated parked read leaves the parking
  // pages it missed sitting in `scored` at 82, back at the top of every peer
  // group, offered to prospects as their best competitor, with nothing on
  // screen looking wrong. This assertion is what caught that omission.
  //
  // WAS EIGHT until 2026-09-02 (instant-load P2). The parked read became TWO
  // reads per call site: the stored `is_parked = 1` verdict (migration 012,
  // indexed) plus the original LIKE net restricted to rows not yet stamped.
  // This assertion did its job again -- both new reads had to come here and
  // prove they carry the same exact-count completeness proof. They do.
  const counted = src.match(/\{ count: "exact" \}/g) || [];
  assert.equal(counted.length, 10, "all full and targeted score-index reads must request an exact count");
  // The open quote distinguishes a real call from a comment naming it.
  // Ten for the same reason as above: each of the two parked tiers proves its
  // own completeness at each call site. One shared proof would let the other
  // tier truncate silently.
  const asserted = src.match(/assertCompleteRead\("/g) || [];
  assert.equal(asserted.length, 10, "all full and targeted score-index reads must prove completeness before being used");
  assert.doesNotMatch(
    src,
    /length >= LEAD_READ_CAP/,
    "a row-count-versus-cap check is not a completeness check -- it passes silently when a server cap truncates below it",
  );

  // Never invent a number for a null column.
  assert.match(
    src,
    /typeof row\.quality_score !== "number"/,
    "a null quality_score must be skipped, not coerced to 0",
  );

  // NEWEST ROW FIRST, THEN ASK IF IT IS SCORED. Filtering profile-not-null in
  // SQL and taking the newest SURVIVOR is not the same thing: for a business
  // whose newest crawl has no profile but an older one does, it resurrects the
  // old score, so the table shows 61 while the panel says "Not scored yet".
  // (Codex review, 2026-08-23. Zero rows match in production today, which is
  // exactly why it would have gone unnoticed until the next re-crawl.)
  assert.match(
    src,
    /newestAt\.get\(row\.business_id\) !== row\.fetched_at/,
    "a score must be ignored unless its row is the business's NEWEST audit -- otherwise a superseded crawl resurfaces as a current score",
  );
  // An unfiltered read of every audit row, which is what the newest-per-business
  // pass runs over. The `is("profile", ...)` narrowing happens on a SEPARATE
  // read; if these two ever merge back into one, this fails.
  assert.match(
    src,
    /\.select\("business_id,fetched_at",\s*\{ count: "exact" \}\)/,
    "the newest audit per business must be derived from ALL rows, before any profile filter narrows them",
  );
}

// ---------------------------------------------------------------------------
// 2b. The completeness check itself, exercised rather than asserted about.
//
// Every guard above is a source match; this one runs the mechanism, because a
// completeness check that silently passes is indistinguishable from one that
// works right up until the day it matters.
// ---------------------------------------------------------------------------

assert.doesNotThrow(
  () => assertCompleteRead("t", [1, 2, 3], 3),
  "a complete read must pass",
);

assert.throws(
  () => assertCompleteRead("t", new Array(1000).fill(0), 23170),
  /t_truncated: got 1000 of 23170 rows/,
  "a server-side cap that truncates BELOW our own limit must still be caught -- this is the case the old cap comparison missed entirely",
);

assert.throws(
  () => assertCompleteRead("t", [1, 2, 3], null),
  /t_count_unavailable/,
  "a read that cannot prove it is complete must fail closed, not be assumed complete",
);

assert.doesNotThrow(
  () => assertCompleteRead("t", [], 0),
  "genuinely zero rows is a complete read, not a truncated one",
);

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

  // NO LEAD RESOLVES UNTIL THE LEADS ON SCREEN BELONG TO THIS QUEUE. Between
  // "load the next page" and that response landing, queueKey already names page
  // 2 while the parent still holds page 1. Gating on `loading` alone leaves a
  // window where the cursor has reset to 0 and Call Mode renders lead #1 of the
  // page just finished, with live disposition buttons -- so the rep calls and
  // logs a business they finished moments ago, and the duplicate looks exactly
  // like a real second attempt. (Codex review, 2026-08-23.)
  assert.match(
    src,
    /const lead: WebLeadRow \| undefined = ready \? leads\[i\] : undefined;/,
    "CallMode must resolve no lead at all until `ready` -- not merely until `loading` is false",
  );
  assert.match(
    src,
    /const atEnd = ready && i >= leads\.length;/,
    "the end-of-queue screen must also wait for the current queue, or it fires against the previous page's length",
  );

  // NOTHING MOVES THE QUEUE WHILE A WRITE IS IN FLIGHT. A successful log()
  // advances by itself; a Skip pressed between the POST leaving and returning
  // advances a second time and silently skips the lead in between -- never
  // called, never logged, nothing on screen to suggest it was missed. (Codex
  // review, 2026-08-23.) Must hold for the keyboard AND the buttons: reps use
  // both, and a guard on one of them is not a guard.
  // One condition, not a list of known cases. Both reported instances (mid-write
  // and mid-page-load) are the same bug: a keystroke moving a cursor that points
  // at nothing. `lead` is undefined in exactly those states.
  assert.match(
    src,
    /if \(pending \|\| !lead\) return;/,
    "the keyboard handler must refuse to navigate unless a lead is actually on screen and no write is in flight",
  );
  assert.match(
    src,
    /disabled=\{i === 0 \|\| pending !== null\}/,
    "the Back control must be disabled while an outcome write is in flight",
  );
  assert.match(
    src,
    /onClick=\{next\}\s*\n\s*disabled=\{pending !== null\}/,
    "the Skip control must be disabled while an outcome write is in flight",
  );
  assert.doesNotMatch(
    src,
    /loading: boolean;/,
    "CallMode must not take a bare `loading` flag -- `ready` is the stronger condition it needs",
  );
}

// The parent must stamp the leads with the query they came from, and compare
// that stamp -- not the loading flag -- when telling Call Mode it is safe.
{
  const src = read("components/web-leads/WebLeadsBrowser.tsx");
  assert.match(src, /setLeadsKey\(qs\)/, "loaded leads must be stamped with the query that fetched them");
  assert.match(
    src,
    /ready=\{!loading && leadsKey === queueKey\}/,
    "Call Mode's readiness must compare the loaded queue against the requested one",
  );
}

console.log("web-leads-scores ok");
