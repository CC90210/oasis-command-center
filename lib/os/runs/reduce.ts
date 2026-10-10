/**
 * lib/os/runs/reduce.ts - a run's events, folded into what the channel shows:
 * the activity trail above the reply, the reply text, the failure, the usage.
 *
 * One reducer for the live view and the replay of a saved run, so a conversation
 * reopened tomorrow reads exactly as it did while it was working.
 *
 * Event data, by kind (lib/os/runs/activity.ts writes them; nothing else does):
 *   agent    { display_name, department?, tools?, runs_on?, spend?, model?, ... }
 *   status   { phase, label }                         what it is doing now
 *   thinking { text }                                 the model's own reasoning, when its provider shows it
 *   tool     { id, phase: start | done, label, ok, detail?, size? }
 *   delta    { text }                                 reply text
 *   usage    { input_tokens, output_tokens }
 *   error    { code, message, model? }
 *   done     { status }
 *
 * PURE.
 */

import type { RunEvent, RunStatus } from "./types";
import { isRunStatus } from "./types";

export type TrailStep =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; label: string; state: "running" | "ok" | "failed"; detail: string | null; size: number | null };

export type RunView = {
  /** The `agent` event's data, as sent. */
  agent: Record<string, unknown> | null;
  /** What it is doing right now ("Thinking it through"); null once finished. */
  activity: string | null;
  steps: TrailStep[];
  text: string;
  error: { code: string; message: string; model: unknown } | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Set by the `done` event. */
  finished: RunStatus | null;
  lastSeq: number;
};

const PAST: ReadonlyArray<readonly [string, string]> = [
  ["Looking up ", "Looked up "],
  ["Checking ", "Checked "],
  ["Reading ", "Read "],
  ["Searching ", "Searched "],
  ["Running ", "Ran "],
  ["Using ", "Used "],
  ["Preparing ", "Prepared "],
];

/** A finished step's words: "Looking up Pipeline" becomes "Looked up Pipeline". Anything else is unchanged. */
export function pastTense(label: string): string {
  for (const [now, then] of PAST) if (label.startsWith(now)) return then + label.slice(now.length);
  return label;
}

export function emptyRunView(): RunView {
  return { agent: null, activity: null, steps: [], text: "", error: null, usage: null, finished: null, lastSeq: 0 };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Fold one event into a view. Pure; an event at or before `lastSeq` is a replay of one already applied and changes nothing. */
export function applyRunEvent(view: RunView, ev: RunEvent): RunView {
  if (ev.seq <= view.lastSeq) return view;
  const next: RunView = { ...view, lastSeq: ev.seq };
  const d = ev.data;
  switch (ev.kind) {
    case "agent":
      next.agent = d;
      break;
    case "status":
      next.activity = str(d.label) || next.activity;
      break;
    case "thinking": {
      const text = str(d.text);
      if (!text) break;
      const last = view.steps[view.steps.length - 1];
      next.steps =
        last && last.kind === "thinking"
          ? [...view.steps.slice(0, -1), { kind: "thinking", text: last.text + text }]
          : [...view.steps, { kind: "thinking", text }];
      break;
    }
    case "tool": {
      const id = str(d.id);
      if (d.phase === "start") {
        const label = str(d.label) || "Working on it";
        next.steps = [...view.steps, { kind: "tool", id, label, state: "running", detail: null, size: null }];
        next.activity = label;
        break;
      }
      const at = view.steps.findIndex((s) => s.kind === "tool" && s.id === id);
      // A producer's result carries only the step's id: the words are the start's.
      const started = at >= 0 ? view.steps[at] : null;
      const label = str(d.label) || (started && started.kind === "tool" ? started.label : "Working on it");
      const done: TrailStep = {
        kind: "tool",
        id,
        label,
        state: d.ok === false ? "failed" : "ok",
        detail: str(d.detail) || null,
        size: numOrNull(d.size),
      };
      next.steps = at >= 0 ? view.steps.map((s, i) => (i === at ? done : s)) : [...view.steps, done];
      break;
    }
    case "delta":
      next.text = view.text + str(d.text);
      break;
    case "usage":
      next.usage = { inputTokens: numOrNull(d.input_tokens) ?? 0, outputTokens: numOrNull(d.output_tokens) ?? 0 };
      break;
    case "error":
      next.error = { code: str(d.code) || "provider_error", message: str(d.message), model: d.model ?? null };
      break;
    case "done":
      next.finished = isRunStatus(d.status) ? d.status : "done";
      next.activity = null;
      break;
  }
  return next;
}

export function reduceRunEvents(events: readonly RunEvent[], from: RunView = emptyRunView()): RunView {
  return events.reduce(applyRunEvent, from);
}
