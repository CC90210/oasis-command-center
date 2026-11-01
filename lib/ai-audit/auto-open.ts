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

/** Founder meetings still ahead and still on, nearest first. */
export async function upcomingFounderMeetings(db: Client, tenantId: string, now: Date, limit = AUTO_OPEN_LIMIT): Promise<UpcomingMeeting[]> {
  const rs = await db.execute({
    sql: `SELECT id, lead_id, meet_room_id FROM call_appointments
          WHERE tenant_id = ? AND entity_type = 'lead'
            AND status = 'scheduled' AND workflow_status = 'active' AND calendar_status = 'verified'
            AND scheduled_for > ?
          ORDER BY scheduled_for ASC LIMIT ?`,
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
      if (!e.meet_room_id && meeting.meet_room_id) patch.meet_room_id = meeting.meet_room_id;
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
