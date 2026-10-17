/**
 * lib/forms/public-booking-details-only.ts - the sales-desk alert for a /book
 * visitor who left details without a time (app/api/forms/booking/details-only).
 *
 * The alert fires on that explicit submit, never on "a lead with no booking
 * yet": /book creates the lead a few seconds before it books, so that rule
 * would false-alarm every real booking (e9, 2026-10-17). Whether the lead
 * already holds a live call is the route's check (bookedCallFromAppointment),
 * not a field on the lead: a past or cancelled call leaves its id behind
 * (Codex review of #677).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { tursoConfigured } from "@/lib/turso";

/**
 * A lead alerts at most once in this window: a repeat or a racing second
 * request of the same visit never alerts twice, and a lead who comes back on
 * another day and again cannot pick a time alerts again.
 */
export const DETAILS_ONLY_REALERT_MS = 24 * 60 * 60 * 1000;

/**
 * Turso holds the leads: the same switch getServiceSupabase reads
 * (lib/supabase-server.ts). Otherwise the deploy has been rolled back to
 * Supabase, and a stamp written to Turso would land on a stale copy of the lead
 * (Codex review of #677).
 */
export function tursoHoldsTheLeads(env: Record<string, string | undefined> = process.env): boolean {
  return env.EMPIRE_DATA_BACKEND === "turso_cloud" && tursoConfigured();
}

/**
 * Claim this lead's details-only alert. One statement stamps
 * `details_only_alerted_at` only while the lead is unstamped or was last
 * stamped before the window, so racing requests never alert twice.
 */
export async function claimDetailsOnlyAlert(
  db: Client,
  input: { tenantId: string; leadId: string; now: Date },
): Promise<boolean> {
  const at = input.now.toISOString();
  const cutoff = new Date(input.now.getTime() - DETAILS_ONLY_REALERT_MS).toISOString();
  const res = await db.execute({
    sql: `UPDATE tenant_records
             SET data = json_set(data, '$.details_only_alerted_at', ?), updated_at = ?
           WHERE tenant_id = ? AND id = ? AND entity_type = 'lead'
             AND (json_extract(data, '$.details_only_alerted_at') IS NULL
                  OR json_extract(data, '$.details_only_alerted_at') < ?)
           RETURNING id`,
    args: [at, at, input.tenantId, input.leadId, cutoff],
  });
  return res.rows.length > 0;
}

/** The part of the service client the rollback path uses. */
type LeadPatcher = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>;
};

/**
 * The same claim when the deploy is rolled back to Supabase: judged on the lead
 * as just read, then stamped through patch_tenant_record_data. Not atomic, so
 * two racing requests can both alert; acceptable on a rollback-only path.
 */
export async function claimDetailsOnlyAlertLegacy(
  service: LeadPatcher,
  input: { tenantId: string; leadId: string; lead: Record<string, unknown>; now: Date },
): Promise<boolean> {
  const last = typeof input.lead.details_only_alerted_at === "string" ? Date.parse(input.lead.details_only_alerted_at) : NaN;
  if (Number.isFinite(last) && input.now.getTime() - last < DETAILS_ONLY_REALERT_MS) return false;
  const res = await service.rpc("patch_tenant_record_data", {
    p_id: input.leadId,
    p_tenant_id: input.tenantId,
    p_patch: { details_only_alerted_at: input.now.toISOString() },
  });
  return !res.error;
}
