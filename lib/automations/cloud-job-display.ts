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

/** A row's last-run state: a dot tone and one line. PURE. */
export function lastRunLine(flow: CronFlow, now: number): { tone: "ok" | "failed" | "none"; text: string } {
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
export function cloudJobsSubtitle(flows: CronFlow[] | null, canToggle: boolean): string {
  if (flows === null) return "Couldn't read the run history just now. The read failed and has been logged.";
  const paused = flows.filter((f) => f.enabled === false).length;
  const failing = flows.filter((f) => f.enabled !== false && f.last && !f.last.ok).length;
  return [
    `${flows.length} scheduled jobs run on Cloudflare whether or not your computer is on.`,
    paused ? `${paused} paused.` : "",
    failing ? `${failing} failed on their last run.` : "",
    canToggle ? "Switch any job off or on here." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
