/**
 * schedule-plan — the one schedule library for automations: the plan a person
 * picks, the cron it becomes, the sentence that describes it, and the instants
 * it actually runs at.
 *
 * WHY ONE LIBRARY. The guided setup previews "the next 3 runs", the dispatcher
 * arms the next slot, the gap rule refuses a schedule that runs too often, and
 * the list says when a task runs next. If any two of those computed time
 * differently, the page would promise a run the scheduler never makes. They
 * all call nextRuns here.
 *
 * TIME IS WALL-CLOCK TIME IN THE AUTOMATION'S OWN ZONE. "9:00 AM Toronto" is
 * 13:00 UTC in summer and 14:00 UTC in winter; a schedule computed in UTC
 * drifts an hour twice a year. Every run is found on the zone's calendar first
 * and converted to an instant second. The two days a year that conversion is
 * not one-to-one follow cron's long-standing rule (Vixie cron, cronie):
 *
 *   Spring forward (a missing hour). A FIXED time inside it (02:30) runs once,
 *   pushed past the gap (03:30), and is not run a second time when that lands
 *   on another chosen time. An EVERY-HOUR schedule just has no run in the hour
 *   that does not exist.
 *
 *   Fall back (a repeated hour). A FIXED time inside it (01:30) runs once, the
 *   first time the clock shows it. An EVERY-HOUR schedule runs in both copies,
 *   so the 25-hour night has 25 runs.
 *
 * "Every hour" means the hour field covers all 24 hours; anything narrower is a
 * fixed time.
 *
 * Day of month and day of week are ORed when both are set, exactly as the
 * bridge's cron_runner.py does (a field is "set" when it is not "*"), so a
 * custom cron means the same thing to both runners.
 *
 * Fails closed: an unknown zone or a cron the shared grammar refuses yields no
 * runs and a null gap, never a guess.
 *
 * No server imports: the wizard can call this in the browser to preview runs.
 */

import { isValidCronExpr } from "@/lib/automations/cron-grammar";
import { expandNumericField } from "@/lib/automations/cron-schedule";
import { dayNumber, fromDayNumber, isTimeZone, wallParts } from "@/lib/calendar/zone";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/**
 * Longest run of calendar days collectRuns will scan without turning up a NEW
 * occurrence before it gives up on finding another. This resets every time a
 * run is found, so it bounds each STEP of the search, not the whole
 * collection: a sparse-but-real schedule (every 4 years, Feb 29) keeps
 * finding runs for as many as were asked for, instead of being truncated by
 * a horizon measured from the first occurrence. 8 years covers the worst
 * real gap between leap days (a skipped century, e.g. 2096 -> 2104). A
 * schedule that never fires at all (Feb 30) burns this budget once, from the
 * start, and correctly returns what exists: nothing.
 */
const HORIZON_DAYS = 8 * 366;

export const SCHEDULE_MODES = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "every_n_hours",
  "manual",
  "custom",
] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/** Intervals that divide the day evenly, so "every N hours" never drifts. */
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
export type EveryHours = (typeof EVERY_HOURS)[number];

/**
 * What the person chose. `time` is "HH:MM" on the zone's wall clock; for
 * every_n_hours it is the first run of each day. `days` are 0 (Sunday) to 6.
 * day_of_month stops at 28 so a monthly task runs every month.
 */
export type SchedulePlan =
  | { mode: "daily" | "weekdays"; time: string; timezone: string }
  | { mode: "weekly"; time: string; days: number[]; timezone: string }
  | { mode: "monthly"; time: string; day_of_month: number; timezone: string }
  | { mode: "every_n_hours"; time: string; every_hours: EveryHours; timezone: string }
  | { mode: "manual"; timezone: string }
  | { mode: "custom"; cron: string; timezone: string };

export type SchedulePlanError =
  | "schedule_invalid"
  | "schedule_mode_invalid"
  | "schedule_timezone_invalid"
  | "schedule_time_invalid"
  | "schedule_days_invalid"
  | "schedule_day_of_month_invalid"
  | "schedule_every_hours_invalid"
  | "schedule_cron_invalid";

