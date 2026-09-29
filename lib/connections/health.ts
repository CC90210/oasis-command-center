/**
 * lib/connections/health.ts — live probes, and the one function that turns a
 * probe into a recorded status.
 *
 * GREEN MEANS PROVEN (doc 03 a.1 principle 4). A connection is only ever
 * marked healthy here, from a real call to the provider that answered the way
 * a working connection answers. Saving a key proves nothing; the Settings card
 * reads rules.isVerifiedHealthy over what this file recorded.
 *
 * STRIPE. A restricted key is probed with GET requests only — this module has
 * no code path that sends anything else to Stripe:
 *   GET /v1/balance         required: proves the key authenticates, says
 *                           live or test mode, and is what Finance's cash
 *                           view reads.
 *   GET /v1/events?limit=1  required: the Finance sync polls Events (doc 03
 *                           e.3), so a key that cannot read them is degraded.
 *   GET /v1/account         optional: the account id and business name. A
 *                           restricted key may not be allowed to read it;
 *                           then the account id comes from Stripe's own
 *                           permission error ("… on account 'acct_…'"). No
 *                           account id at all means the key cannot be pinned,
 *                           and it is refused.
 * Any 401 is final (the key is dead). A 429, 5xx, timeout or network error is
 * "unknown" — Stripe could not be asked, which is not the same as "broken".
 */
import "server-only";
import type { Client } from "@libsql/client";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import { readTenantCredentialStrict } from "@/lib/tenant-integration-store";
import { providerById, type ProviderDef } from "@/lib/connections/registry";
import {
  HEALTH_RECHECK_AFTER_MS,
  credentialServiceFor,
  mergeVerdicts,
  type ConnectionEnvironment,
  type HealthCheckSource,
  type HealthVerdict,
  type ProbeErrorCode,
} from "@/lib/connections/rules";
import {
  listConnectionsDueForHealth,
  pruneConnectionHistory,
  recordHealthCheck,
  type ConnectionRow,
  type HealthRecordResult,
} from "@/lib/connections/store";

export type FetchImpl = typeof fetch;

/** What every probe returns. `accountId` is what the provider says the credential belongs to. */
export type ProbeResult = {
  verdict: HealthVerdict;
  code: ProbeErrorCode | null;
  /** Plain English, safe to show the owner. Never contains the credential. */
  detail: string | null;
  latencyMs: number;
  accountId: string | null;
  accountLabel: string | null;
  environment: ConnectionEnvironment | null;
};

// ── Stripe ────────────────────────────────────────────────────────────────

const STRIPE_API = "https://api.stripe.com";
const STRIPE_TIMEOUT_MS = 10_000;

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

type StripeCall =
  | { kind: "ok"; body: Obj }
  | { kind: "rejected" } // 401
  | { kind: "forbidden"; accountId: string | null } // 403
  | { kind: "unreachable"; detail: string } // 429 / 5xx / network / timeout
  | { kind: "unexpected"; status: number };

/** "… does not have the required permissions for this endpoint on account 'acct_123'. …" */
export function accountIdFromStripeError(body: unknown): string | null {
  const message = asObj(asObj(body)?.error)?.message;
  if (typeof message !== "string") return null;
  const m = /on account '(acct_[A-Za-z0-9]+)'/.exec(message);
  return m ? m[1] : null;
}

async function stripeGet(key: string, path: string, fetchImpl: FetchImpl): Promise<StripeCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${STRIPE_API}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { kind: "unreachable", detail: aborted ? "timed out" : "network error" };
  } finally {
    clearTimeout(timer);
  }
  const body = asObj(await res.json().catch(() => null));
  if (res.status === 200 && body) return { kind: "ok", body };
  if (res.status === 401) return { kind: "rejected" };
  if (res.status === 403) return { kind: "forbidden", accountId: accountIdFromStripeError(body) };
  if (res.status === 429 || res.status >= 500) return { kind: "unreachable", detail: `HTTP ${res.status}` };
  return { kind: "unexpected", status: res.status };
}

