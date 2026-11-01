/**
 * tests/ai-audit-auto-open.test.ts — every founder meeting still ahead gets
 * its Free AI Audit opened by the tick, tied to its appointment and room
 * (lib/ai-audit/auto-open.ts; CC, 2026-11-01).
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-auto-open.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, check, finish, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

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
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

async function apply(db: Client, file: string) {
  for (const stmt of splitStatements(readFileSync(join(process.cwd(), "database", "turso", file), "utf8"))) await db.execute(stmt);
}

const NOW = new Date("2026-11-01T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString();
const lead = (n: number) => `7a000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const appt = (n: number) => `7b000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const room = (n: number) => `7d000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

/** The columns of call_appointments that auto-open reads (the full table is a sales migration). */
const CALL_APPOINTMENTS = `CREATE TABLE call_appointments (
  id text primary key, tenant_id text not null, lead_id text not null, entity_type text not null,
  scheduled_for text not null, status text not null, workflow_status text not null,
  calendar_status text not null, meet_room_id text, meeting_kind text not null default 'founder_audit')`;

async function main() {
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of [
    "bravo__186_os_approvals.sql",
    "bravo__206_tool_jobs.sql",
    "bravo__237_ai_audit_core.sql",
    "bravo__238_ai_audit_delivery.sql",
    "bravo__239_ai_audit_discovery.sql",
    "bravo__241_ai_audit_briefs.sql",
  ]) await apply(db, f);
  const autoOpen = await import("../lib/ai-audit/auto-open");
  const store = await import("../lib/ai-audit/store");
  const meetingLinks = await import("../lib/ai-audit/meeting-links");
  const tick = await import("../lib/ai-audit/tick");
  // The client's website, served by a fake web: the brief reads it, never the real internet.
  const SITE = "<html><head><title>Fixture</title></head><body><p>We fix things in Montreal.</p></body></html>";
  const requested: string[] = [];
  let clock = 0;
  const site = {
    fetch: (async (url: string) => {
      requested.push(url);
      if (new URL(url).hostname === "fixture-plumbing.ca" && new URL(url).pathname === "/") return new Response(SITE, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    }) as never,
    clock: () => (clock += 10),
  };
  const tickDeps = () => ({ payment: { alert: async () => undefined } as never, onboarding: {} as never, site });

  const addLead = (n: number, stage: string) =>
    db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [lead(n), OASIS, JSON.stringify({ stage, company: `[TEST] Auto ${n}`, name: "Test Owner", email: `auto${n}@fixture.test`, website: "fixture-plumbing.ca" })],
    });
  const addMeeting = (n: number, hours: number, state: { status?: string; workflow?: string; calendar?: string; room?: string | null } = {}) =>
    db.execute({
      sql: `INSERT INTO call_appointments (id, tenant_id, lead_id, entity_type, scheduled_for, status, workflow_status, calendar_status, meet_room_id)
            VALUES (?, ?, ?, 'lead', ?, ?, ?, ?, ?)`,
      args: [appt(n), OASIS, lead(n), at(hours), state.status ?? "scheduled", state.workflow ?? "active", state.calendar ?? "verified", state.room === undefined ? room(n) : state.room],
    });
  const openFor = async (n: number) => store.getOpenEngagementForLead(db, OASIS, lead(n));

  await check("without call_appointments the step does nothing and reports nothing", async () => {
    assert.equal(await autoOpen.callAppointmentsInstalled(db), false);
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.auditsOpened, 0);
    assert.deepEqual(rep.errors.filter((e) => e.step === "auto_open"), []);
  });

  await db.execute(CALL_APPOINTMENTS);

  await check("a booked founder meeting still ahead gets its audit at Meeting booked, tied to the appointment and the room", async () => {
    await addLead(1, "founder_meeting_booked");
    await addMeeting(1, 29);
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.auditsOpened, 1);
    assert.equal(rep.meetingsLinked, 1);
    const e = await openFor(1);
    assert.ok(e, "the engagement is open");
    assert.equal(e.stage, "call_scheduled");
    assert.equal(e.appointment_id, appt(1));
    assert.equal(e.meet_room_id, room(1));
    assert.equal(e.created_by, null, "opened by the system, not by a person");
    const events = await db.execute({ sql: "SELECT event, ref_id FROM ai_audit_events WHERE engagement_id = ? ORDER BY created_at, event", args: [e.id] });
    const names = events.rows.map((r) => String(r.event));
    assert.equal(names.filter((x) => x === "opened").length, 1);
    assert.equal(names.filter((x) => x === "meeting_linked").length, 1);
    assert.equal(events.rows.find((r) => r.event === "meeting_linked")?.ref_id, appt(1));
    // The point of opening it at booking: the pre-call brief is built in the same run, from the client's site.
    assert.equal(rep.briefsBuilt, 1);
    assert.ok(requested.some((u) => new URL(u).hostname === "fixture-plumbing.ca"), `the brief read the client's website (read: ${requested.join(", ")})`);
    const briefs = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_briefs WHERE tenant_id = ? AND engagement_id = ?", args: [OASIS, e.id] });
    assert.equal(Number(briefs.rows[0].n), 1);
  });

  await check("a second run opens nothing more and links nothing again", async () => {
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.auditsOpened, 0);
    assert.equal(rep.meetingsLinked, 0);
    const n = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_engagements WHERE lead_id = ?", args: [lead(1)] });
    assert.equal(Number(n.rows[0].n), 1);
  });

  await check("past, cancelled, no-show and unverified meetings open nothing", async () => {
    await addLead(2, "founder_meeting_booked");
    await addMeeting(2, -3);
    await addLead(3, "founder_meeting_booked");
    await addMeeting(3, 30, { status: "cancelled", workflow: "cancelled", calendar: "cancelled" });
    await addLead(4, "founder_meeting_booked");
    await addMeeting(4, 30, { status: "no_answer", workflow: "no_show" });
    await addLead(5, "founder_meeting_booked");
    await addMeeting(5, 30, { calendar: "pending" });
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.auditsOpened, 0);
    for (const n of [2, 3, 4, 5]) assert.equal(await openFor(n), null, `lead ${n} has no audit`);
  });

  await check("a lead marked Lost gets no audit, and the run carries on", async () => {
    await addLead(6, "lost");
    await addMeeting(6, 31);
    await addLead(7, "founder_meeting_booked");
    await addMeeting(7, 32, { room: null });
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(await openFor(6), null);
    assert.equal(rep.auditsOpened, 1);
    const e = await openFor(7);
    assert.equal(e?.appointment_id, appt(7));
    assert.equal(e?.meet_room_id, null, "no room on the appointment: none is invented");
    assert.deepEqual(rep.errors.filter((x) => x.step === "auto_open"), []);
  });

  await check("an audit the owner already tied to another appointment keeps it", async () => {
    await addLead(8, "founder_meeting_booked");
    const opened = await store.openEngagement(db, { tenantId: OASIS, leadId: lead(8), actor: { type: "user", id: null }, now: NOW });
    assert.ok(opened.ok);
    const set = await store.patchEngagement(db, {
      tenantId: OASIS,
      id: opened.engagement.id,
      expectedRowVersion: opened.engagement.row_version,
      patch: { appointment_id: "another-appointment" },
      event: "meeting_linked",
      actor: { type: "user", id: null },
      now: NOW,
    });
    assert.ok(set.ok);
    await addMeeting(8, 33);
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.meetingsLinked, 0);
    const e = await openFor(8);
    assert.equal(e?.appointment_id, "another-appointment");
    assert.equal(e?.meet_room_id, null);
  });

  await check("meetings with nothing left to do never use up the limit: an eleventh meeting is still reached (CodeRabbit on #789)", async () => {
    // Ten Lost leads with meetings sooner than the one that needs an audit.
    for (let n = 20; n < 20 + autoOpen.AUTO_OPEN_LIMIT; n += 1) {
      await addLead(n, "lost");
      await addMeeting(n, 1 + (n - 20) / 10);
    }
    await addLead(40, "founder_meeting_booked");
    await addMeeting(40, 50);
    const pending = await autoOpen.upcomingFounderMeetings(db, OASIS, NOW);
    assert.deepEqual(pending.map((m) => m.lead_id), [lead(40)], "only the meeting with work left is listed");
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.auditsOpened, 1);
    assert.equal((await openFor(40))?.appointment_id, appt(40));
  });

  await check("a sales call is not a founder audit: it opens nothing (CodeRabbit on #789)", async () => {
    await addLead(42, "founder_meeting_booked");
    await addMeeting(42, 52);
    await db.execute({ sql: "UPDATE call_appointments SET meeting_kind = 'sales_call' WHERE id = ?", args: [appt(42)] });
    await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(await openFor(42), null);
  });

  await check("a reschedule that replaced the room moves the engagement's room link with it (CodeRabbit on #789)", async () => {
    await db.execute({ sql: "UPDATE call_appointments SET meet_room_id = ? WHERE id = ?", args: ["room-replaced", appt(1)] });
    const rep = await tick.runAiAuditTick(db, { tenantIds: [OASIS], now: () => NOW, deps: tickDeps() });
    assert.equal(rep.meetingsLinked, 1);
    const e = await openFor(1);
    assert.equal(e?.appointment_id, appt(1));
    assert.equal(e?.meet_room_id, "room-replaced");
  });

  await check("a lead row with broken JSON does not stop the query", async () => {
    await db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)", args: [lead(41), OASIS, "{not json"] });
    await addMeeting(41, 51);
    await autoOpen.upcomingFounderMeetings(db, OASIS, NOW);
  });

  await check("targeted reconciliation touches only requested leads and an empty list does nothing", async () => {
    await addLead(50, "founder_meeting_booked");
    await addMeeting(50, 55);
    await addLead(51, "founder_meeting_booked");
    await addMeeting(51, 56);
    assert.deepEqual(await autoOpen.autoOpenForBookedMeetings(db, { tenantId: OASIS, now: NOW, leadIds: [] }), { opened: 0, linked: 0 });
    const rep = await autoOpen.autoOpenForBookedMeetings(db, { tenantId: OASIS, now: NOW, leadIds: [lead(50)] });
    assert.deepEqual(rep, { opened: 1, linked: 1 });
    assert.equal(await openFor(51), null);
  });

  await check("cancel detaches the meeting but preserves the audit and rebooking reuses it", async () => {
    const before = (await openFor(50))!;
    const input = { tenantId: OASIS, leadId: lead(50), appointmentId: appt(50), now: NOW };
    assert.equal(await meetingLinks.unlinkCancelledAuditMeeting(db, input), 0, "an active meeting cannot be detached");
    await db.execute({ sql: "UPDATE call_appointments SET status='cancelled', workflow_status='cancelled', calendar_status='cancelled' WHERE id=?", args: [appt(50)] });
    assert.equal(await meetingLinks.unlinkCancelledAuditMeeting(db, { ...input, tenantId: "other-tenant" }), 0);
    assert.equal(await meetingLinks.unlinkCancelledAuditMeeting(db, { ...input, leadId: lead(51) }), 0);
    assert.equal(await meetingLinks.unlinkCancelledAuditMeeting(db, input), 1);
    assert.equal(await meetingLinks.unlinkCancelledAuditMeeting(db, input), 0, "retry is idempotent");
    const detached = (await openFor(50))!;
    assert.equal(detached.id, before.id);
    assert.equal(detached.stage, before.stage);
    assert.equal(detached.closed_at, null);
    assert.equal(detached.appointment_id, null);
    assert.equal(detached.meet_room_id, null);
    assert.equal(detached.row_version, before.row_version + 1);
    await db.execute({
      sql: `INSERT INTO call_appointments (id,tenant_id,lead_id,entity_type,scheduled_for,status,workflow_status,calendar_status,meet_room_id)
            VALUES (?,?,?,'lead',?,'scheduled','active','verified',?)`,
      args: [appt(52), OASIS, lead(50), at(57), room(52)],
    });
    assert.deepEqual(await autoOpen.autoOpenForBookedMeetings(db, { tenantId: OASIS, now: NOW, leadIds: [lead(50)] }), { opened: 0, linked: 1 });
    const relinked = (await openFor(50))!;
    assert.equal(relinked.id, before.id);
    assert.equal(relinked.appointment_id, appt(52));
    assert.equal(relinked.meet_room_id, room(52));
    assert.equal(await meetingLinks.unlinkCancelledAuditMeeting(db, input), 0, "late old cancellation cannot clear the new booking");
    const events = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_events WHERE engagement_id=? AND event='meeting_unlinked'", args: [before.id] });
    assert.equal(Number(events.rows[0].n), 1);
  });

  await check("detach and its history are one transaction; a failed history insert leaves links intact for repair", async () => {
    await autoOpen.autoOpenForBookedMeetings(db, { tenantId: OASIS, now: NOW, leadIds: [lead(51)] });
    const before = (await openFor(51))!;
    await db.execute({ sql: "UPDATE call_appointments SET status='cancelled', workflow_status='cancelled', calendar_status='cancelled' WHERE id=?", args: [appt(51)] });
    await db.execute("CREATE TRIGGER reject_unlink BEFORE INSERT ON ai_audit_events WHEN NEW.event='meeting_unlinked' BEGIN SELECT RAISE(ABORT, 'fixture_event_write_failure'); END");
    await assert.rejects(meetingLinks.unlinkCancelledAuditMeeting(db, { tenantId: OASIS, leadId: lead(51), appointmentId: appt(51), now: NOW }), /fixture_event_write_failure/);
    assert.equal((await openFor(51))?.appointment_id, appt(51));
    assert.equal((await openFor(51))?.row_version, before.row_version);
    await db.execute("DROP TRIGGER reject_unlink");
    await meetingLinks.repairCancelledAuditMeetingLinks(db, OASIS, NOW);
    assert.equal((await openFor(51))?.appointment_id, null);
  });

  await check("a meeting cancelled after the scan cannot be linked by the old scan result", async () => {
    await addLead(53, "founder_meeting_booked");
    await addMeeting(53, 60);
    const raced = new Proxy(db, {
      get(target, key) {
        if (key === "execute") return async (statement: Parameters<Client["execute"]>[0]) => {
          const result = await target.execute(statement);
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.startsWith("SELECT a.id, a.lead_id")) await db.execute({
            sql: "UPDATE call_appointments SET status='cancelled', workflow_status='cancelled', calendar_status='cancelled' WHERE id=?", args: [appt(53)],
          });
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const rep = await autoOpen.autoOpenForBookedMeetings(raced, { tenantId: OASIS, now: NOW, leadIds: [lead(53)] });
    assert.equal(rep.linked, 0);
    assert.equal((await openFor(53))?.appointment_id, null);
  });

  await check("the tick's auto-open runs before the engagement list, so a new audit is in the same run's work", async () => {
    const src = readFileSync(join(process.cwd(), "lib", "ai-audit", "tick.ts"), "utf8");
    assert.ok(src.indexOf('guard("auto_open"') > 0 && src.indexOf('guard("auto_open"') < src.indexOf('guard("list"'));
  });

  finish("ai-audit-auto-open");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
