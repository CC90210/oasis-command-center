/**
 * lib/ai-audit/meet-link.ts — a discovery call held in Oasis Meet, joined to
 * its Free AI Audit engagement.
 *
 * ROOMS. An engagement's rooms are its lead's (meet_rooms.lead_id, which a
 * booking already sets). The live-call screen opens the newest open one, or
 * makes one for the lead: recorded, and named for the call.
 *
 * TRANSCRIPTS. A room's transcript, once Meet has it ready, becomes one of the
 * engagement's transcripts (source "meet") only when:
 *   - every guest agreed to the recording in Meet before joining
 *     (meet_participants.consent_at). That is the recording consent, basis
 *     "meet_guests". A room no guest joined is no client's call;
 *   - the client's answer about AI analysis is known: CC records it on the
 *     call's opening question (the profile's consent.ai_processing), or says
 *     it when he attaches the transcript by hand. Yes or no, it is the
 *     transcript's AI consent, and a no means nothing is ever sent to a model;
 *   - the engagement is still before Gate 1.
 * The tick attaches what it can; anything it cannot is listed for CC once, and
 * he attaches it by hand. The lines are scrubbed like any transcript's
 * (lib/ai-audit/transcript.ts parseMeetLines). A Meet transcript that was
 * attached once, even if CC deleted it later, is never attached again by
 * itself.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { createMeetRoom } from "@/lib/meet/rooms";
import { meetRecordingTablesInstalled, readTranscript } from "@/lib/meet/recording";
import { parseMeetLines } from "@/lib/ai-audit/transcript";
import { addTranscript } from "@/lib/ai-audit/transcripts";
import { listProfileFields } from "@/lib/ai-audit/versions";
import { PROFILE_EDIT_STAGES, shortName } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, requireTenant, type Actor, type Engagement } from "@/lib/ai-audit/store";

export type AuditRoomGuest = { name: string; consented: boolean };
export type AuditRoom = {
  id: string;
  code: string;
  title: string;
  status: string;
  recordAudio: boolean;
  startsAt: string | null;
  createdAt: string;
  /** Meet's transcript of the room, if it has one: its status and how many lines. */
  transcript: { status: string; lines: number } | null;
  guests: AuditRoomGuest[];
  /** The engagement's transcript made from this room, if one was attached. */
  attachedTranscriptId: string | null;
};

/** The event that says a room's transcript is waiting for CC (the tick writes it once per room). */
export const MEET_TRANSCRIPT_NEEDS_YOU = "meet_transcript_needs_you";

async function guestsOf(db: Client, t: string, roomId: string): Promise<AuditRoomGuest[]> {
  const rs = await db.execute({
    sql: "SELECT display_name, consent_at FROM meet_participants WHERE tenant_id = ? AND room_id = ? AND role = 'guest' ORDER BY joined_at, id",
    args: [t, roomId],
  });
  return rs.rows.map((g) => ({ name: String(g.display_name), consented: g.consent_at !== null && g.consent_at !== undefined && String(g.consent_at) !== "" }));
}

/** The engagement's Meet rooms, newest first, with what each holds for the audit. Empty when Meet is not set up. */
export async function roomsForEngagement(db: Client, tenantId: string, engagement: Pick<Engagement, "id" | "lead_id">): Promise<AuditRoom[]> {
  const t = requireTenant(tenantId);
  if (!engagement.lead_id || !(await meetRecordingTablesInstalled(db))) return [];
  const rooms = (
    await db.execute({
      sql: `SELECT id, code, title, status, record_audio, starts_at, created_at FROM meet_rooms
             WHERE tenant_id = ? AND lead_id = ? ORDER BY COALESCE(starts_at, created_at) DESC, created_at DESC LIMIT 10`,
      args: [t, engagement.lead_id],
    })
  ).rows;
  const out: AuditRoom[] = [];
  for (const r of rooms) {
    const id = String(r.id);
    const meet = await readTranscript(db, t, id);
    const attached = (
      await db.execute({ sql: "SELECT id FROM ai_audit_transcripts WHERE tenant_id = ? AND engagement_id = ? AND meet_room_id = ? AND status = 'active' LIMIT 1", args: [t, engagement.id, id] })
    ).rows[0];
    out.push({
      id,
      code: String(r.code),
      title: String(r.title),
      status: String(r.status),
      recordAudio: Number(r.record_audio) === 1,
      startsAt: r.starts_at === null || r.starts_at === undefined ? null : String(r.starts_at),
      createdAt: String(r.created_at),
      transcript: meet ? { status: meet.status, lines: meet.lines.length } : null,
      guests: await guestsOf(db, t, id),
      attachedTranscriptId: attached ? String(attached.id) : null,
    });
  }
  return out;
}

