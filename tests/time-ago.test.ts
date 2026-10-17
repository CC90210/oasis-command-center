/**
 * tests/time-ago.test.ts - one "time ago" vocabulary for every screen.
 *
 * WHY. About a dozen hand-rolled helpers said the same thing a dozen ways:
 * "never" here and a dash there, "5m ago" and "5 min ago" and "5 minutes ago",
 * and some turned into a date after 30 days while others counted days
 * forever. lib/devices/presence.ts timeAgo is now the only implementation;
 * this pins its wording and the options a screen may use to differ. A few
 * stamps still word time their own way (NOT_MOVED_YET below, a follow-up),
 * and the guard at the end stops any new one, whatever its helper is called.
 *
 * Pure. The date cases build their instants from LOCAL calendar parts so they
 * hold in any time zone the test runs in.
 *
 * Run: node --conditions=react-server --import tsx tests/time-ago.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { relTime } from "../components/conversations/format";
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

check("moment: true is the device screens' wording: a moment once it is an hour old, relative before that", () => {
  const m = (ms: number) => timeAgo(NOW - ms, { now: NOW, moment: true });
  // Same words as the default under an hour, except seconds are counted ("a recent ping still reads in seconds").
  assert.equal(m(20_000), "20 s ago");
  assert.equal(m(1), "1 s ago", "never '0 s ago'");
  assert.equal(m(4 * MIN), "4 min ago");
  assert.equal(timeAgo(NOW + 5_000, { now: NOW, moment: true }), "just now", "a moment ahead of the clock");
  for (const none of [null, undefined, "", "not a date"]) assert.equal(timeAgo(none, { now: NOW, moment: true }), "never");
  // An hour or more: the time today, or the day and time before today. Never a count of hours or days.
  const sameDay = m(3 * HOUR);
  assert.equal(sameDay, new Date(NOW - 3 * HOUR).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), "today: the time");
  const earlier = m(2 * DAY);
  assert.equal(earlier, new Date(NOW - 2 * DAY).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), "an earlier day: the day and time");
  assert.equal(m(40 * DAY), new Date(NOW - 40 * DAY).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), "a pairing months ago keeps its day and time");
  for (const text of [sameDay, earlier, m(40 * DAY)]) assert.doesNotMatch(text, /\bago\b/, text);
  assert.notEqual(earlier, timeAgo(NOW - 2 * DAY, { now: NOW }), "and it is not the default wording");
  assert.match(earlier, /\d{1,2}/, "it carries a day of the month");
});

check("compact: true is the Conversations inbox's stamp, word for word what its relTime always said", () => {
  // The inbox's helper as it was before the one vocabulary, with the clock passed in: the option must match it.
  const before1017 = (at: number, now: number) => {
    const min = Math.round((now - at) / 60_000);
    if (min < 1) return "now";
    if (min < 60) return `${min}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.round(hr / 24);
    if (day < 7) return `${day}d`;
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const c = (ms: number) => timeAgo(NOW - ms, { now: NOW, compact: true });
  assert.equal(c(0), "now");
  assert.equal(c(29_000), "now", "under half a minute rounds to now");
  assert.equal(c(31_000), "1m", "and from half a minute it rounds up, as the inbox did");
  assert.equal(c(59 * MIN), "59m");
  assert.equal(c(2 * HOUR), "2h");
  assert.equal(c(5 * DAY), "5d");
  assert.equal(c(8 * DAY), new Date(NOW - 8 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" }), "from a week, the short date");
  assert.equal(c(-5 * MIN), "now", "a moment ahead of the clock");
  assert.equal(timeAgo("not a date", { now: NOW, compact: true }), "never");
  for (let ms = -HOUR; ms < 10 * DAY; ms += 7 * MIN + 13_000) assert.equal(c(ms), before1017(NOW - ms, NOW), `${ms} ms old`);
  // relTime is that option on the real clock, and a time that does not parse is still an empty stamp.
  assert.equal(relTime(new Date(Date.now() - 3 * MIN - 1_000).toISOString()), "3m");
  assert.equal(relTime("not a date"), "");
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

/** A file's code without its comments, so a comment quoting old wording is not counted. "https://" is kept. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** A stamp that says "ago", built in code: `${n} min ago`, `${days}d ago`. */
const AGO_STAMP = /\$\{[^}]*\}[^`\n]*\bago\b/;
/** The clock minus a moment... */
const ELAPSED = /Date\.now\(\)\s*-\s*[A-Za-z_(]/;
/** ...made into a unit stamp: `${n}m`, `${h} h`, `${d} days`. */
const UNIT_STAMP = /\$\{[^}]+\}\s?(?:s|m|h|d|mo|min|mins|hr|hrs|minutes?|hours?|days?)`/;

/** Files the guard below matches that are not a time ago: a duration, a countdown, or a window or threshold named in a sentence. */
const NOT_A_TIME_AGO: Record<string, string> = {
  "components/automations/BackgroundWorkersPanel.tsx": "a worker's uptime, how long it has been running",
  "components/ChatWidget.tsx": "the seconds a reply has been streaming, a running timer",
  "components/conversations/CallsBoard.tsx": "a countdown to a booked call ('in 2h 5m'), coloured as it gets close",
  "lib/bulk-email/dispatch.ts": "names the freshness window in a send error ('unsent after 24h')",
  "lib/delivery/messages.ts": "how far past its SLA target a ticket is, the SLA clock's own duration ('2h 5m ago')",
  "lib/founders-finances/invoices-io.ts": "names the reminder window ('reminded within the last 3 days')",
  "lib/health/drip-checks.ts": "names the check's threshold ('queued more than 30 minutes ago')",
  "lib/lenders/feedback-bias.ts": "names the lookback window ('in last 90d')",
  "lib/os/connectors.ts": "names a threshold, not an age ('more than a week ago')",
};

/** Files that still word a time ago their own way. Known, and a follow-up: each should move onto timeAgo or an option of it. */
const NOT_MOVED_YET: Record<string, string> = {
  "app/pipeline/[id]/page.tsx": "Last touch counts whole days against the lead's SLA, set in days ('5d target' beside it); the same count raises the overdue warning",
  "components/sunbiz/MyActiveDealsCard.tsx": "SunBiz is retired (lib/tenant/retired.ts); a deal's age in days",
  "components/sunbiz/SunBizDashboard.tsx": OWN_TIME_AGO["components/sunbiz/SunBizDashboard.tsx"],
  "components/underwriting/ApplicationUnderwritingReport.tsx": "'Started N minutes ago' on an underwriting run",
  "lib/founders-performance-core.ts": "'Last posted N days ago', a whole-day count",
  "lib/health/runner.ts": "health reasons say 'N min ago': the same minute words, but never hours or days",
  "lib/skills/view.ts": "'Last checked in N days ago' marks a stale skill by whole days",
  "lib/web-leads/trust.ts": "'Measured N months ago', a month count on a lead's site evidence",
};

check("nothing works out a time ago under another name", () => {
  const found: string[] = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sources(join(root, dir))) {
      const rel = relative(root, file).replace(/\\/g, "/");
      if (rel === "lib/devices/presence.ts") continue;
      const code = codeOf(readFileSync(file, "utf8"));
      if (AGO_STAMP.test(code) || (ELAPSED.test(code) && UNIT_STAMP.test(code))) found.push(rel);
    }
  }
  const known = { ...NOT_A_TIME_AGO, ...NOT_MOVED_YET };
  assert.deepEqual(found.filter((f) => !(f in known)), [], "a time ago worked out here is a second vocabulary: call timeAgo (lib/devices/presence.ts) or add an option there; a duration or window goes in NOT_A_TIME_AGO with its reason");
  assert.deepEqual(Object.keys(known).filter((f) => !found.includes(f)), [], "a listed file the guard no longer matches: take it off the list");
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
