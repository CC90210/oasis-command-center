/**
 * skills-tab-view.test.ts - the Skills tab's pure view logic (JARVIS plan 3, Task 6).
 * PINNED: plain-English tile names; counts never include skills missing from this computer;
 * a kind or skill with no record reads "not tested" and draws no squares (never green);
 * the status line in Toronto time turns amber after 26 h AND whenever the check-in's Toronto
 * calendar date is neither today nor yesterday, even under 26 h (crossing two midnights);
 * squares() floors the ok share so a near-perfect score still shows a miss; Training lists only
 * this computer's changes; WORSE totals first; toggling an add-sub cascades BOTH ways to the ops
 * that place a skill into it; a stale test record (older than the latest check-in) says so.
 * Run: node --import tsx tests/skills-tab-view.test.ts
 */
import assert from "node:assert/strict";
import { CHANGES, COMPUTER, LIB, NOW } from "./skills-tab-fixture";
import {
  activeChip, addToValue, changeFor, labelNames, members, recordsAgeLine, scoreText, search, sortTiles, squares, statusLine, testLine, tiles, toggleOp, totalsRows, training,
} from "../lib/skills/view";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}
console.log("skills-tab-view:");

check("tiles use plain-English names and fall back to the label name", () => {
  const t = tiles(LIB);
  assert.deepEqual(t.map((x) => x.title), ["Fix something broken", "Build a screen or page", "A kind with no short name yet"]);
  assert.equal(t[0].long, "Something is broken, wrong, failing or behaving unexpectedly");
});

check("a tile counts only skills that are on this computer", () => {
  const t = tiles(LIB);
  assert.equal(t.find((x) => x.id === "debug")?.skills, 3);
  assert.equal(t.find((x) => x.id === "ui-build")?.skills, 1);   // not-installed-here is not counted
});

check("a kind with no score reads not tested", () => {
  const t = tiles(LIB).find((x) => x.id === "brand-new-kind");
  assert.equal(t?.score, null);
  assert.equal(scoreText(t?.score ?? null), "Not tested yet");
  assert.equal(scoreText({ n: 32, ok: 27 }), "27 of 32");
});

check("weakest sorts the lowest routed-right rate first and untested last", () => {
  assert.deepEqual(sortTiles(tiles(LIB), "weakest").map((x) => x.id), ["ui-build", "debug", "brand-new-kind"]);
  assert.deepEqual(sortTiles(tiles(LIB), "biggest").map((x) => x.id), ["debug", "ui-build", "brand-new-kind"]);
});

check("members lists use-first before also-helps and filters by sub-label", () => {
  assert.deepEqual(members(LIB, "debug", null).map((m) => [m.skill.name, m.rank]),
    [["graft", "use-first"], ["superpowers:systematic-debugging", "use-first"], ["turso-cloud", "also-helps"]]);
  assert.deepEqual(members(LIB, "debug", "debug-slow-query").map((m) => m.skill.name), ["graft", "turso-cloud"]);
});

check("no record draws no squares and never reads as tested", () => {
  assert.deepEqual(squares(null), []);
  assert.deepEqual(squares({ n: 0, ok: 0 }), []);
  assert.deepEqual(testLine(null), { text: "Not tested, no evidence", tested: false });
  assert.deepEqual(testLine({ n: 0, ok: 0 }), { text: "Not tested, no evidence", tested: false });
  assert.deepEqual(squares({ n: 4, ok: 3 }), ["ok", "ok", "ok", "miss"]);
  assert.equal(testLine({ n: 4, ok: 3 }).text, "3 of 4 test prompts routed here");
});

check("D5: squares floors the ok share so a near-perfect score still shows a miss", () => {
  const sq = squares({ n: 100, ok: 99 });
  assert.equal(sq.length, 40);
  assert.ok(sq.includes("miss"), "99 of 100 is not a perfect score and must draw at least one miss");
  assert.equal(sq.filter((s) => s === "miss").length, 1);
});

