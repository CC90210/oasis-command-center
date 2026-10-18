/**
 * lib/meet/handlers.ts - Oasis Meet's routes, as functions of what they depend on (database, SFU, session,
 * ICE servers, clock), so the tests run every route against a real libSQL file and a stand-in SFU. The route
 * files (app/api/calendar/meet, app/api/meet/[code]/*) only pass in the live dependencies (./live-deps.ts).
 *
 *   GET/POST /api/calendar/meet        a host lists and makes rooms (session; middleware keeps it signed-in)
 *   POST /api/meet/[code]/join         a person enters: a name, the recording tick, a participant cookie
 *   GET  /api/meet/[code]/state        who is here and what they publish; keeps the caller present
 *   POST /api/meet/[code]/sfu          one negotiation step on the caller's own SFU session
 *   POST /api/meet/[code]/leave        the caller leaves; their session is cut
 *   POST /api/meet/[code]/host         a host removes someone, ends the meeting, or deletes it with its recording;
 *                                      media is cut, not just tokens
 *
 * The /api/meet/ routes are public at the middleware (a guest has no account) and authenticate themselves:
 * every call but join needs a participant token for THIS room, re-read against the participant's row, and
 * host actions need the host's session (lib/meet/access.ts).
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { NextRequest, NextResponse } from "next/server";
import { fnv1a32 } from "@/lib/automations/schedule-plan";
import { readCappedJson, sameOrigin } from "@/lib/offer-pages/public-http";
import {
  MEET_COOKIE,
  MeetNotConfiguredError,
  meetCookie,
  meetDisplayName,
  meetRoleFor,
  meetTokenConfigured,
  requireMeetHost,
  requireMeetParticipant,
  signMeetToken,
  verifyMeetToken,
  type MeetRole,
  type MeetSession,
} from "./access";
import { parseCreateRoom, parseHost, parseJoin, parseSfu } from "./bodies";
import { meetError, meetJson } from "./answers";
import { meetFailure, meetRateLimited, roomView } from "./http";
import type { RTCIceServerLike } from "./ice";
import {
  MEET_MAX_PARTICIPANTS,
  MEET_MAX_TRACKS,
  claimRecorder,
  deleteMeetRoomRows,
  endAbandonedRooms,
  endMeetRoom,
  expireIfHostGone,
  forgetSession,
  holdSession,
  isStale,
  joinMeetRoom,
  leaveMeet,
  leaveStale,
  pendingCuts,
  presentParticipants,
  readPresence,
  removeParticipant,
  roomSessions,
  setParticipantSession,
  setParticipantTracks,
  touchParticipant,
  type HeldSession,
  type MeetPresence,
} from "./participants";
import { meetRoomPath, meetRoomUrl } from "./links";
import { createMeetRoom, listMeetRooms, parseMeetCode, readMeetRoomByCode, setRoomCalendarEvent, type MeetRoom } from "./rooms";
import type { ScheduleOutcome } from "./schedule";
import { cutSession, settledMids, type SfuClient } from "./sfu";

export type { MeetSession };

export type MeetDeps = {
  db: Client;
  /** The SFU client; throws MeetNotConfiguredError when the Realtime app is not set. */
  sfu: () => SfuClient;
  session: () => Promise<MeetSession>;
  ice: () => Promise<RTCIceServerLike[]>;
  /** Put a meeting made for later on its host's Schedule (lib/meet/schedule.ts addMeetingToSchedule). */
  schedule: (owner: { tenantId: string; userId: string }, room: MeetRoom, opts: { timeZone: string; minutes?: number }) => Promise<ScheduleOutcome>;
  /** Take a deleted meeting off its creator's Schedule. Best effort: a failure is logged, the meeting is still deleted. */
  unschedule: (owner: { tenantId: string; userId: string }, eventId: string) => Promise<void>;
  /** The recording side (lib/meet/recording.ts, e9). */
  recording: {
    /** This workspace records (OASIS only) and the recording tables are installed. */
    available: (tenantId: string) => Promise<boolean>;
    /** This workspace's meetings may record at all (meetRecordingServed). */
    served: (tenantId: string) => boolean;
    /** Delete a meeting's recording here and on the PC; null when recording is not installed (nothing to delete). */
    remove: (room: MeetRoom, userId: string, now: Date) => Promise<{ relayRemaining: number } | null>;
  };
  /**
   * Work that runs after the answer has gone (live: ctx.waitUntil, lib/os/runs/keepalive.ts), never on a poll's
   * path. Resolves once the work is handed over, not when it is done: await it, so the platform holds the work
   * before the answer is sent.
   */
  later: (label: string, work: () => Promise<unknown>) => Promise<void>;
  now: () => Date;
};


