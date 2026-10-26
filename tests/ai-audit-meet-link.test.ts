/**
 * Free AI Audit, phase 2c: a discovery call held in Oasis Meet joins its
 * engagement (lib/ai-audit/meet-link.ts).
 *
 * - The lead's room is found, or one is made for it (recorded, and only one).
 * - A ready Meet transcript is attached by the tick only when every guest
 *   agreed to the recording in Meet and the client's AI answer is on the
 *   profile; its lines are scrubbed; the AI answer, yes or no, is the
 *   transcript's AI consent.
 * - Without an AI answer, or with a guest who did not agree, it waits for CC
 *   once (an event and an alert), and CC attaches it by hand.
 * - After Gate 1, and for another lead's room, nothing is attached.
 * - A transcript attached once and deleted is never attached again by itself.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-meet-link.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, USERS, check, finish, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

const NOW = () => new Date();

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
  const link = await import("../lib/ai-audit/meet-link");
  const tr = await import("../lib/ai-audit/transcript");

  const cc = { type: "user" as const, id: USERS.cc.id };
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
  /** A finished Meet call: a room for the lead, its guests, and a ready transcript. */
  const meetCall = async (lead: string, guests: Array<{ name: string; consented: boolean }>, lines: Array<{ speaker: string; text: string }>) => {
    const roomId = crypto.randomUUID();
    const at = NOW().toISOString();
    await db.execute({
      sql: "INSERT INTO meet_rooms (id, tenant_id, code, title, host_user_id, status, record_audio, starts_at, calendar_event_id, lead_id, created_at, started_at, ended_at, ended_reason) VALUES (?, ?, ?, 'Discovery call', ?, 'ended', 1, NULL, NULL, ?, ?, ?, ?, 'host_ended')",
      args: [roomId, OASIS, `code-${roomId.slice(0, 8)}`, USERS.cc.id, lead, at, at, at],
    });
    await db.execute({ sql: "INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, joined_at, last_seen_at) VALUES (?, ?, ?, 'host', ?, 'CC', ?, ?, ?)", args: [crypto.randomUUID(), OASIS, roomId, USERS.cc.id, at, at, at] });
    let order = 0;
    for (const g of guests) {
      // Guests join one after another, as they do in a real call.
      order += 1;
      const joined = new Date(Date.parse(at) + order * 1000).toISOString();
      await db.execute({ sql: "INSERT INTO meet_participants (id, tenant_id, room_id, role, user_id, display_name, consent_at, joined_at, last_seen_at) VALUES (?, ?, ?, 'guest', NULL, ?, ?, ?, ?)", args: [crypto.randomUUID(), OASIS, roomId, g.name, g.consented ? joined : null, joined, joined] });
    }
    const meetLines = lines.map((l, i) => ({ at_ms: i * 5000, end_ms: i * 5000 + 4000, participant_id: "p", speaker: l.speaker, text: l.text }));
    await db.execute({
      sql: "INSERT INTO meet_transcripts (id, tenant_id, room_id, status, lines_json, text, relay_expires_at, created_at, updated_at, ready_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), OASIS, roomId, JSON.stringify(meetLines), lines.map((l) => l.text).join(" "), new Date(Date.now() + 30 * 86_400_000).toISOString(), at, at, at],
    });
    return roomId;
  };
  const aiAnswer = (eid: string, value: boolean) =>
    versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: "consent.ai_processing", value, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
  const alerts: Array<Record<string, unknown>> = [];
  const alert = async (a: Record<string, unknown>) => void alerts.push(a);
  const call = [
    { speaker: "Dana Lee", text: "We get about 40 calls a week and miss a third of them." },
    { speaker: "CC", text: "And the alarm code for the shop?" },
    { speaker: "Dana Lee", text: "The alarm code is 4421 but please do not write that down." },
  ];

  console.log("rooms");
  await check("the lead's room is found, or one is made for it: recorded, named for the call, and only one", async () => {
    const { eid, lead } = await engagementFor("Room Maker Co");
    assert.deepEqual(await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!), []);
    const a = await link.createAuditRoom(db, { tenantId: OASIS, engagementId: eid, hostUserId: USERS.cc.id, now: NOW() });
    assert.ok(a.ok && a.created);
    const again = await link.createAuditRoom(db, { tenantId: OASIS, engagementId: eid, hostUserId: USERS.cc.id, now: NOW() });
    assert.ok(again.ok && !again.created && a.ok && again.roomId === a.roomId, "a second press makes no second room");
    const rooms = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!);
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].recordAudio, true);
    assert.match(rooms[0].title, /Discovery call/);
    const r = (await db.execute({ sql: "SELECT lead_id FROM meet_rooms WHERE id = ?", args: [rooms[0].id] })).rows[0];
    assert.equal(String(r.lead_id), lead);
  });

  console.log("transcripts");
  await check("a ready Meet transcript joins its engagement when every guest agreed and the AI answer is recorded; its lines are scrubbed", async () => {
    const { eid, lead } = await engagementFor("Attached Co");
    await aiAnswer(eid, true);
    await meetCall(lead, [{ name: "Dana Lee", consented: true }], call);
    const r = await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert);
    assert.deepEqual(r, { attached: 1, waiting: 0 });
    const list = await transcripts.listTranscripts(db, OASIS, eid, { withLines: true });
    assert.equal(list.length, 1);
    const t = list[0];
    assert.deepEqual([t.source, t.consent_recording, t.consent_ai, t.consent_basis], ["meet", true, true, "meet_guests"]);
    assert.ok(t.meet_room_id);
    assert.ok(!(t.lines ?? []).some((l) => l.text.includes("4421")), "the alarm code was taken out");
    assert.equal((t.lines ?? [])[0].speaker, "Dana Lee");
    assert.equal((t.lines ?? [])[1].t, "00:00:05");
    assert.ok(t.redactions >= 1);
    assert.deepEqual(await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert), { attached: 0, waiting: 0 }, "attached once");
    assert.equal((await store.getEngagement(db, OASIS, eid))!.stage, "call_completed", "the transcript marks the call held");
  });
  await check("a client who declined AI analysis: attached with no AI consent, so nothing will be sent to a model", async () => {
    const { eid, lead } = await engagementFor("Declined Co");
    await aiAnswer(eid, false);
    await meetCall(lead, [{ name: "Sam", consented: true }], call.slice(0, 1));
    assert.equal((await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert)).attached, 1);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.equal(t.consent_ai, false);
  });
  await check("no AI answer recorded: it waits for CC once, with an alert, and CC attaches it by hand with the answer", async () => {
    const { eid, lead } = await engagementFor("Waiting Co");
    const room = await meetCall(lead, [{ name: "Ana", consented: true }], call.slice(0, 1));
    const before = alerts.length;
    assert.deepEqual(await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert), { attached: 0, waiting: 1 });
    assert.equal(alerts.length - before, 1);
    assert.equal(alerts.at(-1)?.alertType, "ai_audit_meet_transcript_waiting");
    assert.deepEqual(await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert), { attached: 0, waiting: 0 }, "listed once, not every minute");
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW() }), { ok: false, error: "ai_answer_needed" });
    const r = await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true });
    assert.ok(r.ok && !r.duplicate);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual([t.consent_ai, t.consent_by], [true, USERS.cc.id]);
  });
  await check("a guest who did not agree to the recording: the transcript is never used, even by hand", async () => {
    const { eid, lead } = await engagementFor("Refused Co");
    await aiAnswer(eid, true);
    const room = await meetCall(lead, [{ name: "Agreed", consented: true }, { name: "Not asked", consented: false }], call.slice(0, 1));
    assert.deepEqual(await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert), { attached: 0, waiting: 1 });
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: eid, roomId: room, actor: cc, now: NOW(), ai: true }), { ok: false, error: "no_recording_consent" });
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0);
  });
  await check("another lead's room, a room no guest joined, and an engagement past Gate 1 attach nothing", async () => {
    const one = await engagementFor("First Lead Co");
    const other = await engagementFor("Second Lead Co");
    await aiAnswer(one.eid, true);
    const otherRoom = await meetCall(other.lead, [{ name: "Guest", consented: true }], call.slice(0, 1));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: one.eid, roomId: otherRoom, actor: cc, now: NOW(), ai: true }), { ok: false, error: "not_found" });
    const empty = await meetCall(one.lead, [], call.slice(0, 1));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: one.eid, roomId: empty, actor: cc, now: NOW(), ai: true }), { ok: false, error: "no_guests" });
    // Past Gate 1 (the stage the authorization moves it to): closed.
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'generating' WHERE id = ?", args: [one.eid] });
    const late = await meetCall(one.lead, [{ name: "Guest", consented: true }], call.slice(0, 1));
    assert.deepEqual(await link.attachMeetTranscript(db, { tenantId: OASIS, engagementId: one.eid, roomId: late, actor: cc, now: NOW(), ai: true }), { ok: false, error: "stage_closed" });
    const fromTick = await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert);
    assert.equal(fromTick.attached, 0);
  });
  await check("a Meet transcript CC deleted is never attached again by itself", async () => {
    const { eid, lead } = await engagementFor("Deleted Again Co");
    await aiAnswer(eid, true);
    await meetCall(lead, [{ name: "Dana", consented: true }], call.slice(0, 1));
    assert.equal((await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert)).attached, 1);
    const [t] = await transcripts.listTranscripts(db, OASIS, eid);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: t.id, actor: cc, now: NOW() }), { ok: true });
    assert.equal((await link.autoAttachMeetTranscripts(db, OASIS, NOW(), alert)).attached, 0);
    assert.equal((await transcripts.listTranscripts(db, OASIS, eid)).length, 0);
  });
  await check("the room list says what each room holds for the audit", async () => {
    const { eid, lead } = await engagementFor("Listed Co");
    await meetCall(lead, [{ name: "Dana", consented: true }, { name: "Sam", consented: false }], call.slice(0, 2));
    const [room] = await link.roomsForEngagement(db, OASIS, (await store.getEngagement(db, OASIS, eid))!);
    assert.deepEqual(room.transcript, { status: "ready", lines: 2 });
    assert.deepEqual(room.guests, [{ name: "Dana", consented: true }, { name: "Sam", consented: false }]);
    assert.equal(room.attachedTranscriptId, null);
    assert.ok(tr.parseMeetLines([{ t: 0, speaker: "Dana", text: "hi" }]).ok);
  });

  finish("ai-audit-meet-link");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
