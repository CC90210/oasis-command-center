/**
 * Pure state machine for the Cloud dashboard-email drain.
 *
 * The scheduled route owns I/O. This module owns the safety contract so it can
 * be exercised against an in-memory store: exact OASIS email lanes, read-only
 * rehearsal, compare-and-swap claims, receipt reconciliation, deterministic
 * provider identity, bounded retry, and terminal ambiguity.
 */

import { randomUUID } from "node:crypto";
import { mailboxBrandConflict, TENANT_ID_BRAND } from "@/lib/email/brand-for-tenant";

export const OASIS_DASHBOARD_EMAIL_SENDER_SWITCH = "OASIS_DASHBOARD_EMAIL_SENDER_FORWARD";
export const DASHBOARD_EMAIL_CLAIM_LEASE_MS = 3 * 60_000;
export const DASHBOARD_EMAIL_STALE_QUEUE_MS = 15 * 60_000;
export const DASHBOARD_EMAIL_DEFAULT_LIMIT = 5;

const OASIS_TENANT_IDS = new Set(
  Object.entries(TENANT_ID_BRAND)
    .filter(([, brand]) => brand === "oasis")
    .map(([tenantId]) => tenantId),
);
const TRUTHY = new Set(["on", "true", "1", "yes"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DashboardEmailMetadata = Record<string, unknown>;

export type DashboardEmailQueueRow = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  type: string;
  channel: string;
  direction: string;
  agent_source: string;
  provider: string | null;
  provider_message_id: string | null;
  subject: string | null;
  content: string | null;
  content_preview: string | null;
  to_email: string | null;
  metadata: unknown;
  created_at: string;
  sent_at: string | null;
};

export type DashboardEmailReceipt = {
  id: string;
  sent_at: string | null;
  provider_message_id: string | null;
};

export type DashboardEmailCasExpected = {
  status: string;
  claimToken?: string;
  claimedAt?: string | null;
};

export type DashboardEmailCasWrite = {
  metadata: DashboardEmailMetadata;
  sentAt?: string | null;
};

export interface DashboardEmailSenderStore {
  listRunnable(now: Date, limit: number): Promise<DashboardEmailQueueRow[]>;
  listStaleSending(now: Date, limit: number): Promise<DashboardEmailQueueRow[]>;
  listAmbiguousReceipts(now: Date, limit: number): Promise<DashboardEmailQueueRow[]>;
  findCanonicalReceipt(row: DashboardEmailQueueRow): Promise<DashboardEmailReceipt | null>;
  compareAndSet(
    row: DashboardEmailQueueRow,
    expected: DashboardEmailCasExpected,
    write: DashboardEmailCasWrite,
  ): Promise<boolean>;
}

export type DashboardEmailSendResult =
  | {
      ok: true;
      provider: "oasis_shared_gmail";
      gmail_message_id: string;
      from_address: string;
    }
  | {
      ok: false;
      provider: "oasis_shared_gmail";
      reason:
        | "not_configured"
        | "brand_mismatch"
        | "send_failed"
        | "delivery_unknown"
        | "suppressed"
        | "suppression_error";
      error: string;
    };

export type DashboardEmailSend = (args: {
  row: DashboardEmailQueueRow;
  idempotencyKey: string;
}) => Promise<DashboardEmailSendResult>;

export type DashboardEmailSenderSummary = {
  mode: "dry_run" | "live";
  inspected: number;
  would_process: Array<{ id: string; lane: "dashboard_drawer" | "ai_audit_transactional"; status: string }>;
  would_mark_delivery_unknown: string[];
  would_check_ambiguous_receipts: string[];
  claimed: number;
  sent: number;
  reconciled: number;
  retried: number;
  failed: number;
  suppressed: number;
  delivery_unknown: number;
  raced: number;
  transition_failures: number;
};

export function dashboardEmailMetadata(value: unknown): DashboardEmailMetadata {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as DashboardEmailMetadata) };
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as DashboardEmailMetadata) };
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function dashboardEmailSenderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUTHY.has((env[OASIS_DASHBOARD_EMAIL_SENDER_SWITCH] ?? "").trim().toLowerCase());
}

