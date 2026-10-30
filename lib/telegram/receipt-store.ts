/**
 * Durable Telegram ingress/reply receipt on the existing agent_events table.
 *
 * No migration is needed: agent_events already has a globally unique
 * idempotency_key plus pending/processing/done state, visibility leases and a
 * JSON payload. Every statement binds the fixed OASIS correlation id and the
 * receipt id; a Telegram update can never touch another event.
 */
import "server-only";
import type { Client, Row } from "@libsql/client";
import {
  isOasisTelegramJob,
  OASIS_TELEGRAM_TENANT_ID,
  sameTelegramJob,
  telegramIdempotencyKey,
  telegramReceiptId,
  type OasisTelegramJob,
} from "./protocol";

export type TelegramReceiptPhase = "received" | "prepared" | "sending" | "sent" | "delivery_unknown";

export type TelegramReceiptPayload = {
  v: 1;
  job: OasisTelegramJob;
  phase: TelegramReceiptPhase;
  replyText?: string;
  telegramMessageId?: number;
};

export type TelegramReceipt = {
  id: string;
  status: "pending" | "processing" | "done" | "failed" | "dead";
  payload: TelegramReceiptPayload;
  visibilityUntil: string | null;
  retryCount: number;
  lastError: string | null;
};

const EVENT_TYPE = "oasis_telegram_message";
const PUBLISHER = "telegram";
const TARGET = "oasis-command-center.telegram";
const PROCESSOR = "oasis-command-center.telegram-worker";
const CLAIM_MS = 10 * 60_000;

function parsePayload(raw: unknown): TelegramReceiptPayload | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value?.v !== 1 ||
      !isOasisTelegramJob(value.job) ||
      !["received", "prepared", "sending", "sent", "delivery_unknown"].includes(String(value.phase))
    ) {
      return null;
    }
    if (value.replyText !== undefined && typeof value.replyText !== "string") return null;
    if (
      value.telegramMessageId !== undefined &&
      (!Number.isSafeInteger(value.telegramMessageId) || Number(value.telegramMessageId) < 1)
    ) {
      return null;
    }
    return value as unknown as TelegramReceiptPayload;
  } catch {
    return null;
  }
}

function receiptFromRow(row: Row | Record<string, unknown>): TelegramReceipt {
  const payload = parsePayload(row.payload);
  if (!payload) throw new Error("telegram_receipt_payload_invalid");
  const status = String(row.status);
  if (!["pending", "processing", "done", "failed", "dead"].includes(status)) {
    throw new Error("telegram_receipt_status_invalid");
  }
  return {
    id: String(row.id),
    status: status as TelegramReceipt["status"],
    payload,
    visibilityUntil: row.visibility_until === null || row.visibility_until === undefined ? null : String(row.visibility_until),
    retryCount: Number(row.retry_count ?? 0),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  };
}

const RECEIPT_COLUMNS = "id, status, payload, visibility_until, retry_count, last_error";

async function receiptByKey(db: Client, job: OasisTelegramJob): Promise<TelegramReceipt | null> {
  const rs = await db.execute({
    sql: `SELECT ${RECEIPT_COLUMNS} FROM agent_events
          WHERE idempotency_key = ? AND correlation_id = ? AND event_type = ? LIMIT 1`,
    args: [telegramIdempotencyKey(job), OASIS_TELEGRAM_TENANT_ID, EVENT_TYPE],
  });
  return rs.rows[0] ? receiptFromRow(rs.rows[0]) : null;
}

export async function ensureTelegramReceipt(
  db: Client,
  job: OasisTelegramJob,
  now: Date,
): Promise<{ created: boolean; receipt: TelegramReceipt }> {
  const at = now.toISOString();
  const payload: TelegramReceiptPayload = { v: 1, job, phase: "received" };
  const inserted = await db.execute({
    sql: `INSERT OR IGNORE INTO agent_events
            (id, event_type, publisher_agent, target_agent, severity, payload, correlation_id,
             published_at, created_at, source_agent, idempotency_key, status, retry_count)
          VALUES (?, ?, ?, ?, 'info', ?, ?, ?, ?, ?, ?, 'pending', 0)`,
    args: [
      telegramReceiptId(job),
      EVENT_TYPE,
      PUBLISHER,
      TARGET,
      JSON.stringify(payload),
      OASIS_TELEGRAM_TENANT_ID,
      at,
      at,
      PUBLISHER,
      telegramIdempotencyKey(job),
    ],
  });
  const receipt = await receiptByKey(db, job);
  if (!receipt) throw new Error("telegram_receipt_insert_failed");
  if (!sameTelegramJob(receipt.payload.job, job)) throw new Error("telegram_idempotency_key_reused");
  return { created: inserted.rowsAffected === 1, receipt };
}

export type TelegramClaim =
  | { state: "claimed"; receipt: TelegramReceipt; leaseToken: string }
  | { state: "done"; receipt: TelegramReceipt }
  | { state: "busy" };

