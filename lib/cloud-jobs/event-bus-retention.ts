import type { Client, InStatement } from "@libsql/client";

export const EVENT_RETENTION_DAYS = 30;
export const EVENT_RETENTION_LIMIT = 20_000;
export const EVENT_RETENTION_CHUNK = 200;

type EventRow = {
  id: string;
  event_type: string;
  published_at: unknown;
  created_at: unknown;
};

export function parseEventTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  // Python's source treats every offset-free database timestamp as UTC. JS
  // otherwise interprets the legacy "YYYY-MM-DD HH:mm:ss" form in the host's
  // local zone, moving the 30-day boundary by hours.
  const zoned = /(?:Z|[+-]\d\d:?\d\d)$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(zoned);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function staleEventRows(rows: EventRow[], cutoff: Date): EventRow[] {
  return rows.filter((row) => {
    const timestamp = parseEventTimestamp(row.published_at) ?? parseEventTimestamp(row.created_at);
    return timestamp !== null && timestamp.getTime() < cutoff.getTime();
  });
}

export async function runEventBusRetention(input: {
  db: Pick<Client, "execute">;
  dryRun: boolean;
  now?: Date;
  days?: number;
  limit?: number;
}): Promise<{
  ok: boolean;
  cutoff_days: number;
  dry_run: boolean;
  dry_run_scope: "database_read_only" | "live";
  stale_found: number;
  by_type: Record<string, number>;
  marked: number;
  failed: number;
}> {
  const days = input.days ?? EVENT_RETENTION_DAYS;
  const limit = input.limit ?? EVENT_RETENTION_LIMIT;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("event_retention_days_invalid");
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_RETENTION_LIMIT) {
    throw new Error("event_retention_limit_invalid");
  }
  const read = await input.db.execute({
    sql: `SELECT id, event_type, published_at, created_at
          FROM agent_events
          WHERE status = 'pending'
          LIMIT ?`,
    args: [limit + 1],
  });
  if (read.rows.length > limit) throw new Error("event_retention_read_limit_exceeded");
  const rows: EventRow[] = read.rows.map((row) => ({
    id: String(row.id || ""),
    event_type: String(row.event_type || "unknown"),
    published_at: row.published_at,
    created_at: row.created_at,
  }));
  const cutoff = new Date((input.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  const stale = staleEventRows(rows, cutoff).filter((row) => row.id);
  const byType: Record<string, number> = {};
  for (const row of stale) byType[row.event_type] = (byType[row.event_type] ?? 0) + 1;
  const orderedTypes = Object.fromEntries(
    Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 10),
  );
  if (input.dryRun || stale.length === 0) {
    return {
      ok: true,
      cutoff_days: days,
      dry_run: input.dryRun,
      dry_run_scope: input.dryRun ? "database_read_only" : "live",
      stale_found: stale.length,
      by_type: orderedTypes,
      marked: 0,
      failed: 0,
    };
  }

  let marked = 0;
  let failed = 0;
  for (let offset = 0; offset < stale.length; offset += EVENT_RETENTION_CHUNK) {
    const ids = stale.slice(offset, offset + EVENT_RETENTION_CHUNK).map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const statement: InStatement = {
      sql: `UPDATE agent_events
            SET status = 'dead',
                last_error = ?
            WHERE status = 'pending' AND id IN (${placeholders})`,
      args: [`aged out by event_retention: no consumer claimed it within ${days}d`, ...ids],
    };
    try {
      const result = await input.db.execute(statement);
      marked += result.rowsAffected;
      // A consumer may claim a selected row between the read and this guarded
      // update. That row no longer needs retention; it is not a failed write.
    } catch (error) {
      failed += ids.length;
      console.error("[event-bus-retention.chunk]", error instanceof Error ? error.stack : error);
    }
  }
  return {
    ok: failed === 0,
    cutoff_days: days,
    dry_run: false,
    dry_run_scope: "live",
    stale_found: stale.length,
    by_type: orderedTypes,
    marked,
    failed,
  };
}
