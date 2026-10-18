/**
 * Delete meeting on e9's real recording code: the wiring the live routes use (lib/meet/recording-deps.ts over
 * lib/meet/recording.ts), on throwaway libSQL files with migrations 206 (tool jobs), 230 and 231, a stand-in R2
 * relay, and a stand-in SFU nobody connects to (so there is no media to cut). tests/meet-room.test.ts holds the routes to their order with
 * a stand-in recording; this proves the real one keeps it:
 *  - before migration 231, recording is unavailable: the panel is told so, a room never records, and a delete has
 *    nothing to remove;
 *  - only OASIS's own workspaces record;
 *  - deleting a recorded meeting deletes its audio on the relay, calls off its transcription, leaves e9's
 *    tombstone (it refuses a late chunk, and the PC's delete job reports to it) and removes the room's rows.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-delete.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { NextRequest } from "next/server";
import { OASIS, USERS, check, emptyDatabase, finish, scalar, setupToolsDatabase } from "./_tools-harness";
import type { MeetDeps, MeetSession } from "../lib/meet/handlers";
import type { MeetStorage } from "../lib/meet/recording";
import type { SfuClient } from "../lib/meet/sfu";

const ROOT = join(__dirname, "..");
const ORIGIN = "https://oasisai.work";
const OTHER = "cccccccc-0000-4000-8000-00000000000c";
const CC = USERS.cc.id;
let ipSeq = 0;

function request(path: string, body: unknown) {
  // Off Cloudflare and Vercel, lib/api-helpers.ts reads the caller's address from x-forwarded-for.
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { host: "oasisai.work", origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": `198.51.100.${(ipSeq += 1) % 250}` },
    body: JSON.stringify(body),
  });
}

/** A stand-in R2 relay: objects in memory. */
function relay() {
  const objects = new Map<string, Uint8Array>();
  const storage: MeetStorage = {
    async put(path, bytes) {
      objects.set(path, bytes);
    },
    async signedGetUrl(path) {
      return `https://relay.example/${path}`;
    },
    async remove(path) {
      objects.delete(path);
    },
  };
  return { storage, objects };
}

