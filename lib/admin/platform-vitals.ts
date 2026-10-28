/**
 * lib/admin/platform-vitals.ts - System health's "Platform vitals" strip (2026-10-28).
 *
 * Infrastructure, in numbers, each one live, "no data yet", "not connected" or failed, never a guessed 0
 * (components/os/KpiTile.tsx):
 *   - database: one SELECT 1 to Turso, timed, with a 1.5 s deadline;
 *   - AI calls in the last 24 hours (ai_usage_events): how many, how many failed, the median latency;
 *   - browser errors in the last 24 hours (client_error_reports, stored since #545 and shown nowhere until now);
 *   - health checks in the last 24 hours (health_check_runs): ok / degraded / failing runs;
 *   - the Cloudflare Worker over 24 hours: requests, errors, CPU (GraphQL Analytics,
 *     workersInvocationsAdaptive). It needs a READ-ONLY analytics token in the Worker
 *     (CLOUDFLARE_ANALYTICS_TOKEN, never the deploy token) and the account id; until both exist the
 *     tile says "not connected" with what to add.
 * Every read is tenant-scoped except the Worker's (one Worker serves every workspace; the page is
 * operator-only). Each read fails on its own: one broken source never blanks the strip.
 */
import "server-only";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export type Vital<T> =
  | { state: "live"; value: T }
  | { state: "no_data" }
  | { state: "not_connected"; reason: string }
  | { state: "error" };

export type PlatformVitals = {
  databaseMs: Vital<number>;
  ai24h: Vital<{ calls: number; failed: number; p50Ms: number | null }>;
  browserErrors24h: Vital<number>;
  checks24h: Vital<{ ok: number; degraded: number; failing: number }>;
  worker24h: Vital<{ requests: number; errors: number; cpuP50Ms: number; cpuP99Ms: number }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DB_DEADLINE_MS = 1_500;
const WORKER_SCRIPT = "oasis-command-center";

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function databaseRoundTrip(): Promise<Vital<number>> {
  if (!tursoConfigured()) return { state: "not_connected", reason: "No database is configured." };
  const started = Date.now();
  try {
    await withDeadline(getTursoClient().execute("SELECT 1"), DB_DEADLINE_MS);
    return { state: "live", value: Date.now() - started };
  } catch (err) {
    console.error("[platform-vitals.database]", err instanceof Error ? err.message : String(err));
    return { state: "error" };
  }
}

async function aiCalls(tenantId: string, sinceIso: string): Promise<PlatformVitals["ai24h"]> {
  try {
    const db = getTursoClient();
    const totals = await db.execute({
      sql: "SELECT count(*) AS calls, sum(CASE WHEN outcome = 'ok' THEN 0 ELSE 1 END) AS failed FROM ai_usage_events WHERE tenant_id = ? AND occurred_at >= ?",
      args: [tenantId, sinceIso],
    });
    const calls = Number(totals.rows[0]?.calls ?? 0);
    if (calls === 0) return { state: "no_data" };
    const timed = await db.execute({
      sql: "SELECT count(*) AS n FROM ai_usage_events WHERE tenant_id = ? AND occurred_at >= ? AND latency_ms IS NOT NULL",
      args: [tenantId, sinceIso],
    });
    const n = Number(timed.rows[0]?.n ?? 0);
    let p50Ms: number | null = null;
    if (n > 0) {
      const median = await db.execute({
        sql: "SELECT latency_ms FROM ai_usage_events WHERE tenant_id = ? AND occurred_at >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms LIMIT 1 OFFSET ?",
        args: [tenantId, sinceIso, Math.floor((n - 1) / 2)],
      });
      p50Ms = median.rows[0] ? Number(median.rows[0].latency_ms) : null;
    }
    return { state: "live", value: { calls, failed: Number(totals.rows[0]?.failed ?? 0), p50Ms } };
  } catch (err) {
    console.error("[platform-vitals.ai]", err instanceof Error ? err.message : String(err));
    return { state: "error" };
  }
}

async function browserErrors(tenantId: string, sinceIso: string): Promise<Vital<number>> {
  try {
    const rs = await getTursoClient().execute({
      sql: "SELECT count(*) AS n FROM client_error_reports WHERE tenant_id = ? AND created_at >= ?",
      args: [tenantId, sinceIso],
    });
    return { state: "live", value: Number(rs.rows[0]?.n ?? 0) };
  } catch (err) {
    console.error("[platform-vitals.browser_errors]", err instanceof Error ? err.message : String(err));
    return { state: "error" };
  }
}

async function healthChecks(tenantId: string, sinceIso: string): Promise<PlatformVitals["checks24h"]> {
  try {
    const rs = await getTursoClient().execute({
      sql: "SELECT verdict, count(*) AS n FROM health_check_runs WHERE tenant_id = ? AND ran_at >= ? GROUP BY verdict",
      args: [tenantId, sinceIso],
    });
    const by = new Map(rs.rows.map((r) => [String(r.verdict), Number(r.n)]));
    const ok = by.get("ok") ?? 0;
    const degraded = by.get("degraded") ?? 0;
    const failing = by.get("failing") ?? 0;
    return ok + degraded + failing === 0 ? { state: "no_data" } : { state: "live", value: { ok, degraded, failing } };
  } catch (err) {
    console.error("[platform-vitals.health_checks]", err instanceof Error ? err.message : String(err));
    return { state: "error" };
  }
}

const WORKER_QUERY = `query Vitals($accountTag: string!, $from: Time!, $to: Time!, $script: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;

/** The Worker's own 24 hours. `fetchImpl` and `env` are seams for tests. */
export async function workerVitals(
  now: number,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformVitals["worker24h"]> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !account) {
    return { state: "not_connected", reason: "Add a read-only Cloudflare Analytics token and the account id to the Worker to see its requests, errors and CPU." };
  }
  try {
    const res = await withDeadline(
      fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: WORKER_QUERY,
          variables: {
            accountTag: account,
            from: new Date(now - DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
            to: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
            script: WORKER_SCRIPT,
          },
        }),
      }),
      5_000,
    );
    if (!res.ok) throw new Error(`analytics_http_${res.status}`);
    const body = (await res.json()) as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number; errors?: number }; quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number } }> }> } };
      errors?: unknown;
    };
    if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error("analytics_graphql_error");
    const row = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0];
    if (!row) return { state: "no_data" };
    // cpuTime quantiles are microseconds.
    return {
      state: "live",
      value: {
        requests: Number(row.sum?.requests ?? 0),
        errors: Number(row.sum?.errors ?? 0),
        cpuP50Ms: Math.round(Number(row.quantiles?.cpuTimeP50 ?? 0) / 100) / 10,
        cpuP99Ms: Math.round(Number(row.quantiles?.cpuTimeP99 ?? 0) / 100) / 10,
      },
    };
  } catch (err) {
    console.error("[platform-vitals.worker]", err instanceof Error ? err.message : String(err));
    return { state: "error" };
  }
}

export async function loadPlatformVitals(tenantId: string, now: number = Date.now()): Promise<PlatformVitals> {
  const sinceIso = new Date(now - DAY_MS).toISOString();
  const [databaseMs, ai24h, browserErrors24h, checks24h, worker24h] = await Promise.all([
    databaseRoundTrip(),
    aiCalls(tenantId, sinceIso),
    browserErrors(tenantId, sinceIso),
    healthChecks(tenantId, sinceIso),
    workerVitals(now),
  ]);
  return { databaseMs, ai24h, browserErrors24h, checks24h, worker24h };
}
