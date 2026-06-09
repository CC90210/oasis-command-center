/**
 * Canonical "is the bridge functionally available?" check.
 *
 * Two independent signals feed it:
 *
 *   - bridgeOnline (boolean | null) — client-side probe result. The
 *     ChatWidget periodically GETs /api/bridge/health (proxy mode) or
 *     http://127.0.0.1:9100/health (operator localhost). Set to true on
 *     200, false on non-200 / network error, null while inflight.
 *
 *   - serverBridgeOnline (boolean | undefined) — server-rendered prop
 *     from getBridgeOnline(tenant_id), which reads
 *     bridge_pairings.last_seen_at and compares to a 5-minute window.
 *     This is updated server-side every time the VPS daemon POSTs
 *     /api/bridge/ping (outbound from VPS — works through any firewall
 *     that lets the daemon reach the dashboard).
 *
 * Either signal being true is sufficient evidence the daemon is alive
 * and can service requests. We trust both independently because:
 *
 *   - serverBridgeOnline catches the case where the Vercel→VPS proxy
 *     (BRIDGE_VPS_URL / BRIDGE_BEARER_TOKEN) is misconfigured but the
 *     daemon is heartbeating outbound just fine. Without this, an
 *     encryption-key rotation that clears the bridge env vars silently
 *     disables every employee's chat dropdown — even though the bridge
 *     itself is working.
 *
 *   - bridgeOnline catches the case where the daemon JUST stopped
 *     heartbeating (within the 5-minute stale window) but the proxy
 *     still resolves /health → 200. Rare in practice; here for
 *     completeness.
 *
 * Both false → daemon genuinely down. Block CLI options.
 *
 * History:
 *   2026-06-08 — introduced as the proxyMode-gated check. Required
 *     isProxyModeRuntime() AND serverBridgeOnline.
 *   2026-06-09 — simplified to either-signal-trust after Vercel logs
 *     revealed the proxy was 503'ing on every probe while the daemon
 *     was pinging every 30s. The old gate disabled the dropdown for
 *     every SunBiz employee even though the bridge was usable.
 *
 * isProxyModeRuntime() is still used at URL-builder sites (probe,
 * prewarm, chat-reset, chat, exec-tool) to pick between proxy and
 * direct URLs. That's a separate concern from "is the daemon up?"
 */
export function computeEffectiveBridgeOnline(
  bridgeOnline: boolean | null,
  serverBridgeOnline: boolean | undefined,
): boolean {
  return bridgeOnline === true || serverBridgeOnline === true;
}
