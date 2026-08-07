/**
 * Supabase server-side client factories.
 *
 * Two clients, two roles:
 *   - getServiceSupabase() — service role, bypasses RLS, used for internal
 *     queries the dashboard needs (cross-tenant admin views, etc.)
 *   - getAuthedSupabase()  — anon key + the user's session cookie. RLS
 *     enforces tenant isolation. This is the safe default for any query
 *     scoped to "the logged-in user's tenant."
 *
 * The session is read from Next.js cookies via @supabase/ssr.
 */

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { createTursoPostgrest } from "@/lib/turso-postgrest";
import { TURSO_RPC_SHIM } from "@/lib/turso-rpc-shim";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";

let _serviceCached: SupabaseClient | null = null;
let _hybridCached: SupabaseClient | null = null;

type RpcShape = {
  data: unknown;
  error: { message: string; code?: string; details?: unknown; hint?: unknown } | null;
  count: number | null;
  status: number;
  statusText: string;
};

/**
 * Make an rpc() result chainable, the way supabase-js's PostgrestFilterBuilder is.
 *
 * The proxy used to return a bare Promise. Real supabase-js returns a builder,
 * so any `.rpc(...).abortSignal(sig)` — or .single(), .maybeSingle(),
 * .throwOnError() — was a TypeError thrown INSIDE the caller's try block.
 *
 * That took down every TextTorrent SMS path: operator replies, per-lead SMS,
 * drip SMS steps, scheduled sends, inbox sync. Each surfaced as a 503
 * "rate_limiter_unavailable", which reads like a vendor outage. tsc could not
 * catch it because getServiceSupabase() is typed as SupabaseClient.
 *
 * abortSignal is honoured rather than accepted-and-ignored — the caller uses it
 * as a timeout, and silently dropping it would turn a fast failure into a hang.
 */
function chainableRpc(promise: Promise<RpcShape>): Promise<RpcShape> {
  const api = {
    then: (...a: Parameters<Promise<RpcShape>["then"]>) => promise.then(...a),
    catch: (...a: Parameters<Promise<RpcShape>["catch"]>) => promise.catch(...a),
    finally: (...a: Parameters<Promise<RpcShape>["finally"]>) => promise.finally(...a),

    abortSignal(signal: AbortSignal) {
      return chainableRpc(new Promise<RpcShape>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        const onAbort = () =>
          reject(new DOMException("The operation was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
          (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
        );
      }));
    },

    single() {
      return chainableRpc(promise.then((r) => ({
        ...r,
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
      })));
    },
    maybeSingle() {
      return api.single();
    },
    // PostgREST's .select() on an rpc() shapes the returned columns; the shim
    // already returns full rows, so this is an accepted no-op rather than an
    // error — refusing it would break callers for no behavioural gain.
    select() {
      return api;
    },
    throwOnError() {
      return chainableRpc(promise.then((r) => {
        if (r.error) throw new Error(r.error.message);
        return r;
      }));
    },
  };
  return api as unknown as Promise<RpcShape>;
}

function makeSupabaseService(): SupabaseClient {
  if (_serviceCached) return _serviceCached;
  const url = process.env.BRAVO_SUPABASE_URL;
  const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // Turso mode does not need Supabase credentials, but this factory used to
    // demand them anyway: the hybrid proxy wraps a REAL client, so constructing
    // it threw before any routing could happen.
    //
    // That is a cancellation blocker, not a config nicety. The day the Supabase
    // project is deleted these env vars go away, and every one of the 205
    // service-role routes would throw here — with data, auth and storage all
    // already migrated and working. Found because a local Turso-mode run
    // happened to lack the vars and accidentally simulated post-cancellation.
    //
    // So under Turso mode, hand back a stub whose data surface the proxy
    // replaces wholesale. Anything the proxy does NOT intercept (auth, channel)
    // throws a message naming the real problem instead of a generic
    // "misconfigured".
    if (process.env.EMPIRE_DATA_BACKEND === "turso_cloud") {
      _serviceCached = new Proxy({} as SupabaseClient, {
        get(_t, prop) {
          throw new Error(
            `supabase.${String(prop)} is unavailable: Supabase is not configured and ` +
            `EMPIRE_DATA_BACKEND=turso_cloud. Data goes through the Turso adapter, ` +
            `storage through R2, and auth through the turso-* routes — this surface ` +
            `has no replacement yet and must be ported.`
          );
        },
      });
      return _serviceCached;
    }
    throw new Error(
      "Service Supabase misconfigured: BRAVO_SUPABASE_URL + BRAVO_SUPABASE_SERVICE_ROLE_KEY required."
    );
  }
  _serviceCached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceCached;
}

