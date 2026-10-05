import "server-only";

/**
 * Client error reports are kept 30 days (data minimisation: a message or a
 * stack can echo page text). Pruned on a schedule, not only when a new report
 * arrives: /api/cron/connection-health runs this every 15 minutes, beside
 * Slack's retention (lib/slack/retention.ts).
 *
 * Before migration bravo__198 is applied the table does not exist; that is a
 * no-op, never a failed run.
 */

import type { Client } from "@libsql/client";

export const CLIENT_ERROR_RETENTION_DAYS = 30;
const BATCH = 500;
const DAY = 86_400_000;

export type ClientErrorRetentionResult = { deleted: number; notInstalled: boolean };

export async function purgeClientErrorReports(db: Client, now: Date): Promise<ClientErrorRetentionResult> {
  const cutoff = new Date(now.getTime() - CLIENT_ERROR_RETENTION_DAYS * DAY).toISOString();
  try {
    const rs = await db.execute({
      sql: `DELETE FROM client_error_reports WHERE id IN (
              SELECT id FROM client_error_reports WHERE created_at < ? LIMIT ${BATCH})`,
      args: [cutoff],
    });
    return { deleted: rs.rowsAffected, notInstalled: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) return { deleted: 0, notInstalled: true };
    throw err;
  }
}
