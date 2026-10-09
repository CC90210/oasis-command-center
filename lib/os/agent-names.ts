/**
 * lib/os/agent-names.ts - what a person sees an OASIS agent called. The ONE
 * rule; a page asks it instead of choosing a name itself.
 *
 * WHY. OASIS runs on house agents with personal names (lib/agents.ts
 * AGENT_REGISTRY: Bravo, Atlas, Maven, Aura, Hermes, Solara, Helios, Lumen,
 * Lex). Those names are OASIS's own. CC (2026-10-01): clients see departments,
 * "listed on the navigational bar as marketing or finance, and then that agent
 * works in the back end". The OS pages already speak in departments (the
 * department tabs, the AI Team, Settings > AI brain, the Feed). The older pages
 * each picked a name for themselves (a registry label, an agent-library name,
 * copy written for the founders) and showed it to whoever opened them. The
 * signed-in crawl of 2026-10-02 counted 62 such names in front of a client
 * owner or a sales rep; the crawl of main on 2026-10-08 still found 50.
 *
 * THE RULE
 *   - Internal names are for OASIS's founders: a founder persona (CC, Adon, an
 *     owner-granted admin) standing in an OASIS workspace, known by its slug AND
 *     its tenant id (the Playbook's rule, lib/playbook-access.ts). The verified
 *     operator is one of them. A client of any role never is, and neither is
 *     any other OASIS seat (a rep, a manager, marketing, a builder, a member).
 *     lib/os/agent-names-session.ts readsInternalAgentNames decides it; every
 *     function here takes its answer as `internal`.
 *   - Everyone else reads a house agent as the department that answers for it
 *     (lib/os/chat-href.ts departmentForAgent: Bravo -> Chief of Staff, Atlas ->
 *     Finance, Maven -> Marketing, Hermes -> Operations ...), in a label and in
 *     copy OASIS wrote for its founders (a quick action, a playbook document).
 *   - The agent library (the marketplace and its agent pages) offers a house
 *     agent to the founders only. A client never runs one (decision 21,
 *     components/os/department/config.ts workspaceBindings), so a card for one
 *     would be a button that does nothing, whatever it was called.
 * A workspace's own teammates and the neutral library templates keep their
 * names: those are the workspace's words. Data a workspace wrote (a lead called
 * "Atlas Roofing") is never rewritten, and is not read here.
 *
 * LOWER CASE IS NOT A NAME. In copy, "Bravo" is a name and "bravo" is a slug or
 * a path ("--to bravo", ".bravo/profiles"); rewriting the second would break
 * the command it sits in. Copy that carries slugs like that is founders-only
 * instead (the prompts library and the client-deploy runbook,
 * lib/playbook-access.ts requirePlaybookFounder).
 *
 * PURE and light: no session, no database, and only the agent registry, the
 * department list and the persona pattern, so a client component (the manifest
 * editor) can name its agents with it. Who is looking is the session half,
 * lib/os/agent-names-session.ts.
 */

import { AGENT_REGISTRY, resolveAgentKey } from "@/lib/agents";
import { departmentForAgent, departmentLabel, type AskDepartmentSlug } from "@/lib/os/chat-href";
import { namesPersona } from "@/lib/os/channel/identity";

/**
 * Every house agent's slug and display name, lowercased, to its registry key
 * ("lumen" -> "life-preservation"). Codex is left out: it is the executor
 * behind custom agents, not a persona (lib/os/channel/identity.ts does the same).
 */
const HOUSE_AGENT_BY_WORD: ReadonlyMap<string, string> = new Map(
  Object.values(AGENT_REGISTRY)
    .filter((a) => a.key !== "codex")
    .flatMap((a): Array<[string, string]> => [
      [a.key.toLowerCase(), a.key],
      [a.label.toLowerCase(), a.key],
    ]),
);

/** The registry key of a house agent named by its slug, a legacy alias or its name; null for anything else. */
function houseAgentKey(word: string | null | undefined): string | null {
  const w = (word || "").trim().toLowerCase();
  if (!w) return null;
  return HOUSE_AGENT_BY_WORD.get(w) ?? HOUSE_AGENT_BY_WORD.get(resolveAgentKey(w)) ?? null;
}

/** The department that answers for a house agent ("chief-of-staff" for bravo), or null when it is not one. */
export function houseAgentDepartmentSlug(nameOrSlug: string | null | undefined): AskDepartmentSlug | null {
  const key = houseAgentKey(nameOrSlug);
  return key ? departmentForAgent(key) : null;
}

/** That department's label ("Chief of Staff"), or null when `nameOrSlug` is not a house agent. */
export function houseAgentDepartment(nameOrSlug: string | null | undefined): string | null {
  const dept = houseAgentDepartmentSlug(nameOrSlug);
  return dept ? departmentLabel(dept) : null;
}

/**
 * The name a viewer sees for an agent whose own name (a library name, or the
 * workspace binding's display_name) is `name`. A founder reads it as written. A
 * house agent read by anyone else keeps the workspace's name for it when that
 * name is not a persona (OASIS's seed names bravo after the departments it
 * leads); otherwise it is the department that answers for it ("Bravo" ->
 * "Chief of Staff"). Any other agent keeps its own name.
 */
export function agentNameFor(agent: { slug: string; name?: string | null }, internal: boolean): string {
  const name = (agent.name || "").trim();
  const department = houseAgentDepartment(agent.slug);
  if (internal || department === null) return name || agent.slug;
  return name && !namesPersona(name) ? name : department;
}

const escapeForRegex = (w: string) => w.replace(/[.*+?^${}()|[\]\\-]/g, (c) => `\\${c}`);
const NAME_IN_COPY = new RegExp(`\\b(${[...HOUSE_AGENT_BY_WORD.keys()].map(escapeForRegex).join("|")})\\b`, "gi");

/**
 * Copy OASIS wrote for its founders, as `internal` may read it: for anyone but
 * a founder, each house agent written as a name ("Atlas", "MAVEN") becomes the
 * department that answers for it ("no revenue figures (that's Finance)"). A
 * lower-case slug is left alone (see LOWER CASE IS NOT A NAME above).
 */
export function agentTextFor(text: string, internal: boolean): string {
  if (internal || !text) return text;
  return text.replace(NAME_IN_COPY, (word) => (word === word.toLowerCase() ? word : houseAgentDepartment(word) ?? word));
}

/** Whether the agent library (the marketplace and its agent pages) offers `slug` to this viewer. */
export function libraryOffersAgent(slug: string, internal: boolean): boolean {
  return internal || houseAgentKey(slug) === null;
}
