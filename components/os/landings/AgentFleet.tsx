/**
 * AgentFleet — Admin › Fleet's roster: one row per agent the workspace has
 * enabled, whether it is running, and what it owns (registered schedules,
 * always-on processes, workflows). Moved from the old /agents page with its
 * copy and catalog intact; the pulsing glow dot and the per-agent coloured
 * labels were not moved (#464: no perpetual motion, no glow; blue is for
 * actions and links).
 *
 * Server component. Signals come from fleet-data.ts; when those reads failed,
 * every agent says "status unknown" rather than "never seen".
 *
 * Running (2026-09-30) means one of the agent's processes on the operator's
 * machine checked in within 5 minutes; "Last task" (its last reasoning tick)
 * is its own line, so a quiet loop no longer reads as a dead agent and a stale
 * tick no longer reads as a running one.
 */

import { Card, Tag } from "@/components/Card";
import { catalogFor } from "@/lib/agent-catalog";
import { getAgentInfo } from "@/lib/agents";
import { timeAgo } from "@/lib/fmt";
import type { Fleet } from "@/components/os/landings/fleet-data";

export function fleetSummary(fleet: Fleet): { running: number; total: number } | null {
  if (!fleet.signalsKnown) return null;
  let running = 0;
  for (const s of fleet.signals.values()) if (s.live) running += 1;
  return { running, total: fleet.agents.length };
}

