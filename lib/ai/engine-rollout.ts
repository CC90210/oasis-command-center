export type SubscriptionRuntime = "claude" | "codex" | "gemini";

export const CODEX_OASIS_ROLLOUT_MESSAGE =
  "Codex subscription access is currently limited to approved OASIS computers. Choose Claude Code, Pure local, or an API key.";

/**
 * Codex starts on OASIS-owned pairings only. The engine route applies the
 * pairing approval/protocol checks separately, after this workspace gate.
 */
export function subscriptionRolloutError(provider: SubscriptionRuntime, oasisWorkspace: boolean): "codex_oasis_rollout_only" | null {
  return provider === "codex" && !oasisWorkspace ? "codex_oasis_rollout_only" : null;
}
