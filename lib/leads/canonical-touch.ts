import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";

type Db = ReturnType<typeof getServiceSupabase>;

export type CanonicalLeadTouch = {
  tenantId: string;
  leadId: string;
  /** Timestamp from the provider or the already-persisted interaction row. */
  occurredAt: string;
  /** Calls update both canonical fields; every other touch updates contact only. */
  isCall?: boolean;
  /**
   * Optional ownership snapshot for claim/outcome flows. If assignment changed
   * after authorization, Turso rejects the touch instead of stamping the new
   * owner's lead with the previous rep's action.
   */
  expectedOwnerId?: string | null;
};

/**
 * Persist the fields every pipeline SLA / Last Touch reader trusts.
 *
 * Provider retries can arrive late and out of order, so neither field is ever
 * moved backwards. Callers must pass a stable event timestamp (provider time,
 * or the ledger row's created_at on retry) rather than a fresh `new Date()`.
 * Errors are deliberately thrown: webhook callers return non-2xx for retry,
 * while irreversible outbound callers translate them into tracking_warning.
 */
export async function persistCanonicalLeadTouch(
  db: Db,
  input: CanonicalLeadTouch,
): Promise<{ lastContactedAt: string; lastCallAt: string | null }> {
  const persisted = await db.rpc("record_lead_touch", {
    p_id: input.leadId,
    p_tenant_id: input.tenantId,
    p_occurred_at: input.occurredAt,
    p_is_call: input.isCall === true,
    ...(input.expectedOwnerId !== undefined
      ? { p_expected_owner_id: input.expectedOwnerId }
      : {}),
  });
  if (persisted.error) {
    throw new Error(`canonical_touch_write_failed:${persisted.error.message}`);
  }

  const result =
    persisted.data && typeof persisted.data === "object"
      ? (persisted.data as Record<string, unknown>)
      : {};
  const lastContactedAt = result.last_contacted_at;
  const lastCallAt = result.last_call_at;
  if (typeof lastContactedAt !== "string") {
    throw new Error("canonical_touch_invalid_result");
  }
  return {
    lastContactedAt,
    lastCallAt: typeof lastCallAt === "string" ? lastCallAt : null,
  };
}