export async function claimTelegramReceipt(db: Client, job: OasisTelegramJob, now: Date): Promise<TelegramClaim> {
  const current = await receiptByKey(db, job);
  if (!current) throw new Error("telegram_receipt_missing");
  if (!sameTelegramJob(current.payload.job, job)) throw new Error("telegram_idempotency_key_reused");
  if (current.status === "done" || current.status === "dead") return { state: "done", receipt: current };
  const at = now.toISOString();
  const until = new Date(now.getTime() + CLAIM_MS).toISOString();
  const leaseToken = `${PROCESSOR}:${globalThis.crypto.randomUUID()}`;
  const rs = await db.execute({
    sql: `UPDATE agent_events
             SET status = 'processing', processed_by = ?, visibility_until = ?, retry_count = retry_count + 1,
                 last_error = NULL
           WHERE id = ? AND idempotency_key = ? AND correlation_id = ? AND event_type = ?
             AND (status IN ('pending','failed') OR (status = 'processing' AND visibility_until < ?))
           RETURNING ${RECEIPT_COLUMNS}`,
    args: [
      leaseToken,
      until,
      telegramReceiptId(job),
      telegramIdempotencyKey(job),
      OASIS_TELEGRAM_TENANT_ID,
      EVENT_TYPE,
      at,
    ],
  });
  return rs.rows[0]
    ? { state: "claimed", receipt: receiptFromRow(rs.rows[0]), leaseToken }
    : { state: "busy" };
}

async function writeProcessingPayload(
  db: Client,
  job: OasisTelegramJob,
  payload: TelegramReceiptPayload,
  leaseToken: string,
): Promise<void> {
  const rs = await db.execute({
    sql: `UPDATE agent_events SET payload = ?
          WHERE id = ? AND idempotency_key = ? AND correlation_id = ? AND event_type = ?
            AND status = 'processing' AND processed_by = ?`,
    args: [
      JSON.stringify(payload),
      telegramReceiptId(job),
      telegramIdempotencyKey(job),
      OASIS_TELEGRAM_TENANT_ID,
      EVENT_TYPE,
      leaseToken,
    ],
  });
  if (rs.rowsAffected !== 1) throw new Error("telegram_receipt_lease_lost");
}

export async function savePreparedTelegramReply(
  db: Client,
  job: OasisTelegramJob,
  replyText: string,
  leaseToken: string,
): Promise<TelegramReceiptPayload> {
  const payload: TelegramReceiptPayload = { v: 1, job, phase: "prepared", replyText };
  await writeProcessingPayload(db, job, payload, leaseToken);
  return payload;
}

export async function markTelegramSending(
  db: Client,
  job: OasisTelegramJob,
  replyText: string,
  leaseToken: string,
): Promise<TelegramReceiptPayload> {
  const payload: TelegramReceiptPayload = { v: 1, job, phase: "sending", replyText };
  await writeProcessingPayload(db, job, payload, leaseToken);
  return payload;
}

export async function releaseTelegramReceipt(
  db: Client,
  job: OasisTelegramJob,
  payload: TelegramReceiptPayload,
  error: string,
  leaseToken: string,
): Promise<void> {
  const rs = await db.execute({
    sql: `UPDATE agent_events
             SET status = 'pending', payload = ?, visibility_until = NULL, processed_by = NULL, last_error = ?
           WHERE id = ? AND idempotency_key = ? AND correlation_id = ? AND event_type = ?
             AND status = 'processing' AND processed_by = ?`,
    args: [
      JSON.stringify(payload),
      error.slice(0, 240),
      telegramReceiptId(job),
      telegramIdempotencyKey(job),
      OASIS_TELEGRAM_TENANT_ID,
      EVENT_TYPE,
      leaseToken,
    ],
  });
  if (rs.rowsAffected !== 1) throw new Error("telegram_receipt_lease_lost");
}

async function finishTelegramReceipt(
  db: Client,
  job: OasisTelegramJob,
  payload: TelegramReceiptPayload,
  now: Date,
  error: string | null,
  leaseToken: string,
): Promise<void> {
  const at = now.toISOString();
  const rs = await db.execute({
    sql: `UPDATE agent_events
             SET status = 'done', payload = ?, visibility_until = NULL, processed_at = ?, last_error = ?
           WHERE id = ? AND idempotency_key = ? AND correlation_id = ? AND event_type = ?
             AND status = 'processing' AND processed_by = ?`,
    args: [
      JSON.stringify(payload),
      at,
      error,
      telegramReceiptId(job),
      telegramIdempotencyKey(job),
      OASIS_TELEGRAM_TENANT_ID,
      EVENT_TYPE,
      leaseToken,
    ],
  });
  if (rs.rowsAffected !== 1) throw new Error("telegram_receipt_lease_lost");
}

export async function finishTelegramSent(
  db: Client,
  job: OasisTelegramJob,
  replyText: string,
  telegramMessageId: number,
  now: Date,
  leaseToken: string,
): Promise<void> {
  await finishTelegramReceipt(
    db,
    job,
    { v: 1, job, phase: "sent", replyText, telegramMessageId },
    now,
    null,
    leaseToken,
  );
}

/**
 * Once an outbound request entered the network, uncertainty is terminal. A
 * retry records the ambiguity and never emits a possible duplicate reply.
 */
export async function finishTelegramDeliveryUnknown(
  db: Client,
  job: OasisTelegramJob,
  replyText: string,
  now: Date,
  reason: string,
  leaseToken: string,
): Promise<void> {
  await finishTelegramReceipt(
    db,
    job,
    { v: 1, job, phase: "delivery_unknown", replyText },
    now,
    reason.slice(0, 240),
    leaseToken,
  );
}
