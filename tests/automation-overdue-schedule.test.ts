/**
 * A dead scheduler must not present as a healthy fleet.
 *
 * When the machine running scripts/scheduler.py stops, no row is written. No
 * card goes red — a red card needs a run that failed, and there are no runs.
 * Every toggle still reads "On", every last_result is the one from the last
 * successful fire, and next_run_at — a timestamp that froze the moment the
 * scheduler died — keeps rendering as a future commitment: "Next Sep 1, 3:00 AM
 * EDT", read in the middle of September. The tab reported a perfect fleet while
 * nothing had fired for weeks, and there was no way to tell from the page.
 *
 * Every assertion here uses a FROZEN clock. A staleness test that reads
 * Date.now() is a test that passes today and means something different tomorrow.
 *
 * Run: node --conditions=react-server --import tsx tests/automation-overdue-schedule.test.ts
 */
import assert from "node:assert/strict";
import {
  describeNextRun,
  humanizeLateness,
  scheduleIntervalSeconds,
} from "../lib/automations/cron-schedule";

const HOUR = 3_600;
const DAY = 86_400;

// ── the interval comes from the row's own schedule ─────────────────────────
// One flat threshold cannot judge both a five-minute sweep and a Sunday digest.
// The LARGEST legitimate gap is the measure, not the average — the same rule
// scripts/core/cron_health_check.py:schedule_interval_seconds settled on, and
// for the same reason: "0 10 * * MON-FRI" averages under a day but really waits
// out the weekend, so measuring the mean would declare it overdue every Sunday
// until the badge stopped meaning anything.
assert.equal(scheduleIntervalSeconds("* * * * *"), 60);
assert.equal(scheduleIntervalSeconds("*/5 * * * *"), 300);
assert.equal(scheduleIntervalSeconds("*/15 * * * *"), 900);
assert.equal(scheduleIntervalSeconds("0 * * * *"), HOUR);
assert.equal(scheduleIntervalSeconds("30 * * * *"), HOUR);
assert.equal(scheduleIntervalSeconds("0 */4 * * *"), 4 * HOUR);
assert.equal(scheduleIntervalSeconds("0 6 * * *"), DAY);
assert.equal(scheduleIntervalSeconds("0 9 * * 1-5"), 3 * DAY, "Friday to Monday is the real gap");
assert.equal(scheduleIntervalSeconds("0 10 * * MON-FRI"), 3 * DAY, "named days must parse too");
assert.equal(scheduleIntervalSeconds("0 20 * * 0"), 7 * DAY);
assert.equal(scheduleIntervalSeconds("0 20 * * 7"), 7 * DAY, "cron allows 7 for Sunday");
assert.equal(scheduleIntervalSeconds("0 8 * * 0,6"), 6 * DAY, "Sunday to Saturday is the long half");
assert.equal(scheduleIntervalSeconds("0 3 1 * *"), 31 * DAY, "monthly is judged by the longest month");

// No opinion beats a wrong opinion: an unparseable schedule yields no verdict
// rather than a confident "Overdue" derived from a guess.
for (const unparseable of ["@reboot", "", "0 6 * *", "0 6 L * *", "0 6 * JAN *", "0 6 1 * 1-5"]) {
  assert.equal(
    scheduleIntervalSeconds(unparseable),
    null,
    `must refuse to guess an interval for: ${unparseable || "(empty)"}`,
  );
}

// ── the tense of a stored timestamp ────────────────────────────────────────
const NOW = Date.parse("2026-09-17T16:00:00.000Z");
const iso = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString();

{
  // Still ahead — the only case where "Next" is a true word.
  const ahead = describeNextRun({
    nextRunAt: iso(600), schedule: "*/5 * * * *", enabled: true, now: NOW,
  });
  assert.match(ahead.text, /^Next /);
  assert.equal(ahead.overdue, false);
}

{
  // Just past due, inside one interval. Late, but a scheduler that paused to
  // breathe is not a dead one — say the tense and stop there.
  const justPast = describeNextRun({
    nextRunAt: iso(-120), schedule: "*/5 * * * *", enabled: true, now: NOW,
  });
  assert.match(justPast.text, /^Was due /, "a past timestamp must never wear the word 'Next'");
  assert.doesNotMatch(justPast.text, /Next/);
  assert.equal(justPast.overdue, false, "one missed fire is not yet evidence the host is gone");
}

{
  // THE OUTAGE. A five-minute sweep whose next fire was due sixteen days ago.
  const dead = describeNextRun({
    nextRunAt: iso(-16 * DAY), schedule: "*/5 * * * *", enabled: true, now: NOW,
  });
  assert.equal(dead.overdue, true);
  assert.match(dead.text, /^Overdue by 16d/);
  assert.match(dead.text, /nothing has run since/);
  assert.doesNotMatch(dead.text, /Next/);
  assert.equal(Math.round(dead.overdue_by_seconds!), 16 * DAY);
}

{
  // Proportionality both ways: two days of silence is a dead per-minute job and
  // a perfectly normal weekly one. Same elapsed time, opposite verdicts.
  assert.equal(
    describeNextRun({ nextRunAt: iso(-2 * DAY), schedule: "* * * * *", enabled: true, now: NOW }).overdue,
    true,
  );
  assert.equal(
    describeNextRun({ nextRunAt: iso(-2 * DAY), schedule: "0 20 * * 0", enabled: true, now: NOW }).overdue,
    false,
  );
  // And the weekday job that is merely enjoying its weekend.
  assert.equal(
    describeNextRun({
      nextRunAt: iso(-2 * DAY - HOUR), schedule: "0 10 * * MON-FRI", enabled: true, now: NOW,
    }).overdue,
    false,
    "a MON-FRI job must not be called dead on a Sunday",
  );
}

{
  // A schedule nobody could parse gets the tense but never the accusation.
  const unparseable = describeNextRun({
    nextRunAt: iso(-90 * DAY), schedule: "@reboot", enabled: true, now: NOW,
  });
  assert.match(unparseable.text, /^Was due /);
  assert.equal(unparseable.overdue, false, "no interval means no overdue verdict, not a free one");
}

{
  // A paused row's stored timestamp is a bookmark, not a promise. Nothing is
  // supposed to fire, so nothing is overdue — flagging it would put a warm
  // border on every automation the operator deliberately switched off.
  const paused = describeNextRun({
    nextRunAt: iso(-30 * DAY), schedule: "*/5 * * * *", enabled: false, now: NOW,
  });
  assert.match(paused.text, /\(paused\)$/);
  assert.equal(paused.overdue, false);
}

assert.equal(
  describeNextRun({ nextRunAt: null, schedule: "0 6 * * *", enabled: true, now: NOW }).text,
  "Not scheduled",
);
assert.equal(
  describeNextRun({ nextRunAt: "not-a-date", schedule: "0 6 * * *", enabled: true, now: NOW }).overdue,
  false,
);

// ── lateness reads at a glance ─────────────────────────────────────────────
assert.equal(humanizeLateness(45), "45s");
assert.equal(humanizeLateness(20 * 60), "20m");
assert.equal(humanizeLateness(6 * HOUR), "6h");
assert.equal(humanizeLateness(16 * DAY), "16d");

console.log("automation-overdue-schedule: a stopped scheduler can no longer read as a healthy fleet");
