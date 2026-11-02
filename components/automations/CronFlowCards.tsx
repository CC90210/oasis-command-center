/**
 * CronFlowCards - Automations: "24/7 cloud automations (Cloudflare)", one row per scheduled cloud
 * job (2026-10-28, Phase 7; on/off switches and plain names 2026-10-31).
 *
 * Each row reads left to right: what the job does (plain name and one line, lib/automations/
 * cloud-jobs.ts) and when it runs, what happened (the last run, the last 24 hours, the next run),
 * and its ON / PAUSED switch. Data: lib/automations/cron-runs.ts over cron_runs and
 * cron_job_switches. A schedule with no recorded run says "not measured yet"; a failed read says so,
 * never zeros. The switch works only for the viewer the toggle route accepts: the page mount
 * resolves that (app/automations/page.tsx with lib/automations/cloud-job-control.ts) and passes
 * canToggle, so this card never loads the session code; everyone else sees the state read-only.
 *
 * Server component. Solid status dots, no glow and no perpetual motion (#464).
 */
import { Card } from "@/components/Card";
import { CloudJobToggle } from "@/components/automations/CloudJobToggle";
import { cloudJobInfo } from "@/lib/automations/cloud-jobs";
import { cloudJobName, cloudJobsSubtitle, lastRunLine, nextRunText } from "@/lib/automations/cloud-job-display";
import { loadCronFlows, type CronFlow } from "@/lib/automations/cron-runs";
import { timeAgo } from "@/lib/devices/presence";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

const DOT: Record<"ok" | "failed" | "overdue" | "none", string> = {
  ok: "bg-status-engaged",
  failed: "bg-status-hot",
  overdue: "bg-status-warm",
  none: "bg-fg-dim",
};

export async function CronFlowCards({ canToggle = false }: { canToggle?: boolean }) {
  const now = Date.now();
  const flows = tursoConfigured() ? await loadCronFlows(getTursoClient(), now) : null;
  return <CronFlowList flows={flows} now={now} canToggle={canToggle} />;
}

/** The card itself, from data already read (null = the read failed). */
export function CronFlowList({ flows, now, canToggle = false }: { flows: CronFlow[] | null; now: number; canToggle?: boolean }) {
  return (
    <Card title="24/7 cloud automations (Cloudflare)" subtitle={cloudJobsSubtitle(flows, canToggle, now)}>
      {flows === null ? null : (
        <ul className="divide-y divide-bg-border">
          {flows.map((flow) => {
            const info = cloudJobInfo(flow.path);
            const name = cloudJobName(flow.path);
            const paused = flow.enabled === false;
            const line = lastRunLine(flow, now);
            const next = nextRunText(flow);
            return (
              <li
                key={flow.path}
                className={`grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-3 ${paused ? "opacity-70" : ""}`}
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg" title={flow.path}>
                    <span>{name}</span>
                    {info?.noLiveUse && (
                      <span className="rounded-full border border-status-warm/40 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-status-warm">
                        No live use · Safe to pause
                      </span>
                    )}
                  </p>
                  {info && <p className="text-xs text-fg-muted">{info.description}</p>}
                  {info?.noLiveUse && <p className="text-[11px] text-status-warm">{info.noLiveUse}</p>}
                  <p className="text-[11px] text-fg-dim">Runs {flow.words}</p>
                </div>
                <div className="min-w-0 text-xs">
                  {paused ? (
                    <>
                      <p className="flex items-center gap-1.5 text-fg">
                        <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT.none}`} />
                        <span className="truncate">Paused{flow.pausedAt ? ` · ${timeAgo(flow.pausedAt, { now })}` : ""}</span>
                      </p>
                      <p className="text-fg-dim">Won&apos;t run until it is switched back on</p>
                    </>
                  ) : (
                    <>
                      <p className="flex items-center gap-1.5 text-fg">
                        <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[line.tone]}`} />
                        <span className="truncate">{line.text}</span>
                      </p>
                      <p className="text-fg-dim">
                        {flow.day.total > 0 ? `${flow.day.ok}/${flow.day.total} OK in 24 h` : "No runs in 24 h"}
                        {next ? ` · ${next}` : ""}
                      </p>
                    </>
                  )}
                </div>
                <div className="sm:justify-self-end">
                  <CloudJobToggle route={flow.path} name={name} enabled={flow.enabled} canToggle={canToggle} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
