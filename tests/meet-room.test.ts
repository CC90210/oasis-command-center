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
import { MEET_COOKIE, MEET_TOKEN_SECRET_ENV, MeetNotConfiguredError } from "../lib/meet/access";
import { parseSfu } from "../lib/meet/bodies";
import { handleCreateRoom, handleHost, handleJoin, handleLeave, handleListRooms, handleSfu, handleState, type MeetDeps, type MeetSession } from "../lib/meet/handlers";
import { MEET_HOST_GRACE_MS, MEET_MAX_PARTICIPANTS } from "../lib/meet/participants";
import { displayMeetCode, readMeetRoomByCode } from "../lib/meet/rooms";
import type { SfuClient } from "../lib/meet/sfu";

let failures = 0;
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

/** A stand-in SFU: sessions and their tracks in memory, every call recorded. */
function fakeSfu() {
  const calls: Array<{ op: string; sessionId: string; mids?: string[]; tracks?: unknown }> = [];
  const sessions = new Map<string, Array<{ mid: string; location: string; trackName: string; status: string }>>();
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
      return (sessions.get(sessionId) ?? []).map((t) => ({ ...t }));
    },
  };
  return { client, calls, sessions };
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
  const deps = (over: Partial<MeetDeps> = {}): MeetDeps => ({
    db,
    sfu: () => sfu.client,
    session: signedOut,
    ice: async () => [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    schedule: async (owner, room, opts) => {
      scheduled.push({ owner, startsAt: room.startsAt, timeZone: opts.timeZone, minutes: opts.minutes });
      return { ok: true, eventId: `evt-${scheduled.length}` };
    },
    now: () => new Date(clock),
    ...over,
  });
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
    assert.ok(!("tenantId" in room) && !("hostUserId" in room), "the room view never carries its workspace or host id");
    code = String(room.code);
    await handleCreateRoom(request("/api/calendar/meet", { body: { title: "Theirs" } }), deps({ session: as(REP, false, OTHER) }));
    const list = (await json(await handleListRooms(deps({ session: as(ADON) })))).rooms as Json[];
    assert.ok(list.some((r) => r.code === code) && !list.some((r) => r.title === "Theirs"), "the list is the workspace's own rooms");
    assert.equal(list.find((r) => r.code === code)?.mine, false, "Adon sees CC's room as not his own");
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
    const admin = await json(await handleJoin(request(`/api/meet/${code}/join`, { body: {}, ip: freshIp() }), code, deps({ session: as(ADON, true) })));
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

  await check("the room holds eight people at most, counted in the same statement as the join", async () => {
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const full = String((r.room as Json).code);
    const statuses: number[] = [];
    for (let i = 0; i < MEET_MAX_PARTICIPANTS + 1; i += 1) {
      statuses.push((await handleJoin(request(`/api/meet/${full}/join`, { body: { name: `P${i}` }, ip: freshIp() }), full, deps())).status);
    }
    assert.deepEqual(statuses, [...Array(MEET_MAX_PARTICIPANTS).fill(200), 409]);
    clock += 31_000; // everyone stopped polling: they are gone, and their places are free again
    assert.equal((await handleJoin(request(`/api/meet/${full}/join`, { body: { name: "Late" }, ip: freshIp() }), full, deps())).status, 200);
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
    const res = await handleHost(request(`/api/meet/${c2}/host`, { body: { action: "end" }, ip: freshIp() }), c2, deps({ session: as(ADON, true) }));
    assert.equal(res.status, 200, "an owner or admin by base role may end it");
    const cuts = sfu.calls.slice(before).filter((c) => c.op === "tracks").map((c) => c.sessionId);
    assert.equal(new Set(cuts).size, 2, "both sessions were read and cut");
    assert.equal((await handleState(request(`/api/meet/${c2}/state`, { method: "GET", cookie: cookieOf(guest)!, ip: freshIp() }), c2, deps())).status, 410);
    assert.equal((await handleJoin(request(`/api/meet/${c2}/join`, { body: { name: "Late" }, ip: freshIp() }), c2, deps())).status, 410);
    assert.equal((await json(await handleHost(request(`/api/meet/${c2}/host`, { body: { action: "end" }, ip: freshIp() }), c2, deps({ session: as(CC) })))).alreadyEnded, true, "ending twice is fine");
  });

  await check("a live room whose host has been gone ten minutes ends itself", async () => {
    const r = await json(await handleCreateRoom(request("/api/calendar/meet", { body: { recordAudio: false } }), deps({ session: as(CC) })));
    const c3 = String((r.room as Json).code);
    await handleJoin(request(`/api/meet/${c3}/join`, { body: {}, ip: freshIp() }), c3, deps({ session: as(CC) }));
    const guest = cookieOf(await handleJoin(request(`/api/meet/${c3}/join`, { body: { name: "G" }, ip: freshIp() }), c3, deps()))!;
    const poll = () => handleState(request(`/api/meet/${c3}/state`, { method: "GET", cookie: guest, ip: freshIp() }), c3, deps());
    clock += MEET_HOST_GRACE_MS - 60_000;
    assert.equal((await poll()).status, 200, "nine minutes: still waiting for the host");
    clock += 120_000;
    assert.equal((await poll()).status, 410);
    const room = await readMeetRoomByCode(db, c3.replace(/-/g, ""));
    assert.equal(room?.endedReason, "host_left");
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
