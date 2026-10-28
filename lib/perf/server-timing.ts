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
import { NAV_KIND_HEADER, isNavKind, navKindFromRequestHeaders, type NavKind } from "./nav-kind";

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
 * How a render was asked for: document load, client navigation or prefetch
 * (lib/perf/nav-kind.ts). Next strips its RSC and prefetch headers from what
 * headers() returns, so middleware decides the kind from the raw request and
 * forwards it as NAV_KIND_HEADER; this reads that, then falls back to the raw
 * headers in case they are present (a direct call, a test).
 */
export type { NavKind } from "./nav-kind";

export function navKindOf(h: { get(name: string): string | null }): NavKind {
  try {
    const forwarded = h.get(NAV_KIND_HEADER);
    if (isNavKind(forwarded)) return forwarded;
    return navKindFromRequestHeaders(h);
  } catch {
    return "doc";
  }
}

/** What a summary line may carry besides its spans. No identifiers, no values. */
export interface PerfMeta {
  nav?: NavKind;
  /** The request's cf-ray, so a layout line and a page line from one request can be joined. */
  ray?: string | null;
  /** How the scope ended: "ok", "redirect" or "error". */
  outcome?: "ok" | "redirect" | "error";
}

/**
 * [perf] lines this isolate has written. 1 and 2 are the first renders of a
 * freshly started isolate, which is how a cold start is told apart from a
 * warm one in the logs. A plain number per isolate: no request data, no
 * pending promise (tests/worker-request-isolation.test.ts).
 */
let perfSeq = 0;

const RAY_RE = /^[A-Za-z0-9-]{1,40}$/;

/**
 * One structured line per tracked render scope. Greppable as `[perf]`;
 * fields are label:ms pairs plus the total. Skips trivially-fast scopes
 * (< 5ms with no spans) so full-bleed marketing paths don't spam logs.
 */
export function logPerfSummary(
  scope: string,
  path: string,
  spans: PerfSpan[],
  totalMs: number,
  meta: PerfMeta = {},
): void {
  try {
    if (!perfLogEnabled()) return;
    if (totalMs < 5 && spans.length === 0) return;
    perfSeq += 1;
    const fields: Record<string, number> = {};
    for (const s of spans) fields[s.label] = Math.round(s.ms);
    const extra: Record<string, string> = {};
    if (meta.nav) extra.nav = meta.nav;
    if (meta.ray && RAY_RE.test(meta.ray)) extra.ray = meta.ray;
    if (meta.outcome) extra.outcome = meta.outcome;
    console.log(
      `[perf] ${JSON.stringify({ ...extra, iso: perfSeq, scope, path: path.slice(0, 120), total_ms: Math.round(totalMs), spans: fields })}`,
    );
  } catch {
    // fail-open
  }
}

/**
 * One [perf] line for a page render, the way the root layout writes its own:
 * spans go into `spans` (pass it to timed()), and done() writes the line once,
 * with the nav kind and cf-ray read from the request headers, then hands back
 * whatever it was given, unchanged, so a page can `return perf.done("ok", (...))`.
 */
export function startPagePerf(
  scope: string,
  path: string,
  hdrs: { get(name: string): string | null },
): { spans: PerfSpan[]; done<T>(outcome: "ok" | "redirect" | "error", value?: T): T } {
  const t0 = Date.now();
  const spans: PerfSpan[] = [];
  let logged = false;
  return {
    spans,
    done<T>(outcome: "ok" | "redirect" | "error", value?: T): T {
      if (!logged) {
        logged = true;
        let ray: string | null = null;
        try {
          ray = hdrs.get("cf-ray");
        } catch {
          // fail-open
        }
        logPerfSummary(scope, path, spans, Date.now() - t0, { nav: navKindOf(hdrs), ray, outcome });
      }
      return value as T;
    },
  };
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
 * PERF_DB_VERBOSE=1 — including inside transaction() scopes (Codex P2,
 * 2026-09-01: lib/sms/reply-agent.ts and the RPC shim run tx.execute, and
 * an unwrapped transaction would silently vanish from the baseline).
 * Everything else passes through untouched (bound methods keep their
 * original receiver). With the env var off the added cost is one boolean
 * check per call.
 */
function timedExecute<T extends { execute: (stmt: never) => Promise<unknown> }>(
  target: T,
  kind: string,
) {
  return async (stmt: InStatement | string) => {
    const t0 = Date.now();
    const res = await target.execute(stmt as never);
    const rows = (res as { rows?: unknown[] } | null)?.rows;
    logDbCall(kind, stmt, Date.now() - t0, Array.isArray(rows) ? rows.length : null);
    return res;
  };
}

function timedBatch<T extends { batch: (...args: never[]) => Promise<unknown> }>(
  target: T,
  kind: string,
) {
  return async (...args: unknown[]) => {
    const t0 = Date.now();
    const res = await (target.batch as (...a: unknown[]) => Promise<unknown>)(...args);
    logDbCall(kind, `${kind}(${Array.isArray(args[0]) ? (args[0] as unknown[]).length : "?"} stmts)`, Date.now() - t0, null);
    return res;
  };
}

function instrumentTransaction<T extends object>(tx: T): T {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "execute" && typeof (target as { execute?: unknown }).execute === "function") {
        return timedExecute(target as { execute: (stmt: never) => Promise<unknown> }, "tx.execute");
      }
      if (prop === "batch" && typeof (target as { batch?: unknown }).batch === "function") {
        return timedBatch(target as { batch: (...args: never[]) => Promise<unknown> }, "tx.batch");
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function instrumentTursoClient(client: Client): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") return timedExecute(target, "execute");
      if (prop === "batch") return timedBatch(target, "batch");
      if (prop === "transaction") {
        return async (...args: unknown[]) => {
          // transaction() is overloaded (with/without a mode arg); forward
          // whatever the caller passed and wrap whatever comes back.
          const factory = target.transaction as unknown as (...a: unknown[]) => Promise<object>;
          const tx = await factory.apply(target, args);
          return instrumentTransaction(tx);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
