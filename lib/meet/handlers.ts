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
 *   POST /api/meet/[code]/host         a host removes someone or ends the meeting; media is cut, not just tokens
 *
 * The /api/meet/ routes are public at the middleware (a guest has no account) and authenticate themselves:
 * every call but join needs a participant token for THIS room, re-read against the participant's row, and
 * host actions need the host's session (lib/meet/access.ts).
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { NextRequest, NextResponse } from "next/server";
import { readCappedJson, sameOrigin } from "@/lib/offer-pages/public-http";
import {
  MEET_COOKIE,
  MeetNotConfiguredError,
  meetCookie,
  meetDisplayName,
  meetRoleFor,
  requireMeetHost,
  requireMeetParticipant,
  signMeetToken,
  verifyMeetToken,
  type MeetRole,
} from "./access";
import { parseCreateRoom, parseHost, parseJoin, parseSfu } from "./bodies";
import { meetError, meetFailure, meetJson, meetRateLimited, roomView } from "./http";
import type { RTCIceServerLike } from "./ice";
import {
  MEET_MAX_TRACKS,
  endMeetRoom,
  expireIfHostGone,
  joinMeetRoom,
  leaveMeet,
  presentParticipants,
  readPresence,
  removeParticipant,
  roomSessions,
  setParticipantSession,
  setParticipantTracks,
  touchParticipant,
  type MeetPresence,
} from "./participants";
import { createMeetRoom, displayMeetCode, listMeetRooms, parseMeetCode, readMeetRoomByCode, type MeetRoom } from "./rooms";
import { cutSession, type SfuClient } from "./sfu";

export type MeetSession = { ok: true; tenantId: string; userId: string; isTrueAdmin: boolean; email?: string | null } | { ok: false };

export type MeetDeps = {
  db: Client;
  /** The SFU client; throws MeetNotConfiguredError when the Realtime app is not set. */
  sfu: () => SfuClient;
  session: () => Promise<MeetSession>;
  ice: () => Promise<RTCIceServerLike[]>;
  now: () => Date;
};

const link = (room: MeetRoom) => `/meet/${displayMeetCode(room.code)}`;

/** The SFU client, or null when meetings are not set up: cutting media then has nothing to cut. */
function sfuIfConfigured(deps: MeetDeps): SfuClient | null {
  try {
    return deps.sfu();
  } catch (err) {
    if (err instanceof MeetNotConfiguredError) return null;
    throw err;
  }
}

/** Cut every session the room has had, so ending it stops media even in a browser that ignores the answer. */
async function cutRoom(deps: MeetDeps, room: MeetRoom): Promise<void> {
  const sfu = sfuIfConfigured(deps);
  if (!sfu) return;
  for (const sessionId of await roomSessions(deps.db, room)) await cutSession(sfu, sessionId, "room.end");
}

