/**
 * lib/ledger/read.ts — the minimal read API the KPI registry builds on.
 *
 * Every function takes the tenant explicitly and binds it into the WHERE;
 * libSQL has no row-level security, so that clause is the isolation boundary.
 * An empty tenant throws rather than reading "every tenant". Callers get the
 * tenant from the session (a tile) or from a server context that came from
 * one (the metric registry).
 *
 *   countByKey  how many of one event in [from, to) by occurred_at.
 *   latestFor   the newest event about one subject (optionally of one key).
 *   coverage    per-UTC-day counts per key over the last N days, so a tile can
 *               decide whether it has enough history to show a number
 *               (plan §F2.12: "—" until 14 consecutive days of coverage).
 */
import type { Client, InValue } from "@libsql/client";
import type { LedgerRow } from "@/lib/ledger/emit";

function requireTenant(tenantId: string): string {
  const t = (tenantId || "").trim();
  if (!t) throw new Error("ledger: tenant id is required");
  return t;
}

function iso(v: Date | string, field: string): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`ledger: ${field} is not a time`);
  return d.toISOString();
}

/** Count of `eventKey` events for the tenant with from <= occurred_at < to. */
export async function countByKey(
  db: Client,
  tenantId: string,
  eventKey: string,
  from: Date | string,
  to: Date | string,
): Promise<number> {
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM outcome_events
          WHERE tenant_id = ? AND event_key = ? AND occurred_at >= ? AND occurred_at < ?`,
    args: [requireTenant(tenantId), eventKey, iso(from, "from"), iso(to, "to")],
  });
  return Number(rs.rows[0]?.n ?? 0);
}

export type LedgerEvent = Omit<LedgerRow, "payload_json"> & { payload: Record<string, unknown> };

function mapEvent(r: Record<string, unknown>): LedgerEvent {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = typeof v === "bigint" ? Number(v) : v;
  const payloadJson = String(out.payload_json ?? "{}");
  delete out.payload_json;
  // Written canonical by emit.ts; a row that does not parse was written around
  // it, and that is a loud error, not an empty payload.
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  return { ...(out as Omit<LedgerRow, "payload_json">), payload };
}

/** The newest event about one subject, by occurred_at then id. Null when there is none. */
export async function latestFor(
  db: Client,
  tenantId: string,
  subject: { type: string; id: string },
  eventKey?: string,
): Promise<LedgerEvent | null> {
  const args: InValue[] = [requireTenant(tenantId), subject.type, subject.id];
  let keyClause = "";
  if (eventKey) {
    keyClause = " AND event_key = ?";
    args.push(eventKey);
  }
  const rs = await db.execute({
    sql: `SELECT * FROM outcome_events
          WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?${keyClause}
          ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    args,
  });
  const row = rs.rows[0];
  if (!row) return null;
  const o: Record<string, unknown> = {};
  rs.columns.forEach((c, i) => {
    o[c] = (row as unknown as unknown[])[i];
  });
  return mapEvent(o);
}

export type KeyCoverage = {
  /** Count per day, aligned with Coverage.days. */
  perDay: number[];
  daysWithEvents: number;
  /** Consecutive days with at least one event, counting back from the newest day. */
  trailingStreak: number;
};

export type Coverage = {
  tenantId: string;
  /** UTC days, oldest first, the last one being today (UTC). */
  days: string[];
  byKey: Record<string, KeyCoverage>;
};

/**
 * Per-day counts for each key over the last `days` UTC days, today included.
 * A day with no events is 0, never missing, so "no data" and "not
 * instrumented yet" are both visible as zeros a tile can refuse to average.
 */
export async function coverage(
  db: Client,
  tenantId: string,
  eventKeys: readonly string[],
  days: number,
  now: Date = new Date(),
): Promise<Coverage> {
  const t = requireTenant(tenantId);
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error("ledger: coverage days must be 1..366");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(new Date(today - i * 86_400_000).toISOString().slice(0, 10));
  const byKey: Record<string, KeyCoverage> = {};
  const keys = [...new Set(eventKeys)];
  for (const k of keys) byKey[k] = { perDay: dayList.map(() => 0), daysWithEvents: 0, trailingStreak: 0 };
  if (keys.length === 0) return { tenantId: t, days: dayList, byKey };

  const from = `${dayList[0]}T00:00:00.000Z`;
  const to = new Date(today + 86_400_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT event_key, substr(occurred_at, 1, 10) AS day, COUNT(*) AS n FROM outcome_events
          WHERE tenant_id = ? AND event_key IN (${keys.map(() => "?").join(", ")})
            AND occurred_at >= ? AND occurred_at < ?
          GROUP BY event_key, day`,
    args: [t, ...keys, from, to],
  });
  const index = new Map(dayList.map((d, i) => [d, i]));
  for (const r of rs.rows) {
    const i = index.get(String(r.day));
    const k = String(r.event_key);
    if (i === undefined || !byKey[k]) continue;
    byKey[k].perDay[i] = Number(r.n ?? 0);
  }
  for (const k of keys) {
    const c = byKey[k];
    c.daysWithEvents = c.perDay.filter((n) => n > 0).length;
    let streak = 0;
    for (let i = c.perDay.length - 1; i >= 0 && c.perDay[i] > 0; i--) streak += 1;
    c.trailingStreak = streak;
  }
  return { tenantId: t, days: dayList, byKey };
}
