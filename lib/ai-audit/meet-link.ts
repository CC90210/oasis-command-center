/**
 * lib/ai-audit/meet-link.ts — a discovery call held in Oasis Meet, joined to
 * its Free AI Audit engagement.
 *
 * ROOMS. An engagement's rooms are its lead's (meet_rooms.lead_id, which a
 * booking already sets). The live-call screen opens the newest open one, or
 * makes one for the lead: recorded where Meet records, named for the call, and
 * only one while one is open (the INSERT itself checks, so two presses at once
 * make one room). None is made while Meet's video service is not set up.
 *
 * TRANSCRIPTS. A room's transcript, once Meet has it ready, becomes one of the
 * engagement's transcripts (source "meet") only when:
 *   - every guest agreed to the recording in Meet before joining
 *     (meet_participants.consent_at). That is the recording consent, basis
 *     "meet_guests". A room no guest joined is no client's call;
 *   - the client's answer about AI analysis is known, in the workspace
 *     owner's word: his answer on the call's opening question (the profile's
 *     consent.ai_processing, Client-reported or Verified, saved by him), or
 *     what he says when he attaches the transcript by hand. Yes or no, it is
 *     the transcript's AI consent, and a no means nothing is ever sent to a
 *     model. Another founder's answer, or a hypothesis, never is;
 *   - the engagement is still before Gate 1.
 * The tick attaches by itself only a call that ended after the engagement
 * opened and that no audit ever held (a Meet transcript the owner deleted is
 * never attached again by itself), whose audio all reached the server, with no
 * guest removed and a guest heard. Anything else it lists for the owner once,
 * with the reason, and only he attaches it, by hand. A wait for the AI answer
 * ends when a newer answer is saved on the profile. The lines are timed from
 * the room's start and scrubbed like any transcript's (lib/ai-audit/
 * transcript.ts parseMeetLines).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { createMeetRoomUnlessLeadHasOpen } from "@/lib/meet/rooms";
import { meetRoomPath } from "@/lib/meet/links";
import { meetRecordingTablesInstalled, readTranscript, type TranscriptLine as MeetLine } from "@/lib/meet/recording";
import { parseMeetLines, type ParseError } from "@/lib/ai-audit/transcript";
import { addTranscript } from "@/lib/ai-audit/transcripts";
import { listProfileFields } from "@/lib/ai-audit/versions";
import { withdrawAuthorizationIfStale } from "@/lib/ai-audit/authorize";
import { PROFILE_EDIT_STAGES, shortName } from "@/lib/ai-audit/rules";
import { dbBool } from "@/lib/db-bool";
import { eventStatement, getEngagement, requireTenant, text, type Actor, type Engagement } from "@/lib/ai-audit/store";

export type AuditRoomGuest = { name: string; consented: boolean; removed: boolean };
export type AuditRoom = {
  id: string;
  code: string;
  /** The room's address in the app, /meet/abc-defg-hjk (lib/meet/links.ts). */
  path: string;
  title: string;
  status: string;
  recordAudio: boolean;
  startsAt: string | null;
  createdAt: string;
  endedAt: string | null;
  /** Meet's transcript of the room, if it has one: its status and how many lines. */
  transcript: { status: string; lines: number } | null;
  guests: AuditRoomGuest[];
  /** The engagement's transcript made from this room, if one is attached. */
  attachedTranscriptId: string | null;
  /** For a ready transcript not attached: why the tick leaves it for the owner's hand, in plain words. Empty when nothing does. */
  holds: string[];
};

/** The event that marks a room the tick does not take up again by itself: written once per room, with the reason. */
export const MEET_TRANSCRIPT_NEEDS_YOU = "meet_transcript_needs_you";
/** The event that says a room waits for the client's answer about AI analysis: a newer answer on the profile lifts it. */
export const MEET_TRANSCRIPT_NEEDS_AI_ANSWER = "meet_transcript_needs_ai_answer";

const AI_ANSWER_KEY = "consent.ai_processing";
const RECORDING_ANSWER_KEY = "consent.recording";
/** A room whose lines are on the engagement already (pasted by hand): not picked again. */
export const MEET_TRANSCRIPT_ALREADY_HERE = "meet_transcript_already_here";
/** Meet's recorder sends 10-second pieces of audio (lib/meet/recording.ts). */
const CHUNK_SECONDS = 10;
const ROOM_LIST_LIMIT = 10;

