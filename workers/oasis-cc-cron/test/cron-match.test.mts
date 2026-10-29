import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cronMatches, isValidCronExpression, isValidTimeZone } from "../src/cron-match";
import { CRON_TABLE, cronEntryMatches, forwardingEnabled } from "../src/index";

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

// The exact UTC matcher replaced by this change. Keeping it in the regression
// test proves the optional-zone default does not move any existing due minute.
function legacyCronMatches(expr: string, instant: Date): boolean {
  const partMatches = (part: string, value: number) => {
    if (part === "*") return true;
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (range) {
      const [lo, hi, stride] = [Number(range[1]), Number(range[2]), Number(range[3] || 1)];
      return value >= lo && value <= hi && (value - lo) % stride === 0;
    }
    return Number(part) === value;
  };
  const fieldMatches = (field: string, value: number) => field.split(",").some((part) => partMatches(part, value));
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const dateOk = dayOfMonth !== "*" && dayOfWeek !== "*"
    ? fieldMatches(dayOfMonth, instant.getUTCDate()) || fieldMatches(dayOfWeek, instant.getUTCDay())
    : fieldMatches(dayOfMonth, instant.getUTCDate()) && fieldMatches(dayOfWeek, instant.getUTCDay());
  return fieldMatches(minute, instant.getUTCMinutes()) &&
    fieldMatches(hour, instant.getUTCHours()) &&
    fieldMatches(month, instant.getUTCMonth() + 1) &&
    dateOk;
}

test("every table expression parses", () => {
  assert.equal(CRON_TABLE.length, 23, "the existing registry has 23 schedules");
  for (const e of CRON_TABLE) {
    assert.doesNotThrow(() => cronMatches(e.schedule, at("2026-08-31T00:00:00Z")), e.schedule);
    assert.equal(isValidCronExpression(e.schedule), true, `${e.path}: ${e.schedule}`);
    if (e.timeZone !== undefined) assert.equal(isValidTimeZone(e.timeZone), true, `${e.path}: ${e.timeZone}`);
  }
});

test("the optional zone defaults to UTC, preserving all 23 existing schedules", () => {
  const first = Date.parse("2026-10-31T00:00:00Z");
  const last = Date.parse("2026-11-03T00:00:00Z");
  for (const entry of CRON_TABLE) {
    assert.equal(entry.timeZone, undefined, `${entry.path} must remain on its current implicit UTC behavior`);
    for (let time = first; time <= last; time += 60_000) {
      const instant = new Date(time);
      assert.equal(
        cronMatches(entry.schedule, instant),
        legacyCronMatches(entry.schedule, instant),
        `${entry.path} changed at ${instant.toISOString()}`,
      );
    }
  }
});

test("day names are case-insensitive and work as singles, comma lists, and ranges", () => {
  const week = [
    ["SUN", "2026-11-01T09:00:00Z"],
    ["mon", "2026-11-02T09:00:00Z"],
    ["TuE", "2026-11-03T09:00:00Z"],
    ["WED", "2026-11-04T09:00:00Z"],
    ["thu", "2026-11-05T09:00:00Z"],
    ["FRI", "2026-11-06T09:00:00Z"],
    ["sat", "2026-11-07T09:00:00Z"],
  ] as const;
  for (const [name, iso] of week) {
    assert.equal(cronMatches(`0 9 * * ${name}`, at(iso)), true, name);
  }
  assert.equal(cronMatches("0 9 * * MON,wed,FRI", at("2026-11-04T09:00:00Z")), true);
  assert.equal(cronMatches("0 9 * * MON,wed,FRI", at("2026-11-05T09:00:00Z")), false);
  for (const iso of ["2026-11-02T09:00:00Z", "2026-11-04T09:00:00Z", "2026-11-06T09:00:00Z"]) {
    assert.equal(cronMatches("0 9 * * mon-FRI", at(iso)), true, iso);
  }
  for (const iso of ["2026-11-01T09:00:00Z", "2026-11-07T09:00:00Z"]) {
    assert.equal(cronMatches("0 9 * * mon-FRI", at(iso)), false, iso);
  }
});

