/**
 * Turso / libSQL client factory for tenants whose data sovereignty choice is
 * "Local libSQL" (see ClientCommandCenterProfile.dataBackend === "turso").
 *
 * Two source modes:
 *   - file: TURSO_DB_PATH=/Users/.../tenant.db  → local libSQL file
 *   - http: TURSO_DB_URL=libsql://... + TURSO_AUTH_TOKEN  → hosted Turso
 *
 * The factory is process-cached and idempotent. Callers that get an error
 * should swallow + fall back to Supabase via lib/db.ts — see getDbBackend().
 */

import { createClient, type Client } from "@libsql/client";
import { instrumentTursoClient } from "@/lib/perf/server-timing";

/**
 * Options for every libSQL client kept at module scope.
 *
 * @libsql/client queues statements behind a per-client concurrency limit
 * (default 20). getTursoClient() is ONE client per isolate, shared by every
 * request that isolate serves, so that queue is shared too. A statement that
 * waits in it is started later by ANOTHER request's completion; the Workers
 * runtime ties the statement to that other request, cancels the waiting
 * request's continuation, and kills it as hung. Any page that keeps 20 reads in
 * flight fills the queue, and a request landing in the same isolate meanwhile
 * dies: "Something went wrong" on every other click (2026-10-01 pipeline
 * incident; see lib/runtime/settled-once.ts for the runtime messages).
 *
 * A limit no isolate can reach means no statement waits on another request.
 * Each request's own fetches stay bounded by the runtime's per-request
 * connection limit, which queues inside that request.
 */
export const LIBSQL_CLIENT_OPTIONS = { concurrency: Number.MAX_SAFE_INTEGER } as const;

let _cached: Client | null = null;

export function getTursoClient(): Client {
  if (_cached) return _cached;
  const path = process.env.TURSO_DB_PATH;
  // TURSO_DATABASE_URL is the canonical name (matches turso_admin --write-env
  // and the Python DAL); TURSO_DB_URL kept as the legacy fallback this file
  // originally shipped with.
  const remote = process.env.TURSO_DATABASE_URL || process.env.TURSO_DB_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  // instrumentTursoClient is the P0 latency seam: EVERY app→Turso call
  // (query builder, RPC shim, session verification) flows through this
  // factory, so wrapping here measures all of them. Pass-through unless
  // PERF_DB_VERBOSE=1; never logs bound args (PII lives there).
  if (path) {
    _cached = instrumentTursoClient(createClient({ url: `file:${path}`, ...LIBSQL_CLIENT_OPTIONS }));
    return _cached;
  }
  if (remote) {
    _cached = instrumentTursoClient(createClient({ url: remote, authToken: token, ...LIBSQL_CLIENT_OPTIONS }));
    return _cached;
  }
  throw new Error(
    "Turso misconfigured: set TURSO_DB_PATH (local file) or TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)."
  );
}

export function tursoConfigured(): boolean {
  return !!(
    process.env.TURSO_DB_PATH ||
    process.env.TURSO_DATABASE_URL ||
    process.env.TURSO_DB_URL
  );
}
