/**
 * lib/booking/meeting-watch.ts - what the founder-meeting dispatcher watches
 * once a call's time comes (CC, 2026-10-28: "make sure they are accounted for
 * to rebook ... it's very vital to actually getting them to show up").
 *
 * Two jobs, run every minute by app/api/cron/dispatch-founder-meeting-reminders:
 *
 *   1. LEAD WAITING. During a call, the lead is in the Oasis Meet room and no
 *      host is: the founder gets an urgent email (host_guest_waiting), once per
 *      meeting. On 2026-10-25 a lead joined on time and waited two hours.
 *   2. MISSED. Fifteen minutes after the start, a meeting nobody held is
 *      closed out (lib/booking/no-show.ts) and the lead gets their own rebook
 *      link by email (and text, if they ticked it), then follow-ups at +24 h and
 *      +72 h until they rebook. Who joined is read from the room, never guessed:
 *        - lead never joined         -> "we missed each other"
 *        - lead joined, no host      -> an apology (CC chose auto-apologise)
 *        - nobody joined             -> "we missed each other"
 *        - both joined               -> held: nothing automatic, the founder records it
 *      A meeting with no Oasis Meet room (a Google Meet link) has no join data,
 *      so it is left for the founder: the Today page asks for its outcome.
 *
 * Only meetings that started 15 minutes to 48 hours ago are considered, so the
 * watcher never reaches back into old history on its first run.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { markFounderMeetingNoShow, type NoShowWho } from "@/lib/booking/no-show";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import { MEET_PRESENCE_MS } from "@/lib/meet/participants";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { closeVerifiedFounderMeeting } from "@/lib/website-sales-founder-meeting";
import { FOUNDER_MEETING_TIMEZONE, founderMeetingDedupeKey } from "@/lib/website-sales-meeting";

export const NO_SHOW_GRACE_MINUTES = 15;
export const NO_SHOW_LOOKBACK_HOURS = 48;
/** A join counts toward THIS meeting only inside this window around its slot (a lead who tested the link the night before did not attend). */
export const ATTENDANCE_EARLY_MINUTES = 30;
export const ATTENDANCE_LATE_MINUTES = 30;
export const NO_SHOW_FOLLOW_UPS_HOURS = [24, 72] as const;

export type Attendance = {
  guestJoined: boolean;
  hostJoined: boolean;
  guestPresentNow: boolean;
  hostPresentNow: boolean;
};

export type ParticipantRow = {
  role: string;
  joined_at: string;
  left_at: string | null;
  removed_at?: string | null;
  last_seen_at: string;
};

/** Who was in the room for this meeting's slot, and who is in it now. */
export function attendanceFrom(
  rows: ParticipantRow[],
  input: { startsAt: string; durationMinutes: number; nowMs: number },
): Attendance {
  const start = Date.parse(input.startsAt);
  const from = start - ATTENDANCE_EARLY_MINUTES * 60_000;
  const until = start + (input.durationMinutes + ATTENDANCE_LATE_MINUTES) * 60_000;
  const inSlot = (row: ParticipantRow) => {
    const joined = Date.parse(row.joined_at);
    return Number.isFinite(joined) && joined >= from && joined <= until;
  };
  const presentNow = (row: ParticipantRow) =>
    !row.left_at && !row.removed_at && Date.parse(row.last_seen_at) > input.nowMs - MEET_PRESENCE_MS;
  const guests = rows.filter((row) => row.role === "guest");
  const hosts = rows.filter((row) => row.role === "host");
  return {
    guestJoined: guests.some(inSlot),
    hostJoined: hosts.some(inSlot),
    guestPresentNow: guests.some(presentNow),
    hostPresentNow: hosts.some(presentNow),
  };
}

/** What a meeting that has passed its grace minutes was: held, or missed by whom. */
export function classifyMeeting(att: Pick<Attendance, "guestJoined" | "hostJoined">): "held" | NoShowWho {
  if (att.guestJoined && att.hostJoined) return "held";
  if (att.guestJoined) return "host_absent";
  if (att.hostJoined) return "lead_absent";
  return "both_absent";
}

