/**
 * The rebook link and the no-show close-out (CC, 2026-10-28): a missed founder
 * meeting is recorded as a no-show, the lead gets a link that moves THAT
 * meeting, and the link cannot be replayed, forged or used on a meeting that
 * has not happened yet. Runs against a real in-memory libSQL database with the
 * founder-meeting migrations applied.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import { transition_pipeline_lead } from "../lib/turso-rpc-shim";
import {
  REBOOK_TOKEN_TTL_S,
  RebookNotConfiguredError,
  rebookUrl,
  signRebookToken,
  verifyRebookToken,
} from "../lib/booking/rebook-token";
import { firstNameOf, pickRebookSlot, readRebookState, rebookHosts, rebookLeadPatch } from "../lib/booking/rebook";
import { markFounderMeetingNoShow } from "../lib/booking/no-show";
import {
  activateVerifiedFounderMeeting,
  closeVerifiedFounderMeeting,
  rescheduleVerifiedFounderMeeting,
} from "../lib/website-sales-founder-meeting";

const KEY = "k".repeat(48);
process.env.FORM_LINK_HMAC_KEY = KEY;
const ENV = { FORM_LINK_HMAC_KEY: KEY };

const TENANT = "tenant-a";
const LEAD = "lead-a";
const APPT = "appt-a";
const HOST = "founder-a";
const ORGANIZER = "founder@oasisai.work";
const MISSED = "2026-10-28T16:00:00.000Z";
const NOW = Date.parse("2026-10-28T20:00:00.000Z");
const NEW_TIME = "2026-10-30T15:00:00.000Z";

const SCHEMA = `
  CREATE TABLE tenants (id TEXT PRIMARY KEY);
  CREATE TABLE call_appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'lead',
    scheduled_for TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled', 'completed', 'no_answer', 'cancelled', 'rescheduled')),
    pre_call_note TEXT,
    outcome_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE tenant_records (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT,
    type TEXT NOT NULL DEFAULT 'note',
    channel TEXT NOT NULL DEFAULT 'system',
    direction TEXT,
    agent_source TEXT,
    actor_user_id TEXT,
    subject TEXT,
    content TEXT,
    content_preview TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX website_sales_interaction_request_uidx
    ON lead_interactions (tenant_id, json_extract(metadata, '$.request_id'))
    WHERE agent_source = 'website_sales_pipeline'
      AND json_extract(metadata, '$.request_id') IS NOT NULL;
  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    appointment_id TEXT,
    start_at TEXT,
    end_at TEXT,
    description TEXT,
    location TEXT,
    updated_at TEXT
  );
`;

async function fixture() {
  // A file, not :memory:: transition_pipeline_lead opens a write transaction, which is a second connection.
  const raw = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "meeting-rebook-")), "db.sqlite")}` });
  const migrations = [
    "database/turso/167_founder_meeting_closed_loop.turso.sql",
    "database/turso/169_founder_meeting_reminder_tiers.turso.sql",
    "database/turso/bravo__224_public_booking_offer_label.sql",
    "database/turso/bravo__232_booking_meet_room.sql",
  ].map((path) => readFileSync(path, "utf8"));
  await raw.executeMultiple(`${SCHEMA}\n${migrations.join("\n")}`);
  const base = createTursoPostgrest(raw) as unknown as { from: (table: string) => unknown };
  // The service client's rpc() for the one RPC these paths call, as lib/supabase-server.ts wires it.
  const db = {
    from: (table: string) => base.from(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "transition_pipeline_lead");
      try {
        return { data: await transition_pipeline_lead(raw, args), error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
  const calendarUpdates: string[] = [];
  const meetingDeps = {
    db: db as never,
    now: () => NOW,
    updateCalendar: async (input: { meetingAt: string; meetingLink?: string }) => {
      calendarUpdates.push(input.meetingAt);
      return {
        calendarId: "primary",
        eventId: "event-a",
        htmlLink: "https://calendar.google.com/calendar/event?eid=a",
        meetLink: input.meetingLink || "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-a",
        organizerEmail: ORGANIZER,
      };
    },
    memberStanding: async () => ({ standing: "active" as const, member: null }),
  };
  await raw.execute({
    sql: `INSERT INTO call_appointments (
      id, tenant_id, lead_id, entity_type, scheduled_for, assigned_to, status, created_by,
      meeting_kind, duration_minutes, timezone, client_name_snapshot, company_snapshot,
      client_email_snapshot, client_phone_snapshot, client_agenda, handoff_note,
      google_calendar_id, google_event_id, google_event_html_link, google_meet_link, google_ical_uid,
      calendar_status, organizer_email_snapshot, booking_request_id, revision, workflow_status, sms_consent,
      offer_label
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      APPT, TENANT, LEAD, "lead", MISSED, HOST, "scheduled", HOST,
      "founder_audit", 15, "America/Toronto", "Gideon Boniface", "Rice farm",
      "gideon@example.com", "+2348153169177", "A 15-minute AI audit call.", "Public ai-audit booking.",
      "primary", "event-a", "https://calendar.google.com/calendar/event?eid=a",
      "https://meet.google.com/abc-defg-hij", "ical-a",
      "verified", ORGANIZER, "booking-a", 1, "active", 0,
      "AI automation audit",
    ],
  });
  await raw.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [LEAD, TENANT, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: APPT, company: "Rice farm" })],
  });
  return { raw, db, meetingDeps, calendarUpdates };
}

async function appointmentRow(raw: Client) {
  return (await raw.execute({ sql: "SELECT * FROM call_appointments WHERE id = ?", args: [APPT] })).rows[0];
}

async function leadData(raw: Client): Promise<Record<string, unknown>> {
  const row = (await raw.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [LEAD] })).rows[0];
  return JSON.parse(String(row.data)) as Record<string, unknown>;
}

function testToken() {
  const claims = { tenantId: TENANT, appointmentId: APPT, leadId: LEAD };
  const token = signRebookToken(claims, { nowMs: NOW, env: ENV });
  const verified = verifyRebookToken(token, { nowMs: NOW, env: ENV });
  assert.deepEqual(verified && { ...verified, exp: 0 }, { ...claims, exp: 0 });
  assert.equal(verified?.exp, Math.floor(NOW / 1000) + REBOOK_TOKEN_TTL_S, "the link lasts two weeks");

  assert.equal(verifyRebookToken(token, { nowMs: NOW + REBOOK_TOKEN_TTL_S * 1000 + 1000, env: ENV }), null, "an expired link is refused");
  const [payload, sig] = token.split(".");
  const flipped = `${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
  assert.equal(verifyRebookToken(flipped, { nowMs: NOW, env: ENV }), null, "a changed signature is refused");
  const forged = Buffer.from(JSON.stringify({ v: 1, t: TENANT, a: "appt-other", l: LEAD, exp: 9e9 })).toString("base64url");
  assert.equal(verifyRebookToken(`${forged}.${sig}`, { nowMs: NOW, env: ENV }), null, "a payload swapped under an old signature is refused");
  assert.equal(
    verifyRebookToken(token, { nowMs: NOW, env: { FORM_LINK_HMAC_KEY: "z".repeat(48) } }),
    null,
    "a token signed under another key is refused",
  );
  assert.equal(verifyRebookToken("", { nowMs: NOW, env: ENV }), null);
  assert.equal(verifyRebookToken("a.b.c", { nowMs: NOW, env: ENV }), null);
  assert.throws(() => signRebookToken(claims, { env: {} }), RebookNotConfiguredError, "no key, no link");
  assert.throws(() => verifyRebookToken(token, { env: { FORM_LINK_HMAC_KEY: "short" } }), RebookNotConfiguredError);
  assert.equal(rebookUrl("https://oasisai.work/", "abc.def"), "https://oasisai.work/book/rebook/abc.def");
}

function testPureHelpers() {
  assert.equal(firstNameOf("  Gideon Boniface "), "Gideon");
  assert.equal(firstNameOf(null), "");
  const cc = { userId: HOST, role: "organizer", email: ORGANIZER, displayName: "CC" };
  const slots = [
    { start: "2026-10-30T15:00:00.000Z", hosts: [cc] },
    { start: "2026-10-30T16:00:00.000Z", hosts: [{ userId: "someone-else", role: "organizer", email: "x@oasisai.work", displayName: "X" }] },
    { start: "2026-10-30T17:00:00.000Z", hosts: [cc, { userId: "closer-b", role: "attendee", email: "b@oasisai.work", displayName: "B" }] },
  ] as never;
  const alone = rebookHosts({ public_booking_host_ids: [HOST] }, { assigned_to: HOST });
  assert.deepEqual(alone, { organizerId: HOST, hostIds: [HOST] });
  assert.deepEqual(rebookHosts({}, { assigned_to: HOST }).hostIds, [HOST], "no stored hosts: the meeting's own host");
  assert.ok(pickRebookSlot(slots, "2026-10-30T15:00:00.000Z", alone), "the meeting's own host's slot is offered");
  assert.equal(pickRebookSlot(slots, "2026-10-30T16:00:00.000Z", alone), null, "a slot another founder organizes is not this meeting's");
  assert.equal(
    pickRebookSlot(slots, "2026-10-30T17:00:00.000Z", alone),
    null,
    "a slot that adds a co-host would leave Schedule copies and lead access stale, so it is not offered",
  );
  assert.ok(
    pickRebookSlot(slots, "2026-10-30T17:00:00.000Z", rebookHosts({ public_booking_host_ids: [HOST, "closer-b"] }, { assigned_to: HOST })),
    "a meeting booked with that co-host keeps them",
  );
  assert.equal(pickRebookSlot(slots, "2026-10-30T18:00:00.000Z", alone), null, "a time that is not open is refused");
  const patch = rebookLeadPatch({
    startsAt: NEW_TIME,
    occurredAt: "2026-10-28T20:00:00.000Z",
    receipt: { calendarId: "primary", eventId: "e", htmlLink: "h", meetLink: "m", iCalUID: "i" },
    revision: 2,
  });
  assert.equal(patch.stage, "founder_meeting_booked", "a rebook never moves the lead's stage");
  assert.equal(patch.founder_meeting_at, NEW_TIME);
  assert.equal(patch.founder_meeting_status, "rescheduled");
}

async function testNoShowThenRebook() {
  const { raw, db, meetingDeps, calendarUpdates } = await fixture();
  const close = (input: Parameters<typeof closeVerifiedFounderMeeting>[0]) => closeVerifiedFounderMeeting(input, meetingDeps);

  // Never recorded early: a meeting still ahead is refused.
  await assert.rejects(
    markFounderMeetingNoShow(
      { tenantId: TENANT, appointmentId: APPT, who: "lead_absent", actorUserId: "system:test" },
      { db: db as never, now: () => Date.parse(MISSED) - 60_000, close, origin: "https://oasisai.work", env: ENV },
    ),
    /meeting_not_started/,
  );
  assert.equal((await appointmentRow(raw)).status, "scheduled");

  const first = await markFounderMeetingNoShow(
    { tenantId: TENANT, appointmentId: APPT, who: "both_absent", actorUserId: "system:test" },
    { db: db as never, now: () => NOW, close, origin: "https://oasisai.work", env: ENV },
  );
  assert.equal(first.alreadyClosed, false);
  assert.equal(first.leadUpdated, true);
  assert.match(first.rebookUrl, /^https:\/\/oasisai\.work\/book\/rebook\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const closed = await appointmentRow(raw);
  assert.equal(closed.status, "no_answer");
  assert.equal(closed.workflow_status, "no_show");
  const lead = await leadData(raw);
  assert.equal(lead.stage, "founder_meeting_booked", "a no-show keeps the lead at Founder Meeting");
  assert.equal(lead.founder_meeting_status, "no_show");
  assert.equal(lead.no_show_who, "both_absent");
  assert.ok(Date.parse(String(lead.next_action_at)) > NOW, "a next action is set");
  const timeline = await raw.execute({ sql: "SELECT type, subject FROM lead_interactions WHERE lead_id = ?", args: [LEAD] });
  assert.deepEqual(timeline.rows.map((r) => [r.type, r.subject]), [["deal_outcome", "Meeting missed"]]);

  // A retry closes nothing twice and writes no second timeline row.
  const again = await markFounderMeetingNoShow(
    { tenantId: TENANT, appointmentId: APPT, who: "both_absent", actorUserId: "system:test" },
    { db: db as never, now: () => NOW, close, origin: "https://oasisai.work", env: ENV },
  );
  assert.equal(again.alreadyClosed, true);
  assert.equal(again.leadUpdated, false);
  assert.equal((await raw.execute({ sql: "SELECT COUNT(*) n FROM lead_interactions", args: [] })).rows[0].n, 1);

  // The link opens to the calendar.
  const open = await readRebookState(db as never, first.rebookToken, NOW);
  assert.equal(open.state, "open");
  if (open.state !== "open") return;
  assert.equal(open.firstName, "Gideon");
  assert.equal(open.durationMinutes, 15);
  assert.equal(open.missedAt, MISSED);
  assert.equal(open.offerLabel, "AI automation audit");

  // The route's move: the same meeting, a new revision, the lead's new time.
  const meeting = await rescheduleVerifiedFounderMeeting(
    { tenantId: TENANT, leadId: LEAD, appointmentId: APPT, requestId: "11111111-1111-4111-8111-111111111111", meetingAt: NEW_TIME },
    meetingDeps,
  );
  assert.deepEqual(calendarUpdates, [NEW_TIME], "the same Google event moves");
  assert.equal(meeting.revision, 2);
  const moved = await appointmentRow(raw);
  assert.equal(moved.scheduled_for, NEW_TIME);
  assert.equal(moved.status, "scheduled");

  // In flight until activated (the route activates right after the lead record).
  assert.deepEqual(await readRebookState(db as never, first.rebookToken, NOW), { state: "pending" });
  await activateVerifiedFounderMeeting(TENANT, APPT, meetingDeps);
  // Used: the link now shows the booked time and cannot move the meeting again.
  const used = await readRebookState(db as never, first.rebookToken, NOW);
  assert.equal(used.state, "booked");
  if (used.state === "booked") assert.equal(used.startsAt, NEW_TIME);
  // Even a second request that read "open" before the first one landed cannot
  // move it again: the move itself refuses a meeting no longer in the past.
  await assert.rejects(
    rescheduleVerifiedFounderMeeting(
      {
        tenantId: TENANT, leadId: LEAD, appointmentId: APPT,
        requestId: "22222222-2222-4222-8222-222222222222",
        meetingAt: "2026-10-31T15:00:00.000Z",
        requireStartedBefore: new Date(NOW).toISOString(),
      },
      meetingDeps,
    ),
    /meeting_no_longer_reschedulable/,
  );
  assert.equal((await appointmentRow(raw)).scheduled_for, NEW_TIME, "the racing second move changed nothing");

  // New reminders exist for the new revision; the old revision's are cancelled.
  const reminders = await raw.execute({
    sql: "SELECT appointment_revision, status FROM website_sales_meeting_notifications WHERE appointment_id = ? AND kind <> 'confirmation'",
    args: [APPT],
  });
  assert.ok(reminders.rows.some((r) => Number(r.appointment_revision) === 2 && r.status === "pending"), "the rebooked call gets reminders");
}

async function testClosedLinks() {
  const { raw, db } = await fixture();
  const token = signRebookToken({ tenantId: TENANT, appointmentId: APPT, leadId: LEAD }, { nowMs: NOW, env: ENV });
  // A meeting still ahead is not "missed": the link shows its time instead of a calendar.
  await raw.execute({ sql: "UPDATE call_appointments SET scheduled_for = ? WHERE id = ?", args: [NEW_TIME, APPT] });
  assert.equal((await readRebookState(db as never, token, NOW)).state, "booked");
  await raw.execute({ sql: "UPDATE call_appointments SET scheduled_for = ? WHERE id = ?", args: [MISSED, APPT] });
  // A missed meeting not yet closed out opens (the dispatcher may not have run yet).
  assert.equal((await readRebookState(db as never, token, NOW)).state, "open");
  // A move in flight says so instead of offering a second one.
  await raw.execute({ sql: "UPDATE call_appointments SET workflow_status = 'pending_transition' WHERE id = ?", args: [APPT] });
  assert.deepEqual(await readRebookState(db as never, token, NOW), { state: "pending" });
  await raw.execute({ sql: "UPDATE call_appointments SET workflow_status = 'active' WHERE id = ?", args: [APPT] });
  // A revision bumped by a rolled-back move does not kill the link: the meeting is still missed.
  await raw.execute({ sql: "UPDATE call_appointments SET revision = 5 WHERE id = ?", args: [APPT] });
  assert.equal((await readRebookState(db as never, token, NOW)).state, "open");
  // A lead that moved on cannot be pulled back by an old link.
  await raw.execute({
    sql: "UPDATE tenant_records SET data = ? WHERE id = ?",
    args: [JSON.stringify({ stage: "lost", calendar_appointment_id: APPT }), LEAD],
  });
  assert.deepEqual(await readRebookState(db as never, token, NOW), { state: "closed", reason: "lead_stage_changed" });
  // A link for another lead's appointment is refused.
  const wrongLead = signRebookToken({ tenantId: TENANT, appointmentId: APPT, leadId: "lead-b" }, { nowMs: NOW, env: ENV });
  assert.deepEqual(await readRebookState(db as never, wrongLead, NOW), { state: "closed", reason: "not_found" });
  // A cancelled meeting cannot be revived.
  await raw.execute({
    sql: "UPDATE tenant_records SET data = ? WHERE id = ?",
    args: [JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: APPT }), LEAD],
  });
  await raw.execute({ sql: "UPDATE call_appointments SET status = 'cancelled', workflow_status = 'cancelled' WHERE id = ?", args: [APPT] });
  assert.deepEqual(await readRebookState(db as never, token, NOW), { state: "closed", reason: "meeting_not_rebookable" });
  assert.deepEqual(await readRebookState(db as never, "garbage", NOW), { state: "closed", reason: "invalid_or_expired" });
}

function testSourceContracts() {
  const route = readFileSync("app/api/forms/booking/rebook/route.ts", "utf8");
  assert.match(route, /sameOrigin\(req\)/, "the rebook POST refuses cross-origin calls like /api/forms/booking");
  assert.match(route, /rateLimit\(/, "the rebook POST is rate-limited");
  assert.match(route, /rescheduleVerifiedFounderMeeting/, "a rebook MOVES the meeting, never creates a second one");
  assert.equal((route.match(/requireStartedBefore:/g) || []).length, 2, "both moves (new and resumed) carry the past-only guard");
  assert.equal((route.match(/openerAttendee: openerOf\(slot\)/g) || []).length, 2, "both moves keep the slot's second host on the invite");
  const replay = route.slice(route.indexOf("const moved ="), route.indexOf("const state = await readRebookState"));
  assert.ok(
    replay.indexOf("if (!recorded.ok)") > 0 && replay.indexOf("if (!recorded.ok)") < replay.indexOf("activateVerifiedFounderMeeting"),
    "a replay never activates a meeting the lead record does not show",
  );
  assert.match(replay, /pending_request_id === requestId/, "a move reserved under this request resumes instead of closing the link");
  assert.ok(
    replay.indexOf("lead.stage !== REBOOK_LEAD_STAGE") > 0 &&
      replay.indexOf("lead.stage !== REBOOK_LEAD_STAGE") < replay.indexOf("rescheduleVerifiedFounderMeeting("),
    "a resumed move re-checks the lead before touching the calendar",
  );
  assert.match(replay, /if \(!slot\) return NextResponse\.json\(\{ ok: false, error: "rebook_in_progress" \}/, "an unapplied move resumes only into a still-open slot");
  assert.equal((route.match(/if \(recorded\.applied\)/g) || []).length, 2, "both success paths tell the sales desk, once");
  const page = readFileSync("components/booking/RebookPage.tsx", "utf8");
  assert.doesNotMatch(page, /retry_required"\) setRequestId\(null\)/, "an uncertain move is retried under the same request id");
  assert.doesNotMatch(route, /createVerifiedFounderMeeting/);
  const internal = readFileSync("app/api/internal/tools/meeting-no-show/route.ts", "utf8");
  assert.match(internal, /authenticateToolsRequest\(req/, "the no-show route is signed like the tool runner");
  assert.match(internal, /AI_AUDIT_TENANT_ID/, "the no-show route only touches OASIS's own workspace");
  assert.doesNotMatch(internal, /console\.\w+\([^)]*rebook_?url/i, "the rebook link is never logged");
}

async function main() {
  testToken();
  testPureHelpers();
  testSourceContracts();
  await testNoShowThenRebook();
  await testClosedLinks();
  console.log("meeting-rebook: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
