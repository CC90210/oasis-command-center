"use client";

import { useEffect, useState } from "react";
import type { ScanEvent } from "@/lib/site-scan/events";
import type { ScanView } from "@/lib/site-scan/types";
import { AgentConsole, usePacedCount } from "@/components/scan/AgentConsole";
import { CompetitorRadar } from "@/components/scan/CompetitorRadar";
import { SiteViewport } from "@/components/scan/SiteViewport";

/**
 * The scan at work: the agent's log on the left, what it is looking at and what it has found on
 * the right, and the stages as a bar on top. One pace for all of it (usePacedCount), so a counter
 * never runs ahead of the line that earned it. A scan that was already over when the page opened
 * (a permalink) is shown whole, at once.
 */

function counts(events: ScanEvent[]) {
  let pages = 0;
  let checksYes = 0;
  let checks = 0;
  let findings = 0;
  let matched = 0;
  for (const e of events) {
    if (e.kind === "page" && e.data?.kind === "site_page" && typeof e.data.status === "number" && e.data.status >= 200 && e.data.status < 300) pages += 1;
    else if (e.kind === "check") {
      checks += 1;
      if (e.data?.status === "yes") checksYes += 1;
    } else if (e.kind === "signal") findings += 1;
    else if (e.kind === "competitor" || e.kind === "prospect") matched += 1;
  }
  return { pages, checksYes, checks, findings, matched };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ops-panel px-3 py-3">
      <p className="font-display text-2xl font-semibold tabular-nums text-fg">{value}</p>
      <p className="mt-1 font-data text-[9.5px] uppercase tracking-[0.2em] text-fg-dim">{label}</p>
    </div>
  );
}

function useElapsed(t0: number | null, running: boolean, lastAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [running]);
  if (t0 === null) return 0;
  return Math.max(0, ((running ? now : (lastAt ?? now)) - t0) / 1_000);
}

export function LiveWorkspace({ scan, events, finished, wasFinished, stopped = false }: { scan: ScanView | null; events: ScanEvent[]; finished: boolean; wasFinished: boolean; stopped?: boolean }) {
  const shownCount = usePacedCount(events.length, wasFinished);
  const shown = events.slice(0, shownCount);
  const catching = shownCount < events.length;
  // `stopped`: the scan cannot be followed (an expired link): never drawn as still working.
  const live = !stopped && (!finished || catching);
  const t0 = events.length ? new Date(events[0].at).getTime() : null;
  const lastAt = shown.length ? new Date(shown[shown.length - 1].at).getTime() : null;
  const elapsed = useElapsed(t0, !finished, lastAt);
  const c = counts(shown);
  const stages = scan?.stages ?? [];
  const doneStages = stages.filter((s) => s.state === "done" || s.state === "skipped").length;
  const current = stages.find((s) => s.state === "running");

  return (
    <section aria-label="The scan, live" className="border border-ops-edge bg-ops-panel/80 p-4 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-signal" : "bg-status-engaged"}`} aria-hidden="true" />
          <p className="font-data text-[11px] uppercase tracking-[0.24em] text-fg">
            {live ? (current ? current.title : "Working") : stopped || scan?.status === "failed" ? "Stopped" : "Finished"}
          </p>
        </div>
        <p className="font-data text-[11px] uppercase tracking-[0.2em] text-fg-dim">
          {scan?.domain ?? ""}
          {t0 !== null ? ` · ${elapsed.toFixed(0)} s · ${shown.length} steps` : ""}
        </p>
      </header>
      <div className="mt-3 flex gap-1" role="progressbar" aria-valuemin={0} aria-valuemax={stages.length || 8} aria-valuenow={doneStages} aria-label="Scan progress">
        {(stages.length ? stages : Array.from({ length: 8 }, (_, i) => ({ key: String(i), title: "", state: "pending" as const }))).map((s) => (
          <span
            key={s.key}
            title={s.title}
            className={`h-1 flex-1 ${s.state === "done" ? "bg-signal" : s.state === "running" ? "animate-pulse bg-signal/50" : s.state === "skipped" ? "bg-ops-edge" : "bg-ops-line"}`}
          />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <AgentConsole events={shown} live={live} t0={t0 ?? 0} />
        <div className="flex min-w-0 flex-col gap-4">
          <SiteViewport events={shown} fallbackUrl={scan?.url ?? ""} live={live} />
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-ops-line bg-ops-line sm:grid-cols-4">
            <Stat label="Pages read" value={String(c.pages)} />
            <Stat label="Checks passed" value={c.checks ? `${c.checksYes}/${c.checks}` : "0"} />
            <Stat label="Findings" value={String(c.findings)} />
            <Stat label="Businesses matched" value={String(c.matched)} />
          </div>
          <CompetitorRadar events={shown} />
        </div>
      </div>
    </section>
  );
}
