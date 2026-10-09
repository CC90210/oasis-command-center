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

/**
 * Which harness a DEPARTMENT's turn runs in when OASIS's agents run on the CLI
 * bridge (CC, 2026-10-09: "make sure the agents ... are connected to actual
 * agent harnesses and proper MD files that skill-route them"). The CLI runs in
 * that repo, so its own CLAUDE.md / AGENTS.md and skills route the work.
 * Sales and Client Success have no repo of their own yet: they run in the
 * Chief of Staff's. OASIS's own workspace only (lib/os/department-agent.ts).
 */
const DEPARTMENT_HARNESS: Record<string, HarnessTarget["agent"]> = {
  chief_of_staff: "bravo",
  sales: "bravo",
  client_success: "bravo",
  operations: "bravo",
  marketing: "maven",
  finance: "atlas",
};

/** The harness a department's turn runs in, or null for a department with none. */
export function harnessForDepartment(departmentKey: string): HarnessTarget | null {
  const agent = DEPARTMENT_HARNESS[departmentKey];
  return HARNESS_TARGETS.find((t) => t.agent === agent) ?? null;
}

/** Picker labels, keyed by bridge agent: "Marketing · CMO-Agent". */
export function harnessTargetLabels(): Record<string, string> {
  return Object.fromEntries(HARNESS_TARGETS.map((t) => [t.agent, `${t.departments} · ${t.repo}`]));
}