type Guarded = { ok: true; code: string } | { ok: false; response: NextResponse };

/**
 * What every room route checks before it reads anything: a write comes from our own origin, the link is a real
 * code, and this address and this room are inside their rate limit. One place, so no route can skip a step.
 */
function guard(req: NextRequest, rawCode: string, kind: Parameters<typeof meetRateLimited>[2], { write = true } = {}): Guarded {
  if (write && !sameOrigin(req)) return { ok: false, response: meetError(403, "cross_origin_refused") };
  const code = parseMeetCode(rawCode);
  if (!code) return { ok: false, response: meetError(404, "room_not_found") };
  const limited = meetRateLimited(req, code, kind);
  return limited ? { ok: false, response: limited } : { ok: true, code };
}

/** The SFU client, or null when meetings are not set up: cutting media then has nothing to cut. */
function sfuIfConfigured(deps: Pick<MeetDeps, "sfu">): SfuClient | null {
  try {
    return deps.sfu();
  } catch (err) {
    if (err instanceof MeetNotConfiguredError) return null;
    throw err;
  }
}

/**
 * A call can connect: the video service (the Cloudflare Realtime app) is set up, and so is the participant token's
 * secret, without which nobody can join. A meeting is only made, and only offered, where both are. A booking asks it
 * too (`meetMediaReady(liveMeetDeps())`) and gives the lead a Google Meet link instead when it is false.
 */
export const meetMediaReady = (deps: Pick<MeetDeps, "sfu">): boolean => meetTokenConfigured() && sfuIfConfigured(deps) !== null;

let noSfuLogged = false;

/**
 * Cut one session a row holds and, once it is cut, let the row forget it. True when nothing is left to cut. With
 * no SFU app set (a secret missing or rotated) nothing can be reached to cut: that counts as done, logged once, so
 * a meeting can never be kept undeletable by a session id nobody can close.
 */
async function cutHeld(deps: MeetDeps, room: Pick<MeetRoom, "tenantId" | "id">, held: HeldSession, where: string): Promise<boolean> {
  const sfu = sfuIfConfigured(deps);
  if (!sfu) {
    if (!noSfuLogged) console.error(`[meet.${where}] no SFU app is set; a held session cannot be cut`);
    noSfuLogged = true;
    return true;
  }
  if (!(await cutSession(sfu, held.sessionId, where))) return false;
  try {
    await forgetSession(deps.db, room, held);
  } catch (err) {
    // The media is cut either way; the row keeps the id, so a later step cuts it again (it is already closed).
    console.error(`[meet.${where}] a cut session could not be forgotten`, err instanceof Error ? err.message : err);
  }
  return true;
}

/**
 * Cut every session the room's rows still hold, all at once (each is two SFU calls), so ending it stops media even
 * in a browser that ignores the answer. True when every one is cut; a failed one keeps its id for the next try.
 */