const present = (v: unknown): boolean => v !== null && v !== undefined && String(v) !== "";
/** A JSON column's array length in SQL: 0 for NULL or text that is not JSON, never an error that stops the query. */
const linesCount = (column: string) => `CASE WHEN json_valid(${column}) THEN json_array_length(${column}) ELSE 0 END`;

// ---------------------------------------------------------------------------
// What holds a call for the owner's hand
// ---------------------------------------------------------------------------

/** Why the tick leaves a ready call for the owner: each is something only a person can judge (review of phase 2c, F3 and F6). */
export type MeetHold = "before_engagement" | "attached_before" | "audio_missing" | "guest_removed" | "no_guest_words";

type HoldFacts = {
  roomEndedAt: string | null;
  roomCreatedAt: string;
  engagementCreatedAt: string;
  /** A transcript was made from this room before, for any audit, kept or deleted. */
  attachedBefore: boolean;
  missingChunks: number;
  recorderFailed: number;
  recorderErrored: number;
  guestRemoved: boolean;
  guestHeard: boolean;
};

function holdsOf(f: HoldFacts): Array<{ hold: MeetHold; words: string }> {
  const out: Array<{ hold: MeetHold; words: string }> = [];
  if ((f.roomEndedAt ?? f.roomCreatedAt) < f.engagementCreatedAt) out.push({ hold: "before_engagement", words: "the call ended before this engagement was opened" });
  if (f.attachedBefore) out.push({ hold: "attached_before", words: "it was attached to an audit before, and a Meet transcript once attached is never attached again by itself" });
  // The larger of the gaps the relay saw and the recording browser's own count, as Meet's panel says it.
  const missing = Math.max(f.missingChunks, f.recorderFailed);
  if (missing > 0) {
    const s = missing * CHUNK_SECONDS;
    out.push({ hold: "audio_missing", words: `about ${s < 120 ? `${s} seconds` : `${Math.round(s / 60)} minutes`} of its audio did not reach the server` });
  } else if (f.recorderErrored > 0) {
    out.push({ hold: "audio_missing", words: "the recording browser reported a problem, so part of its audio may be missing" });
  }
  if (f.guestRemoved) out.push({ hold: "guest_removed", words: "a guest was removed from the call" });
  if (!f.guestHeard) out.push({ hold: "no_guest_words", words: "no guest's words are in the transcript" });
  return out;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * The engagement's Meet rooms, newest first, with what each holds for the audit. Empty when Meet is not set up.
 * Two reads at once, however many rooms (review of phase 2c, F7): the rooms with what Meet and the audit hold for
 * each, counted in SQL so no transcript text leaves the database, and their guests.
 */
export async function roomsForEngagement(db: Client, tenantId: string, engagement: Pick<Engagement, "id" | "lead_id" | "created_at">): Promise<AuditRoom[]> {
  const t = requireTenant(tenantId);
  if (!engagement.lead_id || !(await meetRecordingTablesInstalled(db))) return [];
  const leadRooms = `SELECT id FROM meet_rooms WHERE tenant_id = ? AND lead_id = ? ORDER BY COALESCE(starts_at, created_at) DESC, created_at DESC LIMIT ${ROOM_LIST_LIMIT}`;
  const attachedHere = "SELECT a.id FROM ai_audit_transcripts a WHERE a.tenant_id = r.tenant_id AND a.engagement_id = ? AND a.meet_room_id = r.id AND a.status = 'active' LIMIT 1";
  const [rooms, guests] = await Promise.all([
    db.execute({
      sql: `SELECT r.id, r.code, r.title, r.status, r.record_audio, r.starts_at, r.created_at, r.ended_at,
                   m.status AS t_status, ${linesCount("m.lines_json")} AS t_lines,
                   COALESCE(m.missing_chunks, 0) AS missing_chunks, COALESCE(m.recorder_failed, 0) AS recorder_failed, COALESCE(m.recorder_errored, 0) AS recorder_errored,
                   (${attachedHere}) AS attached_id,
                   EXISTS (SELECT 1 FROM ai_audit_transcripts b WHERE b.tenant_id = r.tenant_id AND b.meet_room_id = r.id) AS attached_before,
                   CASE WHEN m.status = 'ready' AND json_valid(m.lines_json) AND NOT EXISTS (${attachedHere}) THEN EXISTS (
                     SELECT 1 FROM json_each(m.lines_json) j
                       JOIN meet_participants p ON j.type = 'object' AND p.id = (CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.participant_id') END)
                      WHERE p.tenant_id = r.tenant_id AND p.room_id = r.id AND p.role = 'guest'
                   ) ELSE 0 END AS guest_heard
              FROM meet_rooms r
              LEFT JOIN meet_transcripts m ON m.tenant_id = r.tenant_id AND m.room_id = r.id
             WHERE r.tenant_id = ? AND r.lead_id = ?
             ORDER BY COALESCE(r.starts_at, r.created_at) DESC, r.created_at DESC LIMIT ${ROOM_LIST_LIMIT}`,
      args: [engagement.id, engagement.id, t, engagement.lead_id],
    }),
    db.execute({
      sql: `SELECT room_id, display_name, consent_at, removed_at FROM meet_participants
             WHERE tenant_id = ? AND role = 'guest' AND room_id IN (${leadRooms})
             ORDER BY joined_at, id`,
      args: [t, t, engagement.lead_id],
    }),
  ]);
  const guestsOf = new Map<string, AuditRoomGuest[]>();
  for (const g of guests.rows) {
    const list = guestsOf.get(String(g.room_id)) ?? [];
    list.push({ name: String(g.display_name), consented: present(g.consent_at), removed: present(g.removed_at) });
    guestsOf.set(String(g.room_id), list);
  }
  return rooms.rows.map((r) => {
    const id = String(r.id);
    const roomGuests = guestsOf.get(id) ?? [];
    const attachedTranscriptId = text(r.attached_id);
    const status = text(r.t_status);
    const lines = Number(r.t_lines) || 0;
    const holds =
      status === "ready" && lines > 0 && !attachedTranscriptId
        ? holdsOf({
            roomEndedAt: text(r.ended_at),
            roomCreatedAt: String(r.created_at),
            engagementCreatedAt: engagement.created_at,
            attachedBefore: dbBool(r.attached_before),
            missingChunks: Number(r.missing_chunks) || 0,
            recorderFailed: Number(r.recorder_failed) || 0,
            recorderErrored: Number(r.recorder_errored) || 0,
            guestRemoved: roomGuests.some((g) => g.removed),
            guestHeard: dbBool(r.guest_heard),
          }).map((h) => h.words)
        : [];
    return {
      id,
      code: String(r.code),
      path: meetRoomPath({ code: String(r.code) }),
      title: String(r.title),
      status: String(r.status),
      recordAudio: Number(r.record_audio) === 1,
      startsAt: text(r.starts_at),
      createdAt: String(r.created_at),
      endedAt: text(r.ended_at),
      transcript: status ? { status, lines } : null,
      guests: roomGuests,
      attachedTranscriptId,
      holds,
    };
  });
}

/** What making a room needs from Meet's own setup: the same two checks as lib/meet/handlers.ts handleCreateRoom. */
export type AuditRoomMeet = {
  /** A call can connect: the video service and the join token's secret are set (lib/meet/handlers.ts meetMediaReady). */
  mediaReady: () => boolean;
  /** This workspace's meetings record (MeetDeps["recording"].available). */
  recordingAvailable: (tenantId: string) => Promise<boolean>;
};

export type CreateRoomResult =
  | { ok: true; roomId: string; code: string; created: boolean }
  | { ok: false; error: "not_found" | "no_lead" | "meet_not_installed" | "meet_not_configured" };

/** The lead's open call room, or a new one: recorded where Meet records, named for the discovery call, linked to the lead. */
export async function createAuditRoom(
  db: Client,
  input: { tenantId: string; engagementId: string; hostUserId: string; now: Date; meet: AuditRoomMeet },
): Promise<CreateRoomResult> {
  const t = requireTenant(input.tenantId);
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!e.lead_id) return { ok: false, error: "no_lead" };
  if (!(await meetRecordingTablesInstalled(db))) return { ok: false, error: "meet_not_installed" };
  const leadId = e.lead_id;
  const openRoom = async () =>
    (await db.execute({ sql: "SELECT id, code FROM meet_rooms WHERE tenant_id = ? AND lead_id = ? AND status IN ('scheduled', 'live') ORDER BY created_at DESC LIMIT 1", args: [t, leadId] })).rows[0];
  for (let attempt = 1; ; attempt += 1) {
    // A room still to be held (booked, or made earlier): that one, so a second press makes no second room.
    const open = await openRoom();
    if (open) return { ok: true, roomId: String(open.id), code: String(open.code), created: false };
    // A room whose call cannot connect is never made: no link that fails when it is opened.
    if (!input.meet.mediaReady()) return { ok: false, error: "meet_not_configured" };
    const room = await createMeetRoomUnlessLeadHasOpen(db, {
      tenantId: t,
      hostUserId: input.hostUserId,
      title: `Discovery call: ${shortName(e.business_name, "a new client", 60)}`,
      // Recorded only where Meet records: guests are never asked to agree to a recording nobody makes.
      recordAudio: await input.meet.recordingAvailable(t),
      leadId,
      now: input.now,
    });
    if (room) {
      await db.execute(eventStatement({ tenantId: t, engagementId: e.id, event: "meet_room_created", actor: { type: "user", id: input.hostUserId }, at: input.now.toISOString(), refType: "meet_room", refId: room.id }));
      return { ok: true, roomId: room.id, code: room.code, created: true };
    }
    // Another press made one at the same moment (the INSERT checks for it): read it again, and use it.
    if (attempt >= 3) throw new Error("ai-audit.meet-link: could not make or find the lead's call room");
  }
}