function when(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_MEETING_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/**
 * The lead's messages after a missed meeting, in CC's voice. No em dashes
 * (CC, 2026-09-08). The shared mailbox adds the signature and footer.
 */
export function buildNoShowMessages(input: {
  firstName: string;
  offerLabel: string;
  missedAt: string;
  rebookUrl: string;
  who: NoShowWho;
}): {
  email: { subject: string; body: string };
  sms: string;
  followUps: Array<{ hours: number; subject: string; body: string }>;
} {
  const hi = input.firstName ? `Hi ${input.firstName},` : "Hi,";
  const offer = input.offerLabel || "call";
  const link = [
    "Here is your own link to pick a new time. It shows every open time in your time zone, and the video call link moves with it:",
    input.rebookUrl,
  ].join("\n");
  const apology = input.who === "host_absent";
  const email = apology
    ? {
        subject: "I'm sorry I missed our call",
        body: [
          hi,
          "",
          `You joined our ${offer} on ${when(input.missedAt)} and I wasn't there. I'm sorry, that's on me.`,
          "",
          link,
          "",
          "Or reply with a couple of times that suit you and I'll make one of them work.",
        ].join("\n"),
      }
    : {
        subject: "Sorry we missed each other",
        body: [
          hi,
          "",
          `We had your ${offer} booked for ${when(input.missedAt)}, and we didn't get to connect.`,
          "",
          link,
          "",
          "Or reply with a couple of times that suit you and I'll make one of them work.",
        ].join("\n"),
      };
  const sms = apology
    ? `OASIS AI: Sorry I missed our ${offer}. Pick a new time here: ${input.rebookUrl}`
    : `OASIS AI: Sorry we missed each other for your ${offer}. Pick a new time here: ${input.rebookUrl}`;
  const followUps = [
    {
      hours: NO_SHOW_FOLLOW_UPS_HOURS[0],
      subject: `Still want your ${offer}?`,
      body: [
        hi,
        "",
        `Just making sure my last note reached you. Your link to pick a new time for your ${offer} is still open:`,
        input.rebookUrl,
        "",
        "It takes about 15 minutes, and there is no cost.",
      ].join("\n"),
    },
    {
      hours: NO_SHOW_FOLLOW_UPS_HOURS[1],
      subject: `Last note about your ${offer}`,
      body: [
        hi,
        "",
        `I won't keep filling your inbox. If you'd still like your ${offer}, your link is here whenever you are ready:`,
        input.rebookUrl,
      ].join("\n"),
    },
  ];
  return { email, sms, followUps };
}

/** The founder's urgent note: the lead is in the room and nobody from OASIS is. */
export function buildGuestWaitingAlert(input: {
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  meetLink: string;
  startsAt: string;
  leadId: string;
}): { subject: string; body: string } {
  const who = input.name || "Your lead";
  return {
    subject: `${who} is waiting in the call room now`,
    body: [
      `${who}${input.company ? ` (${input.company})` : ""} is in the video call room and nobody from OASIS is.`,
      `The call was booked for ${when(input.startsAt)}.`,
      "",
      `Join now: ${input.meetLink}`,
      input.phone ? `Phone: ${input.phone}` : null,
      input.email ? `Email: ${input.email}` : null,
      `Lead: ${pipelineLeadUrl(input.leadId)}`,
    ].filter((line): line is string => line !== null).join("\n"),
  };
}

type WatchedAppointment = {
  id: string;
  tenant_id: string;
  lead_id: string;
  scheduled_for: string;
  duration_minutes: number | null;
  revision: number;
  assigned_to: string | null;
  meet_room_id: string | null;
  sms_consent: number | boolean;
  client_name_snapshot: string | null;
  company_snapshot: string | null;
  client_email_snapshot: string | null;
  client_phone_snapshot: string | null;
  google_meet_link: string | null;
  organizer_email_snapshot: string | null;
  offer_label: string | null;
};

const WATCH_COLUMNS =
  "id,tenant_id,lead_id,scheduled_for,duration_minutes,revision,assigned_to,meet_room_id,sms_consent,client_name_snapshot,company_snapshot,client_email_snapshot,client_phone_snapshot,google_meet_link,organizer_email_snapshot,offer_label";

export type WatchDependencies = {
  db: SupabaseClient;
  now: () => number;
  origin: string;
  markNoShow?: typeof markFounderMeetingNoShow;
  alert?: typeof pushWorkspaceAlert;
};

export type WatchResult = { guestWaiting: number; noShows: number; held: number; errors: string[] };

async function readParticipants(db: SupabaseClient, tenantId: string, roomId: string): Promise<ParticipantRow[]> {
  const result = await db
    .from("meet_participants")
    .select("role,joined_at,left_at,removed_at,last_seen_at")
    .eq("tenant_id", tenantId)
    .eq("room_id", roomId);
  if (result.error) throw new Error(`meet_participants_read_failed:${result.error.message}`);
  return (result.data || []) as ParticipantRow[];
}

async function insertNotification(db: SupabaseClient, row: Record<string, unknown>): Promise<boolean> {
  const inserted = await db.from("website_sales_meeting_notifications").insert(row);
  if (inserted.error) {
    if (String(inserted.error.message).toLowerCase().includes("unique")) return false;
    throw new Error(`meeting_watch_insert_failed:${inserted.error.message}`);
  }
  return true;
}

function firstNameOf(name: string | null): string {
  return (name || "").trim().split(/\s+/)[0]?.slice(0, 60) || "";
}

/**
 * Run both watches once. Never throws: each meeting's failure is collected
 * (and reported by the caller) so one bad row cannot stop the rest.
 */
export async function watchFounderMeetings(deps: WatchDependencies): Promise<WatchResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const result: WatchResult = { guestWaiting: 0, noShows: 0, held: 0, errors: [] };
  const markNoShow = deps.markNoShow ?? markFounderMeetingNoShow;
  const alert = deps.alert ?? pushWorkspaceAlert;

  // Meetings in their slot now, or past it within the lookback.
  const candidates = await deps.db
    .from("call_appointments")
    .select(WATCH_COLUMNS)
    .eq("meeting_kind", "founder_audit")
    .eq("status", "scheduled")
    .eq("workflow_status", "active")
    .eq("calendar_status", "verified")
    .lte("scheduled_for", new Date(nowMs + 2 * 60_000).toISOString())
    .gte("scheduled_for", new Date(nowMs - NO_SHOW_LOOKBACK_HOURS * 3_600_000).toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(25);
  if (candidates.error) {
    result.errors.push(`meeting_watch_query_failed:${candidates.error.message}`);
    return result;
  }

  for (const appointment of (candidates.data || []) as WatchedAppointment[]) {
    try {
      const startMs = Date.parse(appointment.scheduled_for);
      const duration = Number(appointment.duration_minutes) || 15;
      if (!appointment.meet_room_id) continue; // a Google Meet link: no join data, the founder records it
      const att = attendanceFrom(await readParticipants(deps.db, appointment.tenant_id, appointment.meet_room_id), {
        startsAt: appointment.scheduled_for,
        durationMinutes: duration,
        nowMs,
      });

      // 1. The lead is waiting and no host is: tell the founder now, once.
      const inSlot = nowMs >= startMs - 2 * 60_000 && nowMs <= startMs + (duration + 10) * 60_000;
      if (inSlot && att.guestPresentNow && !att.hostPresentNow && appointment.organizer_email_snapshot && appointment.google_meet_link) {
        const note = buildGuestWaitingAlert({
          name: appointment.client_name_snapshot,
          company: appointment.company_snapshot,
          phone: appointment.client_phone_snapshot,
          email: appointment.client_email_snapshot,
          meetLink: appointment.google_meet_link,
          startsAt: appointment.scheduled_for,
          leadId: appointment.lead_id,
        });
        const queued = await insertNotification(deps.db, {
          id: randomUUID(),
          tenant_id: appointment.tenant_id,
          appointment_id: appointment.id,
          lead_id: appointment.lead_id,
          kind: "host_guest_waiting",
          reminder_minutes_before: null,
          channel: "email",
          due_at: nowIso,
          recipient: appointment.organizer_email_snapshot.toLowerCase(),
          sender_user_id: appointment.assigned_to || "system",
          subject: note.subject,
          body: note.body,
          appointment_revision: appointment.revision,
          dedupe_key: founderMeetingDedupeKey(appointment.id, appointment.revision, "host_guest_waiting", "email"),
          updated_at: nowIso,
        });
        if (queued) result.guestWaiting += 1;
      }

      // 2. Past its grace minutes: held, or missed by whom.
      if (nowMs < startMs + NO_SHOW_GRACE_MINUTES * 60_000) continue;
      const verdict = classifyMeeting(att);
      if (verdict === "held") {
        result.held += 1;
        continue;
      }
      const closed = await markNoShow(
        { tenantId: appointment.tenant_id, appointmentId: appointment.id, who: verdict, actorUserId: "system:meeting-watch" },
        { db: deps.db, now: deps.now, close: closeVerifiedFounderMeeting, origin: deps.origin },
      );
      result.noShows += 1;
      if (closed.leadStage !== "founder_meeting_booked") continue; // the lead moved on: nothing to send
      const messages = buildNoShowMessages({
        firstName: firstNameOf(appointment.client_name_snapshot),
        offerLabel: appointment.offer_label || "call",
        missedAt: appointment.scheduled_for,
        rebookUrl: closed.rebookUrl,
        who: verdict,
      });
      const base = {
        tenant_id: appointment.tenant_id,
        appointment_id: appointment.id,
        lead_id: appointment.lead_id,
        reminder_minutes_before: null,
        sender_user_id: appointment.assigned_to || "system",
        appointment_revision: appointment.revision,
        updated_at: nowIso,
      };
      if (appointment.client_email_snapshot) {
        await insertNotification(deps.db, {
          ...base,
          id: randomUUID(),
          kind: "no_show_rebook",
          channel: "email",
          due_at: nowIso,
          recipient: appointment.client_email_snapshot,
          subject: messages.email.subject,
          body: messages.email.body,
          dedupe_key: founderMeetingDedupeKey(appointment.id, appointment.revision, "no_show_rebook", "email"),
        });
        for (const followUp of messages.followUps) {
          await insertNotification(deps.db, {
            ...base,
            id: randomUUID(),
            kind: "no_show_followup",
            channel: "email",
            due_at: new Date(nowMs + followUp.hours * 3_600_000).toISOString(),
            recipient: appointment.client_email_snapshot,
            subject: followUp.subject,
            body: followUp.body,
            dedupe_key: `${appointment.id}:${appointment.revision}:no_show_followup_${followUp.hours}h:email`,
          });
        }
      }
      if (appointment.sms_consent && appointment.client_phone_snapshot) {
        await insertNotification(deps.db, {
          ...base,
          id: randomUUID(),
          kind: "no_show_rebook",
          channel: "sms",
          due_at: nowIso,
          recipient: appointment.client_phone_snapshot,
          subject: null,
          body: messages.sms,
          dedupe_key: founderMeetingDedupeKey(appointment.id, appointment.revision, "no_show_rebook", "sms"),
        });
      }
      const who =
        verdict === "host_absent"
          ? "The lead joined and nobody from OASIS did. An apology with their rebook link is going out now."
          : verdict === "lead_absent"
            ? "You joined and the lead did not. Their rebook link is going out now."
            : "Nobody joined. Their rebook link is going out now.";
      await alert(
        appointment.tenant_id,
        [
          `<b>Missed: ${escapeTelegramHtml(appointment.client_name_snapshot || "a lead")}${appointment.company_snapshot ? ` - ${escapeTelegramHtml(appointment.company_snapshot)}` : ""}</b>`,
          `Booked for ${escapeTelegramHtml(when(appointment.scheduled_for))}.`,
          who,
          `<a href="${pipelineLeadUrl(appointment.lead_id)}">Open the lead in Command Center</a>`,
        ].join("\n"),
        { desk: "sales" },
      ).catch(() => undefined);
    } catch (error) {
      result.errors.push(`${appointment.id}:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    }
  }
  return result;
}