async function main() {
  console.log("meet delete (real recording):");
  const { MEET_TOKEN_SECRET_ENV } = await import("../lib/meet/access");
  const { handleCreateRoom, handleHost, handleJoin, handleListRooms } = await import("../lib/meet/handlers");
  const { meetRecordingDeps } = await import("../lib/meet/recording-deps");
  const { acceptChunk, ensureTranscriptJob } = await import("../lib/meet/recording");
  const { readMeetRoomByCode } = await import("../lib/meet/rooms");
  process.env[MEET_TOKEN_SECRET_ENV] = "a-test-only-secret-that-is-long-enough-1234";
  const migration = (name: string) => readFileSync(join(ROOT, "database", "turso", name), "utf8");
  let clock = Date.parse("2026-10-17T16:00:00.000Z");
  const as = (userId: string, tenantId = OASIS) => async (): Promise<MeetSession> => ({ ok: true, tenantId, userId, isTrueAdmin: false, email: "cc@oasisai.work" });
  const depsFor = (db: Client, storage: MeetStorage) => (session: () => Promise<MeetSession>): MeetDeps => ({
    db,
    // Set up (a meeting is only made where its call can connect), but never asked: nobody here opens a session.
    sfu: () => ({}) as SfuClient,
    session,
    ice: async () => [],
    schedule: async () => ({ ok: false, reason: "no_calendar" }),
    unschedule: async () => {},
    recording: meetRecordingDeps(db, () => storage),
    later: (_label, work) => void work().catch((err: unknown) => console.error("[test.later]", err)),
    now: () => new Date(clock),
  });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const make = async (deps: MeetDeps, body: Record<string, unknown>) => (await json(await handleCreateRoom(request("/api/calendar/meet", body), deps))).room as Record<string, unknown>;
  const host = (code: string, action: string, deps: MeetDeps) => handleHost(request(`/api/meet/${code}/host`, { action }), code, deps);

  await check("before migration 231: recording is unavailable, a room never records, and a delete has nothing to remove", async () => {
    const bare = emptyDatabase();
    await bare.executeMultiple(migration("bravo__230_meet_rooms.sql"));
    const deps = depsFor(bare, relay().storage);
    assert.equal((await json(await handleListRooms(deps(as(CC))))).recordingAvailable, false);
    const room = await make(deps(as(CC)), { recordAudio: true });
    assert.equal(room.recordAudio, false);
    const code = String(room.code);
    assert.deepEqual(await json(await host(code, "delete", deps(as(CC)))), { ok: true, deleted: true, relayRemaining: 0, mediaCut: true });
    assert.equal(await readMeetRoomByCode(bare, code.replace(/-/g, "")), null);
  });

  const db = await setupToolsDatabase();
  await db.executeMultiple(migration("bravo__230_meet_rooms.sql"));
  await db.executeMultiple(migration("bravo__231_meet_recordings.sql"));
  const { storage, objects } = relay();
  const deps = depsFor(db, storage);

  await check("installed: only OASIS's own workspaces record", async () => {
    assert.equal((await json(await handleListRooms(deps(as(CC))))).recordingAvailable, true);
    assert.equal((await json(await handleListRooms(deps(as(CC, OTHER))))).recordingAvailable, false);
    assert.equal((await make(deps(as(CC)), {})).recordAudio, true);
    assert.equal((await make(deps(as(CC, OTHER)), { recordAudio: true })).recordAudio, false);
  });

  await check("deleting a recorded meeting: its audio leaves the relay, its transcription is called off, e9's tombstone stays, the room's rows go", async () => {
    const code = String((await make(deps(as(CC)), { title: "Recorded" })).code);
    const joined = await json(await handleJoin(request(`/api/meet/${code}/join`, {}), code, deps(as(CC))));
    assert.equal(joined.records, true, "the creator's browser records it");
    const room = (await readMeetRoomByCode(db, code.replace(/-/g, "")))!;
    const chunk = (seq: number) =>
      acceptChunk(db, storage, {
        room, uploadedBy: CC, participantId: String(joined.participantId), displayName: String(joined.name),
        segmentId: "seg-1", seq, segmentStartedMs: clock, mimeType: "audio/webm", bytes: new Uint8Array([1, 2, 3]), now: new Date(clock),
      });
    assert.equal((await chunk(0)).ok, true);
    assert.equal((await chunk(1)).ok, true);
    assert.equal(objects.size, 2);
    // The host ends it and it is handed to the PC: a transcription is waiting when the delete comes.
    clock += 60_000;
    assert.equal((await host(code, "end", deps(as(CC)))).status, 200);
    assert.equal((await ensureTranscriptJob(db, (await readMeetRoomByCode(db, room.code))!, CC, new Date(clock))).state, "queued");
    assert.deepEqual(await json(await host(code, "delete", deps(as(CC)))), { ok: true, deleted: true, relayRemaining: 0, mediaCut: true });
    assert.equal(objects.size, 0, "none of its audio is left on the relay");
    assert.equal(Number(await scalar(db, "SELECT count(*) FROM meet_recording_chunks WHERE tenant_id = ? AND room_id = ?", [OASIS, room.id])), 0);
    assert.equal(await scalar(db, "SELECT status FROM meet_transcripts WHERE tenant_id = ? AND room_id = ?", [OASIS, room.id]), "deleted", "e9's tombstone stays");
    assert.equal(
      await scalar(db, "SELECT error_code FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ?", [OASIS, `meet_transcribe:${room.id}`]),
      "meeting_deleted",
      "the waiting transcription is called off",
    );
    const rows = await scalar(db, "SELECT (SELECT count(*) FROM meet_rooms WHERE tenant_id = ? AND id = ?) + (SELECT count(*) FROM meet_participants WHERE tenant_id = ? AND room_id = ?)", [OASIS, room.id, OASIS, room.id]);
    assert.equal(Number(rows), 0, "the room and its people's rows are gone");
    assert.deepEqual(await chunk(2), { ok: false, status: 410, error: "recording_closed" }, "a chunk still in flight is refused by the tombstone");
    assert.equal(objects.size, 0);
  });

  finish("meet delete (real recording)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
