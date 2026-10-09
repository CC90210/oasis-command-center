/**
 * lib/bridge-cli-policy.ts - which AI app on the paired computer a bridge turn
 * may run, and which of its tools are switched off, by the asker's team role.
 *
 * ONE RULE for every caller that forwards a turn to the bridge's /chat: the
 * coding harness proxy (app/api/bridge/chat) and a department turn on a CLI
 * engine (lib/ai/bridge-turn.ts). It used to live inline in the proxy route;
 * a second copy for departments could drift, and the drift would be a way
 * around the no-shell wall.
 *
 *   - Owners and admins: the app they chose, every tool.
 *   - Everyone else: Claude Code, with the role's mutating tools disallowed.
 *     Claude Code is the ONLY app whose --disallowed-tools spawn flag enforces
 *     that wall; Codex and Gemini CLI have no equivalent (Codex audit P1), and
 *     the bridge itself pins a restricted turn to Claude Code too.
 *
 * PURE.
 */
import { bridgeDisallowedToolsForRole } from "@/lib/role-gates";

export const BRIDGE_CLI_PROVIDERS = ["claude", "codex", "gemini"] as const;
export type BridgeCliProvider = (typeof BRIDGE_CLI_PROVIDERS)[number];

export function isBridgeCliProvider(v: unknown): v is BridgeCliProvider {
  return typeof v === "string" && (BRIDGE_CLI_PROVIDERS as readonly string[]).includes(v);
}

export function isPrivilegedBridgeRole(teamRole: string | null | undefined): boolean {
  const r = (teamRole || "").trim().toLowerCase();
  return r === "owner" || r === "admin";
}

export function bridgeCliPolicy(
  teamRole: string | null | undefined,
  requested: BridgeCliProvider,
): { cliProvider: BridgeCliProvider; disallowedTools: string[] } {
  return {
    cliProvider: isPrivilegedBridgeRole(teamRole) ? requested : "claude",
    disallowedTools: bridgeDisallowedToolsForRole(teamRole),
  };
}
