/**
 * lib/os/runs/engine-label.ts - which app a run on a person's own computer runs on, in its own name.
 *
 * A message sent to a paired computer is queued with the exact engine that was tested and saved for it
 * (runtime_engine_kind + runtime_engine_name, lib/os/runs/store.ts); the computer that claims it runs
 * that engine and no other (lib/os/runs/computer-turn.ts computerRuntime). The chat says the same name
 * while the run is going: "Codex", never a fixed "Claude Code" for every computer run (CC, 2026-10-15:
 * with Codex connected, the chief of staff's channel said Claude Code).
 *
 * PURE. Shared by the server (the run head every chat frame carries) and its tests.
 */
import { CLI_ENGINE_LABEL, isCliEngine } from "@/lib/ai/agent-engine";
import type { RunExecutor } from "./types";

export type RunEngineFacts = {
  executor: RunExecutor | null;
  runtimeEngineKind: "api" | "cli" | "local" | null;
  runtimeEngineName: string | null;
  targetPairingId: string | null;
};

/**
 * The app a computer run runs on ("Codex", "Claude Code", "llama3 (local model)"), or null when the run
 * is not on a computer (a reply on the workspace's AI account names its model itself) or the saved
 * engine is not one this build knows (never a guess).
 */
export function runEngineLabel(run: RunEngineFacts): string | null {
  if (run.executor !== "computer") return null;
  const name = run.runtimeEngineName?.trim() || null;
  if (run.runtimeEngineKind === "cli") return isCliEngine(name) ? CLI_ENGINE_LABEL[name] : null;
  if (run.runtimeEngineKind === "local") return name ? `${name.replace(/^(?:ollama|lmstudio)\//, "")} (local model)` : null;
  // No snapshot at all is the first computer contract (department_task_v1), which only ever runs Claude Code.
  if (run.runtimeEngineKind === null && name === null && !run.targetPairingId?.trim()) return CLI_ENGINE_LABEL.claude;
  return null;
}
