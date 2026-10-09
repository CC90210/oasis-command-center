import test from "node:test";
import assert from "node:assert/strict";
import {
  fmtInt, fmtSignedInt, fmtCtr, fmtPos, fmtDate, fmtMonth, fmtTimestamp,
  pctChange, ppChange, posChange, parseRange, pagePath, STATUS_LABEL,
} from "../lib/seo/format";

test("unknown in, null out: the view prints a dash, never 0", () => {
  for (const f of [fmtInt, fmtSignedInt, fmtCtr, fmtPos]) {
    assert.equal(f(null), null);
    assert.equal(f(undefined), null);
  }
  assert.equal(fmtDate(null), null);
  assert.equal(fmtTimestamp(null), null);
});

test("a real zero is a zero", () => {
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtCtr(0), "0.0%");
});

test("numbers", () => {
  assert.equal(fmtInt(7958), "7,958");
  assert.equal(fmtSignedInt(12), "+12");
  assert.equal(fmtSignedInt(-1200), "−1,200");
  assert.equal(fmtSignedInt(0), "0");
  assert.equal(fmtCtr(0.04976), "5.0%");
  assert.equal(fmtPos(8.4567), "8.5");
});

test("dates are fixed strings, never the machine's locale", () => {
  assert.equal(fmtDate("2026-10-05"), "Oct 5, 2026");
  assert.equal(fmtMonth("2026-03"), "Mar 2026");
  assert.match(fmtTimestamp("2026-10-07T16:40:00Z") ?? "", /^Oct 7, 2026, 12:40\sPM ET$/);
});

test("pctChange: no comparison when either side is unknown", () => {
  assert.equal(pctChange(10, null), null);
  assert.equal(pctChange(null, 10), null);
  assert.equal(pctChange(undefined, 10), null);
});

test("pctChange: up, down, flat and from zero", () => {
  assert.deepEqual(pctChange(110, 100), { text: "+10.0%", tone: "good", sr: "up 10.0 percent" });
  assert.deepEqual(pctChange(90, 100), { text: "−10.0%", tone: "bad", sr: "down 10.0 percent" });
  assert.deepEqual(pctChange(100, 100), { text: "0.0%", tone: "flat", sr: "no change" });
  assert.deepEqual(pctChange(5, 0), { text: "new", tone: "good", sr: "new, none in the earlier period" });
  assert.deepEqual(pctChange(0, 0), { text: "0.0%", tone: "flat", sr: "no change" });
});

test("ppChange: CTR moves in percentage points", () => {
  assert.deepEqual(ppChange(0.05, 0.046), { text: "+0.4 pts", tone: "good", sr: "up 0.4 points" });
  assert.equal(ppChange(null, 0.04), null);
  assert.equal(ppChange(0.04, null), null);
});

test("posChange: a LOWER position is an improvement", () => {
  assert.deepEqual(posChange(5.5, 8), { text: "−2.5", tone: "good", sr: "moved up 2.5 positions" });
  assert.deepEqual(posChange(9, 8), { text: "+1.0", tone: "bad", sr: "moved down 1.0 positions" });
  assert.deepEqual(posChange(8.02, 8), { text: "0.0", tone: "flat", sr: "no change" });
  assert.equal(posChange(null, 8), null);
});

test("parseRange defaults anything unknown to 28d", () => {
  assert.equal(parseRange("3m"), "3m");
  assert.equal(parseRange("16m"), "16m");
  for (const bad of [undefined, "", "7d", ["3m"], "28D"]) assert.equal(parseRange(bad), "28d");
});

test("every status the API can send has a label", () => {
  for (const s of ["current", "behind", "waiting", "collecting", "access_removed"] as const) assert.ok(STATUS_LABEL[s]);
});

test("pagePath shows the path of a page URL, and the input when it is not a URL", () => {
  assert.equal(pagePath("https://oasisai.work/services/seo?x=1"), "/services/seo?x=1");
  assert.equal(pagePath("https://oasisai.work/"), "/");
  assert.equal(pagePath("not a url"), "not a url");
});
