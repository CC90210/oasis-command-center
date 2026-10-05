import { BRIDGE_CHAT_BASE } from "@/lib/agent-roots";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The operator's OWN bridge, on the machine the dashboard is being viewed from.
 *
 * Exported (2026-09-03) because two surfaces that control local daemons —
 * the worker Start/Stop/Restart buttons and the CLI diagnostics panel — each
 * carried a private copy of `process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE ||
 * "http://localhost:9100"`. That env var is the HOSTED-bridge override for
 * SunBiz employees; it is the wrong signal for "where is the daemon that runs
 * on this operator's PC", and in the deployed bundle it had been inlined as
 * http://localhost:3000 — a dev-server port. Every Restart click POSTed to a
 * port nothing listens on and surfaced as
 * `Unexpected token '<', "<!DOCTYPE"... is not valid JSON`.
 *
 * Loopback is the one address that is always the viewer's own machine.
 * Browsers exempt it from mixed-content blocking, and the bridge allowlists
 * the production origin with `access-control-allow-private-network`.
 */
export const LOCAL_BRIDGE_DEFAULT = "http://127.0.0.1:9100";

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
