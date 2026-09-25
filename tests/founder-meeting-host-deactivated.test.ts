/**
 * founder-meeting-host-deactivated.test.ts — a verified founder meeting whose
 * host was deactivated after booking must not be rescheduled AS that host.
 *
 * Kept-hot founder_meeting_booked leads on OASIS-live are linked to verified
 * appointments hosted by a rep retired on 2026-09-24. Before this fix,
 * rescheduleVerifiedFounderMeeting kept hostUserId = appointment.assigned_to,
 * re-patched the Google event from the retired host's calendar (Google re-sends
 * the invite, sendUpdates=all) and queued the new confirmation/reminder rows
 * with sender_user_id = the retired host.
 *
 * rescheduleVerifiedFounderMeeting runs for real against a local libSQL file
 * database — appointment load, reservation, the call_appointments write and the
 * notification outbox from migrations 167/169. memberStanding is NOT injected:
 * the module's default (lib/team) reads user_profiles from the same database,
 * so the wiring itself is under test. The only stand-in is the Google Calendar
 * boundary, which records what it was asked to patch.
 *
 * Run: node --conditions=react-server --import tsx tests/founder-meeting-host-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "founder-meeting-host-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const LEAD = "lead-host-deactivated";
const ACTIVE_HOST = "5e5e5e5e-0000-4000-8000-000000000001";
const RETIRED_HOST = "5e5e5e5e-0000-4000-8000-000000000002";
const ORGANIZER = "founder@oasisai.work";
const NOW = Date.parse("2026-09-24T14:00:00.000Z");
const BOOKED_FOR = "2026-09-25T16:00:00.000Z";
const MOVE_TO = "2026-09-25T18:00:00.000Z";
const RETIRED_AT = "2026-09-24T12:00:00Z";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

async function main() {
  console.log("founder-meeting-host-deactivated:");
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'lead', scheduled_for TEXT NOT NULL, assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'completed', 'no_answer', 'cancelled', 'rescheduled')),
      pre_call_note TEXT, outcome_note TEXT, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_source TEXT, metadata TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, full_name TEXT,
      display_name TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
  `);
  await seed.batch([
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at)
            VALUES ('p-active', ?, 'active@oasisai.work', ?, 'owner', 'Active Host', '2026-09-01T00:00:00Z')`,
      args: [ACTIVE_HOST, TENANT],
    },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at, deactivated_at)
            VALUES ('p-retired', ?, 'retired@oasisai.work', ?, 'closer', 'Retired Host', '2026-09-01T00:00:00Z', ?)`,
      args: [RETIRED_HOST, TENANT, RETIRED_AT],
    },
  ], "write");

  const insertVerifiedAppointment = (id: string, host: string) =>
    seed.execute({
      sql: `INSERT INTO call_appointments (
        id, tenant_id, lead_id, entity_type, scheduled_for, assigned_to, status, created_by,
        meeting_kind, duration_minutes, timezone, client_name_snapshot, company_snapshot,
        client_email_snapshot, client_phone_snapshot, website_snapshot, client_agenda, handoff_note,
        google_calendar_id, google_event_id, google_event_html_link, google_meet_link, google_ical_uid,
        calendar_status, organizer_email_snapshot, booking_request_id, revision, workflow_status, sms_consent
      ) VALUES (?,?,?,'lead',?,?,'scheduled',?,'founder_audit',15,'America/Toronto','Taylor Smith',
        'North Star Dental','taylor@example.com','+14165550101','https://northstardental.ca/',
        'Review the site.','Qualified handoff.','primary',?,
        'https://calendar.google.com/calendar/event?eid=test','https://meet.google.com/abc-defg-hij',
        'ical-1','verified',?,?,1,'active',1)`,
      args: [id, TENANT, LEAD, BOOKED_FOR, host, host, `event-${id}`, ORGANIZER, `booking-${id}`],
    });

  const { rescheduleVerifiedFounderMeeting } = await import("../lib/website-sales-founder-meeting");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  type PatchCall = { hostUserId: string; eventId: string; meetingAt: string };
  const patched: PatchCall[] = [];
  const deps = {
    db: getServiceSupabase() as never,
    now: () => NOW,
    updateCalendar: async (input: PatchCall) => {
      patched.push({ hostUserId: input.hostUserId, eventId: input.eventId, meetingAt: input.meetingAt });
      return {
        calendarId: "primary",
        eventId: input.eventId,
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        meetLink: "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-1",
        organizerEmail: ORGANIZER,
      };
    },
  };
  const reschedule = (appointmentId: string, requestId: string) =>
    rescheduleVerifiedFounderMeeting(
      { tenantId: TENANT, leadId: LEAD, appointmentId, requestId, meetingAt: MOVE_TO },
      deps as never,
    );
  const row = async (id: string) =>
    (await seed.execute({ sql: "SELECT * FROM call_appointments WHERE id = ?", args: [id] })).rows[0];
  const queuedSenders = async (id: string) =>
    (await seed.execute({
      sql: "SELECT DISTINCT sender_user_id FROM website_sales_meeting_notifications WHERE appointment_id = ?",
      args: [id],
    })).rows.map((r) => String(r.sender_user_id));
  const assertUntouched = async (id: string) => {
    const appointment = await row(id);
    assert.equal(appointment.scheduled_for, BOOKED_FOR, "the meeting time moved");
    assert.equal(Number(appointment.revision), 1, "the revision advanced");
    assert.equal(appointment.workflow_status, "active", "the appointment was reserved for a transition");
    assert.equal(appointment.pending_request_id, null, "a reschedule reservation was left behind");
    assert.equal(appointment.last_reschedule_request_id, null);
    assert.deepEqual(await queuedSenders(id), [], "reminder rows were queued");
  };

  await insertVerifiedAppointment("meeting-retired", RETIRED_HOST);
  await insertVerifiedAppointment("meeting-read-error", ACTIVE_HOST);
  await insertVerifiedAppointment("meeting-active", ACTIVE_HOST);

  await check("a deactivated host: refused as meeting_host_deactivated; nothing patched, reserved or queued", async () => {
    await assert.rejects(reschedule("meeting-retired", "reschedule-retired"), (error: Error) => {
      assert.equal(error.message, "meeting_host_deactivated");
      return true;
    });
    assert.deepEqual(patched, [], "Google was asked to re-send the invite from a retired host's calendar");
    await assertUntouched("meeting-retired");
  });

  await check("a standing read that fails: refused as meeting_host_check_failed; nothing touched", async () => {
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      await assert.rejects(reschedule("meeting-read-error", "reschedule-read-error"), (error: Error) => {
        assert.equal(error.message, "meeting_host_check_failed");
        assert.ok(error.cause, "the read failure is kept as the cause");
        return true;
      });
    } finally {
      await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
    assert.deepEqual(patched, []);
    await assertUntouched("meeting-read-error");
  });

  await check("the same meeting reschedules once its host's standing can be read (the refusal was retryable)", async () => {
    const meeting = await reschedule("meeting-read-error", "reschedule-read-error");
    assert.equal(meeting.meetingAt, MOVE_TO);
    assert.deepEqual(patched.splice(0), [
      { hostUserId: ACTIVE_HOST, eventId: "event-meeting-read-error", meetingAt: MOVE_TO },
    ]);
  });

  await check("an active host reschedules exactly as before: patched as the host, rows queued as the host", async () => {
    const meeting = await reschedule("meeting-active", "reschedule-active");
    assert.equal(meeting.meetingAt, MOVE_TO);
    assert.deepEqual(patched.splice(0), [
      { hostUserId: ACTIVE_HOST, eventId: "event-meeting-active", meetingAt: MOVE_TO },
    ]);
    const appointment = await row("meeting-active");
    assert.equal(appointment.scheduled_for, MOVE_TO);
    assert.equal(Number(appointment.revision), 2);
    assert.equal(appointment.last_reschedule_request_id, "reschedule-active");
    assert.deepEqual(await queuedSenders("meeting-active"), [ACTIVE_HOST]);
  });

  await check("a replay of an applied reschedule returns its receipt before any standing read", async () => {
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      const replay = await reschedule("meeting-active", "reschedule-active");
      assert.equal(replay.meetingAt, MOVE_TO);
    } finally {
      await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
    assert.deepEqual(patched, [], "a replay never re-patches Google");
  });

  seed.close();
  if (failures) {
    console.error(`founder-meeting-host-deactivated: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("founder-meeting-host-deactivated: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
