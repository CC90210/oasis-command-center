/**
 * lib/automations/run-summary.ts - what one Automations row says about its last
 * run, in plain English, with every time in the viewer's own zone.
 *
 * CC 2026-10-16: the row still showed machine text as its message. A good run
 * read `Last result: {"drained": 0}`, a failure read `Error: FAILED (exit 1):
 * [full: ...] Traceback ...`, and a skipped slot said it was skipped but never
 * when. The scheduler's words are evidence, so they stay, inside a closed
 * Details; the line a person reads is built here:
 *   - every row gets one result sentence: "Ran fine at 8:00 AM.", "Failed at
 *     8:00 AM: it took too long and was stopped.", "Result unclear: ...", or the
 *     skip sentence carrying the slot it missed;
 *   - "Last ran" (the last real run) and "Last attempt" (the latest tick, skips
 *     included) are two lines only when they differ;
 *   - only a real failure paints the card red. A skip or a deferral never does,
 *     even while the failure counter is still set: the count keeps its own badge
 *     and the "Last ran" line says that run failed.
 *
 * Pure, with the clock and the zone passed in, so every sentence is pinned by
 * tests/cron-empire-row.test.ts instead of by reading the component as a string.
 */

import {
  attemptKindOf,
  classifyLastResult,
  explainSkippedResult,
  type AttemptKind,
} from "@/lib/cron-empire-row";
import type { CronInventoryJob } from "@/lib/automations/cron-inventory";
import { scheduleIntervalSeconds } from "@/lib/automations/cron-schedule";
import { formatClock, nextRuns } from "@/lib/automations/schedule-plan";
import { isTimeZone, wallDateKey } from "@/lib/calendar/zone";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Enough runs to cover the widest gap of an every-minute schedule plus margin; see previousScheduledRun. */
const PREVIOUS_RUN_SCAN_LIMIT = 500;

export type RunTone = "ok" | "bad" | "unclear" | "neutral";

export type RunSummaryJob = Pick<
  CronInventoryJob,
  "schedule" | "last_run_at" | "last_run_status" | "last_run_output" | "last_run_error"
> &
  Partial<Pick<CronInventoryJob, "next_run_at" | "unresolved_failures" | "last_attempt_kind" | "last_result_text">>;

export type RunSummary = {
  /** Paint the card warm. Only a real failure does. */
  failed: boolean;
  /** The last REAL run. Null when it is not known (never ran, or a deferral overwrote it). */
  lastRan: { text: string; tone: RunTone } | null;
  /** The latest tick, only when it was not that real run. */
  lastAttempt: string | null;
  /** The sentence a person reads. Raw stored text never appears here. */
  result: { text: string; tone: RunTone } | null;
  /** The stored result, verbatim, for a closed Details disclosure. */
  details: string | null;
};

export type RunSummaryOptions = {
  /** Frozen clock for tests; Date.now() otherwise. */
  now?: number;
  /** IANA zone the times are shown in; the viewer's own zone otherwise. */
  timeZone?: string;
};

/** The viewer's zone, as the runtime reports it. UTC rather than a throw. */
export function viewerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

function zoneOf(opts: RunSummaryOptions): string {
  return opts.timeZone && isTimeZone(opts.timeZone) ? opts.timeZone : viewerTimeZone();
}

/** "2h ago": the short relative form the row has always used (moved here from CronJobsManager). */
export function relativeTimeShort(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * A moment the way a sentence carries it, in the viewer's zone: "5:30 AM" today,
 * "5:30 AM yesterday", "5:30 AM on Oct 14" otherwise. The same 12-hour clock as
 * the row's "Next ..." stamp; en-US because it sits inside an English sentence.
 */
export function formatRunMoment(instant: string | number | Date, opts: RunSummaryOptions = {}): string | null {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  const now = opts.now ?? Date.now();
  const timeZone = zoneOf(opts);
  const date = new Date(ms);
  // ICU puts a narrow no-break space before AM/PM; keep plain spaces.
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone })
    .format(date)
    .replace(/[  ]/g, " ");
  const day = wallDateKey(date, timeZone);
  if (day === wallDateKey(new Date(now), timeZone)) return clock;
  if (day === wallDateKey(new Date(now - DAY_MS), timeZone)) return `${clock} yesterday`;
  const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(date);
  return `${clock} on ${dayLabel}`;
}

