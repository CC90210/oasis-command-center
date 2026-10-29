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
 * watcher never reaches back into old history on its first run. A rebook that
 * was rolled back gets its messages back for as long as its link could be
 * used, whatever the meeting's age.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { markFounderMeetingNoShow, type NoShowWho } from "@/lib/booking/no-show";
import { loadRebookLead, REBOOK_LEAD_STAGE } from "@/lib/booking/rebook";
import { REBOOK_TOKEN_TTL_S, rebookUrl, signRebookToken } from "@/lib/booking/rebook-token";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import { MEET_PRESENCE_MS } from "@/lib/meet/participants";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { memberStanding } from "@/lib/team";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { closeVerifiedFounderMeeting } from "@/lib/website-sales-founder-meeting";
import { FOUNDER_MEETING_TIMEZONE, founderMeetingDedupeKey } from "@/lib/website-sales-meeting";

export const NO_SHOW_GRACE_MINUTES = 15;
export const NO_SHOW_LOOKBACK_HOURS = 48;
/** A rebook can be tried (and rolled back) while its link works; three days on, nothing it queued can still be waiting. */
export const NO_SHOW_RESTORE_LOOKBACK_MS = (REBOOK_TOKEN_TTL_S + 3 * 86_400) * 1000;
/** A join counts toward THIS meeting only inside this window around its slot (a lead who tested the link the night before did not attend). */
export const ATTENDANCE_EARLY_MINUTES = 30;
export const ATTENDANCE_LATE_MINUTES = 30;
export const NO_SHOW_FOLLOW_UPS_HOURS = [24, 72] as const;

export type Attendance = {
  /** The lead was in the room at some point in the meeting's window. */
  guestJoined: boolean;
  /** Someone who could open the call (the room's host role) was in the room at some point in the window. */
  hostJoined: boolean;
  /** The lead and a host were in the room AT THE SAME TIME, in the window: the call happened. */
  met: boolean;
  guestPresentNow: boolean;
  hostPresentNow: boolean;
};

export type ParticipantRow = {
  role: string;
  /** Set for anyone signed in; null for a visitor on the public link. */
  user_id?: string | null;
  joined_at: string;
  left_at: string | null;
  removed_at?: string | null;
  last_seen_at: string;
};

/**
 * Who was in the room for this meeting, and who is in it now.
 *
 * The lead's side is everyone who is not a member of the meeting's own
 * workspace (isTeammate): the public-link visitor, or someone signed in to
 * another workspace (Codex review of #775). OASIS's side is whoever could open
 * the call: a participant with the room's host role (the meeting's host or a
 * workspace admin, lib/meet/access.ts meetRoleFor). A teammate without it
 * waits in the lobby with the lead until a host comes (waiting_for_host,
 * lib/meet/handlers.ts), so it counts as neither side (Codex review r5). A
 * call was HELD only when the lead and a host were in the room AT THE SAME
 * TIME inside the meeting's window: a host testing the room at 15:40 and a
 * lead waiting alone at 16:05 never met.
 */
