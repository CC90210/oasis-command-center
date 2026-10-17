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
