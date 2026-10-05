/**
 * sms-agent-host-deactivated.test.ts — the SMS reply agent never acts, or
 * mails, AS a founder-meeting host who has been deactivated.
 *
 * Kept-hot founder_meeting_booked leads on OASIS-live are linked to verified
 * appointments hosted by a rep retired on 2026-09-24. Before this fix:
 *
 *   - a client's SMS reschedule of such a meeting reached
 *     rescheduleVerifiedFounderMeeting, which now refuses a deactivated (or
 *     unreadable) host by throwing — and that throw escaped the reply agent,
 *     failing the client's job into the retry/dead-letter lane;
 *   - notifyRep mailed the rep copy of every client SMS FROM the host's own
 *     Gmail, deactivated or not.
 *
 * runSmsReplyAgentWorker runs for real against a local libSQL file database:
 * the queue, claim and lease, appointment match, conversation state, rules
 * classification, reschedule guards and host-slot reservation, the REAL
 * lib/website-sales-founder-meeting reschedule service with its default
 * lib/team standing read, lead transitions and the job completion writes.
 * Replies stay in dry-run. Stand-ins record instead of reaching the network:
 * the rep's Gmail sender, the operator alert writer, the canonical-touch
 * writer, the conversations nudge, the bridge LLM queue and Twilio.
 *
 * Run: node --conditions=react-server --import tsx tests/sms-agent-host-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "sms-agent-host-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.SMS_AGENT_AUTONOMY = "execute";
delete process.env.BRAVO_FORCE_DRY_RUN;
delete process.env.SMS_AGENT_LLM;
// Client replies stay in dry-run: no Twilio send is part of this test.
delete process.env.LIVE_SEND_TWILIO;
delete process.env.DASHBOARD_LIVE_SEND;
// Never let a test reach Google, a bridge or Telegram, whatever the shell holds.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|TELEGRAM_|SUNBIZ_TELEGRAM)/.test(key)) delete process.env[key];
}

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

type RepMail = { tenantId: string; userId: string; to: string; idempotencyKey: string };
const repMails: RepMail[] = [];
stubModule(require.resolve("../lib/integrations/gmail-oauth-send"), {
  sendGmailAsOperator: async (args: RepMail & { expectedFromAddress: string }) => {
    repMails.push({ tenantId: args.tenantId, userId: args.userId, to: args.to, idempotencyKey: args.idempotencyKey });
    return {
      ok: true,
      provider: "gmail_oauth",
      gmail_message_id: `gm-${repMails.length}`,
      thread_id: `th-${repMails.length}`,
      from_address: args.expectedFromAddress,
    };
  },
});
type Alert = { tenantId: string; alertType: string; lane: string; subjectId?: string; body?: string };
const alerts: Alert[] = [];
stubModule(require.resolve("../lib/notify/agent-alert"), {
  writeAgentAlert: async (input: Alert) => void alerts.push(input),
});
stubModule(require.resolve("../lib/leads/canonical-touch"), {
  persistCanonicalLeadTouch: async () => undefined,
});
stubModule(require.resolve("../lib/realtime/conversations-nudge"), {
  nudgeConversations: async () => undefined,
});
stubModule(require.resolve("../lib/bridge-infer"), {
  queueInfer: async () => {
    throw new Error("the LLM classifier is off in this test");
  },
});
stubModule(require.resolve("../lib/sms-direct-twilio"), {
  sendSmsDirectTwilio: async () => {
    throw new Error("replies are dry-run in this test");
  },
});

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // brand "oasis"
const AVA = "7a7a7a7a-0000-4000-8000-000000000001"; // active host
const ETHAN = "7a7a7a7a-0000-4000-8000-000000000002"; // deactivated host
const RETIRED_AT = "2026-09-24T12:00:00Z";
const ORGANIZER: Record<string, string> = { [AVA]: "ava@oasisai.work", [ETHAN]: "ethan@oasisai.work" };
const LATE = "I'm running 10 minutes late";

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

/** The next weekday at 14:00 Toronto, at least three days out: inside every
 *  reschedule guard (lead time, horizon, business hours, 15-minute boundary). */
function validSlotLocalIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  for (let days = 3; days < 10; days += 1) {
    const at = new Date(Date.now() + days * 864e5);
    const p = Object.fromEntries(parts.formatToParts(at).map((part) => [part.type, part.value]));
    if (p.weekday !== "Sat" && p.weekday !== "Sun") return `${p.year}-${p.month}-${p.day}T14:00`;
  }
  throw new Error("no weekday found");
}