test("invalid day names and time zones fail closed", () => {
  for (const expr of ["0 9 * * FUNDAY", "0 9 * * MONDAY", "0 9 * * MON-FUNDAY", "0 9 * * MON,,FRI"]) {
    assert.equal(isValidCronExpression(expr), false, expr);
    assert.equal(cronMatches(expr, at("2026-11-02T09:00:00Z")), false, expr);
  }
  assert.equal(isValidTimeZone("America/Toronto"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  for (const zone of ["", "+01:00", "Toronto", "Mars/Olympus_Mons", "America/Not_A_Zone"]) {
    assert.equal(isValidTimeZone(zone), false, zone);
    assert.equal(cronMatches("0 9 * * MON", at("2026-11-02T14:00:00Z"), zone), false, zone);
  }
});

test("a Toronto wall-clock schedule follows the 2026 fall-back transition", () => {
  const entry = { path: "/test", schedule: "0 9 * * SUN", timeZone: "America/Toronto" };
  // Oct 25 is still EDT (UTC-4); Nov 1 is EST after the clocks fall back (UTC-5).
  assert.equal(cronEntryMatches(entry, at("2026-10-25T13:00:00Z")), true);
  assert.equal(cronEntryMatches(entry, at("2026-10-25T14:00:00Z")), false);
  assert.equal(cronEntryMatches(entry, at("2026-11-01T13:00:00Z")), false);
  assert.equal(cronEntryMatches(entry, at("2026-11-01T14:00:00Z")), true);
  assert.equal(cronEntryMatches({ ...entry, timeZone: "America/Not_A_Zone" }, at("2026-11-01T14:00:00Z")), false);
});

test("Toronto fixed times use the first fall-back occurrence", () => {
  const fallBack = { path: "/fixed-fall", schedule: "30 1 * * *", timeZone: "America/Toronto" };
  assert.equal(cronEntryMatches(fallBack, at("2026-11-01T05:30:00Z")), true, "first 01:30 EDT fires");
  assert.equal(cronEntryMatches(fallBack, at("2026-11-01T06:30:00Z")), false, "repeated 01:30 EST does not fire twice");
});

test("Toronto fixed times shift once through the spring gap", () => {
  const springForward = { path: "/fixed-spring", schedule: "30 2 * * *", timeZone: "America/Toronto" };
  assert.equal(cronEntryMatches(springForward, at("2026-03-08T07:30:00Z")), true, "missing 02:30 is pushed to 03:30 EDT");
  assert.equal(cronEntryMatches(springForward, at("2026-03-08T06:30:00Z")), false, "01:30 EST is not the shifted run");
  assert.equal(cronEntryMatches(springForward, at("2026-03-08T08:30:00Z")), false, "the shifted run happens only once");
});

test("Toronto every-hour schedules keep both elapsed hours across DST", () => {
  const hourly = { path: "/hourly", schedule: "0 * * * *", timeZone: "America/Toronto" };
  assert.equal(cronEntryMatches(hourly, at("2026-11-01T05:00:00Z")), true, "01:00 EDT");
  assert.equal(cronEntryMatches(hourly, at("2026-11-01T06:00:00Z")), true, "01:00 EST");
  assert.equal(cronEntryMatches(hourly, at("2026-03-08T06:00:00Z")), true, "01:00 EST");
  assert.equal(cronEntryMatches(hourly, at("2026-03-08T07:00:00Z")), true, "03:00 EDT; the missing wall hour creates no phantom run");
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
  // on 2026-09-28 (0860f968); none of them may come back. Oasis Meet's relay
  // upkeep (*/5, #685) fires here too.
  const d = at("2026-08-31T13:40:00Z");
  const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, d)).map((e) => e.path).sort();
  assert.deepEqual(due, [
    "/api/cron/ai-audit-tick",
    "/api/cron/dispatch-automations",
    "/api/cron/dispatch-engine-fallbacks",
    "/api/cron/dispatch-drips",
    "/api/cron/dispatch-founder-meeting-reminders",
    "/api/cron/dispatch-scheduled-calls",
    "/api/cron/dispatch-scheduled-sends",
    "/api/cron/meet-relay",
    "/api/cron/operator-email-agent?write=1",
    "/api/cron/sms-reply-agent",
  ].sort());
});

test("the books' daily jobs each fire once a day, sharing only the every-minute dispatchers (engine fallbacks, guided automations, meeting reminders), in order", () => {
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
      assert.deepEqual(
        due.sort(),
        [
          "/api/cron/dispatch-automations",
          "/api/cron/dispatch-engine-fallbacks",
          // Every minute since 2026-10-28: the reminder ladder ends 5 minutes out.
          "/api/cron/dispatch-founder-meeting-reminders",
          p,
        ].sort(),
        `${p} shares minute ${m} with an unexpected route: ${due.join(", ")}`,
      );
    }
  }
  assert.deepEqual(fired.map((f) => f.job), order, "each job fires exactly once a day, in dependency order");
  // The Bank of Canada publishes by 16:30 Eastern: 21:30 UTC in winter (EST).
  // fx-refresh at 21:23 ran before it half the year (the #491 review), so it
  // runs after 21:45 UTC, with the Stripe reconcile after it.
  const fx = fired.find((f) => f.job === "fx-refresh");
  assert.ok(fx && fx.minute >= 21 * 60 + 45, `fx-refresh fires after 21:45 UTC (fires at minute ${fx?.minute})`);
});
