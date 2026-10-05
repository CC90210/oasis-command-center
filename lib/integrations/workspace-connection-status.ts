export type WorkspaceConnectionState =
  | "connected"
  | "configured"
  | "attention"
  | "not_configured"
  | "unavailable";

export const WORKSPACE_HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function isWorkspaceHeartbeatFresh(
  checkedAt: string | null,
  nowMs = Date.now(),
): boolean {
  if (!checkedAt) return false;
  const checkedAtMs = Date.parse(checkedAt);
  return Number.isFinite(checkedAtMs) &&
    checkedAtMs <= nowMs &&
    nowMs - checkedAtMs <= WORKSPACE_HEALTH_MAX_AGE_MS;
}

/**
 * Merge two independent truths without inventing a negative:
 * credential presence says the service is configured, while a heartbeat can
 * prove it connected or explicitly failing. Unknown status values fail closed.
 */
export function classifyWorkspaceConnection(input: {
  lookupAvailable: boolean;
  configured: boolean;
  healthStatus: string | null;
  healthFresh: boolean;
}): WorkspaceConnectionState {
  if (!input.lookupAvailable) return "unavailable";
  if (input.healthFresh && (input.healthStatus === "down" || input.healthStatus === "degraded")) {
    return "attention";
  }
  if (input.healthFresh && input.healthStatus === "healthy") return "connected";
  if (input.healthFresh && input.healthStatus && input.healthStatus !== "unconfigured") {
    return "unavailable";
  }
  if (input.configured) return "configured";
  return "not_configured";
}
