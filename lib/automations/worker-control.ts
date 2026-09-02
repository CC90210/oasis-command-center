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
 * Client-side module: it uses `fetch` and a NEXT_PUBLIC_ env var, and is
 * imported only by client components.
 */

const BRIDGE_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://localhost:9100";

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
      : await fetch(`${BRIDGE_BASE}/exec-tool`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tool_name: "fleet_control",
            input: { action, name },
          }),
        });
    const data = (await res.json()) as { ok?: boolean; output?: string; is_error?: boolean; error?: string };
    if (!res.ok || data.ok === false || data.is_error === true) {
      return { ok: false, output: data.error || data.output || `http_${res.status}` };
    }
    return { ok: true, output: data.output || "ok" };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : "network_failure" };
  }
}
