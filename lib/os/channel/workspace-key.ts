/**
 * lib/os/channel/workspace-key.ts — which saved AI key every channel answers on.
 *
 * A channel (a department channel, or a direct agent chat under /t/<slug>)
 * answers on ONE row of agent_model_config: this workspace's row for
 * CHANNEL_CONFIG_AGENT_KEY with user_id IS NULL. A teammate's personal row, or
 * another agent's row, is never used by a channel.
 *
 * Three places read that row and must read the SAME one:
 *   - app/api/agents/chat/route.ts (the channel itself);
 *   - components/os/department/channel.ts (is the channel ready?);
 *   - app/api/agent-config/test-connection/route.ts ("Test" on a saved key),
 * so the key they name lives here once.
 *
 * PURE: no imports.
 */

/** The agent_model_config.agent_key of the workspace row channels answer on. */
export const CHANNEL_CONFIG_AGENT_KEY = "bravo";