/**
 * The slot a scheduler skip missed, read off the row's own schedule.
 *
 * `skipped-stale` leaves last_run_at on the last real run and stores no time of
 * its own, but it does advance next_run_at to the first slot after the moment it
 * skipped. The slot just before that one therefore fell inside the window the
 * scheduler was not running: the computer was off at it. That is the time the
 * sentence can honestly name.
 *
 * Two refusals keep it from naming a wrong one. The schedule must be one this
 * file can read, and next_run_at must itself be a run of that schedule in this
 * zone: the scheduler reads cron in its own computer's zone, so a viewer in
 * another zone, or a row whose next run was set by the interval fallback, gets
 * no time rather than an invented one.
 */
export function previousScheduledRun(
  schedule: string,
  nextRunAt: string | null | undefined,
  timeZone: string,
): Date | null {
  if (!nextRunAt) return null;
  const next = Date.parse(nextRunAt);
  if (!Number.isFinite(next)) return null;
  const widestGapSeconds = scheduleIntervalSeconds(schedule);
  if (widestGapSeconds === null) return null;
  // Two hours past the widest gap covers a daylight-saving shift either way.
  const from = next - widestGapSeconds * 1000 - 2 * HOUR_MS;
  const runs = nextRuns(schedule, timeZone, from, PREVIOUS_RUN_SCAN_LIMIT).map((d) => d.getTime());
  const at = runs.findIndex((t) => Math.abs(t - next) < MINUTE_MS);
  if (at <= 0) return null;
  return new Date(runs[at - 1]);
}

/**
 * The missed slot when the stored text names one after the word "missed": a
 * full timestamp with its zone, or a wall-clock "05:30" (a catch-up line such as
 * "caught-up: missed 05:30 slot (PC off)"). Anything else is not trusted as the
 * slot: "skipped: waiting until 09:00" names a different moment.
 */
export function slotNamedInText(text: string | null | undefined, opts: RunSummaryOptions = {}): string | null {
  if (!text) return null;
  const match =
    /\bmissed\b\D{0,24}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})|\d{1,2}:\d{2})/i.exec(text);
  if (!match) return null;
  const found = match[1];
  if (found.includes("T")) return formatRunMoment(found, opts);
  const [h, m] = found.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return formatClock(found);
}

/**
 * A short reason a person can read, when the stored text states one. Never a
 * cause the text does not state: null leaves "Failed at 8:00 AM." on its own,
 * with the scheduler's own words one click away under Details.
 */
export function plainFailureReason(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  // The shape scan the board already trusts (lib/cron-empire-row.ts): a JSON
  // summary or "failed: 3" counting its own failures.
  const reported = /^reported (\w+)=(.*)$/.exec(classifyLastResult(text).reason ?? "");
  if (reported) {
    const [, key, value] = reported;
    if (key === "ok") return "it reported that it did not succeed";
    if (key === "status" || key === "state" || key === "result") return "it reported that it failed";
    const count = Number(value);
    if (Number.isInteger(count) && count > 0) return count === 1 ? "it reported 1 problem" : `it reported ${count} problems`;
    return "it reported a problem";
  }
  const t = text.toLowerCase();
  if (/timed out|timeout/.test(t)) return "it took too long and was stopped";
  if (/unknown_action_type/.test(t)) return "the scheduler does not know how to run this job";
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|permission denied|invalid[ _-]?(?:api[ _-]?)?key/.test(t)) {
    return "it was refused access";
  }
  if (/\b429\b|rate[ _-]?limit|quota/.test(t)) return "it hit a usage limit";
  if (/econnrefused|enotfound|getaddrinfo|connection (?:refused|reset|error)|could not connect/.test(t)) {
    return "it could not reach a service it needs";
  }
  if (/no such file|enoent|no module named|cannot find module/.test(t)) return "something it needs is missing";
  if (/traceback|exit -?\d+|\berror\b|\bfailed\b/.test(t)) return "the script stopped with an error";
  return null;
}

