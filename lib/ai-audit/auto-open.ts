/**
 * lib/ai-audit/auto-open.ts — every booked founder meeting gets its Free AI
 * Audit opened by itself (CC, 2026-11-01: "auto-create audit engagements on
 * booking", so the research is ready BEFORE the call).
 *
 * Until now an engagement opened only when someone pressed "Start AI audit"
 * on the lead, so a call could arrive with nothing prepared: on 2026-11-01
 * both of the next day's audit calls had no engagement and no brief.
 *
 * WHICH MEETINGS. A founder meeting still ahead, still on: the appointment is
 * scheduled, its workflow active and its calendar event verified. Past calls,
 * no-shows and cancellations are left alone, so the old founder meetings on
 * the Pipeline do not all open at once.
 *
 * WHAT IT DOES. openEngagement for the lead (it hands back the open one when
 * there is one, and opens at Meeting booked when the lead is at Founder
 * Meeting), then records the appointment and its Oasis Meet room on the
 * engagement, once. A link the owner or an earlier run set to another
 * appointment is kept. The tick's brief step (lib/ai-audit/briefs.ts) then
 * reads the client's website in the same run.
 *
 * Runs from the audit tick (lib/ai-audit/tick.ts), never inside the booking
 * itself: an audit that cannot be opened never fails a booking. Nothing here
 * contacts the client. Safe to repeat.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { openEngagement, patchEngagement, requireTenant, type Actor } from "@/lib/ai-audit/store";

/** Meetings handled per tenant per tick, nearest first. */
export const AUTO_OPEN_LIMIT = 10;

const SYSTEM: Actor = { type: "system", id: null };

export type AutoOpenReport = { opened: number; linked: number };

type UpcomingMeeting = { id: string; lead_id: string; meet_room_id: string | null };

/** Whether call_appointments exists (a fresh database or a test fixture may not have it). */
export async function callAppointmentsInstalled(db: Client): Promise<boolean> {
  const rs = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_appointments'", args: [] });
  return rs.rows.length > 0;
}

/**
 * Founder meetings still ahead and still on that have something left to do, nearest first.
 *
 * The limit counts only those (CodeRabbit on #789): a meeting whose lead is gone or Lost, or whose open
 * engagement is already linked (to it, with its room, or to another appointment), is filtered out by the
 * query itself, so ten of them can never keep an eleventh meeting from being reached.
 */
export async function upcomingFounderMeetings(db: Client, tenantId: string, now: Date, limit = AUTO_OPEN_LIMIT): Promise<UpcomingMeeting[]> {
  const rs = await db.execute({
    sql: `SELECT a.id, a.lead_id, a.meet_room_id FROM call_appointments a
          JOIN tenant_records l ON l.tenant_id = a.tenant_id AND l.id = a.lead_id AND l.entity_type = 'lead'
          WHERE a.tenant_id = ? AND a.entity_type = 'lead' AND a.meeting_kind = 'founder_audit'
            AND a.status = 'scheduled' AND a.workflow_status = 'active' AND a.calendar_status = 'verified'
            AND a.scheduled_for > ?
            AND COALESCE(CASE WHEN json_valid(l.data) THEN json_extract(l.data, '$.stage') END, '') <> 'lost'
            AND NOT EXISTS (
              SELECT 1 FROM ai_audit_engagements e
              WHERE e.tenant_id = a.tenant_id AND e.lead_id = a.lead_id AND e.closed_at IS NULL
                AND e.appointment_id IS NOT NULL
                AND (e.appointment_id <> a.id OR a.meet_room_id IS NULL OR e.meet_room_id IS a.meet_room_id)
            )
          ORDER BY a.scheduled_for ASC LIMIT ?`,
    args: [requireTenant(tenantId), now.toISOString(), limit],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    lead_id: String(r.lead_id),
    meet_room_id: typeof r.meet_room_id === "string" && r.meet_room_id ? r.meet_room_id : null,
  }));
}

/**
 * Open (or find) the audit for each upcoming founder meeting and record its
 * appointment and room. One meeting that fails is reported by `onError` and
 * the rest still run.
 */
export async function autoOpenForBookedMeetings(
  db: Client,
  input: { tenantId: string; now: Date; onError?: (appointmentId: string, err: unknown) => void },
): Promise<AutoOpenReport> {
  const tenantId = requireTenant(input.tenantId);
  const report: AutoOpenReport = { opened: 0, linked: 0 };
  if (!(await callAppointmentsInstalled(db))) return report;
  for (const meeting of await upcomingFounderMeetings(db, tenantId, input.now)) {
    try {
      const opened = await openEngagement(db, { tenantId, leadId: meeting.lead_id, actor: SYSTEM, now: input.now });
      // A lead that is gone or marked Lost has nothing to prepare.
      if (!opened.ok) continue;
      if (opened.created) report.opened += 1;
      const e = opened.engagement;
      // Linked once. An engagement already tied to another appointment keeps it.
      if (e.appointment_id && e.appointment_id !== meeting.id) continue;
      const patch: { appointment_id?: string; meet_room_id?: string } = {};
      if (!e.appointment_id) patch.appointment_id = meeting.id;
      // The appointment's room is the one to join: a reschedule that replaced the room moves the link with it.
      if (meeting.meet_room_id && e.meet_room_id !== meeting.meet_room_id) patch.meet_room_id = meeting.meet_room_id;
      if (!Object.keys(patch).length) continue;
      const saved = await patchEngagement(db, {
        tenantId,
        id: e.id,
        expectedRowVersion: e.row_version,
        patch,
        event: "meeting_linked",
        actor: SYSTEM,
        now: input.now,
        refType: "call_appointment",
        refId: meeting.id,
      });
      // A conflict means someone changed the engagement meanwhile: the next tick tries again.
      if (saved.ok) report.linked += 1;
    } catch (err) {
      input.onError?.(meeting.id, err);
    }
  }
  return report;
}
