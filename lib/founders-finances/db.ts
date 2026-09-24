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

import { randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet, Row } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";

export type { InStatement };

export function finDb(): Client {
  return getTursoClient();
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