export function summarizeRun(job: RunSummaryJob, opts: RunSummaryOptions = {}): RunSummary {
  const now = opts.now ?? Date.now();
  const at: RunSummaryOptions = { now, timeZone: zoneOf(opts) };
  const status = job.last_run_status;
  const raw = job.last_result_text ?? null;
  // Tenant rows have no verbatim column: their error and output ARE the stored text.
  const evidence = raw ?? job.last_run_error ?? job.last_run_output ?? null;
  const details = evidence && evidence.trim() ? evidence : null;
  const failures = Math.max(0, job.unresolved_failures ?? 0);
  // An older payload without the field still carries the skip in its status.
  const kind: AttemptKind | null =
    job.last_attempt_kind !== undefined
      ? job.last_attempt_kind
      : status === "skipped"
        ? attemptKindOf(evidence) ?? "skipped"
        : null;

  if (kind) {
    // Only the scheduler's own skip leaves last_run_at on the last real run; a
    // skip or deferral the job wrote was stamped at that attempt instead, and
    // the real run before it is no longer recorded anywhere.
    const lastRanAt = kind === "missed" ? job.last_run_at : null;
    const attemptAt = kind === "missed" ? null : job.last_run_at;
    const derivedSlot =
      kind === "missed" ? previousScheduledRun(job.schedule, job.next_run_at, at.timeZone as string) : null;
    // The missed slot when the text names it, else the slot read off the
    // schedule, else the attempt's own time.
    const when =
      slotNamedInText(evidence, at) ??
      (derivedSlot ? formatRunMoment(derivedSlot, at) : attemptAt ? formatRunMoment(attemptAt, at) : null);
    const verb = kind === "deferred" ? "held back" : "skipped";
    return {
      // A computer that was off, or a job waiting its turn, is not a failure
      // (CC 2026-10-16). The counter still shows: its badge, and "and failed"
      // on the real run it belongs to.
      failed: false,
      lastRan: lastRanAt
        ? {
            text: `Last ran ${relativeTimeShort(lastRanAt, now)}${failures > 0 ? " and failed" : ""}`,
            tone: failures > 0 ? "bad" : "neutral",
          }
        : null,
      lastAttempt:
        kind === "missed"
          ? when ? `Last attempt: skipped at ${when}` : "Last attempt: skipped"
          : attemptAt
            ? `Last attempt ${relativeTimeShort(attemptAt, now)}: ${verb}`
            : `Last attempt: ${verb}`,
      result: { text: explainSkippedResult(evidence ?? "", when), tone: "neutral" },
      details,
    };
  }

  const ranAt = job.last_run_at;
  const when = ranAt ? formatRunMoment(ranAt, at) : null;
  const atWhen = when ? ` at ${when}` : "";
  const lastRan = ranAt
    ? {
        text: `Last ran ${relativeTimeShort(ranAt, now)}`,
        tone: (status === "success" ? "ok" : status === "error" ? "bad" : status === "unknown" ? "unclear" : "neutral") as RunTone,
      }
    : null;

  let result: RunSummary["result"] = null;
  if (status === "success") {
    const caughtUp = /^caught-up\b/i.test((evidence ?? "").trim()) ? slotNamedInText(evidence, at) : null;
    result = {
      text: `Ran fine${atWhen}${caughtUp ? `, catching up on the ${caughtUp} run the computer missed` : ""}.`,
      tone: "ok",
    };
  } else if (status === "error") {
    // The counter can be what makes it an error while this run's own text reads
    // clean. Say exactly that, rather than pin the failure on this run.
    const counterOnly = failures > 0 && raw !== null && classifyLastResult(raw).status !== "error";
    if (counterOnly) {
      result = {
        text: `Ran${atWhen}, but ${failures} earlier failure${failures === 1 ? " has" : "s have"} not been cleared by a good run.`,
        tone: "bad",
      };
    } else {
      const reason = plainFailureReason(evidence);
      result = { text: `Failed${atWhen}${reason ? `: ${reason}` : ""}.`, tone: "bad" };
    }
  } else if (status === "unknown") {
    result = {
      text: `Result unclear: it ran${atWhen}, but what it saved does not say whether it worked.`,
      tone: "unclear",
    };
  } else if (ranAt) {
    result = { text: `Ran${atWhen}, with no result saved to check.`, tone: "unclear" };
  }

  return { failed: status === "error", lastRan, lastAttempt: null, result, details };
}