// ---------------------------------------------------------------------------
// Attaching a transcript
// ---------------------------------------------------------------------------

export type AttachError =
  | "not_found"
  | "stage_closed"
  | "meet_not_installed"
  | "meet_not_ready"
  | "owner_only"
  | "no_guests"
  | "no_recording_consent"
  | "recording_declined"
  | "held"
  | "ai_answer_needed"
  | "ai_answer_unconfirmed"
  | "attached_with_other_ai_answer"
  | "too_many_transcripts"
  | "conflict"
  | `meet_transcript_${ParseError}`;
export type AttachResult =
  | { ok: true; transcriptId: string; duplicate: boolean }
  | { ok: false; error: AttachError; holds?: Array<{ hold: MeetHold; words: string }> };

/** The workspace owner (user_profiles.is_owner)? The query access.ts runs, inline as authorize.ts and delivery.ts have it: lib code stays off the session layer. */
async function userIsOwner(db: Client, t: string, userId: string): Promise<boolean> {
  const row = (await db.execute({ sql: "SELECT is_owner FROM user_profiles WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1", args: [t, userId] })).rows[0];
  return !!row && dbBool(row.is_owner);
}

/**
 * The client's answer about AI analysis on the profile, if it is the owner's record of what they said: labelled
 * Client-reported or Verified, saved by the workspace owner (review of phase 2c, F2). Another founder's answer,
 * a hypothesis or an estimate is not the client's yes.
 */
