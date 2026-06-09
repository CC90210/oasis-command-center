/**
 * Canonical dropdown-state derivation for the chat picker.
 *
 * Inputs:
 *   - bridgeOnline:        client probe result (true / false / null=inflight)
 *   - serverBridgeOnline:  server-rendered prop from getBridgeOnline() —
 *                          bridge_pairings.last_seen_at < 5min
 *
 * Outputs one of four states:
 *   - "online"    bridge fully reachable; CLI options enabled, no suffix
 *   - "degraded"  daemon heartbeating outbound (DB fresh) but client probe
 *                 failed. CLI options ENABLED (tool calls may still succeed
 *                 if the proxy intermittent fails). Suffix names the state.
 *   - "checking"  probe inflight, no decision yet. CLI options disabled.
 *   - "offline"   daemon genuinely down. CLI options disabled.
 *
 * Why a derived enum instead of inline ternaries: the previous form was
 * a 4-deep nested ternary tracking 2 dimensions simultaneously (enabled vs
 * disabled, plus the suffix label). A future tighten or A/B test would have
 * to re-derive the same state machine inline. Extracted so the rules are
 * one-named-thing and testable.
 *
 * Sibling lib/bridge-effective-online.ts answers "is the bridge usable?"
 * (boolean). This file answers "what suffix + tooltip should the dropdown
 * render?" (state). Both consume the same two signals; that's intentional —
 * a single source of truth would have to encode "checking" as a special
 * boolean which is uglier than two specialized helpers.
 */
export type DropdownState = "online" | "degraded" | "checking" | "offline";

export function deriveDropdownState(
  bridgeOnline: boolean | null,
  serverBridgeOnline: boolean | undefined,
): DropdownState {
  if (bridgeOnline === true) return "online";
  if (serverBridgeOnline === true) return "degraded";
  if (bridgeOnline === null) return "checking";
  return "offline";
}

export const DROPDOWN_SUFFIX: Record<DropdownState, string> = {
  online: "",
  degraded: " (daemon online · proxy degraded)",
  checking: " (checking…)",
  offline: " (bridge offline)",
};

/**
 * Whether the dropdown option should be enabled (clickable). Online +
 * degraded both allow click — degraded because the tool call might still
 * succeed (intermittent proxy issue) and even when it doesn't, the user
 * gets a clear error that names the fix instead of a silently-disabled UI.
 */
export function isDropdownEnabled(state: DropdownState): boolean {
  return state === "online" || state === "degraded";
}
