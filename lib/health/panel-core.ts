/**
 * lib/health/panel-core.ts — how a health verdict is allowed to render.
 *
 * WHY THIS FILE EXISTS AT ALL. The outcome checks have run every 15 minutes
 * since 2026-08-07 and written to `health_check_runs`, and nothing has ever
 * read that table. /health and /system-health both predate it and look at
 * agent_events instead. So the checks that exist specifically to catch silent
 * failure were themselves failing silently.
 *
 * TWO RULES, AND THEY ARE THE WHOLE POINT:
 *
 *   check_broken IS NOT OK. A check that could not run must never render green.
 *   Treating an errored check as healthy is how a monitor reports fine while
 *   the thing it watches is dead — the exact failure the 2026-06-30 audit named
 *   and the SMS outage then demonstrated for ten days.
 *
 *   SILENCE IS NOT HEALTH. A check with no recent run is STALE, and a check
 *   that has never run is a problem, not a blank. Absence of a bad signal is
 *   not a good signal.
 *
 * Pure and free of "server-only" so both rules are directly testable.
 */

import type { CheckVerdict } from "./checks-core";

export type Tone = "good" | "warn" | "bad" | "unknown";

/**
 * Map a verdict onto how it may be shown.
 *
 * `check_broken` deliberately shares the "bad" tone with `failing`: an operator
 * scanning the page must not be able to mistake "we could not measure this"
 * for "this is fine".
 */
export function verdictTone(verdict: CheckVerdict | string): Tone {
  switch (verdict) {
    case "ok":
      return "good";
    case "degraded":
      return "warn";
    case "failing":
    case "check_broken":
      return "bad";
    default:
      // An unrecognised verdict is not a pass. New states must be classified
      // deliberately rather than defaulting into green.
      return "unknown";
  }
}

export type Freshness = "fresh" | "stale" | "never_run";

/**
 * How much to trust the last run.
 *
 * The checks tick every 15 minutes, so an hour without one means the scheduler
 * is down — which is exactly what happened between 2026-08-06 and 2026-08-11,
 * when Vercel's cron stopped firing and every surface still looked healthy.
 * Staleness has to be visible or the panel inherits that blindness.
 */
export function freshness(input: { ranAt: number | null; nowMs: number; staleAfterMs?: number }): Freshness {
  if (input.ranAt === null || !Number.isFinite(input.ranAt)) return "never_run";
  const staleAfter = input.staleAfterMs ?? 60 * 60 * 1000;
  return input.nowMs - input.ranAt > staleAfter ? "stale" : "fresh";
}

export type PanelCheck = {
  checkId: string;
  verdict: CheckVerdict | string;
  observed: number | null;
  baseline: number | null;
  reason: string | null;
  ranAt: string | null;
};

export type PanelRow = PanelCheck & {
  tone: Tone;
  freshness: Freshness;
  /** True when this row should draw an operator's eye. */
  needsAttention: boolean;
};

/**
 * Decorate checks for display.
 *
 * A stale or never-run check needs attention REGARDLESS of its last verdict,
 * because a green verdict from two days ago describes a world that no longer
 * exists.
 */
export function toPanelRows(checks: PanelCheck[], nowMs: number): PanelRow[] {
  return checks
    .map((c) => {
      const tone = verdictTone(c.verdict);
      const fresh = freshness({ ranAt: c.ranAt ? Date.parse(c.ranAt) : null, nowMs });
      return {
        ...c,
        tone,
        freshness: fresh,
        needsAttention: tone === "bad" || tone === "warn" || tone === "unknown" || fresh !== "fresh",
      };
    })
    .sort((a, b) => {
      // Problems first, then staleness, then alphabetical so the order is stable.
      const rank = (r: PanelRow) => (r.tone === "bad" ? 0 : r.freshness !== "fresh" ? 1 : r.tone === "warn" ? 2 : 3);
      return rank(a) - rank(b) || a.checkId.localeCompare(b.checkId);
    });
}

export type OpenAlert = {
  alertKey: string;
  firstFailedAt: string | null;
  lastAlertedAt: string | null;
  repeatN: number;
};

/** How long the condition has been bad, in whole hours. Null when unknown —
 *  never 0, which would read as "just started" rather than "we don't know". */
export function failingForHours(alert: OpenAlert, nowMs: number): number | null {
  if (!alert.firstFailedAt) return null;
  const started = Date.parse(alert.firstFailedAt);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((nowMs - started) / 3_600_000));
}

/**
 * Where this alert sits on the escalation ladder.
 *
 * Mirrors lib/notify/alert-decay.ts: an alert repeats hourly for the first six
 * hours, then every six, then daily. Showing it stops an operator wondering
 * whether silence means fixed or means throttled.
 */
export function ladderLabel(alert: OpenAlert, nowMs: number): string {
  const hours = failingForHours(alert, nowMs);
  if (hours === null) return "new";
  if (hours < 6) return "hourly";
  if (hours < 24) return "every 6h";
  return "daily";
}
