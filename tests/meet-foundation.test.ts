/**
 * Oasis Meet's foundation (migration bravo__230, lib/meet/rooms.ts, lib/meet/access.ts): the meeting link's code,
 * rooms in their own workspace, who is a host, and the participant token every guest call is checked against.
 *
 * Real SQL on a throwaway libSQL file with the real migration applied, twice (it must be safe to re-run).
 *
 * Run: node --conditions=react-server --import tsx tests/meet-foundation.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  MEET_COOKIE,
  MEET_TOKEN_SECRET_ENV,
  MEET_TOKEN_TTL_S,
  MeetNotConfiguredError,
  meetApiPath,
  meetCookie,
  meetRoleFor,
  requireMeetHost,
  requireMeetParticipant,
  signMeetToken,
  verifyMeetToken,
} from "../lib/meet/access";
import {
  MEET_CODE_ALPHABET,
  MEET_CODE_LENGTH,
  MEET_DEFAULT_TITLE,
  MEET_TITLE_MAX,
  createMeetRoom,
  displayMeetCode,
  listMeetRooms,
  meetTitle,
  newMeetCode,
  parseMeetCode,
  readMeetRoom,
  readMeetRoomByCode,
} from "../lib/meet/rooms";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const ROOT = join(__dirname, "..");
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
const CC = "11111111-0000-4000-8000-000000000001";
const ADON = "11111111-0000-4000-8000-000000000002";
const REP = "11111111-0000-4000-8000-000000000003";
const SECRET = "a-test-only-secret-that-is-long-enough-1234";
const NOW = Date.parse("2026-10-17T15:00:00.000Z");

async function main() {
  console.log("meet foundation:");
  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "meet-")), "test.db")}` });
  const migration = readFileSync(join(ROOT, "database", "turso", "bravo__230_meet_rooms.sql"), "utf8");
  await db.executeMultiple(migration);
  process.env[MEET_TOKEN_SECRET_ENV] = SECRET;

  await check("the migration is additive and safe to run again", async () => {
    await db.executeMultiple(migration);
    assert.doesNotMatch(migration.replace(/--.*$/gm, ""), /\b(drop|alter|delete|update)\b/i, "only CREATE ... IF NOT EXISTS");
    const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'meet_%' ORDER BY name")).rows.map((r) => r.name);
    assert.deepEqual(tables, ["meet_participants", "meet_rooms"]);
  });

  await check("a code is ten letters from the alphabet, with no 'l', and a byte that would bias it is drawn again", () => {
    assert.equal(MEET_CODE_ALPHABET.length, 25);
    assert.ok(!MEET_CODE_ALPHABET.includes("l"));
    for (let i = 0; i < 500; i += 1) {
      const code = newMeetCode();
      assert.equal(code.length, MEET_CODE_LENGTH);
      for (const ch of code) assert.ok(MEET_CODE_ALPHABET.includes(ch), code);
    }
    // 250 and up are dropped: 256 is not a multiple of 25, and folding them in would favour the first letters.
    const draws = [new Uint8Array([250, 255, 0, 1, 2, 3, 4, 5, 6, 7]), new Uint8Array([24, 49, 0, 0, 0, 0, 0, 0, 0, 0])];
    const code = newMeetCode(() => draws.shift()!);
    assert.equal(code, "abcdefghzz", "the two biased bytes were skipped and the next draw filled the code");
  });

  await check("a link reads 3-4-3 and parses back from what people type", () => {
    assert.equal(displayMeetCode("abcdefghjk"), "abc-defg-hjk");
    assert.equal(parseMeetCode("abc-defg-hjk"), "abcdefghjk");
    assert.equal(parseMeetCode("  ABC DEFG HJK "), "abcdefghjk", "spaces and capitals are fine");
    for (const bad of ["abc-defg-hj", "abc-defg-hjkk", "abc-defg-hjl", "abc-defg-hj1", "", null, 42, "a".repeat(41)]) {
      assert.equal(parseMeetCode(bad), null, String(bad));
    }
  });

  await check("a title is kept plain and short, and none at all is 'Meeting'", () => {
    assert.equal(meetTitle(undefined), MEET_DEFAULT_TITLE);
    assert.equal(meetTitle("   "), MEET_DEFAULT_TITLE);
    assert.equal(meetTitle("Call\nwith\tAcme"), "Call with Acme");
    assert.equal(meetTitle("x".repeat(500)).length, MEET_TITLE_MAX);
  });

  const room = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Discovery call", now: new Date(NOW) });

  await check("a room is made scheduled, recording audio, in its own workspace, and read back the same", async () => {
    assert.equal(room.status, "scheduled");
    assert.equal(room.recordAudio, true);
    assert.equal(room.title, "Discovery call");
    assert.deepEqual(await readMeetRoomByCode(db, room.code), room);
    assert.deepEqual(await readMeetRoom(db, { tenantId: OASIS, roomId: room.id }), room);
    assert.equal(await readMeetRoom(db, { tenantId: OTHER, roomId: room.id }), null, "another workspace's id reads as no room");
    const quiet = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, recordAudio: false, startsAt: "2026-10-20T14:00:00-04:00" });
    assert.equal(quiet.recordAudio, false);
    assert.equal(quiet.startsAt, "2026-10-20T18:00:00.000Z", "a planned start is kept in UTC");
    assert.equal((await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, startsAt: "not a time" })).startsAt, null);
  });

  await check("a code already taken is drawn again, and three clashes in a row are an error", async () => {
    const codes = [room.code, "zzzzzzzzzz"];
    const again = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, nextCode: () => codes.shift()! });
    assert.equal(again.code, "zzzzzzzzzz");
    await assert.rejects(createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, nextCode: () => room.code }), /UNIQUE/);
  });

  await check("the Schedule's list is the workspace's own rooms, newest first", async () => {
    await createMeetRoom(db, { tenantId: OTHER, hostUserId: REP, title: "Not ours" });
    const later = await createMeetRoom(db, { tenantId: OASIS, hostUserId: ADON, title: "Later", now: new Date(NOW + 60_000) });
    const list = await listMeetRooms(db, { tenantId: OASIS });
    assert.ok(list.every((r) => r.tenantId === OASIS));
    assert.ok(!list.some((r) => r.title === "Not ours"));
    assert.ok(list.findIndex((r) => r.id === later.id) < list.findIndex((r) => r.id === room.id), "newest first");
    assert.equal((await listMeetRooms(db, { tenantId: OASIS, limit: 1 })).length, 1);
  });

  await check("host: who made the room or runs the workspace; another member is a guest; another workspace is no one", () => {
    assert.equal(meetRoleFor({ tenantId: OASIS, userId: CC, isAdmin: false }, room), "host");
    assert.equal(meetRoleFor({ tenantId: OASIS, userId: ADON, isAdmin: true }, room), "host");
    assert.equal(meetRoleFor({ tenantId: OASIS, userId: REP, isAdmin: false }, room), "guest");
    assert.equal(meetRoleFor({ tenantId: OTHER, userId: CC, isAdmin: true }, room), null);
  });

  await check("requireMeetHost: 401 signed out, 404 no room or another workspace's, 403 a member who is not host", async () => {
    const as = (s: { ok: true; tenantId: string; userId: string; isAdmin: boolean } | { ok: false }) => async () => s;
    const status = async (r: Awaited<ReturnType<typeof requireMeetHost>>) => (r.ok ? 200 : r.response.status);
    const code = displayMeetCode(room.code);
    assert.equal(await status(await requireMeetHost(db, code, as({ ok: false }))), 401);
    assert.equal(await status(await requireMeetHost(db, "abc-defg-hjk", as({ ok: true, tenantId: OASIS, userId: CC, isAdmin: true }))), 404);
    assert.equal(await status(await requireMeetHost(db, "not a code", as({ ok: true, tenantId: OASIS, userId: CC, isAdmin: true }))), 404);
    assert.equal(await status(await requireMeetHost(db, code, as({ ok: true, tenantId: OTHER, userId: CC, isAdmin: true }))), 404);
    assert.equal(await status(await requireMeetHost(db, code, as({ ok: true, tenantId: OASIS, userId: REP, isAdmin: false }))), 403);
    const ok = await requireMeetHost(db, code, as({ ok: true, tenantId: OASIS, userId: CC, isAdmin: false }));
    assert.ok(ok.ok && ok.room.id === room.id && ok.tenantId === OASIS && ok.userId === CC);
  });

  await check("a participant token: signed here, for one participant, until it expires", () => {
    const token = signMeetToken({ roomId: room.id, participantId: "p1", role: "guest" }, NOW);
    const claims = verifyMeetToken(token, NOW + 1_000);
    assert.deepEqual(claims, { roomId: room.id, participantId: "p1", role: "guest", exp: Math.floor(NOW / 1000) + MEET_TOKEN_TTL_S });
    assert.equal(verifyMeetToken(token, NOW + MEET_TOKEN_TTL_S * 1000), null, "expired");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, r: room.id, p: "p1", role: "host", exp: 9e9 })).toString("base64url");
    assert.equal(verifyMeetToken(`${forged}.${sig}`, NOW), null, "a payload changed after signing");
    assert.equal(verifyMeetToken(`${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`, NOW), null, "a changed signature");
    for (const junk of ["", ".", "a.b.c", `.${sig}`, `${payload}.`, "x".repeat(2000), null, undefined]) {
      assert.equal(verifyMeetToken(junk as string, NOW), null, String(junk).slice(0, 20));
    }
    process.env[MEET_TOKEN_SECRET_ENV] = `${SECRET}-rotated`;
    assert.equal(verifyMeetToken(token, NOW), null, "a token signed under another secret");
    process.env[MEET_TOKEN_SECRET_ENV] = SECRET;
  });

  await check("no secret, no meetings: missing or short, signing and checking both throw (the route answers 503)", () => {
    for (const value of [undefined, "short"]) {
      if (value === undefined) delete process.env[MEET_TOKEN_SECRET_ENV];
      else process.env[MEET_TOKEN_SECRET_ENV] = value;
      assert.throws(() => signMeetToken({ roomId: "r", participantId: "p", role: "guest" }), MeetNotConfiguredError);
      assert.throws(() => verifyMeetToken("anything.at-all"), MeetNotConfiguredError);
    }
    process.env[MEET_TOKEN_SECRET_ENV] = SECRET;
  });

  await check("the cookie: HttpOnly, Secure, SameSite=Lax, sent only to this room's API", () => {
    const cookie = meetCookie(room.code, "tok");
    assert.equal(cookie.name, MEET_COOKIE);
    assert.deepEqual(cookie.options, { httpOnly: true, secure: true, sameSite: "lax", path: `/api/meet/${displayMeetCode(room.code)}`, maxAge: MEET_TOKEN_TTL_S });
    assert.equal(meetApiPath(room.code), cookie.options.path);
  });

  await check("requireMeetParticipant re-reads the row: left, removed and an ended room take effect at once", async () => {
    const add = async (id: string, extra: Record<string, string | null> = {}) => {
      await db.execute({
        sql: `INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, joined_at, last_seen_at, left_at, removed_at, tracks)
              VALUES (?, ?, ?, 'guest', NULL, 'Guest', ?, ?, ?, ?, '[{"trackName":"a1","kind":"audio"},{"bad":1}]')`,
        args: [id, OASIS, room.id, new Date(NOW).toISOString(), new Date(NOW).toISOString(), extra.left_at ?? null, extra.removed_at ?? null],
      });
    };
    await add("here");
    await add("gone", { left_at: new Date(NOW).toISOString() });
    await add("out", { removed_at: new Date(NOW).toISOString() });
    const code = displayMeetCode(room.code);
    const call = (cookie: string | undefined, c = code) =>
      requireMeetParticipant(db, { cookies: { get: (n: string) => (n === MEET_COOKIE && cookie ? { value: cookie } : undefined) } }, c, NOW);
    const status = (r: Awaited<ReturnType<typeof call>>) => (r.ok ? 200 : r.response.status);
    const tokenFor = (participantId: string, roomId = room.id) => signMeetToken({ roomId, participantId, role: "guest" }, NOW);

    const ok = await call(tokenFor("here"));
    assert.ok(ok.ok, "a participant in the room");
    if (ok.ok) assert.deepEqual(ok.participant.tracks, [{ trackName: "a1", kind: "audio" }], "a malformed track entry is dropped");
    assert.equal(status(await call(undefined)), 401, "no cookie");
    assert.equal(status(await call(tokenFor("here", "another-room"))), 401, "a token for another room");
    assert.equal(status(await call(tokenFor("nobody"))), 401, "a participant who is not in the room");
    assert.equal(status(await call(tokenFor("gone"))), 401, "they left");
    assert.equal(status(await call(tokenFor("out"))), 403, "the host removed them");
    assert.equal(status(await call(tokenFor("here"), "abc-defg-hjk")), 404, "no such room");
    const elsewhere = await createMeetRoom(db, { tenantId: OASIS, hostUserId: CC, title: "Another room" });
    assert.equal(status(await call(tokenFor("here", elsewhere.id), displayMeetCode(elsewhere.code))), 401, "one room's participant, named in a token for another room");
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ?, ended_reason = 'host_ended' WHERE tenant_id = ? AND id = ?", args: [new Date(NOW).toISOString(), OASIS, room.id] });
    assert.equal(status(await call(tokenFor("here"))), 410, "the room ended");
  });

  if (failures) {
    console.error(`meet foundation: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet foundation: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