async function cutRoom(deps: MeetDeps, room: Pick<MeetRoom, "tenantId" | "id">, where: string): Promise<boolean> {
  const held = await roomSessions(deps.db, room);
  const results = await Promise.allSettled(held.map((h) => cutHeld(deps, room, h, where)));
  return results.every((r) => r.status === "fulfilled" && r.value);
}

/** How often one room is tidied (per Worker isolate): an SFU that is down costs a retry per half minute, not one per poll. */
const TIDY_EVERY_MS = 30_000;
const lastTidy = new Map<string, number>();

/**
 * After a poll has been answered: whoever has gone silent for MEET_STALE_MS has left, and the sessions of people
 * who left or were removed whose cut has not gone through are cut again.
 */
async function tidyRoomLater(deps: MeetDeps, room: MeetRoom, now: Date): Promise<void> {
  const at = now.getTime();
  if (at - (lastTidy.get(room.id) ?? Number.NEGATIVE_INFINITY) < TIDY_EVERY_MS) return;
  if (lastTidy.size > 500) lastTidy.clear();
  lastTidy.set(room.id, at);
  await deps.later("state.tidy", async () => {
    await leaveStale(deps.db, room, now);
    const held = await pendingCuts(deps.db, room, now, MEET_MAX_PARTICIPANTS);
    await Promise.allSettled(held.map((h) => cutHeld(deps, room, h, "state.tidy")));
  });
}

/**
 * Re-read after a slow SFU call: a leave, a removal or the room's end may have landed meanwhile, and cut and forgotten
 * the session this call just added to. Then what it added is cut too, and the answer is the one the caller gets now.
 */
async function goneMeanwhile(deps: MeetDeps, room: MeetRoom, me: MeetPresence, sfu: SfuClient, sessionId: string): Promise<NextResponse | null> {
  const [nowRoom, row] = await Promise.all([
    readMeetRoomByCode(deps.db, room.code),
    readPresence(deps.db, { tenantId: room.tenantId, roomId: room.id, participantId: me.id }),
  ]);
  const why = !nowRoom
    ? meetError(404, "room_not_found")
    : nowRoom.status === "ended"
      ? meetError(410, "room_ended", { reason: nowRoom.endedReason })
      : row?.removedAt
        ? meetError(403, "removed")
        : !row || row.leftAt
          ? meetError(401, "not_in_room")
          : null;
  // A re-cut that fails gives the row the id back (the leave, removal or end that came first may have forgotten
  // it), so the room's tidy-up and its end can still cut what this call added.
  if (why && !(await cutSession(sfu, sessionId, "sfu.gone_meanwhile")) && nowRoom) {
    await holdSession(deps.db, room, { participantId: me.id, sessionId });
  }
  return why;
}

/**
 * A short tag for a participant's current SFU session, never the session id itself (that stays on the server): it
 * changes when they reconnect, so the others' browsers pull what they publish anew (lib/meet/room-client.ts).
 */
function sessionTag(sessionId: string | null): string | null {
  return sessionId ? fnv1a32(sessionId).toString(36) : null;
}

/** The reason a meeting made for later says it is not on the Schedule when the Schedule itself could not be reached. */
const SCHEDULE_UNAVAILABLE = "schedule_unavailable";

