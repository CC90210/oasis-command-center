/** Outcome check for the cloud dashboard-email sender and its queue. */

import "server-only";

import type { DripCheck } from "@/lib/health/drip-checks";
import { TENANT_ID_BRAND } from "@/lib/email/brand-for-tenant";
import {
  DASHBOARD_EMAIL_CLAIM_LEASE_MS,
  DASHBOARD_EMAIL_STALE_QUEUE_MS,
  dashboardEmailMetadata,
  isDashboardEmailLane,
  type DashboardEmailQueueRow,
} from "@/lib/leads/dashboard-email-sender";

const READ_CAP = 500;
const RETRY_HEALTH_GRACE_MS = 2 * 60_000;
const OASIS_TENANT_IDS = Object.entries(TENANT_ID_BRAND)
  .filter(([, brand]) => brand === "oasis")
  .map(([tenantId]) => tenantId);

export type DashboardEmailHealthProblem = {
  id: string;
  kind:
    | "queued_stale"
    | "retry_due"
    | "lease_expired"
    | "delivery_unknown"
    | "terminal_failed"
    | "receipt_unreconciled";
};

export type DashboardEmailHealthSummary = {
  problems: DashboardEmailHealthProblem[];
  reason: string;
};

export function summarizeDashboardEmailHealth(
  rows: DashboardEmailQueueRow[],
  receiptQueueIds: ReadonlySet<string>,
  nowMs: number,
): DashboardEmailHealthSummary {
  const problems: DashboardEmailHealthProblem[] = [];
  for (const row of rows) {
    if (!isDashboardEmailLane(row)) continue;
    const metadata = dashboardEmailMetadata(row.metadata);
    const status = String(metadata.status ?? "");
    if (receiptQueueIds.has(row.id) && status !== "sent" && status !== "cancelled") {
      problems.push({ id: row.id, kind: "receipt_unreconciled" });
      continue;
    }
    if (status === "queued") {
      const created = Date.parse(row.created_at);
      if (Number.isFinite(created) && created + DASHBOARD_EMAIL_STALE_QUEUE_MS <= nowMs) {
        problems.push({ id: row.id, kind: "queued_stale" });
      }
      continue;
    }
    if (status === "retry") {
      const next = Date.parse(String(metadata.next_attempt_at ?? ""));
      if (!Number.isFinite(next) || next + RETRY_HEALTH_GRACE_MS <= nowMs) {
        problems.push({ id: row.id, kind: "retry_due" });
      }
      continue;
    }
    if (status === "sending") {
      const lease = Date.parse(String(metadata.lease_expires_at ?? ""));
      const claimed = Date.parse(String(metadata.claimed_at ?? ""));
      const expired = Number.isFinite(lease)
        ? lease <= nowMs
        : Number.isFinite(claimed)
          ? claimed + DASHBOARD_EMAIL_CLAIM_LEASE_MS <= nowMs
          : true;
      if (expired) problems.push({ id: row.id, kind: "lease_expired" });
      continue;
    }
    if (status === "delivery_unknown") {
      problems.push({ id: row.id, kind: "delivery_unknown" });
      continue;
    }
    if (status === "failed") problems.push({ id: row.id, kind: "terminal_failed" });
  }

  const count = (kind: DashboardEmailHealthProblem["kind"]) =>
    problems.filter((problem) => problem.kind === kind).length;
  const reason = problems.length === 0
    ? "dashboard email queue is draining: no stale queue, due retry, expired claim, terminal failure, ambiguity, or unreconciled gateway receipt"
    : [
        `queued stale=${count("queued_stale")}`,
        `retry due=${count("retry_due")}`,
        `leases expired=${count("lease_expired")}`,
        `delivery unknown=${count("delivery_unknown")}`,
        `terminal failed=${count("terminal_failed")}`,
        `receipt unreconciled=${count("receipt_unreconciled")}`,
      ].join("; ");
  return { problems, reason };
}

type HealthDb = Parameters<DripCheck["observe"]>[0];