check("fix round 1 #1: squares never under-counts below the cap (integer multiply-first, no float division)", () => {
  // Plain `(ok/n)*n` floating-point division lands a hair under the true integer here.
  assert.equal(squares({ n: 22, ok: 15 }).filter((s) => s === "ok").length, 15);
  for (let n = 1; n <= 40; n += 1) {
    for (let ok = 0; ok <= n; ok += 1) {
      const got = squares({ n, ok }).filter((s) => s === "ok").length;
      assert.equal(got, ok, `n=${n} ok=${ok} got ${got}`);
    }
  }
});

check("the status line is in Toronto time and turns amber after 26 hours", () => {
  assert.deepEqual(statusLine(COMPUTER.last_checkin_at, new Date(NOW)), { text: "Checked in at 2:04 am", stale: false });
  assert.deepEqual(statusLine("2026-10-11T20:04:00.000Z", new Date(NOW)), { text: "Checked in yesterday at 4:04 pm", stale: false });
  assert.deepEqual(statusLine("2026-10-11T06:04:00.000Z", new Date(NOW)), { text: "Last checked in 1 day ago", stale: true });
  assert.deepEqual(statusLine("2026-10-10T06:04:00.000Z", new Date(NOW)), { text: "Last checked in 2 days ago", stale: true });
  assert.deepEqual(statusLine(null, new Date(NOW)), { text: "Not checked in yet", stale: true });
});

check("D4: a check-in two Toronto calendar days back reads days-ago even under 26 hours", () => {
  // now = 00:30 Toronto on 2026-10-13 (04:30 UTC); check-in = 23:30 Toronto on 2026-10-11
  // (03:30 UTC on 2026-10-12), 25 hours earlier but two calendar dates back, not "yesterday".
  const now2 = new Date("2026-10-13T04:30:00.000Z");
  assert.deepEqual(statusLine("2026-10-12T03:30:00.000Z", now2), { text: "Last checked in 2 days ago", stale: true });
});

check("fix round 1 #2: yesterday survives both DST transition days (spring-forward and fall-back)", () => {
  // Spring forward: clocks skip 2:00-3:00 am on 2026-03-08, so that Toronto day is 23 hours.
  // Check-in 2026-03-08 22:00 Toronto (EDT, after the jump) = 2026-03-09T02:00:00.000Z.
  // Read at 2026-03-09 00:30 Toronto (EDT) = 2026-03-09T04:30:00.000Z.
  assert.deepEqual(
    statusLine("2026-03-09T02:00:00.000Z", new Date("2026-03-09T04:30:00.000Z")),
    { text: "Checked in yesterday at 10:00 pm", stale: false },
  );
  // Fall back: clocks repeat 1:00-2:00 am on 2026-11-01, so that Toronto day is 25 hours.
  // Check-in 2026-10-31 23:00 Toronto (EDT) = 2026-11-01T03:00:00.000Z.
  // Read at 2026-11-01 23:30 Toronto (EST, after the fallback) = 2026-11-02T04:30:00.000Z.
  assert.deepEqual(
    statusLine("2026-11-01T03:00:00.000Z", new Date("2026-11-02T04:30:00.000Z")),
    { text: "Checked in yesterday at 11:00 pm", stale: false },
  );
});

check("training lists only this computer's changes, recent ones, newest first", () => {
  const l = training(CHANGES, COMPUTER.id, new Date(NOW));
  assert.deepEqual(l.held.map((c) => c.change_id), ["ch-held"]);
  assert.deepEqual(l.failed.map((c) => c.change_id), ["ch-failed"]);
  assert.deepEqual(l.waiting.map((c) => c.change_id), ["ch-wait"]);
  assert.deepEqual(l.applied.map((c) => c.change_id), ["ch-applied"]);
});

check("totals put the kind of work that got worse first, with plain names", () => {
  const rows = totalsRows(CHANGES[0], LIB);
  assert.deepEqual(rows.map((r) => [r.name, r.before, r.after, r.delta]), [["Sell, price and pitch", 7, 6, -1], ["Plan a new feature", 12, 13, 1]]);
});

