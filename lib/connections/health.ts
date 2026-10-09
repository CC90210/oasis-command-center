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
 *   one GET per advertised   required: every Read permission the setup steps
 *   Read permission          ask for (registry STRIPE_READ_PERMISSIONS) is
 *   (STRIPE_PERMISSION_      proven by reading it — /v1/balance, then one row
 *   PROBES)                  (limit=1) of each list. A key missing any of them
 *                            is degraded and says which ("Missing: Invoices
 *                            read"), so a card is never green, and a connect
 *                            never records, a scope the key cannot use.
 *                            /v1/balance also says live or test mode.
 *   GET /v1/account          optional: the account id and business name. A
 *                            restricted key may not be allowed to read it;
 *                            then the account id comes from Stripe's own
 *                            permission error ("… on account 'acct_…'"). No
 *                            account id at all means the key cannot be pinned,
 *                            and it is refused.
 * The GETs run in parallel under ONE deadline that also covers reading each
 * body, so a probe finishes within STRIPE_TIMEOUT_MS whatever Stripe does.
 * Any 401 is final (the key is dead). A 429, 5xx, timeout or network error is
 * "unknown" — Stripe could not be asked, which is not the same as "broken".
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import { publishAgentEvent, type AgentEventPublish } from "@/lib/manifest/events";
import { readTenantCredentialStrict } from "@/lib/tenant-integration-store";
import { STRIPE_READ_PERMISSIONS, providerById, providerForEnv, type ProviderDef } from "@/lib/connections/registry";
import { probeJevKey } from "@/lib/jev/client";
import { connectorBySlug } from "@/lib/os/connectors";
import { setupHref } from "@/lib/setup-links";
import { authTest as slackAuthTest } from "@/lib/slack/client";
import {
  BOT_TOKEN_FIELD,
  HEALTH_RECHECK_AFTER_MS,
  credentialServiceFor,
  isVerifiedHealthy,
  mergeVerdicts,
  type ConnectionEnvironment,
  type ConnectionStatus,
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
/** One deadline for a whole Stripe probe: every GET, headers and body. */
export const STRIPE_TIMEOUT_MS = 10_000;

/**
 * A Worker keeps at most 6 fetches waiting for response headers; any more
 * queue inside the runtime while their probe's deadline runs. So one probe
 * sends at most this many GETs at once, and the health pass runs one probe at
 * a time (HEALTH_PASS_CONCURRENCY): a probe's waiting is then only ever behind
 * its own requests — 13 GETs in three rounds — never behind another probe's
 * (CodeRabbit #472).
 */
export const STRIPE_MAX_IN_FLIGHT = 6;

/** `fn` over `items`, at most `limit` at once, results in input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * The GET that proves each Read permission OASIS asks the owner for. Keys are
 * exactly registry STRIPE_READ_PERMISSIONS (tests/os-connections.test.ts holds
 * the two together), so adding a permission to the setup steps without a probe
 * fails CI. List endpoints ask for one row.
 */
export const STRIPE_PERMISSION_PROBES: Readonly<Record<string, string>> = {
  Balance: "/v1/balance",
  "Balance transactions": "/v1/balance_transactions?limit=1",
  Charges: "/v1/charges?limit=1",
  Refunds: "/v1/refunds?limit=1",
  Customers: "/v1/customers?limit=1",
  Disputes: "/v1/disputes?limit=1",
  Events: "/v1/events?limit=1",
  Invoices: "/v1/invoices?limit=1",
  Payouts: "/v1/payouts?limit=1",
  Prices: "/v1/prices?limit=1",
  Products: "/v1/products?limit=1",
  Subscriptions: "/v1/subscriptions?limit=1",
};

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

/**
 * `work`, or a rejection the moment `signal` aborts — whichever comes first. A
 * fetch honours its signal for the headers, but nothing makes an arbitrary
 * body promise (or a fetch that ignores its signal) give up, so the deadline
 * is enforced here rather than trusted to the callee.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * One GET under the probe's shared deadline. The deadline stays armed until the
 * body is read: headers that arrive on time followed by a body that never does
 * are "timed out", not a hang.
 */
async function stripeGet(key: string, path: string, fetchImpl: FetchImpl, signal: AbortSignal): Promise<StripeCall> {
  let res: Response;
  try {
    res = await untilAborted(
      fetchImpl(`${STRIPE_API}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal,
      }),
      signal,
    );
  } catch {
    return { kind: "unreachable", detail: signal.aborted ? "timed out" : "network error" };
  }
  let body: Obj | null;
  try {
    body = asObj(await untilAborted(res.json(), signal));
  } catch {
    if (signal.aborted) return { kind: "unreachable", detail: "timed out" };
    body = null; // not JSON: judged on the status alone, as before
  }
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
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const done = (r: Omit<ProbeResult, "latencyMs">): ProbeResult => ({ ...r, latencyMs: Date.now() - started });
  const empty = { accountId: null, accountLabel: null, environment: null } as const;

  const reads = STRIPE_READ_PERMISSIONS.map((permission) => {
    const path = STRIPE_PERMISSION_PROBES[permission];
    if (!path) throw new Error(`stripe_permission_has_no_probe:${permission}`);
    return { permission, path };
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? STRIPE_TIMEOUT_MS);
  let account: StripeCall;
  let results: StripeCall[];
  try {
    // At most STRIPE_MAX_IN_FLIGHT at once: the rest wait here, on this
    // probe's own clock, instead of in the Worker's connection queue behind
    // another probe's requests.
    [account, ...results] = await mapLimited(
      ["/v1/account", ...reads.map((r) => r.path)],
      STRIPE_MAX_IN_FLIGHT,
      (path) => stripeGet(key, path, fetchImpl, controller.signal),
    );
  } finally {
    clearTimeout(timer);
  }
  const balance = results[reads.findIndex((r) => r.permission === "Balance")] ?? null;
  const calls = [account, ...results];

  if (calls.some((c) => c.kind === "rejected")) {
    return done({
      ...empty,
      verdict: "down",
      code: "key_rejected",
      detail:
        balance?.kind === "rejected"
          ? "Stripe does not accept this key. It may have been deleted, expired or rolled in Stripe. Paste a new restricted key."
          : "Stripe stopped accepting this key partway through the check. Paste a new restricted key.",
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

  const livemode = balance?.kind === "ok" ? balance.body.livemode : undefined;
  const environment: ConnectionEnvironment | null =
    livemode === true ? "live" : livemode === false ? "test" : key.startsWith("rk_live_") ? "live" : key.startsWith("rk_test_") ? "test" : null;

  // Every advertised permission Stripe refused, in the order the setup steps list them.
  const missing = reads.filter((_, i) => results[i].kind === "forbidden").map((r) => r.permission);

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
      detail: `Missing: ${missing.map((p) => `${p} read`).join(", ")}. The key works, but Stripe refused to show OASIS ${missing.length === 1 ? "that" : "those"}. Edit the key in Stripe (Developers › API keys) and set ${missing.length === 1 ? "it" : "each"} to Read.`,
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

/** A provider's live probe. `timeoutMs` bounds the whole probe (default: the provider's own deadline). */
export type Probe = (credential: string, fetchImpl: FetchImpl, timeoutMs?: number) => Promise<ProbeResult>;

/**
 * A TypeSafe key has no account id to pin, so the connection pins a fingerprint
 * of the key itself: the same key reconnects to its own row, and another key
 * while one is live is a different account (disconnect first). Never the key.
 */
export function jevKeyFingerprint(key: string): string {
  return `key:${createHash("sha256").update(key.trim()).digest("hex").slice(0, 16)}`;
}

/** Jev: list the models the key may use. Sends no data (lib/jev/client.ts probeJevKey). */
async function probeJev(credential: string, fetchImpl: FetchImpl, timeoutMs?: number): Promise<ProbeResult> {
  const r = await probeJevKey(credential, { fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  return {
    verdict: r.verdict,
    code: r.code,
    detail: r.detail,
    latencyMs: r.latencyMs,
    accountId: r.verdict === "healthy" ? jevKeyFingerprint(credential) : null,
    accountLabel: r.verdict === "healthy" ? "TypeSafe API key" : null,
    environment: null,
  };
}

/** Slack: auth.test with the bot token. Its team is the account the connection is pinned to. */
async function probeSlack(credential: string, fetchImpl: FetchImpl, timeoutMs?: number): Promise<ProbeResult> {
  const started = Date.now();
  const r = await slackAuthTest(credential, { fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  const latencyMs = Date.now() - started;
  if (r.ok) {
    const teamId = typeof r.data.team_id === "string" ? r.data.team_id : null;
    if (!teamId) {
      return { verdict: "unknown", code: "account_unidentified", detail: "Slack did not say which workspace this token is for.", latencyMs, accountId: null, accountLabel: null, environment: null };
    }
    return { verdict: "healthy", code: null, detail: null, latencyMs, accountId: teamId, accountLabel: r.data.team ?? null, environment: null };
  }
  if (["invalid_auth", "account_inactive", "token_revoked", "token_expired", "not_authed"].includes(r.error)) {
    return {
      verdict: "down",
      code: "key_rejected",
      detail: "Slack no longer accepts OASIS's token for this workspace (the app was removed or the token revoked). Install it again.",
      latencyMs,
      accountId: null,
      accountLabel: null,
      environment: null,
    };
  }
  return {
    verdict: "unknown",
    code: "provider_unreachable",
    detail: `Slack did not answer the check (${r.error}). OASIS will check again.`,
    latencyMs,
    accountId: null,
    accountLabel: null,
    environment: null,
  };
}

/** The live probe for each provider that has one. A provider without one cannot be green. */
const PROBES: Readonly<Record<string, Probe>> = {
  stripe: (credential, fetchImpl, timeoutMs) => probeStripeRestrictedKey(credential, { fetchImpl, timeoutMs }),
  jev: probeJev,
  slack: probeSlack,
};

export function probeFor(provider: string): Probe | null {
  return PROBES[provider] ?? null;
}

/** Providers the health cron can re-probe: live on this deployment, and holding a probe. */
export function probedProviders(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return Object.keys(PROBES).filter((id) => providerForEnv(id, env)?.availability === "live");
}

// ── Probe a stored connection ─────────────────────────────────────────────

export type ConnectionsDeps = {
  db: Client;
  fetchImpl?: FetchImpl;
  now: () => Date;
  /** Bound on one provider probe; default the provider's own (STRIPE_TIMEOUT_MS). */
  probeTimeoutMs?: number;
  /** The Feed's tape; default lib/manifest/events publishAgentEvent. */
  publishEvent?: (event: AgentEventPublish) => Promise<void>;
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
  // An app install stores the bot token it was given (token-store saveBotToken).
  if (provider.authKind === "app_install") return BOT_TOKEN_FIELD;
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
  const provider = providerForEnv(row.provider, process.env);
  const probe = provider && provider.availability === "live" ? probeFor(provider.id) : null;
  if (!provider || !probe) throw new Error(`provider_not_probeable:${row.provider}`);

  const credential = await readTenantCredentialStrict(row.tenant_id, credentialServiceFor(row.id), credentialFieldFor(provider));
  let outcome: Pick<ProbeResult, "verdict" | "code" | "detail" | "accountLabel" | "environment"> & { latencyMs: number | null };
  if (!credential.ok) {
    if (credential.reason === "lookup_failed") throw new Error("credential_lookup_failed");
    outcome = { verdict: "down", ...CREDENTIAL_FAILURE[credential.reason], latencyMs: null, accountLabel: null, environment: null };
  } else {
    const result = await probe(credential.value, deps.fetchImpl ?? fetch, deps.probeTimeoutMs);
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
        from_verdict: recorded.previousVerdict,
        verdict: outcome.verdict,
        verified: isVerifiedHealthy(recorded.connection, deps.now().getTime()),
        code: outcome.code,
        source,
      },
    });
  }
  if (recorded.worsened) {
    await alertConnectionWorsened(deps, {
      tenantId: row.tenant_id,
      connectionId: row.id,
      provider: row.provider,
      from: recorded.previousStatus,
      to: recorded.connection.status,
      code: outcome.code,
      detail: outcome.detail,
      source,
    });
  }
  return recorded;
}

/** Where the owner fixes a connection (Settings › Connections). */
export const CONNECTIONS_SETTINGS_HREF = setupHref("connections");

/**
 * Tell the workspace a connection got worse (doc 03 a.3: the health cron
 * "flips status and alerts Operations and the owner"). In-app only: one
 * agent_events row on the workspace's Feed, attributed to Operations. The
 * owner's Today lists the connection under Needs you for as long as it stays
 * in an attention status (components/os/today model reads tenant_connections),
 * so a recovery clears that item with no second event. Client workspaces have
 * no per-workspace email or Telegram channel yet, so nothing is sent outside
 * the app. Best-effort like every tape write: a failure is logged, never thrown
 * — the status is already recorded.
 */
export async function alertConnectionWorsened(
  deps: Pick<ConnectionsDeps, "publishEvent">,
  input: {
    tenantId: string;
    connectionId: string;
    provider: string;
    from: ConnectionStatus;
    to: ConnectionStatus;
    code: ProbeErrorCode | null;
    detail: string | null;
    source: HealthCheckSource;
  },
): Promise<void> {
  const label = providerById(input.provider)?.label ?? input.provider;
  try {
    await (deps.publishEvent ?? publishAgentEvent)({
      eventType: "CONNECTION_NEEDS_ATTENTION",
      tenantId: input.tenantId,
      // dept:<key> is the Feed's explicit department attribution.
      publisher: "dept:operations",
      severity: input.to === "degraded" ? "warn" : "error",
      payload: {
        // entity + from/to is what the Feed's one-line summary prints.
        entity: `${label} connection`,
        from: input.from,
        to: input.to,
        connection_id: input.connectionId,
        provider: input.provider,
        code: input.code,
        detail: input.detail,
        source: input.source,
        // The one app's card when the catalog has it, else the hub.
        href: connectorBySlug(input.provider) ? setupHref(`connector:${input.provider}`) : CONNECTIONS_SETTINGS_HREF,
      },
    });
  } catch (err) {
    console.error("[connections.alert] feed event failed", {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      error: err instanceof Error ? err.stack : err,
    });
  }
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
  flipped: Array<{ connection_id: string; provider: string; from: string; to: string; verdict: HealthVerdict }>;
  /** `error` is a stable code (PASS_ERROR_CODES or "probe_threw"); the full error is in the server log only. */
  errors: Array<{ connection_id: string; provider: string; error: string }>;
  /** Due connections left for the next pass because the remaining time could not fit one more probe. */
  deferred: number;
  pruned: { healthChecksDeleted: number; oauthStatesDeleted: number };
};

/**
 * The pass's time budget: the route's maxDuration is 60s, and 15s of it stays
 * for listing, pruning and the response.
 */
export const HEALTH_PASS_BUDGET_MS = 45_000;
/**
 * Probes in flight at once: ONE. A probe already fills the Worker's six
 * connection slots (STRIPE_MAX_IN_FLIGHT); a second one would only queue
 * behind it on its own deadline and time out with Stripe reachable.
 */
export const HEALTH_PASS_CONCURRENCY = 1;
/** One probe at its worst: the provider deadline, plus the database reads and writes around it. */
export const PROBE_WORST_CASE_MS = STRIPE_TIMEOUT_MS + 5_000;
/**
 * As many due connections as fit the budget even when EVERY probe runs to its
 * deadline (a Stripe outage): 1 lane × 3 rounds = 3. Every 15 minutes, that
 * keeps ~12 connections re-probed each hour — the pilot scale. Past that, run
 * the pass more often or move it onto the job queue; do not raise this cap or
 * the concurrency.
 */
export const HEALTH_PASS_LIMIT = HEALTH_PASS_CONCURRENCY * Math.floor(HEALTH_PASS_BUDGET_MS / PROBE_WORST_CASE_MS);

/**
 * The cron response is printed to a public Actions log (cron-driver.yml), so a
 * probe that throws is reported by code; the message and stack go to the
 * server log only.
 */
const PASS_ERROR_CODES: ReadonlySet<string> = new Set([
  "credential_lookup_failed",
  "provider_not_probeable",
  "connection_not_found",
]);

function passErrorCode(err: unknown): string {
  const prefix = (err instanceof Error ? err.message : "").split(":")[0];
  return PASS_ERROR_CODES.has(prefix) ? prefix : "probe_threw";
}

/**
 * One pass. First trim old history (two indexed DELETEs), so a pass that runs
 * out of time on probes still prunes. Then re-probe live connections whose last
 * check is older than HEALTH_RECHECK_AFTER_MS, oldest first, at most `limit`,
 * `concurrency` at a time. A lane starts another probe only while the time left
 * in the budget still fits one at its worst; whatever is left is `deferred` and
 * stays due, first in line next pass. One connection throwing never strands the
 * rest; it is reported in `errors`, and the route turns a non-empty `errors`
 * into a 500 so the cron runner sees it.
 */
export async function runConnectionHealthPass(
  deps: ConnectionsDeps,
  opts: {
    limit?: number;
    concurrency?: number;
    budgetMs?: number;
    probeWorstCaseMs?: number;
    /** Monotonic-enough ms clock for the budget (tests pin it). */
    clock?: () => number;
  } = {},
): Promise<HealthPassResult> {
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = opts.budgetMs ?? HEALTH_PASS_BUDGET_MS;
  const worstMs = opts.probeWorstCaseMs ?? PROBE_WORST_CASE_MS;
  const now = deps.now();
  const pruned = await pruneConnectionHistory(deps.db, now);
  const due = await listConnectionsDueForHealth(deps.db, {
    providers: probedProviders(),
    staleBefore: new Date(now.getTime() - HEALTH_RECHECK_AFTER_MS),
    limit: opts.limit ?? HEALTH_PASS_LIMIT,
  });
  const result: HealthPassResult = {
    checked: 0,
    healthy: 0,
    flipped: [],
    errors: [],
    deferred: 0,
    pruned,
  };
  const queue = [...due];
  const worker = async () => {
    while (queue.length > 0 && budgetMs - (clock() - startedAt) >= worstMs) {
      await probeOne(queue.shift()!);
    }
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
          verdict: recorded.connection.last_health_verdict,
        });
      }
    } catch (err) {
      console.error("[connections.health_pass] probe threw", {
        tenantId: row.tenant_id,
        connectionId: row.id,
        provider: row.provider,
        error: err instanceof Error ? err.stack : err,
      });
      result.errors.push({ connection_id: row.id, provider: row.provider, error: passErrorCode(err) });
    }
  };
  const lanes = Math.max(1, Math.min(opts.concurrency ?? HEALTH_PASS_CONCURRENCY, queue.length || 1));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  result.deferred = queue.length;
  if (result.deferred > 0) {
    console.warn("[connections.health_pass] out of time; deferred to the next pass", { deferred: result.deferred });
  }
  return result;
}
