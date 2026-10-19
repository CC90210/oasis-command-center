/**
 * lib/integrations/presence-heartbeat.ts - which integrations_health rows are
 * only "a key is on file", never "the service answered".
 *
 * OASIS's computer (the paired bridge) reports a "healthy" row every minute for
 * every service whose key NAME it finds in its env file: metadata.via
 * "env_key_present" (the chat bridge) or "local_install" (the local bridge's
 * credential scan). Nothing called the service. Read as a check, it put
 * "Connected" on the old System health integration grid and on the Telegram
 * and Google cards (2026-10-08) for keys nobody had tested.
 *
 * A real probe of something installed on that computer says "local_probe", and
 * a failure written by a real call carries its own status: neither is matched.
 *
 * PURE AND CLIENT-SAFE.
 */

/** The `via` values that mean "a key name was found", not "a check passed". */
export const PRESENCE_ONLY_VIA: readonly string[] = ["env_key_present", "local_install"];

/**
 * The mark app/api/bridge/ping puts on every row it writes, over anything the
 * computer sent under the same key. A paired computer writes this table only
 * through that route, and any paired computer of the workspace can (pairing
 * is per person). OASIS's own email sender writes the mailbox's real sign-in
 * result straight to the database (BEA scripts/integration_health.py ping,
 * the ping_integration RPC), never through the route. So a marked row is a
 * computer's own report: it is never read as a check of a value OASIS keeps on
 * its server (lib/integrations/server-checks.ts mailboxSendCheck), or a rep's
 * laptop could post "the mailbox's last send worked" and turn the Google card
 * green (PR #558 review).
 */
export const BRIDGE_REPORT_KEY = "_reported_by";
export const BRIDGE_REPORT_VALUE = "paired_bridge";

/** True when the route that paired computers report through wrote this row. */
export function isBridgeReport(metadata: unknown): boolean {
  return heartbeatMetadata(metadata)?.[BRIDGE_REPORT_KEY] === BRIDGE_REPORT_VALUE;
}

/** A row's metadata as an object (it arrives as JSON text or an object), or null. */
export function heartbeatMetadata(metadata: unknown): Record<string, unknown> | null {
  let m: unknown = metadata;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

/** True when a heartbeat's metadata says it only reports a key on file. */
export function isPresenceOnlyHeartbeat(metadata: unknown): boolean {
  let m: unknown = metadata;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return false;
    }
  }
  if (!m || typeof m !== "object") return false;
  const via = (m as { via?: unknown }).via;
  return typeof via === "string" && PRESENCE_ONLY_VIA.includes(via);
}
