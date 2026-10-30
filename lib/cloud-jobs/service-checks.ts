import type { Client, InStatement } from "@libsql/client";
import {
  OASIS_OPERATOR_TENANT_ID,
  operatorEmail,
  type EnvLike,
} from "@/lib/cloud-jobs/control";

export const SERVICE_CHECK_NAMES = [
  "cloudflare",
  "hostinger",
  "github",
  "firecrawl",
  "wise",
] as const;

export type ServiceCheckName = (typeof SERVICE_CHECK_NAMES)[number];
export type HealthVerdict = "healthy" | "degraded" | "down";

export type ServiceCheckResult = {
  service: ServiceCheckName;
  http: number | null;
  status: HealthVerdict | "configured" | "no_key";
  recorded: boolean;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ServiceCheckDeps = {
  db: Pick<Client, "execute">;
  env?: EnvLike;
  fetchImpl?: FetchLike;
  now?: () => Date;
  dryRun?: boolean;
};

const UA = "oasis-command-center-service-checks/1.0";
const HOSTINGER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function first(env: EnvLike, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function configuredServiceChecks(env: EnvLike): Record<ServiceCheckName, boolean> {
  return {
    cloudflare: Boolean(first(env, "CLOUDFLARE_WORKERS_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TOKEN")),
    hostinger: Boolean(first(env, "HOSTINGER_API_TOKEN", "HOSTSTINGER_KEY", "HOSTINGER_KEY", "HOSTINGER_TOKEN")),
    github: Boolean(first(env, "GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN")),
    firecrawl: Boolean(first(env, "FIRECRAWL_API_KEY")),
    wise: Boolean(first(env, "WISE_API_TOKEN", "OASIS_COMMAND_CENTER__WISE_API_TOKEN")),
  };
}

export function serviceHealthVerdict(status: number): { status: HealthVerdict; error: string | null } {
  if (status >= 200 && status < 300) return { status: "healthy", error: null };
  if (status === 401 || status === 403) {
    return { status: "down", error: `the key was refused (HTTP ${status})` };
  }
  if (status === 0) return { status: "degraded", error: "the service could not be reached" };
  return { status: "degraded", error: `the service answered HTTP ${status}` };
}

async function getStatus(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<number> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "user-agent": UA, accept: "application/json", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return 0;
  }
}

async function checkCloudflare(env: EnvLike, fetchImpl: FetchLike): Promise<number | null> {
  const token = first(env, "CLOUDFLARE_WORKERS_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TOKEN");
  if (!token) return null;
  const headers = { authorization: `Bearer ${token}` };
  let status = await getStatus("https://api.cloudflare.com/client/v4/user/tokens/verify", headers, fetchImpl);
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!(status >= 200 && status < 300) && account) {
    status = await getStatus(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/tokens/verify`,
      headers,
      fetchImpl,
    );
  }
  return status;
}

async function checkHostinger(env: EnvLike, fetchImpl: FetchLike): Promise<number | null> {
  const token = first(env, "HOSTINGER_API_TOKEN", "HOSTSTINGER_KEY", "HOSTINGER_KEY", "HOSTINGER_TOKEN");
  if (!token) return null;
  return getStatus(
    "https://developers.hostinger.com/api/vps/v1/virtual-machines",
    { authorization: `Bearer ${token}`, "user-agent": HOSTINGER_UA },
    fetchImpl,
  );
}

async function checkGithub(env: EnvLike, fetchImpl: FetchLike): Promise<number | null> {
  const token = first(env, "GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN");
  if (!token) return null;
  return getStatus(
    "https://api.github.com/user",
    { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    fetchImpl,
  );
}

async function checkFirecrawl(env: EnvLike, fetchImpl: FetchLike): Promise<number | null> {
  const token = first(env, "FIRECRAWL_API_KEY");
  if (!token) return null;
  return getStatus(
    "https://api.firecrawl.dev/v1/team/credit-usage",
    { authorization: `Bearer ${token}` },
    fetchImpl,
  );
}

async function checkWise(env: EnvLike, fetchImpl: FetchLike): Promise<number | null> {
  const token = first(env, "WISE_API_TOKEN", "OASIS_COMMAND_CENTER__WISE_API_TOKEN");
  if (!token) return null;
  return getStatus(
    "https://api.transferwise.com/v2/profiles",
    { authorization: `Bearer ${token}` },
    fetchImpl,
  );
}

const CHECKS: Record<ServiceCheckName, (env: EnvLike, fetchImpl: FetchLike) => Promise<number | null>> = {
  cloudflare: checkCloudflare,
  hostinger: checkHostinger,
  github: checkGithub,
  firecrawl: checkFirecrawl,
  wise: checkWise,
};

async function resolveOperatorProfile(
  db: Pick<Client, "execute">,
  env: EnvLike,
): Promise<{ profileId: string; tenantId: string }> {
  const rowset = await db.execute({
    sql: `SELECT id, tenant_id
          FROM user_profiles
          WHERE tenant_id = ? AND lower(email) = ? AND deactivated_at IS NULL
          LIMIT 2`,
    args: [OASIS_OPERATOR_TENANT_ID, operatorEmail(env)],
  });
  if (rowset.rows.length !== 1) {
    throw new Error(`service_checks_operator_scope_invalid:${rowset.rows.length}`);
  }
  const profileId = String(rowset.rows[0].id || "");
  const tenantId = String(rowset.rows[0].tenant_id || "");
  if (!profileId || tenantId !== OASIS_OPERATOR_TENANT_ID) {
    throw new Error("service_checks_operator_scope_invalid");
  }
  return { profileId, tenantId };
}

async function recordHealth(
  db: Pick<Client, "execute">,
  scope: { profileId: string; tenantId: string },
  service: ServiceCheckName,
  status: HealthVerdict,
  error: string | null,
  http: number,
  now: Date,
): Promise<boolean> {
  const at = now.toISOString();
  const statement: InStatement = {
    sql: `INSERT INTO integrations_health
            (tenant_id, profile_id, service, status, last_ping_at, last_error, metadata, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, service) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            status = excluded.status,
            last_ping_at = excluded.last_ping_at,
            last_error = excluded.last_error,
            metadata = excluded.metadata,
            updated_at = excluded.updated_at
          WHERE integrations_health.tenant_id = excluded.tenant_id`,
    args: [
      scope.tenantId,
      scope.profileId,
      service,
      status,
      at,
      error,
      JSON.stringify({ source: "service_check", http, _runtime: "cloudflare" }),
      at,
    ],
  };
  const result = await db.execute(statement);
  return result.rowsAffected === 1;
}

export async function runServiceChecks(deps: ServiceCheckDeps): Promise<{
  ok: boolean;
  dry_run: boolean;
  dry_run_scope: "config_only" | "live";
  missing: ServiceCheckName[];
  results: ServiceCheckResult[];
}> {
  const env = deps.env ?? process.env;
  const configured = configuredServiceChecks(env);
  const missing = SERVICE_CHECK_NAMES.filter((service) => !configured[service]);
  if (deps.dryRun) {
    return {
      ok: missing.length === 0,
      dry_run: true,
      dry_run_scope: "config_only",
      missing,
      results: SERVICE_CHECK_NAMES.map((service) => ({
        service,
        http: null,
        status: configured[service] ? "configured" : "no_key",
        recorded: false,
      })),
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const statuses = await Promise.all(SERVICE_CHECK_NAMES.map((service) => CHECKS[service](env, fetchImpl)));
  const scope = await resolveOperatorProfile(deps.db, env);
  const now = deps.now?.() ?? new Date();
  const results: ServiceCheckResult[] = [];
  for (let i = 0; i < SERVICE_CHECK_NAMES.length; i += 1) {
    const service = SERVICE_CHECK_NAMES[i];
    const http = statuses[i];
    if (http === null) {
      results.push({ service, http: null, status: "no_key", recorded: false });
      continue;
    }
    const verdict = serviceHealthVerdict(http);
    const recorded = await recordHealth(deps.db, scope, service, verdict.status, verdict.error, http, now);
    results.push({ service, http, status: verdict.status, recorded });
  }
  const failed = results.some(
    (result) => result.status === "no_key" || result.status === "down" || (result.http !== null && !result.recorded),
  );
  return { ok: !failed, dry_run: false, dry_run_scope: "live", missing, results };
}
