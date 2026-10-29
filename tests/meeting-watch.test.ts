/**
 * The meeting watcher (lib/booking/meeting-watch.ts): who was in the room for a
 * call's slot, what a passed call was, the lead's messages after a miss, and
 * the founder's "lead is waiting" note, run against a real libSQL file with the
 * meeting migrations applied. The no-show close-out itself is
 * tests/meeting-rebook.test.ts; here it is a recorder.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  attendanceFrom,
  buildGuestWaitingAlert,
  buildNoShowMessages,
  classifyMeeting,
  noShowDedupeKey,
  watchFounderMeetings,
  type ParticipantRow,
} from "../lib/booking/meeting-watch";

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000aa";
const KEY = "k".repeat(48);
process.env.FORM_LINK_HMAC_KEY = KEY;
const HOST = "host-cc";
const NOW = Date.parse("2026-10-28T16:20:00.000Z");
const START = "2026-10-28T16:00:00.000Z";

function participant(role: string, joinedAt: string, opts: Partial<ParticipantRow> = {}): ParticipantRow {
  // Two minutes in the room unless the case says otherwise (Vivian's real test visit lasted 18 s);
  // a participant who leaves on purpose was last heard from as they left.
  const leftAt = opts.left_at === undefined ? new Date(Date.parse(joinedAt) + 120_000).toISOString() : opts.left_at;
  return {
    role,
    user_id: role === "host" ? HOST : null,
    joined_at: joinedAt,
    left_at: leftAt,
    removed_at: null,
    last_seen_at: opts.last_seen_at ?? leftAt ?? joinedAt,
    ...opts,
  };
}

function testAttendance() {
  const slot = { startsAt: START, durationMinutes: 15, nowMs: NOW };
  // Vivian tested her link the evening she booked, three days before: that is not attending.
  assert.equal(attendanceFrom([participant("guest", "2026-10-25T18:26:11.000Z")], slot).guestJoined, false);
  assert.equal(attendanceFrom([participant("guest", "2026-10-28T15:58:00.000Z")], slot).guestJoined, true, "a few minutes early counts");
  assert.equal(attendanceFrom([participant("guest", "2026-10-28T16:44:00.000Z")], slot).guestJoined, true, "late inside the window counts");
  assert.equal(attendanceFrom([participant("guest", "2026-10-28T17:30:00.000Z")], slot).guestJoined, false, "hours later is another visit");
  const now = attendanceFrom(
    [participant("guest", "2026-10-28T16:01:00.000Z", { left_at: null, last_seen_at: new Date(NOW - 5_000).toISOString() })],
    slot,
  );
  assert.equal(now.guestPresentNow, true);
  assert.equal(now.hostPresentNow, false);
  const gone = attendanceFrom(
    [participant("guest", "2026-10-28T16:01:00.000Z", { left_at: null, last_seen_at: new Date(NOW - 120_000).toISOString() })],
    slot,
  );
  assert.equal(gone.guestPresentNow, false, "not heard from in two minutes is not in the room now");

  // A signed-in teammate who is not the room's host joins as "guest": still OASIS, never the lead.
  const opener = attendanceFrom([participant("guest", "2026-10-28T16:01:00.000Z", { user_id: "opener-1" })], slot);
  assert.equal(opener.guestJoined, false, "a signed-in opener is not the lead");
  assert.equal(opener.hostJoined, true, "a signed-in opener is OASIS in the room");

  // Held means the two sides were in the room AT THE SAME TIME (Codex review of #775).
  const together = attendanceFrom(
    [participant("guest", "2026-10-28T16:00:30.000Z"), participant("host", "2026-10-28T16:02:00.000Z")],
    slot,
  );
  assert.equal(together.met, true);
  const apart = attendanceFrom(
    [
      participant("host", "2026-10-28T15:40:00.000Z", { left_at: "2026-10-28T15:42:00.000Z" }),
      participant("guest", "2026-10-28T16:00:00.000Z", { left_at: "2026-10-28T16:10:00.000Z" }),
    ],
    slot,
  );
  assert.deepEqual([apart.guestJoined, apart.hostJoined, apart.met], [true, true, false], "a host testing the room at 15:40 never met a lead waiting at 16:00");
  assert.equal(classifyMeeting(apart), "missed_each_other");
  // A vanished browser's left_at is the CLEANUP time; presence ends when it was last heard from (Codex review).
  const stale = attendanceFrom(
    [
      participant("host", "2026-10-28T15:40:00.000Z", { last_seen_at: "2026-10-28T15:42:00.000Z", left_at: "2026-10-28T16:00:02.000Z" }),
      participant("guest", "2026-10-28T16:00:00.000Z", { left_at: "2026-10-28T16:10:00.000Z", last_seen_at: "2026-10-28T16:09:58.000Z" }),
    ],
    slot,
  );
  assert.equal(stale.met, false, "a host last seen at 15:42 did not meet a lead who came at 16:00, whatever the cleanup stamped");
  // Someone signed in to ANOTHER workspace is the lead's side, not OASIS.
  const outsider = attendanceFrom(
    [participant("guest", "2026-10-28T16:00:00.000Z", { user_id: "client-of-another-workspace" })],
    { ...slot, isTeammate: (id) => id === HOST },
  );
  assert.deepEqual([outsider.guestJoined, outsider.hostJoined], [true, false]);

  assert.equal(classifyMeeting({ guestJoined: true, hostJoined: true, met: true }), "held");
  assert.equal(classifyMeeting({ guestJoined: true, hostJoined: true, met: false }), "missed_each_other");
  assert.equal(classifyMeeting({ guestJoined: true, hostJoined: false, met: false }), "host_absent");
  assert.equal(classifyMeeting({ guestJoined: false, hostJoined: true, met: false }), "lead_absent");
  assert.equal(classifyMeeting({ guestJoined: false, hostJoined: false, met: false }), "both_absent");
}

function testMessages() {
  const url = "https://oasisai.work/book/rebook/abc.def";
  const missed = buildNoShowMessages({ firstName: "Gideon", offerLabel: "AI automation audit", missedAt: START, rebookUrl: url, who: "both_absent" });
  assert.equal(missed.email.subject, "Sorry we missed each other");
  assert.match(missed.email.body, /^Hi Gideon,/);
  assert.ok(missed.email.body.includes(url));
  assert.match(missed.sms, /^OASIS AI: Sorry we missed each other for your AI automation audit\. Pick a new time here: /);
  const sorry = buildNoShowMessages({ firstName: "Uwem", offerLabel: "AI automation audit", missedAt: START, rebookUrl: url, who: "host_absent" });
  assert.equal(sorry.email.subject, "I'm sorry I missed our call");
  assert.match(sorry.email.body, /You joined our AI automation audit .* and I wasn't there/);
  assert.deepEqual(missed.followUps.map((f) => f.hours), [24, 72]);
  for (const text of [missed.email.body, missed.sms, sorry.email.body, ...missed.followUps.map((f) => f.body)]) {
    assert.ok(!/[–—]/.test(text), "no dashes CC does not write");
    assert.ok(text.includes(url), "every message carries the lead's own link");
  }
  const waiting = buildGuestWaitingAlert({
    name: "Vivian", company: "Salon", phone: "+2349065082127", email: "v@example.com",
    meetLink: "https://oasisai.work/meet/rut-imtb-oqz", startsAt: START, leadId: "lead-v",
  });
  assert.equal(waiting.subject, "Vivian is waiting in the call room now");
  assert.match(waiting.body, /Join now: https:\/\/oasisai\.work\/meet\/rut-imtb-oqz/);
  assert.match(waiting.body, /\/pipeline\/lead-v/);
}

async function testWatch() {
  const raw = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "meeting-watch-")), "db.sqlite")}` });
  await raw.executeMultiple(`
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'lead', scheduled_for TEXT NOT NULL, assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled', pre_call_note TEXT, outcome_note TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT, agent_source TEXT,
      to_phone TEXT, to_email TEXT, subject TEXT, content TEXT, content_preview TEXT,
      actor_user_id TEXT, metadata TEXT, created_at TEXT);
    CREATE TABLE meet_participants (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))), tenant_id TEXT NOT NULL, room_id TEXT NOT NULL,
      role TEXT NOT NULL, user_id TEXT, joined_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, left_at TEXT, removed_at TEXT
    );
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
    ${readFileSync("database/turso/bravo__250_founder_meeting_reminder_ladder.sql", "utf8")}
    ${readFileSync("database/turso/bravo__224_public_booking_offer_label.sql", "utf8")}
    ${readFileSync("database/turso/bravo__232_booking_meet_room.sql", "utf8")}
  `);
  const db = createTursoPostgrest(raw) as never;
  const appointment = async (id: string, start: string, opts: { room?: string | null; consent?: number; tenant?: string } = {}) => {
    await raw.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [`lead-${id}`, opts.tenant ?? TENANT, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: id })],
    });
    return raw.execute({
      sql: `INSERT INTO call_appointments (id, tenant_id, lead_id, scheduled_for, assigned_to, created_by, meeting_kind,
              duration_minutes, timezone, client_name_snapshot, company_snapshot, client_email_snapshot, client_phone_snapshot,
              google_meet_link, calendar_status, organizer_email_snapshot, revision, workflow_status, sms_consent, offer_label, meet_room_id)
            VALUES (?, ?, ?, ?, ?, ?, 'founder_audit', 15, 'America/Toronto', ?, 'Rice farm', ?, '+14165550101',
              'https://oasisai.work/meet/vbj-mhtn-ndp', 'verified', 'conaugh@oasisai.work', 1, 'active', ?, 'AI automation audit', ?)`,
      args: [id, opts.tenant ?? TENANT, `lead-${id}`, start, HOST, HOST, `Lead ${id}`, `${id}@example.com`, opts.consent ?? 0,
        opts.room === undefined ? `room-${id}` : opts.room],
    });
  };
  const joinRoom = (room: string, role: string, at: string, opts: { left?: string | null; seen?: string; userId?: string | null } = {}) =>
    raw.execute({
      sql: "INSERT INTO meet_participants (tenant_id, room_id, role, user_id, joined_at, last_seen_at, left_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      // Ten minutes in the room unless the case says otherwise, last heard from as they left.
      args: [TENANT, room, role, opts.userId === undefined ? (role === "host" ? HOST : null) : opts.userId, at,
        opts.seen ?? (opts.left === undefined ? new Date(Date.parse(at) + 600_000).toISOString() : opts.left ?? at),
        opts.left === undefined ? new Date(Date.parse(at) + 600_000).toISOString() : opts.left],
    });
  const marked: Array<{ appointmentId: string; who: string }> = [];
  const alerts: string[] = [];
  const failCloseOnce = new Set<string>(["flaky"]);
  const deps = {
    db,
    now: () => NOW,
    origin: "https://oasisai.work",
    env: { FORM_LINK_HMAC_KEY: KEY },
    isTeammate: async (_tenant: string, userId: string) => userId === HOST || userId === "opener-1",
    markNoShow: (async (input: { appointmentId: string; who: string }) => {
      if (failCloseOnce.delete(input.appointmentId)) throw new Error("meeting_close_failed:row_changed");
      marked.push({ appointmentId: input.appointmentId, who: input.who });
      const before = (await raw.execute({ sql: "SELECT status FROM call_appointments WHERE id = ?", args: [input.appointmentId] })).rows[0];
      await raw.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id=?", args: [input.appointmentId] });
      await raw.execute({
        sql: "UPDATE tenant_records SET data = json_set(data, '$.founder_meeting_status', 'no_show') WHERE id = ?",
        args: [`lead-${input.appointmentId}`],
      });
      return { alreadyClosed: before?.status === "no_answer", leadUpdated: true, leadStage: "founder_meeting_booked" };
    }) as never,
    alert: (async (_tenant: string, text: string) => {
      alerts.push(text);
      return { delivered: true, outcome: "sent" };
    }) as never,
  };
  const rows = async (id: string) =>
    (await raw.execute({ sql: "SELECT kind, channel, due_at, recipient, body FROM website_sales_meeting_notifications WHERE appointment_id = ? ORDER BY kind, channel, due_at", args: [id] })).rows;

  await appointment("nobody", START, { consent: 1 }); // 20 min ago, nobody came
  await appointment("lead-only", START); // the lead waited alone
  await joinRoom("room-lead-only", "guest", "2026-10-28T16:01:00.000Z");
  await appointment("held", START); // both joined
  await joinRoom("room-held", "guest", "2026-10-28T16:00:30.000Z");
  await joinRoom("room-held", "host", "2026-10-28T16:02:00.000Z");
  await appointment("gmeet", START, { room: null }); // a Google Meet link: no join data
  await appointment("now", "2026-10-28T16:15:00.000Z"); // in its slot, lead in the room, no host
  await joinRoom("room-now", "guest", "2026-10-28T16:14:00.000Z", { left: null, seen: new Date(NOW - 3_000).toISOString() });
  await appointment("early", "2026-10-28T16:10:00.000Z"); // 10 min in: not yet past the grace minutes
  await appointment("opener-only", START); // only a signed-in opener came: the lead never did
  await joinRoom("room-opener-only", "guest", "2026-10-28T16:01:00.000Z", { userId: "opener-1" });
  await appointment("flaky", START); // its close fails once: the next run finishes it
  await appointment("elsewhere", START, { tenant: OTHER_TENANT }); // another workspace: never touched
  for (let i = 0; i < 30; i++) await appointment(`gmeet-${i}`, "2026-10-28T08:00:00.000Z", { room: null }); // no join data
  // Closed as a no-show earlier, but its lead write failed: the watcher finishes the lead.
  await appointment("half-done", "2026-10-28T14:00:00.000Z");
  await raw.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id='half-done'", args: [] });
  // Rebooks that failed and were rolled back: each meeting is the no-show again at a higher revision.
  const rolledBack = async (id: string, start: string, revision: number) => {
    await appointment(id, start);
    await raw.execute({
      sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show', revision=?, last_compensated_request_id='req-failed' WHERE id=?",
      args: [revision, id],
    });
    await raw.execute({ sql: "UPDATE tenant_records SET data = json_set(data, '$.founder_meeting_status', 'no_show') WHERE id = ?", args: [`lead-${id}`] });
  };
  const queuedNoShow = (row: {
    id: string; appointment: string; message: string; channel?: "email" | "sms"; due: string; revision: number;
    missedAt: string; status: string; sentAt?: string; lastError?: string;
  }) =>
    raw.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel,
              due_at, recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key, last_error, sent_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 's', 'link', ?, 0, ?, ?, ?, ?)`,
      args: [row.id, TENANT, row.appointment, `lead-${row.appointment}`,
        row.message.startsWith("no_show_followup") ? "no_show_followup" : "no_show_rebook", row.channel ?? "email", row.due,
        row.channel === "sms" ? "+14165550101" : "rb@example.com", HOST, row.status, row.revision,
        noShowDedupeKey(row.appointment, row.revision, row.message, row.channel ?? "email", row.missedAt),
        row.lastError ?? (row.status === "cancelled" ? "reschedule_compensated" : null), row.sentAt ?? null],
    });
  // Rolled back once: both messages were cancelled with the move.
  await rolledBack("rolled-back", "2026-10-28T13:00:00.000Z", 2);
  await queuedNoShow({ id: "rb-email", appointment: "rolled-back", message: "no_show_rebook", due: "2026-10-28T13:15:00.000Z", revision: 1, missedAt: "2026-10-28T13:00:00.000Z", status: "cancelled" });
  await queuedNoShow({ id: "rb-24", appointment: "rolled-back", message: "no_show_followup_24h", due: "2026-10-29T13:15:00.000Z", revision: 1, missedAt: "2026-10-28T13:00:00.000Z", status: "cancelled" });
  // A restore cut short: its first copy landed, the next write failed (Codex review r4). The dispatcher saw the move first for one.
  await rolledBack("rb-partial", "2026-10-28T12:00:00.000Z", 2);
  for (const [id, message, status, lastError] of [
    ["rp-email", "no_show_rebook", "cancelled", undefined],
    ["rp-24", "no_show_followup_24h", "cancelled", undefined],
    ["rp-72", "no_show_followup_72h", "skipped", "meeting_moved"],
  ] as const) {
    await queuedNoShow({ id, appointment: "rb-partial", message, due: "2026-10-29T12:15:00.000Z", revision: 1, missedAt: "2026-10-28T12:00:00.000Z", status, lastError });
  }
  await queuedNoShow({ id: "rp-email-2", appointment: "rb-partial", message: "no_show_rebook", due: "2026-10-28T16:00:00.000Z", revision: 2, missedAt: "2026-10-28T12:00:00.000Z", status: "pending" });
  // Rolled back twice: the restored rebook email went out at revision 2, then the second rollback cancelled the 72 h follow-up.
  await rolledBack("rb-twice", "2026-10-28T11:00:00.000Z", 3);
  await queuedNoShow({ id: "rt-email-1", appointment: "rb-twice", message: "no_show_rebook", due: "2026-10-28T11:15:00.000Z", revision: 1, missedAt: "2026-10-28T11:00:00.000Z", status: "cancelled" });
  await queuedNoShow({ id: "rt-72-1", appointment: "rb-twice", message: "no_show_followup_72h", due: "2026-10-31T11:15:00.000Z", revision: 1, missedAt: "2026-10-28T11:00:00.000Z", status: "cancelled" });
  await queuedNoShow({ id: "rt-email-2", appointment: "rb-twice", message: "no_show_rebook", due: "2026-10-28T11:30:00.000Z", revision: 2, missedAt: "2026-10-28T11:00:00.000Z", status: "sent", sentAt: "2026-10-28T11:30:05.000Z" });
  await queuedNoShow({ id: "rt-72-2", appointment: "rb-twice", message: "no_show_followup_72h", due: "2026-10-31T11:15:00.000Z", revision: 2, missedAt: "2026-10-28T11:00:00.000Z", status: "cancelled" });
  // Missed again after a rebook that held: the first miss's text (cancelled by that rebook) stays gone.
  await rolledBack("rb-second-miss", "2026-10-28T10:00:00.000Z", 3);
  await queuedNoShow({ id: "rs-sms-1", appointment: "rb-second-miss", message: "no_show_rebook", channel: "sms", due: "2026-10-21T15:15:00.000Z", revision: 1, missedAt: "2026-10-21T15:00:00.000Z", status: "cancelled", lastError: "meeting_rescheduled" });
  await queuedNoShow({ id: "rs-email-2", appointment: "rb-second-miss", message: "no_show_rebook", due: "2026-10-28T10:15:00.000Z", revision: 2, missedAt: "2026-10-28T10:00:00.000Z", status: "sent", sentAt: "2026-10-28T10:15:04.000Z" });
  await queuedNoShow({ id: "rs-24-2", appointment: "rb-second-miss", message: "no_show_followup_24h", due: "2026-10-29T10:15:00.000Z", revision: 2, missedAt: "2026-10-28T10:00:00.000Z", status: "cancelled" });
  // Missed 50 hours ago, rebook rolled back before its 72 h follow-up: past the 48-hour watch, still put right.
  await rolledBack("rb-old", "2026-10-26T14:20:00.000Z", 2);
  await queuedNoShow({ id: "ro-email", appointment: "rb-old", message: "no_show_rebook", due: "2026-10-26T14:35:00.000Z", revision: 1, missedAt: "2026-10-26T14:20:00.000Z", status: "sent", sentAt: "2026-10-26T14:35:03.000Z" });
  await queuedNoShow({ id: "ro-24", appointment: "rb-old", message: "no_show_followup_24h", due: "2026-10-27T14:35:00.000Z", revision: 1, missedAt: "2026-10-26T14:20:00.000Z", status: "skipped", lastError: "lead_moved_on" });
  await queuedNoShow({ id: "ro-72", appointment: "rb-old", message: "no_show_followup_72h", due: "2026-10-29T14:35:00.000Z", revision: 1, missedAt: "2026-10-26T14:20:00.000Z", status: "cancelled" });
  // Closed and recorded by the operator's route: left alone.
  await appointment("operator-closed", "2026-10-28T14:30:00.000Z");
  await raw.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id='operator-closed'", args: [] });
  await raw.execute({ sql: "UPDATE tenant_records SET data = json_set(data, '$.founder_meeting_status', 'no_show') WHERE id = 'lead-operator-closed'", args: [] });

  const first = await watchFounderMeetings(deps);
  assert.equal(first.errors.length, 1, "the failed close is reported");
  assert.match(first.errors[0], /^flaky:meeting_close_failed/);
  assert.deepEqual(
    marked.map((m) => `${m.appointmentId}:${m.who}`).sort(),
    ["half-done:both_absent", "lead-only:host_absent", "nobody:both_absent", "opener-only:lead_absent"],
    "the missed meetings past their grace minutes are closed with what the room saw, and the half-done one is finished",
  );
  assert.ok(!marked.some((m) => m.appointmentId === "operator-closed"), "a no-show the operator already recorded is left alone");
  const restored = await raw.execute({
    sql: "SELECT kind, status, appointment_revision, due_at FROM website_sales_meeting_notifications WHERE appointment_id = 'rolled-back' AND appointment_revision = 2 ORDER BY kind",
    args: [],
  });
  assert.deepEqual(
    restored.rows.map((r) => `${r.kind}:${r.status}`),
    ["no_show_followup:pending", "no_show_rebook:pending"],
    "a rolled-back rebook gets its unsent rebook messages back at the current revision",
  );
  assert.equal(restored.rows.find((r) => r.kind === "no_show_followup")?.due_at, "2026-10-29T13:15:00.000Z", "a future follow-up keeps its time");
  const atRevision = async (id: string, revision: number) =>
    (await raw.execute({
      sql: "SELECT dedupe_key FROM website_sales_meeting_notifications WHERE appointment_id = ? AND appointment_revision = ? ORDER BY dedupe_key",
      args: [id, revision],
    })).rows.map((r) => String(r.dedupe_key).split(":").slice(2, 4).join(":"));
  assert.deepEqual(
    await atRevision("rb-partial", 2),
    ["no_show_followup_24h:email", "no_show_followup_72h:email", "no_show_rebook:email"],
    "a restore cut short is finished message by message, a dispatcher's 'moved' skip included, nothing twice",
  );
  assert.deepEqual(
    await atRevision("rb-twice", 3),
    ["no_show_followup_72h:email"],
    "after two rollbacks only the follow-up comes back: the rebook email already went out once",
  );
  assert.deepEqual(
    await atRevision("rb-second-miss", 3),
    ["no_show_followup_24h:email"],
    "the second miss's follow-up comes back, the first miss's text never does",
  );
  const old = await raw.execute({ sql: "SELECT dedupe_key, due_at FROM website_sales_meeting_notifications WHERE appointment_id = 'rb-old' AND appointment_revision = 2", args: [] });
  assert.deepEqual(
    old.rows.map((r) => `${String(r.dedupe_key).split(":").slice(2, 4).join(":")}@${r.due_at}`),
    ["no_show_followup_72h:email@2026-10-29T14:35:00.000Z"],
    "a meeting missed 50 hours ago still gets its cancelled follow-up back, and one skipped for its own reason stays skipped",
  );
  assert.equal(first.held, 1);
  assert.equal(first.noShows, 4);
  assert.deepEqual(await rows("elsewhere"), [], "another workspace's meeting is never written to");
  const flakyQueued = await rows("flaky");
  assert.equal(flakyQueued.filter((r) => r.kind === "no_show_rebook").length, 1, "the rebook email is queued before the close is tried");
  const nobody = await rows("nobody");
  assert.deepEqual(
    nobody.map((r) => `${r.kind}:${r.channel}`),
    ["no_show_followup:email", "no_show_followup:email", "no_show_rebook:email", "no_show_rebook:sms"],
    "rebook email and text now, two follow-ups later",
  );
  assert.ok(nobody.every((r) => /https:\/\/oasisai\.work\/book\/rebook\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(String(r.body))), "a real signed link in every message");
  const leadOnly = await rows("lead-only");
  assert.ok(leadOnly.some((r) => r.kind === "no_show_rebook" && String(r.body).includes("I wasn't there")), "the lead who waited gets the apology");
  assert.ok(!leadOnly.some((r) => r.channel === "sms"), "no text without the SMS tick");
  assert.deepEqual(await rows("gmeet"), [], "a Google Meet call is left for the founder");
  assert.deepEqual(await rows("early"), [], "a call ten minutes in is not missed yet");
  assert.equal((await rows("held")).length, 0);
  const waiting = await rows("now");
  assert.deepEqual(waiting.map((r) => `${r.kind}:${r.recipient}`), ["host_guest_waiting:conaugh@oasisai.work"]);
  assert.equal(alerts.length, 4, "the founder hears about each missed meeting that closed, and the finished one");

  // The next minute: the failed close finishes, nothing else happens twice.
  const second = await watchFounderMeetings(deps);
  assert.deepEqual(second.errors, []);
  assert.equal(second.noShows, 1, "only the meeting whose close failed is closed now");
  assert.ok(marked.some((m) => m.appointmentId === "flaky"));
  assert.equal((await rows("flaky")).filter((r) => r.kind === "no_show_rebook").length, 1, "its messages are not queued twice");
  assert.equal(alerts.length, 5, "and the founder hears about it once");
  assert.equal((await rows("now")).length, 1, "the lead-waiting note goes out once per meeting");
  const restoredAgain = await raw.execute({ sql: "SELECT count(*) AS n FROM website_sales_meeting_notifications WHERE appointment_id = 'rolled-back' AND appointment_revision = 2", args: [] });
  assert.equal(Number(restoredAgain.rows[0].n), 2, "restored once, not again");
  for (const [id, revision, n] of [["rb-partial", 2, 3], ["rb-twice", 3, 1], ["rb-second-miss", 3, 1], ["rb-old", 2, 1]] as const) {
    assert.equal((await atRevision(id, revision)).length, n, `${id}: nothing restored twice`);
  }
}

async function main() {
  testAttendance();
  testMessages();
  await testWatch();
  console.log("meeting-watch: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