export function attendanceFrom(
  rows: ParticipantRow[],
  input: { startsAt: string; durationMinutes: number; nowMs: number; isTeammate?: (userId: string) => boolean },
): Attendance {
  const start = Date.parse(input.startsAt);
  const from = start - ATTENDANCE_EARLY_MINUTES * 60_000;
  const until = start + (input.durationMinutes + ATTENDANCE_LATE_MINUTES) * 60_000;
  const presentNow = (row: ParticipantRow) =>
    !row.left_at && !row.removed_at && Date.parse(row.last_seen_at) > input.nowMs - MEET_PRESENCE_MS;
  // In the room from joining until last heard from (plus the presence
  // window). A left_at can be the CLEANUP time of a browser that vanished
  // (leaveStale), long after its last heartbeat, so it only ever shortens
  // the stay, never stretches it into a meeting it missed (Codex review).
  const interval = (row: ParticipantRow): [number, number] | null => {
    const joined = Date.parse(row.joined_at);
    if (!Number.isFinite(joined)) return null;
    if (presentNow(row)) return [joined, input.nowMs];
    const seen = Date.parse(row.last_seen_at);
    const heardUntil = Number.isFinite(seen) ? seen + MEET_PRESENCE_MS : joined;
    const stamped = Date.parse(row.left_at || row.removed_at || "");
    const ended = Number.isFinite(stamped) ? Math.min(stamped, heardUntil) : heardUntil;
    return [joined, Math.max(joined, ended)];
  };
  const clip = (span: [number, number] | null): [number, number] | null => {
    if (!span) return null;
    const a = Math.max(span[0], from);
    const b = Math.min(span[1], until);
    return a <= b ? [a, b] : null;
  };
  const isTeammate = input.isTeammate ?? (() => true);
  const oasis = rows.filter((row) => row.role === "host" && !!row.user_id && isTeammate(row.user_id));
  const lead = rows.filter((row) => !row.user_id || !isTeammate(row.user_id));
  const leadSpans = lead.map((row) => clip(interval(row))).filter((x): x is [number, number] => x !== null);
  const oasisSpans = oasis.map((row) => clip(interval(row))).filter((x): x is [number, number] => x !== null);
  const met = leadSpans.some(([a1, b1]) => oasisSpans.some(([a2, b2]) => Math.max(a1, a2) <= Math.min(b1, b2)));
  return {
    guestJoined: leadSpans.length > 0,
    hostJoined: oasisSpans.length > 0,
    met,
    guestPresentNow: lead.some(presentNow),
    hostPresentNow: oasis.some(presentNow),
  };
}

/** What a meeting that has passed its grace minutes was: held, or missed by whom. */
export function classifyMeeting(att: Pick<Attendance, "guestJoined" | "hostJoined" | "met">): "held" | NoShowWho {
  if (att.met) return "held";
  if (att.guestJoined && att.hostJoined) return "missed_each_other";
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
  env?: Readonly<Record<string, string | undefined>>;
  /** Is this signed-in user a member of the workspace (OASIS's side)? Default: lib/team memberStanding. */
  isTeammate?: (tenantId: string, userId: string) => Promise<boolean>;
  markNoShow?: typeof markFounderMeetingNoShow;
  alert?: typeof pushWorkspaceAlert;
  /** A card in the Command Center that stays open whatever its push does. Default: lib/notify/agent-alert. */
  card?: typeof writeAgentAlert;
};

export type WatchResult = { guestWaiting: number; noShows: number; held: number; metAfterNoShow: number; errors: string[] };

/**
 * Whether the meeting's Oasis Meet room still exists. Deleting a room takes its
 * participants with it, so an empty room is then no proof that nobody came
 * (Codex review r10).
 */
async function roomExists(db: SupabaseClient, tenantId: string, roomId: string): Promise<boolean> {
  const room = await db.from("meet_rooms").select("id").eq("tenant_id", tenantId).eq("id", roomId).maybeSingle();
  if (room.error) throw new Error(`meet_room_read_failed:${room.error.message}`);
  return Boolean(room.data);
}

/** This meeting's attendance, or null when there is no room to read: none (a Google Meet link), or deleted since. Unknown, never empty. */
async function attendanceIfRoom(deps: WatchDependencies, appointment: WatchedAppointment, nowMs: number): Promise<Attendance | null> {
  if (!appointment.meet_room_id) return null;
  if (!(await roomExists(deps.db, appointment.tenant_id, appointment.meet_room_id))) return null;
  const participants = await readParticipants(deps.db, appointment.tenant_id, appointment.meet_room_id);
  const teammates = await teammatesAmong(deps.isTeammate, appointment.tenant_id, participants);
  return attendanceFrom(participants, {
    startsAt: appointment.scheduled_for,
    durationMinutes: Number(appointment.duration_minutes) || 15,
    nowMs,
    isTeammate: (userId) => teammates.has(userId),
  });
}