async function ownersAiAnswer(
  db: Client,
  t: string,
  fields: Awaited<ReturnType<typeof listProfileFields>>,
): Promise<{ ok: true; value: boolean; by: string } | { ok: false; error: "ai_answer_needed" | "ai_answer_unconfirmed" }> {
  const answer = fields.find((f) => f.field_key === AI_ANSWER_KEY);
  if (!answer || typeof answer.value !== "boolean") return { ok: false, error: "ai_answer_needed" };
  const said = answer.label === "client_reported" || answer.label === "verified";
  if (!said || !answer.updated_by || !(await userIsOwner(db, t, answer.updated_by))) return { ok: false, error: "ai_answer_unconfirmed" };
  return { ok: true, value: answer.value, by: answer.updated_by };
}

/**
 * Meet's lines on the call's own clock (review of phase 2c, F1). A line's at_ms is wall-clock time, ms since the
 * epoch (lib/meet/recording.ts), so its time on the call is at_ms less the room's start (less the first line's
 * when the room has none, as Meet's own panel does), never below zero, in the order the lines were said.
 */
function onCallClock(lines: readonly MeetLine[], startedAt: string | null): Array<{ t: number; speaker: string; text: string }> {
  const ordered = [...lines].sort((a, b) => a.at_ms - b.at_ms);
  const started = startedAt && Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : null;
  const zero = started ?? ordered[0]?.at_ms ?? 0;
  return ordered.map((l) => ({ t: Math.max(0, Math.floor((l.at_ms - zero) / 1000)), speaker: l.speaker, text: l.text }));
}

