import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { TENANT_ID_BRAND } from "@/lib/email/brand-for-tenant";
import { getServiceSupabase } from "@/lib/supabase-server";

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_LIMIT = 100;

type ReservationStatus = "direct_reserved" | "direct_attempting";

type ReservationRow = {
  id: string;
  tenant_id: string;
  metadata: unknown;
};

export type DashboardEmailReservationRecovery = {
  inspected: number;
  queued: number;
  delivery_unknown: number;
  raced: number;
  errors: number;
};

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Invalid legacy metadata is handled below as a skipped/raced row. The
      // recovery job must never replace it with an invented object.
    }
  }
  return {};
}

/**
 * Recover dashboard-email reservations left behind by a terminated request.
 *
 * A request that died before any transport began is safe to expose to the
 * queue. Once a provider call began, delivery may have happened even if its
 * receipt never came back, so that row becomes terminal and requires review.
 * It is never automatically sent again.
 */
export async function recoverStaleDashboardEmailReservations(args: {
  db?: SupabaseClient;
  now?: Date;
  staleAfterMs?: number;
  limit?: number;
} = {}): Promise<DashboardEmailReservationRecovery> {
  const db = args.db ?? getServiceSupabase();
  const now = args.now ?? new Date();
  const staleAfterMs = Math.max(60_000, args.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, 500));
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const oasisTenantIds = Object.entries(TENANT_ID_BRAND)
    .filter(([, brand]) => brand === "oasis")
    .map(([tenantId]) => tenantId);
  const out: DashboardEmailReservationRecovery = {
    inspected: 0,
    queued: 0,
    delivery_unknown: 0,
    raced: 0,
    errors: 0,
  };

  if (!oasisTenantIds.length) return out;

  const stale = await db
    .from("lead_interactions")
    .select("id,tenant_id,metadata")
    .in("tenant_id", oasisTenantIds)
    .eq("agent_source", "dashboard_drawer")
    .eq("type", "email_queued")
    .in("metadata->>status", ["direct_reserved", "direct_attempting"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (stale.error) throw new Error(`dashboard_email_reservation_read_failed: ${stale.error.message}`);

  const rows = (stale.data ?? []) as ReservationRow[];
  out.inspected = rows.length;
  for (const row of rows) {
    const metadata = metadataObject(row.metadata);
    const fromStatus = String(metadata.status ?? "") as ReservationStatus;
    if (fromStatus !== "direct_reserved" && fromStatus !== "direct_attempting") {
      out.raced += 1;
      continue;
    }

    const attemptToken = typeof metadata.attempt_token === "string"
      ? metadata.attempt_token
      : "";
    const recoveredAt = now.toISOString();
    const nextMetadata: Record<string, unknown> = fromStatus === "direct_reserved"
      ? {
          ...metadata,
          status: "queued",
          queued_at: recoveredAt,
          queue_reason: "stale_pre_dispatch_reservation_recovered",
          reservation_recovered_at: recoveredAt,
        }
      : {
          ...metadata,
          status: "delivery_unknown",
          delivery_unknown_at: recoveredAt,
          send_error: "uncertain_delivery_after_direct_attempt",
          needs_operator_review: true,
        };

    let transition = db
      .from("lead_interactions")
      .update({ metadata: nextMetadata })
      .eq("id", row.id)
      .eq("tenant_id", row.tenant_id)
      .eq("metadata->>status", fromStatus);
    if (attemptToken) {
      transition = transition.eq("metadata->>attempt_token", attemptToken);
    }
    const transitioned = await transition.select("id").maybeSingle();
    if (transitioned.error) {
      out.errors += 1;
      console.error("[dashboard-email-reservations] recovery transition failed", {
        interaction_id: row.id,
        tenant_id: row.tenant_id,
        from_status: fromStatus,
        error: transitioned.error.message,
      });
      continue;
    }
    if (!transitioned.data?.id) {
      out.raced += 1;
      continue;
    }
    if (fromStatus === "direct_reserved") out.queued += 1;
    else out.delivery_unknown += 1;
  }

  return out;
}
