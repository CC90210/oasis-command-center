/**
 * Durable compare-and-swap journal for operator-only scheduled deliveries.
 *
 * The provider boundary is deliberately pessimistic: before making an
 * outward call the row becomes `attempting`. A provider receipt moves it to
 * `delivered`; any caught failure moves it to terminal `delivery_unknown`.
 * If the process disappears during the call, a later invocation converts the
 * expired `attempting` lease to `delivery_unknown` instead of sending again.
 */
import "server-only";

import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { redactAll } from "@/lib/secret-redaction";

export const OPERATOR_JOB_DELIVERY_LEASE_MS = 2 * 60_000;

export type OperatorJobDeliveryClaim =
  | { state: "claimed"; deliveryKey: string; claimToken: string }
  | { state: "already_delivered"; deliveryKey: string }
  | { state: "delivery_in_flight"; deliveryKey: string }
  | { state: "delivery_unknown"; deliveryKey: string };

type DeliveryRow = {
  job_key: unknown;
  scheduled_for: unknown;
  status: unknown;
  claim_token: unknown;
  lease_expires_at: unknown;
  attempt_started_at: unknown;
};

function bounded(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return redactAll(String(value)).slice(0, 500);
}

function validDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function readDelivery(
  db: Client,
  tenantId: string,
  deliveryKey: string,
): Promise<DeliveryRow | null> {
  const rs = await db.execute({
    sql: `SELECT job_key, scheduled_for, status, claim_token, lease_expires_at, attempt_started_at
            FROM operator_job_deliveries
           WHERE tenant_id = ? AND delivery_key = ?
           LIMIT 1`,
    args: [tenantId, deliveryKey],
  });
  return (rs.rows[0] as unknown as DeliveryRow | undefined) ?? null;
}

function leaseIsActive(value: unknown, nowMs: number): boolean {
  const leaseMs = value === null || value === undefined ? NaN : Date.parse(String(value));
  return Number.isFinite(leaseMs) && leaseMs > nowMs;
}

/**
 * Claim one date/tick key. Only an expired `claimed` row with no attempt may
 * be taken over. An expired `attempting` row is terminalized as unknown.
 */
export async function claimOperatorJobDelivery(input: {
  db: Client;
  tenantId: string;
  jobKey: string;
  scheduledFor: string;
  nowMs: number;
  claimToken?: string;
}): Promise<OperatorJobDeliveryClaim> {
  if (!validDateKey(input.scheduledFor)) throw new Error("operator_job_delivery_invalid_date_key");
  const deliveryKey = `${input.jobKey}:${input.scheduledFor}`;
  const claimToken = input.claimToken ?? randomUUID();
  const nowIso = new Date(input.nowMs).toISOString();
  const leaseIso = new Date(input.nowMs + OPERATOR_JOB_DELIVERY_LEASE_MS).toISOString();
  const inserted = await input.db.execute({
    sql: `INSERT OR IGNORE INTO operator_job_deliveries
            (id, tenant_id, job_key, delivery_key, scheduled_for, status,
             claim_token, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?)`,
    args: [randomUUID(), input.tenantId, input.jobKey, deliveryKey, input.scheduledFor, claimToken, leaseIso, nowIso, nowIso],
  });
  if (inserted.rowsAffected === 1) return { state: "claimed", deliveryKey, claimToken };

  // At most one CAS retry is needed: another contender either changed the row
  // to a terminal state or owns the current lease.
  for (let readNo = 0; readNo < 2; readNo += 1) {
    const row = await readDelivery(input.db, input.tenantId, deliveryKey);
    if (!row) throw new Error("operator_job_delivery_claim_disappeared");
    if (String(row.job_key) !== input.jobKey || String(row.scheduled_for) !== input.scheduledFor) {
      throw new Error("operator_job_delivery_key_collision");
    }
    const status = String(row.status);
    if (status === "delivered") return { state: "already_delivered", deliveryKey };
    if (status === "delivery_unknown") return { state: "delivery_unknown", deliveryKey };

    if (status === "attempting") {
      if (leaseIsActive(row.lease_expires_at, input.nowMs)) {
        return { state: "delivery_in_flight", deliveryKey };
      }
      const terminal = await input.db.execute({
        sql: `UPDATE operator_job_deliveries
                 SET status = 'delivery_unknown', lease_expires_at = NULL,
                     last_error = COALESCE(last_error, 'attempt lease expired without a provider receipt'),
                     updated_at = ?
               WHERE tenant_id = ? AND delivery_key = ? AND status = 'attempting'
                 AND claim_token = ?`,
        args: [nowIso, input.tenantId, deliveryKey, String(row.claim_token)],
      });
      if (terminal.rowsAffected === 1) return { state: "delivery_unknown", deliveryKey };
      continue;
    }

    if (status !== "claimed" || row.attempt_started_at !== null) {
      throw new Error(`operator_job_delivery_invalid_state:${status}`);
    }
    if (leaseIsActive(row.lease_expires_at, input.nowMs)) {
      return { state: "delivery_in_flight", deliveryKey };
    }
    const reclaimed = await input.db.execute({
      sql: `UPDATE operator_job_deliveries
               SET claim_token = ?, lease_expires_at = ?, updated_at = ?
             WHERE tenant_id = ? AND delivery_key = ? AND status = 'claimed'
               AND claim_token = ? AND attempt_started_at IS NULL
               AND lease_expires_at <= ?`,
      args: [claimToken, leaseIso, nowIso, input.tenantId, deliveryKey, String(row.claim_token), nowIso],
    });
    if (reclaimed.rowsAffected === 1) return { state: "claimed", deliveryKey, claimToken };
  }
  return { state: "delivery_in_flight", deliveryKey };
}

