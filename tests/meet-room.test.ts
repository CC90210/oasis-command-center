/**
 * Oasis Meet's room API (lib/meet/handlers.ts): every route run for real against a throwaway libSQL file with
 * migration bravo__230, a stand-in Cloudflare Realtime SFU that records each call, and stand-in sessions.
 *
 * What it holds the routes to (e9's review of the plan, 2026-10-17):
 *  - a guest needs a name and, in a recorded room, the recording tick; the cookie is HttpOnly and scoped to the
 *    room's API path; nobody's workspace, host id or SFU session leaves the server;
 *  - the participant cap is one statement; a guest's media waits for a host;
 *  - a pull names only what someone else in THIS room publishes now;
 *  - leave, remove and end cut media at the SFU (every track on the session, sent and received), not just tokens;
 *  - a live room whose host has gone for 10 minutes ends itself; nothing runs without its secrets.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-room.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";
import { publicAppBaseUrl } from "../lib/api-helpers";
import { MEET_COOKIE, MEET_TOKEN_SECRET_ENV, MeetNotConfiguredError } from "../lib/meet/access";
import { parseHost, parseSfu } from "../lib/meet/bodies";
import { deleteMeetRoom, handleCreateRoom, handleHost, handleJoin, handleLeave, handleListRooms, handleSfu, handleState, meetMediaReady, type MeetDeps, type MeetSession } from "../lib/meet/handlers";
import { meetGuestFirstName } from "../lib/meet/guest-name";
import { meetRoomUrl } from "../lib/meet/links";
import {
  MEET_CUT_RETRY_MS,
  MEET_HOST_GRACE_MS,
  MEET_IDLE_MS,
  MEET_MAX_PARTICIPANTS,
  MEET_STALE_MS,
  endAbandonedRooms,
  endMeetRoom,
  forgetSession,
  holdSession,
  pendingCuts,
} from "../lib/meet/participants";
import { createMeetRoom, displayMeetCode, readMeetRoomByCode, rescheduleMeetRoom } from "../lib/meet/rooms";
import { SfuError, type SfuClient } from "../lib/meet/sfu";

let failures = 0;
let finished = false;
// A promise that never settles lets Node exit 0 mid-suite: that is a failure, never a pass (as tests/meet-recorder.test.ts).
process.on("beforeExit", () => {
  if (!finished) {
    console.log("meet room: exited before every check finished");
    process.exitCode = 1;
  }
});
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const ROOT = join(__dirname, "..");
const ORIGIN = "https://oasisai.work";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
const CC = "11111111-0000-4000-8000-000000000001";
const ADON = "11111111-0000-4000-8000-000000000002";
const REP = "11111111-0000-4000-8000-000000000003";
let clock = Date.parse("2026-10-17T16:00:00.000Z");
let ipSeq = 0;
const freshIp = () => `198.51.100.${(ipSeq += 1) % 250}`;

type Json = Record<string, unknown>;

function request(path: string, opts: { method?: string; body?: unknown; cookie?: string; ip?: string; origin?: string | null } = {}) {
  // Off Cloudflare and Vercel, lib/api-helpers.ts reads the caller's address from x-forwarded-for.
  const headers: Record<string, string> = { host: "oasisai.work", "x-forwarded-for": opts.ip ?? "203.0.113.10" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = `${MEET_COOKIE}=${opts.cookie}`;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/**
 * A stand-in SFU: sessions and their tracks in memory, every call recorded. `down` holds sessions it cannot be
 * asked about (a 500), `gone` the ones it no longer has (a 404), `disconnected` the ones whose browser has gone (a
 * 410, as the live SFU answers it); reading a session takes a moment, and `widest` is the most reads that were in
 * flight at once.
 */
function fakeSfu() {
  const calls: Array<{ op: string; sessionId: string; mids?: string[]; tracks?: unknown }> = [];
  const sessions = new Map<string, Array<{ mid: string; location: string; trackName: string; status: string }>>();
  const down = new Set<string>();
  const gone = new Set<string>();
  const disconnected = new Set<string>();
  /** Run while a pull or publish is on its way: after the SFU has the request, before it adds the track. */
  const hooks: { duringPull?: () => Promise<unknown>; duringPublish?: () => Promise<unknown> } = {};
  let reading = 0;
  let widest = 0;
  let n = 0;
  const client: SfuClient = {
    async newSession() {
      const id = `sess-${(n += 1)}`;
      sessions.set(id, []);
      calls.push({ op: "new", sessionId: id });
      return id;
    },
    async publish(sessionId, _offer, tracks) {
      calls.push({ op: "publish", sessionId, tracks });
      if (hooks.duringPublish) await hooks.duringPublish();
      const list = sessions.get(sessionId)!;
      for (const t of tracks) list.push({ mid: t.mid, location: "local", trackName: t.trackName, status: "active" });
      return {
        requiresImmediateRenegotiation: false,
        sessionDescription: { type: "answer", sdp: "v=0 answer" },
        tracks: tracks.map((t) => (t.trackName === "refused" ? { trackName: t.trackName, mid: t.mid, errorCode: "invalid_track" } : { trackName: t.trackName, mid: t.mid })),
      };
    },
    async pull(sessionId, tracks) {
      calls.push({ op: "pull", sessionId, tracks });
      if (hooks.duringPull) await hooks.duringPull();
      const list = sessions.get(sessionId)!;
      const out = tracks.map((t, i) => ({ location: "remote" as const, sessionId: t.sessionId, trackName: t.trackName, mid: `r${list.length + i}` }));
      for (const o of out) list.push({ mid: o.mid, location: "remote", trackName: o.trackName, status: "active" });
      return { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "v=0 offer" }, tracks: out };
    },
    async renegotiate(sessionId) {
      calls.push({ op: "renegotiate", sessionId });
    },
    async close(sessionId, mids, offer) {
      calls.push({ op: offer ? "close" : "force-close", sessionId, mids });
      for (const t of sessions.get(sessionId) ?? []) if (mids.includes(t.mid)) t.status = "inactive";
      return { sessionDescription: offer ? { type: "answer", sdp: "v=0 closed" } : null, tracks: mids.map((mid) => ({ mid })) };
    },
    async sessionTracks(sessionId) {
      calls.push({ op: "tracks", sessionId });
      reading += 1;
      widest = Math.max(widest, reading);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (down.has(sessionId)) throw new SfuError("sfu_http_500", "the SFU answered 500", 500);
        if (gone.has(sessionId)) throw new SfuError("session_not_found", "no such session", 404);
        if (disconnected.has(sessionId)) {
          throw new SfuError("session_error", "Session appears to be disconnected. Please check if the PeerConnection is connected.", 410);
        }
        return (sessions.get(sessionId) ?? []).map((t) => ({ ...t }));
      } finally {
        reading -= 1;
      }
    },
  };
  return {
    client, calls, sessions, down, gone, disconnected, hooks,
    widest: () => widest,
    resetWidest: () => {
      widest = 0;
    },
  };
}

