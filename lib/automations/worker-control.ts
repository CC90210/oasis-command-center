/**
 * Drive the daemon supervisor from the dashboard — the one control path, shared.
 *
 * Extracted from BackgroundWorkersPanel on 2026-08-21 because the Automations
 * tab has a SECOND surface that starts and stops daemons: a cron row whose
 * work belongs to a supervised process (see lib/automations/daemon-backed-crons.ts)
 * toggles the process, not the row. Two copies of this function would be two
 * places for the allowlist and the error wording to drift.
 *
 * ONE ROUTE (2026-09-30): every action goes to
 * POST /api/automations/background-workers/control, which holds the bridge
 * bearer server-side and allowlists the worker. The OASIS path used to POST the
 * operator's loopback bridge's /exec-tool straight from the browser. Since
 * the bridge bearer went on (BEA 38139ede, 2026-09-29) the bridge answers 401 to
 * any request without the token, loopback included, and the token must never
 * reach a browser, so that path could only ever fail. The server reaches the
 * operator's machine through the tenant's bridge target and calls the bridge's
 * `fleet_control` tool, which validates the action and shells nothing.
 *
 * Client-side module: it uses `fetch` and is imported only by client
 * components.
 */

/** Control actions exposed in the UI. */
export type WorkerAction = "start" | "stop" | "restart";

export const WORKER_CONTROL_ROUTE = "/api/automations/background-workers/control";

/**
 * What a failed control call says, in words. A 401 from the bridge is the
 * token, never "offline": the bridge is up and refusing us.
 */
export function describeControlError(error: string | undefined, status: number): string {
  switch (error) {
    case "bridge_refused_token":
      return "the bridge refused the request (token)";
    case "bridge_unreachable":
      return "the Command Center couldn't reach your computer's bridge";
    case "bridge_not_configured":
      return "no bridge address or token is set for this workspace";
    case "unauthenticated":
      return "you're signed out; sign in and try again";
    case "not_found":
      return "this workspace can't control that worker";
    case "unknown_worker":
      return "that worker isn't on the allowed list";
    case "invalid_action":
      return "that action isn't allowed";
    case undefined:
    case "":
      return `the control request failed (HTTP ${status})`;
    default:
      return error;
  }
}

/**
 * `service` is the full `integrations_health` key ("pm2.claude-bridge"). The
 * key keeps its historical "pm2." spelling because it is a stored identifier in
 * integrations_health — renaming it would orphan every existing health row.
 */
export async function runWorkerAction(
  service: string,
  action: WorkerAction,
): Promise<{ ok: boolean; output: string }> {
  // The server allowlists the name and the bridge re-validates it; this only
  // refuses an obviously malformed one before a round trip.
  const name = service.replace(/^pm2\./, "");
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    return { ok: false, output: "invalid_service_name" };
  }
  try {
    const res = await fetch(WORKER_CONTROL_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service, action }),
    });
    const text = await res.text();
    let data: { ok?: boolean; output?: string; is_error?: boolean; error?: string };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return { ok: false, output: `the control route returned something that isn't JSON (HTTP ${res.status})` };
    }
    if (!res.ok || data.ok === false || data.is_error === true) {
      return { ok: false, output: describeControlError(data.error, res.status) };
    }
    return { ok: true, output: data.output || "ok" };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : "network_failure" };
  }
}
