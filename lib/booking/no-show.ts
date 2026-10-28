/**
 * lib/booking/no-show.ts - record that a founder meeting did not happen, and
 * mint the lead's link to pick a new time (CC, 2026-10-28: "make sure they are
 * accounted for to rebook").
 *
 * Before this, a missed meeting stayed "scheduled" forever: the Pipeline could
 * not tell a held call from a missed one, and nothing offered the lead a way
 * back in. This is the one place that closes it out, used by the operator's
 * internal route now and by the reminder dispatcher's automatic check later:
 *   1. closeVerifiedFounderMeeting(no_show): status no_answer, workflow no_show,
 *      every pending reminder cancelled. Refused before the start time.
 *   2. The lead keeps its stage (Founder Meeting, the existing no-show
 *      convention) and gets founder_meeting_status "no_show", the outcome and
 *      a next action a day out, through transition_pipeline_lead with a request
 *      id derived from the appointment and its revision, so a retry is a no-op.
 *   3. A rebook link signed for this appointment (lib/booking/rebook-token.ts).
 *
 * `who` says what the room saw. It is recorded, never guessed: "unknown" is
 * the honest answer when there is no join data (a Google Meet link).
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rebookUrl, signRebookToken } from "@/lib/booking/rebook-token";
import { loadRebookAppointment, loadRebookLead, REBOOK_LEAD_STAGE, type RebookAppointment } from "@/lib/booking/rebook";
import { closeVerifiedFounderMeeting } from "@/lib/website-sales-founder-meeting";

export type NoShowWho = "lead_absent" | "host_absent" | "both_absent" | "missed_each_other" | "unknown";

export const NO_SHOW_WHO: readonly NoShowWho[] = ["lead_absent", "host_absent", "both_absent", "missed_each_other", "unknown"];

const NEXT_ACTION_MS = 24 * 60 * 60 * 1000;

export type NoShowResult = {
  appointmentId: string;
  leadId: string;
  revision: number;
  /** The meeting was already closed as a no-show before this call. */
  alreadyClosed: boolean;
  /** The lead record was moved to "no_show" (false when it has moved on, or was already marked). */
  leadUpdated: boolean;
  leadStage: string;
  rebookUrl: string;
  rebookToken: string;
  scheduledFor: string;
  clientName: string | null;
};