async function main() {
  console.log("meet room:");
  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "meet-room-")), "test.db")}` });
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__230_meet_rooms.sql"), "utf8"));
  process.env[MEET_TOKEN_SECRET_ENV] = "a-test-only-secret-that-is-long-enough-1234";
  const sfu = fakeSfu();
  const signedOut = async (): Promise<MeetSession> => ({ ok: false });
  const as = (userId: string, isTrueAdmin = false, tenantId = OASIS) => async (): Promise<MeetSession> => ({ ok: true, tenantId, userId, isTrueAdmin, email: "cc@oasisai.work" });
  const scheduled: Array<{ owner: { tenantId: string; userId: string }; startsAt: string | null; timeZone: string; minutes?: number }> = [];
  const unscheduled: Array<{ owner: { tenantId: string; userId: string }; eventId: string }> = [];
  // An OASIS workspace with recording installed, unless a check says otherwise.
  const recording: MeetDeps["recording"] = {
    available: async () => true,
    served: () => true,
    remove: async () => ({ relayRemaining: 0 }),
  };
  const deps = (over: Partial<MeetDeps> = {}): MeetDeps => ({
    db,
    sfu: () => sfu.client,
    session: signedOut,
    ice: async () => [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    schedule: async (owner, room, opts) => {
      scheduled.push({ owner, startsAt: room.startsAt, timeZone: opts.timeZone, minutes: opts.minutes });
      return { ok: true, eventId: `evt-${scheduled.length}` };
    },
    unschedule: async (owner, eventId) => {
      unscheduled.push({ owner, eventId });
    },
    recording,
    later: async (_label, work) => {
      background.push(work());
    },
    now: () => new Date(clock),
    ...over,
  });
  // What the routes leave to run after their answer (deps.later), awaited by the checks that read its effect.
  const background: Array<Promise<unknown>> = [];
  const settle = async () => {
    while (background.length) await Promise.allSettled(background.splice(0));
  };
  const heldSession = async (participantId: string) =>
    (await db.execute({ sql: "SELECT sfu_session_id AS s FROM meet_participants WHERE id = ?", args: [participantId] })).rows[0]?.s ?? null;
  /** Let time pass while these people keep polling, once a minute (inside MEET_STALE_MS, so they stay in the room). */
  const passWhilePolling = async (ms: number, polls: Array<() => Promise<Response>>) => {
    for (let left = ms; left > 0; left -= 60_000) {
      clock += Math.min(60_000, left);
      for (const poll of polls) await poll();
    }
  };
  const json = async (res: Response) => (await res.json()) as Json;
  const cookieOf = (res: Response) => (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(MEET_COOKIE)?.value;

  // the host makes a room
  let code = "";
  await check("the Schedule panel: signed in only, same-origin only, and it makes a room in the host's own workspace", async () => {
    assert.equal((await handleCreateRoom(request("/api/calendar/meet", { body: {} }), deps())).status, 401);
    assert.equal((await handleCreateRoom(request("/api/calendar/meet", { body: {}, origin: "https://evil.example" }), deps({ session: as(CC) }))).status, 403);
    assert.equal((await handleCreateRoom(request("/api/calendar/meet", { body: { title: 1 } }), deps({ session: as(CC) }))).status, 400);
    assert.equal((await handleCreateRoom(request("/api/calendar/meet", { body: { extra: true } }), deps({ session: as(CC) }))).status, 400, "an unknown key is refused");
    const res = await handleCreateRoom(request("/api/calendar/meet", { body: { title: "Discovery call" } }), deps({ session: as(CC) }));
    assert.equal(res.status, 201);
    const room = (await json(res)).room as Json;
    assert.equal(room.title, "Discovery call");
    assert.equal(room.recordAudio, true);
    assert.match(String(room.link), /^\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    assert.equal(room.url, `${publicAppBaseUrl().replace(/\/+$/, "")}${room.link}`, "the whole link comes from the app's canonical address, not the request's host");
    assert.ok(!("tenantId" in room) && !("hostUserId" in room), "the room view never carries its workspace or host id");
    code = String(room.code);
    await handleCreateRoom(request("/api/calendar/meet", { body: { title: "Theirs" } }), deps({ session: as(REP, false, OTHER) }));
    await handleCreateRoom(request("/api/calendar/meet", { body: { title: "Rep's own" } }), deps({ session: as(REP) }));
    const list = (await json(await handleListRooms(deps({ session: as(ADON, true) })))).rooms as Json[];
    assert.ok(
      list.some((r) => r.code === code) && list.some((r) => r.title === "Rep's own") && !list.some((r) => r.title === "Theirs"),
      "an owner or admin, who hosts every meeting in the workspace, sees them all, and only the workspace's own",
    );
    assert.equal(list.find((r) => r.code === code)?.mine, false, "Adon sees CC's room as not his own");
    assert.equal(list.find((r) => r.code === code)?.url, room.url, "the list carries the same whole link");
    const reps = (await json(await handleListRooms(deps({ session: as(REP) })))).rooms as Json[];
    assert.deepEqual(reps.map((r) => r.title), ["Rep's own"], "a member who is not an admin sees only the meetings they made");
    assert.equal((await json(await handleListRooms(deps({ session: as(CC) })))).mediaReady, true, "the video service is set up");
    const noApp = deps({ session: as(CC), sfu: () => { throw new MeetNotConfiguredError("no app"); } });
    assert.equal((await json(await handleListRooms(noApp))).mediaReady, false, "until it is, the panel says so and offers no meeting to make");
    const refused = await handleCreateRoom(request("/api/calendar/meet", { body: { title: "Too soon" } }), noApp);
    assert.equal(refused.status, 503);
    assert.equal((await json(refused)).error, "meet_not_configured", "and the server makes none: no link goes out that fails when it is opened");
  });

  await check("the room page may use the camera and microphone; every other page still may not", async () => {
    // next.config.js headers(): the later matching rule wins for the same key (Next.js; OpenNext keeps the order).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../next.config.js") as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const rules = await config.headers();
    const policy = (source: string) => rules.findIndex((r) => r.source === source && r.headers.some((h) => h.key === "Permissions-Policy"));
    const valueOf = (i: number) => rules[i].headers.find((h) => h.key === "Permissions-Policy")!.value;
    const everywhere = policy("/:path*");
    const meet = policy("/meet/:path*");
    assert.ok(everywhere >= 0 && meet > everywhere, "the /meet rule comes after the site-wide one, so it wins on /meet");
    assert.equal(valueOf(everywhere), "camera=(), microphone=(), geolocation=(self), payment=()", "every other page: exactly the policy it had");
    assert.equal(valueOf(meet), "camera=(self), microphone=(self), geolocation=(self), payment=()", "the room page: camera and microphone, every other restriction kept");
  });

  await check("a meeting made for later goes on the host's Schedule, in their time zone; the link works even when it cannot", async () => {
    const make = async (body: Record<string, unknown>, over: Partial<MeetDeps> = {}) =>
      json(await handleCreateRoom(request("/api/calendar/meet", { body }), deps({ session: as(CC), ...over })));
    const before = scheduled.length;
    const later = await make({ title: "Follow-up", startsAt: "2026-10-21T14:00:00-04:00", timeZone: "America/Toronto", minutes: 45 });
    assert.deepEqual(later.schedule, { added: true });
    assert.deepEqual(scheduled.at(-1), { owner: { tenantId: OASIS, userId: CC }, startsAt: "2026-10-21T18:00:00.000Z", timeZone: "America/Toronto", minutes: 45 });
    const row = await readMeetRoomByCode(db, String((later.room as Json).code).replace(/-/g, ""));
    assert.equal(row?.calendarEventId, `evt-${scheduled.length}`, "the room remembers its Schedule event");
    const shabbat = await make({ startsAt: "2026-10-24T16:00:00Z", timeZone: "America/Toronto" }, { schedule: async () => ({ ok: false, reason: "shabbat_protected" }) });
    assert.deepEqual(shabbat.schedule, { added: false, reason: "shabbat_protected" }, "the Schedule's own code, which the panel words with its messageFor");
    assert.ok((shabbat.room as Json).link, "the link is made either way");
    const noZone = await make({ startsAt: "2026-10-21T18:00:00Z" });
    assert.deepEqual(noZone.schedule, { added: false, reason: "time_zone_invalid" });
    const errors = console.error;
    console.error = () => {}; // the fault this causes on purpose is logged
    const unreachable = await make({ startsAt: "2026-10-22T18:00:00Z", timeZone: "America/Toronto" }, { schedule: async () => { throw new TypeError("network down"); } }).finally(() => {
      console.error = errors;
    });
    assert.deepEqual(unreachable.schedule, { added: false, reason: "schedule_unavailable" }, "a Schedule that cannot be reached never turns a made meeting into a failure (a retry would make a second one)");
    assert.ok((unreachable.room as Json).link);
    const now = await make({});
    assert.equal(now.schedule, undefined, "Start now has no time, so nothing goes on the Schedule");
    assert.equal(scheduled.length, before + 1, "the Schedule was asked once: for the meeting with a time and a zone");
    assert.equal((await handleCreateRoom(request("/api/calendar/meet", { body: { minutes: 5 } }), deps({ session: as(CC) }))).status, 400, "a length outside 15-480 minutes is refused");
  });

  // people join
  let guestCookie = "";
  let guestId = "";
  let hostCookie = "";
  let hostId = "";
  await check("a guest gives a name and, in a recorded room, ticks the notice; the cookie is HttpOnly and scoped to the room's API", async () => {
    const path = `/api/meet/${code}/join`;
    assert.equal((await handleJoin(request(path, { body: { consent: true }, ip: freshIp() }), code, deps())).status, 400, "no name");
    assert.equal(
      (await json(await handleJoin(request(path, { body: { consent: true }, ip: freshIp() }), code, deps({ session: as(REP, false, OTHER) })))).error,
      "name_required",
      "a signed-in visitor from another workspace types a name: their email never shows the room",
    );
    assert.equal(
      (await json(await handleJoin(request(path, { body: { name: "Same id" }, ip: freshIp() }), code, deps({ session: as(CC, false, OTHER) })))).error,
      "consent_required",
      "the creator's user id signed in to ANOTHER workspace is not the creator: they tick the notice like any guest",
    );
    assert.equal(((await json(await handleJoin(request(path, { body: { name: "Jane" }, ip: freshIp() }), code, deps()))).error), "consent_required");
    assert.equal((await handleJoin(request(path, { body: { name: "Jane", consent: true }, origin: "https://evil.example" }), code, deps())).status, 403);
    assert.equal((await handleJoin(request("/api/meet/abc-defg-hjk/join", { body: { name: "Jane", consent: true }, ip: freshIp() }), "abc-defg-hjk", deps())).status, 404);
    const res = await handleJoin(request(path, { body: { name: "  Jane  Doe ", consent: true }, ip: freshIp() }), code, deps());
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.role, "guest");
    assert.equal(body.name, "Jane Doe");
    assert.ok(Array.isArray(body.iceServers));
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=lax/i);
    assert.match(setCookie, new RegExp(`Path=/api/meet/${code}`));
    guestCookie = cookieOf(res)!;
    guestId = String(body.participantId);
    assert.ok(guestCookie && guestId);
  });

  await check("a refresh is the same participant, not a second one", async () => {
    const res = await handleJoin(request(`/api/meet/${code}/join`, { body: { name: "Jane", consent: true }, cookie: guestCookie, ip: freshIp() }), code, deps());
    assert.equal((await json(res)).participantId, guestId);
  });

  await check("a guest's media waits for a host; the host's join opens the room", async () => {
    const waiting = await handleSfu(request(`/api/meet/${code}/sfu`, { body: { action: "session" }, cookie: guestCookie, ip: freshIp() }), code, deps());
    assert.equal(waiting.status, 409);
    assert.equal((await json(waiting)).error, "waiting_for_host");
    const state = await json(await handleState(request(`/api/meet/${code}/state`, { method: "GET", cookie: guestCookie, ip: freshIp() }), code, deps()));
    assert.equal(state.hostPresent, false);
    assert.equal((state.room as Json).status, "scheduled");
    const res = await handleJoin(request(`/api/meet/${code}/join`, { body: {}, ip: freshIp() }), code, deps({ session: as(CC) }));
    const body = await json(res);
    assert.equal(body.role, "host", "the creator is host, and needs no tick or typed name");
    assert.equal(body.records, true, "the creator's browser records a recorded room");
    assert.equal((body.room as Json).status, "live");
    assert.equal(
      (await json(await handleJoin(request(`/api/meet/${code}/join`, { body: {}, ip: freshIp() }), code, deps({ session: as(ADON, true) })))).error,
      "consent_required",
      "a second host did not choose to record: they read and tick the notice like anyone else (Law 25)",
    );
    const admin = await json(await handleJoin(request(`/api/meet/${code}/join`, { body: { consent: true }, ip: freshIp() }), code, deps({ session: as(ADON, true) })));
    assert.equal(admin.role, "host");
    assert.equal(admin.records, false, "a second host never starts a second recording");
    hostCookie = cookieOf(res)!;
    hostId = String(body.participantId);
    const member = await json(await handleJoin(request(`/api/meet/${code}/join`, { body: { name: "Rep", consent: true }, ip: freshIp() }), code, deps({ session: as(REP) })));
    assert.equal(member.role, "guest", "a member who is not host or a base-role admin joins as a guest");
    assert.equal(member.records, false);
  });

  // the SFU, through the room's checks
  const sfuCall = (cookie: string, body: unknown) => handleSfu(request(`/api/meet/${code}/sfu`, { body, cookie, ip: freshIp() }), code, deps());
  const offer = { type: "offer", sdp: "v=0 offer" };
  await check("publish: a session first, then up to three named tracks; a track the SFU refuses is not offered to the room", async () => {
    assert.equal((await sfuCall(hostCookie, { action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }] })).status, 409, "no session yet");
    assert.equal((await sfuCall(hostCookie, { action: "session" })).status, 200);
    assert.equal((await sfuCall(guestCookie, { action: "session" })).status, 200, "the host is here, so the guest connects");
    const res = await sfuCall(hostCookie, { action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }, { mid: "1", trackName: "refused", kind: "video" }] });
    const body = await json(res);
    assert.equal((body.sessionDescription as Json).type, "answer");
    const state = await json(await handleState(request(`/api/meet/${code}/state`, { method: "GET", cookie: guestCookie, ip: freshIp() }), code, deps()));
    const host = (state.participants as Json[]).find((p) => p.id === hostId)!;
    assert.deepEqual(host.tracks, [{ trackName: "mic", kind: "audio" }], "only the accepted track, and no mid or session id");
    assert.ok(!JSON.stringify(state).includes("sess-"), "no SFU session id reaches a browser");
    assert.equal(state.hostPresent, true);
    const tooMany = await sfuCall(hostCookie, { action: "publish", offer, tracks: [{ mid: "2", trackName: "cam", kind: "video" }, { mid: "3", trackName: "screen", kind: "video" }, { mid: "4", trackName: "more", kind: "video" }] });
    assert.equal(tooMany.status, 400);
  });

  await check("pull: only what someone else in this room publishes now, by participant, and their session stays on the server", async () => {
    assert.equal((await sfuCall(guestCookie, { action: "pull", tracks: [{ participantId: hostId, trackName: "cam" }] })).status, 404, "not published");
    assert.equal((await sfuCall(hostCookie, { action: "pull", tracks: [{ participantId: hostId, trackName: "mic" }] })).status, 404, "your own track");
    assert.equal((await sfuCall(guestCookie, { action: "pull", tracks: [{ participantId: "someone-elsewhere", trackName: "mic" }] })).status, 404, "nobody in this room");
    const res = await sfuCall(guestCookie, { action: "pull", tracks: [{ participantId: hostId, trackName: "mic" }] });
    const body = await json(res);
    assert.equal(body.requiresImmediateRenegotiation, true);
    assert.deepEqual(body.tracks, [{ participantId: hostId, trackName: "mic", mid: "r0", errorCode: null }]);
    const pull = sfu.calls.filter((c) => c.op === "pull").at(-1)!;
    const hostSession = sfu.calls.find((c) => c.op === "publish")!.sessionId;
    assert.deepEqual(pull.tracks, [{ sessionId: hostSession, trackName: "mic" }], "the server put in the host's own session");
    assert.ok(!JSON.stringify(body).includes("sess-"));
    assert.equal((await sfuCall(guestCookie, { action: "renegotiate", answer: { type: "answer", sdp: "v=0 a" } })).status, 200);
  });

  await check("close: the caller's tracks stop being offered to the room", async () => {
    await sfuCall(hostCookie, { action: "publish", offer, tracks: [{ mid: "5", trackName: "screen", kind: "video" }] });
    const res = await sfuCall(hostCookie, { action: "close", mids: ["5"], offer });
    assert.equal(res.status, 200);
    const state = await json(await handleState(request(`/api/meet/${code}/state`, { method: "GET", cookie: guestCookie, ip: freshIp() }), code, deps()));
    const host = (state.participants as Json[]).find((p) => p.id === hostId)!;
    assert.deepEqual((host.tracks as Json[]).map((t) => t.trackName), ["mic"]);
  });

  await check("bodies are strict: unknown keys, wrong types and outsized lists are refused", async () => {
    assert.equal(parseSfu({ action: "session", extra: 1 }), null);
    assert.equal(parseSfu({ action: "publish", offer: { type: "answer", sdp: "x" }, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }] }), null, "an answer is not an offer");
    assert.equal(parseSfu({ action: "publish", offer, tracks: [{ mid: "0", trackName: "Mic Track", kind: "audio" }] }), null, "a track name is plain");
    assert.equal(parseSfu({ action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }, { mid: "1", trackName: "mic", kind: "audio" }] }), null, "one name once");
    assert.equal(parseSfu({ action: "pull", tracks: Array.from({ length: 25 }, () => ({ participantId: "p", trackName: "mic" })) }), null);
    assert.equal(parseSfu({ action: "close", mids: [] }), null);
    assert.equal((await sfuCall(guestCookie, { action: "nope" })).status, 400);
  });

  // leaving, removal and the end cut media at the SFU
  await check("a host removes a guest: their token stops at once and every track on their session is closed at the SFU", async () => {
    const guestSession = sfu.calls.filter((c) => c.op === "new")[1].sessionId;
    const before = sfu.calls.length;
    assert.equal((await handleHost(request(`/api/meet/${code}/host`, { body: { action: "remove", participantId: guestId }, ip: freshIp() }), code, deps({ session: as(REP) }))).status, 403, "only a host");
    assert.equal((await handleHost(request(`/api/meet/${code}/host`, { body: { action: "remove", participantId: hostId }, ip: freshIp() }), code, deps({ session: as(CC) }))).status, 400, "not yourself");
    const res = await handleHost(request(`/api/meet/${code}/host`, { body: { action: "remove", participantId: guestId }, ip: freshIp() }), code, deps({ session: as(CC) }));
    assert.equal(res.status, 200);
    assert.equal((await json(res)).mediaCut, true);
    assert.equal(await heldSession(guestId), null, "a cut that went through is forgotten");
    const cut = sfu.calls.slice(before).find((c) => c.op === "force-close" && c.sessionId === guestSession);
    assert.deepEqual(cut?.mids, ["r0"], "what the guest was receiving is closed too, by force");
    assert.ok(sfu.sessions.get(guestSession)!.every((t) => t.status === "inactive"));
    assert.equal((await handleState(request(`/api/meet/${code}/state`, { method: "GET", cookie: guestCookie, ip: freshIp() }), code, deps())).status, 403);
    assert.equal((await sfuCall(guestCookie, { action: "session" })).status, 403, "and no new session");
    assert.equal((await handleJoin(request(`/api/meet/${code}/join`, { body: { name: "Jane", consent: true }, cookie: guestCookie, ip: freshIp() }), code, deps())).status, 403, "the same browser cannot walk back in");
  });

  await check("leaving: the token stops, the session is cut, the cookie is cleared; leaving twice is fine", async () => {
    const res = await handleJoin(request(`/api/meet/${code}/join`, { body: { name: "Sam", consent: true }, ip: freshIp() }), code, deps());
    const cookie = cookieOf(res)!;
    await sfuCall(cookie, { action: "session" });
    const left = await handleLeave(request(`/api/meet/${code}/leave`, { cookie, ip: freshIp() }), code, deps());
    assert.equal(left.status, 200);
    assert.match(left.headers.get("set-cookie") ?? "", /Max-Age=0/i);
    assert.equal((await handleState(request(`/api/meet/${code}/state`, { method: "GET", cookie, ip: freshIp() }), code, deps())).status, 401);
    assert.equal((await handleLeave(request(`/api/meet/${code}/leave`, { cookie, ip: freshIp() }), code, deps())).status, 200);
  });

  await check("the room holds eight people at most, counted in the same statement as the join; guests can never fill it against its host", async () => {
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const full = String((r.room as Json).code);
    const statuses: number[] = [];
    for (let i = 0; i < MEET_MAX_PARTICIPANTS; i += 1) {
      statuses.push((await handleJoin(request(`/api/meet/${full}/join`, { body: { name: `P${i}` }, ip: freshIp() }), full, deps())).status);
    }
    assert.deepEqual(statuses, [...Array(MEET_MAX_PARTICIPANTS - 1).fill(200), 409], "guests hold seven places at most: a leaked link cannot fill the room");
    assert.equal((await handleJoin(request(`/api/meet/${full}/join`, { body: {}, ip: freshIp() }), full, deps({ session: as(CC) }))).status, 200, "so its host can always get in, and remove them");
    assert.equal((await handleJoin(request(`/api/meet/${full}/join`, { body: { consent: true }, ip: freshIp() }), full, deps({ session: as(ADON, true) }))).status, 409, "eight people in all");
    clock += MEET_STALE_MS + 1_000; // everyone stopped polling five minutes ago: they have left, and their places are free again
    assert.equal((await handleJoin(request(`/api/meet/${full}/join`, { body: { name: "Late" }, ip: freshIp() }), full, deps())).status, 200);

    // Eight in all counts hosts too: with a host in, a seventh guest fills the room; with two hosts in, it is full.
    const fill = async (hosts: Array<() => Promise<MeetSession>>, guests: number) => {
      const c = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })))).room as Json).code);
      for (const host of hosts) assert.equal((await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: host }))).status, 200);
      for (let i = 0; i < guests; i += 1) assert.equal((await handleJoin(request(`/api/meet/${c}/join`, { body: { name: `G${i}` }, ip: freshIp() }), c, deps())).status, 200);
      return (await handleJoin(request(`/api/meet/${c}/join`, { body: { name: "One more" }, ip: freshIp() }), c, deps())).status;
    };
    assert.equal(await fill([as(CC)], 6), 200, "one host and six guests: a seventh guest takes the last place");
    assert.equal(await fill([as(CC), as(ADON, true)], 6), 409, "two hosts and six guests: the room is full, guests or not");
  });

  await check("a place stays held while its person can still come back to it (silent under five minutes), so the room never goes over", async () => {
    const c = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })))).room as Json).code);
    const join = async (session: (() => Promise<MeetSession>) | null, name?: string) =>
      (await handleJoin(request(`/api/meet/${c}/join`, { body: name ? { name } : {}, ip: freshIp() }), c, deps(session ? { session } : {}))).status;
    for (let i = 0; i < MEET_MAX_PARTICIPANTS - 1; i += 1) assert.equal(await join(null, `G${i}`), 200);
    clock += 2 * 60_000; // their laptops slept for two minutes: off the People list, still able to come back
    assert.equal(await join(null, "Newcomer"), 409, "the seven guests' places are still theirs");
    assert.equal(await join(as(CC)), 200, "the host still gets the eighth");
    assert.equal(await join(as(ADON, true)), 409, "and nobody gets a ninth");
    clock += MEET_STALE_MS; // the guests have now been silent for seven minutes: they have left
    assert.equal(await join(null, "Newcomer"), 200, "a place its person left is free again");
  });

  await check("the host ends it: every session the room had is cut, and everyone gets 410", async () => {
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const c2 = String((r.room as Json).code);
    const host = await handleJoin(request(`/api/meet/${c2}/join`, { body: {}, ip: freshIp() }), c2, deps({ session: as(CC) }));
    const guest = await handleJoin(request(`/api/meet/${c2}/join`, { body: { name: "G" }, ip: freshIp() }), c2, deps());
    const call = (cookie: string, body: unknown) => handleSfu(request(`/api/meet/${c2}/sfu`, { body, cookie, ip: freshIp() }), c2, deps());
    await call(cookieOf(host)!, { action: "session" });
    await call(cookieOf(host)!, { action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }] });
    await call(cookieOf(guest)!, { action: "session" });
    const before = sfu.calls.length;
    sfu.resetWidest();
    const res = await handleHost(request(`/api/meet/${c2}/host`, { body: { action: "end" }, ip: freshIp() }), c2, deps({ session: as(ADON, true) }));
    assert.equal(res.status, 200, "an owner or admin by base role may end it");
    assert.equal((await json(res)).mediaCut, true);
    const cuts = sfu.calls.slice(before).filter((c) => c.op === "tracks").map((c) => c.sessionId);
    assert.equal(new Set(cuts).size, 2, "both sessions were read and cut");
    assert.equal(sfu.widest(), 2, "at once, not one after the other");
    assert.equal((await handleState(request(`/api/meet/${c2}/state`, { method: "GET", cookie: cookieOf(guest)!, ip: freshIp() }), c2, deps())).status, 410);
    assert.equal((await handleJoin(request(`/api/meet/${c2}/join`, { body: { name: "Late" }, ip: freshIp() }), c2, deps())).status, 410);
    assert.equal((await json(await handleHost(request(`/api/meet/${c2}/host`, { body: { action: "end" }, ip: freshIp() }), c2, deps({ session: as(CC) })))).alreadyEnded, true, "ending twice is fine");
  });

  await check("recording is offered only where it really happens, so a guest is never asked to agree to one nobody makes", async () => {
    const off: MeetDeps["recording"] = { ...recording, available: async () => false, served: () => false };
    assert.equal((await json(await handleListRooms(deps({ session: as(CC) })))).recordingAvailable, true);
    assert.equal((await json(await handleListRooms(deps({ session: as(CC), recording: off })))).recordingAvailable, false);
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: true } }), deps({ session: as(CC), recording: off })));
    assert.equal((r.room as Json).recordAudio, false, "asking to record where nothing records makes a room that does not");
    const c = String((r.room as Json).code);
    assert.equal((await handleJoin(request(`/api/meet/${c}/join`, { body: { name: "G" }, ip: freshIp() }), c, deps())).status, 200, "no notice to tick");
    // A room made while this workspace recorded, joined by its creator once it no longer does.
    const on = await json(await handleCreateRoom(request("/api/calendar/meet", { body: {} }), deps({ session: as(CC) })));
    const c2 = String((on.room as Json).code);
    const host = await json(await handleJoin(request(`/api/meet/${c2}/join`, { body: {}, ip: freshIp() }), c2, deps({ session: as(CC), recording: off })));
    assert.equal(host.records, false, "a browser is told to record only where recording is served");
  });

  const deleteMeeting = (c: string, session: () => Promise<MeetSession>, over: Partial<MeetDeps> = {}) =>
    handleHost(request(`/api/meet/${c}/host`, { body: { action: "delete" }, ip: freshIp() }), c, deps({ session, ...over }));
  const roomRows = async (roomId: string) =>
    Number((await db.execute({ sql: "SELECT (SELECT count(*) FROM meet_rooms WHERE id = ?) + (SELECT count(*) FROM meet_participants WHERE room_id = ?) AS n", args: [roomId, roomId] })).rows[0].n);

  await check("Delete meeting: a host only; a meeting still going is ended and its media cut; the recording goes before the rows", async () => {
    assert.deepEqual(parseHost({ action: "delete" }), { action: "delete" });
    assert.equal(parseHost({ action: "delete", participantId: "x" }), null, "nothing else rides along");
    const made = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { title: "To delete", startsAt: "2026-10-22T14:00:00-04:00", timeZone: "America/Toronto" } }), deps({ session: as(CC) })));
    const eventId = `evt-${scheduled.length}`;
    const c = String((made.room as Json).code);
    const roomId = String((made.room as Json).id);
    assert.equal((await deleteMeeting(c, signedOut)).status, 401);
    assert.equal((await deleteMeeting(c, as(REP))).status, 403, "a member who is not its host");
    const host = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) })))!;
    const guest = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: { name: "G", consent: true }, ip: freshIp() }), c, deps()))!;
    for (const cookie of [host, guest]) await handleSfu(request(`/api/meet/${c}/sfu`, { body: { action: "session" }, cookie, ip: freshIp() }), c, deps());
    const seen: Json[] = [];
    // A cut reads the session's tracks first (these two published nothing, so there is nothing more to close).
    const cutsSoFar = () => sfu.calls.slice(before).filter((x) => x.op === "tracks").length;
    const removing: MeetDeps["recording"] = {
      ...recording,
      remove: async (room, userId) => {
        seen.push({ userId, status: (await readMeetRoomByCode(db, room.code))?.status ?? null, rows: await roomRows(room.id), cuts: cutsSoFar() });
        return { relayRemaining: 3 };
      },
    };
    const rowsAtUnschedule: number[] = [];
    const unscheduling: MeetDeps["unschedule"] = async (owner, id) => {
      rowsAtUnschedule.push(await roomRows(roomId));
      unscheduled.push({ owner, eventId: id });
    };
    const before = sfu.calls.length;
    const unscheduledBefore = unscheduled.length;
    const res = await deleteMeeting(c, as(CC), { recording: removing, unschedule: unscheduling });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ok: true, deleted: true, relayRemaining: 3, mediaCut: true }, "what is still on the relay, so the panel can say so");
    assert.deepEqual(
      seen,
      [{ userId: CC, status: "ended", rows: 3, cuts: 2 }],
      "the recording was removed after both sessions were cut, while the room and its people's rows were all still there, the room already ended",
    );
    assert.deepEqual(rowsAtUnschedule, [3], "the Schedule entry comes off before the rows go");
    assert.deepEqual(unscheduled.slice(unscheduledBefore), [{ owner: { tenantId: OASIS, userId: CC }, eventId }], "its entry comes off the creator's Schedule");
    assert.equal(await roomRows(roomId), 0, "the room and everyone's row in it are gone");
    assert.equal((await handleState(request(`/api/meet/${c}/state`, { method: "GET", cookie: guest, ip: freshIp() }), c, deps())).status, 404, "the link is dead");
  });

  await check("Delete meeting: a recording that cannot be removed keeps the meeting; another host's delete leaves the creator's calendar alone", async () => {
    const made = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { startsAt: "2026-10-22T15:00:00-04:00", timeZone: "America/Toronto" } }), deps({ session: as(CC) })));
    const c = String((made.room as Json).code);
    const roomId = String((made.room as Json).id);
    const unscheduledBefore = unscheduled.length;
    const failing: MeetDeps["recording"] = { ...recording, remove: async () => { throw new Error("relay unreachable"); } };
    const errors = console.error;
    console.error = () => {}; // meetFailure logs the fault this check causes on purpose
    let res: Response;
    try {
      res = await deleteMeeting(c, as(CC), { recording: failing });
    } finally {
      console.error = errors;
    }
    assert.equal(res.status, 500);
    assert.equal(await roomRows(roomId), 1, "the meeting is kept, so its recording is never orphaned by a half-done delete");
    assert.equal(unscheduled.length, unscheduledBefore, "and so is its Schedule entry");
    const removedBy: string[] = [];
    const nothingInstalled: MeetDeps["recording"] = { ...recording, remove: async (_room, userId) => { removedBy.push(userId); return null; } };
    assert.deepEqual(await json(await deleteMeeting(c, as(ADON, true), { recording: nothingInstalled })), { ok: true, deleted: true, relayRemaining: 0, mediaCut: true });
    assert.deepEqual(removedBy, [ADON], "an owner or admin by base role may delete it");
    assert.equal(unscheduled.length, unscheduledBefore, "the creator's calendar is theirs: another host's delete never writes to it");
    assert.equal(await roomRows(roomId), 0);
  });

  await check("a booking's room: made for the lead and the slot, moved with it, and deleted server-side when the booking is cancelled", async () => {
    const LEAD = "lead-0001";
    const startsAt = new Date(clock + 3 * 24 * 60 * 60_000).toISOString();
    const room = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "OASIS call with Jane", startsAt, leadId: LEAD });
    assert.deepEqual([room.status, room.leadId, room.startsAt, room.calendarEventId], ["scheduled", LEAD, startsAt, null], "its calendar entries belong to the booking");
    assert.equal(meetRoomUrl(room, "https://oasisai.work/"), `https://oasisai.work/meet/${displayMeetCode(room.code)}`, "the one link the invite, email and calendar file carry");
    assert.equal(meetMediaReady(deps()), true, "a booking asks the same question the panel does before it hands out a link");
    assert.equal(meetMediaReady({ sfu: () => { throw new MeetNotConfiguredError("no app"); } }), false, "and gives the lead a Google Meet link when calls cannot connect");
    // Moved: the same link, the new time.
    const later = new Date(Date.parse(startsAt) + 2 * 60 * 60_000).toISOString();
    assert.equal(await rescheduleMeetRoom(db, room, later), true);
    assert.equal((await readMeetRoomByCode(db, room.code))?.startsAt, later, "moved, the code unchanged");
    assert.equal(await rescheduleMeetRoom(db, room, "not a time"), false);
    // The host sees it is a booking, and Delete in the panel refuses it: the booking's cancel removes it with its invite.
    const listed = ((await json(await handleListRooms(deps({ session: as(CC) })))).rooms as Json[]).find((r) => r.code === displayMeetCode(room.code));
    assert.equal(listed?.leadId, LEAD, "the host's list says which lead booked it");
    const refused = await handleHost(request(`/api/meet/${displayMeetCode(room.code)}/host`, { body: { action: "delete" }, ip: freshIp() }), displayMeetCode(room.code), deps({ session: as(CC) }));
    assert.deepEqual([refused.status, (await json(refused)).error], [409, "booked_meeting"]);
    assert.ok(await readMeetRoomByCode(db, room.code), "and the room is kept");
    // The lead opens it early and waits; the booking is then cancelled, with no host signed in anywhere.
    const c = displayMeetCode(room.code);
    const lead = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: { name: "Jane", consent: true }, ip: freshIp() }), c, deps()))!;
    const unscheduledBefore = unscheduled.length;
    const out = await deleteMeetRoom(deps(), (await readMeetRoomByCode(db, room.code))!, CC, new Date(clock));
    assert.deepEqual(out, { relayRemaining: 0, mediaCut: true });
    assert.equal(unscheduled.length, unscheduledBefore, "no Schedule entry of Meet's to take off: the booking removes its own");
    assert.equal(await roomRows(room.id), 0, "the room and the lead's row are gone");
    assert.equal((await handleState(request(`/api/meet/${c}/state`, { method: "GET", cookie: lead, ip: freshIp() }), c, deps())).status, 404, "the link is dead");
    // An ended room is not moved: the booking makes a new one.
    const held = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, startsAt, leadId: LEAD });
    await endMeetRoom(db, held, "host_ended", new Date(clock));
    assert.equal(await rescheduleMeetRoom(db, held, later), false, "a meeting that is over keeps its time");
  });

  await check("a booked meeting's room page greets its lead by first name, from their own record in the room's workspace only", async () => {
    await db.execute("CREATE TABLE IF NOT EXISTS tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT)");
    const lead = async (id: string, tenantId: string, data: unknown, entityType = "lead") =>
      db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)", args: [id, tenantId, entityType, typeof data === "string" ? data : JSON.stringify(data)] });
    await lead("lead-jane", OASIS, { contact_name: "jane doe", business_name: "Acme Roofing", email: "jane@example.com" });
    await lead("lead-biz", OASIS, { name: "Acme Roofing", company: "Acme Roofing" });
    await lead("lead-alias", OASIS, { owner_full_name: "Marc Tremblay" });
    await lead("lead-elsewhere", OTHER, { contact_name: "Someone Else" });
    await lead("lead-broken", OASIS, "{not json");
    await lead("not-a-lead", OASIS, { contact_name: "Client Person" }, "client");
    const greet = (leadId: string | null) => meetGuestFirstName(db, { tenantId: OASIS, leadId });
    assert.equal(await greet("lead-jane"), "Jane", "the first name only, as the CRM's emails write it");
    assert.equal(await greet("lead-alias"), "Marc", "by every name field the forms write");
    assert.equal(await greet("lead-biz"), null, "a contact name that is really the company is not a name");
    assert.equal(await greet("lead-elsewhere"), null, "another workspace's lead is never read");
    assert.equal(await greet("not-a-lead"), null, "only a lead record");
    assert.equal(await greet(null), null, "a room no lead booked");
    assert.equal(await greet("nobody"), null);
    const errors = console.error;
    console.error = () => {}; // the unreadable record is logged on purpose
    try {
      assert.equal(await greet("lead-broken"), null, "an unreadable record leaves the field empty, never keeps anyone out");
    } finally {
      console.error = errors;
    }
  });

  await check("a live room whose host has been gone ten minutes ends itself", async () => {
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const c3 = String((r.room as Json).code);
    await handleJoin(request(`/api/meet/${c3}/join`, { body: {}, ip: freshIp() }), c3, deps({ session: as(CC) }));
    const guest = cookieOf(await handleJoin(request(`/api/meet/${c3}/join`, { body: { name: "G" }, ip: freshIp() }), c3, deps()))!;
    const poll = () => handleState(request(`/api/meet/${c3}/state`, { method: "GET", cookie: guest, ip: freshIp() }), c3, deps());
    await passWhilePolling(MEET_HOST_GRACE_MS - 60_000, [poll]);
    assert.equal((await poll()).status, 200, "nine minutes: still waiting for the host");
    await passWhilePolling(120_000, [poll]);
    assert.equal((await poll()).status, 410);
    const room = await readMeetRoomByCode(db, c3.replace(/-/g, ""));
    assert.equal(room?.endedReason, "host_left");
  });

  // Media is cut at the SFU, and a cut that fails is never lost.
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const errors = console.error;
    console.error = () => {}; // the SFU faults these checks cause on purpose are logged
    try {
      return await fn();
    } finally {
      console.error = errors;
    }
  };
  /** A room with its creator in it and `guests` guests, each with an SFU session. */
  const callWith = async (guests: number, body: Record<string, unknown> = { recordAudio: false }) => {
    const made = await json(await handleCreateRoom(request("/api/calendar/meet", { body }), deps({ session: as(CC) })));
    const c = String((made.room as Json).code);
    const enter = async (join: Response) => ({ cookie: cookieOf(join)!, id: String((await json(join)).participantId) });
    const people = [await enter(await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) })))];
    for (let i = 0; i < guests; i += 1) {
      people.push(await enter(await handleJoin(request(`/api/meet/${c}/join`, { body: { name: `G${i}`, consent: true }, ip: freshIp() }), c, deps())));
    }
    for (const p of people) await handleSfu(request(`/api/meet/${c}/sfu`, { body: { action: "session" }, cookie: p.cookie, ip: freshIp() }), c, deps());
    const sessions = await Promise.all(people.map(async (p) => String(await heldSession(p.id))));
    return { c, roomId: String((made.room as Json).id), host: people[0], guests: people.slice(1), sessions };
  };
  const reads = (sessionId: string) => sfu.calls.filter((x) => x.op === "tracks" && x.sessionId === sessionId).length;

  await check("a removed guest whose cut failed is cut again from the room's next polls, at most every 30 seconds; a session the SFU no longer has counts as cut", async () => {
    const call = await callWith(2);
    const [guest, other] = call.guests;
    const session = call.sessions[1];
    sfu.down.add(session);
    const removed = await quietly(async () =>
      json(await handleHost(request(`/api/meet/${call.c}/host`, { body: { action: "remove", participantId: guest.id }, ip: freshIp() }), call.c, deps({ session: as(CC) }))),
    );
    assert.equal(removed.mediaCut, false, "the host is told the cut did not go through");
    assert.equal(await heldSession(guest.id), session, "the row keeps the session until a cut does");
    const poll = () => handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: call.host.cookie, ip: freshIp() }), call.c, deps());
    const tried = reads(session);
    await quietly(async () => {
      assert.equal((await poll()).status, 200);
      await settle();
    });
    assert.equal(reads(session), tried + 1, "the host's poll tried again, after its answer");
    await poll();
    await settle();
    assert.equal(reads(session), tried + 1, "and not again within 30 seconds, so an SFU that is down costs one try per half minute");
    sfu.down.delete(session);
    clock += 31_000;
    await poll();
    await settle();
    assert.equal(await heldSession(guest.id), null, "cut at last, and forgotten");
    sfu.gone.add(call.sessions[2]);
    await handleLeave(request(`/api/meet/${call.c}/leave`, { cookie: other.cookie, ip: freshIp() }), call.c, deps());
    assert.equal(await heldSession(other.id), null, "a session the SFU no longer has carries no media: done at once");
  });

  await check("a cut that failed is tried again for an hour after the person was removed, then let go", async () => {
    const call = await callWith(1);
    sfu.down.add(call.sessions[1]);
    await quietly(() => handleHost(request(`/api/meet/${call.c}/host`, { body: { action: "remove", participantId: call.guests[0].id }, ip: freshIp() }), call.c, deps({ session: as(CC) })));
    const room = (await readMeetRoomByCode(db, call.c.replace(/-/g, "")))!;
    const minutes = (n: number) => new Date(clock + n * 60_000);
    assert.deepEqual((await pendingCuts(db, room, minutes(59))).map((h) => h.participantId), [call.guests[0].id], "within the hour it is tried again");
    assert.deepEqual(await pendingCuts(db, room, minutes(61)), [], "an hour on, its session is let go");
    assert.equal(MEET_CUT_RETRY_MS, 60 * 60_000);
    sfu.down.delete(call.sessions[1]);
  });

  await check("an end whose cut failed leaves the session for Delete, which cuts it whatever the status; an SFU that stays down never keeps a meeting from being deleted", async () => {
    const call = await callWith(1);
    sfu.down.add(call.sessions[1]);
    const ended = await quietly(async () => json(await handleHost(request(`/api/meet/${call.c}/host`, { body: { action: "end" }, ip: freshIp() }), call.c, deps({ session: as(CC) }))));
    assert.equal(ended.mediaCut, false);
    assert.equal(await heldSession(call.host.id), null, "the session that was cut is forgotten");
    assert.equal(await heldSession(call.guests[0].id), call.sessions[1], "the one that was not is kept");
    sfu.down.delete(call.sessions[1]);
    const tried = reads(call.sessions[1]);
    assert.deepEqual(await json(await deleteMeeting(call.c, as(CC))), { ok: true, deleted: true, relayRemaining: 0, mediaCut: true });
    assert.equal(reads(call.sessions[1]), tried + 1, "the delete cut what the end could not, although the room had ended");

    const stuck = await callWith(1);
    for (const s of stuck.sessions) sfu.down.add(s);
    assert.deepEqual(await quietly(async () => json(await deleteMeeting(stuck.c, as(CC)))), { ok: true, deleted: true, relayRemaining: 0, mediaCut: false });
    assert.equal(await roomRows(stuck.roomId), 0, "deleted all the same");

    const unset = await callWith(1);
    const noApp = { sfu: () => { throw new MeetNotConfiguredError("no app"); } };
    assert.deepEqual(await quietly(async () => json(await deleteMeeting(unset.c, as(CC), noApp))), { ok: true, deleted: true, relayRemaining: 0, mediaCut: true }, "no SFU app: nothing can be cut, and the meeting is deleted");
  });

  await check("a host who opens a meeting alone and leaves leaves it waiting: the first guest is never shown ended; a call its host then leaves ends ten minutes on", async () => {
    const made = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const c = String((made.room as Json).code);
    const joinAs = async (session?: () => Promise<MeetSession>, body: Record<string, unknown> = {}) => {
      const res = await handleJoin(request(`/api/meet/${c}/join`, { body, ip: freshIp() }), c, deps(session ? { session } : {}));
      return { cookie: cookieOf(res)!, id: String((await json(res)).participantId) };
    };
    const poll = (cookie: string) => handleState(request(`/api/meet/${c}/state`, { method: "GET", cookie, ip: freshIp() }), c, deps());
    const tested = await joinAs(as(CC));
    await handleLeave(request(`/api/meet/${c}/leave`, { cookie: tested.cookie, ip: freshIp() }), c, deps());
    clock += 30 * 60_000;
    const guest = await joinAs(undefined, { name: "Early" });
    const waiting = await poll(guest.cookie);
    assert.equal(waiting.status, 200, "half an hour after the host's test, the first guest waits for the host");
    assert.equal((await json(waiting)).hostPresent, false);
    const host = await joinAs(as(CC));
    await poll(host.cookie);
    for (const p of [host, guest]) await handleSfu(request(`/api/meet/${c}/sfu`, { body: { action: "session" }, cookie: p.cookie, ip: freshIp() }), c, deps());
    await poll(guest.cookie);
    const guestPolls = () => poll(guest.cookie);
    await passWhilePolling(MEET_HOST_GRACE_MS - 60_000, [guestPolls]); // the host's tab died; the guest waits on
    assert.equal((await poll(guest.cookie)).status, 200, "nine minutes on, still waiting for the host");
    await passWhilePolling(120_000, [guestPolls]);
    assert.equal((await poll(guest.cookie)).status, 410);
    assert.equal((await readMeetRoomByCode(db, c.replace(/-/g, "")))?.endedReason, "host_left");
    await settle();
    assert.deepEqual([await heldSession(host.id), await heldSession(guest.id)], [null, null], "and its media is cut, after the answer");
  });

  await check("a call left without its host that nobody polls ends when the list is read (or by the relay's sweep), and its media is cut; a room only its host has opened stays waiting", async () => {
    const lone = await callWith(0);
    await handleLeave(request(`/api/meet/${lone.c}/leave`, { cookie: lone.host.cookie, ip: freshIp() }), lone.c, deps());
    const abandoned = await callWith(1);
    const elsewhere = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(REP, false, OTHER) })));
    const e = String((elsewhere.room as Json).code);
    await handleJoin(request(`/api/meet/${e}/join`, { body: {}, ip: freshIp() }), e, deps({ session: as(REP, false, OTHER) }));
    await handleJoin(request(`/api/meet/${e}/join`, { body: { name: "Their guest" }, ip: freshIp() }), e, deps());
    clock += MEET_HOST_GRACE_MS + 60_000; // everyone's tab closed without a word
    const list = (await json(await handleListRooms(deps({ session: as(CC) })))).rooms as Json[];
    await settle();
    assert.equal(list.find((r) => r.code === abandoned.c)?.status, "ended", "the list never shows it live");
    assert.equal((await readMeetRoomByCode(db, abandoned.c.replace(/-/g, "")))?.endedReason, "host_left");
    assert.equal(await heldSession(abandoned.guests[0].id), null, "its media was cut, after the answer");
    assert.equal(list.find((r) => r.code === lone.c)?.status, "live", "nobody has used it yet: it waits for its meeting");
    assert.equal((await readMeetRoomByCode(db, e.replace(/-/g, "")))?.status, "live", "another workspace's rooms are its own list's business");
    const swept = await endAbandonedRooms(db, [OTHER, OASIS], new Date(clock));
    assert.deepEqual(swept.map((r) => r.tenantId), [OTHER], "the relay's sweep ends them for every workspace it is given");
  });

  await check("a call between two hosts, or a host and a guest, ends once its hosts are gone; one person in two tabs, or a guest who left before any host came, is not a call", async () => {
    const make = async () => String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })))).room as Json).code);
    const join = (c: string, session?: () => Promise<MeetSession>, body: Record<string, unknown> = {}) =>
      handleJoin(request(`/api/meet/${c}/join`, { body, ip: freshIp() }), c, deps(session ? { session } : {}));
    // CC and Adon are both owners, so both host every room: a call between just the two of them is still a call.
    const hosts = await make();
    await join(hosts, as(CC));
    await join(hosts, as(ADON, true));
    const twoTabs = await make();
    await join(twoTabs, as(CC));
    await join(twoTabs, as(CC));
    const early = await make();
    const left = cookieOf(await join(early, undefined, { name: "Too early" }))!;
    await handleLeave(request(`/api/meet/${early}/leave`, { cookie: left, ip: freshIp() }), early, deps());
    clock += 60_000;
    await join(early, as(CC));
    clock += MEET_HOST_GRACE_MS + 60_000; // every tab closed without a word
    const list = (await json(await handleListRooms(deps({ session: as(CC) })))).rooms as Json[];
    await settle();
    const status = (c: string) => list.find((r) => r.code === c)?.status;
    assert.equal(status(hosts), "ended", "two hosts in the room together were a call: it ends, and its recording is handed over");
    assert.equal(status(twoTabs), "live", "one person in two tabs is not a call: it waits for its meeting");
    assert.equal(status(early), "live", "nor a guest who had left before any host came");
  });

  await check("a reconnect replaces the session only once the old one is cut: until then the row keeps it, and the browser tries again", async () => {
    const call = await callWith(1);
    const [guest] = call.guests;
    const reconnect = () => handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "session" }, cookie: guest.cookie, ip: freshIp() }), call.c, deps());
    sfu.down.add(call.sessions[1]);
    assert.equal((await quietly(reconnect)).status, 502);
    assert.equal(await heldSession(guest.id), call.sessions[1], "the old session is still on the row, so it can still be cut");
    sfu.down.delete(call.sessions[1]);
    assert.equal((await reconnect()).status, 200);
    const next = await heldSession(guest.id);
    assert.ok(next && next !== call.sessions[1], "a new session, once the old one was cut");
  });

  await check("a session whose browser has gone (the SFU's 410) counts as cut: a reconnect after a dropped network goes through, and a Leave forgets it at once", async () => {
    // Reconnect: the network dropped, so the SFU calls the old session disconnected; the cut must not block the new one.
    const call = await callWith(1);
    const [guest] = call.guests;
    sfu.disconnected.add(call.sessions[1]);
    const res = await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "session" }, cookie: guest.cookie, ip: freshIp() }), call.c, deps());
    assert.equal(res.status, 200, "a dropped network reconnects, never 502 six times over");
    const next = await heldSession(guest.id);
    assert.ok(next && next !== call.sessions[1], "on a new session");
    // Leave: the page closed its connection before it told the room, so the room's cut meets a disconnected session.
    const other = await callWith(1);
    const [leaving] = other.guests;
    sfu.disconnected.add(other.sessions[1]);
    assert.equal((await handleLeave(request(`/api/meet/${other.c}/leave`, { cookie: leaving.cookie, ip: freshIp() }), other.c, deps())).status, 200);
    assert.equal(await heldSession(leaving.id), null, "forgotten at once: nothing left for the tidy-up or the relay sweep to retry");
    const room = (await readMeetRoomByCode(db, other.c.replace(/-/g, "")))!;
    assert.deepEqual(await pendingCuts(db, room, new Date(clock)), [], "no cut is pending");
  });

  await check("each person's session reaches the others only as a tag, and the tag changes when they reconnect", async () => {
    const call = await callWith(1);
    const tag = async () =>
      ((await json(await handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: call.host.cookie, ip: freshIp() }), call.c, deps()))).participants as Json[])
        .find((p) => p.id === call.guests[0].id)?.session;
    const first = await tag();
    assert.ok(typeof first === "string" && first.length > 0 && !call.sessions.some((s) => String(first).includes(s)), "a tag, never the session id");
    await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "session" }, cookie: call.guests[0].cookie, ip: freshIp() }), call.c, deps());
    assert.notEqual(await tag(), first, "a reconnect is a new tag, so the others pull what they publish anew");
  });

  await check("forgetting a cut session never clears the one a reconnect put in its place", async () => {
    const call = await callWith(1);
    const room = (await readMeetRoomByCode(db, call.c.replace(/-/g, "")))!;
    await forgetSession(db, room, { participantId: call.guests[0].id, sessionId: "an-older-session" });
    assert.equal(await heldSession(call.guests[0].id), call.sessions[1]);
    await holdSession(db, room, { participantId: call.guests[0].id, sessionId: "an-older-session" });
    assert.equal(await heldSession(call.guests[0].id), call.sessions[1], "nor does giving a failed cut's session back");
  });

  await check("silent for five minutes, a participant's own calls are refused and their old token makes a new place, before anything has tidied the room", async () => {
    const call = await callWith(1);
    const [guest] = call.guests;
    clock += MEET_STALE_MS + 1_000; // nobody polled: the room has not been tidied
    assert.equal((await handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: guest.cookie, ip: freshIp() }), call.c, deps())).status, 401);
    const back = await json(await handleJoin(request(`/api/meet/${call.c}/join`, { body: { name: "G0" }, cookie: guest.cookie, ip: freshIp() }), call.c, deps()));
    assert.ok(back.participantId && back.participantId !== guest.id, "not revived by the old token: a new join, through the cap");
  });

  await check("someone silent for five minutes has left: their calls are refused, their session is cut, and coming back goes through the cap", async () => {
    const call = await callWith(1);
    const [guest] = call.guests;
    const hostPolls = () => handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: call.host.cookie, ip: freshIp() }), call.c, deps());
    await passWhilePolling(MEET_STALE_MS + 60_000, [hostPolls]); // the guest's page stopped polling, its connection still open
    await settle();
    assert.equal((await handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: guest.cookie, ip: freshIp() }), call.c, deps())).status, 401);
    assert.equal((await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "session" }, cookie: guest.cookie, ip: freshIp() }), call.c, deps())).status, 401);
    assert.equal(await heldSession(guest.id), null, "the room's polls marked them left and cut what they still held");
    const back = await json(await handleJoin(request(`/api/meet/${call.c}/join`, { body: { name: "G0" }, cookie: guest.cookie, ip: freshIp() }), call.c, deps()));
    assert.ok(back.participantId && back.participantId !== guest.id, "a new place in the room, taken through the cap");
  });

  await check("a short silence is only a gap: someone not heard from for four minutes (a laptop asleep, a locked phone) is still in the call", async () => {
    const call = await callWith(1);
    const [guest] = call.guests;
    clock += 4 * 60_000;
    assert.equal((await handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: guest.cookie, ip: freshIp() }), call.c, deps())).status, 200);
    await settle();
    assert.equal(await heldSession(guest.id), call.sessions[1], "nothing of theirs was cut");
  });

  await check("a page that opens the room again as its person leaves gets a new place: the old one counts only if it is still there to refresh", async () => {
    const call = await callWith(1);
    const [guest] = call.guests;
    let raced = false;
    const racing = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== "execute") return typeof value === "function" ? value.bind(target) : value;
        return async (stmt: Parameters<typeof db.execute>[0]) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (!raced && sql.startsWith("UPDATE meet_participants SET last_seen_at")) {
            raced = true; // their leave lands between the join's read of their place and its refresh
            await handleLeave(request(`/api/meet/${call.c}/leave`, { cookie: guest.cookie, ip: freshIp() }), call.c, deps());
          }
          return target.execute(stmt);
        };
      },
    });
    const back = await json(await handleJoin(request(`/api/meet/${call.c}/join`, { body: { name: "G0" }, cookie: guest.cookie, ip: freshIp() }), call.c, deps({ db: racing })));
    assert.ok(raced, "the leave landed in the gap");
    assert.ok(back.participantId && back.participantId !== guest.id, "a new place, not the one that had just left");
  });

  await check("a removal that lands while a pull is on its way: what the pull added is cut too, and the puller is told", async () => {
    const call = await callWith(2);
    const [puller, publisher] = call.guests;
    await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }] }, cookie: publisher.cookie, ip: freshIp() }), call.c, deps());
    sfu.hooks.duringPull = () => handleHost(request(`/api/meet/${call.c}/host`, { body: { action: "remove", participantId: puller.id }, ip: freshIp() }), call.c, deps({ session: as(CC) }));
    const res = await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "pull", tracks: [{ participantId: publisher.id, trackName: "mic" }] }, cookie: puller.cookie, ip: freshIp() }), call.c, deps());
    sfu.hooks.duringPull = undefined;
    assert.equal(res.status, 403, "removed while the pull was on its way");
    assert.ok(sfu.sessions.get(call.sessions[1])!.every((t) => t.status === "inactive"), "the track the pull added after the removal's cut is closed as well");
  });

  await check("a removal that lands while a publish is on its way: what it published is cut too; a re-cut that fails gives the row its session back", async () => {
    const call = await callWith(1);
    const [guest] = call.guests;
    sfu.hooks.duringPublish = async () => {
      await handleHost(request(`/api/meet/${call.c}/host`, { body: { action: "remove", participantId: guest.id }, ip: freshIp() }), call.c, deps({ session: as(CC) }));
      sfu.down.add(call.sessions[1]); // the removal's cut went through; the SFU stops answering for the next one
    };
    const res = await quietly(() =>
      handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }] }, cookie: guest.cookie, ip: freshIp() }), call.c, deps()),
    );
    sfu.hooks.duringPublish = undefined;
    assert.equal(res.status, 403);
    assert.equal(await heldSession(guest.id), call.sessions[1], "the row holds the session again, so it can still be cut");
    sfu.down.delete(call.sessions[1]);
    clock += 31_000;
    await handleState(request(`/api/meet/${call.c}/state`, { method: "GET", cookie: call.host.cookie, ip: freshIp() }), call.c, deps());
    await settle();
    assert.equal(await heldSession(guest.id), null, "and the room's next tidy-up cut it");
    assert.ok(sfu.sessions.get(call.sessions[1])!.every((t) => t.status === "inactive"), "what the publish added is closed");
  });

  await check("an end that lands while a pull is on its way: the puller is told the room ended, and what the pull added is cut", async () => {
    const call = await callWith(2);
    const [puller, publisher] = call.guests;
    await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "publish", offer, tracks: [{ mid: "0", trackName: "mic", kind: "audio" }] }, cookie: publisher.cookie, ip: freshIp() }), call.c, deps());
    sfu.hooks.duringPull = () => handleHost(request(`/api/meet/${call.c}/host`, { body: { action: "end" }, ip: freshIp() }), call.c, deps({ session: as(CC) }));
    const res = await handleSfu(request(`/api/meet/${call.c}/sfu`, { body: { action: "pull", tracks: [{ participantId: publisher.id, trackName: "mic" }] }, cookie: puller.cookie, ip: freshIp() }), call.c, deps());
    sfu.hooks.duringPull = undefined;
    assert.equal(res.status, 410);
    assert.ok(sfu.sessions.get(call.sessions[1])!.every((t) => t.status === "inactive"));
  });

  await check("a meeting made for a time is not ended by its hosts trying it out early: only a call that reaches its time is its call", async () => {
    const startsAt = new Date(clock + 24 * 60 * 60_000).toISOString(); // tomorrow
    const c = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false, startsAt, timeZone: "America/Toronto" } }), deps({ session: as(CC) })))).room as Json).code);
    const together = async () => {
      await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) }));
      await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(ADON, true) }));
    };
    const status = async () => (await readMeetRoomByCode(db, c.replace(/-/g, "")))?.status;
    await together(); // CC and Adon, both hosts, try tomorrow's room today
    clock += MEET_HOST_GRACE_MS + 60_000;
    await handleListRooms(deps({ session: as(CC) }));
    assert.equal(await status(), "live", "the link sent to tomorrow's client still works");
    clock = Date.parse(startsAt) - 5 * 60_000; // the meeting itself, starting five minutes early
    await together();
    clock += MEET_HOST_GRACE_MS + 60_000;
    await handleListRooms(deps({ session: as(CC) }));
    assert.equal(await status(), "ended", "a call at its time, once its hosts are gone, ends");
    await settle();
  });

  await check("a try-out that only one of its two hosts stays in until the meeting's time is still not its call", async () => {
    const startsAt = new Date(clock + 30 * 60_000).toISOString(); // in half an hour
    const c = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false, startsAt, timeZone: "America/Toronto" } }), deps({ session: as(CC) })))).room as Json).code);
    const cc = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) })))!;
    const adon = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(ADON, true) })))!;
    const polls = (cookie: string) => () => handleState(request(`/api/meet/${c}/state`, { method: "GET", cookie, ip: freshIp() }), c, deps());
    await passWhilePolling(5 * 60_000, [polls(cc), polls(adon)]); // trying it out together
    await handleLeave(request(`/api/meet/${c}/leave`, { cookie: cc, ip: freshIp() }), c, deps()); // CC leaves, 25 minutes early
    await passWhilePolling(20 * 60_000, [polls(adon)]); // Adon stays on until five minutes before, then steps away
    assert.equal((await polls(adon)()).status, 200, "Adon was in the room all along");
    await handleLeave(request(`/api/meet/${c}/leave`, { cookie: adon, ip: freshIp() }), c, deps());
    clock += MEET_HOST_GRACE_MS + 60_000;
    await handleListRooms(deps({ session: as(CC) }));
    assert.equal((await readMeetRoomByCode(db, c.replace(/-/g, "")))?.status, "live", "its guests, due now, still find it waiting for them");
    await settle();
  });

  await check("the room keeps saying it records while its creator's poll is a minute late: the recorder is still running", async () => {
    const c = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: {} }), deps({ session: as(CC) })))).room as Json).code);
    await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) }));
    const admin = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: { consent: true }, ip: freshIp() }), c, deps({ session: as(ADON, true) })))!;
    clock += 60_000; // the creator's page has not polled for a minute (a slow network, a busy laptop)
    assert.equal((await json(await handleState(request(`/api/meet/${c}/state`, { method: "GET", cookie: admin, ip: freshIp() }), c, deps()))).recording, true);
  });

  await check("calls connect only with the participant token's secret set too: without it the list says not ready and nothing is made", async () => {
    const secret = process.env[MEET_TOKEN_SECRET_ENV];
    delete process.env[MEET_TOKEN_SECRET_ENV];
    try {
      assert.equal((await json(await handleListRooms(deps({ session: as(CC) })))).mediaReady, false);
      assert.equal((await handleCreateRoom(request("/api/calendar/meet", { body: {} }), deps({ session: as(CC) }))).status, 503);
    } finally {
      process.env[MEET_TOKEN_SECRET_ENV] = secret;
    }
  });

  await check("the room says it is being recorded only while its creator, whose browser records it, is in the call", async () => {
    const c = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: {} }), deps({ session: as(CC) })))).room as Json).code);
    const admin = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: { consent: true }, ip: freshIp() }), c, deps({ session: as(ADON, true) })))!;
    const recording = async () => (await json(await handleState(request(`/api/meet/${c}/state`, { method: "GET", cookie: admin, ip: freshIp() }), c, deps()))).recording;
    assert.equal(await recording(), false, "a second host is in and the creator is not: nothing records");
    const creator = cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) })))!;
    assert.equal(await recording(), true);
    await handleLeave(request(`/api/meet/${c}/leave`, { cookie: creator, ip: freshIp() }), c, deps());
    assert.equal(await recording(), false, "and stops saying so when the creator leaves");
  });

  await check("the backstop: a room nobody has been in for twelve hours ends (expired), but never one made for a time still ahead", async () => {
    const join = async (c: string) => cookieOf(await handleJoin(request(`/api/meet/${c}/join`, { body: {}, ip: freshIp() }), c, deps({ session: as(CC) })))!;
    const leave = (c: string, cookie: string) => handleLeave(request(`/api/meet/${c}/leave`, { cookie, ip: freshIp() }), c, deps());
    const now = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })))).room as Json).code);
    await leave(now, await join(now)); // the creator alone, then the tab closed
    const startsAt = new Date(clock + 20 * 60 * 60_000).toISOString(); // tomorrow
    const tomorrow = String(((await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false, startsAt, timeZone: "America/Toronto" } }), deps({ session: as(CC) })))).room as Json).code);
    await leave(tomorrow, await join(tomorrow)); // tested early
    const read = (c: string) => readMeetRoomByCode(db, c.replace(/-/g, ""));
    clock += MEET_IDLE_MS + 60_000;
    await handleListRooms(deps({ session: as(CC) }));
    assert.equal((await read(now))?.endedReason, "expired", "started now and left alone for twelve hours: it has ended");
    assert.equal((await read(tomorrow))?.status, "live", "tomorrow's meeting, tested early, keeps its link");
    clock += 21 * 60 * 60_000; // its time came and went, more than twelve hours ago, with nobody in it
    await handleListRooms(deps({ session: as(CC) }));
    assert.equal((await read(tomorrow))?.endedReason, "expired");
    await settle();
  });

  await check("nothing runs without its secrets: no token secret is 503 before any row is written; no SFU app is 503", async () => {
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const c4 = String((r.room as Json).code);
    const secret = process.env[MEET_TOKEN_SECRET_ENV];
    delete process.env[MEET_TOKEN_SECRET_ENV];
    const res = await handleJoin(request(`/api/meet/${c4}/join`, { body: { name: "G" }, ip: freshIp() }), c4, deps());
    process.env[MEET_TOKEN_SECRET_ENV] = secret;
    assert.equal(res.status, 503);
    assert.equal((await json(res)).error, "meet_not_configured");
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM meet_participants p JOIN meet_rooms r ON r.id = p.room_id WHERE r.code = ?", args: [c4.replace(/-/g, "")] });
    assert.equal(Number(rows.rows[0].n), 0, "no stray participant row");
    const host = cookieOf(await handleJoin(request(`/api/meet/${c4}/join`, { body: {}, ip: freshIp() }), c4, deps({ session: as(CC) })))!;
    const unset = deps({ sfu: () => { throw new MeetNotConfiguredError("no app"); } });
    assert.equal((await handleSfu(request(`/api/meet/${c4}/sfu`, { body: { action: "session" }, cookie: host, ip: freshIp() }), c4, unset)).status, 503);
  });

  await check("a script guessing links is slowed per address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await handleJoin(request("/api/meet/abc-defg-hjk/join", { body: { name: "x", consent: true }, ip: "192.0.2.77" }), "abc-defg-hjk", deps())).status);
    assert.ok(statuses.includes(429), `a burst from one address meets 429 (${statuses.join(",")})`);
    assert.equal(displayMeetCode("abcdefghjk"), "abc-defg-hjk");
  });

  finished = true;
  if (failures) {
    console.error(`meet room: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet room: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
