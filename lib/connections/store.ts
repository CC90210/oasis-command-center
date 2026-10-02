/**
 * lib/connections/store.ts — every read and write of the Connections tables
 * (migration bravo__187: tenant_connections, connection_health_checks,
 * oauth_states' pruning, provider_webhook_routes).
 *
 * Raw SQL on the libSQL client, like lib/delivery/store.ts: the compare-and-set
 * statements here (refresh lease, single-use state, exclusive claim) must say
 * exactly what they do, which the PostgREST adapter would hide.
 *
 * TENANT ISOLATION. Every function that takes a `tenantId` puts it in the WHERE
 * clause of every statement it runs, and the callers take it from the resolved
 * session — never from a request body. A connection id from another tenant
 * therefore reads as "not found" and writes nothing. The only statements that
 * look across tenants are marked CROSS-TENANT below, and each returns the least
 * it can: a boolean for the exclusivity check, and system rows for the health
 * cron and webhook routing, which have no session by nature.
 *
 * NO SECRETS HERE. Credentials live in tenant_integration_credentials, reached
 * only through lib/tenant-integration-store.ts.
 *
 * Nothing is swallowed. A failed statement throws; the route turns it into a
 * loud 500. Writes take a clock (`now`), so tests pin time.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import {
  HEALTH_CHECK_RETENTION_MS,
  OAUTH_STATE_RETENTION_MS,
  isExclusiveProvider,
  isVerifiedHealthy,
  isWorseStatus,
  statusAfterProbe,
  type AuthKind,
  type ConnectionEnvironment,
  type ConnectionStatus,
  type HealthCheckSource,
  type HealthVerdict,
  type ProbeErrorCode,
  type ScopeKind,
} from "@/lib/connections/rules";

// ── Shapes ────────────────────────────────────────────────────────────────

export type ConnectionRow = {
  id: string;
  tenant_id: string;
  provider: string;
  scope_kind: ScopeKind;
  user_id: string | null;
  auth_kind: AuthKind;
  external_account_id: string | null;
  external_account_label: string | null;
  environment: ConnectionEnvironment | null;
  granted_scopes_json: string;
  scope_set_version: number;
  status: ConnectionStatus;
  token_version: number;
  refresh_lease_until: string | null;
  last_health_at: string | null;
  last_health_verdict: HealthVerdict;
  last_health_code: ProbeErrorCode | null;
  last_health_detail: string | null;
  consecutive_failures: number;
  connected_by: string | null;
  connected_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
  updated_at: string;
};

export type HealthCheckRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  check_source: HealthCheckSource;
  checked_at: string;
  verdict: HealthVerdict;
  latency_ms: number | null;
  error_code: ProbeErrorCode | null;
  detail: string | null;
};

const CONNECTION_COLUMNS = `id, tenant_id, provider, scope_kind, user_id, auth_kind, external_account_id,
  external_account_label, environment, granted_scopes_json, scope_set_version, status, token_version,
  refresh_lease_until, last_health_at, last_health_verdict, last_health_code, last_health_detail,
  consecutive_failures, connected_by, connected_at, revoked_at, revoked_by, created_at, updated_at`;

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function toConnection(r: Row): ConnectionRow {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    provider: String(r.provider),
    scope_kind: String(r.scope_kind) as ScopeKind,
    user_id: str(r.user_id),
    auth_kind: String(r.auth_kind) as AuthKind,
    external_account_id: str(r.external_account_id),
    external_account_label: str(r.external_account_label),
    environment: str(r.environment) as ConnectionEnvironment | null,
    granted_scopes_json: str(r.granted_scopes_json) ?? "[]",
    scope_set_version: num(r.scope_set_version),
    status: String(r.status) as ConnectionStatus,
    token_version: num(r.token_version),
    refresh_lease_until: str(r.refresh_lease_until),
    last_health_at: str(r.last_health_at),
    last_health_verdict: (str(r.last_health_verdict) ?? "unknown") as HealthVerdict,
    last_health_code: str(r.last_health_code) as ProbeErrorCode | null,
    last_health_detail: str(r.last_health_detail),
    consecutive_failures: num(r.consecutive_failures),
    connected_by: str(r.connected_by),
    connected_at: str(r.connected_at),
    revoked_at: str(r.revoked_at),
    revoked_by: str(r.revoked_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function toHealthCheck(r: Row): HealthCheckRow {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    connection_id: String(r.connection_id),
    provider: String(r.provider),
    check_source: String(r.check_source) as HealthCheckSource,
    checked_at: String(r.checked_at),
    verdict: String(r.verdict) as HealthVerdict,
    latency_ms: r.latency_ms === null || r.latency_ms === undefined ? null : Number(r.latency_ms),
    error_code: str(r.error_code) as ProbeErrorCode | null,
    detail: str(r.detail),
  };
}

/**
 * What a route may return about a connection: state and health only. No
 * credential, no lease, no internal counters.
 */
