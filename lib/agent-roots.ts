/**
 * Mirror of bravo_cli/agent_roots.py for dashboard awareness.
 *
 * The dashboard doesn't need to RESOLVE these paths (the bridge does that
 * locally). It just needs to know the canonical layout so it can show the
 * operator which agents would be paired locally if they ran the bridge.
 */

export const AGENT_REPO_HINTS: Record<string, string> = {
  bravo: "~/Business-Empire-Agent",
  atlas: "~/APPS/CFO-Agent",
  maven: "~/CMO-Agent",
  aura: "~/AURA",
  hermes: "~/hermes",
  // SunBiz: the chat targets the `solara`/`helios` personas; both live in the
  // SunBiz repo (~/SunBiz-Agent dev, /srv/sunbiz/sunbiz-agent on the VPS).
  sunbiz: "~/SunBiz-Agent",
  solara: "~/SunBiz-Agent",
  helios: "~/SunBiz-Agent",
};

/** Endpoint the bridge serves chat from. Defaults to the local desktop bridge,
 *  but reads NEXT_PUBLIC_BRIDGE_CHAT_BASE so a hosted deploy (e.g. the SunBiz
 *  VPS bridge behind nginx/TLS) can point every employee's browser at the shared
 *  always-on bridge instead of their own localhost. Mirrors BridgeCliPanel.tsx. */
export const BRIDGE_CHAT_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://127.0.0.1:9100";
