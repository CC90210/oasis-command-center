/**
 * Free AI Audit, phase 2c: a discovery call held in Oasis Meet joins its
 * engagement (lib/ai-audit/meet-link.ts), with the review's fixes.
 *
 * - The lead's room is found, or one is made for it: recorded where Meet
 *   records, only where a call can connect, and only one even for two presses
 *   at once; another once the only one has ended.
 * - A ready Meet transcript is attached by the tick only when every guest
 *   agreed to the recording in Meet and the workspace owner recorded the
 *   client's AI answer as what the client said (Client-reported or Verified);
 *   its lines are timed from the room's start and scrubbed; the AI answer, yes
 *   or no, is the transcript's AI consent.
 * - The client's AI answer said by hand is the owner's only (the route answers
 *   403 to anyone else), and a second attach with the other answer is refused.
 * - Without an acceptable AI answer it waits for CC once (an event and an
 *   alert), and a newer answer on the profile lifts the wait.
 * - Lost audio, a removed guest, no guest heard, a call that ended before the
 *   engagement opened, or one any audit held before: listed for the owner once,
 *   with the reason, and attached only by his hand.
 * - A ready transcript with no lines is never picked; one that cannot be
 *   attached is listed once; neither starves a good call.
 * - A Meet transcript over the paste cap is refused whole, never cut.
 * - An auto-attach withdraws a Gate 1 card it makes stale.
 * - The room list costs the same few reads however many rooms, and no
 *   transcript text leaves the database for it.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-meet-link.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client, InStatement } from "@libsql/client";
import { OASIS, USERS, check, finish, login, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

const NOW = () => new Date();
/** Real time moves on: a profile answer saved after a tick is newer than the tick's event. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  if (buf.length) out.push(buf.join("\n").trim());
  return out.filter(Boolean);
}

async function apply(db: Client, file: string) {
  for (const stmt of splitStatements(readFileSync(join(process.cwd(), "database", "turso", file), "utf8"))) await db.execute(stmt);
}

/** The client with every execute counted, and the columns each one returned. */
function counting(inner: Client): { db: Client; seen: Array<{ sql: string; columns: string[] }> } {
  const seen: Array<{ sql: string; columns: string[] }> = [];
  const db = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "execute") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (stmt: InStatement) => {
        const rs = await target.execute(stmt);
        seen.push({ sql: typeof stmt === "string" ? stmt : stmt.sql, columns: rs.columns });
        return rs;
      };
    },
  });
  return { db, seen };
}

