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
    _cached = instrumentTursoClient(createClient({ url: `file:${path}` }));
    return _cached;
  }
  if (remote) {
    _cached = instrumentTursoClient(createClient({ url: remote, authToken: token }));
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