export function AgentFleet({ fleet }: { fleet: Fleet }) {
  if (fleet.agents.length === 0) {
    return (
      <Card>
        <p className="py-6 text-sm text-fg-muted">No agents are enabled for this workspace.</p>
      </Card>
    );
  }
  return (
    <Card noPadding>
      <ul className="divide-y divide-hairline">
        {fleet.agents.map((key) => {
          const info = getAgentInfo(key);
          const cat = catalogFor(key);
          const signal = fleet.signals.get(key) ?? null;
          const total = cat.crons.length + cat.processes.length + cat.workflows.length;
          const dot = !fleet.signalsKnown
            ? "bg-fg-faint"
            : signal?.live
              ? "bg-status-engaged"
              : signal?.lastSignalAt
                ? "bg-status-warm"
                : "bg-fg-faint";
          const status = !fleet.signalsKnown
            ? "status unknown"
            : signal?.live
              ? `Running · ${signal.runningCount} of ${signal.processCount} process${signal.processCount === 1 ? "" : "es"} checked in`
              : signal?.lastSignalAt
                ? `Not running · last check-in ${timeAgo(signal.lastSignalAt)}`
                : "No process has reported";
          const lastTask = !fleet.signalsKnown
            ? null
            : signal?.lastTaskAt
              ? `Last task ${timeAgo(signal.lastTaskAt)}${signal.tickCount !== null ? ` (tick ${signal.tickCount})` : ""}`
              : "No task recorded";
          return (
            <li key={key} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold text-fg">{info.label}</span>
                    <span className="text-xs text-fg-muted">{info.tagline}</span>
                  </div>
                  {info.description && <p className="mt-1 text-[13px] leading-5 text-fg-muted">{info.description}</p>}
                  {info.askMeAbout && (
                    <p className="mt-1 text-xs text-fg-dim">
                      <span className="font-medium text-fg-muted">Ask about: </span>
                      {info.askMeAbout}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs tabular-nums text-fg-muted">
                  <div>{status}</div>
                  {lastTask && <div className="mt-0.5 text-fg-dim">{lastTask}</div>}
                  {total > 0 && <div className="mt-0.5 text-fg-dim">{total} highlighted</div>}
                </div>
              </div>
              {total > 0 ? (
                <div className="grid gap-4 pl-5 lg:grid-cols-3">
                  <CatalogColumn
                    title="Registered schedules"
                    hint="status in Automations"
                    entries={cat.crons.map((c) => ({ name: c.name, meta: c.schedule || c.location, desc: c.description }))}
                  />
                  <CatalogColumn
                    title="Always-on processes"
                    hint="running locally"
                    entries={cat.processes.map((p) => ({ name: p.name, meta: p.location, desc: p.description }))}
                  />
                  <CatalogColumn
                    title="Workflows"
                    hint="event-triggered"
                    entries={cat.workflows.map((w) => ({ name: w.name, meta: w.location, desc: w.description }))}
                  />
                </div>
              ) : (
                <p className="pl-5 text-xs text-fg-dim">No schedules, processes or workflows registered for this agent yet.</p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function FleetSummaryTag({ fleet }: { fleet: Fleet }) {
  const summary = fleetSummary(fleet);
  if (!summary) return <Tag tone="warm">Status unknown</Tag>;
  return <Tag tone={summary.running === 0 ? "neutral" : "engaged"}>{`${summary.running} of ${summary.total} running`}</Tag>;
}

function CatalogColumn({
  title,
  hint,
  entries,
}: {
  title: string;
  hint: string;
  entries: Array<{ name: string; meta: string; desc: string }>;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-fg-muted">
        {title} <span className="tabular-nums text-fg-dim">({entries.length})</span>
      </div>
      <div className="mb-2 text-[11px] text-fg-dim">{hint}</div>
      {entries.length === 0 ? (
        <div className="text-xs text-fg-dim">None</div>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.name} className="text-xs leading-snug">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="font-medium text-fg">{prettifyEntryName(e.name)}</span>
                {prettifyMeta(e.meta) && <span className="text-[11px] text-fg-dim">· {prettifyMeta(e.meta)}</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-fg-muted">{e.desc}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "lead_engine" → "Lead engine", "snapshot-mrr" → "Snapshot MRR" (acronyms kept). */
export function prettifyEntryName(raw: string): string {
  const ACRONYMS = new Set(["mrr", "edi", "pos", "crm", "kpi", "ai", "cmo", "cfo", "ceo", "po", "rsvp", "fire"]);
  const cleaned = raw.replace(/[_-]+/g, " ").trim();
  return cleaned
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return lower;
    })
    .join(" ");
}

/**
 * Hosts OASIS left (Turso replaced Supabase on 2026-08-09; the Command Center
 * runs on Cloudflare): a catalog entry still tagged with one shows no host
 * rather than a wrong one. "vercel" meant the hosted dashboard, now "cloud".
 */
const RETIRED_LOCATION: Record<string, string> = { supabase: "", vercel: "cloud" };

/** Cron strings in plain English ("0 3 * * *" → "daily at 3:00 AM UTC"); locations pass through. */
export function prettifyMeta(meta: string): string {
  if (!meta) return "";
  if (meta in RETIRED_LOCATION) return RETIRED_LOCATION[meta];
  const cronMatch = meta.match(/^(\d+|\*)\s+(\d+|\*)\s+(\*)\s+(\*)\s+(\*)$/);
  if (cronMatch) {
    const [, min, hour] = cronMatch;
    if (min === "*" && hour === "*") return "every minute";
    if (min !== "*" && hour !== "*") {
      const h = Number(hour);
      const m = Number(min);
      const ampm = h < 12 ? "AM" : "PM";
      const h12 = h === 0 ? 12 : h <= 12 ? h : h - 12;
      return `daily at ${h12}:${m.toString().padStart(2, "0")} ${ampm} UTC`;
    }
    if (min !== "*" && hour === "*") return `every hour at :${min.padStart(2, "0")}`;
    if (min === "*" && hour !== "*") return `every minute during the ${hour}:00 UTC hour`;
  }
  const stepMin = meta.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (stepMin) return `every ${stepMin[1]} minutes`;
  const stepHour = meta.match(/^(\d+)\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (stepHour) return `every ${stepHour[2]} hours at :${stepHour[1].padStart(2, "0")}`;
  return meta;
}
