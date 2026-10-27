/**
 * lib/os/agent-access-names-session.ts - the session half of
 * lib/os/agent-access-names.ts: the agents the signed-in owner picks from,
 * named as their workspace's AI Team names them.
 *
 * Only the two agent-choice routes import it (app/api/connections/agents and
 * app/api/credentials/custom), so the tool runner's imports stay as they were.
 * A viewer that cannot be resolved gets the department labels: a name is a
 * courtesy, never the rule.
 */

import "server-only";

import { resolveOsViewer } from "@/components/os/department/viewer";
import { AGENT_CHOICES, type AgentChoice } from "@/lib/os/agent-access";
import { namedAgentChoices } from "@/lib/os/agent-access-names";
import { readsInternalAgentNames } from "@/lib/os/agent-names-session";

export async function agentChoicesForSession(): Promise<AgentChoice[]> {
  try {
    const viewer = await resolveOsViewer();
    if (!viewer.ok) return [...AGENT_CHOICES];
    return namedAgentChoices({ oasis: viewer.oasis, manifest: viewer.manifest, internal: readsInternalAgentNames(viewer.surface) });
  } catch (err) {
    console.error("[agent-access] could not name the agents; department labels shown", { error: err instanceof Error ? err.message : String(err) });
    return [...AGENT_CHOICES];
  }
}
