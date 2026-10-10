"use client";

import { AlertCircle, Check, ChevronRight, Loader2 } from "lucide-react";
import { pastTense, type RunView, type TrailStep } from "@/lib/os/runs/reduce";

/** "1,200 characters" is noise; "1.2k characters" is how big the answer to a lookup was. */
export function formatSize(chars: number): string {
  return chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(1)}k characters`;
}

/** The one line that stands for a finished trail: what it looked up, in order, without repeats. */
export function trailSummary(steps: readonly TrailStep[]): string {
  const labels: string[] = [];
  for (const s of steps) {
    if (s.kind !== "tool") continue;
    const w = pastTense(s.label);
    if (!labels.includes(w)) labels.push(w);
  }
  const looked = labels.length ? labels.join(", ") : "Thought it through";
  return looked.length > 90 ? `${looked.slice(0, 89)}...` : looked;
}

function Step({ step, running }: { step: TrailStep; running: boolean }) {
  if (step.kind === "thinking") {
    return (
      <li className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-fg-muted">Thinking</span>
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bg-deep/40 px-3 py-2 text-[12px] leading-relaxed text-fg-dim">
          {step.text}
        </p>
      </li>
    );
  }
  const live = step.state === "running" && running;
  return (
    <li className="flex items-start gap-2 text-[12px] leading-snug">
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
        {live ? (
          <Loader2 className="h-3 w-3 animate-spin text-accent" />
        ) : step.state === "failed" ? (
          <AlertCircle className="h-3 w-3 text-status-hot" />
        ) : (
          <Check className="h-3 w-3 text-status-engaged" />
        )}
      </span>
      <span className="min-w-0 text-fg-muted">
        {step.state === "running" ? step.label : pastTense(step.label)}
        {step.state === "failed" && <span className="text-status-hot"> (did not work)</span>}
        {step.detail && <span className="text-fg-dim"> - {step.detail}</span>}
        {step.size !== null && <span className="text-fg-dim tabular-nums"> ({formatSize(step.size)})</span>}
      </span>
    </li>
  );
}

/**
 * What the department is doing, above its reply: each lookup under its plain
 * label with how much came back, and the model's reasoning for the people who
 * may see it. Open while it works; folded to one line once the reply is
 * written, and a click opens it again.
 */
export function ActivityTrail({ view, running }: { view: RunView; running: boolean }) {
  const { steps, activity } = view;
  if (steps.length === 0 && !running) return null;
  const header = running ? (
    <span className="flex items-center gap-2">
      <Loader2 className="h-3 w-3 animate-spin text-accent" aria-hidden />
      <span aria-live="polite">{activity ?? "Thinking it through"}</span>
    </span>
  ) : (
    <span className="flex items-center gap-1.5">
      <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden />
      <span>{trailSummary(steps)}</span>
    </span>
  );
  if (steps.length === 0) {
    return <div className="px-1 text-[12px] text-fg-dim">{header}</div>;
  }
  return (
    <details open={running} className="group max-w-[min(42rem,88%)] px-1" data-testid="activity-trail">
      <summary className="cursor-pointer list-none text-[12px] text-fg-dim hover:text-fg-muted [&::-webkit-details-marker]:hidden">
        {header}
      </summary>
      <ol className="mt-2 flex flex-col gap-2 border-l border-hairline pl-3">
        {steps.map((s, i) => (
          <Step key={s.kind === "tool" ? `${s.id}-${i}` : `think-${i}`} step={s} running={running} />
        ))}
      </ol>
    </details>
  );
}