const PLAN_ERROR_MESSAGES: Record<SchedulePlanError, string> = {
  schedule_invalid: "The schedule is missing or is not in a form this page can read.",
  schedule_mode_invalid:
    "Pick how often it runs: every day, weekdays, weekly, monthly, every few hours, only when you start it, or a custom schedule.",
  schedule_timezone_invalid: "That time zone is not one we recognise. Pick a time zone from the list.",
  schedule_time_invalid: "Pick a time of day, written like 09:00.",
  schedule_days_invalid: "Pick at least one day of the week, each day once.",
  schedule_day_of_month_invalid: "Pick a day of the month from 1 to 28, so it runs every month.",
  schedule_every_hours_invalid: "Pick an interval of 1, 2, 3, 4, 6, 8 or 12 hours.",
  schedule_cron_invalid: "The custom schedule is not a five-field cron this scheduler can run.",
};

export type ValidatePlanResult =
  | { ok: true; plan: SchedulePlan }
  | { ok: false; error: SchedulePlanError; message: string };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function refuse(error: SchedulePlanError): ValidatePlanResult {
  return { ok: false, error, message: PLAN_ERROR_MESSAGES[error] };
}

/**
 * Check a plan from a request body and return it with only its mode's own
 * fields. A hand validator that fails closed (zod is not a dependency).
 */
export function validatePlan(input: unknown): ValidatePlanResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse("schedule_invalid");
  const raw = input as Record<string, unknown>;
  const mode = raw.mode;
  if (typeof mode !== "string" || !(SCHEDULE_MODES as readonly string[]).includes(mode)) {
    return refuse("schedule_mode_invalid");
  }
  const timezone = raw.timezone;
  if (!isTimeZone(timezone) || timezone.trim() === "") return refuse("schedule_timezone_invalid");

  if (mode === "manual") return { ok: true, plan: { mode, timezone } };
  if (mode === "custom") {
    if (!isValidCronExpr(raw.cron)) return refuse("schedule_cron_invalid");
    return { ok: true, plan: { mode, cron: normalizeCron(raw.cron as string), timezone } };
  }

  const time = raw.time;
  if (typeof time !== "string" || !TIME_RE.test(time)) return refuse("schedule_time_invalid");

  switch (mode) {
    case "daily":
    case "weekdays":
      return { ok: true, plan: { mode, time, timezone } };
    case "weekly": {
      const days = raw.days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ||
        new Set(days).size !== days.length
      ) {
        return refuse("schedule_days_invalid");
      }
      return { ok: true, plan: { mode, time, days: [...(days as number[])].sort((a, b) => a - b), timezone } };
    }
    case "monthly": {
      const dom = raw.day_of_month;
      if (!Number.isInteger(dom) || (dom as number) < 1 || (dom as number) > 28) {
        return refuse("schedule_day_of_month_invalid");
      }
      return { ok: true, plan: { mode, time, day_of_month: dom as number, timezone } };
    }
    case "every_n_hours": {
      const n = raw.every_hours;
      if (!(EVERY_HOURS as readonly unknown[]).includes(n)) return refuse("schedule_every_hours_invalid");
      return { ok: true, plan: { mode, time, every_hours: n as EveryHours, timezone } };
    }
  }
  return refuse("schedule_mode_invalid");
}

function normalizeCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ");
}

function hourMinute(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [h, m];
}

/**
 * The 5-field cron for a validated plan, built in code (a model never writes
 * a schedule). Manual is the empty schedule: nothing arms it.
 */
