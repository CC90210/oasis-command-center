import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cronMatches } from "../src/cron-match";
import { CRON_TABLE, forwardingEnabled } from "../src/index";

// The kill switch decides whether 28 production routes get called. It must be
// permissive about SPELLING (an operator writing "true" must not silently get a
// dry worker) and strict about everything else (unset/typo => dry).
test("CRON_FORWARD accepts conventional truthy spellings", () => {
  for (const v of ["on", "true", "1", "yes", "ON", "True", " on ", "YES"]) {
    assert.equal(forwardingEnabled({ CRON_FORWARD: v }), true, `should forward: ${JSON.stringify(v)}`);
  }
});

test("CRON_FORWARD is fail-closed for anything else", () => {
  for (const v of [undefined, "", "off", "false", "0", "no", "onn", "enabled", "y"]) {
    assert.equal(forwardingEnabled({ CRON_FORWARD: v }), false, `should stay dry: ${JSON.stringify(v)}`);
  }
});

test("fan-out releases every unread response body", () => {
  const source = readFileSync("workers/oasis-cc-cron/src/index.ts", "utf8");
  assert.match(source, /await res\.body\?\.cancel\(\)/);
});

const at = (iso: string) => new Date(iso);

test("every table expression parses", () => {
  for (const e of CRON_TABLE) {
    assert.doesNotThrow(() => cronMatches(e.schedule, at("2026-08-31T00:00:00Z")), e.schedule);
  }
});

test("fixed daily: 0 3 * * *", () => {
  assert.equal(cronMatches("0 3 * * *", at("2026-08-31T03:00:00Z")), true);
  assert.equal(cronMatches("0 3 * * *", at("2026-08-31T03:01:00Z")), false);
  assert.equal(cronMatches("0 3 * * *", at("2026-08-31T04:00:00Z")), false);
});

test("hourly at minute: 17 * * * *", () => {
  assert.equal(cronMatches("17 * * * *", at("2026-08-31T09:17:00Z")), true);
  assert.equal(cronMatches("17 * * * *", at("2026-08-31T09:18:00Z")), false);
});

test("steps: */5, */10, */15, */30", () => {
  for (const [expr, n] of [["*/5 * * * *", 5], ["*/10 * * * *", 10], ["*/15 * * * *", 15], ["*/30 * * * *", 30]] as const) {
    for (let m = 0; m < 60; m++) {
      const d = new Date(Date.UTC(2026, 7, 31, 12, m));
      assert.equal(cronMatches(expr, d), m % n === 0, `${expr} @ :${m}`);
    }
  }
});

test("hour step: 0 */6 * * *", () => {
  for (let h = 0; h < 24; h++) {
    const d = new Date(Date.UTC(2026, 7, 31, h, 0));
    assert.equal(cronMatches("0 */6 * * *", d), h % 6 === 0, `hour ${h}`);
  }
  assert.equal(cronMatches("0 */6 * * *", at("2026-08-31T06:01:00Z")), false);
});

test("hour list: 0 6,18 * * *", () => {
  assert.equal(cronMatches("0 6,18 * * *", at("2026-08-31T06:00:00Z")), true);
  assert.equal(cronMatches("0 6,18 * * *", at("2026-08-31T18:00:00Z")), true);
  assert.equal(cronMatches("0 6,18 * * *", at("2026-08-31T12:00:00Z")), false);
});

test("weekly: 40 13 * * 1 fires only Monday", () => {
  assert.equal(cronMatches("40 13 * * 1", at("2026-08-31T13:40:00Z")), true);  // Monday
  assert.equal(cronMatches("40 13 * * 1", at("2026-09-01T13:40:00Z")), false); // Tuesday
  assert.equal(cronMatches("40 13 * * 1", at("2026-08-31T13:41:00Z")), false);
});

test("a Vercel-identical minute fires the exact due set", () => {
  // Monday 13:40 UTC — the */5 senders, the three */10 jobs, and the weekly
  // kixie scan. (*/30 does NOT fire at :40 — 40 % 30 !== 0.)
  const d = at("2026-08-31T13:40:00Z");
  const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, d)).map((e) => e.path).sort();
  assert.deepEqual(due, [
    "/api/cron/dispatch-bulk-email",
    "/api/cron/dispatch-drips",
    "/api/cron/dispatch-founder-meeting-reminders",
    "/api/cron/dispatch-scheduled-calls",
    "/api/cron/dispatch-scheduled-sends",
    "/api/cron/kixie-compliance-scan?mode=weekly",
    "/api/cron/operator-email-agent?write=1",
    "/api/cron/scan-lender-replies?write=1",
    "/api/cron/sms-reply-agent",
    "/api/cron/tps-enroll?write=1",
  ].sort());
});
