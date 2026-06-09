import { deriveDropdownState, isDropdownEnabled } from "./bridge-dropdown-state";

/**
 * Canonical "is the bridge functionally available?" check.
 *
 * Used by 5 call sites in ChatWidget (send gate, bridgeReady ground-truth,
 * prewarm gate, chat-reset gate, plus the dropdown enable-state).
 *
 * Implementation: thin wrapper over deriveDropdownState + isDropdownEnabled.
 * Keeping these unified means the "online OR degraded → usable" rule lives
 * in exactly one place — a future tighten on one helper can't silently let
 * the other drift. (The previous parallel definitions were
 * mathematically equivalent but defined independently — a future
 * tighten on one could break the other silently.)
 *
 * isProxyModeRuntime() is still used at URL-builder sites (probe,
 * prewarm, chat-reset, chat, exec-tool) to pick between proxy and
 * direct URLs. That's a separate concern from "is the daemon up?"
 */
export function computeEffectiveBridgeOnline(
  bridgeOnline: boolean | null,
  serverBridgeOnline: boolean | undefined,
): boolean {
  return isDropdownEnabled(deriveDropdownState(bridgeOnline, serverBridgeOnline));
}