async function readParticipants(db: SupabaseClient, tenantId: string, roomId: string): Promise<ParticipantRow[]> {
  const result = await db
    .from("meet_participants")
    .select("role,user_id,joined_at,left_at,removed_at,last_seen_at")
    .eq("tenant_id", tenantId)
    .eq("room_id", roomId);
  if (result.error) throw new Error(`meet_participants_read_failed:${result.error.message}`);
  return (result.data || []) as ParticipantRow[];
}

/**
 * A no-show message's dedupe key: appointment, revision, message, channel, and
 * the miss it is about (the meeting's start, in epoch ms). The miss keeps an
 * earlier miss of the same appointment (rebooked, then missed again) from ever
 * counting as, or coming back as, this one's message.
 */
export function noShowDedupeKey(
  appointmentId: string,
  revision: number,
  message: string,
  channel: "email" | "sms",
  missedAt: string,
): string {
  return `${appointmentId}:${revision}:${message}:${channel}:${Date.parse(missedAt)}`;
}

/**
 * What a rollback leaves a queued message as: cancelled by the move or by its
 * compensation, or skipped as moved when the dispatcher saw the new revision
 * first. A message stopped for any other reason (the call happened after all,
 * a STOP, a completed call) stays stopped (Codex review r9).
 */
function leftByRollback(row: Record<string, unknown>): boolean {
  if (row.status === "skipped") return row.last_error === "meeting_moved";
  return row.status === "cancelled" && (row.last_error === "meeting_rescheduled" || row.last_error === "reschedule_compensated");
}

/**
 * A missed meeting whose rebook was rolled back (compensation restores the
 * no-show at a higher revision and cancels its notifications): queue again, at
 * the current revision, each of this miss's messages that never went out, so
 * the lead still gets their link and follow-ups. Each message (the rebook
 * email, each follow-up, the text) is judged by its own latest copy (Codex
 * review r4): one that went out once never goes again, one already queued at
 * this revision is left alone, and only a copy the rollback left behind is put
 * back. A batch cut short by a failed write is finished on the next run.
 */
async function restoreRolledBackNoShowMessages(
  db: SupabaseClient,
  appointment: WatchedAppointment,
  nowIso: string,
): Promise<number> {
  const existing = await db
    .from("website_sales_meeting_notifications")
    .select("id,kind,channel,recipient,sender_user_id,subject,body,due_at,status,sent_at,last_error,appointment_revision,dedupe_key")
    .eq("tenant_id", appointment.tenant_id)
    .eq("appointment_id", appointment.id)
    .in("kind", ["no_show_rebook", "no_show_followup"]);
  if (existing.error) throw new Error(`no_show_restore_read_failed:${existing.error.message}`);
  const missed = String(Date.parse(appointment.scheduled_for));
  const latest = new Map<string, Record<string, unknown>>();
  const delivered = new Set<string>();
  for (const row of (existing.data || []) as Array<Record<string, unknown>>) {
    const parts = String(row.dedupe_key).split(":"); // noShowDedupeKey
    if (parts.length !== 5 || parts[4] !== missed) continue; // another miss's message
    const message = `${parts[2]}:${parts[3]}`;
    if (row.sent_at || row.status === "sent") delivered.add(message);
    const seen = latest.get(message);
    if (!seen || Number(row.appointment_revision) > Number(seen.appointment_revision)) latest.set(message, row);
  }
  let restored = 0;
  for (const [message, row] of latest) {
    if (delivered.has(message)) continue;
    if (Number(row.appointment_revision) >= appointment.revision) continue;
    if (!leftByRollback(row)) continue;
    const [name, channel] = message.split(":");
    const dedupeKey = noShowDedupeKey(appointment.id, appointment.revision, name, channel as "email" | "sms", appointment.scheduled_for);
    const due = String(row.due_at) > nowIso ? String(row.due_at) : nowIso;
    if (
      await insertNotification(db, {
        id: randomUUID(),
        tenant_id: appointment.tenant_id,
        appointment_id: appointment.id,
        lead_id: appointment.lead_id,
        kind: row.kind,
        reminder_minutes_before: null,
        channel: row.channel,
        due_at: due,
        recipient: row.recipient,
        sender_user_id: row.sender_user_id,
        subject: row.subject ?? null,
        body: row.body,
        appointment_revision: appointment.revision,
        dedupe_key: dedupeKey,
        updated_at: nowIso,
      })
    ) restored += 1;
  }
  return restored;
}

