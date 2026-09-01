/**
 * P0 latency instrumentation (instant-load plan, 2026-09-01).
 *
 * WHY. Every prior latency number for this app (2,703ms FILTER_SELECT,
 * ~140ms duplicate tenant read) was measured by an EXTERNAL harness and
 * lost the moment the session ended. Nothing in the codebase records where
 * a request's time actually goes, so every optimization argument restarts
 * from zero. This module is the permanent, in-repo seam: span timers for
 * the root layout's "session tax", and a per-query wrapper for the Turso
 * client so the db-side cost distribution is reconstructable from logs.
 *
 * CONTRACT (load-bearing):
 *   - FAIL-OPEN. Instrumentation must never break, slow, or reorder a
 *     request. Every log path is wrapped; a throwing logger is swallowed.
 *   - NO VALUES IN LOGS. SQL text is safe to log because every value is
 *     bound as an arg (see lib/turso-postgrest.ts whereSql) — args are
 *     NEVER logged, only the SQL text and durations. Do not "improve"
 *     this by logging args: lead PII lives in those bindings.
 *   - Layout summary logs by default (one line per shell render);
 *     per-query logging is verbose and gated on PERF_DB_VERBOSE=1.
 */

import type { Client, InStatement } from "@libsql/client";

export interface PerfSpan {
  label: string;
  ms: number;
}

/** Layout/page summary logging: on unless explicitly disabled. */
export function perfLogEnabled(): boolean {
  return process.env.PERF_LOG !== "0";
}

/** Per-query db logging: off unless explicitly enabled (verbose). */
export function perfDbVerbose(): boolean {
  return process.env.PERF_DB_VERBOSE === "1";
}

/**
 * Await `p`, recording its duration into `sink`. The promise's value and
 * its REJECTION both pass through untouched — a failed read must keep
 * failing exactly the way it failed before this wrapper existed.
 */
export async function timed<T>(label: string, p: Promise<T>, sink: PerfSpan[]): Promise<T> {
  const t0 = Date.now();
  try {
    return await p;
  } finally {
    try {
      sink.push({ label, ms: Date.now() - t0 });
    } catch {
      // fail-open: a broken sink never breaks the request
    }
  }
}

/**
 * One structured line per tracked render scope. Greppable as `[perf]`;
 * fields are label:ms pairs plus the total. Skips trivially-fast scopes
 * (< 5ms with no spans) so full-bleed marketing paths don't spam logs.
 */
export function logPerfSummary(scope: string, path: string, spans: PerfSpan[], totalMs: number): void {
  try {
    if (!perfLogEnabled()) return;
    if (totalMs < 5 && spans.length === 0) return;
    const fields: Record<string, number> = {};
    for (const s of spans) fields[s.label] = Math.round(s.ms);
    console.log(
      `[perf] ${JSON.stringify({ scope, path: path.slice(0, 120), total_ms: Math.round(totalMs), spans: fields })}`,
    );
  } catch {
    // fail-open
  }
}

// ------------------------------------------------------------- db wrapper

function sqlPreview(stmt: InStatement | string): string {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  // SQL text only — bound args are deliberately not read here at all.
  return sql.replace(/\s+/g, " ").slice(0, 140);
}

function logDbCall(kind: string, stmt: InStatement | string, ms: number, rows: number | null): void {
  try {
    if (!perfDbVerbose()) return;
    console.log(
      `[perf.db] ${JSON.stringify({ kind, ms: Math.round(ms), rows, sql: sqlPreview(stmt) })}`,
    );
  } catch {
    // fail-open
  }
}

/**
 * Wrap a libSQL client so execute()/batch() report per-call durations when
 * PERF_DB_VERBOSE=1. Everything else passes through untouched (bound
 * methods keep their original receiver). With the env var off the added
 * cost is one boolean check per call.
 */
export function instrumentTursoClient(client: Client): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (stmt: InStatement | string) => {
          const t0 = Date.now();
          const res = await target.execute(stmt as InStatement);
          logDbCall("execute", stmt, Date.now() - t0, res?.rows ? res.rows.length : null);
          return res;
        };
      }
      if (prop === "batch") {
        return async (...args: Parameters<Client["batch"]>) => {
          const t0 = Date.now();
          const res = await target.batch(...args);
          logDbCall("batch", `batch(${Array.isArray(args[0]) ? args[0].length : "?"} stmts)`, Date.now() - t0, null);
          return res;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
