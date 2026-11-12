"use client";

import { Check, Loader2, Minus } from "lucide-react";
import { SCAN_STAGES, STAGE_TITLES, type ScanView } from "@/lib/site-scan/types";

/** The left rail: one line per stage, ticking as the server reports each one done. */
export function StageRail({ scan }: { scan: ScanView | null }) {
  const stages = scan?.stages ?? SCAN_STAGES.map((key, i) => ({ key, title: STAGE_TITLES[key], state: i === 0 ? ("running" as const) : ("pending" as const) }));
  return (
    <ol className="border border-ops-edge bg-ops-panel/90 p-4" aria-label="Scan progress">
      {stages.map((s) => (
        <li key={s.key} className="flex items-center gap-3 py-2" aria-current={s.state === "running" ? "step" : undefined}>
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
              s.state === "done" ? "border-status-engaged bg-status-engaged/15 text-status-engaged" : s.state === "running" ? "border-signal text-signal" : s.state === "skipped" ? "border-ops-edge text-fg-dim" : "border-ops-edge text-transparent"
            }`}
            aria-hidden="true"
          >
            {s.state === "done" ? <Check className="h-3 w-3" /> : s.state === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : s.state === "skipped" ? <Minus className="h-3 w-3" /> : null}
          </span>
          <span className={`text-[14px] ${s.state === "done" ? "text-fg" : s.state === "running" ? "text-fg" : "text-fg-dim"}`}>
            {s.title}
            {s.state === "skipped" ? <span className="ml-2 font-data text-[10px] uppercase tracking-[0.18em] text-fg-dim">skipped</span> : null}
          </span>
        </li>
      ))}
      {scan ? (
        <li className="mt-2 border-t border-ops-line pt-3 font-data text-[11px] uppercase tracking-[0.2em] text-fg-dim">{scan.domain}</li>
      ) : null}
    </ol>
  );
}
