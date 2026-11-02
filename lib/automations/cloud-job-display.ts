/**
 * lib/automations/cloud-job-display.ts - the words on the "24/7 cloud automations (Cloudflare)" card
 * (moved out of components/automations/CronFlowCards.tsx on 2026-10-31 so tests can read them
 * without loading the card's client-side switch).
 *
 * PURE: no database, no session, no React.
 */
import type { CronFlow } from "@/lib/automations/cron-runs";
import { cloudJobInfo } from "@/lib/automations/cloud-jobs";
import { timeAgo } from "@/lib/devices/presence";
import { nextRuns } from "@/lib/automations/schedule-plan";

/** "/api/cron/finance-books?job=fx-refresh" -> "Finance books: FX refresh". The fallback for an unknown path. PURE. */
export function cronJobName(path: string): string {
  const [base, query] = path.replace(/^\/api\/cron\//, "").split("?");
  const ACRONYMS = new Set(["ai", "cc", "fx", "sla", "sms"]);
  const words = (s: string) =>
    s
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w))
      .join(" ");
  const name = words(base);
  const job = query ? new URLSearchParams(query).get("job") : null;
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return job ? `${label}: ${words(job)}` : label;
}

/** The plain-English name of a scheduled job (lib/automations/cloud-jobs.ts); an unknown path falls back to its words. PURE. */
export function cloudJobName(path: string): string {
  return cloudJobInfo(path)?.name ?? cronJobName(path);
}

// The cron Worker allows two attempts, retry jitter and a reporting request.
// Ordinary routes get 2 minutes per attempt; these dispatchers get 14 minutes.
// A missing report is only overdue after that entire execution budget.
const LONG_RUNNING_PATHS = new Set([
  "/api/cron/dispatch-engine-fallbacks",
  "/api/cron/dispatch-automations",
]);

export function cloudRunFreshness(flow: CronFlow, now: number): "fresh" | "overdue" | "unknown" | "unmeasured" | "paused" {
  if (flow.enabled === false) return "paused";
  if (flow.enabled === null || !Number.isFinite(now)) return "unknown";
  const lastAt = flow.last ? Date.parse(flow.last.at) : null;
  const resumedAt = flow.resumedAt ? Date.parse(flow.resumedAt) : null;
  const times = [lastAt, resumedAt].filter((at): at is number => at !== null);
  if (times.some((at) => !Number.isFinite(at) || at > now + 60_000)) return "unknown";
  if (times.length === 0) return "unmeasured";
  const baseline = Math.max(...times);
  const due = nextRuns(flow.schedule, flow.timeZone, baseline, 1)[0]?.getTime();
  if (due === undefined || !Number.isFinite(due)) return "unknown";
  const grace = (LONG_RUNNING_PATHS.has(flow.path) ? 30 : 5) * 60_000;
  return now > due + grace ? "overdue" : "fresh";
}

/** A row's last-run state: a dot tone and one line. PURE. */
export function lastRunLine(flow: CronFlow, now: number): { tone: "ok" | "failed" | "overdue" | "none"; text: string } {
  const freshness = cloudRunFreshness(flow, now);
  if (freshness === "paused") return { tone: "none", text: "Paused" };
  if (freshness === "unknown") return { tone: "none", text: "Run freshness could not be checked" };
  if (freshness === "overdue") {
    const previous = flow.last
      ? `last ${flow.last.ok ? "OK" : `failed (${flow.last.status || "no answer"})`} report ${timeAgo(flow.last.at, { now })}`
      : "no run reported since this job was switched on";
    return { tone: "overdue", text: `Overdue · ${previous}` };
  }
  if (!flow.last) return { tone: "none", text: "Not measured yet" };
  const when = timeAgo(flow.last.at, { now });
  const ms = flow.last.ms !== null ? ` · ${flow.last.ms.toLocaleString("en-US")} ms` : "";
  return flow.last.ok
    ? { tone: "ok", text: `OK${ms} · ${when}` }
    : { tone: "failed", text: `Failed (${flow.last.status || "no answer"})${ms} · ${when}` };
}

/** The next instant in the schedule's own zone, including the active DST abbreviation. PURE. */
export function nextRunText(flow: Pick<CronFlow, "nextAt" | "timeZone">): string | null {
  if (!flow.nextAt) return null;
  const instant = new Date(flow.nextAt);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: flow.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(instant);
    const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value;
    const hour = value("hour");
    const minute = value("minute");
    const zone = value("timeZoneName");
    return hour && minute && zone ? `next ${hour}:${minute} ${zone}` : null;
  } catch {
    return null;
  }
}

/** The card's subtitle: how many jobs, and what needs a look. PURE. */
export function cloudJobsSubtitle(flows: CronFlow[] | null, canToggle: boolean, now = Date.now()): string {
  if (flows === null) return "Couldn't read the run history just now. The read failed and has been logged.";
  const paused = flows.filter((f) => f.enabled === false).length;
  const failing = flows.filter((f) => f.enabled !== false && f.last && !f.last.ok).length;
  const overdue = flows.filter((f) => cloudRunFreshness(f, now) === "overdue").length;
  return [
    `${flows.length} scheduled jobs run on Cloudflare whether or not your computer is on.`,
    paused ? `${paused} paused.` : "",
    failing ? `${failing} failed on their last run.` : "",
    overdue ? `${overdue} overdue for a run report.` : "",
    canToggle ? "Switch any job off or on here." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