// Host management (Schedule's Meet panel)
export async function handleListRooms(deps: MeetDeps): Promise<NextResponse> {
  try {
    const session = await deps.session();
    if (!session.ok) return meetError(401, "sign_in_required");
    const rooms = await listMeetRooms(deps.db, { tenantId: session.tenantId, limit: 20 });
    return meetJson({
      ok: true,
      rooms: rooms.map((r) => ({ id: r.id, ...roomView(r), link: link(r), createdAt: r.createdAt, mine: r.hostUserId === session.userId })),
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
    const body = parseCreateRoom(await readCappedJson(req, 4_000));
    if (!body) return meetError(400, "invalid_body");
    const room = await createMeetRoom(deps.db, {
      tenantId: session.tenantId,
      hostUserId: session.userId,
      title: body.title,
      startsAt: body.startsAt ?? null,
      recordAudio: body.recordAudio ?? true,
      now: deps.now(),
    });
    return meetJson({ ok: true, room: { id: room.id, ...roomView(room), link: link(room), createdAt: room.createdAt, mine: true } }, 201);
  } catch (err) {
    return meetFailure(err, "rooms.create");
  }
}

// The room
/**
 * What a join answers. `records`: this browser runs the recording, which is only ever the room creator's (one
 * recording browser per room; the recording route refuses a second). If the creator is not in the call,
 * nothing records.
 */
function joined(participant: MeetPresence, room: MeetRoom, iceServers: RTCIceServerLike[]) {
  return meetJson({
    ok: true,
    participantId: participant.id,
    role: participant.role,
    name: participant.displayName,
    records: participant.role === "host" && room.recordAudio && participant.userId !== null && participant.userId === room.hostUserId,
    room: roomView(room),
    iceServers,
  });
}

export async function handleJoin(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  if (!sameOrigin(req)) return meetError(403, "cross_origin_refused");
  const code = parseMeetCode(rawCode);
  if (!code) return meetError(404, "room_not_found");
  const limited = meetRateLimited(req, code, "join");
  if (limited) return limited;
  try {
    const body = parseJoin((await readCappedJson(req, 2_000)) ?? undefined);
    if (!body) return meetError(400, "invalid_body");
    const room = await readMeetRoomByCode(deps.db, code);
    if (!room) return meetError(404, "room_not_found");
    if (room.status === "ended") return meetError(410, "room_ended");
    const now = deps.now();
    // Checked before anything is written: without its secret no token can be signed, and a join would be a stray row.
    const earlier = verifyMeetToken(req.cookies.get(MEET_COOKIE)?.value, now.getTime());
    const session = await deps.session();
    const role: MeetRole = session.ok ? (meetRoleFor(session, room) ?? "guest") : "guest";

    // The same browser coming back (a refresh, a dropped connection): its token still names someone in this room.
    if (earlier && earlier.roomId === room.id) {
      const before = await readPresence(deps.db, { tenantId: room.tenantId, roomId: room.id, participantId: earlier.participantId });
      if (before?.removedAt) return meetError(403, "removed");
      if (before && !before.leftAt && before.role === role) {
        await touchParticipant(deps.db, before, now);
        return joined(before, room, await deps.ice());
      }
    }

    const name = meetDisplayName(body.name) ?? (session.ok ? meetDisplayName(session.email?.split("@")[0]) : null);
    if (!name) return meetError(400, "name_required");
    // The recording notice is ticked before a guest's camera or microphone is touched (the page asks first).
    if (room.recordAudio && role === "guest" && body.consent !== true) return meetError(400, "consent_required");
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
    const res = joined(participant, current, await deps.ice());
    const cookie = meetCookie(code, token);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (err) {
    return meetFailure(err, "join");
  }
}

export async function handleState(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  const code = parseMeetCode(rawCode);
  if (!code) return meetError(404, "room_not_found");
  const limited = meetRateLimited(req, code, "state");
  if (limited) return limited;
  try {
    const now = deps.now();
    const auth = await requireMeetParticipant(deps.db, req, code, now.getTime());
    if (!auth.ok) return auth.response;
    const { room, participant: me } = auth;
    await touchParticipant(deps.db, me, now);
    if (await expireIfHostGone(deps.db, room, now)) {
      await cutRoom(deps, room);
      return meetError(410, "room_ended");
    }
    const present = await presentParticipants(deps.db, room, now);
    return meetJson({
      ok: true,
      room: roomView(room),
      me: { id: me.id, role: me.role, name: me.displayName },
      hostPresent: present.some((p) => p.role === "host"),
      participants: present.map((p) => ({
        id: p.id,
        name: p.displayName,
        role: p.role,
        me: p.id === me.id,
        tracks: p.tracks.map((t) => ({ trackName: t.trackName, kind: t.kind })),
      })),
    });
  } catch (err) {
    return meetFailure(err, "state");
  }
}

export async function handleSfu(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  if (!sameOrigin(req)) return meetError(403, "cross_origin_refused");
  const code = parseMeetCode(rawCode);
  if (!code) return meetError(404, "room_not_found");
  const limited = meetRateLimited(req, code, "sfu");
  if (limited) return limited;
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
      if (me.sfuSessionId) await cutSession(sfu, me.sfuSessionId, "sfu.reconnect");
      await setParticipantSession(deps.db, me, await sfu.newSession());
      return meetJson({ ok: true });
    }

    if (!me.sfuSessionId) return meetError(409, "no_session");

    if (body.action === "publish") {
      const kept = me.tracks.filter((t) => !body.tracks.some((n) => n.trackName === t.trackName));
      if (kept.length + body.tracks.length > MEET_MAX_TRACKS) return meetError(400, "too_many_tracks");
      const result = await sfu.publish(me.sfuSessionId, body.offer, body.tracks.map(({ mid, trackName }) => ({ mid, trackName })));
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
    const failed = new Set(result.tracks.filter((t) => t.errorCode && t.errorCode !== "close_track_error").map((t) => t.mid));
    const closed = new Set(body.mids.filter((m) => !failed.has(m)));
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
  if (!sameOrigin(req)) return meetError(403, "cross_origin_refused");
  const code = parseMeetCode(rawCode);
  if (!code) return meetError(404, "room_not_found");
  const limited = meetRateLimited(req, code, "leave");
  if (limited) return limited;
  try {
    const now = deps.now();
    const auth = await requireMeetParticipant(deps.db, req, code, now.getTime());
    // Leaving a room that ended, or leaving twice, is already done.
    if (!auth.ok) return [401, 410].includes(auth.response.status) ? meetJson({ ok: true }) : auth.response;
    await leaveMeet(deps.db, auth.participant, now);
    const sfu = sfuIfConfigured(deps);
    if (sfu) await cutSession(sfu, auth.participant.sfuSessionId, "leave");
    const res = meetJson({ ok: true });
    const cookie = meetCookie(code, "");
    res.cookies.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
    return res;
  } catch (err) {
    return meetFailure(err, "leave");
  }
}

export async function handleHost(req: NextRequest, rawCode: string, deps: MeetDeps): Promise<NextResponse> {
  if (!sameOrigin(req)) return meetError(403, "cross_origin_refused");
  const code = parseMeetCode(rawCode);
  if (!code) return meetError(404, "room_not_found");
  const limited = meetRateLimited(req, code, "action");
  if (limited) return limited;
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
      const sfu = sfuIfConfigured(deps);
      if (sfu) await cutSession(sfu, removed.sfuSessionId, "host.remove");
      return meetJson({ ok: true, removed: removed.id });
    }

    const endedNow = await endMeetRoom(deps.db, room, "host_ended", now);
    await cutRoom(deps, room);
    return meetJson({ ok: true, ended: true, alreadyEnded: !endedNow });
  } catch (err) {
    return meetFailure(err, "host");
  }
}
