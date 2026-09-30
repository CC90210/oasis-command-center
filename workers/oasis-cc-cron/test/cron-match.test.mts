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
  // Monday 13:40 UTC — the */5 senders and the */10 operator email agent.
  // (*/15 does NOT fire at :40 — 40 % 15 !== 0.) The SunBiz-only routes that
  // also fired here (dispatch-bulk-email, the weekly kixie scan,
  // scan-lender-replies, tps-enroll) were unscheduled when SunBiz was retired
  // on 2026-09-28 (0860f968); none of them may come back.
  const d = at("2026-08-31T13:40:00Z");
  const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, d)).map((e) => e.path).sort();
  assert.deepEqual(due, [
    "/api/cron/dispatch-drips",
    "/api/cron/dispatch-founder-meeting-reminders",
    "/api/cron/dispatch-scheduled-calls",
    "/api/cron/dispatch-scheduled-sends",
    "/api/cron/operator-email-agent?write=1",
    "/api/cron/sms-reply-agent",
  ].sort());
});

test("the books' daily jobs each fire once a day, alone in their minute, in order", () => {
  // lib/founders-finances/books-cron.ts: rates, then Stripe (payouts leave
  // clearing before the bank feed looks), then Wise invoice matches, then the
  // feed. Each on its own minute, off the 5-minute grid, so none shares a
  // tick with another job.
  const order = ["fx-refresh", "stripe-reconcile", "wise-reconcile", "wise-sync"];
  const fired: Array<{ job: string; minute: number }> = [];
  for (let m = 0; m < 24 * 60; m++) {
    const d = new Date(Date.UTC(2026, 8, 30, 0, m));
    const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, d)).map((e) => e.path);
    const books = due.filter((p) => p.startsWith("/api/cron/finance-books?job="));
    for (const p of books) {
      fired.push({ job: p.slice("/api/cron/finance-books?job=".length), minute: m });
      assert.deepEqual(due, [p], `${p} shares minute ${m} with ${due.join(", ")}`);
    }
  }
  assert.deepEqual(fired.map((f) => f.job), order, "each job fires exactly once a day, in dependency order");
  // The Bank of Canada publishes by 16:30 Eastern: 21:30 UTC in winter (EST).
  // fx-refresh at 21:23 ran before it half the year (the #491 review), so it
  // runs after 21:45 UTC, with the Stripe reconcile after it.
  const fx = fired.find((f) => f.job === "fx-refresh");
  assert.ok(fx && fx.minute >= 21 * 60 + 45, `fx-refresh fires after 21:45 UTC (fires at minute ${fx?.minute})`);
});
