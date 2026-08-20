/**
 * Shared helpers for /api routes. Extracted to kill the duplication that was
 * starting to drift across 4 route files (bad()/profileForUser()).
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { getServiceSupabase, getSessionUser } from "./supabase-server";

export function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

/**
 * Guarantee a route answers with JSON, even when it throws.
 *
 * A route handler returns a structured body on every path it anticipates, but a
 * throw escapes all of them — a session lookup that fails, the Turso proxy, a
 * driver hiccup mid-query — and an unhandled throw yields a response with NO
 * BODY. The browser then calls .json() on an empty string and reports
 * "Unexpected end of JSON input": a parser message standing in for the real
 * fault, naming nothing anyone can act on. That is precisely how the
 * Automations tab kept breaking with no usable diagnosis.
 *
 * Wrapping a handler converts any escape into a rendered error plus a server
 * log that says what actually broke. Use it on read paths the UI depends on.
 *
 *   export const GET = jsonRoute("api/cron-jobs GET", async () => { ... });
 */
export function jsonRoute<A extends unknown[]>(
  label: string,
  handler: (...args: A) => Promise<NextResponse>,
): (...args: A) => Promise<NextResponse> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${label}] threw`, {
        message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return NextResponse.json(
        { ok: false, error: "handler_threw", message, route: label },
        { status: 500 },
      );
    }
  };
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded. Used to hash bridge tokens
 * + HMAC secrets before storage / lookup. Five routes (auth/pair,
 * auth/pair-code/redeem, bridge/ping, inbound/n8n, outbound/log) were
 * each defining this same 3-line helper inline; consolidated
 * 2026-05-09 so future security tweaks (switching to BLAKE3,
 * normalizing input, etc.) happen in one place.
 *
 * Usage: const tokenHash = sha256(tokenPlain);
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Promise-with-fallback. Wrap any reader so a single thrown query can't
 * 500 a server-rendered page. Used in /today, /pipeline, /analytics,
 * /reasoning, /integrations, /settings — every dynamic page that does a
 * Promise.all over Supabase readers.
 *
 * The `label` is required: it surfaces in Vercel function logs as
 * `[safe:<label>] <error>` so failed readers are searchable instead of
 * silently rendering zeros. Use dotted scope-y names like "today.counts",
 * "pipeline.breakdown", "operations.events".
 *
 * Usage: const value = await safe("today.counts", readerPromise(), defaultValue);
 */
export async function safe<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.error(`[safe:${label}]`, err);
    return fallback;
  }
}

/**
 * Verify a "Bearer <secret>" header against an env-provided shared secret.
 * Used by /api/auth/provision-cli, /api/auth/pair, and any other CLI-only
 * route where the caller is the wizard / installer, not a logged-in user.
 *
 * Returns true on match. Routes should `return bad(401, "...")` on false.
 * Constant-time compare so timing attacks don't leak the secret.
 */
export function checkBearerSecret(req: NextRequest, envVar: string): boolean {
  const expected = (process.env[envVar] || "").trim();
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const provided = auth.slice(7).trim();
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Best-effort client IP extraction. Walks x-forwarded-for first
 * entry, then x-real-ip, then "unknown" so the caller doesn't have
 * to null-check. Used as a key for rate limiters + forensic logs.
 * Don't treat the value as identity — the headers are operator-
 * controllable on a self-hosted deploy.
 *
 * Single source of truth so a future "trust nginx-proxied real-ip
 * over xff" tweak lands in one place instead of six.
 */
export function getClientIp(req: NextRequest): string {
  // Prefer Vercel's platform-set header — a client request cannot forge it,
  // whereas raw X-Forwarded-For's leftmost entry IS client-suppliable. This
  // matters beyond rate-limit keys: the e-sign flow burns this value into the
  // signer's legal Certificate of Completion + audit as non-repudiation
  // evidence, so trust the verified header first, then fall back off-Vercel.
  const vercel = (req.headers.get("x-vercel-forwarded-for") || "").split(",")[0]?.trim();
  if (vercel) return vercel;
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * Resolve the authed user's profile row. Returns null when no session OR
 * no profile linked to that auth user. Routes should `return bad(401, ...)`
 * on null.
 */
export async function profileForUser(): Promise<{
  id: string;
  tenant_id: string | null;
} | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("id, tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  return r.data || null;
}

/**
 * Resolve the authed user's tenant_id directly. Thin wrapper over
 * profileForUser when the caller only needs the tenant.
 *
 * Consolidates the ~9 inline `resolveTenantId()` implementations that
 * spread across /api/forms, /api/sequences, /api/cron-jobs,
 * /api/applications/* during the SunBiz CRM build. Each had its own
 * identical body — getSessionUser -> db.user_profiles.select(tenant_id)
 * -> return value-or-null. New routes should import this helper.
 */
export async function tenantIdForUser(): Promise<string | null> {
  const p = await profileForUser();
  return p?.tenant_id ?? null;
}

/**
 * Resolve both tenant + user IDs in one call. Some routes need the
 * user_id too (cron-jobs records created_by, forms records created_by).
 */
export async function tenantAndUserIds(): Promise<{
  tenant_id: string | null;
  user_id: string | null;
}> {
  const user = await getSessionUser();
  if (!user) return { tenant_id: null, user_id: null };
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  return {
    tenant_id: (r.data as { tenant_id: string | null } | null)?.tenant_id ?? null,
    user_id: user.id,
  };
}

/**
 * Detect "the table doesn't exist in the schema cache" — usually means
 * the operator has the dashboard deployed but hasn't applied the latest
 * SQL migration yet. PostgREST's error string is the canonical signal
 * (PGRST205), with the Postgres-side `42P01 undefined_table` as a
 * secondary check. The literal "Could not find the table" string also
 * appears in some response shapes.
 *
 * Five routes (/api/cron-jobs, /api/forms, /forms page, CronJobsManager,
 * lib/queries.ts) duplicated this regex+code-check before consolidation.
 * Anyone adding a new feature that depends on a fresh migration should
 * call this helper and return the standard structured 503 below.
 *
 * Usage:
 *   if (error) {
 *     if (isMissingTableError(error, "public.tenant_cron_jobs")) {
 *       return NextResponse.json(missingTablePayload({
 *         migration: "database/041_tenant_cron_jobs.sql",
 *         feature: "Automations",
 *       }), { status: 503 });
 *     }
 *     return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
 *   }
 */
export function isMissingTableError(
  err: { message?: string; code?: string } | null | undefined,
  tableHint?: string,
): boolean {
  if (!err) return false;
  // Error codes first — cheap and unambiguous.
  //   PGRST205: PostgREST when the API can't find the table in its
  //             schema cache (most common when the dashboard runs
  //             against Supabase but the SQL migration hasn't applied
  //             yet — cache reloads ~30s after migration).
  //   42P01:    Postgres-direct undefined_table — happens when something
  //             bypasses PostgREST and the relation isn't there.
  if (err.code === "PGRST205" || err.code === "42P01") return true;
  // Fall through to message-pattern matching for cases where the error
  // object lost its code (some PostgREST proxy paths drop it). Two
  // formats to cover both API and direct-SQL responses:
  const msg = err.message || "";
  const lower = msg.toLowerCase();
  if (tableHint && msg.includes(tableHint)) return true;
  if (lower.includes("could not find the table")) return true;     // PostgREST
  if (lower.includes("relation") && lower.includes("does not exist")) return true; // Postgres
  return false;
}

/**
 * Cross-DB unique-constraint classifier. Postgres-direct and PostgREST
 * report unique violations as code 23505, but the Turso/libSQL path reports
 * them as `SQLITE_CONSTRAINT` with the detail only in the message — code is
 * NOT mapped. Routes that insert-then-rotate on conflict (e.g.
 * /api/auth/pair bridge_pairings) must accept BOTH shapes or the rotate
 * branch never fires and a re-pair 500s (seen 2026-08-14: self-pair from a
 * Windows bridge died on `UNIQUE constraint failed:
 * bridge_pairings.tenant_id, bridge_pairings.machine_fingerprint`).
 *
 * EVERY caller routes through here — routes and lib code alike. Sites across
 * the repo carried their own Postgres-only check, each one dead on Turso, and
 * they were swept 2026-08-14. Some used `!== "23505"` to mean "this error is
 * NOT a benign duplicate", which failed the other way round: the branch fired
 * on precisely the duplicates it was meant to wave through.
 *
 * Do not write a fresh `code === "23505"` — tests/unique-violation-classifier.test.ts
 * walks app/ and lib/ and fails the build on the bare literal in any quoting
 * style or comparison, exempting only this file. That test is the live count;
 * a tally written here would be stale by the next sweep.
 */
export function isUniqueViolationError(
  err: { message?: string; code?: string } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === "23505") return true; // Postgres / PostgREST
  const msg = (err.message || "").toLowerCase();
  if (msg.includes("unique constraint failed")) return true; // SQLite / libSQL
  if (msg.includes("duplicate key")) return true; // Postgres message fallback
  return false;
}

/**
 * Bulk-insert a chunk, and on a unique violation keep the rows that are fine.
 *
 * A chunked insert is all-or-nothing: one colliding row fails the statement and
 * takes its 499 neighbours with it. Both cold-list importers responded by
 * counting the WHOLE chunk as duplicates — 499 good leads lost, reported to the
 * operator as a plausible and false number. The founders ingest route had
 * already solved it by retrying row by row; they just never reached that code,
 * because the branch was guarded by a Postgres error code that is dead on Turso.
 *
 * Extracted after I wrote the same retry loop into two files verbatim. Returns
 * counts rather than throwing so callers keep their own error shape; `failure`
 * is set only for an error that is NOT a duplicate, and the caller decides
 * whether that is fatal.
 */
export async function insertChunkSalvagingDuplicates<T>(
  db: { from: (t: string) => any },
  table: string,
  chunk: T[],
  select = "id",
): Promise<{ inserted: number; duplicates: number; failure: { message?: string } | null }> {
  const bulk = await db.from(table).insert(chunk).select(select);
  if (!bulk.error) {
    return { inserted: bulk.data?.length ?? 0, duplicates: 0, failure: null };
  }
  if (!isUniqueViolationError(bulk.error)) {
    return { inserted: 0, duplicates: 0, failure: bulk.error };
  }

  // At least one row collided. Retry individually so the rest still land.
  let inserted = 0;
  let duplicates = 0;
  for (const row of chunk) {
    const one = await db.from(table).insert(row).select(select);
    if (!one.error) inserted += one.data?.length ?? 0;
    else if (isUniqueViolationError(one.error)) duplicates += 1;
    else return { inserted, duplicates, failure: one.error };
  }
  return { inserted, duplicates, failure: null };
}

/**
 * Standard structured 503 payload for the "migration not applied" case.
 * Routes hand this to NextResponse.json with status: 503; UI components
 * branch on `error === "migration_not_applied"` to render the
 * actionable apply_migration.py banner instead of a generic red error.
 *
 * Keeping the shape stable across routes means UI components like
 * CronJobsManager can be re-used / generalized for future migration-
 * gated features without per-feature copy.
 */
export function missingTablePayload(opts: {
  /** Path under database/ — e.g. "database/041_tenant_cron_jobs.sql". */
  migration: string;
  /** Operator-facing feature name — e.g. "Automations", "Forms". */
  feature: string;
}): {
  ok: false;
  error: "migration_not_applied";
  migration: string;
  how_to_apply: string;
  hint: string;
} {
  return {
    ok: false,
    error: "migration_not_applied",
    migration: opts.migration,
    how_to_apply: `python scripts/apply_migration.py ${opts.migration}`,
    hint: `The ${opts.feature} feature needs ${opts.migration.split("/").pop()} applied to your Supabase project. Run the command above on the operator machine. After it completes, Supabase's PostgREST cache picks up the new table within ~30 seconds — refresh the page after that.`,
  };
}
