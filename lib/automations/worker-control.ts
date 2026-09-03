/**
 * Drive the daemon supervisor from the dashboard — the one control path, shared.
 *
 * Extracted from BackgroundWorkersPanel on 2026-08-21 because the Automations
 * tab now has a SECOND surface that starts and stops daemons: a cron row whose
 * work belongs to a supervised process (see lib/automations/daemon-backed-crons.ts)
 * toggles the process, not the row. Two copies of this function would be two
 * places for the injection allowlist and the remote/local decision to drift.
 *
 * Two routes:
 *   - LOCAL (operator's machine): the browser POSTs the bridge's localhost
 *     exec-tool directly, because Vercel cannot reach localhost. It calls the
 *     `fleet_control` tool, NOT `bash` with a pm2 string.
 *
 *     Why (2026-09-02): PM2 stopped being the Windows supervisor on 2026-08-27
 *     — its named pipe returns EPERM there — so every button on this surface
 *     had been silently failing. Worse than failing: a blocked pm2 call SPAWNS
 *     AN ORPHAN GOD DAEMON (23 accumulated that way once; 42 grew to 112 in
 *     forty minutes another time), so each click on a dead button leaked a
 *     process. The supervisor is now scripts/ops/fleet_watchdog.py, and
 *     `fleet_control` validates the action bridge-side and shells nothing.
 *
 *   - REMOTE (SunBiz VPS daemons): through /api/automations/background-workers
 *     /control, which holds the bridge bearer server-side and allowlists the
 *     command. The browser never sees the bearer and can only ask for
 *     `pm2 <action> <allowlisted-name>`. This one stays on pm2 deliberately:
 *     the EPERM above is a Windows named-pipe fault, and the VPS is Linux,
 *     where pm2 is still the live supervisor for the SunBiz fleet.
 *
 * Client-side module: it uses `fetch` and is imported only by client
 * components.
 *
 * The LOCAL path targets LOCAL_BRIDGE_DEFAULT — the viewer's own loopback —
 * and deliberately NOT NEXT_PUBLIC_BRIDGE_CHAT_BASE (2026-09-03). That var is
 * the hosted-VPS override for SunBiz employees, and in the deployed bundle it
 * had been inlined as http://localhost:3000, a dev-server port, so every
 * Restart on the operator's own daemons POSTed to a port nothing listens on
 * and failed with `Unexpected token '<', "<!DOCTYPE"`. The server-side proxy
 * is not an alternative here: resolveBridgeTarget fails closed for a tenant
 * with no bridge_url (correctly — the SunBiz bearer must not be borrowed), and
 * a Cloudflare Worker cannot reach an operator's laptop anyway. Loopback is the
 * only address that is always that machine.
 */

import { LOCAL_BRIDGE_DEFAULT } from "@/lib/bridge-client-routing";

/** Control actions exposed in the UI. */
export type WorkerAction = "start" | "stop" | "restart";

/**
 * `service` is the full `integrations_health` key ("pm2.claude-bridge"). Both
 * control paths want the name without the prefix. The key keeps its historical
 * "pm2." spelling because it is a stored identifier in integrations_health —
 * renaming it would orphan every existing health row.
 */
export async function runWorkerAction(
  service: string,
  action: WorkerAction,
  remoteControl: boolean,
): Promise<{ ok: boolean; output: string }> {
  // Strip "pm2." prefix if present. The allowlist is defense-in-depth on both
  // paths, and the bridge re-validates it — a browser check alone is not a
  // control-plane guarantee.
  const name = service.replace(/^pm2\./, "");
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    return { ok: false, output: "invalid_service_name" };
  }
  try {
    const res = remoteControl
      ? await fetch(`/api/automations/background-workers/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ service, action }),
        })
      : await fetch(`${LOCAL_BRIDGE_DEFAULT}/exec-tool`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tool_name: "fleet_control",
            input: { action, name },
          }),
        });
    // A non-JSON body means we reached something that is not the bridge — a
    // dev server, a login page, an HTML error. Name that, instead of letting
    // JSON.parse report an unexpected '<'.
    const text = await res.text();
    let data: { ok?: boolean; output?: string; is_error?: boolean; error?: string };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return {
        ok: false,
        output: remoteControl
          ? `bridge proxy returned non-JSON (HTTP ${res.status})`
          : `no bridge answered at ${LOCAL_BRIDGE_DEFAULT} (HTTP ${res.status}, non-JSON) — is the local bridge running on this machine?`,
      };
    }
    if (!res.ok || data.ok === false || data.is_error === true) {
      return { ok: false, output: data.error || data.output || `http_${res.status}` };
    }
    return { ok: true, output: data.output || "ok" };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : "network_failure" };
  }
}
