/**
 * lib/slack/retention.ts - Slack text is kept for 90 days, then deleted.
 *
 * What is deleted, per workspace with a Slack connection (live or not):
 *   - conversation_events rows of event_type 'slack_message' older than
 *     SLACK_RETENTION_DAYS (the mirrored messages and OASIS's posted replies);
 *   - slack_event_receipts older than RECEIPT_RETENTION_DAYS (Slack retries
 *     within minutes; a week of receipts is ample dedupe);
 *   - jev_calls older than JEV_TELEMETRY_RETENTION_DAYS (telemetry only, no
 *     text, but it is not kept forever either);
 *   - Slack people (external_identities: display name, teammate link) not
 *     looked up again for SLACK_RETENTION_DAYS. A disconnect deletes them all
 *     at once (lib/slack/routing.ts slackDisconnectStatements).
 * Approvals (with their draft text) are the business record of what was
 * approved and posted, and stay.
 *
 * Runs from the connection-health cron (every 15 minutes, already scheduled),
 * a bounded batch per workspace per run, so a first run over a large backlog
 * never holds the database. A missing slack_* / jev_calls table (bravo__197 not
 * applied) is reported as not_installed, loudly, and does not fail the cron.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { isSlackSchemaMissing } from "@/lib/slack/routing";
import { SLACK_EVENT_TYPE } from "@/lib/slack/mirror";

export const SLACK_RETENTION_DAYS = 90;
export const RECEIPT_RETENTION_DAYS = 7;
export const JEV_TELEMETRY_RETENTION_DAYS = 180;
/** Rows per workspace per run. */
export const RETENTION_BATCH = 500;

const DAY = 86_400_000;

export type RetentionResult = {
  workspaces: number;
  messagesDeleted: number;
  receiptsDeleted: number;
  jevCallsDeleted: number;
  identitiesDeleted: number;
  /** True when a table this sweep needs is not there yet (bravo__197). */
  notInstalled: boolean;
};

export async function purgeSlackRetention(db: Client, now: Date): Promise<RetentionResult> {
  const out: RetentionResult = { workspaces: 0, messagesDeleted: 0, receiptsDeleted: 0, jevCallsDeleted: 0, identitiesDeleted: 0, notInstalled: false };
  const messageCutoff = new Date(now.getTime() - SLACK_RETENTION_DAYS * DAY).toISOString();

  // Every workspace that ever connected Slack, revoked included: its mirrored
  // text ages out on the same clock after a disconnect.
  const tenants = await db.execute({ sql: "SELECT DISTINCT tenant_id FROM tenant_connections WHERE provider = 'slack'", args: [] });
  for (const row of tenants.rows) {
    const tenantId = String((row as unknown as Record<string, unknown>).tenant_id);
    out.workspaces += 1;
    const rs = await db.execute({
      sql: `DELETE FROM conversation_events WHERE id IN (
              SELECT id FROM conversation_events
              WHERE tenant_id = ? AND event_type = ? AND created_at < ?
              LIMIT ${RETENTION_BATCH})`,
      args: [tenantId, SLACK_EVENT_TYPE, messageCutoff],
    });
    out.messagesDeleted += rs.rowsAffected;
  }

  try {
    const r = await db.execute({
      sql: "DELETE FROM slack_event_receipts WHERE received_at < ?",
      args: [new Date(now.getTime() - RECEIPT_RETENTION_DAYS * DAY).toISOString()],
    });
    out.receiptsDeleted = r.rowsAffected;
    const j = await db.execute({
      sql: "DELETE FROM jev_calls WHERE created_at < ?",
      args: [new Date(now.getTime() - JEV_TELEMETRY_RETENTION_DAYS * DAY).toISOString()],
    });
    out.jevCallsDeleted = j.rowsAffected;
    // A Slack person OASIS has not had to look up for 90 days (they stopped
    // writing in mapped channels, or left): their name and teammate link go.
    const i = await db.execute({
      sql: "DELETE FROM external_identities WHERE provider = 'slack' AND checked_at < ?",
      args: [messageCutoff],
    });
    out.identitiesDeleted = i.rowsAffected;
  } catch (err) {
    if (!isSlackSchemaMissing(err)) throw err;
    out.notInstalled = true;
    console.error("[slack.retention] migration bravo__197 is not applied: receipts and Jev telemetry were not trimmed");
  }
  return out;
}