// Host management (Schedule's Meet panel)
export async function handleListRooms(deps: MeetDeps): Promise<NextResponse> {
  try {
    const session = await deps.session();
    if (!session.ok) return meetError(401, "sign_in_required");
    // A call left without its host that nobody polls any more ends here (and in the recording relay's sweep), so
    // the list never shows it live and its recording is handed over.
    for (const room of await endAbandonedRooms(deps.db, [session.tenantId], deps.now())) {
      await deps.later("rooms.abandoned", () => cutRoom(deps, room, "room.abandoned"));
    }
    const [rooms, recordingAvailable] = await Promise.all([
      // A person sees the meetings they made; an owner or admin by base role, who hosts every meeting in the
      // workspace (lib/meet/access.ts meetRoleFor), sees them all.
      listMeetRooms(deps.db, { tenantId: session.tenantId, limit: 20, ...(session.isTrueAdmin ? {} : { hostUserId: session.userId }) }),
      deps.recording.available(session.tenantId),
    ]);
    return meetJson({
      ok: true,
      // `leadId`: a meeting a lead booked is the booking's to cancel (from the lead), not the panel's to delete. The list
      // is a host's own view of their workspace; a guest's answers (roomView) never carry it.
      rooms: rooms.map((r) => ({
        id: r.id, ...roomView(r), link: meetRoomPath(r), url: meetRoomUrl(r), createdAt: r.createdAt, mine: r.hostUserId === session.userId, leadId: r.leadId,
      })),
      // The panel offers "Record and transcribe", and shows a meeting's transcript, only when this is true.
      recordingAvailable,
      // Until the video service is set up the panel says so and offers no meeting to make: nobody sends a client a
      // link that fails when they open it.
      mediaReady: meetMediaReady(deps),
    });
  } catch (err) {
    return meetFailure(err, "rooms.list");
  }
}

export async function handleCreateRoom(req: NextRequest, deps: MeetDeps): Promise<NextResponse> {
  if (!sameOrigin(req)) return meetError(403, "cross_origin_refused");
  try {
    const session = await deps.session();
    if (!session.ok) return meetError(401, "sign_in_required");
    // A meeting whose call cannot connect is never made: no link goes out that fails when it is opened.
    if (!meetMediaReady(deps)) return meetError(503, "meet_not_configured");
    const body = parseCreateRoom(await readCappedJson(req, 4_000));
    if (!body) return meetError(400, "invalid_body");
    // A room records only where recording really happens (an OASIS workspace with recording installed): guests
    // are never asked to agree to a recording nobody makes.
    const recordingAvailable = await deps.recording.available(session.tenantId);
    const room = await createMeetRoom(deps.db, {
      tenantId: session.tenantId,
      hostUserId: session.userId,
      title: body.title,
      startsAt: body.startsAt ?? null,
      recordAudio: recordingAvailable && (body.recordAudio ?? true),
      now: deps.now(),
    });
    // A meeting made for later also goes on the host's Schedule. The link works whether or not it could; a
    // refusal comes back as the Schedule's own code (shabbat_protected...), worded by the Schedule's messageFor.
    // The room exists from here on: nothing about the Schedule turns this answer into a failure (a retry would make
    // a second room).
    let schedule: { added: true } | { added: false; reason: string } | undefined;
    if (room.startsAt) {
      const owner = { tenantId: session.tenantId, userId: session.userId };
      let outcome: ScheduleOutcome = { ok: false, reason: "time_zone_invalid" };
      if (body.timeZone) {
        try {
          outcome = await deps.schedule(owner, room, { timeZone: body.timeZone, minutes: body.minutes });
        } catch (err) {
          console.error("[meet.rooms.create] the Schedule could not be reached", err instanceof Error ? err.message : err);
          outcome = { ok: false, reason: SCHEDULE_UNAVAILABLE };
        }
      }
      if (outcome.ok) {
        try {
          await setRoomCalendarEvent(deps.db, room, outcome.eventId);
          room.calendarEventId = outcome.eventId;
          schedule = { added: true };
        } catch (err) {
          // A room that cannot remember its entry could never take it off again: take it back now.
          console.error("[meet.rooms.create] could not link the Schedule entry", err instanceof Error ? err.message : err);
          await deps.unschedule(owner, outcome.eventId);
          schedule = { added: false, reason: SCHEDULE_UNAVAILABLE };
        }
      } else {
        schedule = { added: false, reason: outcome.reason };
      }
    }
    return meetJson(
      { ok: true, room: { id: room.id, ...roomView(room), link: meetRoomPath(room), url: meetRoomUrl(room), createdAt: room.createdAt, mine: true }, ...(schedule ? { schedule } : {}) },
      201,
    );
  } catch (err) {
    return meetFailure(err, "rooms.create");
  }
}

