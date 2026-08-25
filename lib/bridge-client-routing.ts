import { BRIDGE_CHAT_BASE } from "@/lib/agent-roots";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_BRIDGE_DEFAULT = "http://127.0.0.1:9100";

/** Pure hostname rule used by tests and the browser runtime wrapper below. */
export function bridgeProxyModeForHostname(hostname: string): boolean {
  return !LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

/**
 * Hosted dashboards must use the authenticated same-origin bridge proxy;
 * only a dashboard loaded on loopback may call the local daemon directly.
 */
export function isProxyModeRuntime(): boolean {
  if (typeof window !== "undefined") {
    return bridgeProxyModeForHostname(window.location.hostname);
  }
  return BRIDGE_CHAT_BASE !== LOCAL_BRIDGE_DEFAULT;
}

export function bridgeClientUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return isProxyModeRuntime()
    ? `/api/bridge/${cleanPath}`
    : `${BRIDGE_CHAT_BASE.replace(/\/+$/, "")}/${cleanPath}`;
}
