export type SubscriptionRuntime = "claude" | "codex" | "opencode";

export const CODEX_OASIS_ROLLOUT_MESSAGE =
  "Codex and OpenCode are currently limited to approved OASIS computers. Choose Claude Code, Pure local, or an API key.";

/**
 * Codex and OpenCode start on OASIS-owned pairings only: both can reach more
 * of the computer than Claude Code's --disallowed-tools wall allows, so a
 * client workspace gets them only after they have run on OASIS's own. The
 * engine route applies the pairing approval/protocol checks separately, after
 * this workspace gate. The code keeps its first name: it is on the wire.
 */
export function subscriptionRolloutError(provider: SubscriptionRuntime, oasisWorkspace: boolean): "codex_oasis_rollout_only" | null {
  return (provider === "codex" || provider === "opencode") && !oasisWorkspace ? "codex_oasis_rollout_only" : null;
}