async function readLane(
  db: HealthDb,
  source: "dashboard_drawer" | "ai_audit_transactional",
): Promise<{ rows: DashboardEmailQueueRow[]; error: string | null; capped: boolean }> {
  let query = db
    .from("lead_interactions")
    .select(
      "id,tenant_id,lead_id,type,channel,direction,agent_source,provider,provider_message_id,subject,to_email,metadata,created_at,sent_at",
    )
    .in("tenant_id", OASIS_TENANT_IDS)
    .eq("type", "email_queued")
    .eq("channel", "email")
    .eq("direction", "outbound")
    .eq("agent_source", source)
    .in("metadata->>status", [
      "queued",
      "retry",
      "sending",
      "failed",
      "delivery_unknown",
    ])
    .order("created_at", { ascending: true })
    .limit(READ_CAP);
  if (source === "ai_audit_transactional") {
    query = query.eq("provider", "oasis_transactional_outbox");
  }
  const result = await query;
  return {
    rows: (result.data ?? []) as DashboardEmailQueueRow[],
    error: result.error?.message ?? null,
    capped: (result.data ?? []).length >= READ_CAP,
  };
}

export async function observeDashboardEmailHealth(
  db: HealthDb,
  tenantId: string,
  endMs: number,
): Promise<{ observed: number | null; reason: string }> {
  if (TENANT_ID_BRAND[tenantId] !== "oasis") {
    return { observed: 0, reason: "not an OASIS workspace; cloud dashboard-email sender does not own this queue" };
  }
  try {
    const [drawer, transactional] = await Promise.all([
      readLane(db, "dashboard_drawer"),
      readLane(db, "ai_audit_transactional"),
    ]);
    if (drawer.error || transactional.error) {
      return {
        observed: null,
        reason: `dashboard email health read failed: ${drawer.error || transactional.error}`,
      };
    }
    if (drawer.capped || transactional.capped) {
      return {
        observed: null,
        reason: `dashboard email health read hit its ${READ_CAP}-row cap; refusing a partial queue verdict`,
      };
    }
    const rows = [...drawer.rows, ...transactional.rows];
    const transactionalIds = transactional.rows.map((row) => row.id);
    const receiptQueueIds = new Set<string>();
    if (transactionalIds.length) {
      const receipts = await db
        .from("lead_interactions")
        .select("metadata")
        .in("tenant_id", OASIS_TENANT_IDS)
        .eq("agent_source", "ai_audit_transactional")
        .eq("channel", "email")
        .eq("type", "email_sent")
        .in("metadata->>outbox_interaction_id", transactionalIds)
        .limit(READ_CAP);
      if (receipts.error) {
        return { observed: null, reason: `dashboard email receipt health read failed: ${receipts.error.message}` };
      }
      if ((receipts.data ?? []).length >= READ_CAP) {
        return { observed: null, reason: `dashboard email receipt health read hit its ${READ_CAP}-row cap` };
      }
      for (const receipt of receipts.data ?? []) {
        const metadata = dashboardEmailMetadata((receipt as { metadata?: unknown }).metadata);
        const queueId = typeof metadata.outbox_interaction_id === "string"
          ? metadata.outbox_interaction_id
          : "";
        if (queueId) receiptQueueIds.add(queueId);
      }
    }
    const summary = summarizeDashboardEmailHealth(rows, receiptQueueIds, endMs);
    return { observed: summary.problems.length, reason: summary.reason };
  } catch (error) {
    return {
      observed: null,
      reason: `dashboard email health check threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const DASHBOARD_EMAIL_CHECKS: DripCheck[] = [{
  id: "dashboard_email.queue_health",
  severity: "critical",
  rule: { kind: "must_be_zero" },
  observe: async (db, tenantId, endMs) =>
    (await observeDashboardEmailHealth(db, tenantId, endMs)).observed,
  observeDetailed: observeDashboardEmailHealth,
  describe: (result) => result.reason,
}];
