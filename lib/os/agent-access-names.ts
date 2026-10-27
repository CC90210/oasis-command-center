/**
 * lib/os/agent-access-names.ts - the agents an owner picks from, by name.
 *
 * CC, 2026-10-26: a credential or an app is connected to a specific AI. The
 * harness maps every department to a named agent (OASIS: Bravo leads Chief of
 * Staff and Operations, SDR leads Sales, Maven Marketing, Customer Support
 * Client Success, Atlas Finance), so the picker shows "Maven (Marketing)"
 * rather than "Marketing" alone.
 *
 * Named the way the workspace's AI Team names its leads: the lead is
 * departmentLead (components/os/department/config.ts: the workspace's manifest,
 * or OASIS's own leads), and its name goes through agentNameFor
 * (lib/os/agent-names.ts), so a house agent's personal name reaches OASIS's
 * founders only and everyone else reads the department. A department with no
 * lead in the workspace keeps its department label.
 *
 * Pure: the session half is agentChoicesForSession in
 * lib/os/agent-access-names-session.ts. The access rules themselves stay department
 * based (lib/os/agent-access.ts); this only names them.
 */

import { departmentLead, type DepartmentScope } from "@/components/os/department/config";
import { getSeedAgent } from "@/lib/agents/library";
import { AGENT_CHOICES, type AgentChoice } from "@/lib/os/agent-access";
import { agentNameFor } from "@/lib/os/agent-names";

export function namedAgentChoices(scope: DepartmentScope & { internal: boolean }): AgentChoice[] {
  return AGENT_CHOICES.map(({ key, label }) => {
    const lead = departmentLead(key, scope);
    if (!lead) return { key, label };
    const name = agentNameFor(
      { slug: lead.slug, name: lead.binding?.display_name ?? getSeedAgent(lead.slug)?.name ?? null },
      scope.internal,
    ).trim();
    // A name that is the department itself (a client reading a house agent) adds nothing.
    return name && name.toLowerCase() !== label.toLowerCase() ? { key, label: `${name} (${label})`, agent: name } : { key, label };
  });
}