export type DashboardEmailCredentialReadiness =
  | { ready: true; fromAddress: string }
  | { ready: false; reason: string; missing?: string[] };

/**
 * The cloud drain intentionally requires the deployment-owned env pair. The
 * shared sender's tenant-row fallback remains for existing synchronous paths,
 * but it is not accepted as evidence that this new unattended job is ready.
 */
export function dashboardEmailCredentialReadiness(
  env: Record<string, string | undefined> = process.env,
): DashboardEmailCredentialReadiness {
  const fromAddress = (env.OASIS_MAIL_FROM ?? "").trim();
  const appPassword = (env.OASIS_MAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  const missing = [
    ...(!fromAddress ? ["OASIS_MAIL_FROM"] : []),
    ...(!appPassword ? ["OASIS_MAIL_APP_PASSWORD"] : []),
  ];
  if (missing.length) {
    return {
      ready: false,
      reason: `missing ${missing.join(" and ")}`,
      missing,
    };
  }
  if (!EMAIL_RE.test(fromAddress)) {
    return { ready: false, reason: "OASIS_MAIL_FROM is not a valid email address" };
  }
  const conflict = mailboxBrandConflict("oasis", fromAddress);
  if (conflict) return { ready: false, reason: conflict };
  return { ready: true, fromAddress };
}

export function dashboardEmailLane(
  row: Pick<DashboardEmailQueueRow, "agent_source" | "provider">,
): "dashboard_drawer" | "ai_audit_transactional" | null {
  if (row.agent_source === "dashboard_drawer") return "dashboard_drawer";
  if (
    row.agent_source === "ai_audit_transactional" &&
    row.provider === "oasis_transactional_outbox"
  ) {
    return "ai_audit_transactional";
  }
  return null;
}

/** Exact ownership boundary: OASIS, outbound email, and one of two lanes. */
export function isDashboardEmailLane(row: DashboardEmailQueueRow): boolean {
  return (
    OASIS_TENANT_IDS.has(row.tenant_id) &&
    row.type === "email_queued" &&
    row.channel === "email" &&
    row.direction === "outbound" &&
    dashboardEmailLane(row) !== null
  );
}

export function dashboardEmailIdempotencyKey(row: DashboardEmailQueueRow): string {
  const metadata = dashboardEmailMetadata(row.metadata);
  for (const candidate of [
    row.provider_message_id,
    metadata.outbox_delivery_key,
    metadata.delivery_key,
    metadata.attempt_token,
  ]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return value;
  }
  return `dashboard-email:${row.id}`;
}

function due(row: DashboardEmailQueueRow, nowMs: number): boolean {
  const metadata = dashboardEmailMetadata(row.metadata);
  const status = String(metadata.status ?? "");
  if (status === "queued") return true;
  if (status !== "retry") return false;
  const next = Date.parse(String(metadata.next_attempt_at ?? ""));
  return !Number.isFinite(next) || next <= nowMs;
}

/** True only when a sending claim is expired or cannot prove a live lease. */
export function dashboardEmailStaleSending(row: DashboardEmailQueueRow, nowMs: number): boolean {
  const metadata = dashboardEmailMetadata(row.metadata);
  if (metadata.status !== "sending") return false;
  const lease = Date.parse(String(metadata.lease_expires_at ?? ""));
  if (Number.isFinite(lease)) return lease <= nowMs;
  const claimed = Date.parse(String(metadata.claimed_at ?? ""));
  if (Number.isFinite(claimed)) return claimed + DASHBOARD_EMAIL_CLAIM_LEASE_MS <= nowMs;
  // A sending row without a parseable lease or claim time cannot prove that a
  // worker still owns it. It is ambiguous work, never permission to resend.
  return true;
}

function expectedFor(row: DashboardEmailQueueRow): DashboardEmailCasExpected {
  const metadata = dashboardEmailMetadata(row.metadata);
  const expected: DashboardEmailCasExpected = { status: String(metadata.status ?? "") };
  const claimToken = typeof metadata.claim_token === "string" ? metadata.claim_token : "";
  const claimedAt = typeof metadata.claimed_at === "string" ? metadata.claimed_at : "";
  if (claimToken) expected.claimToken = claimToken;
  else expected.claimedAt = claimedAt || null;
  return expected;
}

function withoutLiveLease(metadata: DashboardEmailMetadata): DashboardEmailMetadata {
  const next = { ...metadata };
  delete next.claim_token;
  delete next.lease_expires_at;
  return next;
}

function sentMetadata(
  row: DashboardEmailQueueRow,
  at: string,
  receipt?: DashboardEmailReceipt | null,
  provider?: { gmail_message_id: string; from_address: string } | null,
): DashboardEmailMetadata {
  const next: DashboardEmailMetadata = {
    ...withoutLiveLease(dashboardEmailMetadata(row.metadata)),
    status: "sent",
    sent_at: receipt?.sent_at || at,
    ...(receipt
      ? {
          gateway_interaction_id: receipt.id,
          reconciled: true,
          ...(receipt.provider_message_id
            ? { gateway_provider_message_id: receipt.provider_message_id }
            : {}),
        }
      : {}),
    ...(provider
      ? {
          sent_via: "oasis_shared_gmail",
          gmail_message_id: provider.gmail_message_id,
          from_address: provider.from_address,
        }
      : {}),
  };
  delete next.send_error;
  delete next.next_attempt_at;
  return next;
}

async function reconcileReceipt(
  store: DashboardEmailSenderStore,
  row: DashboardEmailQueueRow,
  receipt: DashboardEmailReceipt,
  at: string,
): Promise<boolean> {
  return store.compareAndSet(row, expectedFor(row), {
    metadata: sentMetadata(row, at, receipt),
    sentAt: receipt.sent_at || at,
  });
}

function terminalMetadata(
  row: DashboardEmailQueueRow,
  status: "failed" | "suppressed" | "delivery_unknown",
  at: string,
  reason: string,
  attempts?: number,
): DashboardEmailMetadata {
  const metadata = withoutLiveLease(dashboardEmailMetadata(row.metadata));
  return {
    ...metadata,
    status,
    ...(attempts === undefined ? {} : { attempts }),
    send_error: reason.slice(0, 500),
    ...(status === "delivery_unknown"
      ? { delivery_unknown_at: at, needs_operator_review: true }
      : status === "failed"
        ? { failed_at: at, needs_operator_review: true }
        : { suppressed_at: at }),
  };
}

function baseSummary(dryRun: boolean): DashboardEmailSenderSummary {
  return {
    mode: dryRun ? "dry_run" : "live",
    inspected: 0,
    would_process: [],
    would_mark_delivery_unknown: [],
    would_check_ambiguous_receipts: [],
    claimed: 0,
    sent: 0,
    reconciled: 0,
    retried: 0,
    failed: 0,
    suppressed: 0,
    delivery_unknown: 0,
    raced: 0,
    transition_failures: 0,
  };
}

/** Run one bounded queue pass. The caller must apply off-switch/credential gates first. */
export async function runDashboardEmailSender(args: {
  store: DashboardEmailSenderStore;
  send: DashboardEmailSend;
  now?: Date;
  dryRun?: boolean;
  limit?: number;
  claimToken?: () => string;
}): Promise<DashboardEmailSenderSummary> {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const at = now.toISOString();
  const dryRun = args.dryRun === true;
  const limit = Math.max(1, Math.min(args.limit ?? DASHBOARD_EMAIL_DEFAULT_LIMIT, 25));
  const summary = baseSummary(dryRun);

  const [rawRunnable, rawStale, rawAmbiguous] = await Promise.all([
    args.store.listRunnable(now, limit),
    args.store.listStaleSending(now, limit),
    args.store.listAmbiguousReceipts(now, limit),
  ]);
  const runnable = rawRunnable
    .filter((row) => isDashboardEmailLane(row) && due(row, nowMs))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
  const stale = rawStale
    .filter((row) => isDashboardEmailLane(row) && dashboardEmailStaleSending(row, nowMs))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
  const ambiguous = rawAmbiguous
    .filter((row) => (
      isDashboardEmailLane(row) &&
      dashboardEmailLane(row) === "ai_audit_transactional" &&
      dashboardEmailMetadata(row.metadata).status === "delivery_unknown"
    ))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
  summary.inspected = runnable.length + stale.length + ambiguous.length;
  summary.would_process = runnable.map((row) => ({
    id: row.id,
    lane: dashboardEmailLane(row)!,
    status: String(dashboardEmailMetadata(row.metadata).status ?? ""),
  }));
  summary.would_mark_delivery_unknown = stale.map((row) => row.id);
  summary.would_check_ambiguous_receipts = ambiguous.map((row) => row.id);
  if (dryRun) return summary;

  // A send_gateway receipt can land after a crashed claim was conservatively
  // parked as delivery_unknown. Receipt proof may close that ambiguity; the
  // absence of proof never reopens it for delivery.
  for (const row of ambiguous) {
    const receipt = await args.store.findCanonicalReceipt(row);
    if (!receipt) continue;
    if (await reconcileReceipt(args.store, row, receipt, at)) summary.reconciled += 1;
    else summary.raced += 1;
  }

  // A crashed post-claim process is ambiguous. A canonical receipt proves it
  // sent; without one the only safe automatic outcome is delivery_unknown.
  for (const row of stale) {
    const receipt = await args.store.findCanonicalReceipt(row);
    if (receipt) {
      if (await reconcileReceipt(args.store, row, receipt, at)) summary.reconciled += 1;
      else summary.raced += 1;
      continue;
    }
    const changed = await args.store.compareAndSet(row, expectedFor(row), {
      metadata: terminalMetadata(
        row,
        "delivery_unknown",
        at,
        "claim lease expired without a canonical delivery receipt; automatic resend refused",
      ),
    });
    if (changed) summary.delivery_unknown += 1;
    else summary.raced += 1;
  }

  for (const row of runnable) {
    // The PC sender may have delivered before its status write. Reconcile that
    // proof before taking a new claim or talking to Gmail.
    const existingReceipt = await args.store.findCanonicalReceipt(row);
    if (existingReceipt) {
      if (await reconcileReceipt(args.store, row, existingReceipt, at)) summary.reconciled += 1;
      else summary.raced += 1;
      continue;
    }

    const metadata = dashboardEmailMetadata(row.metadata);
    const claimToken = (args.claimToken ?? randomUUID)();
    const claimedMetadata: DashboardEmailMetadata = {
      ...metadata,
      status: "sending",
      claim_token: claimToken,
      claimed_at: at,
      lease_expires_at: new Date(nowMs + DASHBOARD_EMAIL_CLAIM_LEASE_MS).toISOString(),
    };
    const claimed = await args.store.compareAndSet(
      row,
      expectedFor(row),
      { metadata: claimedMetadata },
    );
    if (!claimed) {
      summary.raced += 1;
      continue;
    }
    summary.claimed += 1;
    const claimedRow: DashboardEmailQueueRow = { ...row, metadata: claimedMetadata };

    // Close the tiny read->claim race with the old process: if its receipt
    // arrived meanwhile, that proof wins and this runner sends nothing.
    const receiptAfterClaim = await args.store.findCanonicalReceipt(claimedRow);
    if (receiptAfterClaim) {
      if (await reconcileReceipt(args.store, claimedRow, receiptAfterClaim, at)) summary.reconciled += 1;
      else summary.transition_failures += 1;
      continue;
    }

    const to = (claimedRow.to_email ?? "").trim();
    const body = (claimedRow.content || claimedRow.content_preview || "").trim();
    if (!EMAIL_RE.test(to) || !body || !claimedRow.lead_id) {
      const reason = !EMAIL_RE.test(to)
        ? "invalid or missing email destination"
        : !body
          ? "missing email body"
          : "missing lead id";
      const changed = await args.store.compareAndSet(
        claimedRow,
        { status: "sending", claimToken },
        { metadata: terminalMetadata(claimedRow, "failed", at, reason) },
      );
      if (changed) summary.failed += 1;
      else summary.transition_failures += 1;
      continue;
    }

    let result: DashboardEmailSendResult;
    try {
      result = await args.send({
        row: claimedRow,
        idempotencyKey: dashboardEmailIdempotencyKey(claimedRow),
      });
    } catch (error) {
      // A thrown provider call does not prove where in SMTP it failed.
      result = {
        ok: false,
        provider: "oasis_shared_gmail",
        reason: "delivery_unknown",
        error: error instanceof Error ? error.message : "provider threw",
      };
    }

    const attempts = Number(metadata.attempts ?? 0) + 1;
    if (result.ok) {
      const changed = await args.store.compareAndSet(
        claimedRow,
        { status: "sending", claimToken },
        {
          metadata: {
            ...sentMetadata(claimedRow, at, null, result),
            attempts,
            last_attempt_at: at,
          },
          sentAt: at,
        },
      );
      if (changed) summary.sent += 1;
      else summary.transition_failures += 1;
      continue;
    }

    const reason = `${result.reason}: ${result.error}`.slice(0, 500);
    if (result.reason === "delivery_unknown") {
      const changed = await args.store.compareAndSet(
        claimedRow,
        { status: "sending", claimToken },
        { metadata: terminalMetadata(claimedRow, "delivery_unknown", at, reason, attempts) },
      );
      if (changed) summary.delivery_unknown += 1;
      else summary.transition_failures += 1;
      continue;
    }
    if (result.reason === "suppressed") {
      const changed = await args.store.compareAndSet(
        claimedRow,
        { status: "sending", claimToken },
        { metadata: terminalMetadata(claimedRow, "suppressed", at, reason, attempts) },
      );
      if (changed) summary.suppressed += 1;
      else summary.transition_failures += 1;
      continue;
    }
    if (result.reason === "brand_mismatch") {
      const changed = await args.store.compareAndSet(
        claimedRow,
        { status: "sending", claimToken },
        { metadata: terminalMetadata(claimedRow, "failed", at, reason, attempts) },
      );
      if (changed) summary.failed += 1;
      else summary.transition_failures += 1;
      continue;
    }

    // Confirmed pre-delivery failures retry with bounded exponential backoff.
    const maxAttempts = Math.max(1, Number(metadata.max_attempts ?? 5));
    const terminal = attempts >= maxAttempts;
    const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, attempts - 1)));
    const retryMetadata = terminal
      ? terminalMetadata(claimedRow, "failed", at, reason, attempts)
      : {
          ...withoutLiveLease(dashboardEmailMetadata(claimedRow.metadata)),
          status: "retry",
          attempts,
          last_attempt_at: at,
          next_attempt_at: new Date(nowMs + delaySeconds * 1000).toISOString(),
          send_error: reason,
        };
    const changed = await args.store.compareAndSet(
      claimedRow,
      { status: "sending", claimToken },
      { metadata: retryMetadata },
    );
    if (!changed) summary.transition_failures += 1;
    else if (terminal) summary.failed += 1;
    else summary.retried += 1;
  }

  return summary;
}
