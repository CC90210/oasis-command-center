/**
 * Database access for FOUNDERS > Finances.
 *
 * Every fin_* table lives in Turso only (Supabase was retired 2026-08-09 and
 * never had these tables), so this module talks to the raw libSQL client:
 * statements, reports and atomic journal posting all need SQL the PostgREST
 * shim does not express. Multi-statement writes go through
 * `client.batch([...], "write")`, which libSQL runs as ONE transaction — a
 * journal entry and its lines land together or not at all.
 */
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet, Row } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";

export type { InStatement };

/**
 * Round-trip counter. Every execute and every batch is one trip to Turso (a
 * batch is one trip however many statements it carries). Counting is scoped
 * to the async context of countRoundTrips(), so concurrent requests never
 * share a tally; outside that scope the only cost is one getStore() call.
 * tests/finances-roundtrips.test.ts uses it to pin an upper bound per page.
 */
type Tally = { trips: number; sql: string[] };
const tally = new AsyncLocalStorage<Tally>();

function countTrip(t: Tally | undefined, sql: string): void {
  if (!t) return;
  t.trips += 1;
  t.sql.push(sql.replace(/\s+/g, " ").trim().slice(0, 120));
}

function sqlOf(stmt: InStatement): string {
  return typeof stmt === "string" ? stmt : stmt.sql;
}

export async function countRoundTrips<T>(fn: () => Promise<T>): Promise<{ result: T; trips: number; sql: string[] }> {
  const t: Tally = { trips: 0, sql: [] };
  const result = await tally.run(t, fn);
  return { result, trips: t.trips, sql: t.sql };
}

/**
 * The libSQL client. Inside countRoundTrips() it is wrapped so the modules
 * that call finDb().execute() directly are counted too; outside, it is the
 * plain client.
 */
export function finDb(): Client {
  const client = getTursoClient();
  const t = tally.getStore();
  if (!t) return client;
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (stmt: InStatement, ...rest: unknown[]) => {
          countTrip(t, sqlOf(stmt));
          return (target.execute as (...a: unknown[]) => Promise<ResultSet>)(stmt, ...rest);
        };
      }
      if (prop === "batch") {
        return (stmts: InStatement[], ...rest: unknown[]) => {
          countTrip(t, `batch(${stmts.length}) ${stmts[0] ? sqlOf(stmts[0]) : ""}`);
          return (target.batch as (...a: unknown[]) => Promise<ResultSet[]>)(stmts, ...rest);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

type Plain = Record<string, string | number | null>;

function plain(row: Row, columns: string[]): Plain {
  const out: Plain = {};
  for (const c of columns) {
    const v = (row as unknown as Record<string, unknown>)[c];
    if (typeof v === "bigint") out[c] = Number(v);
    else if (v === undefined) out[c] = null;
    else if (v instanceof ArrayBuffer) out[c] = null;
    else out[c] = v as string | number | null;
  }
  return out;
}

export function rowsOf<T = Plain>(rs: ResultSet): T[] {
  return rs.rows.map((r) => plain(r, rs.columns) as unknown as T);
}

export async function query<T = Plain>(sql: string, args: Array<string | number | null> = []): Promise<T[]> {
  const rs = await finDb().execute({ sql, args });
  return rowsOf<T>(rs);
}

export async function queryOne<T = Plain>(sql: string, args: Array<string | number | null> = []): Promise<T | null> {
  const rows = await query<T>(sql, args);
  return rows[0] ?? null;
}

/** Atomic multi-statement write. Throws (and rolls back) on any failure. */
export async function writeBatch(statements: InStatement[]): Promise<ResultSet[]> {
  if (statements.length === 0) return [];
  return finDb().batch(statements, "write");
}

export function n(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}

export function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

/** An audit row as a statement, so it rides in the same transaction as the change it records. */
export function auditStatement(input: {
  entityId: string | null;
  actor: string;
  action: string;
  objectType: string;
  objectId: string | null;
  detail?: Record<string, unknown>;
}): InStatement {
  return {
    sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId("aud"),
      input.entityId,
      input.actor.slice(0, 200),
      input.action,
      input.objectType,
      input.objectId,
      JSON.stringify(input.detail || {}).slice(0, 8000),
    ],
  };
}
