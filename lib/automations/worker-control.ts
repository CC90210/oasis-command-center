/**
 * Drive pm2 from the dashboard — the one control path, shared.
 *
 * Extracted from BackgroundWorkersPanel on 2026-08-21 because the Automations
 * tab now has a SECOND surface that starts and stops daemons: a cron row whose
 * work belongs to a PM2 process (see lib/automations/daemon-backed-crons.ts)
 * toggles the process, not the row. Two copies of this function would be two
 * places for the injection allowlist and the remote/local decision to drift.
 *
 * Two routes, unchanged from the panel's original:
 *   - LOCAL (operator's machine): the browser POSTs the bridge's localhost
 *     exec-tool directly, because Vercel cannot reach localhost.
 *   - REMOTE (SunBiz VPS daemons): through /api/automations/background-workers
 *     /control, which holds the bridge bearer server-side and allowlists the
 *     command. The browser never sees the bearer and can only ask for
 *     `pm2 <action> <allowlisted-name>`.
 *
 * Client-side module: it uses `fetch` and a NEXT_PUBLIC_ env var, and is
 * imported only by client components.
 */

const BRIDGE_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://localhost:9100";

/** pm2 control actions exposed in the UI. */
export type WorkerAction = "start" | "stop" | "restart";

/**
 * `service` is the full `integrations_health` key ("pm2.claude-bridge"). The
 * pm2 CLI wants the name without the prefix.
 */
export async function runWorkerAction(
  service: string,
  action: WorkerAction,
  remoteControl: boolean,
): Promise<{ ok: boolean; output: string }> {
  // Strip "pm2." prefix if present; defense-in-depth allowlist of allowed
  // characters keeps the bash injection surface to literal pm2 names.
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
            tool_name: "bash",
            input: { command: `pm2 ${action} ${name}` },
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
