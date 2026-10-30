/** Database adapter for the pure dashboard-email sender state machine. */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { TENANT_ID_BRAND } from "@/lib/email/brand-for-tenant";
import {
  DASHBOARD_EMAIL_CLAIM_LEASE_MS,
  dashboardEmailLane,
  dashboardEmailStaleSending,
  type DashboardEmailCasExpected,
  type DashboardEmailCasWrite,
  type DashboardEmailQueueRow,
  type DashboardEmailReceipt,
  type DashboardEmailSenderStore,
} from "@/lib/leads/dashboard-email-sender";

const OASIS_TENANT_IDS = Object.entries(TENANT_ID_BRAND)
  .filter(([, brand]) => brand === "oasis")
  .map(([tenantId]) => tenantId);

const SELECT = [
  "id",
  "tenant_id",
  "lead_id",
  "type",
  "channel",
  "direction",
  "agent_source",
  "provider",
  "provider_message_id",
  "subject",
  "content",
  "content_preview",
  "to_email",
  "metadata",
  "created_at",
  "sent_at",
].join(",");

type Lane = "dashboard_drawer" | "ai_audit_transactional";
type JsonTimeFilter =
  | { kind: "lte"; field: string; value: string }
  | { kind: "is_null"; field: string };

function oldestUnique(rows: DashboardEmailQueueRow[][], limit: number): DashboardEmailQueueRow[] {
  const unique = new Map<string, DashboardEmailQueueRow>();
  for (const row of rows.flat()) unique.set(row.id, row);
  return [...unique.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
}

export class SupabaseDashboardEmailSenderStore implements DashboardEmailSenderStore {
  constructor(private readonly db: SupabaseClient) {}

  private async readLaneStatus(
    lane: Lane,
    status: "queued" | "retry" | "sending" | "delivery_unknown",
    limit: number,
    timeFilters: JsonTimeFilter[] = [],
  ): Promise<DashboardEmailQueueRow[]> {
    let query = this.db
      .from("lead_interactions")
      .select(SELECT)
      .in("tenant_id", OASIS_TENANT_IDS)
      .eq("type", "email_queued")
      .eq("channel", "email")
      .eq("direction", "outbound")
      .eq("agent_source", lane)
      .eq("metadata->>status", status)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (lane === "ai_audit_transactional") {
      query = query.eq("provider", "oasis_transactional_outbox");
    }
    for (const filter of timeFilters) {
      query = filter.kind === "lte"
        ? query.lte(filter.field, filter.value)
        : query.is(filter.field, null);
    }
    const result = await query;
    if (result.error) {
      throw new Error(`dashboard_email_${lane}_${status}_read_failed: ${result.error.message}`);
    }
    return (result.data ?? []) as unknown as DashboardEmailQueueRow[];
  }

  async listRunnable(now: Date, limit: number): Promise<DashboardEmailQueueRow[]> {
    const due = { kind: "lte", field: "metadata->>next_attempt_at", value: now.toISOString() } as const;
    const missingDue = { kind: "is_null", field: "metadata->>next_attempt_at" } as const;
    const reads = await Promise.all([
      this.readLaneStatus("dashboard_drawer", "queued", limit),
      this.readLaneStatus("dashboard_drawer", "retry", limit, [due]),
      this.readLaneStatus("dashboard_drawer", "retry", limit, [missingDue]),
      this.readLaneStatus("ai_audit_transactional", "queued", limit),
      this.readLaneStatus("ai_audit_transactional", "retry", limit, [due]),
      this.readLaneStatus("ai_audit_transactional", "retry", limit, [missingDue]),
    ]);
    return oldestUnique(reads, limit);
  }

  async listStaleSending(now: Date, limit: number): Promise<DashboardEmailQueueRow[]> {
    const leaseExpired = { kind: "lte", field: "metadata->>lease_expires_at", value: now.toISOString() } as const;
    const missingLease = { kind: "is_null", field: "metadata->>lease_expires_at" } as const;
    const claimExpired = {
      kind: "lte",
      field: "metadata->>claimed_at",
      value: new Date(now.getTime() - DASHBOARD_EMAIL_CLAIM_LEASE_MS).toISOString(),
    } as const;
    const reads = await Promise.all([
      this.readLaneStatus("dashboard_drawer", "sending", limit, [leaseExpired]),
      this.readLaneStatus("dashboard_drawer", "sending", limit, [missingLease, claimExpired]),
      // This bounded safety scan catches malformed non-null timestamps. Every
      // batch is filtered below before the global limit, so its live leases
      // cannot crowd an expired result out of the merged set.
      this.readLaneStatus("dashboard_drawer", "sending", Math.max(limit, 100)),
      this.readLaneStatus("ai_audit_transactional", "sending", limit, [leaseExpired]),
      this.readLaneStatus("ai_audit_transactional", "sending", limit, [missingLease, claimExpired]),
      this.readLaneStatus("ai_audit_transactional", "sending", Math.max(limit, 100)),
    ]);
    const nowMs = now.getTime();
    return oldestUnique(
      reads.map((batch) => batch.filter((row) => dashboardEmailStaleSending(row, nowMs))),
      limit,
    );
  }

  async listAmbiguousReceipts(_now: Date, limit: number): Promise<DashboardEmailQueueRow[]> {
    // Only the transactional lane has a separate canonical send_gateway
    // receipt. A drawer ambiguity has no independent proof to reconcile.
    return this.readLaneStatus("ai_audit_transactional", "delivery_unknown", limit);
  }

  async findCanonicalReceipt(row: DashboardEmailQueueRow): Promise<DashboardEmailReceipt | null> {
    if (dashboardEmailLane(row) !== "ai_audit_transactional") return null;
    const receipt = await this.db
      .from("lead_interactions")
      .select("id,sent_at,provider_message_id")
      .eq("tenant_id", row.tenant_id)
      .eq("agent_source", "ai_audit_transactional")
      .eq("channel", "email")
      .eq("type", "email_sent")
      .eq("metadata->>outbox_interaction_id", row.id)
      .limit(1)
      .maybeSingle();
    if (receipt.error) {
      throw new Error(`dashboard_email_receipt_read_failed: ${receipt.error.message}`);
    }
    return (receipt.data as DashboardEmailReceipt | null) ?? null;
  }

  async compareAndSet(
    row: DashboardEmailQueueRow,
    expected: DashboardEmailCasExpected,
    write: DashboardEmailCasWrite,
  ): Promise<boolean> {
    const payload: Record<string, unknown> = { metadata: write.metadata };
    if (write.sentAt !== undefined) payload.sent_at = write.sentAt;
    let query = this.db
      .from("lead_interactions")
      .update(payload)
      .eq("id", row.id)
      .eq("tenant_id", row.tenant_id)
      .eq("type", "email_queued")
      .eq("channel", "email")
      .eq("direction", "outbound")
      .eq("agent_source", row.agent_source)
      .eq("metadata->>status", expected.status);
    if (dashboardEmailLane(row) === "ai_audit_transactional") {
      query = query.eq("provider", "oasis_transactional_outbox");
    }
    if (expected.claimToken !== undefined) {
      query = query.eq("metadata->>claim_token", expected.claimToken);
    }
    if (expected.claimedAt === null) {
      query = query.is("metadata->>claimed_at", null);
    } else if (expected.claimedAt !== undefined) {
      query = query.eq("metadata->>claimed_at", expected.claimedAt);
    }
    const changed = await query.select("id").maybeSingle();
    if (changed.error) {
      throw new Error(`dashboard_email_state_transition_failed: ${changed.error.message}`);
    }
    return !!changed.data?.id;
  }
}
