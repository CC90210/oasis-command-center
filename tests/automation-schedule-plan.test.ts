/**
 * tests/automation-schedule-plan.test.ts — the one schedule library every
 * automation path will share (Automations guided setup, PR1).
 *
 * WHAT IS PINNED
 *   - Runs are computed on the automation's OWN wall clock and converted to
 *     instants, so a 9:00 AM Toronto task stays 9:00 AM across both DST
 *     changes. A naive-UTC implementation fails every Toronto assertion here.
 *   - Spring forward: a fixed time inside the missing hour runs once, pushed
 *     past the gap, and never twice when that lands on another chosen time.
 *   - Fall back: a fixed time inside the repeated hour runs once (the first
 *     time the clock shows it); an every-hour schedule runs in BOTH copies of
 *     the hour, so the 25-hour night has 25 runs, each at a real time.
 *   - Day of month and day of week are ORed when both are set, as the bridge's
 *     cron_runner.py and standard cron do.
 *   - An unknown zone or a cron the grammar refuses yields no runs, never a
 *     guess.
 *   - planToCron output always passes the one shared grammar, and cronToPlan
 *     reads it back to the same plan.
 *   - describePlan names the zone and never uses an em dash.
 *   - The minimum gap is measured across seven days, so a custom schedule that
 *     only crowds its runs on a Monday is still seen on a Tuesday.
 *   - The three schedule-writing routes share the one grammar instead of three
 *     hand-copied regexes (one of which accepted MON-FRI, which the bridge's
 *     int() parser cannot read, so such a job silently never fired).
 *
 * Run: node --conditions=react-server --import tsx tests/automation-schedule-plan.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cronToPlan,
  describePlan,
  formatRunInstant,
  jitterFor,
  laneFor,
  minGapOver7Days,
  nextRuns,
  planToCron,
  scheduleKey,
  validatePlan,
  type SchedulePlan,
} from "../lib/automations/schedule-plan";
import { isValidCronExpr } from "../lib/automations/cron-grammar";
import { wallParts } from "../lib/calendar/zone";

const ROOT = join(__dirname, "..");
const TOR = "America/Toronto";
const MIN = 60_000;
const HOUR = 60 * MIN;

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

const iso = (d: Date) => d.toISOString();
const isoList = (ds: Date[]) => ds.map(iso);
/** Wall-clock HH:MM of an instant in Toronto. */
const torWall = (d: Date) => {
  const p = wallParts(d, TOR);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};