export type NoShowDependencies = {
  db: SupabaseClient;
  now: () => number;
  close: typeof closeVerifiedFounderMeeting;
  origin: string;
  env?: Readonly<Record<string, string | undefined>>;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function whoSentence(who: NoShowWho): string {
  switch (who) {
    case "lead_absent":
      return "The lead did not join the video call.";
    case "host_absent":
      return "The lead joined the video call and nobody from OASIS did.";
    case "both_absent":
      return "Nobody joined the video call.";
    case "missed_each_other":
      return "The lead and OASIS were both in the video call room, at different times, and never met.";
    default:
      return "Marked as missed.";
  }
}

export async function markFounderMeetingNoShow(
  input: { tenantId: string; appointmentId: string; who: NoShowWho; actorUserId: string },
  deps: NoShowDependencies,
): Promise<NoShowResult> {
  const nowMs = deps.now();
  const appointment: RebookAppointment | null = await loadRebookAppointment(deps.db, input.tenantId, input.appointmentId);
  if (!appointment) throw new Error("appointment_not_found");
  if (appointment.meeting_kind !== "founder_audit") throw new Error("not_a_founder_meeting");

  const alreadyClosed = appointment.status === "no_answer" && appointment.workflow_status === "no_show";
  if (!alreadyClosed) {
    if (appointment.status !== "scheduled" || appointment.workflow_status !== "active") {
      throw new Error(`meeting_not_closable:${appointment.status}/${appointment.workflow_status}`);
    }
    // A no-show is never recorded early. The close refuses on its own clock too.
    const startMs = Date.parse(appointment.scheduled_for);
    if (!Number.isFinite(startMs) || startMs > nowMs) throw new Error("meeting_not_started");
    await deps.close({
      tenantId: input.tenantId,
      leadId: appointment.lead_id,
      appointmentId: appointment.id,
      outcome: "no_show",
    });
  }

  const lead = await loadRebookLead(deps.db, input.tenantId, appointment.lead_id);
  if (!lead) throw new Error("lead_not_found");
  const leadStage = text(lead.stage);
  const pointsHere = text(lead.calendar_appointment_id) === appointment.id;
  let leadUpdated = false;
  // The lead is written only while the meeting is still this closed no-show
  // and the lead still carries its time: a rebook landing between the close and
  // here (a lead reusing an old link) moved both, and must not be overwritten
  // (Codex review of #773, round 3).
  const latest = await loadRebookAppointment(deps.db, input.tenantId, input.appointmentId);
  const stillMissed =
    !!latest &&
    latest.status === "no_answer" &&
    latest.workflow_status === "no_show" &&
    latest.revision === appointment.revision &&
    Date.parse(latest.scheduled_for) === Date.parse(appointment.scheduled_for);
  const leadMeetingAt = Date.parse(text(lead.founder_meeting_at));
  const leadShowsThisMeeting = !Number.isFinite(leadMeetingAt) || leadMeetingAt === Date.parse(appointment.scheduled_for);
  if (
    stillMissed &&
    leadShowsThisMeeting &&
    leadStage === REBOOK_LEAD_STAGE &&
    pointsHere &&
    text(lead.founder_meeting_status) !== "no_show"
  ) {
    const occurredAt = new Date(nowMs).toISOString();
    const transition = await deps.db.rpc("transition_pipeline_lead", {
      p_tenant_id: input.tenantId,
      p_lead_id: appointment.lead_id,
      p_expected_stage: REBOOK_LEAD_STAGE,
      p_expected_owner_id: typeof lead.assigned_to === "string" ? lead.assigned_to : null,
      p_patch: {
        stage: REBOOK_LEAD_STAGE,
        deal_outcome: "no_show",
        deal_outcome_at: occurredAt,
        founder_meeting_status: "no_show",
        no_show_who: input.who,
        no_show_recorded_at: occurredAt,
        next_action_at: new Date(nowMs + NEXT_ACTION_MS).toISOString(),
      },
      p_request_id: `no-show:${appointment.id}:${appointment.revision}`,
      p_occurred_at: occurredAt,
      p_actor_user_id: input.actorUserId,
      p_action: "deal_outcome",
      p_interaction_type: "deal_outcome",
      p_subject: "Meeting missed",
      p_content: `Deal outcome: no_show. ${whoSentence(input.who)} The ${appointment.scheduled_for} meeting is closed as a no-show; the lead can pick a new time from their rebook link.`,
      p_is_call: false,
      p_metadata: {
        appointment_id: appointment.id,
        deal_outcome: "no_show",
        no_show_who: input.who,
        missed_meeting_at: appointment.scheduled_for,
        source: "meeting_no_show",
      },
    });
    const data = transition.data as { ok?: boolean; error?: string } | null;
    if (transition.error || data?.ok === false) {
      throw new Error(`no_show_lead_update_failed:${transition.error?.message || data?.error || "refused"}`);
    }
    leadUpdated = true;
  }

  const rebookToken = signRebookToken(
    { tenantId: input.tenantId, appointmentId: appointment.id, leadId: appointment.lead_id },
    { nowMs, env: deps.env },
  );
  return {
    appointmentId: appointment.id,
    leadId: appointment.lead_id,
    revision: appointment.revision,
    alreadyClosed,
    leadUpdated,
    leadStage,
    rebookUrl: rebookUrl(deps.origin, rebookToken),
    rebookToken,
    scheduledFor: appointment.scheduled_for,
    clientName: appointment.client_name_snapshot,
  };
}