export type PublicConnection = {
  id: string;
  provider: string;
  status: ConnectionStatus;
  account_id: string | null;
  account_label: string | null;
  environment: ConnectionEnvironment | null;
  connected_at: string | null;
  last_health_at: string | null;
  last_health_verdict: HealthVerdict;
  last_health_code: ProbeErrorCode | null;
  last_health_detail: string | null;
  /** rules.isVerifiedHealthy — the only thing that may turn a card green. */
  verified: boolean;
};

export function toPublicConnection(row: ConnectionRow, nowMs: number): PublicConnection {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    account_id: row.external_account_id,
    account_label: row.external_account_label,
    environment: row.environment,
    connected_at: row.connected_at,
    last_health_at: row.last_health_at,
    last_health_verdict: row.last_health_verdict,
    last_health_code: row.last_health_code,
    last_health_detail: row.last_health_detail,
    verified: isVerifiedHealthy(row, nowMs),
  };
}

// ── Tenant-scoped reads ───────────────────────────────────────────────────

export async function getConnection(db: Client, tenantId: string, connectionId: string): Promise<ConnectionRow | null> {
  const rs = await db.execute({
    sql: `SELECT ${CONNECTION_COLUMNS} FROM tenant_connections WHERE tenant_id = ? AND id = ?`,
    args: [tenantId, connectionId],
  });
  const r = rows(rs)[0];
  return r ? toConnection(r) : null;
}

/** The tenant's live (not revoked) connection for a provider, newest first. */
export async function findActiveConnection(
  db: Client,
  tenantId: string,
  provider: string,
  userId: string | null = null,
): Promise<ConnectionRow | null> {
  const rs = await db.execute({
    sql: `SELECT ${CONNECTION_COLUMNS} FROM tenant_connections
          WHERE tenant_id = ? AND provider = ? AND COALESCE(user_id, '') = ? AND revoked_at IS NULL
          ORDER BY updated_at DESC LIMIT 1`,
    args: [tenantId, provider, userId ?? ""],
  });
  const r = rows(rs)[0];
  return r ? toConnection(r) : null;
}

/** Every live connection in the tenant — the hub's status source. */
export async function listActiveConnections(db: Client, tenantId: string): Promise<ConnectionRow[]> {
  const rs = await db.execute({
    sql: `SELECT ${CONNECTION_COLUMNS} FROM tenant_connections
          WHERE tenant_id = ? AND revoked_at IS NULL
          ORDER BY provider, updated_at DESC`,
    args: [tenantId],
  });
  return rows(rs).map(toConnection);
}

export async function listRecentHealthChecks(
  db: Client,
  tenantId: string,
  connectionId: string,
  limit = 5,
): Promise<HealthCheckRow[]> {
  const rs = await db.execute({
    sql: `SELECT id, tenant_id, connection_id, provider, check_source, checked_at, verdict, latency_ms, error_code, detail
          FROM connection_health_checks
          WHERE tenant_id = ? AND connection_id = ?
          ORDER BY checked_at DESC LIMIT ?`,
    args: [tenantId, connectionId, Math.max(1, Math.min(50, limit))],
  });
  return rows(rs).map(toHealthCheck);
}

/**
 * CROSS-TENANT, boolean only. Is this external account live in some OTHER
 * tenant? Used to refuse a connect with a clear message before the exclusive
 * index would refuse it anyway. It never says which tenant.
 */
