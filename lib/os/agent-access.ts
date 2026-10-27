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

/**
 * One agent an owner can pick: its department, the words the picker shows for
 * it ("Maven (Marketing)"), and the agent's name alone when the workspace
 * names one ("Maven"), for a short line on a card.
 */
export type AgentChoice = { key: DepartmentKey; label: string; agent?: string };

/**
 * A choice as a card's short line: the agents' names, each once (Bravo leads
 * two of OASIS's departments), or the departments where a workspace names no
 * agent. "All agents" and "No agents" as agentAccessLabel says them.
 */
export function agentNamesLine(access: AgentAccess, choices: ReadonlyArray<AgentChoice> = AGENT_CHOICES): string {
  if (access === "all" || access.length === 0) return agentAccessLabel(access, choices);
  return agentNames(access, choices).join(", ");
}

/** A choice in a sentence: "SDR, Maven and Bravo", "all agents", "no agents". */
export function agentNamesSentence(access: AgentAccess, choices: ReadonlyArray<AgentChoice> = AGENT_CHOICES): string {
  if (access === "all") return "all agents";
  const names = agentNames(access, choices);
  if (names.length === 0) return "no agents";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The agents of a list of departments, by name, each once ("Bravo", "SDR"); a department with no named agent by its label. */
export function agentNames(access: readonly DepartmentKey[], choices: ReadonlyArray<AgentChoice> = AGENT_CHOICES): string[] {
  const words = access.map((k) => {
    const c = choices.find((x) => x.key === k);
    return c?.agent || AGENT_CHOICES.find((x) => x.key === k)?.label || k;
  });
  return [...new Set(words)];
}

/** The event a saved agent choice sends, so every card on the page reads it again. */
export const AGENT_ACCESS_CHANGED_EVENT = "oasis:agent-access-changed";

/**
 * The agents an owner can pick, in the order the rail lists them, labelled by
 * department. A workspace names them (lib/os/agent-access-names.ts
 * namedAgentChoices: "Maven (Marketing)"); this is the label without a name.
 */
export const AGENT_CHOICES: ReadonlyArray<AgentChoice> = OS_DEPARTMENTS.map((d) => ({
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

/**
 * The words a list shows for a choice: "All agents", "No agents", or each
 * agent as the workspace names it ("Maven (Marketing), Atlas (Finance)").
 */
export function agentAccessLabel(access: AgentAccess, choices: ReadonlyArray<AgentChoice> = AGENT_CHOICES): string {
  if (access === "all") return "All agents";
  if (access.length === 0) return "No agents";
  return access.map((k) => choices.find((c) => c.key === k)?.label ?? AGENT_CHOICES.find((c) => c.key === k)?.label ?? k).join(", ");
}

/** Same choice? Order does not matter. */
export function sameAgentAccess(a: AgentAccess, b: AgentAccess): boolean {
  if (a === "all" || b === "all") return a === b;
  return a.length === b.length && a.every((k) => b.includes(k));
}

/**
 * A picked list that names every department is "All agents": an owner who
 * unticks one and ticks it back expects to be where they started, not on a
 * list that quietly leaves out agents with no department.
 */
export function collapseToAll(departments: readonly DepartmentKey[]): AgentAccess {
  const ordered = orderedDepartments(departments);
  return ordered.length === AGENT_CHOICES.length ? "all" : ordered;
}

/**
 * The agent tools that use each app's credentials, by tool name. An app's
 * agent choice decides which agents are offered these tools
 * (lib/cloud-tool-runner.ts); tests/agent-access.test.ts counts the credential
 * reads in the runner to keep this list whole. send_sms texts from the
 * operator's computer, which sends OASIS's texts through Quo (CEO-Agent
 * send_gateway). TextTorrent and Kixie are SunBiz's and have no card.
 */
export const APP_TOOLS: Readonly<Record<string, string>> = {
  send_sms: "quo",
  kixie_call: "kixie",
  kixie_send_sms: "kixie",
  texttorrent_send: "texttorrent",
  texttorrent_blast: "texttorrent",
  texttorrent_inbox_reply: "texttorrent",
  texttorrent_create_list: "texttorrent",
  texttorrent_add_contact: "texttorrent",
  texttorrent_block: "texttorrent",
  texttorrent_unblock: "texttorrent",
};

/** The app a tool uses, or null. Own keys only: a tool named "constructor" is no app's. */
export function appForTool(tool: string): string | null {
  return Object.prototype.hasOwnProperty.call(APP_TOOLS, tool) ? APP_TOOLS[tool] : null;
}

/** What an app's agent tools do, in a few words, for its card; null when no agent tool uses the app. */
const APP_TOOL_WORDS: Readonly<Record<string, string>> = {
  quo: "texting a lead from your computer",
  kixie: "Kixie calls and texts",
  texttorrent: "TextTorrent texts and lists",
};
export function agentToolsOf(slug: string): string | null {
  return Object.prototype.hasOwnProperty.call(APP_TOOL_WORDS, slug) ? APP_TOOL_WORDS[slug] : null;
}

/** Why an agent may not use something, as the code a caller acts on. */
export type RefusalCode = "not_given" | "unreadable" | "read_failed";

/**
 * The sentence an agent (and the person reading its answer) gets when it is
 * refused `subject`: what happened and where an owner fixes it.
 */
export function refusalSentence(code: RefusalCode, subject: string, access: AgentAccess | null, where: string): string {
  if (code === "not_given") return `${subject} is set for ${agentAccessLabel(access ?? [])}. An owner can give this agent access in ${where}.`;
  if (code === "unreadable") return `${subject}'s agent choice could not be read, so no agent may use it until an owner saves it again in ${where}.`;
  return `Could not check which agents may use ${subject} right now. Try again shortly.`;
}