function accountLabelFrom(account: Obj | null, accountId: string): string {
  const settings = asObj(account?.settings);
  const dashboard = asObj(settings?.dashboard);
  const profile = asObj(account?.business_profile);
  const name =
    (typeof dashboard?.display_name === "string" && dashboard.display_name.trim()) ||
    (typeof profile?.name === "string" && profile.name.trim()) ||
    null;
  return name ? `${name} (${accountId})` : `Stripe account ${accountId}`;
}

/**
 * Probe a Stripe restricted key. GET only. The key goes in the Authorization
 * header and nowhere else — not in a log line, not in a result.
 */
export async function probeStripeRestrictedKey(
  key: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const done = (r: Omit<ProbeResult, "latencyMs">): ProbeResult => ({ ...r, latencyMs: Date.now() - started });
  const empty = { accountId: null, accountLabel: null, environment: null } as const;

  const balance = await stripeGet(key, "/v1/balance", fetchImpl);
  if (balance.kind === "rejected") {
    return done({
      ...empty,
      verdict: "down",
      code: "key_rejected",
      detail: "Stripe does not accept this key. It may have been deleted, expired or rolled in Stripe. Paste a new restricted key.",
    });
  }
  const events = await stripeGet(key, "/v1/events?limit=1", fetchImpl);
  const account = await stripeGet(key, "/v1/account", fetchImpl);
  const calls = [balance, events, account];

  if (calls.some((c) => c.kind === "rejected")) {
    return done({
      ...empty,
      verdict: "down",
      code: "key_rejected",
      detail: "Stripe stopped accepting this key partway through the check. Paste a new restricted key.",
    });
  }

  const unreachable = calls.find((c): c is Extract<StripeCall, { kind: "unreachable" }> => c.kind === "unreachable");
  const unexpected = calls.find((c): c is Extract<StripeCall, { kind: "unexpected" }> => c.kind === "unexpected");

  const accountId =
    (account.kind === "ok" && typeof account.body.id === "string" && account.body.id.startsWith("acct_")
      ? account.body.id
      : null) ??
    calls.map((c) => (c.kind === "forbidden" ? c.accountId : null)).find((id): id is string => !!id) ??
    null;

  const livemode = balance.kind === "ok" ? balance.body.livemode : undefined;
  const environment: ConnectionEnvironment | null =
    livemode === true ? "live" : livemode === false ? "test" : key.startsWith("rk_live_") ? "live" : key.startsWith("rk_test_") ? "test" : null;

  const missing: string[] = [];
  if (balance.kind === "forbidden") missing.push("Balance");
  if (events.kind === "forbidden") missing.push("Events");

  const verdicts: HealthVerdict[] = [];
  if (missing.length) verdicts.push("degraded");
  if (unreachable || unexpected) verdicts.push("unknown");
  if (!accountId && !unreachable && !unexpected) verdicts.push("down");
  const verdict = mergeVerdicts(verdicts.length ? verdicts : ["healthy"]);

  const accountLabel = accountId ? accountLabelFrom(account.kind === "ok" ? account.body : null, accountId) : null;

  if (verdict === "down") {
    return done({
      accountId: null,
      accountLabel: null,
      environment,
      verdict,
      code: "account_unidentified",
      detail:
        "Stripe accepted the key but would not say which account it belongs to, so OASIS cannot pin it to your workspace. Create the key from the Stripe account you want to connect and try again.",
    });
  }
  if (verdict === "degraded") {
    return done({
      accountId,
      accountLabel,
      environment,
      verdict,
      code: "missing_permissions",
      detail: `The key works, but Stripe refused to show OASIS: ${missing.join(" and ")}. Edit the key in Stripe (Developers › API keys) and set ${missing.join(" and ")} to Read.`,
    });
  }
  if (verdict === "unknown") {
    return done({
      accountId,
      accountLabel,
      environment,
      verdict,
      code: unreachable ? "provider_unreachable" : "unexpected_response",
      detail: unreachable
        ? `Stripe could not be reached (${unreachable.detail}). OASIS will check again.`
        : `Stripe answered with an unexpected HTTP ${unexpected!.status}. OASIS will check again.`,
    });
  }
  return done({ accountId, accountLabel, environment, verdict: "healthy", code: null, detail: null });
}

