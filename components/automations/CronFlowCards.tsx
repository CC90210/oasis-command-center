/**
 * CronFlowCards - Automations: one flow card per scheduled cloud job (2026-10-28, Phase 7).
 *
 * Each card reads left to right: when it runs (in words), what runs it (the Cloudflare cron Worker
 * calling the route), and what happened: the last run's result and time, the last 24 hours, and the
 * next run. Data: lib/automations/cron-runs.ts over cron_runs, which the Worker fills each tick.
 * A schedule with no recorded run says "not measured yet"; a failed read says so, never zeros.
 *
 * Server component. Solid status dots, no glow and no perpetual motion (#464).
 */
import { Card } from "@/components/Card";
import { loadCronFlows, type CronFlow } from "@/lib/automations/cron-runs";
import { timeAgo } from "@/lib/devices/presence";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

/** "/api/cron/finance-books?job=fx-refresh" -> "Finance books: fx refresh". PURE. */
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

/** The card's state: a dot tone and one line. PURE. */
export function lastRunLine(flow: CronFlow, now: number): { tone: "ok" | "failed" | "none"; text: string } {
  if (!flow.last) return { tone: "none", text: "Not measured yet" };
  const when = timeAgo(flow.last.at, { now });
  const ms = flow.last.ms !== null ? ` · ${flow.last.ms.toLocaleString("en-US")} ms` : "";
  return flow.last.ok
    ? { tone: "ok", text: `OK${ms} · ${when}` }
    : { tone: "failed", text: `Failed (${flow.last.status || "no answer"})${ms} · ${when}` };
}

const DOT: Record<"ok" | "failed" | "none", string> = {
  ok: "bg-status-engaged",
  failed: "bg-status-hot",
  none: "bg-fg-dim",
};

export async function CronFlowCards() {
  const now = Date.now();
  const flows = tursoConfigured() ? await loadCronFlows(getTursoClient(), now) : null;
  return <CronFlowList flows={flows} now={now} />;
}

/** The card itself, from data already read (null = the read failed). */
export function CronFlowList({ flows, now }: { flows: CronFlow[] | null; now: number }) {
  const failing = flows ? flows.filter((f) => f.last && !f.last.ok).length : 0;
  return (
    <Card
      title="Scheduled cloud jobs"
      subtitle={
        flows === null
          ? "Couldn't read the run history just now. The read failed and has been logged."
          : `${flows.length} jobs run on Cloudflare whether or not a computer is on.${failing ? ` ${failing} failed on their last run.` : ""}`
      }
    >
      {flows === null ? null : (
        <ul className="divide-y divide-bg-border">
          {flows.map((flow) => {
            const line = lastRunLine(flow, now);
            return (
              <li key={flow.path} className="grid gap-1 py-2.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)] sm:gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">{cronJobName(flow.path)}</p>
                  <p className="text-xs text-fg-muted">{flow.words}</p>
                </div>
                <p className="min-w-0 truncate font-mono text-[11px] text-fg-dim" title={flow.path}>
                  Cloudflare cron → {flow.path}
                </p>
                <div className="min-w-0 text-xs">
                  <p className="flex items-center gap-1.5 text-fg">
                    <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[line.tone]}`} />
                    <span className="truncate">{line.text}</span>
                  </p>
                  <p className="text-fg-dim">
                    {flow.day.total > 0 ? `${flow.day.ok}/${flow.day.total} OK in 24 h` : "No runs in 24 h"}
                    {flow.nextAt ? ` · next ${new Date(flow.nextAt).toISOString().slice(11, 16)} UTC` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