// The room
/**
 * This person's browser may record the room: a host's, in a room that records, in a workspace whose meetings are
 * recorded. Which one of them does is the room's recorder (lib/meet/participants.ts claimRecorder).
 */
const mayRecord = (participant: MeetPresence, room: MeetRoom, deps: Pick<MeetDeps, "recording">) =>
  participant.role === "host" && room.recordAudio && deps.recording.served(room.tenantId);

/**
 * What a join answers. `records`: this browser runs the recording. One browser records a room, whichever host's
 * takes it first; the chunk route refuses audio from any other browser still in the call.
 */
function joined(participant: MeetPresence, room: MeetRoom, iceServers: RTCIceServerLike[], records: boolean) {
  return meetJson({
    ok: true,
    participantId: participant.id,
    role: participant.role,
    name: participant.displayName,
    records,
    room: roomView(room),
    iceServers,
  });
}

/** This browser records the room after its join: it takes the recording if it may and nobody else has it. */
async function recordsAfterJoin(deps: MeetDeps, participant: MeetPresence, room: MeetRoom, now: Date): Promise<boolean> {
  const may = mayRecord(participant, room, deps);
  return may && (await claimRecorder(deps.db, room, participant, now, may)).mine;
}

export async function handleJoin(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  const g = guard(req, rawCode, "join");
  if (!g.ok) return g.response;
  const { code } = g;
  try {
    const body = parseJoin((await readCappedJson(req, 2_000)) ?? undefined);
    if (!body) return meetError(400, "invalid_body");
    const room = await readMeetRoomByCode(deps.db, code);
    if (!room) return meetError(404, "room_not_found");
    if (room.status === "ended") return meetError(410, "room_ended", { reason: room.endedReason });
    const now = deps.now();
    // Checked before anything is written: without its secret no token can be signed, and a join would be a stray row.
    const earlier = verifyMeetToken(req.cookies.get(MEET_COOKIE)?.value, now.getTime());
    const session = await deps.session();
    const role: MeetRole = session.ok ? (meetRoleFor(session, room) ?? "guest") : "guest";

    // The same browser coming back (a refresh, a dropped connection): its token still names someone in this room.
    // One silent for MEET_STALE_MS has left, and comes back as a new join, through the cap.
    if (earlier && earlier.roomId === room.id) {
      const before = await readPresence(deps.db, { tenantId: room.tenantId, roomId: room.id, participantId: earlier.participantId });
      if (before?.removedAt) return meetError(403, "removed");
      // The touch is the check that counts: a leave or the room's tidy-up landing since the read leaves nothing to
      // touch, and then this is a new join too.
      if (before && !before.leftAt && before.role === role && !isStale(before, now) && (await touchParticipant(deps.db, before, now))) {
        return joined(before, room, await deps.ice(), await recordsAfterJoin(deps, before, room, now));
      }
    }

    // Only a member of the room's own workspace joins under their account's name; anyone else types one, so a
    // signed-in visitor from another workspace never shows the room their email.
    const member = session.ok && session.tenantId === room.tenantId;
    const name = meetDisplayName(body.name) ?? (member ? meetDisplayName(session.email?.split("@")[0]) : null);
    if (!name) return meetError(400, "name_required");
    // Quebec Law 25, notice before collection: everyone but the person who chose to record ticks the notice first,
    // a second host too. The page asks for it before it touches a camera or microphone (components/meet/notice.ts).
    const creator = member && session.userId === room.hostUserId;
    if (room.recordAudio && !creator && body.consent !== true) return meetError(400, "consent_required");
    const participant = await joinMeetRoom(deps.db, {
      room,
      role,
      userId: session.ok ? session.userId : null,
      displayName: name,
      consentAt: room.recordAudio ? now.toISOString() : null,
      now,
    });
    if (!participant) return meetError(409, "room_full");
    const token = signMeetToken({ roomId: room.id, participantId: participant.id, role }, now.getTime());
    const current = (await readMeetRoomByCode(deps.db, code)) ?? room;
    const res = joined(participant, current, await deps.ice(), await recordsAfterJoin(deps, participant, current, now));
    const cookie = meetCookie(code, token);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (err) {
    return meetFailure(err, "join");
  }
}

export async function handleState(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  // A read (the 2-second poll): no same-origin check, like any GET.
  const g = guard(req, rawCode, "state", { write: false });
  if (!g.ok) return g.response;
  const { code } = g;
  try {
    const now = deps.now();
    const auth = await requireMeetParticipant(deps.db, req, code, now.getTime());
    if (!auth.ok) return auth.response;
    const { room, participant: me } = auth;
    await touchParticipant(deps.db, me, now);
    if (await expireIfHostGone(deps.db, room, now)) {
      await deps.later("room.expire", () => cutRoom(deps, room, "room.expire"));
      return meetError(410, "room_ended", { reason: "host_left" });
    }
    await tidyRoomLater(deps, room, now);
    const present = await presentParticipants(deps.db, room, now);
    // A host's poll takes the recording when nobody is recording (the recorder left or went silent): the browser
    // starts its recorder from `records`, mid-call too, and stops it when another browser has the recording.
    const recorder = await claimRecorder(deps.db, room, me, now, mayRecord(me, room, deps));
    return meetJson({
      ok: true,
      room: roomView(room),
      me: { id: me.id, role: me.role, name: me.displayName },
      hostPresent: present.some((p) => p.role === "host"),
      records: recorder.mine,
      // Recording now: the room records and the browser that records it is in the call (within MEET_STALE_MS: a late
      // poll does not stop a recorder). The page says "recorded" from this, never from a host being present.
      recording: room.recordAudio && deps.recording.served(room.tenantId) && recorder.inCall,
      participants: present.map((p) => ({
        id: p.id,
        name: p.displayName,
        role: p.role,
        me: p.id === me.id,
        session: sessionTag(p.sfuSessionId),
        tracks: p.tracks.map((t) => ({ trackName: t.trackName, kind: t.kind })),
      })),
    });
  } catch (err) {
    return meetFailure(err, "state");
  }
}

export async function handleSfu(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  const g = guard(req, rawCode, "sfu");
  if (!g.ok) return g.response;
  const { code } = g;
  try {
    const now = deps.now();
    const auth = await requireMeetParticipant(deps.db, req, code, now.getTime());
    if (!auth.ok) return auth.response;
    const body = parseSfu(await readCappedJson(req, 80_000));
    if (!body) return meetError(400, "invalid_body");
    const { room, participant: me } = auth;
    const sfu = deps.sfu();

    if (body.action === "session") {
      // A guest's media waits for a host: nobody sits in a room the host has not opened.
      if (me.role === "guest" && !(await presentParticipants(deps.db, room, now)).some((p) => p.role === "host")) {
        return meetError(409, "waiting_for_host");
      }
      // A reconnect replaces the session only once the old one is cut: the row is the only record of it, and an id
      // overwritten uncut would be a session nobody could ever close. The browser tries again (room-client reconnect).
      if (me.sfuSessionId && !(await cutSession(sfu, me.sfuSessionId, "sfu.reconnect"))) return meetError(502, "sfu_failed");
      await setParticipantSession(deps.db, me, await sfu.newSession());
      return meetJson({ ok: true });
    }

    if (!me.sfuSessionId) return meetError(409, "no_session");

    if (body.action === "publish") {
      const kept = me.tracks.filter((t) => !body.tracks.some((n) => n.trackName === t.trackName));
      if (kept.length + body.tracks.length > MEET_MAX_TRACKS) return meetError(400, "too_many_tracks");
      const result = await sfu.publish(me.sfuSessionId, body.offer, body.tracks.map(({ mid, trackName }) => ({ mid, trackName })));
      const gone = await goneMeanwhile(deps, room, me, sfu, me.sfuSessionId);
      if (gone) return gone;
      const published = body.tracks.flatMap((t) => {
        const r = result.tracks.find((x) => x.trackName === t.trackName);
        return r?.errorCode ? [] : [{ trackName: t.trackName, kind: t.kind, mid: r?.mid || t.mid }];
      });
      await setParticipantTracks(deps.db, me, [...kept, ...published]);
      return meetJson({
        ok: true,
        sessionDescription: result.sessionDescription,
        tracks: result.tracks.map((t) => ({ trackName: t.trackName ?? null, mid: t.mid ?? null, errorCode: t.errorCode ?? null })),
      });
    }

    if (body.action === "pull") {
      // Only what someone else in THIS room publishes right now; their SFU session never leaves the server.
      const present = await presentParticipants(deps.db, room, now);
      const wanted: Array<{ sessionId: string; trackName: string; participantId: string }> = [];
      for (const want of body.tracks) {
        const owner = present.find((p) => p.id === want.participantId && p.id !== me.id);
        const track = owner?.tracks.find((t) => t.trackName === want.trackName);
        if (!owner?.sfuSessionId || !track) return meetError(404, "track_not_found");
        wanted.push({ sessionId: owner.sfuSessionId, trackName: track.trackName, participantId: owner.id });
      }
      const result = await sfu.pull(me.sfuSessionId, wanted.map(({ sessionId, trackName }) => ({ sessionId, trackName })));
      const gone = await goneMeanwhile(deps, room, me, sfu, me.sfuSessionId);
      if (gone) return gone;
      const owners = new Map(wanted.map((w) => [`${w.sessionId}\n${w.trackName}`, w.participantId]));
      return meetJson({
        ok: true,
        requiresImmediateRenegotiation: result.requiresImmediateRenegotiation,
        sessionDescription: result.sessionDescription,
        tracks: result.tracks.map((t) => ({
          participantId: owners.get(`${t.sessionId ?? ""}\n${t.trackName ?? ""}`) ?? null,
          trackName: t.trackName ?? null,
          mid: t.mid ?? null,
          errorCode: t.errorCode ?? null,
        })),
      });
    }

    if (body.action === "renegotiate") {
      await sfu.renegotiate(me.sfuSessionId, body.answer);
      return meetJson({ ok: true });
    }

    // close: the caller's own tracks on its own session; what it published stops being offered to the room.
    const result = await sfu.close(me.sfuSessionId, body.mids, body.offer);
    const closed = settledMids(result);
    const remaining = me.tracks.filter((t) => !closed.has(t.mid));
    if (remaining.length !== me.tracks.length) await setParticipantTracks(deps.db, me, remaining);
    return meetJson({
      ok: true,
      sessionDescription: result.sessionDescription,
      tracks: result.tracks.map((t) => ({ mid: t.mid ?? null, errorCode: t.errorCode ?? null })),
    });
  } catch (err) {
    return meetFailure(err, "sfu");
  }
}

export async function handleLeave(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  const g = guard(req, rawCode, "leave");
  if (!g.ok) return g.response;
  const { code } = g;
  try {
    const now = deps.now();
    const auth = await requireMeetParticipant(deps.db, req, code, now.getTime());
    // Leaving a room that ended, or leaving twice, is already done.
    if (!auth.ok) return [401, 410].includes(auth.response.status) ? meetJson({ ok: true }) : auth.response;
    await leaveMeet(deps.db, auth.participant, now);
    const { id, sfuSessionId } = auth.participant;
    if (sfuSessionId) await cutHeld(deps, auth.room, { participantId: id, sessionId: sfuSessionId }, "leave");
    const res = meetJson({ ok: true });
    const cookie = meetCookie(code, "");
    res.cookies.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
    return res;
  } catch (err) {
    return meetFailure(err, "leave");
  }
}

/**
 * Delete a meeting with its recording, in the one safe order. The host's Delete uses it, and so does a booking that
 * is cancelled (server-side, with liveMeetDeps; `actorUserId` is who deletes, and a booking passes its room's host).
 * Throws, keeping the meeting, when the recording cannot be deleted.
 */
export async function deleteMeetRoom(
  deps: MeetDeps,
  room: MeetRoom,
  actorUserId: string,
  now: Date,
): Promise<{ relayRemaining: number; mediaCut: boolean }> {
  // A meeting still going is ended first, so nobody keeps talking into a room that no longer exists.
  if (room.status !== "ended") await endMeetRoom(deps.db, room, "host_ended", now);
  // Every session the rows still hold is cut, whatever the status: an end whose cut failed left its ids here, and
  // deleting the rows loses them for good. One that still fails is logged and the delete goes on: an SFU that does not
  // answer must never keep a meeting, and its recording, from being deleted.
  const mediaCut = await cutRoom(deps, room, "room.delete");
  // The recording goes next (e9's deleteMeetRecording: the transcript, the relay and the PC's copy). If it fails, the
  // meeting is kept, so the recording can never be orphaned by a half-done delete.
  const recording = await deps.recording.remove(room, actorUserId, now);
  // The creator's own Schedule entry, which Meet made, carries the dead link. Another host's delete never touches
  // someone else's calendar, and a booked meeting's calendar entries belong to its booking (calendarEventId is null).
  if (room.calendarEventId && room.hostUserId === actorUserId) {
    await deps.unschedule({ tenantId: room.tenantId, userId: room.hostUserId }, room.calendarEventId);
  }
  await deleteMeetRoomRows(deps.db, room);
  return { relayRemaining: recording?.relayRemaining ?? 0, mediaCut };
}

export async function handleHost(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  const g = guard(req, rawCode, "action");
  if (!g.ok) return g.response;
  const { code } = g;
  try {
    const body = parseHost(await readCappedJson(req, 1_000));
    if (!body) return meetError(400, "invalid_body");
    const auth = await requireMeetHost(deps.db, code, deps.session);
    if (!auth.ok) return auth.response;
    const { room } = auth;
    const now = deps.now();

    if (body.action === "remove") {
      if (room.status === "ended") return meetError(410, "room_ended");
      const target = await readPresence(deps.db, { tenantId: room.tenantId, roomId: room.id, participantId: body.participantId });
      if (target && target.userId && target.userId === auth.userId) return meetError(400, "cannot_remove_self");
      const removed = await removeParticipant(deps.db, room, body.participantId, now);
      if (!removed) return meetError(404, "participant_not_found");
      // A cut that fails keeps the session id: the room's next polls try again (tidyRoomLater).
      const mediaCut = removed.sfuSessionId
        ? await cutHeld(deps, room, { participantId: removed.id, sessionId: removed.sfuSessionId }, "host.remove")
        : true;
      return meetJson({ ok: true, removed: removed.id, mediaCut });
    }

    if (body.action === "delete") {
      // A meeting a lead booked is the booking's: cancelling it from the lead deletes this room and the booking's own
      // calendar entries and invite together. Deleting only the room would leave those holding a dead link.
      if (room.leadId) return meetError(409, "booked_meeting");
      return meetJson({ ok: true, deleted: true, ...(await deleteMeetRoom(deps, room, auth.userId, now)) });
    }

    const endedNow = await endMeetRoom(deps.db, room, "host_ended", now);
    const mediaCut = await cutRoom(deps, room, "room.end");
    return meetJson({ ok: true, ended: true, alreadyEnded: !endedNow, mediaCut });
  } catch (err) {
    return meetFailure(err, "host");
  }
}