/** The live probe for each provider that has one. A provider without one cannot be green. */
const PROBES: Readonly<Record<string, (credential: string, fetchImpl: FetchImpl) => Promise<ProbeResult>>> = {
  stripe: (credential, fetchImpl) => probeStripeRestrictedKey(credential, { fetchImpl }),
};

export function probeFor(provider: string): ((credential: string, fetchImpl: FetchImpl) => Promise<ProbeResult>) | null {
  return PROBES[provider] ?? null;
}

/** Providers the health cron can re-probe: live, and holding a probe. */
export function probedProviders(): string[] {
  return Object.keys(PROBES).filter((id) => providerById(id)?.availability === "live");
}

// ── Probe a stored connection ─────────────────────────────────────────────

export type ConnectionsDeps = {
  db: Client;
  fetchImpl?: FetchImpl;
  now: () => Date;
};

export type AuditActor = { userId: string | null; email: string | null };

const CREDENTIAL_FAILURE: Record<"missing" | "unreadable", { code: ProbeErrorCode; detail: string }> = {
  missing: {
    code: "credential_missing",
    detail: "The saved key is missing. Paste the restricted key again to reconnect.",
  },
  unreadable: {
    code: "credential_unreadable",
    detail: "The saved key could not be decrypted. Paste the restricted key again to reconnect.",
  },
};

/** The stored credential field for a provider. */
function credentialFieldFor(provider: ProviderDef): string {
  if (provider.restrictedKey) return provider.restrictedKey.credentialField;
  throw new Error(`provider_has_no_stored_key:${provider.id}`);
}

/**
 * Probe one stored connection with its own saved credential, compare the
 * account against the pinned one, and record the result. Used by the manual
 * "Test again" route and the health cron.
 *
 * A credential that cannot be READ (database outage) records nothing and
 * throws: that is an OASIS fault, not a fact about the connection.
 */
export async function probeStoredConnection(
  deps: ConnectionsDeps,
  row: ConnectionRow,
  source: HealthCheckSource,
  actor: AuditActor,
): Promise<HealthRecordResult> {
  const provider = providerById(row.provider);
  const probe = provider && provider.availability === "live" ? probeFor(provider.id) : null;
  if (!provider || !probe) throw new Error(`provider_not_probeable:${row.provider}`);

  const credential = await readTenantCredentialStrict(row.tenant_id, credentialServiceFor(row.id), credentialFieldFor(provider));
  let outcome: Pick<ProbeResult, "verdict" | "code" | "detail" | "accountLabel" | "environment"> & { latencyMs: number | null };
  if (!credential.ok) {
    if (credential.reason === "lookup_failed") throw new Error("credential_lookup_failed");
    outcome = { verdict: "down", ...CREDENTIAL_FAILURE[credential.reason], latencyMs: null, accountLabel: null, environment: null };
  } else {
    const result = await probe(credential.value, deps.fetchImpl ?? fetch);
    if (result.accountId && row.external_account_id && result.accountId !== row.external_account_id) {
      // The key now answers for a different account than the one pinned: never
      // let another company's numbers flow into this workspace.
      outcome = {
        verdict: "down",
        code: "account_mismatch",
        detail: `This key now belongs to ${result.accountId}, not the connected account ${row.external_account_id}. OASIS stopped using it. Disconnect and connect the right account.`,
        latencyMs: result.latencyMs,
        accountLabel: null,
        environment: null,
      };
    } else {
      outcome = {
        verdict: result.verdict,
        code: result.code,
        detail: result.detail,
        latencyMs: result.latencyMs,
        accountLabel: result.verdict === "healthy" ? result.accountLabel : null,
        environment: result.verdict === "healthy" ? result.environment : null,
      };
    }
  }

  const recorded = await recordHealthCheck(deps.db, {
    tenantId: row.tenant_id,
    connectionId: row.id,
    source,
    verdict: outcome.verdict,
    code: outcome.code,
    detail: outcome.detail,
    latencyMs: outcome.latencyMs,
    accountLabel: outcome.accountLabel,
    environment: outcome.environment,
    now: deps.now(),
  });
  if (recorded.flipped) {
    await auditConnection({
      tenantId: row.tenant_id,
      actor,
      action: "connection.health_changed",
      connectionId: row.id,
      after: {
        provider: row.provider,
        from: recorded.previousStatus,
        to: recorded.connection.status,
        verdict: outcome.verdict,
        code: outcome.code,
        source,
      },
    });
  }
  return recorded;
}