/**
 * Service client — THE data-plane switch for all 205 service-role routes.
 *
 * EMPIRE_DATA_BACKEND=turso_cloud routes every `.from()` table read/write to the
 * Turso adapter while `auth` / `storage` / `rpc` / `channel` keep hitting the
 * real Supabase client (auth + file storage have not migrated — see the
 * migration plan). Any other value, or missing Turso config, is 100% Supabase.
 * Rollback is therefore one env var, no deploy.
 *
 * `rpc` FAILS CLOSED under Turso mode. The first design delegated rpc to
 * Supabase "until each is ported" — an adversarial review traced a concrete
 * split-brain through app/api/applications/[id]/edit: verify the record in
 * Turso, patch_tenant_record_data WRITES Postgres, reread from Turso → success
 * reported, stale data returned, and the databases permanently diverge. A
 * loud 400 naming the unported RPC is strictly better than that. Read-only
 * RPCs that have been explicitly verified safe can be listed in
 * TURSO_RPC_PASSTHROUGH (comma-separated) to delegate to Supabase.
 */
const RPC_PASSTHROUGH = new Set(
  (process.env.TURSO_RPC_PASSTHROUGH ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

export function getServiceSupabase(): SupabaseClient {
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) {
    return makeSupabaseService();
  }
  if (_hybridCached) return _hybridCached;
  const supa = makeSupabaseService();
  const turso = createTursoPostgrest(getTursoClient());
  _hybridCached = new Proxy(supa, {
    get(target, prop, receiver) {
      if (prop === "from") return (table: string) => turso.from(table);
      if (prop === "rpc") {
        return (name: string, args?: Record<string, unknown>) => {
          // Ported RPCs run on Turso — same database the tables live in, so no
          // split-brain. Shape matches supabase-js: resolves { data, error }.
          const shimmed = TURSO_RPC_SHIM[name];
          if (shimmed) {
            return chainableRpc(shimmed(getTursoClient(), args ?? {}).then(
              (data) => ({ data, error: null, count: null, status: 200, statusText: "OK" }),
              (e: unknown) => ({
                data: null, count: null, status: 400, statusText: "Bad Request",
                error: { message: e instanceof Error ? e.message : String(e),
                         code: "TURSO_RPC_ERROR", details: null, hint: null },
              }),
            ));
          }
          if (RPC_PASSTHROUGH.has(name)) return target.rpc(name, args);
          // Thenable error response, matching supabase-js's non-throwing shape.
          return chainableRpc(Promise.resolve({
            data: null,
            count: null,
            status: 400,
            statusText: "Bad Request",
            error: {
              message:
                `rpc("${name}") is blocked under EMPIRE_DATA_BACKEND=turso_cloud: ` +
                `PL/pgSQL did not migrate, and delegating to Postgres while tables ` +
                `read from Turso splits writes across databases. Port the RPC, or — ` +
                `only if it is verified read-only — add it to TURSO_RPC_PASSTHROUGH.`,
              code: "TURSO_RPC_BLOCKED",
              details: null,
              hint: null,
            },
          }));
        };
      }
      // Storage: Turso has no object store, so `.storage` routes to R2 when
      // it is configured. Intercepting here rather than editing 23 call sites
      // across 11 files — the same approach `.from()` and `.rpc()` already use.
      // Without this, `.storage` passed straight through to Supabase and stayed
      // a hard dependency no matter what the data plane did.
      if (prop === "storage" && r2Configured()) {
        return r2StorageSurface();
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClient;
  return _hybridCached;
}

/** Authed Supabase — RLS enforced via the user's session.
 *
 * Under EMPIRE_DATA_BACKEND=turso_cloud this client's DATA surface routes to
 * Turso exactly like the service client: .from() -> adapter, .rpc() -> shim.
 * Without this, routes that log audit events via authed.rpc("log_tenant_event")
 * kept writing Supabase after the flip — a bounded but real split-brain
 * (caught in the post-flip self-review). Auth methods stay on the real client.
 */
export async function getAuthedSupabase() {
  const supa = await makeAuthedSupabase();
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) {
    return supa;
  }
  const turso = createTursoPostgrest(getTursoClient());
  return new Proxy(supa, {
    get(target, prop, receiver) {
      if (prop === "from") return (table: string) => turso.from(table);
      if (prop === "rpc") {
        return (name: string, args?: Record<string, unknown>) => {
          const shimmed = TURSO_RPC_SHIM[name];
          if (shimmed) {
            return chainableRpc(shimmed(getTursoClient(), args ?? {}).then(
              (data) => ({ data, error: null, count: null, status: 200, statusText: "OK" }),
              (e: unknown) => ({
                data: null, count: null, status: 400, statusText: "Bad Request",
                error: { message: e instanceof Error ? e.message : String(e),
                         code: "TURSO_RPC_ERROR", details: null, hint: null },
              }),
            ));
          }
          if (RPC_PASSTHROUGH.has(name)) return target.rpc(name, args);
          return chainableRpc(Promise.resolve({
            data: null, count: null, status: 400, statusText: "Bad Request",
            error: { message: `rpc("${name}") is blocked under EMPIRE_DATA_BACKEND=turso_cloud`,
                     code: "TURSO_RPC_BLOCKED", details: null, hint: null },
          }));
        };
      }
      // Storage: Turso has no object store, so `.storage` routes to R2 when
      // it is configured. Intercepting here rather than editing 23 call sites
      // across 11 files — the same approach `.from()` and `.rpc()` already use.
      // Without this, `.storage` passed straight through to Supabase and stayed
      // a hard dependency no matter what the data plane did.
      if (prop === "storage" && r2Configured()) {
        return r2StorageSurface();
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Awaited<ReturnType<typeof makeAuthedSupabase>>;
}

async function makeAuthedSupabase() {
  const url = process.env.BRAVO_SUPABASE_URL;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.BRAVO_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "Authed Supabase misconfigured: BRAVO_SUPABASE_URL + anon key required."
    );
  }
  const cookieStore = await cookies();
  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component — set is a no-op there
        }
      },
    },
  });
}

/** Resolve the currently signed-in user. Returns null if unauthenticated.
 *
 * Turso auth mode: identity comes from OUR HMAC session cookie, verified here
 * directly. The returned object keeps the two fields every caller actually
 * uses (id, email) with the same auth.users uuid — role lookups downstream
 * are unchanged. Supabase mode is byte-identical to before.
 */
export async function getSessionUser() {
  if (process.env.EMPIRE_AUTH_BACKEND === "turso" && process.env.AUTH_SESSION_SECRET) {
    const { cookies } = await import("next/headers");
    const { verifySession, SESSION_COOKIE } = await import("@/lib/turso-auth");
    const store = await cookies();
    const session = verifySession(store.get(SESSION_COOKIE)?.value);
    if (!session) return null;
    // user_metadata is present-but-empty: callers optional-chain into it for
    // display names and fall back to the email local-part, which is exactly
    // the degradation we want until profile metadata is served from Turso.
    return {
      id: session.sub,
      email: session.email,
      user_metadata: {} as Record<string, unknown>,
    };
  }
  const supa = await getAuthedSupabase();
  const { data, error } = await supa.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