async function main() {
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of [
    "bravo__186_os_approvals.sql",
    "bravo__206_tool_jobs.sql",
    "bravo__230_meet_rooms.sql",
    "bravo__231_meet_recordings.sql",
    "bravo__233_meet_room_recorder.sql",
    "bravo__237_ai_audit_core.sql",
    "bravo__238_ai_audit_delivery.sql",
    "bravo__239_ai_audit_discovery.sql",
    "bravo__241_ai_audit_briefs.sql",
  ])
    await apply(db, f);

  const store = await import("../lib/ai-audit/store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const versions = await import("../lib/ai-audit/versions");
  const transcripts = await import("../lib/ai-audit/transcripts");
  const authorize = await import("../lib/ai-audit/authorize");
  const approvals = await import("../lib/os/approvals/store");
  const link = await import("../lib/ai-audit/meet-link");
  const tr = await import("../lib/ai-audit/transcript");
  const route = await import("../app/api/ai-audit/[engagementId]/route");

  const cc = { type: "user" as const, id: USERS.cc.id };
  const admin = { type: "user" as const, id: USERS.admin.id };
  let n = 0;
  const engagementFor = async (name: string, stage: "call_scheduled" | "call_completed" = "call_scheduled") => {
    n += 1;
    const lead = `7c000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
    await db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)", args: [lead, OASIS, JSON.stringify({ stage: "qualified", company: `[TEST] ${name}`, name: "Test Owner", email: `meet+${n}@fixture.test` })] });
    const o = await store.openEngagement(db, { tenantId: OASIS, leadId: lead, actor: cc, now: NOW(), isFixture: true });
    assert.ok(o.ok);
    const eid = o.ok ? o.engagement.id : "";
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: stage, actor: cc, now: NOW() })).ok);
    return { eid, lead };
  };

  type Guest = { name: string; consented: boolean; removed?: boolean };
  /** One spoken line: `at` is seconds after the start; `by` who said it (the host, or a guest by index; default: "CC" is the host, anyone else the first guest). */
  type Line = { speaker: string; text: string; at?: number; by?: "host" | number };
  type CallOpts = {
    /** The meeting's start on the wall clock (ms since the epoch). */
    startMs?: number;
    /** False: the room never recorded a start (meet_rooms.started_at NULL). */
    withStart?: boolean;
    endedAt?: string;
    updatedAt?: string;
    missingChunks?: number;
    recorderFailed?: number;
    recorderErrored?: number;
    /** Stored as lines_json as given, in place of `lines`. */
    rawLines?: unknown[];
  };
  /** A finished Meet call: a room for the lead, its people, and a ready transcript whose at_ms are epoch times, as Meet stores them. */
  const meetCall = async (lead: string, guests: Guest[], lines: Line[], opts: CallOpts = {}) => {
    const roomId = crypto.randomUUID();
    const at = NOW().toISOString();
    const startMs = opts.startMs ?? Date.now() - 600_000;
    await db.execute({
      sql: "INSERT INTO meet_rooms (id, tenant_id, code, title, host_user_id, status, record_audio, starts_at, calendar_event_id, lead_id, created_at, started_at, ended_at, ended_reason) VALUES (?, ?, ?, 'Discovery call', ?, 'ended', 1, NULL, NULL, ?, ?, ?, ?, 'host_ended')",
      args: [roomId, OASIS, `code-${roomId.slice(0, 8)}`, USERS.cc.id, lead, at, opts.withStart === false ? null : new Date(startMs).toISOString(), opts.endedAt ?? at],
    });
    const hostId = crypto.randomUUID();
    await db.execute({ sql: "INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, joined_at, last_seen_at) VALUES (?, ?, ?, 'host', ?, 'CC', ?, ?, ?)", args: [hostId, OASIS, roomId, USERS.cc.id, at, at, at] });
    const guestIds: string[] = [];
    let order = 0;
    for (const g of guests) {
      // Guests join one after another, as they do in a real call.
      order += 1;
      const joined = new Date(Date.parse(at) + order * 1000).toISOString();
      const id = crypto.randomUUID();
      guestIds.push(id);
      await db.execute({
        sql: "INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, joined_at, last_seen_at, removed_at) VALUES (?, ?, ?, 'guest', NULL, ?, ?, ?, ?, ?)",
        args: [id, OASIS, roomId, g.name, g.consented ? joined : null, joined, joined, g.removed ? joined : null],
      });
    }
    const who = (l: Line) => (l.by === "host" ? hostId : typeof l.by === "number" ? guestIds[l.by] : l.speaker === "CC" ? hostId : (guestIds[0] ?? hostId));
    const meetLines = opts.rawLines ?? lines.map((l, i) => {
      const atMs = startMs + Math.round((l.at ?? i * 5) * 1000);
      return { at_ms: atMs, end_ms: atMs + 4000, participant_id: who(l), speaker: l.speaker, text: l.text };
    });
    const updated = opts.updatedAt ?? at;
    await db.execute({
      sql: `INSERT INTO meet_transcripts (id, tenant_id, room_id, status, lines_json, text, relay_expires_at, created_at, updated_at, ready_at, missing_chunks, recorder_failed, recorder_errored)
            VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(), OASIS, roomId, JSON.stringify(meetLines), lines.map((l) => l.text).join(" "), new Date(Date.now() + 30 * 86_400_000).toISOString(), at, updated, updated,
        opts.missingChunks ?? 0, opts.recorderFailed ?? 0, opts.recorderErrored ?? 0,
      ],
    });
    return roomId;
  };
  /** The client's answer about AI analysis on the profile: by default the owner's, Client-reported, from the call. */
  const aiAnswer = (eid: string, value: boolean, opts: { by?: { type: "user"; id: string }; label?: string; source?: string } = {}) =>
    versions.saveProfileField(db, {
      tenantId: OASIS,
      engagementId: eid,
      field: { field_key: "consent.ai_processing", value, label: opts.label ?? "client_reported", source_type: opts.source ?? "call_notes" } as never,
      actor: opts.by ?? cc,
      now: NOW(),
    });
  const alerts: Array<Record<string, unknown>> = [];
  const alert = async (a: Record<string, unknown>) => void alerts.push(a);
  const tick = () => link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert);
  /** Every room earlier checks left waiting is dealt with, so a check can count what its own rooms do. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      const r = await tick();
      if (!r.attached && !r.waiting) return;
    }
    throw new Error("the tick never settled");
  };
  const events = async (eid: string, event: string) =>
    (await db.execute({ sql: "SELECT ref_id, meta FROM ai_audit_events WHERE engagement_id = ? AND event = ? ORDER BY created_at, id", args: [eid, event] })).rows.map((r) => ({
      room: String(r.ref_id),
      meta: JSON.parse(String(r.meta)) as { reason?: string; holds?: string[] },
    }));
  const meetUp = { mediaReady: () => true, recordingAvailable: async () => true };
  const call = [
    { speaker: "Dana Lee", text: "We get about 40 calls a week and miss a third of them." },
    { speaker: "CC", text: "And the alarm code for the shop?" },
    { speaker: "Dana Lee", text: "The alarm code is 4421 but please do not write that down." },
  ];
  const params = (eid: string) => ({ params: Promise.resolve({ engagementId: eid }) });
  const post = (eid: string, body: Record<string, unknown>) => {
    const url = `http://t.test/api/ai-audit/${eid}`;
    const r = new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://t.test" }, body: JSON.stringify(body) }) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(url) });
    return route.POST(r as never, params(eid));
  };

  console.log("rooms");
  await check("the lead's room is found, or one is made for it: recorded, named for the call, and only one, even for two presses at once", async () => {
    const { eid, lead } = await engagementFor("Room Maker Co");
    assert.deepEqual(await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!), []);
    const press = () => link.createAuditRoom(db, { tenantId: OASIS, engagementId: eid, hostUserId: USERS.cc.id, now: NOW(), meet: meetUp });
    const [a, b] = await Promise.all([press(), press()]);
    assert.ok(a.ok && b.ok);
    assert.deepEqual([a.ok && a.created, b.ok && b.created].sort(), [false, true], "one press made it, the other found it");
    assert.equal(a.ok && a.roomId, b.ok && b.roomId);
    const again = await press();
    assert.ok(again.ok && !again.created && a.ok && again.roomId === a.roomId, "a later press makes no second room");
    const rooms = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!);
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].recordAudio, true);
    assert.match(rooms[0].title, /Discovery call/);
    const r = (await db.execute({ sql: "SELECT lead_id FROM meet_rooms WHERE id = ?", args: [rooms[0].id] })).rows[0];
    assert.equal(String(r.lead_id), lead);
    const made = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_events WHERE engagement_id = ? AND event = 'meet_room_created'", args: [eid] })).rows[0];
    assert.equal(Number(made.n), 1);
  });
  await check("a room is made only where a call can connect, recorded only where Meet records, and another once the only one has ended", async () => {
    const { eid, lead } = await engagementFor("Room Rules Co");
    const press = (meet: typeof meetUp) => link.createAuditRoom(db, { tenantId: OASIS, engagementId: eid, hostUserId: USERS.cc.id, now: NOW(), meet });
    assert.deepEqual(await press({ mediaReady: () => false, recordingAvailable: async () => true }), { ok: false, error: "meet_not_configured" });
    const count = async () => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM meet_rooms WHERE lead_id = ?", args: [lead] })).rows[0].n);
    assert.equal(await count(), 0, "no link that fails when it is opened");
    const quiet = await press({ mediaReady: () => true, recordingAvailable: async () => false });
    assert.ok(quiet.ok && quiet.created);
    const row = (await db.execute({ sql: "SELECT record_audio FROM meet_rooms WHERE id = ?", args: [quiet.ok ? quiet.roomId : ""] })).rows[0];
    assert.equal(Number(row.record_audio), 0, "guests are never asked to agree to a recording nobody makes");
    await db.execute({ sql: "UPDATE meet_rooms SET status = 'ended', ended_at = ? WHERE id = ?", args: [NOW().toISOString(), quiet.ok ? quiet.roomId : ""] });
    const next = await press(meetUp);
    assert.ok(next.ok && next.created && quiet.ok && next.roomId !== quiet.roomId, "the only room ended: another is made");
    assert.equal(await count(), 2);
  });

  console.log("transcripts");
  await check("a ready Meet transcript joins its engagement when every guest agreed and the owner recorded the AI answer; its lines are timed and scrubbed", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Attached Co");
    await aiAnswer(eid, true);
    await meetCall(lead, [{ name: "Dana Lee", consented: true }], call);
    assert.deepEqual(await tick(), { attached: 1, waiting: 0 });
    const list = await transcripts.listTranscripts(db, OASIS, eid, { withLines: true });
    assert.equal(list.length, 1);
    const t = list[0];
    assert.deepEqual([t.source, t.consent_recording, t.consent_ai, t.consent_basis, t.consent_by], ["meet", true, true, "meet_guests", USERS.cc.id]);
    assert.ok(t.meet_room_id);
    assert.ok(!(t.lines ?? []).some((l) => l.text.includes("4421")), "the alarm code was taken out");
    assert.equal((t.lines ?? [])[0].speaker, "Dana Lee");
    assert.deepEqual((t.lines ?? []).map((l) => l.t), ["00:00:00", "00:00:05", "00:00:10"]);
    assert.ok(t.redactions >= 1);
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 }, "attached once");
    assert.equal((await store.getEngagement(db, OASIS, eid))!.stage, "call_completed", "the transcript marks the call held");
  });
  await check("times are on the call's clock: Meet's epoch at_ms less the room's start, in order, never below zero; from the first line when the room has no start (review F1)", async () => {
    const { eid, lead } = await engagementFor("Clock Co");
    await aiAnswer(eid, true);
    const start = Date.parse("2026-10-20T15:00:00.000Z");
    const room = await meetCall(
      lead,
      [{ name: "Dana", consented: true }],
      [
        { speaker: "Dana", text: "An hour in, about the invoices.", at: 3700 },
        { speaker: "Dana", text: "Hello, can you hear me?", at: 1 },
        { speaker: "CC", text: "Yes. Tell me about the phones.", at: 65, by: "host" },
        { speaker: "Dana", text: "Said before the room started.", at: -2 },
      ],
      { startMs: start },
    );
    const r = await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: system(), now: NOW() });
    assert.ok(r.ok, JSON.stringify(r));
    const [t] = await transcripts.listTranscripts(db, OASIS, eid, { withLines: true });
    assert.deepEqual(
      (t.lines ?? []).map((l) => [l.t, l.text]),
      [
        ["00:00:00", "Said before the room started."],
        ["00:00:01", "Hello, can you hear me?"],
        ["00:01:05", "Yes. Tell me about the phones."],
        ["01:01:40", "An hour in, about the invoices."],
      ],
    );
    const other = await engagementFor("Clock No Start Co");
    await aiAnswer(other.eid, true);
    const noStart = await meetCall(other.lead, [{ name: "Sam", consented: true }], [{ speaker: "Sam", text: "Second thing.", at: 75 }, { speaker: "Sam", text: "First thing.", at: 10 }], { startMs: start, withStart: false });
    assert.ok((await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: other.eid, roomId: noStart, actor: system(), now: NOW() })).ok);
    const [u] = await transcripts.listTranscripts(db, OASIS, other.eid, { withLines: true });
    assert.deepEqual((u.lines ?? []).map((l) => l.t), ["00:00:00", "00:01:05"]);
  });
  await check("a client who declined AI analysis: attached with no AI consent, so nothing will be sent to a model", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Declined Co");
    await aiAnswer(eid, false);
    await meetCall(lead, [{ name: "Sam", consented: true }], call.slice(0, 1));
    assert.equal((await tick()).attached, 1);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.equal(t.consent_ai, false);
  });
  await check("no AI answer recorded: it waits for CC once, with an alert; the owner's later answer lifts the wait and the next run attaches it", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Waiting Co");
    const room = await meetCall(lead, [{ name: "Ana", consented: true }], call.slice(0, 1));
    const before = alerts.length;
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.equal(alerts.length - before, 1);
    assert.equal(alerts.at(-1)?.alertType, "ai_audit_meet_transcript_waiting");
    assert.match(String(alerts.at(-1)?.body), /answer about AI analysis is not on the profile/);
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 }, "listed once, not every run");
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), byOwner: true }), { ok: false, error: "ai_answer_needed" });
    await pause();
    await aiAnswer(eid, true);
    assert.deepEqual(await tick(), { attached: 1, waiting: 0 }, "the newer answer lifted the wait");
    assert.equal(alerts.length - before, 1, "no second alert");
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual([t.consent_ai, t.consent_by], [true, USERS.cc.id]);
  });
  await check("the owner attaches a waiting call by hand, saying what the client agreed to", async () => {
    await settle();
    const { eid, lead } = await engagementFor("By Hand Co");
    const room = await meetCall(lead, [{ name: "Ana", consented: true }], call.slice(0, 1));
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    const r = await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: false, byOwner: true });
    assert.ok(r.ok && !r.duplicate);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual([t.consent_ai, t.consent_by, t.consent_basis], [false, USERS.cc.id, "meet_guests"]);
  });
  await check("only the owner says the client's AI answer by hand: an admin is refused (403, nothing stored), the owner is not (review F2)", async () => {
    const { eid, lead } = await engagementFor("Admin Hand Co");
    const room = await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: admin, now: NOW(), ai: true }), { ok: false, error: "owner_only" });
    await login(USERS.admin);
    const refused = await post(eid, { action: "attach_meet_transcript", room_id: room, ai: true });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, "owner_only");
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0, "nothing stored");
    await login(USERS.cc);
    const done = await post(eid, { action: "attach_meet_transcript", room_id: room, ai: true });
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual([t.consent_ai, t.consent_by], [true, USERS.cc.id]);
    await login(null);
  });
  await check("the tick takes the profile's AI answer only when the owner saved it as what the client said: not an admin's, not a hypothesis (review F2)", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Whose Answer Co");
    await aiAnswer(eid, true, { by: admin });
    await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 }, "an admin's answer is not the client's yes");
    assert.deepEqual((await events(eid, link.MEET_TRANSCRIPT_NEEDS_AI_ANSWER)).map((e) => e.meta.reason), ["ai_answer_unconfirmed"]);
    assert.match(String(alerts.at(-1)?.body), /not saved by the workspace owner/);
    await pause();
    await aiAnswer(eid, true, { label: "hypothesis", source: "research" });
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 }, "the owner's hypothesis is not the client's yes either");
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0);
    await pause();
    await aiAnswer(eid, true);
    assert.deepEqual(await tick(), { attached: 1, waiting: 0 });
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual([t.consent_ai, t.consent_by], [true, USERS.cc.id]);
  });
  await check("a guest who did not agree to the recording: the transcript is never used, even by hand", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Refused Co");
    await aiAnswer(eid, true);
    const room = await meetCall(lead, [{ name: "Agreed", consented: true }, { name: "Not asked", consented: false }], call.slice(0, 1));
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true, byOwner: true }), { ok: false, error: "no_recording_consent" });
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0);
  });
  await check("another lead's room, a room no guest joined, and an engagement past Gate 1 attach nothing", async () => {
    const one = await engagementFor("First Lead Co");
    const other = await engagementFor("Second Lead Co");
    await aiAnswer(one.eid, true);
    const otherRoom = await meetCall(other.lead, [{ name: "Guest", consented: true }], call.slice(0, 1));
    const byHand = { actor: cc, now: NOW(), ai: true, byOwner: true };
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: one.eid, roomId: otherRoom, ...byHand }), { ok: false, error: "not_found" });
    const empty = await meetCall(one.lead, [], call.slice(0, 1));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: one.eid, roomId: empty, ...byHand }), { ok: false, error: "no_guests" });
    // Past Gate 1 (the stage the authorization moves it to): closed.
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'generating' WHERE id = ?", args: [one.eid] });
    const late = await meetCall(one.lead, [{ name: "Guest", consented: true }], call.slice(0, 1));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: one.eid, roomId: late, ...byHand }), { ok: false, error: "stage_closed" });
    await settle();
    assert.equal((await transcripts.listTranscripts(db, OASIS, one.eid)).length, 0);
  });
  await check("a second attach with the other AI answer is refused, and the stored answer stands (review F5)", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Second Answer Co");
    await aiAnswer(eid, true);
    const room = await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.equal((await tick()).attached, 1);
    const byHand = (ai: boolean) => link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai, byOwner: true });
    assert.deepEqual(await byHand(false), { ok: false, error: "attached_with_other_ai_answer" });
    await login(USERS.cc);
    const viaRoute = await post(eid, { action: "attach_meet_transcript", room_id: room, ai: false });
    assert.equal(viaRoute.status, 409);
    assert.equal(((await viaRoute.json()) as { error: string }).error, "attached_with_other_ai_answer");
    await login(null);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.equal(t.consent_ai, true, "the stored answer stands");
    const same = await byHand(true);
    assert.ok(same.ok && same.duplicate && same.transcriptId === t.id, "the same answer again is the same transcript");
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 1);
  });

  console.log("held for the owner's hand");
  await check("a Meet transcript CC deleted is never attached again by itself", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Deleted Again Co");
    await aiAnswer(eid, true);
    await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.equal((await tick()).attached, 1);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: t.id, actor: cc, now: NOW() }), { ok: true });
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 });
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0);
  });
  await check("a new cycle of the lead never picks up the last cycle's call, and a call that ended before the engagement opened waits for the owner's hand (review F3)", async () => {
    await settle();
    const first = await engagementFor("Two Cycles Co");
    await aiAnswer(first.eid, true);
    const cycleOneRoom = await meetCall(first.lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.equal((await tick()).attached, 1);
    const [t] = await transcripts.listTranscripts(db, OASIS, first.eid);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: first.eid, id: t.id, actor: cc, now: NOW() }), { ok: true });
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'cancelled', closed_at = ? WHERE id = ?", args: [NOW().toISOString(), first.eid] });
    // An older recorded call of the lead, never attached: it ended a day before the second cycle opened.
    const olderRoom = await meetCall(first.lead, [{ name: "Dana", consented: true }], call.slice(0, 1), { endedAt: new Date(Date.now() - 86_400_000).toISOString() });
    await pause();
    const o = await store.openEngagement(db, { tenantId: OASIS, leadId: first.lead, actor: cc, now: NOW(), isFixture: true });
    assert.ok(o.ok && o.created, "cycle 2 opened");
    const second = o.ok ? o.engagement.id : "";
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: second, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    await aiAnswer(second, true);
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 }, "neither old call is taken up by itself, and nothing is alerted for them");
    // Each rule holds on its own: a call an audit held before stays the owner's to attach even were its end stamped after this cycle opened.
    await db.execute({ sql: "UPDATE meet_rooms SET ended_at = ? WHERE id = ?", args: [NOW().toISOString(), cycleOneRoom] });
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 }, "attached once by any audit: never again by itself");
    assert.equal((await transcripts.listTranscripts(db, OASIS, second)).length, 0);
    const rooms = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, second))!);
    const holdsOf = (id: string) => rooms.find((r) => r.id === id)?.holds ?? [];
    assert.ok(holdsOf(cycleOneRoom).some((h) => /attached to an audit before/.test(h)), JSON.stringify(holdsOf(cycleOneRoom)));
    assert.ok(holdsOf(olderRoom).some((h) => /ended before this engagement was opened/.test(h)), JSON.stringify(holdsOf(olderRoom)));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: second, roomId: olderRoom, actor: system(), now: NOW() }), {
      ok: false,
      error: "held",
      holds: [{ hold: "before_engagement", words: "the call ended before this engagement was opened" }],
    });
    const byHand = await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: second, roomId: olderRoom, actor: cc, now: NOW(), ai: true, byOwner: true });
    assert.ok(byHand.ok && !byHand.duplicate, "the owner may attach it by hand");
  });
  await check("lost audio, a removed guest, or no guest heard: held for the owner's hand with the reason, once (review F6)", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Lost Audio Co");
    await aiAnswer(eid, true);
    const lost = await meetCall(lead, [{ name: "Dana", consented: true }], [{ speaker: "CC", text: "Can you hear me? Hello?", by: "host" }], { missingChunks: 120, recorderFailed: 120 });
    const before = alerts.length;
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.deepEqual((await events(eid, link.MEET_TRANSCRIPT_NEEDS_YOU)).map((e) => [e.room, e.meta.reason, e.meta.holds]), [[lost, "held", ["audio_missing", "no_guest_words"]]]);
    assert.equal(alerts.length - before, 1);
    assert.match(String(alerts.at(-1)?.body), /about 20 minutes of its audio did not reach the server; no guest's words are in the transcript/);
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 }, "listed once");
    const [room] = (await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!)).filter((r) => r.id === lost);
    assert.deepEqual(room.holds, ["about 20 minutes of its audio did not reach the server", "no guest's words are in the transcript"]);
    assert.equal((await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: lost, actor: admin, now: NOW() }) as { error?: string }).error, "held", "not by anyone else's press");
    const byHand = await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: lost, actor: cc, now: NOW(), ai: true, byOwner: true });
    assert.ok(byHand.ok, "the owner, having seen why, may attach it");

    const alone = await engagementFor("Removed Guest Co");
    await aiAnswer(alone.eid, true);
    const removed = await meetCall(alone.lead, [{ name: "Wrong Person", consented: true, removed: true }], [{ speaker: "CC", text: "I'll wait for Dana to join.", by: "host" }]);
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.deepEqual((await events(alone.eid, link.MEET_TRANSCRIPT_NEEDS_YOU)).map((e) => [e.room, e.meta.holds]), [[removed, ["guest_removed", "no_guest_words"]]]);
    const [held] = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, alone.eid))!);
    assert.deepEqual(held.guests, [{ name: "Wrong Person", consented: true, removed: true }]);
    assert.equal((await transcripts.listTranscripts(db, OASIS, alone.eid)).length, 0);

    const noisy = await engagementFor("Recorder Errors Co");
    await aiAnswer(noisy.eid, true);
    await meetCall(noisy.lead, [{ name: "Dana", consented: true }], call.slice(0, 1), { recorderErrored: 2 });
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.match(String(alerts.at(-1)?.body), /reported a problem, so part of its audio may be missing/);
  });

  console.log("the tick's queue");
  await check("a ready transcript with no lines is never picked, and calls that cannot be attached are listed once each: neither starves a good call (review F4)", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Queue Co");
    await aiAnswer(eid, true);
    const old = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    for (let i = 0; i < 5; i++) await meetCall(lead, [{ name: "Dana", consented: true }], [], { rawLines: [], updatedAt: old(60 - i) });
    const good = await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    const before = alerts.length;
    assert.deepEqual(await tick(), { attached: 1, waiting: 0 }, "five empty rooms first in line do not hold up the good call");
    assert.equal(alerts.length, before, "nothing to tell about a transcript with no lines");
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid))[0].meet_room_id, good);

    const next = await engagementFor("Queue Two Co");
    await aiAnswer(next.eid, true);
    const blank = [];
    // Lines whose words are only spaces: something to pick, nothing to attach.
    for (let i = 0; i < 5; i++) blank.push(await meetCall(next.lead, [{ name: "Dana", consented: true }], [{ speaker: "Dana", text: "   " }], { updatedAt: old(30 - i) }));
    const fine = await meetCall(next.lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.deepEqual(await tick(), { attached: 0, waiting: 5 }, "five that cannot be attached, each listed");
    assert.equal(alerts.length - before, 5, "one alert each");
    assert.deepEqual(new Set((await events(next.eid, link.MEET_TRANSCRIPT_NEEDS_YOU)).map((e) => e.room)), new Set(blank));
    assert.ok((await events(next.eid, link.MEET_TRANSCRIPT_NEEDS_YOU)).every((e) => e.meta.reason === "meet_transcript_empty"));
    assert.deepEqual(await tick(), { attached: 1, waiting: 0 }, "the next run reaches the good call");
    assert.equal((await transcripts.listTranscripts(db, OASIS, next.eid))[0].meet_room_id, fine);
    assert.deepEqual(await tick(), { attached: 0, waiting: 0 });
    assert.equal(alerts.length - before, 5, "and never alerts about them again");
  });
  await check("a Meet transcript over the 500 KB a paste may hold is refused whole, never cut", async () => {
    await settle();
    const big = Array.from({ length: 300 }, (_, i) => ({ speaker: "Dana", text: `${"word ".repeat(398)}line ${i}` }));
    assert.deepEqual(tr.parseMeetLines(big.map((l, i) => ({ t: i, speaker: l.speaker, text: l.text }))), { ok: false, error: "too_large" });
    assert.ok(tr.parseMeetLines(big.slice(0, 100).map((l, i) => ({ t: i, speaker: l.speaker, text: l.text }))).ok, "under the cap it parses");
    const { eid, lead } = await engagementFor("Long Call Co");
    await aiAnswer(eid, true);
    const room = await meetCall(lead, [{ name: "Dana", consented: true }], big);
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.match(String(alerts.at(-1)?.body), /over 500 KB/);
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true, byOwner: true }), { ok: false, error: "meet_transcript_too_large" });
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0, "nothing stored, nothing cut");
  });
  await check("an auto-attach withdraws a Gate 1 card it makes stale, as a pasted transcript does", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Stale Card Co", "call_completed");
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: "sales.leads_per_month", value: 40, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    await aiAnswer(eid, true);
    const card = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(card.ok, !card.ok ? card.error : "");
    const approvalId = card.ok ? card.approvalId : "";
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, approvalId))!.status, "pending");
    await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.deepEqual(await tick(), { attached: 1, waiting: 0 });
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, approvalId))!.status, "cancelled", "the card no longer binds what the engagement holds");
  });

  console.log("the room list");
  await check("the room list says what each room holds for the audit", async () => {
    const { eid, lead } = await engagementFor("Listed Co");
    await meetCall(lead, [{ name: "Dana", consented: true }, { name: "Sam", consented: false }], call.slice(0, 2));
    const [room] = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!);
    assert.deepEqual(room.transcript, { status: "ready", lines: 2 });
    assert.deepEqual(room.guests, [{ name: "Dana", consented: true, removed: false }, { name: "Sam", consented: false, removed: false }]);
    assert.equal(room.attachedTranscriptId, null);
    assert.deepEqual(room.holds, []);
    assert.ok(tr.parseMeetLines([{ t: 0, speaker: "Dana", text: "hi" }]).ok);
  });
  await check("the room list costs the same three reads however many rooms, and no transcript text leaves the database for it (review F7)", async () => {
    const { eid, lead } = await engagementFor("Many Rooms Co");
    for (let i = 0; i < 6; i++) await meetCall(lead, [{ name: "Dana", consented: true }, { name: "Sam", consented: true }], call);
    const { db: watched, seen } = counting(db);
    const rooms = await link.roomsForEngagement(watched, OASIS, (await store.getEngagement(db, OASIS, eid))!);
    assert.equal(rooms.length, 6);
    assert.ok(rooms.every((r) => r.transcript?.lines === 3 && r.guests.length === 2 && r.holds.length === 0));
    assert.equal(seen.length, 3, seen.map((q) => q.sql.slice(0, 60)).join(" | "));
    assert.ok(!seen.some((q) => q.columns.includes("lines_json") || q.columns.includes("text")), "no transcript text read back");
  });

  console.log("second review of phase 2c");
  await check("F1: the client's recorded no to the recording stands over Meet's join notice: never attached, by the tick or by hand, nor pasted", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Declined Recording Co");
    await aiAnswer(eid, true);
    const declined = await versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: "consent.recording", value: false, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    assert.equal((declined as { value?: unknown }).value, false, JSON.stringify(declined));
    const room = await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.deepEqual(await tick(), { attached: 0, waiting: 1 });
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true, byOwner: true }), { ok: false, error: "recording_declined" });
    const parsedText = (await import("../lib/ai-audit/transcript")).parseTranscriptText("Dana: We agreed after all.");
    assert.ok(parsedText.ok);
    const pasted = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: eid, parsed: parsedText.ok ? parsedText.value : (null as never), source: "paste", consent: { recording: true, ai: true, basis: "owner_attested", by: USERS.cc.id }, actor: cc, now: NOW() });
    assert.deepEqual(pasted, { ok: false, error: "recording_declined" });
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0);
    assert.ok(alerts.some((a) => String(a.body).includes("said no to the recording")), "the alert says why");
    // Corrected to Agreed, the call attaches.
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: "consent.recording", value: true, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    assert.ok((await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true, byOwner: true })).ok);
  });
  await check("F3: a Meet row with lines that are not objects is skipped: the page still reads, and the tick goes on to the next room", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Odd Rows Co");
    await aiAnswer(eid, true);
    const odd = await meetCall(lead, [{ name: "Dana", consented: true }], call, { rawLines: ["oops"] });
    const rooms = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!);
    assert.ok(rooms.some((r) => r.id === odd), "the page lists the room instead of failing");
    const nulls = await meetCall(lead, [{ name: "Dana", consented: true }], call, { rawLines: [null] });
    const good = await meetCall(lead, [{ name: "Dana", consented: true }], call);
    for (let i = 0; i < 5; i++) await tick();
    const attached = (await transcripts.listTranscripts(db, OASIS, eid)).map((x) => x.meet_room_id);
    assert.ok(attached.includes(good), "the good room after the bad ones is attached");
    assert.ok(!attached.includes(nulls) && !attached.includes(odd));
  });
  await check("F5: a room whose lines were pasted by hand is marked once under its own event, never as waiting, and never picked again", async () => {
    await settle();
    const { eid, lead } = await engagementFor("Pasted First Co");
    await aiAnswer(eid, true);
    const room = await meetCall(lead, [{ name: "Dana", consented: true }], call);
    // Attached by hand first (as another run would have, a moment before): the same lines, so the tick finds a duplicate.
    const first = await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true, byOwner: true });
    assert.ok(first.ok);
    await tick();
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 1);
    assert.deepEqual(await events(eid, link.MEET_TRANSCRIPT_NEEDS_YOU), [], "nothing waits on an attached room");
  });

  finish("ai-audit-meet-link");
}

function system() {
  return { type: "system" as const, id: null };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