/** The signed-in participants who are members of the workspace. A read that fails throws: this run skips the meeting. */
async function teammatesAmong(
  isTeammate: WatchDependencies["isTeammate"],
  tenantId: string,
  rows: ParticipantRow[],
): Promise<Set<string>> {
  const ids = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const check =
    isTeammate ??
    (async (tenant: string, userId: string) => (await memberStanding(tenant, userId)).standing !== "not_member");
  const out = new Set<string>();
  for (const id of ids) if (await check(tenantId, id)) out.add(id);
  return out;
}

async function insertNotification(db: SupabaseClient, row: Record<string, unknown>): Promise<boolean> {
  const inserted = await db.from("website_sales_meeting_notifications").insert(row);
  if (inserted.error) {
    if (String(inserted.error.message).toLowerCase().includes("unique")) return false;
    throw new Error(`meeting_watch_insert_failed:${inserted.error.message}`);
  }
  return true;
}

function signedRebookUrl(deps: WatchDependencies, appointment: WatchedAppointment, nowMs: number): string {
  return rebookUrl(
    deps.origin,
    signRebookToken(
      { tenantId: appointment.tenant_id, appointmentId: appointment.id, leadId: appointment.lead_id },
      { nowMs, env: deps.env },
    ),
  );
}

function firstNameOf(name: string | null): string {
  return (name || "").trim().split(/\s+/)[0]?.slice(0, 60) || "";
}

/**
 * Is the lead still waiting in the room with no host, for a call that has not
 * happened? Read live for a "lead is waiting" note about to go out: one held up
 * by a mail failure or the appointment lease may be stale by then (Codex
 * review r8).
 */
export async function leadStillWaiting(
  db: SupabaseClient,
  appointment: { tenant_id: string; meet_room_id: string | null; scheduled_for: string; duration_minutes: number | null },
  nowMs: number,
  isTeammate?: WatchDependencies["isTeammate"],
): Promise<boolean> {
  if (!appointment.meet_room_id) return false;
  const participants = await readParticipants(db, appointment.tenant_id, appointment.meet_room_id);
  const teammates = await teammatesAmong(isTeammate, appointment.tenant_id, participants);
  const att = attendanceFrom(participants, {
    startsAt: appointment.scheduled_for,
    durationMinutes: Number(appointment.duration_minutes) || 15,
    nowMs,
    isTeammate: (userId) => teammates.has(userId),
  });
  return att.guestPresentNow && !att.hostPresentNow && !att.met;
}

const RECOVERY_SCAN_PAGE = 50;
const RECOVERY_SCAN_MAX = 1000;

/**
 * Every row a scan matches, page by page. Rows already dealt with keep
 * matching (a held call waiting for its outcome, a no-show already put right),
 * so reading only the newest page would leave an older one behind them for
 * good (Codex reviews r7, r10).
 */
async function pageThrough<T = WatchedAppointment>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; from < RECOVERY_SCAN_MAX; from += RECOVERY_SCAN_PAGE) {
    const page = await fetchPage(from, from + RECOVERY_SCAN_PAGE - 1);
    if (page.error) return { rows, error: page.error.message };
    const data = (Array.isArray(page.data) ? page.data : []) as T[];
    rows.push(...data);
    if (data.length < RECOVERY_SCAN_PAGE) break;
  }
  return { rows, error: null };
}

/**
 * Run both watches once. Never throws: each meeting's failure is collected
 * (and reported by the caller) so one bad row cannot stop the rest.
 */