const torDate = (d: Date) => {
  const p = wallParts(d, TOR);
  return `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

console.log("automation-schedule-plan:");

// 2026 in Toronto: spring forward Sun Mar 8 02:00 EST -> 03:00 EDT;
// fall back Sun Nov 1 02:00 EDT -> 01:00 EST.

check("spring forward: a daily 02:30 runs once on Mar 8, at 03:30 EDT, and keeps 02:30 on either side", () => {
  const after = new Date("2026-03-07T05:00:00Z"); // Mar 7 00:00 EST
  const runs = nextRuns("30 2 * * *", TOR, after, 3);
  assert.deepEqual(isoList(runs), [
    "2026-03-07T07:30:00.000Z", // Mar 7 02:30 EST
    "2026-03-08T07:30:00.000Z", // Mar 8 03:30 EDT (02:30 does not exist)
    "2026-03-09T06:30:00.000Z", // Mar 9 02:30 EDT
  ]);
  assert.deepEqual(runs.map(torWall), ["02:30", "03:30", "02:30"]);
});

check("spring forward: a time pushed out of the gap is not run twice when it lands on another chosen time", () => {
  const after = new Date("2026-03-08T05:00:00Z"); // Mar 8 00:00 EST
  // Hours 1..23: 02:00 does not exist and is pushed to 03:00, which is also chosen.
  const day = nextRuns("0 1-23/1 * * *", TOR, after, 40).filter((d) => torDate(d) === "2026-03-08");
  const walls = day.map(torWall);
  assert.equal(walls.filter((w) => w === "03:00").length, 1, `03:00 ran ${walls.filter((w) => w === "03:00").length} times`);
  assert.equal(new Set(isoList(day)).size, day.length, "duplicate instants");
  assert.equal(day.length, 22, `expected 22 runs (01:00, 03:00..23:00), got ${day.length}: ${walls.join(" ")}`);
  // A fixed pair inside and after the gap collapses to one run too.
  const pair = nextRuns("0 2,3 * * *", TOR, after, 3);
  assert.deepEqual(isoList(pair), [
    "2026-03-08T07:00:00.000Z", // 03:00 EDT, once
    "2026-03-09T06:00:00.000Z", // Mar 9 02:00 EDT
    "2026-03-09T07:00:00.000Z", // Mar 9 03:00 EDT
  ]);
});

check("spring forward: an every-hour schedule simply has no run in the missing hour (23 that day)", () => {
  const after = new Date("2026-03-08T04:59:59Z");
  const day = nextRuns("0 * * * *", TOR, after, 40).filter((d) => torDate(d) === "2026-03-08");
  assert.equal(day.length, 23);
  assert.ok(!day.map(torWall).includes("02:00"));
  assert.equal(new Set(isoList(day)).size, 23);
});

check("fall back: a daily 01:30 runs once on Nov 1 (the first 01:30), never in the repeated hour", () => {
  const after = new Date("2026-10-31T16:00:00Z");
  const runs = nextRuns("30 1 * * *", TOR, after, 3);
  assert.deepEqual(isoList(runs), [
    "2026-11-01T05:30:00.000Z", // 01:30 EDT
    "2026-11-02T06:30:00.000Z", // 01:30 EST
    "2026-11-03T06:30:00.000Z",
  ]);
});

check("fall back: an every-hour schedule runs 25 times on the 25-hour night, each at a real, distinct time", () => {
  const after = new Date("2026-11-01T03:59:59Z"); // just before Nov 1 00:00 EDT
  const day = nextRuns("0 * * * *", TOR, after, 60).filter((d) => torDate(d) === "2026-11-01");
  assert.equal(day.length, 25, `got ${day.length}`);
  assert.equal(new Set(isoList(day)).size, 25, "instants must be distinct");
  for (const d of day) assert.equal(wallParts(d, TOR).mi, 0, `${iso(d)} is not on the hour in Toronto`);
  const labels = day.map((d) => formatRunInstant(d, TOR));
  assert.equal(new Set(labels).size, 25, `labels collide: ${labels.join(" | ")}`);
  const oneAm = labels.filter((l) => /\b1:00\s?AM\b/.test(l));
  assert.equal(oneAm.length, 2, `the repeated hour: ${oneAm.join(" | ")}`);
  assert.ok(oneAm.some((l) => /EDT/.test(l)) && oneAm.some((l) => /EST/.test(l)), `1 AM must carry both zones: ${oneAm.join(" | ")}`);
});

check("weekdays: from a Friday morning the next runs are Fri, Mon, Tue at 9:00 local", () => {
  const plan: SchedulePlan = { mode: "weekdays", time: "09:00", timezone: TOR };
  const runs = nextRuns(planToCron(plan), TOR, new Date("2026-10-09T12:00:00Z"), 3); // Fri 08:00 EDT
  assert.deepEqual(runs.map(torDate), ["2026-10-09", "2026-10-12", "2026-10-13"]);
  assert.ok(runs.every((d) => torWall(d) === "09:00"));
});

check("weekly, several days: Mon/Wed/Fri at 18:15 local, crossing fall back", () => {
  const plan: SchedulePlan = { mode: "weekly", time: "18:15", days: [5, 1, 3], timezone: TOR };
  const runs = nextRuns(planToCron(plan), TOR, new Date("2026-10-28T12:00:00Z"), 4); // Wed
  assert.deepEqual(runs.map(torDate), ["2026-10-28", "2026-10-30", "2026-11-02", "2026-11-04"]);
  assert.ok(runs.every((d) => torWall(d) === "18:15"), runs.map(torWall).join(" "));
  assert.equal(iso(runs[1]), "2026-10-30T22:15:00.000Z"); // EDT, UTC-4
  assert.equal(iso(runs[2]), "2026-11-02T23:15:00.000Z"); // EST, UTC-5
});

check("monthly on the 15th keeps 09:00 local through both changes", () => {
  const plan: SchedulePlan = { mode: "monthly", time: "09:00", day_of_month: 15, timezone: TOR };
  const runs = nextRuns(planToCron(plan), TOR, new Date("2026-02-20T12:00:00Z"), 3);
  assert.deepEqual(isoList(runs), [
    "2026-03-15T13:00:00.000Z", // EDT
    "2026-04-15T13:00:00.000Z",
    "2026-05-15T13:00:00.000Z",
  ]);
  const late = nextRuns(planToCron(plan), TOR, new Date("2026-10-20T12:00:00Z"), 2);
  assert.deepEqual(isoList(late), ["2026-11-15T14:00:00.000Z", "2026-12-15T14:00:00.000Z"]); // EST
});

check("every 4 hours from 07:00 stays 07/11/15/19/23 local across spring forward", () => {
  const plan: SchedulePlan = { mode: "every_n_hours", time: "07:00", every_hours: 4, timezone: TOR };
  const runs = nextRuns(planToCron(plan), TOR, new Date("2026-03-07T05:00:00Z"), 15);
  assert.deepEqual(runs.map(torWall), Array(3).fill(["07:00", "11:00", "15:00", "19:00", "23:00"]).flat());
  // Mar 7 23:00 EST -> Mar 8 07:00 EDT is 7 real hours, not 8.
  assert.equal(runs[5].getTime() - runs[4].getTime(), 7 * HOUR);
  assert.equal(runs[10].getTime() - runs[9].getTime(), 8 * HOUR);
});

check("day of month and day of week are ORed when both are set (custom cron)", () => {
  // Mar 2026: Mondays are 2, 9, 16; the 15th is a Sunday.
  const runs = nextRuns("0 9 15 * 1", TOR, new Date("2026-03-01T12:00:00Z"), 4);
  assert.deepEqual(runs.map(torDate), ["2026-03-02", "2026-03-09", "2026-03-15", "2026-03-16"]);
});

check("an unknown zone or a refused cron gives no runs, never a guess", () => {
  assert.deepEqual(nextRuns("0 9 * * *", "Mars/Olympus_Mons", new Date(), 3), []);
  assert.deepEqual(nextRuns("0 9 * * *", "", new Date(), 3), []);
  assert.deepEqual(nextRuns("0 9 * * MON-FRI", TOR, new Date(), 3), []);
  assert.deepEqual(nextRuns("not a cron", TOR, new Date(), 3), []);
  assert.deepEqual(nextRuns("0 9 31 2 *", TOR, new Date("2026-01-01T00:00:00Z"), 3), [], "Feb 31 never comes");
  assert.equal(minGapOver7Days("0 9 * * *", "Nowhere/Zone", new Date()), null);
});

check("the minimum gap is measured across seven days, not one", () => {
  const tuesday = new Date("2026-10-13T12:00:00Z");
  // Two runs 30 minutes apart, Mondays only: invisible to a one-day look ahead.
  assert.equal(minGapOver7Days("0,30 9 * * 1", TOR, tuesday), 30);
  assert.equal(minGapOver7Days("0 9 * * *", TOR, tuesday), 24 * 60);
  assert.equal(minGapOver7Days("*/10 * * * *", TOR, tuesday), 10);
  assert.equal(minGapOver7Days("0 9 * * 1", TOR, tuesday), Infinity, "one run a week has no gap inside 7 days");
});

// ── plans ──────────────────────────────────────────────────────────────────
const TIMES = ["00:00", "00:05", "07:00", "09:30", "12:00", "23:59"];
function allPlans(): SchedulePlan[] {
  const plans: SchedulePlan[] = [{ mode: "manual", timezone: TOR }];
  for (const time of TIMES) {
    plans.push({ mode: "daily", time, timezone: TOR });
    plans.push({ mode: "weekdays", time, timezone: TOR });
    for (const days of [[0], [1, 3, 5], [6, 0], [0, 1, 2, 3, 4, 5, 6]]) plans.push({ mode: "weekly", time, days, timezone: TOR });
    for (const day_of_month of [1, 15, 28]) plans.push({ mode: "monthly", time, day_of_month, timezone: TOR });
    for (const every_hours of [1, 2, 3, 4, 6, 8, 12] as const) plans.push({ mode: "every_n_hours", time, every_hours, timezone: TOR });
  }
  plans.push({ mode: "custom", cron: "*/15 9-17 * * 1-5", timezone: "Europe/Paris" });
  plans.push({ mode: "daily", time: "08:00", timezone: "UTC" });
  plans.push({ mode: "daily", time: "08:00", timezone: "Asia/Kolkata" });
  return plans;
}

check("planToCron output always passes the one shared grammar (manual is the empty schedule)", () => {
  for (const plan of allPlans()) {
    const v = validatePlan(plan);
    assert.ok(v.ok, `${JSON.stringify(plan)} refused: ${v.ok ? "" : v.error}`);
    const cron = planToCron(v.plan);
    if (plan.mode === "manual") {
      assert.equal(cron, "");
      continue;
    }
    assert.ok(isValidCronExpr(cron), `${JSON.stringify(plan)} -> "${cron}" fails the grammar`);
    assert.ok(nextRuns(cron, plan.timezone, new Date("2026-06-01T00:00:00Z"), 1).length === 1, `${cron} never runs`);
  }
});

check("cronToPlan reads planToCron back to the same plan", () => {
  for (const plan of allPlans()) {
    const v = validatePlan(plan);
    assert.ok(v.ok);
    assert.deepEqual(cronToPlan(planToCron(v.plan), v.plan.timezone), v.plan, JSON.stringify(plan));
  }
  // Anything the guided modes cannot express stays custom, verbatim.
  assert.deepEqual(cronToPlan("*/15 9-17 * * 1-5", TOR), { mode: "custom", cron: "*/15 9-17 * * 1-5", timezone: TOR });
  assert.deepEqual(cronToPlan("0 9 15 * 1", TOR), { mode: "custom", cron: "0 9 15 * 1", timezone: TOR });
});

check("describePlan names the zone and never uses an em dash", () => {
  for (const plan of allPlans()) {
    const v = validatePlan(plan);
    assert.ok(v.ok);
    const text = describePlan(v.plan);
    assert.ok(!/[\u2014\u2013]/.test(text), `dash in "${text}"`);
    const zoneWord = plan.timezone === TOR ? "Toronto" : plan.timezone === "UTC" ? "UTC" : plan.timezone.split("/").pop()!.replace(/_/g, " ");
    assert.ok(text.includes(zoneWord), `"${text}" does not name ${zoneWord}`);
  }
  assert.equal(describePlan({ mode: "daily", time: "09:00", timezone: TOR }), "Every day at 9:00 AM, Toronto time");
  assert.equal(
    describePlan({ mode: "weekly", time: "18:15", days: [5, 1, 3], timezone: TOR }),
    "Every Monday, Wednesday and Friday at 6:15 PM, Toronto time",
  );
  assert.equal(
    describePlan({ mode: "every_n_hours", time: "07:00", every_hours: 4, timezone: TOR }),
    "Every 4 hours from 7:00 AM until midnight, Toronto time",
  );
  assert.ok(/\bEDT\b/.test(formatRunInstant(new Date("2026-07-01T13:00:00Z"), TOR)), "an instant carries its zone abbreviation");
});

check("validatePlan refuses what the dispatcher could not run, and keeps only the mode's own fields", () => {
  const bad: Array<[unknown, string]> = [
    [null, "schedule_invalid"],
    [{ mode: "hourly", time: "09:00", timezone: TOR }, "schedule_mode_invalid"],
    [{ mode: "daily", time: "9:00", timezone: TOR }, "schedule_time_invalid"],
    [{ mode: "daily", time: "24:00", timezone: TOR }, "schedule_time_invalid"],
    [{ mode: "daily", time: "09:00", timezone: "Nowhere/Zone" }, "schedule_timezone_invalid"],
    [{ mode: "daily", time: "09:00" }, "schedule_timezone_invalid"],
    [{ mode: "weekly", time: "09:00", days: [], timezone: TOR }, "schedule_days_invalid"],
    [{ mode: "weekly", time: "09:00", days: [7], timezone: TOR }, "schedule_days_invalid"],
    [{ mode: "weekly", time: "09:00", days: [1, 1], timezone: TOR }, "schedule_days_invalid"],
    [{ mode: "monthly", time: "09:00", day_of_month: 29, timezone: TOR }, "schedule_day_of_month_invalid"],
    [{ mode: "every_n_hours", time: "09:00", every_hours: 5, timezone: TOR }, "schedule_every_hours_invalid"],
    [{ mode: "custom", cron: "0 9 * * MON", timezone: TOR }, "schedule_cron_invalid"],
    [{ mode: "custom", timezone: TOR }, "schedule_cron_invalid"],
  ];
  for (const [input, code] of bad) {
    const v = validatePlan(input);
    assert.equal(v.ok, false, `${JSON.stringify(input)} accepted`);
    if (!v.ok) {
      assert.equal(v.error, code, JSON.stringify(input));
      assert.match(v.message, /\s/, "the refusal is a sentence");
    }
  }
  const v = validatePlan({ mode: "daily", time: "09:00", timezone: TOR, days: [1], cron: "* * * * *", extra: 1 });
  assert.ok(v.ok);
  assert.deepEqual(v.plan, { mode: "daily", time: "09:00", timezone: TOR });
});

check("jitter, lane and schedule key are stable functions of the id", () => {
  // FNV-1a 32-bit of "a" is 0xe40c292c = 3826002220.
  assert.equal(jitterFor("a"), 3826002220 % 300);
  assert.equal(laneFor("a"), 3826002220 % 8);
  for (const id of ["", "x", crypto.randomUUID(), crypto.randomUUID()]) {
    const j = jitterFor(id);
    const l = laneFor(id);
    assert.ok(Number.isInteger(j) && j >= 0 && j <= 299);
    assert.ok(Number.isInteger(l) && l >= 0 && l <= 7);
    assert.equal(jitterFor(id), j);
    assert.equal(laneFor(id), l);
  }
  assert.equal(scheduleKey("0 9 * * *", TOR, "daily", 42), `0 9 * * *|${TOR}|daily|42`);
});

check("the grammar: the forms the bridge can read, and nothing it cannot", () => {
  for (const ok of ["0 9 * * *", "*/15 * * * *", "0 7-23/4 * * *", "0 9 1,15 * *", "0 9 * * 1-5", "0 9 * * 0,7", "59 23 31 12 7"]) {
    assert.ok(isValidCronExpr(ok), `refused "${ok}"`);
  }
  for (const bad of [
    "0 9 * * MON-FRI", // names: cron_runner.py int()s every field and never fires
    "0 9 * * mon",
    "5/10 * * * *", // a bare value with a step: the bridge reads 5, others read 5,15,25
    "*,5 * * * *", // a star inside a list: cron_runner.py int("*") never fires
    "60 * * * *",
    "0 24 * * *",
    "0 9 0 * *",
    "0 9 * 13 *",
    "0 9 * * 8",
    "*/0 * * * *",
    "0 9 5-1 * *",
    "0 9 * *",
    "0 9 * * * *",
    "",
  ]) {
    assert.ok(!isValidCronExpr(bad), `accepted "${bad}"`);
  }
  assert.equal(isValidCronExpr(undefined), false);
  assert.equal(isValidCronExpr(42), false);
});

check("the three schedule-writing routes share the one grammar", () => {
  for (const route of [
    "app/api/cron-jobs/route.ts",
    "app/api/cron-jobs/[id]/route.ts",
    "app/api/automations/save-draft/route.ts",
  ]) {
    const src = readFileSync(join(ROOT, route), "utf8");
    assert.match(src, /import \{[^}]*\bisValidCronExpr\b[^}]*\} from "@\/lib\/automations\/cron-grammar"/, `${route} must import the shared grammar`);
    assert.doesNotMatch(src, /const CRON_(FIELD|RE)\s*=/, `${route} still declares its own cron regex`);
    assert.doesNotMatch(src, /function isValidCron\(/, `${route} still declares its own validator`);
  }
});

if (failures > 0) {
  console.log(`automation-schedule-plan: ${failures} failing`);
  process.exit(1);
}
console.log("automation-schedule-plan: all checks passed");
