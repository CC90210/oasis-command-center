/**
 * lib/os/agent-access.ts - which agents may use a custom credential or an app.
 *
 * CC, 2026-10-26: "when setting up a custom credential ... we need to be able
 * to select a specific agent that that credential is going to be used by ...
 * that type of logic needs to be applied for the connectors", and the built-in
 * apps should come "pre-organized and agent selected because we have a lot of
 * knowledge and context on this".
 *
 * An agent here is one of the six departments (lib/os/departments.ts). A chat
 * agent reaches its department through AGENT_HOME_DEPARTMENT
 * (lib/os/approvals/rules.ts): bravo is the Chief of Staff, sdr is Sales, maven
 * is Marketing, customer-support is Client Success, atlas is Finance.
 *
 * DEFAULTS, when the owner has saved nothing:
 *   - a custom credential is for every agent, as it was before this existed;
 *   - an app is for the departments its catalog entry names (the "Used by"
 *     list in lib/os/connectors.ts) plus the Chief of Staff, which runs the
 *     whole business and is the agent the owner asks most. An owner who wants
 *     an app kept from it unticks it.
 *   - a service with no card (TextTorrent, Kixie) is for every agent.
 *
 * This file is pure and safe in the browser: the picker uses it to draw the
 * same defaults the server enforces. Reading and saving the owner's choices is
 * lib/os/agent-access-store.ts; enforcement is in lib/cloud-tool-runner.ts.
 */

import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";

/** Every agent, including one with no department; or exactly these departments (possibly none). */
export type AgentAccess = "all" | readonly DepartmentKey[];

/** What an access choice is about. */
export type AccessTarget = { kind: "custom"; key: string } | { kind: "connector"; slug: string };

/** The agents an owner can pick, in the order the rail lists them. */
export const AGENT_CHOICES: ReadonlyArray<{ key: DepartmentKey; label: string }> = OS_DEPARTMENTS.map((d) => ({
  key: d.key,
  label: d.label,
}));

const DEPARTMENT_KEYS: ReadonlySet<string> = new Set(OS_DEPARTMENTS.map((d) => d.key));

/** Department keys in rail order, unknown ones dropped, each once. */
export function orderedDepartments(keys: Iterable<string>): DepartmentKey[] {
  const want = new Set([...keys].filter((k) => DEPARTMENT_KEYS.has(k)));
  return AGENT_CHOICES.map((c) => c.key).filter((k) => want.has(k));
}

/**
 * An access choice from a request body or a stored row: "all", or a list of
 * department keys. Anything else is null, so a caller can refuse it rather than
 * guess. Unknown department names are refused, not dropped: a typo must not
 * quietly narrow who may use a key.
 */
export function normalizeAgentAccess(input: unknown): AgentAccess | null {
  if (input === "all") return "all";
  if (!Array.isArray(input)) return null;
  if (!input.every((k) => typeof k === "string" && DEPARTMENT_KEYS.has(k))) return null;
  return orderedDepartments(input as string[]);
}

/** A stored row's text as an access choice; null when it is absent or unreadable. */
export function parseAgentAccess(raw: string | null | undefined): AgentAccess | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === "all") return "all";
  try {
    return normalizeAgentAccess(JSON.parse(text));
  } catch {
    return null;
  }
}

export function serializeAgentAccess(access: AgentAccess): string {
  return access === "all" ? "all" : JSON.stringify([...access]);
}

/** A custom credential with nothing saved is for every agent. */
export const CUSTOM_DEFAULT_ACCESS: AgentAccess = "all";

/** An app's suggested agents: its catalog departments plus the Chief of Staff. */
export function connectorDefaultAccess(def: { departments: readonly DepartmentKey[] } | null | undefined): AgentAccess {
  if (!def) return "all";
  return orderedDepartments(["chief_of_staff", ...def.departments]);
}

/** True when `access` lets an agent of `department` (null: an agent with none) use the thing. */
export function accessAllows(access: AgentAccess, department: DepartmentKey | null): boolean {
  if (access === "all") return true;
  return department !== null && access.includes(department);
}

/** The words a list shows for a choice: "All agents", "No agents", or the departments. */
export function agentAccessLabel(access: AgentAccess): string {
  if (access === "all") return "All agents";
  if (access.length === 0) return "No agents";
  return access.map((k) => AGENT_CHOICES.find((c) => c.key === k)?.label ?? k).join(", ");
}

/** Same choice? Order does not matter. */
export function sameAgentAccess(a: AgentAccess, b: AgentAccess): boolean {
  if (a === "all" || b === "all") return a === b;
  return a.length === b.length && a.every((k) => b.includes(k));
}
