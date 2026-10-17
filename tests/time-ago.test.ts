/**
 * tests/time-ago.test.ts - one "time ago" vocabulary for every screen.
 *
 * WHY. About a dozen hand-rolled helpers said the same thing a dozen ways:
 * "never" here and a dash there, "5m ago" and "5 min ago" and "5 minutes ago",
 * and some turned into a date after 30 days while others counted days
 * forever. lib/devices/presence.ts timeAgo is now the only implementation;
 * this pins its wording and the options a screen may use to differ.
 *
 * Pure. The date cases build their instants from LOCAL calendar parts so they
 * hold in any time zone the test runs in.
 *
 * Run: node --conditions=react-server --import tsx tests/time-ago.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TIME_AGO_NEVER, timeAgo } from "../lib/devices/presence";

const root = join(__dirname, "..");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A local noon, so every date below is the same calendar day in any zone.
const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime();
const before = (ms: number) => NOW - ms;
const after = (ms: number) => NOW + ms;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The date as the helper should write it, from the instant's own local parts. */
const dateWords = (ms: number, withYear = false) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ""}`;
};

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

console.log("time-ago:");

check("no time at all is one word: never", () => {
  assert.equal(TIME_AGO_NEVER, "never");
  for (const none of [null, undefined, "", "not a date", Number.NaN, new Date("nope")]) {
    assert.equal(timeAgo(none, { now: NOW }), "never", `${String(none)}`);
  }
});

check("under a minute is just now, and the edge is the minute", () => {
  assert.equal(timeAgo(before(0), { now: NOW }), "just now");
  assert.equal(timeAgo(before(5_000), { now: NOW }), "just now");
  assert.equal(timeAgo(before(MIN - 1), { now: NOW }), "just now");
  assert.equal(timeAgo(before(MIN), { now: NOW }), "1 min ago");
});

check("minutes, hours and days count whole units, rounded down", () => {
  assert.equal(timeAgo(before(2 * MIN + 59_000), { now: NOW }), "2 min ago");
  assert.equal(timeAgo(before(HOUR - 1), { now: NOW }), "59 min ago");
  assert.equal(timeAgo(before(HOUR), { now: NOW }), "1 h ago");
  assert.equal(timeAgo(before(3 * HOUR + 40 * MIN), { now: NOW }), "3 h ago");
  assert.equal(timeAgo(before(DAY - 1), { now: NOW }), "23 h ago");
  assert.equal(timeAgo(before(DAY), { now: NOW }), "1 d ago");
  assert.equal(timeAgo(before(47 * HOUR), { now: NOW }), "1 d ago", "47 hours is one whole day");
  assert.equal(timeAgo(before(30 * DAY - 1), { now: NOW }), "29 d ago");
});

check("from 30 days it is a short date, with the year only when it is not this year", () => {
  assert.equal(timeAgo(before(30 * DAY), { now: NOW }), dateWords(before(30 * DAY)), "exactly 30 days is the date, not '30 d ago'");
  assert.equal(timeAgo(new Date(2026, 0, 3, 9).getTime(), { now: NOW }), "Jan 3");
  assert.equal(timeAgo(new Date(2025, 9, 3, 9).getTime(), { now: NOW }), "Oct 3, 2025");
  assert.equal(timeAgo(new Date(2025, 11, 31, 23, 30).toISOString(), { now: new Date(2026, 1, 20, 12).getTime() }), "Dec 31, 2025", "last year's date in February still names the year");
});

check("an ISO string, epoch milliseconds and a Date are the same instant", () => {
  const ms = before(5 * MIN);
  assert.equal(timeAgo(new Date(ms).toISOString(), { now: NOW }), "5 min ago");
  assert.equal(timeAgo(ms, { now: NOW }), "5 min ago");
  assert.equal(timeAgo(new Date(ms), { now: NOW }), "5 min ago");
  assert.notEqual(timeAgo(0, { now: NOW }), "never", "epoch 0 is a real instant, not 'no time'");
});

check("a moment ahead of the clock is just now unless the caller says it is scheduled", () => {
  assert.equal(timeAgo(after(5_000), { now: NOW }), "just now");
  assert.equal(timeAgo(after(3 * DAY), { now: NOW }), "just now");
});

check("future: true reads a scheduled moment as in, never as ago", () => {
  const f = (ms: number) => timeAgo(NOW + ms, { now: NOW, future: true });
  assert.equal(f(20_000), "in under a minute");
  assert.equal(f(MIN), "in 1 min");
  assert.equal(f(5 * MIN), "in 5 min");
  assert.equal(f(3 * HOUR), "in 3 h");
  assert.equal(f(2 * DAY), "in 2 d");
  assert.equal(f(40 * DAY), dateWords(NOW + 40 * DAY), "far out it is the date, like the past");
  assert.equal(f(-20_000), "just now", "future: true does not change the past");
  assert.equal(f(-2 * HOUR), "2 h ago");
  assert.equal(f(-DAY), "1 d ago");
});

check("with no options it reads the real clock", () => {
  assert.equal(timeAgo(new Date().toISOString()), "just now");
  assert.equal(timeAgo(Date.now() - 5 * MIN - 500), "5 min ago");
});

// One implementation

/** Source files (not tests) under the app's three code directories. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && !name.startsWith(".")) sources(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** A file that still declares its own timeAgo, and why it was left. */
const OWN_TIME_AGO: Record<string, string> = {
  "components/sunbiz/SunBizDashboard.tsx":
    "SunBiz is retired (lib/tenant/retired.ts); the page only renders in the demo preview, where this stamp is never drawn",
};

check("presence.ts is the only place that works out a time ago", () => {
  const defining: string[] = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sources(join(root, dir))) {
      const text = readFileSync(file, "utf8");
      if (/\bfunction\s+timeAgo\s*\(|\b(?:const|let)\s+timeAgo\s*=/.test(text)) defining.push(relative(root, file).replace(/\\/g, "/"));
    }
  }
  const unexpected = defining.filter((f) => f !== "lib/devices/presence.ts" && !(f in OWN_TIME_AGO));
  assert.deepEqual(unexpected, [], "a second timeAgo is a second vocabulary: call lib/devices/presence.ts and add an option there");
  assert.ok(defining.includes("lib/devices/presence.ts"), "presence.ts still defines it");
});

check("lib/fmt.ts passes timeAgo through and does not carry its own", () => {
  const fmt = readFileSync(join(root, "lib/fmt.ts"), "utf8");
  assert.match(fmt, /export \{ timeAgo \} from "@\/lib\/devices\/presence";/);
  assert.doesNotMatch(fmt, /\bago\b`/, "no 'N ago' string in fmt.ts");
});

if (failures) {
  console.error(`time-ago: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("time-ago: all checks passed");