export async function watchFounderMeetings(deps: WatchDependencies): Promise<WatchResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const result: WatchResult = { guestWaiting: 0, noShows: 0, held: 0, metAfterNoShow: 0, errors: [] };
  const markNoShow = deps.markNoShow ?? markFounderMeetingNoShow;
  const alert = deps.alert ?? pushWorkspaceAlert;

  // Meetings in their slot now, or past it within the lookback: OASIS's own
  // workspace only (founder meetings are its program; a retired workspace is
  // never written to), Oasis Meet rooms only (no join data otherwise). Every
  // page is read, so held calls waiting for their outcome never crowd out an
  // older miss (Codex review r10).
  const candidates = await pageThrough((from, to) =>
    deps.db
      .from("call_appointments")
      .select(WATCH_COLUMNS)
      .eq("tenant_id", AI_AUDIT_TENANT_ID)
      .eq("meeting_kind", "founder_audit")
      .eq("status", "scheduled")
      .eq("workflow_status", "active")
      .eq("calendar_status", "verified")
      .not("meet_room_id", "is", null)
      .lte("scheduled_for", new Date(nowMs + 2 * 60_000).toISOString())
      .gte("scheduled_for", new Date(nowMs - NO_SHOW_LOOKBACK_HOURS * 3_600_000).toISOString())
      .order("scheduled_for", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (candidates.error) {
    result.errors.push(`meeting_watch_query_failed:${candidates.error}`);
    return result;
  }

  for (const appointment of candidates.rows) {
    try {
      const startMs = Date.parse(appointment.scheduled_for);
      const duration = Number(appointment.duration_minutes) || 15;
      // No room to read (a room deleted after its call, before its outcome was
      // recorded): unknown, never proof that nobody came. The founder records
      // it (Codex review r10).
      const att = await attendanceIfRoom(deps, appointment, nowMs);
      if (!att) continue;

      // 1. The lead is waiting and no host is: tell the founder now, once. Not
      // after a call that happened: a lead whose tab stays open when the host
      // leaves is not waiting (Codex review r7).
      const inSlot = nowMs >= startMs - 2 * 60_000 && nowMs <= startMs + (duration + 10) * 60_000;
      if (inSlot && att.guestPresentNow && !att.hostPresentNow && !att.met && appointment.organizer_email_snapshot && appointment.google_meet_link) {
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
      const lead = await loadRebookLead(deps.db, appointment.tenant_id, appointment.lead_id);
      const reachable =
        !!lead &&
        lead.stage === REBOOK_LEAD_STAGE &&
        lead.calendar_appointment_id === appointment.id;
      if (reachable) {
        const rebookUrl = signedRebookUrl(deps, appointment, nowMs);
        const messages = buildNoShowMessages({
          firstName: firstNameOf(appointment.client_name_snapshot),
          offerLabel: appointment.offer_label || "call",
          missedAt: appointment.scheduled_for,
          rebookUrl,
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
            dedupe_key: noShowDedupeKey(appointment.id, appointment.revision, "no_show_rebook", "email", appointment.scheduled_for),
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
              dedupe_key: noShowDedupeKey(
                appointment.id,
                appointment.revision,
                `no_show_followup_${followUp.hours}h`,
                "email",
                appointment.scheduled_for,
              ),
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
            dedupe_key: noShowDedupeKey(appointment.id, appointment.revision, "no_show_rebook", "sms", appointment.scheduled_for),
          });
        }
      }
      const closed = await markNoShow(
        { tenantId: appointment.tenant_id, appointmentId: appointment.id, who: verdict, actorUserId: "system:meeting-watch" },
        { db: deps.db, now: deps.now, close: closeVerifiedFounderMeeting, origin: deps.origin, env: deps.env },
      );
      result.noShows += 1;
      if (closed.alreadyClosed) continue; // told the founder when it was closed
      const sent = reachable ? " Their rebook link is going out now." : " The lead has moved on in the Pipeline, so nothing was sent.";
      const who =
        verdict === "host_absent"
          ? `The lead joined and nobody opened the call for them.${reachable ? " An apology with their rebook link is going out now." : sent}`
          : verdict === "lead_absent"
            ? `You joined and the lead did not.${sent}`
            : verdict === "missed_each_other"
              ? `You and the lead were both in the room, at different times, and never met.${sent}`
              : `Nobody opened the call, and the lead never joined.${sent}`;
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

  // A meeting closed as a no-show whose lead record never took it (the lead
  // write failed after the close): the close cannot be repeated, so finish the
  // lead here and tell the founder, once (Codex review of #775). A lead that
  // already shows the no-show, moved on, or points elsewhere is left alone.
  const closedNoShows = await pageThrough((from, to) =>
    deps.db
      .from("call_appointments")
      .select(WATCH_COLUMNS)
      .eq("tenant_id", AI_AUDIT_TENANT_ID)
      .eq("meeting_kind", "founder_audit")
      .eq("status", "no_answer")
      .eq("workflow_status", "no_show")
      .not("meet_room_id", "is", null)
      .lte("scheduled_for", nowIso)
      .gte("scheduled_for", new Date(nowMs - NO_SHOW_LOOKBACK_HOURS * 3_600_000).toISOString())
      .order("scheduled_for", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (closedNoShows.error) {
    result.errors.push(`meeting_watch_recovery_query_failed:${closedNoShows.error}`);
    return result;
  }
  for (const appointment of closedNoShows.rows) {
    try {
      const lead = await loadRebookLead(deps.db, appointment.tenant_id, appointment.lead_id);
      if (!lead || lead.stage !== REBOOK_LEAD_STAGE || lead.calendar_appointment_id !== appointment.id) continue;
      if (lead.founder_meeting_status === "no_show") continue; // recorded already

      // No room left to read is unknown, never "nobody came" (Codex review r10).
      const att = await attendanceIfRoom(deps, appointment, nowMs);
      const verdict = att ? classifyMeeting(att) : "held";
      const who: NoShowWho = verdict === "held" ? "unknown" : verdict;
      const finished = await markNoShow(
        { tenantId: appointment.tenant_id, appointmentId: appointment.id, who, actorUserId: "system:meeting-watch" },
        { db: deps.db, now: deps.now, close: closeVerifiedFounderMeeting, origin: deps.origin, env: deps.env },
      );
      if (!finished.leadUpdated) continue;
      result.noShows += 1;
      await alert(
        appointment.tenant_id,
        [
          `<b>Missed: ${escapeTelegramHtml(appointment.client_name_snapshot || "a lead")}${appointment.company_snapshot ? ` - ${escapeTelegramHtml(appointment.company_snapshot)}` : ""}</b>`,
          `Booked for ${escapeTelegramHtml(when(appointment.scheduled_for))}. Its lead record is now marked as a no-show.`,
          `<a href="${pipelineLeadUrl(appointment.lead_id)}">Open the lead in Command Center</a>`,
        ].join("\n"),
        { desk: "sales" },
      ).catch(() => undefined);
    } catch (error) {
      result.errors.push(`${appointment.id}:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    }
  }

  // A rebook that failed and was rolled back leaves the meeting as this
  // no-show again, at a HIGHER revision, with its queued messages cancelled:
  // put back the ones that never went out. Looked for as long as the lead's
  // link could be used, not just 48 hours: a rebook tried on day three can
  // roll back too (Codex review r4).
  const rolledBack = await pageThrough((from, to) =>
    deps.db
      .from("call_appointments")
      .select(WATCH_COLUMNS)
      .eq("tenant_id", AI_AUDIT_TENANT_ID)
      .eq("meeting_kind", "founder_audit")
      .eq("status", "no_answer")
      .eq("workflow_status", "no_show")
      .not("last_compensated_request_id", "is", null)
      .lte("scheduled_for", nowIso)
      .gte("scheduled_for", new Date(nowMs - NO_SHOW_RESTORE_LOOKBACK_MS).toISOString())
      .order("scheduled_for", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (rolledBack.error) {
    result.errors.push(`meeting_watch_restore_query_failed:${rolledBack.error}`);
    return result;
  }
  for (const appointment of rolledBack.rows) {
    try {
      const lead = await loadRebookLead(deps.db, appointment.tenant_id, appointment.lead_id);
      if (!lead || lead.stage !== REBOOK_LEAD_STAGE || lead.calendar_appointment_id !== appointment.id) continue;
      await restoreRolledBackNoShowMessages(deps.db, appointment, nowIso);
    } catch (error) {
      result.errors.push(`${appointment.id}:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    }
  }
  // A missed call whose rebook messages still wait: if the lead and a host met
  // after all (someone came late, and Oasis Meet still let the call happen),
  // the messages stop and the founder is asked to record the outcome, which
  // corrects the no-show. Driven by the waiting messages, not the meeting's
  // age, so a late call is caught however long the worker was down; the room
  // is read whatever the time now, as attendance only counts the meeting's own
  // window. The founder's card is written BEFORE anything stops, so a failed
  // push can never lose the prompt (Codex reviews r8, r9, r10).
  const card = deps.card ?? writeAgentAlert;
  const waiting = await pageThrough<{ appointment_id: string }>((from, to) =>
    deps.db
      .from("website_sales_meeting_notifications")
      .select("appointment_id")
      .eq("tenant_id", AI_AUDIT_TENANT_ID)
      .in("kind", ["no_show_rebook", "no_show_followup"])
      .eq("status", "pending")
      .order("appointment_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (waiting.error) {
    result.errors.push(`meeting_watch_waiting_query_failed:${waiting.error}`);
    return result;
  }
  const waitingIds = [...new Set(waiting.rows.map((row) => row.appointment_id))];
  for (let i = 0; i < waitingIds.length; i += 50) {
    const batch = await deps.db
      .from("call_appointments")
      .select(WATCH_COLUMNS)
      .eq("tenant_id", AI_AUDIT_TENANT_ID)
      .eq("meeting_kind", "founder_audit")
      .eq("status", "no_answer")
      .eq("workflow_status", "no_show")
      .in("id", waitingIds.slice(i, i + 50));
    if (batch.error) {
      result.errors.push(`meeting_watch_waiting_meetings_failed:${batch.error.message}`);
      continue;
    }
    for (const appointment of (batch.data || []) as WatchedAppointment[]) {
      try {
        const lead = await loadRebookLead(deps.db, appointment.tenant_id, appointment.lead_id);
        if (!lead || lead.stage !== REBOOK_LEAD_STAGE || lead.calendar_appointment_id !== appointment.id) continue;
        const att = await attendanceIfRoom(deps, appointment, nowMs);
        if (!att?.met) continue;
        const name = appointment.client_name_snapshot || "a lead";
        const written = await card({
          tenantId: appointment.tenant_id,
          alertType: "founder_meeting_met_after_no_show",
          severity: "warn",
          title: `Met after all: ${name}${appointment.company_snapshot ? ` - ${appointment.company_snapshot}` : ""}`,
          body: [
            "It was recorded as missed, then you and the lead were in the call together. Their rebook follow-ups are stopped.",
            `Record the outcome on the lead: ${pipelineLeadUrl(appointment.lead_id)}`,
          ].join("\n"),
          subjectType: "call_appointment",
          subjectId: appointment.id,
          payload: { appointment_id: appointment.id, lead_id: appointment.lead_id },
          telegramOncePerOpen: true,
        });
        if (written?.stored === false) throw new Error("met_after_no_show_card_not_stored");
        const stopped = await deps.db
          .from("website_sales_meeting_notifications")
          .update({ status: "cancelled", claimed_at: null, last_error: "met_after_no_show", updated_at: nowIso })
          .eq("tenant_id", appointment.tenant_id)
          .eq("appointment_id", appointment.id)
          .in("kind", ["no_show_rebook", "no_show_followup"])
          .eq("status", "pending")
          .select("id");
        if (stopped.error) throw new Error(`met_after_no_show_cancel_failed:${stopped.error.message}`);
        if ((stopped.data || []).length > 0) result.metAfterNoShow += 1;
      } catch (error) {
        result.errors.push(`${appointment.id}:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
      }
    }
  }
  return result;
}
