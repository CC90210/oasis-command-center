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
