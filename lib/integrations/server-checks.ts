/**
 * lib/integrations/server-checks.ts - the real checks of the app details OASIS
 * sets on its own server.
 *
 * OASIS's own workspaces use details set on OASIS's server for the Telegram
 * team bot, the Google mailbox and Twilio (lib/tenant-integration-store.ts,
 * the env fallback). Those values have no saved key row, so a Test of them
 * used to land nowhere: the card could never say "verified", and a failed Test
 * changed nothing on screen (PR #553 review F1). Two real checks are kept for
 * them now, and lib/os/connectors.ts keyedStatus applies the newer one to the
 * server-set values only (a saved value carries its own Test result):
 *
 *   test   the workspace's latest Test of the app: tenant_integration_checks
 *          (migration bravo__205), written by app/api/integrations/keys/test
 *          and deleted when a saved value of the app changes
 *          (app/api/integrations/keys), so it always describes the values in use.
 *   send   for the Google mailbox: OASIS's own email sender, on OASIS's
 *          computer, signs in to Gmail as OASIS's mailbox for every email it
 *          sends and records the outcome on its "gws" heartbeat: healthy with
 *          source "send_gateway.smtp_send" when the email went out, down with
 *          "SMTP authentication failed" when Gmail refused the App Password.
 *          Its other outcomes (a refused recipient, a timeout, a send as a
 *          person's own Google account) say nothing about the mailbox's
 *          password and are not read. A heartbeat that only says a key NAME is
 *          on that computer (presence-heartbeat.ts) is never a check, and the
 *          bridge's minute-by-minute scan no longer overwrites a real result
 *          (app/api/bridge/ping).
 *
 * Every read and write is scoped by the tenant id from the session.
 */

import "server-only";

import type { Row } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { storedTestResult, tenantMayUseEnvFallback } from "@/lib/tenant-integration-store";
import { isPresenceOnlyHeartbeat } from "@/lib/integrations/presence-heartbeat";
import type { ServerCheckFact } from "@/lib/os/connectors";

/** Before migration bravo__205 is applied, no check can have been recorded. */
const MISSING_TABLE = /no such table: tenant_integration_checks\b/i;

