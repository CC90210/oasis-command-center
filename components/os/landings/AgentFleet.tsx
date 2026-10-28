/**
 * AgentFleet — Admin › Fleet: CC's four agents (Bravo, Atlas, Maven, Aura), one
 * tile each (2026-10-28). Each tile says ONE liveness state (fleet-data.ts
 * fleetLiveness: grey never seen, green alive, amber quiet, red down), what it
 * is made of (process check-ins, the agent's own last tick, the computer it runs
 * on, its last Coding harness job: times and statuses only), and three quick
 * actions: open it in the Coding harness, see what it was taught, manage its
 * processes. What an agent is working on is never shown: it stays on the Mac.
 *
 * Server component. A solid status dot, no glow and no perpetual motion (#464).
 * When the liveness reads failed, every tile says "status unknown" rather than
 * "never seen".
 */

import Link from "next/link";
import { Card, Tag } from "@/components/Card";
import { catalogFor } from "@/lib/agent-catalog";
import { getAgentInfo } from "@/lib/agents";
import { HARNESS_TARGETS } from "@/lib/admin/harness-targets";
import { timeAgo } from "@/lib/fmt";
import {
  COMPUTER_SILENT_MS,
  fleetLiveness,
  type Fleet,
  type FleetSignal,
  type Liveness,
} from "@/components/os/landings/fleet-data";

/** Each agent's seat in CC's company. */
export const FLEET_ROLES: Record<string, string> = {
  bravo: "CEO · COO · CTO",
  atlas: "CFO",
  maven: "CMO",
  aura: "Life & home",
};

/** The Admin › Agent training tab each agent learns on (Aura has no department). */
export const FLEET_TRAINING_TAB: Record<string, string> = {
  bravo: "chief_of_staff",
  atlas: "finance",
  maven: "marketing",
};

const LIVENESS: Record<Liveness, { dot: string; word: string }> = {
  green: { dot: "bg-status-engaged", word: "Alive" },
  amber: { dot: "bg-status-warm", word: "Quiet" },
  red: { dot: "bg-status-hot", word: "Down" },
  grey: { dot: "bg-fg-faint", word: "Never seen" },
};

/** The newest of an agent's process check-in and its own tick. */
function lastHeard(signal: FleetSignal | null | undefined): string | null {
  const times = [signal?.lastSignalAt, signal?.lastTaskAt].filter((t): t is string => Boolean(t));
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export function fleetSummary(fleet: Fleet, now: number = Date.now()): { running: number; total: number } | null {
  if (!fleet.signalsKnown) return null;
  let running = 0;
  for (const key of fleet.agents) if (fleetLiveness(fleet.signals.get(key), fleet.computer, now) === "green") running += 1;
  return { running, total: fleet.agents.length };
}

export function AgentFleet({ fleet }: { fleet: Fleet }) {
  if (fleet.agents.length === 0) {
    return (
      <Card>
        <p className="py-6 text-sm text-fg-muted">No agents are wired to this workspace.</p>
      </Card>
    );
  }
  const now = Date.now();
  const computerSilent =
    fleet.computer && (!fleet.computer.lastSeenAt || now - Date.parse(fleet.computer.lastSeenAt) >= COMPUTER_SILENT_MS);
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {fleet.agents.map((key) => {
        const info = getAgentInfo(key);
        const cat = catalogFor(key);
        const signal = fleet.signals.get(key) ?? null;
        const liveness = fleet.signalsKnown ? fleetLiveness(signal, fleet.computer, now) : null;
        const look = liveness ? LIVENESS[liveness] : { dot: "bg-fg-faint", word: "Status unknown" };
        const heard = lastHeard(signal);
        const total = cat.crons.length + cat.processes.length + cat.workflows.length;
        const job = fleet.lastJobs.get(key);
        const tab = FLEET_TRAINING_TAB[key];
        // Only an agent the Coding harness can open gets the link (Aura has no repo target yet:
        // the harness would open another agent's instead).
        const harness = HARNESS_TARGETS.some((t) => t.agent === key);
        return (
          <li key={key} className="space-y-3 rounded-xl border border-bg-border bg-bg-elev/25 p-4">
            <div className="flex items-start gap-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${look.dot}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold text-fg">{info.label}</span>
                  <span className="text-xs text-fg-muted">{FLEET_ROLES[key] ?? info.tagline}</span>
                </div>
                <div className="mt-0.5 text-[13px] text-fg">
                  {look.word}
                  {liveness && heard ? <span className="text-fg-muted"> · heard {timeAgo(heard)}</span> : null}
                </div>
                {liveness === "red" && computerSilent ? (
                  <div className="mt-0.5 text-xs text-status-hot">
                    {fleet.computer!.label} has been silent{" "}
                    {fleet.computer!.lastSeenAt ? `since ${timeAgo(fleet.computer!.lastSeenAt)}` : "since it was paired"}, so nothing on it can report.
                  </div>
                ) : null}
              </div>
            </div>
            {fleet.signalsKnown ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-fg-dim">Processes</dt>
                <dd className="text-fg-muted">
                  {signal && signal.processCount > 0
                    ? `${signal.runningCount} of ${signal.processCount} running${signal.downCount > 0 ? `, ${signal.downCount} reported down` : ""}`
                    : "None report from your computer"}
                </dd>
                <dt className="text-fg-dim">Last tick</dt>
                <dd className="text-fg-muted">
                  {signal?.lastTaskAt ? `${timeAgo(signal.lastTaskAt)}${signal.tickCount !== null ? ` (tick ${signal.tickCount})` : ""}` : "Never"}
                </dd>
                <dt className="text-fg-dim">Coding harness</dt>
                <dd className="text-fg-muted">
                  {!fleet.jobsKnown
                    ? "Couldn't check"
                    : job
                      ? `Last job ${job.status.replace(/_/g, " ")}${job.errorCode ? ` (${job.errorCode.replace(/_/g, " ")})` : ""} · ${timeAgo(job.at)}`
                      : "No jobs yet"}
                </dd>
              </dl>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {harness ? (
                <Link href={`/agent?agent=${key}`} prefetch={false} className="btn-secondary text-xs">
                  Open in Coding harness
                </Link>
              ) : null}
              {tab ? (
                <Link href={`/admin/agent-training?agent=${tab}`} prefetch={false} className="btn-secondary text-xs">
                  What it learned
                </Link>
              ) : null}
              {signal && signal.processCount > 0 ? (
                <Link href="/automations" prefetch={false} className="btn-secondary text-xs">
                  Processes
                </Link>
              ) : null}
            </div>
            {total > 0 ? (
              <details className="group">
                <summary className="cursor-pointer select-none text-xs text-fg-muted hover:text-fg">What it owns ({total})</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
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
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function FleetSummaryTag({ fleet }: { fleet: Fleet }) {
  const summary = fleetSummary(fleet);
  if (!summary) return <Tag tone="warm">Status unknown</Tag>;
  return <Tag tone={summary.running === 0 ? "neutral" : "engaged"}>{`${summary.running} of ${summary.total} alive`}</Tag>;
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