export type CreateRoomResult = { ok: true; roomId: string; code: string; created: boolean } | { ok: false; error: "not_found" | "no_lead" | "meet_not_installed" };

/** The lead's open call room, or a new one: recorded, named for the discovery call, linked to the lead. */
export async function createAuditRoom(db: Client, input: { tenantId: string; engagementId: string; hostUserId: string; now: Date }): Promise<CreateRoomResult> {
  const t = requireTenant(input.tenantId);
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!e.lead_id) return { ok: false, error: "no_lead" };
  if (!(await meetRecordingTablesInstalled(db))) return { ok: false, error: "meet_not_installed" };
  // A room still to be held (booked, or made earlier): that one, so a second press makes no second room.
  const open = (
    await db.execute({ sql: "SELECT id, code FROM meet_rooms WHERE tenant_id = ? AND lead_id = ? AND status IN ('scheduled', 'live') ORDER BY created_at DESC LIMIT 1", args: [t, e.lead_id] })
  ).rows[0];
  if (open) return { ok: true, roomId: String(open.id), code: String(open.code), created: false };
  const room = await createMeetRoom(db, {
    tenantId: t,
    hostUserId: input.hostUserId,
    title: `Discovery call: ${shortName(e.business_name, "a new client", 60)}`,
    recordAudio: true,
    leadId: e.lead_id,
    now: input.now,
  });
  await db.execute(eventStatement({ tenantId: t, engagementId: e.id, event: "meet_room_created", actor: { type: "user", id: input.hostUserId }, at: input.now.toISOString(), refType: "meet_room", refId: room.id }));
  return { ok: true, roomId: room.id, code: room.code, created: true };
}

export type AttachError =
  | "not_found"
  | "stage_closed"
  | "meet_not_installed"
  | "meet_not_ready"
  | "no_guests"
  | "no_recording_consent"
  | "ai_answer_needed"
  | "too_many_transcripts"
  | string;
export type AttachResult = { ok: true; transcriptId: string; duplicate: boolean } | { ok: false; error: AttachError };

/**
 * One room's ready transcript, attached to the engagement. `ai` is CC's word on
 * the client's answer about AI analysis when he attaches by hand; without it the
 * profile's recorded answer is used, and with neither nothing is attached.
 */
