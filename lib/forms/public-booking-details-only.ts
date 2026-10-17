/**
 * lib/forms/public-booking-details-only.ts - the one sales-desk alert for a /book
 * visitor who left details without a time (app/api/forms/booking/details-only).
 *
 * The alert fires on that explicit submit, never on "a lead with no booking
 * yet": /book creates the lead a few seconds before it books, so that rule
 * would false-alarm every real booking (e9, 2026-10-17).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { tursoConfigured } from "@/lib/turso";

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
 * Claim this lead's details-only alert, once. One statement stamps
 * `details_only_alerted_at` on the lead only while it is unstamped and holds no
 * booked call, so a repeat or a racing second request never alerts twice, and a
 * lead that did book is never reported as waiting.
 */
export async function claimDetailsOnlyAlert(
  db: Client,
  input: { tenantId: string; leadId: string; now: Date },
): Promise<boolean> {
  const at = input.now.toISOString();
  const res = await db.execute({
    sql: `UPDATE tenant_records
             SET data = json_set(data, '$.details_only_alerted_at', ?), updated_at = ?
           WHERE tenant_id = ? AND id = ? AND entity_type = 'lead'
             AND json_extract(data, '$.details_only_alerted_at') IS NULL
             AND COALESCE(json_extract(data, '$.calendar_appointment_id'), '') = ''
           RETURNING id`,
    args: [at, at, input.tenantId, input.leadId],
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
 * two racing requests can both alert; acceptable on a rollback-only path, and
 * still never for a lead that is stamped or booked.
 */
export async function claimDetailsOnlyAlertLegacy(
  service: LeadPatcher,
  input: { tenantId: string; leadId: string; lead: Record<string, unknown>; now: Date },
): Promise<boolean> {
  if (input.lead.details_only_alerted_at) return false;
  const appointment = input.lead.calendar_appointment_id;
  if (typeof appointment === "string" && appointment.trim()) return false;
  const res = await service.rpc("patch_tenant_record_data", {
    p_id: input.leadId,
    p_tenant_id: input.tenantId,
    p_patch: { details_only_alerted_at: input.now.toISOString() },
  });
  return !res.error;
}
