/**
 * The Coding harness chat's two honesty rules (2026-09-30), pure so a node
 * test can run them; components/ChatWidget.tsx imports both.
 */

/**
 * Only the harness on /agent may read ?agent / ?prompt / ?autosend. The
 * persistent widget stays mounted, hidden, on every other page; reading the
 * URL there made it swallow and strip another page's ?prompt= (a Chief of
 * Staff deep link lost its question).
 */
export function harnessOwnsUrlParams(active: boolean, pathname: string | null | undefined): boolean {
  const p = pathname || "";
  return active && (p === "/agent" || p.startsWith("/agent/"));
}

/**
 * How long the widget waits for its bridge health probe before calling the
 * bridge unreachable. Direct to the operator's own loopback bridge, 1.5 s is
 * plenty. Through /api/bridge/health (proxy mode, which oasisai.work uses) the
 * server first authorizes the session, then gives the bridge 1.5 s of its own
 * (AbortSignal.timeout(1500) there): a 1.5 s client window aborted before the
 * server could answer, so an online bridge read "offline" for the 30 s until
 * the next probe, and the Coding harness told the operator to go get an API
 * key while the header above it said the computer was online.
 */
export function bridgeProbeTimeoutMs(proxyMode: boolean): number {
  return proxyMode ? 6000 : 1500;
}

/**
 * How long the harness waits for its agent settings (/api/agent-config). The
 * read had no limit, so a request that never answered left "loading agent
 * config..." on screen for good (CC, 2026-10-09).
 */
export const CONFIG_READ_TIMEOUT_MS = 15_000;

/** The plain reason that read failed: a timeout is said as one, never left spinning. */
export function agentConfigReadFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError"
    ? `Couldn't read your agent settings: the server didn't answer within ${CONFIG_READ_TIMEOUT_MS / 1000} seconds. Refresh to try again.`
    : "Couldn't read your agent settings: the request didn't reach the server. Check your connection, then refresh.";
}

/**
 * Is a chat turn possible right now, from a real check? The desktop bridge
 * answered, or there is an actual key: this agent's own saved key, or, for
 * the operator, a platform key /api/usage confirmed exists. Being the
 * operator is not a key: "platform default" used to read Ready while
 * /api/usage answered 412 no_api_key.
 */
export function chatReadiness(input: {
  bridgeReady: boolean;
  configsLoaded: boolean;
  hasOwnKey: boolean;
  isAdmin: boolean;
  platformKey: "unknown" | "present" | "absent";
  providerIsLocalOnly: boolean;
}): { ready: boolean; viaPlatformKey: boolean } {
  if (input.bridgeReady) return { ready: true, viaPlatformKey: false };
  if (!input.configsLoaded || input.providerIsLocalOnly) return { ready: false, viaPlatformKey: false };
  if (input.hasOwnKey) return { ready: true, viaPlatformKey: false };
  const viaPlatformKey = input.isAdmin && input.platformKey === "present";
  return { ready: viaPlatformKey, viaPlatformKey };
}