export async function attachMeetTranscript(
  db: Client,
  input: { tenantId: string; engagementId: string; roomId: string; actor: Actor; now: Date; ai?: boolean },
): Promise<AttachResult> {
  const t = requireTenant(input.tenantId);
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!PROFILE_EDIT_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
  if (!(await meetRecordingTablesInstalled(db))) return { ok: false, error: "meet_not_installed" };
  const room = (await db.execute({ sql: "SELECT id, lead_id FROM meet_rooms WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, input.roomId] })).rows[0];
  // Only the lead's own rooms: never another client's call.
  if (!room || !e.lead_id || String(room.lead_id ?? "") !== e.lead_id) return { ok: false, error: "not_found" };
  const meet = await readTranscript(db, t, input.roomId);
  if (!meet || meet.status !== "ready" || !meet.lines.length) return { ok: false, error: "meet_not_ready" };
  const guests = await guestsOf(db, t, input.roomId);
  if (!guests.length) return { ok: false, error: "no_guests" };
  if (guests.some((g) => !g.consented)) return { ok: false, error: "no_recording_consent" };
  let ai = input.ai;
  if (ai === undefined) {
    const fields = e.current_profile_version_id ? await listProfileFields(db, t, e.current_profile_version_id) : [];
    const answer = fields.find((f) => f.field_key === "consent.ai_processing");
    if (answer && typeof answer.value === "boolean") ai = answer.value;
  }
  if (ai === undefined) return { ok: false, error: "ai_answer_needed" };
  const parsed = parseMeetLines(meet.lines.map((l) => ({ t: Math.max(0, Math.floor(l.at_ms / 1000)), speaker: l.speaker, text: l.text })));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const r = await addTranscript(db, {
    tenantId: t,
    engagementId: e.id,
    parsed: parsed.value,
    source: "meet",
    meetRoomId: input.roomId,
    consent: { recording: true, ai, basis: "meet_guests", by: input.actor.id ?? null },
    actor: input.actor,
    now: input.now,
  });
  if (!r.ok) return r;
  return { ok: true, transcriptId: r.transcript.id, duplicate: r.duplicate };
}

export type AlertFn = (input: { tenantId: string; alertType: string; severity: "info" | "warn" | "urgent"; title: string; body: string; subjectType: string; subjectId: string; telegramOncePerOpen?: boolean }) => Promise<unknown>;

const WHY: Readonly<Record<string, string>> = {
  ai_answer_needed: "the client's answer about AI analysis is not in the profile yet",
  no_recording_consent: "a guest joined without agreeing to the recording",
  no_guests: "no guest joined the room",
};

/**
 * The tick's step: ready Meet transcripts of engagements still before Gate 1,
 * never attached, attached now. One that cannot be (no AI answer recorded, a
 * guest who did not agree) is listed for CC once, and waits for his hand.
 */
export async function autoAttachMeetTranscripts(db: Client, tenantId: string, now: Date, alert: AlertFn, limit = 5): Promise<{ attached: number; waiting: number }> {
  const t = requireTenant(tenantId);
  if (!(await meetRecordingTablesInstalled(db))) return { attached: 0, waiting: 0 };
  const stages = PROFILE_EDIT_STAGES;
  const rs = await db.execute({
    sql: `SELECT e.id AS engagement_id, r.id AS room_id FROM ai_audit_engagements e
            JOIN meet_rooms r ON r.tenant_id = e.tenant_id AND r.lead_id = e.lead_id
            JOIN meet_transcripts m ON m.tenant_id = r.tenant_id AND m.room_id = r.id AND m.status = 'ready'
           WHERE e.tenant_id = ? AND e.stage IN (${stages.map(() => "?").join(", ")})
             AND NOT EXISTS (SELECT 1 FROM ai_audit_transcripts a WHERE a.tenant_id = e.tenant_id AND a.engagement_id = e.id AND a.meet_room_id = r.id)
             AND NOT EXISTS (SELECT 1 FROM ai_audit_events v WHERE v.tenant_id = e.tenant_id AND v.engagement_id = e.id AND v.event = ? AND v.ref_id = r.id)
           ORDER BY m.updated_at LIMIT ?`,
    args: [t, ...stages, MEET_TRANSCRIPT_NEEDS_YOU, limit],
  });
  let attached = 0;
  let waiting = 0;
  const system: Actor = { type: "system", id: null };
  for (const row of rs.rows) {
    const engagementId = String(row.engagement_id);
    const roomId = String(row.room_id);
    const r = await attachMeetTranscript(db, { tenantId: t, engagementId, roomId, actor: system, now });
    if (r.ok) {
      attached += 1;
      continue;
    }
    const why = WHY[r.error];
    if (!why) continue;
    waiting += 1;
    await db.execute(eventStatement({ tenantId: t, engagementId, event: MEET_TRANSCRIPT_NEEDS_YOU, actor: system, at: now.toISOString(), refType: "meet_room", refId: roomId, meta: { reason: r.error } }));
    const e = await getEngagement(db, t, engagementId);
    await alert({
      tenantId: t,
      alertType: "ai_audit_meet_transcript_waiting",
      severity: "info",
      title: `Call transcript waiting: ${shortName(e?.business_name, "an AI audit")}`,
      body: `The Oasis Meet transcript is ready but was not attached: ${why}. Open the engagement to attach it.`,
      subjectType: "ai_audit_engagement",
      subjectId: engagementId,
    });
  }
  return { attached, waiting };
}