check("unticking an add-sub unticks the skills that go into it", () => {
  const ops = CHANGES[0].ops;
  assert.deepEqual(toggleOp(ops, [true, true, true], 0), [false, false, true]);
  assert.deepEqual(toggleOp(ops, [true, true, true], 1), [true, false, true]);
});

check("D3: ticking an op whose label names an unticked add-sub re-ticks that add-sub", () => {
  const ops = CHANGES[0].ops;
  // Starting from the add-sub already unticked (and its dependent op with it), ticking the
  // dependent assign op back on must bring the add-sub back with it.
  assert.deepEqual(toggleOp(ops, [false, false, true], 1), [true, true, true]);
  // The unrelated op (index 2, label "debug") never touches the add-sub either way.
  assert.deepEqual(toggleOp(ops, [false, true, false], 2), [false, true, true]);
});

check("a skill edit becomes one op with a plain description, shared on the primary computer", () => {
  const names = labelNames(LIB);
  assert.deepEqual(changeFor({ kind: "use-first", skill: "turso-cloud", label: "debug-slow-query" }, names, "shared"),
    { description: "Put turso-cloud in Speed up a slow query as use first", scope: "shared",
      ops: [{ op: "assign", skill: "turso-cloud", label: "debug-slow-query", rank: "use-first" }] });
  assert.deepEqual(changeFor({ kind: "remove", skill: "graft", label: "debug" }, names, "pc-1").ops, [{ op: "unassign", skill: "graft", label: "debug" }]);
});

check("search puts a name match first and an empty query lists kinds of work", () => {
  const t = tiles(LIB);
  assert.equal(search(LIB, t, "graf")[0].name, "graft");
  assert.ok(search(LIB, t, "").every((h) => h.kind === "group"));
  assert.deepEqual(search(LIB, t, "zzzz"), []);
});

check("fix round 1 (task 7) #1: activeChip ignores a chip that does not belong to the current kind", () => {
  const debugTile = tiles(LIB).find((t) => t.id === "debug") ?? null;
  const uiTile = tiles(LIB).find((t) => t.id === "ui-build") ?? null;
  // debugTile really has this sub-label: kept.
  assert.equal(activeChip(debugTile, "debug-slow-query"), "debug-slow-query");
  // The screen jumped from debug to ui-build without going through the back button; ui-build has
  // no sub-labels at all in this fixture, so a chip picked under debug must not keep filtering here.
  assert.equal(activeChip(uiTile, "debug-slow-query"), null);
  assert.equal(activeChip(null, "debug-slow-query"), null);
  assert.equal(activeChip(debugTile, null), null);
});

check("Task 4: a stale test record (older than the latest check-in) reads a plain date, otherwise null", () => {
  // Same Toronto calendar date as the check-in: no caveat needed.
  assert.equal(recordsAgeLine("2026-10-12T05:00:00.000Z", COMPUTER.last_checkin_at), null);
  // One Toronto calendar day older than the check-in: the plain-English date line.
  assert.equal(recordsAgeLine("2026-10-11T10:00:00.000Z", COMPUTER.last_checkin_at), "Test record from Oct 11");
  // No records at all: "not tested yet" is said elsewhere, so no age line either.
  assert.equal(recordsAgeLine(null, COMPUTER.last_checkin_at), null);
});

check("fix round 1 (task 8) #1: addToValue falls back when the chosen id is no longer addable", () => {
  const addable = [{ id: "a" }, { id: "b" }];
  // The stored choice is still a real option: kept as-is.
  assert.equal(addToValue(addable, "b"), "b");
  // The screen moved to a different skill/library without a remount; "c" was addable there but
  // is not one of THIS skill's options - must not keep pointing at it (the old bug: a bare
  // `addTo` would return "c" here, while the <select> itself silently shows "a" selected).
  assert.equal(addToValue(addable, "c"), "a");
  // No addable options at all: falls back to "", never a stale id.
  assert.equal(addToValue([], "a"), "");
});

console.log(`skills-tab-view: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
