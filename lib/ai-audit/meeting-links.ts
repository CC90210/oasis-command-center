import "server-only";
import type { Client } from "@libsql/client";
import { eventStatement, requireTenant } from "@/lib/ai-audit/store";

/** Detach only open audits still pointing at this cancelled appointment. */
export async function unlinkCancelledAuditMeeting(
  db: Client,
  input: { tenantId: string; leadId: string; appointmentId: string; now: Date },
): Promise<number> {
  const tenantId = requireTenant(input.tenantId);
  const installed = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_audit_engagements'");
  if (!installed.rows.length) return 0;
  const tx = await db.transaction("write");
  try {
    const changed = await tx.execute({
      sql: `UPDATE ai_audit_engagements SET appointment_id = NULL, meet_room_id = NULL,
              row_version = row_version + 1, updated_at = ?
            WHERE tenant_id = ? AND lead_id = ? AND appointment_id = ? AND closed_at IS NULL
              AND EXISTS (SELECT 1 FROM call_appointments a
                WHERE a.tenant_id = ai_audit_engagements.tenant_id AND a.id = ai_audit_engagements.appointment_id
                  AND a.lead_id = ai_audit_engagements.lead_id AND a.meeting_kind = 'founder_audit'
                  AND a.status = 'cancelled' AND a.workflow_status = 'cancelled' AND a.calendar_status = 'cancelled')
            RETURNING id`,
      args: [input.now.toISOString(), tenantId, input.leadId, input.appointmentId],
    });
    for (const row of changed.rows) {
      await tx.execute(eventStatement({
        tenantId, engagementId: String(row.id), event: "meeting_unlinked", actor: { type: "system", id: null },
        at: input.now.toISOString(), refType: "call_appointment", refId: input.appointmentId,
        meta: { reason: "meeting_cancelled" },
      }));
    }
    await tx.commit();
    return changed.rows.length;
  } catch (error) {
    try { await tx.rollback(); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    tx.close();
  }
}

/** Repairs a process interruption after cancellation committed, before detaching the audit. */
export async function repairCancelledAuditMeetingLinks(db: Client, tenantId: string, now: Date): Promise<void> {
  const rs = await db.execute({
    sql: `SELECT e.lead_id, e.appointment_id FROM ai_audit_engagements e
          JOIN call_appointments a ON a.tenant_id = e.tenant_id AND a.id = e.appointment_id AND a.lead_id = e.lead_id
          WHERE e.tenant_id = ? AND e.closed_at IS NULL AND a.meeting_kind = 'founder_audit'
            AND a.status = 'cancelled' AND a.workflow_status = 'cancelled' AND a.calendar_status = 'cancelled'
          ORDER BY e.updated_at LIMIT 100`,
    args: [requireTenant(tenantId)],
  });
  for (const row of rs.rows) await unlinkCancelledAuditMeeting(db, {
    tenantId, leadId: String(row.lead_id), appointmentId: String(row.appointment_id), now,
  });
}