export async function isAccountHeldByAnotherTenant(
  db: Client,
  tenantId: string,
  provider: string,
  externalAccountId: string,
): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 FROM tenant_connections
          WHERE provider = ? AND external_account_id = ? AND revoked_at IS NULL AND tenant_id <> ?
          LIMIT 1`,
    args: [provider, externalAccountId, tenantId],
  });
  return rs.rows.length > 0;
}

// ── Connect ───────────────────────────────────────────────────────────────

export type ClaimInput = {
  tenantId: string;
  provider: string;
  authKind: AuthKind;
  scopeKind: ScopeKind;
  userId: string | null;
  externalAccountId: string;
  externalAccountLabel: string | null;
  environment: ConnectionEnvironment | null;
  grantedScopes: readonly string[];
  scopeSetVersion: number;
  connectedBy: string | null;
  now: Date;
};

export type ClaimResult =
  | {
      ok: true;
      connection: ConnectionRow;
      created: boolean;
      /**
       * The reused row as it was before this claim (null for a new row). A
       * revoked one here means the claim REACTIVATED it, and undoing the claim
       * puts it back (restoreRevokedClaim), never deletes it.
       */
      previous: ConnectionRow | null;
    }
  | { ok: false; error: "account_connected_elsewhere" }
  | { ok: false; error: "provider_already_connected"; current: ConnectionRow };

/**
 * Claim an external account for a tenant, leaving the row `pending` until a
 * credential is saved and a probe records its health.
 *
 *   - An exclusive account live in another tenant is refused.
 *   - A tenant keeps ONE live connection per provider (and user): a different
 *     account while one is live is refused, so switching accounts is an
 *     explicit disconnect, never a silent swap of the books' source.
 *   - The same account again (a rotated key, or a reconnect after disconnect)
 *     reuses its row, so its history stays in one place.
 *
 * The exclusive unique index is the real guarantee: two tenants racing for one
 * account both pass the read above, and the second write fails on the index.
 */
export async function claimConnection(db: Client, input: ClaimInput): Promise<ClaimResult> {
  const nowIso = input.now.toISOString();
  const exclusive = isExclusiveProvider(input.provider);
  if (exclusive && (await isAccountHeldByAnotherTenant(db, input.tenantId, input.provider, input.externalAccountId))) {
    return { ok: false, error: "account_connected_elsewhere" };
  }

  const active = await findActiveConnection(db, input.tenantId, input.provider, input.userId);
  if (active && active.external_account_id !== input.externalAccountId) {
    return { ok: false, error: "provider_already_connected", current: active };
  }

  const existingRs = await db.execute({
    sql: `SELECT ${CONNECTION_COLUMNS} FROM tenant_connections
          WHERE tenant_id = ? AND provider = ? AND COALESCE(external_account_id, '') = ? AND COALESCE(user_id, '') = ?`,
    args: [input.tenantId, input.provider, input.externalAccountId, input.userId ?? ""],
  });
  const existing = rows(existingRs)[0] ? toConnection(rows(existingRs)[0]) : null;
  const scopes = JSON.stringify([...input.grantedScopes]);

  try {
    if (existing) {
      // Reconnect / new key for the same account. A revoked row comes back as a
      // fresh connection: new connected_at, cleared health, cleared failures.
      const reactivating = existing.revoked_at !== null;
      await db.execute({
        sql: `UPDATE tenant_connections SET
                status = 'pending',
                revoked_at = NULL,
                revoked_by = NULL,
                refresh_lease_until = NULL,
                auth_kind = ?,
                external_account_label = ?,
                environment = ?,
                granted_scopes_json = ?,
                scope_set_version = ?,
                connected_by = ?,
                connected_at = CASE WHEN ? THEN NULL ELSE connected_at END,
                last_health_at = CASE WHEN ? THEN NULL ELSE last_health_at END,
                last_health_verdict = CASE WHEN ? THEN 'unknown' ELSE last_health_verdict END,
                last_health_code = CASE WHEN ? THEN NULL ELSE last_health_code END,
                last_health_detail = CASE WHEN ? THEN NULL ELSE last_health_detail END,
                consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures END,
                updated_at = ?
              WHERE id = ? AND tenant_id = ?`,
        args: [
          input.authKind,
          input.externalAccountLabel,
          input.environment,
          scopes,
          input.scopeSetVersion,
          input.connectedBy,
          reactivating ? 1 : 0,
          reactivating ? 1 : 0,
          reactivating ? 1 : 0,
          reactivating ? 1 : 0,
          reactivating ? 1 : 0,
          reactivating ? 1 : 0,
          nowIso,
          existing.id,
          input.tenantId,
        ],
      });
      const updated = await getConnection(db, input.tenantId, existing.id);
      if (!updated) throw new Error("connection_claim_vanished");
      return { ok: true, connection: updated, created: false, previous: existing };
    }

    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO tenant_connections (
              id, tenant_id, provider, scope_kind, user_id, auth_kind, external_account_id, external_account_label,
              environment, granted_scopes_json, scope_set_version, status, connected_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      args: [
        id,
        input.tenantId,
        input.provider,
        input.scopeKind,
        input.userId,
        input.authKind,
        input.externalAccountId,
        input.externalAccountLabel,
        input.environment,
        scopes,
        input.scopeSetVersion,
        input.connectedBy,
        nowIso,
        nowIso,
      ],
    });
    const created = await getConnection(db, input.tenantId, id);
    if (!created) throw new Error("connection_claim_vanished");
    return { ok: true, connection: created, created: true, previous: null };
  } catch (err) {
    if (!isUniqueViolationError(err as { message?: string })) throw err;
    // Lost a race. Say which one, from the database's own state.
    if (exclusive && (await isAccountHeldByAnotherTenant(db, input.tenantId, input.provider, input.externalAccountId))) {
      return { ok: false, error: "account_connected_elsewhere" };
    }
    const current = await findActiveConnection(db, input.tenantId, input.provider, input.userId);
    if (current) return { ok: false, error: "provider_already_connected", current };
    throw err;
  }
}

/**
 * Undo a claim that never got its credential: deletes the row only while it is
 * still a brand-new pending claim (never connected, never probed) with no
 * health history at all, so it can never remove a connection with history. A
 * REACTIVATED revoked row looks brand-new on its own columns (the claim cleared
 * connected_at and last_health_at), which is why the history is checked too —
 * and why such a row is put back with restoreRevokedClaim instead.
 */
export async function deleteUnprovenClaim(db: Client, tenantId: string, connectionId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: `DELETE FROM tenant_connections
          WHERE id = ? AND tenant_id = ? AND status = 'pending' AND connected_at IS NULL AND last_health_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM connection_health_checks h WHERE h.tenant_id = ? AND h.connection_id = ?
            )`,
    args: [connectionId, tenantId, tenantId, connectionId],
  });
  return rs.rowsAffected === 1;
}

/**
 * Undo a claim that REACTIVATED a revoked row and never got its credential:
 * put back every column the claim changed, so the row is revoked again exactly
 * as the disconnect left it and its history stays attached. Only while the row
 * is still that unproven claim (pending, live, not probed since); returns false
 * otherwise.
 */
export async function restoreRevokedClaim(
  db: Client,
  input: { tenantId: string; previous: ConnectionRow; now: Date },
): Promise<boolean> {
  const p = input.previous;
  if (!p.revoked_at) throw new Error("restore_needs_a_revoked_row");
  const rs = await db.execute({
    sql: `UPDATE tenant_connections SET
            status = ?,
            revoked_at = ?,
            revoked_by = ?,
            refresh_lease_until = ?,
            auth_kind = ?,
            external_account_label = ?,
            environment = ?,
            granted_scopes_json = ?,
            scope_set_version = ?,
            connected_by = ?,
            connected_at = ?,
            last_health_at = ?,
            last_health_verdict = ?,
            last_health_code = ?,
            last_health_detail = ?,
            consecutive_failures = ?,
            updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'pending' AND revoked_at IS NULL AND last_health_at IS NULL`,
    args: [
      p.status,
      p.revoked_at,
      p.revoked_by,
      p.refresh_lease_until,
      p.auth_kind,
      p.external_account_label,
      p.environment,
      p.granted_scopes_json,
      p.scope_set_version,
      p.connected_by,
      p.connected_at,
      p.last_health_at,
      p.last_health_verdict,
      p.last_health_code,
      p.last_health_detail,
      p.consecutive_failures,
      input.now.toISOString(),
      p.id,
      input.tenantId,
    ],
  });
  return rs.rowsAffected === 1;
}

/** A write around the connection failed (e.g. the credential could not be saved). */
export async function markConnectionError(
  db: Client,
  input: { tenantId: string; connectionId: string; code: ProbeErrorCode; detail: string; now: Date },
): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE tenant_connections SET status = 'error', last_health_code = ?, last_health_detail = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    args: [input.code, input.detail.slice(0, 500), input.now.toISOString(), input.connectionId, input.tenantId],
  });
  return rs.rowsAffected === 1;
}

// ── Health ────────────────────────────────────────────────────────────────

export type HealthRecordInput = {
  tenantId: string;
  connectionId: string;
  source: HealthCheckSource;
  verdict: HealthVerdict;
  code: ProbeErrorCode | null;
  detail: string | null;
  latencyMs: number | null;
  now: Date;
  /** Facts the probe learned (a fresher account name, the key's mode). */
  accountLabel?: string | null;
  environment?: ConnectionEnvironment | null;
};

export type HealthRecordResult = {
  connection: ConnectionRow;
  previousStatus: ConnectionStatus;
  previousVerdict: HealthVerdict;
  /** False when the connection was revoked while the probe ran: nothing was written. */
  recorded: boolean;
  /**
   * The connection's health changed: its status, its verdict, or whether the
   * card is verified green (doc 03 a.2: every health flip is audited). A pass
   * that turns "unknown" keeps the status but loses the green, and counts.
   */
  flipped: boolean;
  /** The status moved to a worse one that needs the owner (rules.isWorseStatus) — what raises an alert. */
  worsened: boolean;
};

/**
 * Record one probe: move the status (rules.statusAfterProbe) and append the
 * history row, in ONE batch so the card and its history can never disagree.
 *
 * Both statements are pinned to the tenant: the UPDATE by its WHERE, the
 * INSERT by an EXISTS on the same (id, tenant_id), so a connection id from
 * another tenant writes nothing at all. A connection revoked while the probe
 * was in flight writes nothing either: both statements require revoked_at IS
 * NULL inside the same batch, and a probe that changed no row reports no flip
 * (the disconnect changed the status, not the probe).
 */
export async function recordHealthCheck(db: Client, input: HealthRecordInput): Promise<HealthRecordResult> {
  const before = await getConnection(db, input.tenantId, input.connectionId);
  if (!before) throw new Error("connection_not_found");
  const next = statusAfterProbe(before.status, { verdict: input.verdict, code: input.code }, before.consecutive_failures);
  const nowIso = input.now.toISOString();
  const detail = input.detail ? input.detail.slice(0, 500) : null;

  const statements: InStatement[] = [
    {
      sql: `UPDATE tenant_connections SET
              status = ?,
              consecutive_failures = ?,
              last_health_at = ?,
              last_health_verdict = ?,
              last_health_code = ?,
              last_health_detail = ?,
              connected_at = CASE WHEN connected_at IS NULL AND ? = 'connected' THEN ? ELSE connected_at END,
              external_account_label = COALESCE(?, external_account_label),
              environment = COALESCE(?, environment),
              updated_at = ?
            WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
      args: [
        next.status,
        next.consecutiveFailures,
        nowIso,
        input.verdict,
        input.code,
        detail,
        next.status,
        nowIso,
        input.accountLabel ?? null,
        input.environment ?? null,
        nowIso,
        input.connectionId,
        input.tenantId,
      ],
    },
    {
      sql: `INSERT INTO connection_health_checks
              (id, tenant_id, connection_id, provider, check_source, checked_at, verdict, latency_ms, error_code, detail)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM tenant_connections WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL)`,
      args: [
        randomUUID(),
        input.tenantId,
        input.connectionId,
        before.provider,
        input.source,
        nowIso,
        input.verdict,
        input.latencyMs === null ? null : Math.max(0, Math.round(input.latencyMs)),
        input.code,
        detail,
        input.connectionId,
        input.tenantId,
      ],
    },
  ];
  const [updated] = await db.batch(statements, "write");
  const after = await getConnection(db, input.tenantId, input.connectionId);
  if (!after) throw new Error("connection_not_found");
  const recorded = updated.rowsAffected === 1;
  const nowMs = input.now.getTime();
  const flipped =
    recorded &&
    (after.status !== before.status ||
      after.last_health_verdict !== before.last_health_verdict ||
      isVerifiedHealthy(after, nowMs) !== isVerifiedHealthy(before, nowMs));
  return {
    connection: after,
    previousStatus: before.status,
    previousVerdict: before.last_health_verdict,
    recorded,
    flipped,
    worsened: recorded && isWorseStatus(before.status, after.status),
  };
}