/**
 * Write to the shared tenant audit log. The write is best-effort by design
 * (logTenantAudit never throws), but a failure is logged loudly, never dropped.
 */
export async function auditConnection(input: {
  tenantId: string;
  actor: AuditActor;
  action: string;
  connectionId: string;
  after: Record<string, unknown>;
}): Promise<void> {
  const res = await logTenantAudit({
    tenantId: input.tenantId,
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    actionType: input.action,
    targetTable: "tenant_connections",
    targetId: input.connectionId,
    after: input.after,
  });
  if (!res.ok) {
    console.error("[connections.audit] audit write failed", {
      tenantId: input.tenantId,
      action: input.action,
      connectionId: input.connectionId,
      error: res.error,
    });
  }
}

// ── The health cron's pass ────────────────────────────────────────────────

export type HealthPassResult = {
  checked: number;
  healthy: number;
  flipped: Array<{ connection_id: string; provider: string; from: string; to: string }>;
  errors: Array<{ connection_id: string; provider: string; error: string }>;
  pruned: { healthChecksDeleted: number; oauthStatesDeleted: number };
};

/**
 * One pass: re-probe every live connection whose last check is older than
 * HEALTH_RECHECK_AFTER_MS (oldest first, up to `limit`, `concurrency` at a
 * time — each probe is a few sequential Stripe calls, and different keys have
 * separate Stripe rate limits), then trim old history. Run every 15 minutes, a
 * pass of 40 keeps up to ~160 connections re-probed each hour. One connection
 * throwing never strands the rest; it is reported in `errors`, and the route
 * turns a non-empty `errors` into a 500 so the cron runner sees it.
 */
export async function runConnectionHealthPass(
  deps: ConnectionsDeps,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<HealthPassResult> {
  const now = deps.now();
  const due = await listConnectionsDueForHealth(deps.db, {
    providers: probedProviders(),
    staleBefore: new Date(now.getTime() - HEALTH_RECHECK_AFTER_MS),
    limit: opts.limit ?? 40,
  });
  const result: HealthPassResult = {
    checked: 0,
    healthy: 0,
    flipped: [],
    errors: [],
    pruned: { healthChecksDeleted: 0, oauthStatesDeleted: 0 },
  };
  const queue = [...due];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) await probeOne(row);
  };
  const probeOne = async (row: ConnectionRow) => {
    try {
      const recorded = await probeStoredConnection(deps, row, "cron", { userId: null, email: null });
      result.checked += 1;
      if (recorded.connection.last_health_verdict === "healthy") result.healthy += 1;
      if (recorded.flipped) {
        result.flipped.push({
          connection_id: row.id,
          provider: row.provider,
          from: recorded.previousStatus,
          to: recorded.connection.status,
        });
      }
    } catch (err) {
      console.error("[connections.health_pass] probe threw", {
        tenantId: row.tenant_id,
        connectionId: row.id,
        provider: row.provider,
        error: err instanceof Error ? err.stack : err,
      });
      result.errors.push({
        connection_id: row.id,
        provider: row.provider,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  };
  const lanes = Math.max(1, Math.min(opts.concurrency ?? 5, queue.length || 1));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  result.pruned = await pruneConnectionHistory(deps.db, now);
  return result;
}