async function main() {
  console.log("sms-agent-host-deactivated:");
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'lead', scheduled_for TEXT NOT NULL, assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled', pre_call_note TEXT, outcome_note TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT,
      channel TEXT, direction TEXT, agent_source TEXT, provider TEXT, provider_message_id TEXT,
      to_phone TEXT, content TEXT, content_preview TEXT, actor_user_id TEXT, metadata TEXT, created_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, full_name TEXT,
      display_name TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
    ${readFileSync("database/turso/170_sms_reply_agent.turso.sql", "utf8")}
  `);
  await seed.batch([
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at)
            VALUES ('p-ava', ?, ?, ?, 'owner', 'Ava', '2026-09-01T00:00:00Z')`,
      args: [AVA, ORGANIZER[AVA], TENANT],
    },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at, deactivated_at)
            VALUES ('p-ethan', ?, ?, ?, 'closer', 'Ethan', '2026-09-01T00:00:00Z', ?)`,
      args: [ETHAN, ORGANIZER[ETHAN], TENANT, RETIRED_AT],
    },
  ], "write");

  const slotLocalIso = validSlotLocalIso();
  let appointmentHour = 0;
  let received = 0;
  /** A verified founder audit + its lead + the client's inbound SMS job. */
  const inbound = async (key: string, host: string, phoneLast10: string, body: string, awaitingSlot = false) => {
    const appointmentId = `appt-${key}`;
    const leadId = `lead-${key}`;
    const phone = `+1${phoneLast10}`;
    appointmentHour += 1;
    const scheduledFor = new Date(Date.now() + 864e5 + appointmentHour * 3_600_000).toISOString();
    await seed.execute({
      sql: `INSERT INTO call_appointments (
        id, tenant_id, lead_id, scheduled_for, assigned_to, status, created_by, meeting_kind,
        duration_minutes, timezone, client_name_snapshot, company_snapshot, client_email_snapshot,
        client_phone_snapshot, website_snapshot, client_agenda, handoff_note, google_calendar_id,
        google_event_id, google_event_html_link, google_meet_link, google_ical_uid, calendar_status,
        organizer_email_snapshot, booking_request_id, revision, workflow_status, sms_consent
      ) VALUES (?,?,?,?,?,'scheduled',?,'founder_audit',15,'America/Toronto','Taylor Smith',
        'North Star Dental','taylor@example.com',?,'https://northstardental.ca/','Review the site.',
        'Qualified handoff.','primary',?,'https://calendar.google.com/calendar/event?eid=test',
        'https://meet.google.com/abc-defg-hij','ical-1','verified',?,?,1,'active',1)`,
      args: [appointmentId, TENANT, leadId, scheduledFor, host, host, phone,
        `event-${key}`, ORGANIZER[host], `booking-${key}`],
    });
    await seed.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [leadId, TENANT, JSON.stringify({
        stage: "founder_meeting_booked",
        assigned_to: host,
        attributed_rep_user_id: host,
        founder_meeting_status: "booked",
        calendar_appointment_id: appointmentId,
      })],
    });
    const sid = `SM-${key}`;
    received += 1;
    const receivedAt = new Date(Date.now() - (100 - received) * 1_000).toISOString();
    await seed.execute({
      sql: `INSERT INTO lead_interactions (id, tenant_id, lead_id, type, channel, direction, provider,
              provider_message_id, content, created_at)
            VALUES (?, ?, ?, 'sms_received', 'sms', 'inbound', 'twilio', ?, ?, ?)`,
      args: [`in-${key}`, TENANT, leadId, sid, body, receivedAt],
    });
    await seed.execute({
      sql: `INSERT INTO sms_agent_jobs (id, tenant_id, provider, provider_message_id, from_phone, to_phone,
              phone_last10, body, lead_id, appointment_id, interaction_id, status, received_at)
            VALUES (?, ?, 'twilio', ?, ?, '+14385550000', ?, ?, ?, ?, ?, 'pending', ?)`,
      args: [`job-${key}`, TENANT, sid, phone, phoneLast10, body, leadId, appointmentId, `in-${key}`, receivedAt],
    });
    if (awaitingSlot) {
      await seed.execute({
        sql: `INSERT INTO sms_agent_conversations (tenant_id, phone_last10, lead_id, appointment_id, state,
                proposed_slots, state_expires_at, agent_turns_24h, automation_paused)
              VALUES (?, ?, ?, ?, 'awaiting_slot_choice', ?, ?, 1, 0)`,
        args: [TENANT, phoneLast10, leadId, appointmentId,
          JSON.stringify([{ localIso: slotLocalIso, meetingAt: `${slotLocalIso}:00Z`, label: "Option 1" }]),
          new Date(Date.now() + 3_600_000).toISOString()],
      });
    }
  };
  const job = async (key: string) =>
    (await seed.execute({
      sql: "SELECT status, last_error, proposed_action, attempts FROM sms_agent_jobs WHERE id = ?",
      args: [`job-${key}`],
    })).rows[0];
  const appointmentOf = async (key: string) =>
    (await seed.execute({ sql: "SELECT * FROM call_appointments WHERE id = ?", args: [`appt-${key}`] })).rows[0];
  const leadOf = async (key: string) =>
    JSON.parse(String((await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE id = ?",
      args: [`lead-${key}`],
    })).rows[0].data)) as Record<string, unknown>;
  const assertMeetingUntouched = async (key: string) => {
    const appointment = await appointmentOf(key);
    assert.equal(Number(appointment.revision), 1, "the appointment revision advanced");
    assert.equal(appointment.workflow_status, "active", "the appointment was reserved for a transition");
    assert.equal(appointment.pending_request_id, null, "a reschedule reservation was left behind");
    assert.equal(appointment.last_reschedule_request_id, null);
    const lead = await leadOf(key);
    assert.equal(lead.founder_meeting_status, "booked", "the lead was transitioned");
    const queued = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM website_sales_meeting_notifications WHERE appointment_id = ?",
      args: [`appt-${key}`],
    });
    assert.equal(Number(queued.rows[0].n), 0, "reminder rows were queued");
  };
  const alertsFor = (key: string) => alerts.filter((alert) => alert.subjectId === `appt-${key}`);

  const { runSmsReplyAgentWorker } = await import("../lib/sms/reply-agent");
  const run = async () => {
    repMails.length = 0;
    alerts.length = 0;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
      return await runSmsReplyAgentWorker();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  };

  // ── Run 1: standing readable ───────────────────────────────────────────
  await inbound("ethan-resched", ETHAN, "4165550101", "1", true);
  await inbound("ava-late", AVA, "4165550102", LATE);
  await inbound("ethan-late", ETHAN, "4165550103", LATE);
  const run1 = await run();

  await check("a client reschedule of a deactivated host's meeting is escalated to a human, never crashed", async () => {
    const row = await job("ethan-resched");
    assert.equal(row.status, "escalated", JSON.stringify(row));
    assert.equal(row.last_error, "meeting_host_deactivated");
    assert.equal(row.proposed_action, "human_reschedule_required");
    assert.equal(Number(row.attempts), 1, "the job went through the retry lane");
    await assertMeetingUntouched("ethan-resched");
    const paged = alertsFor("ethan-resched");
    assert.equal(paged.length, 1, JSON.stringify(alerts));
    assert.equal(paged[0].alertType, "sms_agent_human_review");
    assert.equal(paged[0].lane, "operator");
    assert.match(String(paged[0].body), /meeting_host_deactivated/);
  });

  await check("a deactivated host gets no rep email; the operator alert still fires", async () => {
    assert.ok(!repMails.some((mail) => mail.userId === ETHAN), "mail was sent as a deactivated host");
    const row = await job("ethan-late");
    assert.equal(row.status, "escalated");
    assert.equal(row.last_error, null, "skipping a deactivated host's copy is not a delivery failure");
    const paged = alertsFor("ethan-late");
    assert.equal(paged.length, 1);
    assert.equal(paged[0].alertType, "sms_agent_human_review");
  });

  // Scoped to the active host, so this holds on the unfixed agent too.
  await check("an active host still gets the rep email from their own mailbox, exactly as before", async () => {
    assert.deepEqual(repMails.filter((mail) => mail.userId === AVA), [{
      tenantId: TENANT,
      userId: AVA,
      to: ORGANIZER[AVA],
      idempotencyKey: "sms-agent:job-ava-late:sms_agent_human_review",
    }]);
    const row = await job("ava-late");
    assert.equal(row.status, "escalated");
    assert.equal(row.last_error, null);
    assert.equal(alertsFor("ava-late").length, 1);
  });

  await check("the run counts the refusal as an escalated failure, not a worker crash", async () => {
    assert.equal(run1.processed, 3);
    assert.equal(run1.escalated, 3);
    assert.equal(run1.failed, 1);
  });

  // ── Run 2: the standing read fails ───────────────────────────────────────
  await inbound("ava-resched", AVA, "4165550104", "1", true);
  await inbound("ava-late-2", AVA, "4165550105", LATE);
  await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
  try {
    await run();
  } finally {
    await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
  }

  await check("an unreadable host standing escalates the client reschedule; the meeting is untouched", async () => {
    const row = await job("ava-resched");
    assert.equal(row.status, "escalated", JSON.stringify(row));
    // pageAndEscalate records the rep-notice failure first (emailError || reason).
    assert.equal(row.last_error, "rep_standing_check_failed");
    assert.equal(row.proposed_action, "human_reschedule_required");
    await assertMeetingUntouched("ava-resched");
    const paged = alertsFor("ava-resched");
    assert.equal(paged.length, 1);
    assert.match(String(paged[0].body), /meeting_host_check_failed/);
  });

  await check("an unreadable host standing skips the rep email and reports it; the operator alert still fires", async () => {
    assert.deepEqual(repMails, [], "mail was sent as a host whose standing is unknown");
    const row = await job("ava-late-2");
    assert.equal(row.status, "escalated");
    assert.equal(row.last_error, "rep_standing_check_failed");
    assert.equal(alertsFor("ava-late-2").length, 1);
  });

  seed.close();
  if (failures) {
    console.error(`sms-agent-host-deactivated: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("sms-agent-host-deactivated: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
