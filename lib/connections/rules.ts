/**
 * lib/connections/rules.ts — every rule the Connections framework follows.
 *
 * PURE: no database, no session, no env, no fetch, no next/* import. The
 * routes, the store, the health cron and the Settings hub all ask THIS module
 * what a valid status is, which providers are exclusive, when a connection is
 * proven healthy, and whether a pasted Stripe key is acceptable — so
 * tests/os-connections.test.ts can pin all of it in a bare node process.
 *
 * The allowed values here are the only copy. Migration bravo__187 deliberately
 * has no CHECK constraints on these columns (see its header), so every write in
 * lib/connections/store.ts takes its enum values from here.
 */

// ── Vocabularies ──────────────────────────────────────────────────────────

export const CONNECTION_STATUSES = [
  "pending",
  "connected",
  "degraded",
  "expired",
  "revoked",
  "error",
  "pending_review",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const HEALTH_VERDICTS = ["healthy", "degraded", "down", "unknown"] as const;
export type HealthVerdict = (typeof HEALTH_VERDICTS)[number];

/** bank_link: a hosted account-linking flow (Plaid Link), not OAuth 2 proper. */
export const AUTH_KINDS = [
  "oauth2",
  "restricted_key",
  "api_key",
  "system_user",
  "app_install",
  "bank_link",
  "nango",
] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export const SCOPE_KINDS = ["tenant", "user"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const CONNECTION_ENVIRONMENTS = ["live", "test"] as const;
export type ConnectionEnvironment = (typeof CONNECTION_ENVIRONMENTS)[number];

export const HEALTH_CHECK_SOURCES = ["connect", "manual", "cron", "refresh"] as const;
export type HealthCheckSource = (typeof HEALTH_CHECK_SOURCES)[number];

export const PROBE_ERROR_CODES = [
  /** The provider refused the credential outright (HTTP 401). */
  "key_rejected",
  /** The credential works but cannot read something OASIS needs (HTTP 403). */
  "missing_permissions",
  /** The provider never said which account the credential belongs to. */
  "account_unidentified",
  /** The credential now belongs to a different account than the pinned one. */
  "account_mismatch",
  /** Timeout, network error, 429 or 5xx: nothing can be concluded. */
  "provider_unreachable",
  /** A status or body the probe does not understand: nothing concluded. */
  "unexpected_response",
  /** No stored credential for a connection that should have one. */
  "credential_missing",
  /** A stored credential that will not decrypt. Never replaced by env. */
  "credential_unreadable",
  /** An OAuth refresh the provider refused. */
  "refresh_failed",
] as const;
export type ProbeErrorCode = (typeof PROBE_ERROR_CODES)[number];

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

// ── Exclusivity ───────────────────────────────────────────────────────────

/**
 * Providers where one external account may be live in at most ONE tenant: a
 * company's Stripe, books, bank, ad account or phone sub-account can never feed
 * two workspaces (doc 03 F6). The partial unique index
 * ux_tenant_connections_exclusive_account in migration bravo__187 carries the
 * same list; tests/os-connections.test.ts asserts they are equal, so adding a
 * provider here without a migration fails CI.
 */
export const EXCLUSIVE_PROVIDERS = ["stripe", "quickbooks", "xero", "plaid", "meta", "twilio"] as const;

export function isExclusiveProvider(provider: string): boolean {
  return (EXCLUSIVE_PROVIDERS as readonly string[]).includes(provider);
}

// ── Timing ────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A passing probe proves a connection for this long. The health cron re-probes
 * each connection about hourly, so a card that goes a day without a passing probe has lost its
 * evidence and stops being green — the same 24-hour rule the workspace
 * heartbeats use (lib/integrations/workspace-connection-status.ts).
 */
export const HEALTH_FRESH_MS = 24 * HOUR;
/** The cron re-probes a connection whose last check is older than this. */
export const HEALTH_RECHECK_AFTER_MS = 50 * MIN;
/** connection_health_checks rows older than this are deleted by the cron. */
export const HEALTH_CHECK_RETENTION_MS = 30 * 24 * HOUR;
/** How long a started OAuth consent may take before its state expires. */
export const OAUTH_STATE_TTL_MS = 10 * MIN;
/**
 * The shortest CONNECTIONS_OAUTH_STATE_SECRET anything accepts: the OAuth state
 * signer (lib/connections/oauth.ts) and the Slack job key derived from it
 * (lib/slack/job-signature.ts) refuse a shorter one.
 */
export const OAUTH_STATE_SECRET_MIN_LENGTH = 32;
/** oauth_states rows older than this are deleted by the cron. */
export const OAUTH_STATE_RETENTION_MS = 24 * HOUR;
/**
 * How long a token refresh may hold its lease. The refresh call itself is
 * aborted well before this (token-store REFRESH_TIMEOUT_MS), so a holder can
 * never outlive its own lease and let a second refresh race it.
 */
export const REFRESH_LEASE_MS = 2 * MIN;
/** Refresh an access token this long before it expires. */
export const REFRESH_SKEW_MS = 2 * MIN;
/**
 * A connected account that the provider could not be REACHED for (timeouts,
 * 5xx) this many checks in a row is marked degraded. One outage is not a
 * broken connection; three hours of them is worth a look.
 */
export const TRANSIENT_FAILURES_BEFORE_DEGRADED = 3;

// ── Credentials ───────────────────────────────────────────────────────────

/**
 * The tenant_integration_credentials `service` a connection's secret lives
 * under. One namespace per connection, so two connections can never share or
 * overwrite each other's secret, and disconnect can delete exactly one set.
 * Not in ENV_FALLBACKS, so no env value can ever stand in for it.
 */
export function credentialServiceFor(connectionId: string): string {
  if (!connectionId) throw new Error("credential_service_needs_connection_id");
  return `connection:${connectionId}`;
}

/** The field an app install's bot token is stored under, inside its connection's service. */
export const BOT_TOKEN_FIELD = "bot_token";

// ── Stripe restricted keys ────────────────────────────────────────────────

/**
 * Stripe secret-format keys: prefix + environment + an opaque body. The body
 * length is not documented, so this only demands "more than a stub".
 */
const RESTRICTED_KEY = /^rk_(live|test)_[A-Za-z0-9]{16,247}$/;

export type StripeKeyCheck =
  | { ok: true; key: string; environment: ConnectionEnvironment }
  | {
      ok: false;
      error: "key_missing" | "secret_key_refused" | "publishable_key_refused" | "format_invalid";
      message: string;
    };

/**
 * Decision (doc 03 a.5): client tenants connect Stripe with a RESTRICTED key
 * (rk_live_ / rk_test_) that has Read access only. A full secret key (sk_) can
 * move money, so it is refused outright rather than stored and "only used for
 * reads" — the key itself is the guarantee, not a promise in our code.
 *
 * The messages never echo the key back.
 */
export function checkStripeRestrictedKey(raw: unknown): StripeKeyCheck {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) {
    return { ok: false, error: "key_missing", message: "Paste your Stripe restricted key (it starts with rk_live_ or rk_test_)." };
  }
  if (/^sk_(live|test)_/.test(key)) {
    return {
      ok: false,
      error: "secret_key_refused",
      message:
        "That is a full secret key (sk_…), which can charge cards and move money. OASIS only accepts a restricted key (rk_…) with Read access. Create one in Stripe under Developers › API keys › Create restricted key, and paste that instead. You may want to roll the secret key you pasted.",
    };
  }
  if (/^pk_(live|test)_/.test(key)) {
    return {
      ok: false,
      error: "publishable_key_refused",
      message:
        "That is a publishable key (pk_…), which cannot read your account. Paste a restricted key (rk_…) with Read access instead.",
    };
  }
  const m = RESTRICTED_KEY.exec(key);
  if (!m) {
    return {
      ok: false,
      error: "format_invalid",
      message: "That does not look like a Stripe restricted key. It should start with rk_live_ or rk_test_ and contain no spaces.",
    };
  }
  return { ok: true, key, environment: m[1] as ConnectionEnvironment };
}

// ── Jev (TypeSafe) API keys ───────────────────────────────────────────────

export type JevKeyCheck =
  | { ok: true; key: string }
  | { ok: false; error: "key_missing" | "format_invalid"; message: string };

/**
 * A TypeSafe API key, checked the way the installed typesafe-sdk 0.7.1 checks
 * it (typesafe_sdk/_core/config.py resolve_and_validate_api_key): stripped,
 * non-empty, printable ASCII with no whitespace. TypeSafe documents no prefix,
 * so none is demanded; the live probe is what proves the key. Bounded length so
 * a pasted page of text is refused before it is sent anywhere.
 */
export function checkJevApiKey(raw: unknown): JevKeyCheck {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { ok: false, error: "key_missing", message: "Paste your TypeSafe API key." };
  if (key.length < 16 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    return {
      ok: false,
      error: "format_invalid",
      message: "That does not look like a TypeSafe API key. It should be one line of letters, digits and symbols, with no spaces.",
    };
  }
  return { ok: true, key };
}

// ── Health ────────────────────────────────────────────────────────────────

const VERDICT_SEVERITY: Record<HealthVerdict, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

/**
 * Merge sub-check verdicts: the worst KNOWN problem wins. "unknown" (could not
 * check) ranks below a real degradation, because a permission error the
 * provider did report is a fact, and a timeout on another call does not undo it.
 */
export function mergeVerdicts(verdicts: readonly HealthVerdict[]): HealthVerdict {
  if (verdicts.length === 0) return "unknown";
  return verdicts.reduce((worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst), "healthy" as HealthVerdict);
}

export type ProbeOutcome = { verdict: HealthVerdict; code: ProbeErrorCode | null };

/**
 * The status a connection moves to after a probe.
 *
 *   healthy                 → connected (and the failure counter resets)
 *   unknown (unreachable)   → unchanged, until TRANSIENT_FAILURES_BEFORE_DEGRADED
 *                             in a row turn a connected account degraded
 *   degraded                → degraded (it works, but not fully)
 *   down: key rejected /    → expired (the provider no longer accepts it; the
 *         refresh refused     owner must reconnect)
 *   down: anything else     → error
 *   revoked                 → stays revoked, whatever a probe says. Only a new
 *                             connect brings a connection back.
 */
export function statusAfterProbe(
  current: ConnectionStatus,
  outcome: ProbeOutcome,
  consecutiveFailures: number,
): { status: ConnectionStatus; consecutiveFailures: number } {
  const failures = Math.max(0, Math.trunc(consecutiveFailures) || 0);
  if (current === "revoked") return { status: "revoked", consecutiveFailures: failures };
  switch (outcome.verdict) {
    case "healthy":
      return { status: "connected", consecutiveFailures: 0 };
    case "unknown": {
      const n = failures + 1;
      return {
        status: current === "connected" && n >= TRANSIENT_FAILURES_BEFORE_DEGRADED ? "degraded" : current,
        consecutiveFailures: n,
      };
    }
    case "degraded":
      return { status: "degraded", consecutiveFailures: failures + 1 };
    case "down":
      return {
        status: outcome.code === "key_rejected" || outcome.code === "refresh_failed" ? "expired" : "error",
        consecutiveFailures: failures + 1,
      };
  }
}

/**
 * Statuses where the connection is not doing its job and only the owner can
 * fix it (reconnect, or give the key the permissions it lacks). The owner's
 * Today lists a connection under Needs you for as long as it is in one of
 * these, so a recovery clears the item by itself.
 */
export const ATTENTION_STATUSES = ["degraded", "expired", "error"] as const;

const STATUS_SEVERITY: Partial<Record<string, number>> = { degraded: 1, expired: 2, error: 2 };

export function needsAttention(status: string | null | undefined): boolean {
  return (STATUS_SEVERITY[status ?? ""] ?? 0) > 0;
}

/**
 * A status flip the owner must be told about: into an attention status, or to
 * a worse one. A recovery, or a move between equally bad states, is not.
 */
export function isWorseStatus(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return (STATUS_SEVERITY[to] ?? 0) > (STATUS_SEVERITY[from] ?? 0);
}

/**
 * GREEN MEANS PROVEN. True only when the connection is connected AND its last
 * probe passed AND that probe is under HEALTH_FRESH_MS old (and not stamped in
 * the future). A saved key nobody checked, a stale pass, or a pass followed by
 * an unreachable provider are all "not proven".
 */
export function isVerifiedHealthy(
  row: { status: string | null; last_health_verdict: string | null; last_health_at: string | null },
  nowMs: number,
): boolean {
  if (row.status !== "connected" || row.last_health_verdict !== "healthy" || !row.last_health_at) return false;
  const at = Date.parse(row.last_health_at);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age <= HEALTH_FRESH_MS;
}