// ── Disconnect ────────────────────────────────────────────────────────────

/**
 * Mark a connection revoked and drop its webhook routes, in one batch. The
 * credential is deleted BEFORE this by the caller (lib/connections/service.ts),
 * so a revoked row never sits next to a stored secret. Returns false when
 * there was nothing live to revoke in THIS tenant.
 *
 * `alsoDelete` is the provider's own data that must not outlive the
 * connection (Slack: its channel map and looked-up people), deleted in the
 * SAME batch, so a disconnect never half-happens.
 */
export async function revokeConnection(
  db: Client,
  input: { tenantId: string; connectionId: string; revokedBy: string | null; now: Date; alsoDelete?: readonly InStatement[] },
): Promise<boolean> {
  const nowIso = input.now.toISOString();
  const [revoked] = await db.batch(
    [
      {
        sql: `UPDATE tenant_connections SET status = 'revoked', revoked_at = ?, revoked_by = ?,
                refresh_lease_until = NULL, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
        args: [nowIso, input.revokedBy, nowIso, input.connectionId, input.tenantId],
      },
      {
        sql: `DELETE FROM provider_webhook_routes WHERE tenant_id = ? AND connection_id = ?`,
        args: [input.tenantId, input.connectionId],
      },
      ...(input.alsoDelete ?? []),
    ],
    "write",
  );
  return revoked.rowsAffected === 1;
}

// ── Token refresh lease (lib/connections/token-store.ts) ──────────────────

/**
 * Compare-and-set refresh lease: succeeds for exactly one caller holding the
 * current token_version while no unexpired lease exists, and bumps the version
 * so every other caller's CAS now fails. Returns the new version, or null.
 */
export async function takeRefreshLease(
  db: Client,
  input: { tenantId: string; connectionId: string; expectedVersion: number; now: Date; leaseMs: number },
): Promise<number | null> {
  const nowIso = input.now.toISOString();
  const until = new Date(input.now.getTime() + input.leaseMs).toISOString();
  const rs = await db.execute({
    sql: `UPDATE tenant_connections
          SET refresh_lease_until = ?, token_version = token_version + 1, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND token_version = ? AND revoked_at IS NULL
            AND (refresh_lease_until IS NULL OR refresh_lease_until < ?)`,
    args: [until, nowIso, input.connectionId, input.tenantId, input.expectedVersion, nowIso],
  });
  return rs.rowsAffected === 1 ? input.expectedVersion + 1 : null;
}

/** Release a lease this caller holds (its version still current). */
export async function releaseRefreshLease(
  db: Client,
  input: { tenantId: string; connectionId: string; version: number; now: Date },
): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE tenant_connections SET refresh_lease_until = NULL, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND token_version = ?`,
    args: [input.now.toISOString(), input.connectionId, input.tenantId, input.version],
  });
  return rs.rowsAffected === 1;
}

// ── Webhook routes ────────────────────────────────────────────────────────

export async function registerWebhookRoute(
  db: Client,
  input: { tenantId: string; provider: string; externalKey: string; connectionId: string; now: Date },
): Promise<{ ok: true } | { ok: false; error: "route_taken" | "connection_not_found" }> {
  // The connection must be this tenant's own, live one.
  const conn = await getConnection(db, input.tenantId, input.connectionId);
  if (!conn || conn.revoked_at) return { ok: false, error: "connection_not_found" };
  try {
    await db.execute({
      sql: `INSERT INTO provider_webhook_routes (id, tenant_id, provider, external_key, connection_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [randomUUID(), input.tenantId, input.provider, input.externalKey, input.connectionId, input.now.toISOString()],
    });
    return { ok: true };
  } catch (err) {
    if (!isUniqueViolationError(err as { message?: string })) throw err;
    const rs = await db.execute({
      sql: `SELECT 1 FROM provider_webhook_routes
            WHERE provider = ? AND external_key = ? AND tenant_id = ? AND connection_id = ?`,
      args: [input.provider, input.externalKey, input.tenantId, input.connectionId],
    });
    return rs.rows.length > 0 ? { ok: true } : { ok: false, error: "route_taken" };
  }
}

/**
 * CROSS-TENANT by nature: a webhook arrives with no session, and this is how
 * it finds its tenant. Only a live connection answers.
 */
export async function resolveWebhookRoute(
  db: Client,
  provider: string,
  externalKey: string,
): Promise<{ tenantId: string; connectionId: string } | null> {
  const rs = await db.execute({
    sql: `SELECT r.tenant_id, r.connection_id FROM provider_webhook_routes r
          JOIN tenant_connections c ON c.id = r.connection_id AND c.tenant_id = r.tenant_id
          WHERE r.provider = ? AND r.external_key = ? AND c.revoked_at IS NULL
          LIMIT 1`,
    args: [provider, externalKey],
  });
  const r = rows(rs)[0];
  return r ? { tenantId: String(r.tenant_id), connectionId: String(r.connection_id) } : null;
}

// ── Health cron (system) ──────────────────────────────────────────────────

/**
 * CROSS-TENANT (cron only). Live connections of the given providers whose last
 * check is older than `staleBefore`, never-checked first. Revoked rows are
 * never probed.
 */
export async function listConnectionsDueForHealth(
  db: Client,
  input: {
    providers: readonly string[];
    /**
     * Also this provider's connections in workspaces that saved every one of
     * these credential fields (Slack: a workspace's own Slack app, which keeps
     * its connection checkable where OASIS's app is not set up). Presence only.
     */
    alsoWhereTenantSaved?: { provider: string; service: string; fields: readonly string[] };
    staleBefore: Date;
    limit: number;
  },
): Promise<ConnectionRow[]> {
  const also = input.alsoWhereTenantSaved && input.alsoWhereTenantSaved.fields.length > 0 ? input.alsoWhereTenantSaved : null;
  if (input.providers.length === 0 && !also) return [];
  const which: string[] = [];
  const args: (string | number)[] = [];
  if (input.providers.length > 0) {
    which.push(`provider IN (${input.providers.map(() => "?").join(", ")})`);
    args.push(...input.providers);
  }
  if (also) {
    which.push(`(provider = ? AND tenant_id IN (
              SELECT tenant_id FROM tenant_integration_credentials
              WHERE service = ? AND field_key IN (${also.fields.map(() => "?").join(", ")})
              GROUP BY tenant_id HAVING COUNT(DISTINCT field_key) = ?))`);
    args.push(also.provider, also.service, ...also.fields, also.fields.length);
  }
  const rs = await db.execute({
    sql: `SELECT ${CONNECTION_COLUMNS} FROM tenant_connections
          WHERE (${which.join(" OR ")}) AND revoked_at IS NULL
            AND (last_health_at IS NULL OR last_health_at < ?)
          ORDER BY COALESCE(last_health_at, '') ASC
          LIMIT ?`,
    args: [...args, input.staleBefore.toISOString(), Math.max(1, Math.min(500, input.limit))],
  });
  return rows(rs).map(toConnection);
}

/** CROSS-TENANT (cron only). Trim health history and old OAuth states. */
export async function pruneConnectionHistory(
  db: Client,
  now: Date,
): Promise<{ healthChecksDeleted: number; oauthStatesDeleted: number }> {
  const [checks, states] = await db.batch(
    [
      {
        sql: `DELETE FROM connection_health_checks WHERE checked_at < ?`,
        args: [new Date(now.getTime() - HEALTH_CHECK_RETENTION_MS).toISOString()],
      },
      {
        sql: `DELETE FROM oauth_states WHERE created_at < ?`,
        args: [new Date(now.getTime() - OAUTH_STATE_RETENTION_MS).toISOString()],
      },
    ],
    "write",
  );
  return { healthChecksDeleted: checks.rowsAffected, oauthStatesDeleted: states.rowsAffected };
}
