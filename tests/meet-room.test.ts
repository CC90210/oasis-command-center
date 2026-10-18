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
import { handleCreateRoom, handleHost, handleJoin, handleLeave, handleListRooms, handleSfu, handleState, type MeetDeps, type MeetSession } from "../lib/meet/handlers";
import { MEET_CUT_RETRY_MS, MEET_HOST_GRACE_MS, MEET_MAX_PARTICIPANTS, endAbandonedRooms, pendingCuts } from "../lib/meet/participants";
import { displayMeetCode, readMeetRoomByCode } from "../lib/meet/rooms";
import { SfuError, type SfuClient } from "../lib/meet/sfu";

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

/**
 * A stand-in SFU: sessions and their tracks in memory, every call recorded. `down` holds sessions it cannot be
 * asked about (a 500), `gone` the ones it no longer has (a 404); reading a session takes a moment, and `widest` is
 * the most reads that were in flight at once.
 */
function fakeSfu() {
  const calls: Array<{ op: string; sessionId: string; mids?: string[]; tracks?: unknown }> = [];
  const sessions = new Map<string, Array<{ mid: string; location: string; trackName: string; status: string }>>();
  const down = new Set<string>();
  const gone = new Set<string>();
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
      reading += 1;
      widest = Math.max(widest, reading);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (down.has(sessionId)) throw new SfuError("sfu_http_500", "the SFU answered 500", 500);
        if (gone.has(sessionId)) throw new SfuError("session_not_found", "no such session", 404);
        return (sessions.get(sessionId) ?? []).map((t) => ({ ...t }));
      } finally {
        reading -= 1;
      }
    },
  };
  return {
    client, calls, sessions, down, gone,
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
    later: (_label, work) => void background.push(work()),
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

  await check("a removed guest whose cut failed is cut again from the host's next polls, at most every 30 seconds; a session the SFU no longer has counts as cut", async () => {
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
    clock += MEET_HOST_GRACE_MS - 60_000; // the host's tab died
    assert.equal((await poll(guest.cookie)).status, 200, "nine minutes on, still waiting for the host");
    clock += 120_000;
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