/** The send-gateway's heartbeat after an email went out over the mailbox's App Password. */
export const MAILBOX_SEND_SOURCE = "send_gateway.smtp_send";
/** The send-gateway's heartbeat error when Gmail refused the mailbox's App Password. */
export const MAILBOX_SEND_REFUSED = "SMTP authentication failed";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metadataObject(metadata: unknown): Record<string, unknown> | null {
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

/**
 * One "gws" heartbeat as a check of OASIS's mailbox, or null when it is not
 * one: a key-name scan, a failure that is not the password's, a send as a
 * person's own Google account, a row with no time.
 */
export function mailboxSendCheck(row: {
  status: unknown;
  last_ping_at: unknown;
  last_error: unknown;
  metadata: unknown;
}): ServerCheckFact | null {
  const at = typeof row.last_ping_at === "string" && Number.isFinite(Date.parse(row.last_ping_at)) ? row.last_ping_at : null;
  if (!at || isPresenceOnlyHeartbeat(row.metadata)) return null;
  if (row.status === "healthy" && metadataObject(row.metadata)?.source === MAILBOX_SEND_SOURCE) {
    return { service: "gws", via: "send", checked_at: at, ok: true, code: null };
  }
  if (row.status === "down" && row.last_error === MAILBOX_SEND_REFUSED) {
    return { service: "gws", via: "send", checked_at: at, ok: false, code: "send_auth_failed" };
  }
  return null;
}

/**
 * Every real check of one workspace's server-set values. Throws when a read
 * fails (the caller reports "status unavailable"); a missing checks table is
 * "no Test recorded yet", which is what it means.
 */
export async function listServerChecks(tenantId: string): Promise<ServerCheckFact[]> {
  if (!tenantId) throw new Error("server_checks_scope_missing");
  const db = getTursoClient();
  const testsRead = {
    sql: "SELECT service, checked_at, ok, code FROM tenant_integration_checks WHERE tenant_id = ?",
    args: [tenantId],
  };
  const sendsRead = {
    sql: "SELECT status, last_ping_at, last_error, metadata FROM integrations_health WHERE tenant_id = ? AND service = 'gws'",
    args: [tenantId],
  };
  // One round trip: the rail reads this on every page of an OASIS workspace.
  let tests: Row[];
  let heartbeats: Row[];
  try {
    const [t, h] = await db.batch([testsRead, sendsRead], "read");
    tests = t.rows;
    heartbeats = h.rows;
  } catch (error) {
    if (!MISSING_TABLE.test(errorText(error))) throw error;
    tests = [];
    heartbeats = (await db.execute(sendsRead)).rows;
  }
  const out: ServerCheckFact[] = [];
  for (const row of tests) {
    const ok = storedTestResult(row.ok);
    const at = typeof row.checked_at === "string" ? row.checked_at : null;
    if (ok === null || !at || !Number.isFinite(Date.parse(at)) || typeof row.service !== "string") continue;
    out.push({ service: row.service, via: "test", checked_at: at, ok, code: ok ? null : typeof row.code === "string" ? row.code : null });
  }
  for (const row of heartbeats) {
    const check = mailboxSendCheck({ status: row.status, last_ping_at: row.last_ping_at, last_error: row.last_error, metadata: row.metadata });
    if (check) out.push(check);
  }
  return out;
}

/**
 * The fields of one app whose value in a Test came from OASIS's own server: a
 * value the Test used with no saved row behind it. Always empty for a client
 * workspace, which never reads a server value.
 */
export async function serverSetFieldKeys(
  tenantId: string,
  service: string,
  tested: Readonly<Record<string, string>>,
  fieldKeys: readonly string[],
): Promise<string[]> {
  if (!tenantMayUseEnvFallback(tenantId)) return [];
  const r = await getTursoClient().execute({
    sql: "SELECT field_key FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ?",
    args: [tenantId, service],
  });
  const saved = new Set(r.rows.map((row) => String(row.field_key)));
  return fieldKeys.filter((key) => Boolean(tested[key]) && !saved.has(key));
}

/** Record the workspace's latest Test of one app. False (logged) when it could not be saved. */
export async function recordIntegrationCheck(input: {
  tenantId: string;
  service: string;
  ok: boolean;
  code: string | null;
  checkedBy: string | null;
  checkedAt?: string;
}): Promise<boolean> {
  try {
    await getTursoClient().execute({
      sql: `INSERT INTO tenant_integration_checks (tenant_id, service, checked_at, ok, code, checked_by)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, service) DO UPDATE SET
              checked_at = excluded.checked_at, ok = excluded.ok, code = excluded.code, checked_by = excluded.checked_by`,
      args: [
        input.tenantId,
        input.service,
        input.checkedAt ?? new Date().toISOString(),
        input.ok ? 1 : 0,
        input.ok ? null : input.code || "test_failed",
        input.checkedBy,
      ],
    });
    return true;
  } catch (error) {
    console.error("[integration-checks.record]", { tenantId: input.tenantId, service: input.service, error: errorText(error) });
    return false;
  }
}

/**
 * A saved value of the app changed: the last Test no longer describes the
 * values in use. False (logged) when it could not be cleared.
 */
export async function clearIntegrationCheck(tenantId: string, service: string): Promise<boolean> {
  if (!tenantMayUseEnvFallback(tenantId)) return true; // only OASIS's workspaces have one
  try {
    await getTursoClient().execute({
      sql: "DELETE FROM tenant_integration_checks WHERE tenant_id = ? AND service = ?",
      args: [tenantId, service],
    });
    return true;
  } catch (error) {
    if (MISSING_TABLE.test(errorText(error))) return true;
    console.error("[integration-checks.clear]", { tenantId, service, error: errorText(error) });
    return false;
  }
}
