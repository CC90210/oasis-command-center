/**
 * lib/os/channel/workspace-key.ts - which saved AI key every channel answers on.
 *
 * MOVED to lib/ai/workspace-account.ts (2026-10-02, AIP-01): a workspace's AI
 * account is its own row (agent_key "__workspace__", user_id IS NULL), with
 * the `bravo` workspace row as the legacy fallback, and every channel reads it
 * through readWorkspaceAiAccount. This file keeps the old export names for
 * callers on older branches.
 */

export {
  WORKSPACE_AI_AGENT_KEY,
  LEGACY_WORKSPACE_AI_AGENT_KEY,
  readWorkspaceAiAccount,
  hasUsableKey,
} from "@/lib/ai/workspace-account";

/**
 * @deprecated The legacy `bravo` row's agent_key. Reading this row alone
 * misses the workspace's AI account; read it with readWorkspaceAiAccount.
 */
export { LEGACY_WORKSPACE_AI_AGENT_KEY as CHANNEL_CONFIG_AGENT_KEY } from "@/lib/ai/workspace-account";