export function planToCron(plan: SchedulePlan): string {
  switch (plan.mode) {
    case "manual":
      return "";
    case "custom":
      return normalizeCron(plan.cron);
    case "daily": {
      const [h, m] = hourMinute(plan.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = hourMinute(plan.time);
      return `${m} ${h} * * 1-5`;
    }
    case "weekly": {
      const [h, m] = hourMinute(plan.time);
      const days = [...new Set(plan.days)].sort((a, b) => a - b);
      return `${m} ${h} * * ${days.join(",")}`;
    }
    case "monthly": {
      const [h, m] = hourMinute(plan.time);
      return `${m} ${h} ${plan.day_of_month} * *`;
    }
    case "every_n_hours": {
      const [h, m] = hourMinute(plan.time);
      // From the first run of the day to the end of it: 07:00 every 4 hours is
      // 07, 11, 15, 19, 23 on every day.
      return h === 0 ? `${m} */${plan.every_hours} * * *` : `${m} ${h}-23/${plan.every_hours} * * *`;
    }
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Read a stored cron back into the guided mode that produces it, or `custom`
 * with the cron verbatim when no guided mode does. The empty schedule is manual.
 */
export function cronToPlan(cron: string, timezone: string): SchedulePlan {
  const normalized = normalizeCron(String(cron ?? ""));
  if (!normalized) return { mode: "manual", timezone };
  const custom: SchedulePlan = { mode: "custom", cron: normalized, timezone };
  const parts = normalized.split(" ");
  if (parts.length !== 5) return custom;
  const [mi, h, dom, mon, dow] = parts;
  if (!/^\d+$/.test(mi) || Number(mi) > 59 || mon !== "*") return custom;
  const minute = Number(mi);
  const at = (hour: number) => `${pad2(hour)}:${pad2(minute)}`;

  if (dom === "*" && dow === "*") {
    const step = h.match(/^\*\/(\d+)$/);
    if (step && (EVERY_HOURS as readonly number[]).includes(Number(step[1]))) {
      return { mode: "every_n_hours", time: at(0), every_hours: Number(step[1]) as EveryHours, timezone };
    }
    const ranged = h.match(/^(\d+)-23\/(\d+)$/);
    if (
      ranged &&
      Number(ranged[1]) >= 1 &&
      Number(ranged[1]) <= 23 &&
      (EVERY_HOURS as readonly number[]).includes(Number(ranged[2]))
    ) {
      return { mode: "every_n_hours", time: at(Number(ranged[1])), every_hours: Number(ranged[2]) as EveryHours, timezone };
    }
    if (h === "*") return { mode: "every_n_hours", time: at(0), every_hours: 1, timezone };
  }

  if (!/^\d+$/.test(h) || Number(h) > 23) return custom;
  const time = at(Number(h));
  if (dom === "*" && dow === "*") return { mode: "daily", time, timezone };
  if (dom === "*" && dow === "1-5") return { mode: "weekdays", time, timezone };
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
    const days = dow.split(",").map(Number);
    const ascending = days.every((d, i) => i === 0 || d > days[i - 1]);
    return ascending ? { mode: "weekly", time, days, timezone } : custom;
  }
  if (dow === "*" && /^\d+$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 28) {
    return { mode: "monthly", time, day_of_month: Number(dom), timezone };
  }
  return custom;
}

// ── words ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "09:00" -> "9:00 AM", "00:00" -> "12:00 AM", "23:59" -> "11:59 PM". */
export function formatClock(time: string): string {
  const [h, m] = hourMinute(time);
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad2(m)} ${suffix}`;
}

/** "America/Toronto" -> "Toronto time"; UTC stays "UTC". */
export function zoneLabel(timezone: string): string {
  if (/^(Etc\/)?(UTC|GMT|Zulu|UCT|Universal)$/i.test(timezone)) return "UTC";
  const city = timezone.split("/").pop() || timezone;
  return `${city.replace(/_/g, " ")} time`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/**
 * One plain sentence for a plan, naming its zone. It describes a wall-clock
 * time, so it carries the zone's NAME (true all year), not an abbreviation
 * (EDT is false half the year). Instants use formatRunInstant instead.
 */
export function describePlan(plan: SchedulePlan): string {
  const zone = zoneLabel(plan.timezone);
  switch (plan.mode) {
    case "manual":
      return `Only when you start it (times shown in ${zone})`;
    case "custom":
      return `On a custom schedule (${normalizeCron(plan.cron)}), ${zone}`;
    case "daily":
      return `Every day at ${formatClock(plan.time)}, ${zone}`;
    case "weekdays":
      return `Every weekday (Monday to Friday) at ${formatClock(plan.time)}, ${zone}`;
    case "weekly":
      return `Every ${joinWords([...plan.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]))} at ${formatClock(plan.time)}, ${zone}`;
    case "monthly":
      return `On the ${ordinal(plan.day_of_month)} of every month at ${formatClock(plan.time)}, ${zone}`;
    case "every_n_hours": {
      const every = plan.every_hours === 1 ? "Every hour" : `Every ${plan.every_hours} hours`;
      return `${every} from ${formatClock(plan.time)} until midnight, ${zone}`;
    }
  }
}

/**
 * An instant as the automation's zone shows it, WITH the abbreviation in force
 * at that instant: "Sun, Nov 1, 1:00 AM EDT" and "Sun, Nov 1, 1:00 AM EST" are
 * different runs. An unknown zone is shown in UTC, labelled as such.
 */
export function formatRunInstant(instant: Date | number, timezone: string): string {
  const date = typeof instant === "number" ? new Date(instant) : instant;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: isTimeZone(timezone) ? timezone : "UTC" }).format(date);
  } catch {
    text = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(date);
  }
  // ICU puts a narrow no-break space before AM/PM; keep plain spaces.
  return text.replace(/[\u202f\u00a0]/g, " ");
}

// ── run times ──────────────────────────────────────────────────────────────

type CompiledCron = {
  minutes: number[];
  hours: number[];
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The hour field covers all 24 hours: elapsed-time semantics across DST. */
  everyHour: boolean;
};

function compileCron(cron: string): CompiledCron | null {
  if (!isValidCronExpr(cron)) return null;
  const [mi, h, dom, mon, dow] = normalizeCron(cron).split(" ");
  const minutes = expandNumericField(mi, 0, 59);
  const hours = expandNumericField(h, 0, 23);
  const doms = expandNumericField(dom, 1, 31);
  const months = expandNumericField(mon, 1, 12);
  const dows = expandNumericField(dow, 0, 7);
  if (!minutes || !hours || !doms || !months || !dows) return null;
  return {
    minutes,
    hours,
    doms: new Set(doms),
    months: new Set(months),
    dows: new Set(dows.map((d) => d % 7)),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
    everyHour: hours.length === 24,
  };
}

/** Minutes `tz` is ahead of UTC at instant `t`. */
function offsetMinutes(tz: string, t: number): number {
  const p = wallParts(new Date(t), tz);
  const asUtc = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / MIN_MS);
}

function dayMatches(c: CompiledCron, dom: number, weekday: number): boolean {
  const domOk = c.doms.has(dom);
  const dowOk = c.dows.has(weekday);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/** Every instant the cron fires on one wall date (`base` = that date at 00:00 as if UTC). */
function dayInstants(c: CompiledCron, tz: string, base: number): number[] {
  // Offsets before the local day can begin and after it must have ended
  // (zones run from UTC-12 to UTC+14). Equal means no change that day.
  const before = offsetMinutes(tz, base - 14 * HOUR_MS);
  const after = offsetMinutes(tz, base + 38 * HOUR_MS);
  const out = new Set<number>();
  for (const h of c.hours) {
    for (const mi of c.minutes) {
      const wall = base + (h * 60 + mi) * MIN_MS;
      if (before === after) {
        out.add(wall - before * MIN_MS);
        continue;
      }
      const real = [...new Set([before, after])]
        .map((o) => wall - o * MIN_MS)
        .filter((t) => offsetMinutes(tz, t) * MIN_MS === wall - t)
        .sort((a, b) => a - b);
      if (real.length === 0) {
        // Spring-forward gap: a fixed time runs once, pushed past the gap; an
        // every-hour schedule has no run in an hour that does not exist.
        if (!c.everyHour) out.add(wall - before * MIN_MS);
        continue;
      }
      // Fall-back overlap: a fixed time runs the first time the clock shows
      // it; an every-hour schedule runs in both copies of the hour.
      if (c.everyHour) for (const t of real) out.add(t);
      else out.add(real[0]);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Runs in (afterMs, untilMs], at most `max`, in order. */
function collectRuns(c: CompiledCron, tz: string, afterMs: number, untilMs: number, max: number): number[] {
  const start = wallParts(new Date(afterMs), tz);
  const firstDay = dayNumber(start.y, start.m, start.d);
  const found = new Set<number>();
  // A time pushed out of a gap at the very end of one day can land on the next
  // day's first run, so once enough are found, one more day is read before
  // sorting and cutting.
  let stopAfterDay: number | null = null;
  // The horizon is PER occurrence, not for the whole collection: it resets to
  // the day a run was last found, so a sparse schedule can keep going past it
  // to fill `max`, while a schedule that never matches still terminates after
  // one HORIZON_DAYS-long scan from the start.
  let lastProgressDay = firstDay - 1;
  for (let day = firstDay; day - lastProgressDay <= HORIZON_DAYS; day += 1) {
    if (stopAfterDay !== null && day > stopAfterDay) break;
    const { y, m, d, weekday } = fromDayNumber(day);
    const base = Date.UTC(y, m, d);
    if (base - 14 * HOUR_MS > untilMs) break;
    if (!c.months.has(m + 1) || !dayMatches(c, d, weekday)) continue;
    const before = found.size;
    for (const t of dayInstants(c, tz, base)) {
      if (t > afterMs && t <= untilMs) found.add(t);
    }
    if (found.size > before) lastProgressDay = day;
    if (stopAfterDay === null && found.size >= max) stopAfterDay = day + 1;
  }
  return [...found].sort((a, b) => a - b).slice(0, max);
}

function toMs(value: Date | number): number {
  return typeof value === "number" ? value : value.getTime();
}

/**
 * The next `count` runs strictly after `after`, as instants. The function the
 * wizard's preview, the arming of a pending slot and the dispatcher share.
 * Empty for an unknown zone, a refused cron, or a cron that never fires.
 */
export function nextRuns(cron: string, timezone: string, after: Date | number, count: number): Date[] {
  const afterMs = toMs(after);
  if (!Number.isFinite(afterMs) || !Number.isInteger(count) || count < 1) return [];
  if (!isTimeZone(timezone) || timezone.trim() === "") return [];
  const compiled = compileCron(cron);
  if (!compiled) return [];
  return collectRuns(compiled, timezone, afterMs, Number.POSITIVE_INFINITY, count).map((t) => new Date(t));
}

/**
 * The shortest gap, in minutes, between consecutive runs in the 7 days from
 * `from`. Seven days, not one: a schedule that crowds its runs only on Mondays
 * must be seen on a Tuesday. Infinity when fewer than two runs fall in that
 * window; null when the cron or zone is refused (callers fail closed).
 */
export function minGapOver7Days(cron: string, timezone: string, from: Date | number): number | null {
  const fromMs = toMs(from);
  if (!Number.isFinite(fromMs)) return null;
  if (!isTimeZone(timezone) || timezone.trim() === "") return null;
  const compiled = compileCron(cron);
  if (!compiled) return null;
  const runs = collectRuns(compiled, timezone, fromMs - 1, fromMs + 7 * DAY_MS, Number.POSITIVE_INFINITY);
  if (runs.length < 2) return Number.POSITIVE_INFINITY;
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i += 1) smallest = Math.min(smallest, runs[i] - runs[i - 1]);
  return smallest / MIN_MS;
}

// ── spreading and identity ─────────────────────────────────────────────────

/** FNV-1a, 32-bit, over the UTF-8 bytes of `text`. Stable across runtimes. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Seconds (0-299) a task's runs are spread after the chosen minute. */
export function jitterFor(id: string): number {
  return fnv1a32(id) % 300;
}

/** The dispatcher lane (0-7) a task's slots are claimed on. */
export function laneFor(id: string): number {
  return fnv1a32(id) % 8;
}

/** What a pending slot was armed against; a change means it must be re-armed. */
export function scheduleKey(cron: string, timezone: string, mode: ScheduleMode, jitterS: number): string {
  return `${cron}|${timezone}|${mode}|${jitterS}`;
}