/** Write the no-return provider boundary before making the outward call. */
export async function beginOperatorJobDeliveryAttempt(input: {
  db: Client;
  tenantId: string;
  deliveryKey: string;
  claimToken: string;
  nowMs: number;
}): Promise<void> {
  const nowIso = new Date(input.nowMs).toISOString();
  const moved = await input.db.execute({
    sql: `UPDATE operator_job_deliveries
             SET status = 'attempting', attempt_started_at = ?, updated_at = ?
           WHERE tenant_id = ? AND delivery_key = ? AND status = 'claimed'
             AND claim_token = ? AND attempt_started_at IS NULL
             AND lease_expires_at > ?`,
    args: [nowIso, nowIso, input.tenantId, input.deliveryKey, input.claimToken, nowIso],
  });
  if (moved.rowsAffected !== 1) throw new Error("operator_job_delivery_attempt_cas_failed");
}

/** Store the positive provider receipt. Losing this CAS remains ambiguous. */
export async function completeOperatorJobDelivery(input: {
  db: Client;
  tenantId: string;
  deliveryKey: string;
  claimToken: string;
  nowMs: number;
  providerOutcome: unknown;
}): Promise<boolean> {
  const nowIso = new Date(input.nowMs).toISOString();
  const moved = await input.db.execute({
    sql: `UPDATE operator_job_deliveries
             SET status = 'delivered', delivered_at = ?, provider_outcome = ?,
                 last_error = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE tenant_id = ? AND delivery_key = ? AND status = 'attempting'
             AND claim_token = ? AND attempt_started_at IS NOT NULL`,
    args: [nowIso, bounded(input.providerOutcome), nowIso, input.tenantId, input.deliveryKey, input.claimToken],
  });
  return moved.rowsAffected === 1;
}

/** Terminalize a provider attempt that has no trustworthy delivered receipt. */
export async function markOperatorJobDeliveryUnknown(input: {
  db: Client;
  tenantId: string;
  deliveryKey: string;
  claimToken: string;
  nowMs: number;
  providerOutcome?: unknown;
  error?: unknown;
}): Promise<void> {
  const nowIso = new Date(input.nowMs).toISOString();
  await input.db.execute({
    sql: `UPDATE operator_job_deliveries
             SET status = 'delivery_unknown', provider_outcome = COALESCE(?, provider_outcome),
                 last_error = COALESCE(?, last_error), lease_expires_at = NULL,
                 updated_at = ?
           WHERE tenant_id = ? AND delivery_key = ? AND status IN ('attempting', 'delivery_unknown')
             AND claim_token = ?`,
    args: [bounded(input.providerOutcome), bounded(input.error instanceof Error ? input.error.message : input.error), nowIso,
      input.tenantId, input.deliveryKey, input.claimToken],
  });
}