/**
 * One room's ready transcript, attached to the engagement. `ai` is the owner's word on the client's answer about
 * AI analysis when he attaches by hand (`byOwner`: the workspace owner's own press); without it the profile's
 * answer is used, only if it is his record of what the client said. A call something holds (see holdsOf) is
 * attached only by the owner's own press.
 */
export async function attachMeetTranscript(
  db: Client,
  input: { tenantId: string; engagementId: string; roomId: string; actor: Actor; now: Date; ai?: boolean; byOwner?: boolean },
): Promise<AttachResult> {
  const t = requireTenant(input.tenantId);
  // The client's AI answer said by hand is the owner's to give, as every gate is (review of phase 2c, F2).
  if (input.ai !== undefined && !input.byOwner) return { ok: false, error: "owner_only" };
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!PROFILE_EDIT_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
  if (!(await meetRecordingTablesInstalled(db))) return { ok: false, error: "meet_not_installed" };
  const room = (await db.execute({ sql: "SELECT id, lead_id, created_at, started_at, ended_at FROM meet_rooms WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, input.roomId] })).rows[0];
  // Only the lead's own rooms: never another client's call.
  if (!room || !e.lead_id || String(room.lead_id ?? "") !== e.lead_id) return { ok: false, error: "not_found" };
  const made = (await db.execute({ sql: "SELECT id, engagement_id, status, consent_ai FROM ai_audit_transcripts WHERE tenant_id = ? AND meet_room_id = ?", args: [t, input.roomId] })).rows;
  const here = made.find((x) => String(x.engagement_id) === e.id && String(x.status) === "active");
  if (here) {
    // Attached already: another answer about AI analysis is refused, never dropped in silence (review of phase 2c, F5).
    if (input.ai !== undefined && (Number(here.consent_ai) === 1) !== input.ai) return { ok: false, error: "attached_with_other_ai_answer" };
    return { ok: true, transcriptId: String(here.id), duplicate: true };
  }
  const meet = await readTranscript(db, t, input.roomId);
  if (!meet || meet.status !== "ready" || !meet.lines.length) return { ok: false, error: "meet_not_ready" };
  const guests = (await db.execute({ sql: "SELECT id, consent_at, removed_at FROM meet_participants WHERE tenant_id = ? AND room_id = ? AND role = 'guest'", args: [t, input.roomId] })).rows;
  if (!guests.length) return { ok: false, error: "no_guests" };
  if (guests.some((g) => !present(g.consent_at))) return { ok: false, error: "no_recording_consent" };
  // The client's own no to the recording, as recorded on the call's opening question, stands over Meet's join
  // notice: the call cannot be used, even by hand (review of phase 2c, second pass, F1).
  const fields = e.current_profile_version_id ? await listProfileFields(db, t, e.current_profile_version_id) : [];
  if (fields.some((f) => f.field_key === RECORDING_ANSWER_KEY && f.value === false)) return { ok: false, error: "recording_declined" };
  const lines = meet.lines.filter((l): l is MeetLine => !!l && typeof l === "object");
  const guestIds = new Set(guests.map((g) => String(g.id)));
  const holds = holdsOf({
    roomEndedAt: text(room.ended_at),
    roomCreatedAt: String(room.created_at),
    engagementCreatedAt: e.created_at,
    attachedBefore: made.length > 0,
    missingChunks: meet.missingChunks,
    recorderFailed: meet.recorderFailed,
    recorderErrored: meet.recorderErrored,
    guestRemoved: guests.some((g) => present(g.removed_at)),
    guestHeard: lines.some((l) => guestIds.has(String(l.participant_id))),
  });
  // The owner has seen why (the engagement lists it), and only he decides it is the client's call anyway.
  if (holds.length && !input.byOwner) return { ok: false, error: "held", holds };
  let ai = input.ai;
  let by: string | null = input.actor.id ?? null;
  if (ai === undefined) {
    const answer = await ownersAiAnswer(db, t, fields);
    if (!answer.ok) return { ok: false, error: answer.error };
    ai = answer.value;
    // The AI answer is the owner's word; the recording consent is the guests' own (basis meet_guests).
    by = answer.by;
  }
  const parsed = parseMeetLines(onCallClock(lines, text(room.started_at)));
  if (!parsed.ok) return { ok: false, error: `meet_transcript_${parsed.error}` };
  const r = await addTranscript(db, {
    tenantId: t,
    engagementId: e.id,
    parsed: parsed.value,
    source: "meet",
    meetRoomId: input.roomId,
    consent: { recording: true, ai, basis: "meet_guests", by },
    actor: input.actor,
    now: input.now,
  });
  if (!r.ok) return r;
  // The same lines were attached a moment ago (two presses at once), or pasted: the stored answer stands.
  if (r.duplicate && input.ai !== undefined && r.transcript.consent_ai !== input.ai) return { ok: false, error: "attached_with_other_ai_answer" };
  return { ok: true, transcriptId: r.transcript.id, duplicate: r.duplicate };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export type AlertFn = (input: { tenantId: string; alertType: string; severity: "info" | "warn" | "urgent"; title: string; body: string; subjectType: string; subjectId: string; telegramOncePerOpen?: boolean }) => Promise<unknown>;

/** A result that is a race with something else (the engagement moved on, the room or its transcript went): the next run's own query settles it. */
const RACES: ReadonlySet<string> = new Set(["not_found", "stage_closed", "meet_not_installed", "meet_not_ready"]);

const AI_NEXT = "Record the client's answer on the live-call screen's opening question and the next run attaches it, or attach it by hand on the engagement, saying what the client agreed to.";
const PASTE_NEXT = "Nothing was cut or attached: paste the part of the call that matters instead.";

/** Why a room was not attached, and what the owner can do about it, for the alert. */
function waitWords(r: Extract<AttachResult, { ok: false }>): { why: string; next: string } {
  switch (r.error) {
    case "ai_answer_needed":
      return { why: "the client's answer about AI analysis is not on the profile yet", next: AI_NEXT };
    case "ai_answer_unconfirmed":
      return { why: "the profile's answer about AI analysis was not saved by the workspace owner as what the client said", next: AI_NEXT };
    case "held":
      return { why: (r.holds ?? []).map((h) => h.words).join("; "), next: "Check that it is this audit's call, then attach it by hand on the engagement." };
    case "no_recording_consent":
      return { why: "a guest joined without agreeing to the recording", next: "It cannot be used, even by hand: work from your notes." };
    case "recording_declined":
      return { why: "the profile records that the client said no to the recording", next: "It cannot be used, even by hand: work from your notes, or correct that answer on the profile if it was recorded wrongly." };
    case "no_guests":
      return { why: "no guest joined the room", next: "It is not the client's call, so it is not used." };
    case "too_many_transcripts":
      return { why: "the engagement already has 20 transcripts", next: "Delete one you no longer need, then attach it by hand." };
    case "meet_transcript_empty":
      return { why: "it has no words to attach", next: "Work from your notes, or paste the call's transcript." };
    case "meet_transcript_too_large":
      return { why: "it is over 500 KB, the most one transcript can hold", next: PASTE_NEXT };
    case "meet_transcript_too_many_lines":
      return { why: "it has more than 20,000 lines, the most one transcript can hold", next: PASTE_NEXT };
    default:
      return { why: `it could not be attached (${r.error})`, next: "Open the engagement to attach it by hand." };
  }
}

/**
 * The tick's step: ready Meet transcripts of engagements still before Gate 1, attached now when nothing holds
 * them. One that cannot be attached is listed for the owner once, with the reason (an event and an alert), and
 * is not taken up again by itself: a wait for the AI answer ends when a newer answer is saved on the profile.
 */
export async function autoAttachMeetTranscripts(db: Client, tenantId: string, now: Date, alert: AlertFn, limit = 5): Promise<{ attached: number; waiting: number }> {
  const t = requireTenant(tenantId);
  if (!(await meetRecordingTablesInstalled(db))) return { attached: 0, waiting: 0 };
  const stages = PROFILE_EDIT_STAGES;
  // Picked only when there is something to attach (a ready transcript with lines: review of phase 2c, F4), from
  // a call that ended after the engagement opened, that no audit of the workspace ever held, even one deleted
  // since (F3): an older call of the lead is the owner's to attach by hand. A room listed for the owner is not
  // picked again, unless it waited for the AI answer and a newer one was saved since.
  const rs = await db.execute({
    sql: `SELECT e.id AS engagement_id, r.id AS room_id FROM ai_audit_engagements e
            JOIN meet_rooms r ON r.tenant_id = e.tenant_id AND r.lead_id = e.lead_id
            JOIN meet_transcripts m ON m.tenant_id = r.tenant_id AND m.room_id = r.id AND m.status = 'ready'
           WHERE e.tenant_id = ? AND e.stage IN (${stages.map(() => "?").join(", ")})
             AND ${linesCount("m.lines_json")} > 0
             AND COALESCE(r.ended_at, r.created_at) >= e.created_at
             AND NOT EXISTS (SELECT 1 FROM ai_audit_transcripts a WHERE a.tenant_id = e.tenant_id AND a.meet_room_id = r.id)
             AND NOT EXISTS (
               SELECT 1 FROM ai_audit_events v
                WHERE v.tenant_id = e.tenant_id AND v.engagement_id = e.id AND v.ref_id = r.id
                  AND (v.event IN (?, ?) OR (v.event = ? AND NOT EXISTS (
                    SELECT 1 FROM ai_audit_profile_fields f
                     WHERE f.tenant_id = e.tenant_id AND f.profile_version_id = e.current_profile_version_id
                       AND f.field_key = ? AND f.updated_at > v.created_at))))
           ORDER BY m.updated_at LIMIT ?`,
    args: [t, ...stages, MEET_TRANSCRIPT_NEEDS_YOU, MEET_TRANSCRIPT_ALREADY_HERE, MEET_TRANSCRIPT_NEEDS_AI_ANSWER, AI_ANSWER_KEY, limit],
  });
  let attached = 0;
  let waiting = 0;
  const system: Actor = { type: "system", id: null };
  const at = now.toISOString();
  for (const row of rs.rows) {
    const engagementId = String(row.engagement_id);
    const roomId = String(row.room_id);
    // One bad room (a row Meet wrote wrongly) never stops the rooms after it (review of phase 2c, second pass, F3).
    let r: AttachResult;
    try {
      r = await attachMeetTranscript(db, { tenantId: t, engagementId, roomId, actor: system, now });
    } catch (err) {
      console.error("[ai-audit.meet-link] a room could not be attached", { engagementId, roomId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (r.ok) {
      if (r.duplicate) {
        // Another run attached this room a moment ago: nothing to record. The same lines pasted by hand: the room is
        // not picked again, under its own event (never "needs you": nothing waits) (second pass, F5).
        const same = (await db.execute({ sql: "SELECT meet_room_id FROM ai_audit_transcripts WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, r.transcriptId] })).rows[0];
        if (String(same?.meet_room_id ?? "") !== roomId) {
          await db.execute(eventStatement({ tenantId: t, engagementId, event: MEET_TRANSCRIPT_ALREADY_HERE, actor: system, at, refType: "meet_room", refId: roomId, meta: { reason: "already_on_engagement" } }));
        }
        continue;
      }
      attached += 1;
      // A Gate 1 card still waiting no longer binds what the engagement holds: withdrawn, as a pasted transcript withdraws it.
      await withdrawAuthorizationIfStale(db, t, engagementId, system, now);
      continue;
    }
    if (RACES.has(r.error)) continue;
    waiting += 1;
    const forAiAnswer = r.error === "ai_answer_needed" || r.error === "ai_answer_unconfirmed";
    await db.execute(
      eventStatement({
        tenantId: t,
        engagementId,
        event: forAiAnswer ? MEET_TRANSCRIPT_NEEDS_AI_ANSWER : MEET_TRANSCRIPT_NEEDS_YOU,
        actor: system,
        at,
        refType: "meet_room",
        refId: roomId,
        meta: { reason: r.error, ...(r.holds?.length ? { holds: r.holds.map((h) => h.hold) } : {}) },
      }),
    );
    const e = await getEngagement(db, t, engagementId);
    const words = waitWords(r);
    await alert({
      tenantId: t,
      alertType: "ai_audit_meet_transcript_waiting",
      severity: "info",
      title: `Call transcript waiting: ${shortName(e?.business_name, "an AI audit")}`,
      body: `The Oasis Meet transcript is ready but was not attached: ${words.why}. ${words.next}`,
      subjectType: "ai_audit_engagement",
      subjectId: engagementId,
    });
  }
  return { attached, waiting };
}
