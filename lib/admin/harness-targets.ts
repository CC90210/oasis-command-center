/**
 * The Coding harness's targets (2026-09-30): which repo on the operator's
 * computer a harness turn runs in, named by the departments it serves.
 *
 * The /agent picker used to list the workspace's agent personas (Bravo, Atlas,
 * Maven, Aura, Hermes …), which duplicated the department channels and named
 * internal harnesses. It now lists the three repos the bridge can run Claude
 * Code or Codex in. Everyday questions go to Chief of Staff, not here.
 *
 * `agent` is the key the bridge already understands (lib/agent-roots.ts
 * OASIS_BRIDGE_AGENTS maps it to the repo on the operator's machine).
 * Operator-only surface: the repo names are the operator's own.
 */

export type HarnessTarget = {
  agent: "bravo" | "maven" | "atlas";
  departments: string;
  repo: string;
};

export const HARNESS_TARGETS: readonly HarnessTarget[] = [
  { agent: "bravo", departments: "Chief of Staff & Operations", repo: "Business-Empire-Agent" },
  { agent: "maven", departments: "Marketing", repo: "CMO-Agent" },
  { agent: "atlas", departments: "Finance", repo: "CFO-Agent" },
];

/** Picker labels, keyed by bridge agent: "Marketing · CMO-Agent". */
export function harnessTargetLabels(): Record<string, string> {
  return Object.fromEntries(HARNESS_TARGETS.map((t) => [t.agent, `${t.departments} · ${t.repo}`]));
}
