/**
 * founder-meeting-reminder-delivery.test.ts - the reminders actually leave.
 *
 * From 2026-09-04 to 2026-10-28 every founder-meeting reminder failed with
 * "not_connected: no gmail_oauth bundle" (the host's own Gmail login was never
 * connected) and every text was skipped (Twilio only), and nobody heard. This
 * drives GET /api/cron/dispatch-founder-meeting-reminders for real against a
 * local libSQL file, in that same production state, and proves:
 *   - a lead's email falls back to OASIS's shared mailbox and is marked sent;
 *   - a lead's text leaves through Quo, branded, with the join link;
 *   - the founder's 15-minute heads-up reaches the founder as internal mail;
 *   - the day-before text waits for the lead's daytime instead of being dropped;
 *   - a text Quo refuses is never retried into a double text;
 *   - a shared-mailbox failure retries.
 * The network senders, the TCPA clock, alerts and the saga reconciler are
 * stand-ins that record what they were asked.
 *
 * Run: node --conditions=react-server --import tsx tests/founder-meeting-reminder-delivery.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "founder-reminder-delivery-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.CRON_SECRET = "founder-reminder-delivery-cron-secret";
delete process.env.CRON_ALLOW_LOCAL;
delete process.env.BRAVO_FORCE_DRY_RUN;
process.env.LIVE_SEND_QUO = "1";

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

// The production state found on 2026-10-28: the host's Gmail login is not connected.
const operatorAttempts: string[] = [];
stubModule(require.resolve("../lib/integrations/gmail-oauth-send"), {
  sendGmailAsOperator: async (args: { to: string }) => {
    operatorAttempts.push(args.to);
    return { ok: false, provider: "gmail_oauth", reason: "not_connected", error: "no gmail_oauth bundle" };
  },
});
type SharedSend = { to: string; subject: string; body: string; internalAlert?: boolean | null; idempotencyKey?: string; replyTo?: string | null };
const sharedSends: SharedSend[] = [];
let sharedResult: Record<string, unknown> | null = null;
stubModule(require.resolve("../lib/integrations/oasis-shared-gmail-send"), {
  sendOasisSharedGmail: async (args: SharedSend) => {
    sharedSends.push(args);
    return sharedResult ?? { ok: true, provider: "oasis_shared_gmail", gmail_message_id: `<m${sharedSends.length}@oasisai.work>`, from_address: "team@oasisai.work" };
  },
});
const quoSends: Array<{ to: string; text: string; from: string | null }> = [];
let quoResult: Record<string, unknown> | null = null;
let quoSenderResult: Record<string, unknown> | null = null;
let stopIntake = true;
stubModule(require.resolve("../lib/integrations/quo"), {
  quoCredentialsOrNull: async (tenantId: string) => ({ tenantId, apiKey: "test", fromNumber: null }),
  quoSender: async () => quoSenderResult ?? { ok: true, number: "+13653603976", source: "workspace" },
  quoStopIntakeConnected: () => stopIntake,
  sendQuoSms: async (creds: { fromNumber: string | null }, input: { to: string; text: string }) => {
    quoSends.push({ ...input, from: creds.fromNumber });
    return quoResult ?? { ok: true, id: `QU${quoSends.length}`, status: "queued" };
  },
});
let window = { usedFallback: false, withinWindow: true };
const DAYTIME_OPENS = new Date(Date.now() + 60 * 60_000);
stubModule(require.resolve("../lib/tcpa-window"), {
  checkTcpaWindow: () => window,
  dispatchByTcpaWindow: async (
    check: { usedFallback: boolean; withinWindow: boolean },
    effects: { skip: (reason: string) => unknown; send: () => unknown },
  ) => (check.usedFallback ? effects.skip("sms_timezone_unresolved") : !check.withinWindow ? effects.skip("outside_sms_hours") : effects.send()),
  nextTcpaWindowStart: () => DAYTIME_OPENS,
});
stubModule(require.resolve("../lib/notify/agent-alert"), { writeAgentAlert: async () => undefined });
stubModule(require.resolve("../lib/leads/canonical-touch"), { persistCanonicalLeadTouch: async () => undefined });
stubModule(require.resolve("../lib/website-sales-founder-meeting"), {
  reconcileFounderMeetingSagas: async () => ({
    considered: 0, activated: 0, cancelled: 0, compensated: 0, released: 0, failed: 0, errors: [],
  }),
  backfillFounderMeetingNotifications: async () => ({ considered: 0, repaired: 0, failed: 0, errors: [] }),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const HOST = "6f6f6f6f-0000-4000-8000-0000000000aa";
const HOST_EMAIL = "conaugh@oasisai.work";
const PHONE = "+14165550101";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

async function consentIsReadForTheStoredNumber() {
  const { bookingSmsConsent } = await import("../lib/booking/sms-consent");
  const asked: string[] = [];
  const read = (async (_db: unknown, args: { destination: string }) => {
    asked.push(args.destination);
    return args.destination === "+6598234567";
  }) as never;
  await check("SMS consent is read for the exact number the meeting stores", async () => {
    assert.equal(await bookingSmsConsent({} as never, OASIS, "+65 9823 4567", read), true);
    assert.equal(asked.at(-1), "+6598234567", "a written country code is kept, never read as +1");
    assert.equal(await bookingSmsConsent({} as never, OASIS, "(416) 555-0101", read), false);
    assert.equal(asked.at(-1), "+14165550101");
    assert.equal(await bookingSmsConsent({} as never, OASIS, "12", read), false, "an unusable number is never consent");
  });
}

async function main() {
  console.log("founder-meeting-reminder-delivery:");
  await consentIsReadForTheStoredNumber();
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
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
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, full_name TEXT,
      display_name TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
    ${readFileSync("database/turso/bravo__250_founder_meeting_reminder_ladder.sql", "utf8")}
    ${readFileSync("database/turso/bravo__224_public_booking_offer_label.sql", "utf8")}
    ${readFileSync("database/turso/bravo__214_consent_events.sql", "utf8")}
  `);
  await seed.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at)
          VALUES ('p-host', ?, ?, ?, 'owner', 'Conaugh', '2026-09-01T00:00:00Z')`,
    args: [HOST, HOST_EMAIL, OASIS],
  });

  const appointment = (id: string, minutesAhead: number, phone = PHONE) =>
    seed.execute({
      sql: `INSERT INTO call_appointments (
        id, tenant_id, lead_id, scheduled_for, assigned_to, status, created_by, meeting_kind, duration_minutes,
        timezone, client_name_snapshot, company_snapshot, client_email_snapshot, client_phone_snapshot, client_agenda,
        google_meet_link, calendar_status, organizer_email_snapshot, revision, workflow_status, sms_consent, offer_label
      ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, 'founder_audit', 15, 'America/Toronto', 'Taylor Smith',
        'North Star Dental', 'taylor@example.com', ?, 'Review the site.', 'https://meet.google.com/abc-defg-hij',
        'verified', ?, 1, 'active', 1, 'AI automation audit')`,
      args: [id, OASIS, `lead-${id}`, new Date(Date.now() + minutesAhead * 60_000).toISOString(), HOST, HOST, phone, HOST_EMAIL],
    });
  const queue = (id: string, appointmentId: string, kind: string, minutes: number, channel: "email" | "sms", recipient: string) =>
    seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued body', 'pending', 0, 1, ?)`,
      args: [id, OASIS, appointmentId, `lead-${appointmentId}`, kind, minutes, channel,
        new Date(Date.now() - 60_000).toISOString(), recipient, HOST, `dedupe-${id}`],
    });
  const rowOf = async (id: string) =>
    (await seed.execute({
      sql: "SELECT status, attempts, last_error, provider, provider_receipt, subject, body, due_at FROM website_sales_meeting_notifications WHERE id = ?",
      args: [id],
    })).rows[0];

  const { GET } = await import("../app/api/cron/dispatch-founder-meeting-reminders/route");
  const { NextRequest } = await import("next/server");
  const dispatch = async () => {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const res = await GET(
        new NextRequest("http://localhost/api/cron/dispatch-founder-meeting-reminders", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-vercel-cron": "1" },
        }),
      );
      return (await res.json()) as { sent?: number; failed?: number };
    } finally {
      console.error = originalError;
    }
  };

  // Pass 1: the lead's 15-minute email and 5-minute text, the founder's heads-up.
  await appointment("appt-15", 15);
  await appointment("appt-5", 5);
  await queue("lead-email-15", "appt-15", "reminder_15", 15, "email", "taylor@example.com");
  await queue("host-15", "appt-15", "host_15", 15, "email", HOST_EMAIL);
  await queue("lead-sms-5", "appt-5", "reminder_5", 5, "sms", PHONE);
  const pass1 = await dispatch();

  await check("with the host's Gmail unconnected, the lead's email goes out from the shared mailbox", async () => {
    const row = await rowOf("lead-email-15");
    assert.equal(row.status, "sent");
    assert.equal(row.provider, "oasis_shared_gmail");
    const sent = sharedSends.find((s) => s.to === "taylor@example.com");
    assert.ok(sent, "the shared mailbox was asked");
    assert.match(sent.subject, /AI automation audit starts in 1[45] minutes/);
    assert.match(sent.body, /meet\.google\.com\/abc-defg-hij/);
    assert.notEqual(sent.internalAlert, true, "a lead's reminder is never flagged internal");
    assert.equal(sent.replyTo, HOST_EMAIL, "a lead's reply reaches the host, as from the host's own Gmail");
    assert.ok(operatorAttempts.includes("taylor@example.com"), "the host's own Gmail is tried first");
  });
  await check("the lead's 5-minute text leaves through Quo, branded, with the join link", async () => {
    const row = await rowOf("lead-sms-5");
    assert.equal(row.status, "sent");
    assert.equal(row.provider, "quo");
    assert.equal(row.provider_receipt, "QU1");
    assert.equal(quoSends.length, 1);
    assert.equal(quoSends[0].to, PHONE);
    assert.match(quoSends[0].text, /^OASIS AI: Reminder: your AI automation audit starts in [45] minutes/);
    assert.match(quoSends[0].text, /meet\.google\.com\/abc-defg-hij/);
    assert.match(quoSends[0].text, /Reply STOP to opt out/, "the first text carries the opt-out footer");
    assert.equal(quoSends[0].from, "+13653603976", "the sending number is settled before the send");
  });
  await check("the founder's heads-up reaches the founder as internal mail, naming the lead", async () => {
    const row = await rowOf("host-15");
    assert.equal(row.status, "sent");
    const sent = sharedSends.find((s) => s.to === HOST_EMAIL);
    assert.ok(sent);
    assert.equal(sent.internalAlert, true);
    assert.match(sent.subject, /^In 1[45] minutes: Taylor Smith, North Star Dental$/);
    assert.match(sent.body, /Phone: \+14165550101/);
    assert.ok(!operatorAttempts.includes(HOST_EMAIL), "the founder's mail never takes the lead-facing path");
    const touches = await seed.execute({ sql: "SELECT count(*) AS n FROM lead_interactions WHERE to_email = ?", args: [HOST_EMAIL] });
    assert.equal(Number(touches.rows[0].n), 0, "mail to the founder is not contact with the lead");
  });
  await check("the run reports three sent and no failures", async () => {
    assert.equal(pass1.sent, 3);
    assert.equal(pass1.failed, 0);
  });

  // Pass 2: the day-before text arrives at night for the lead.
  window = { usedFallback: false, withinWindow: false };
  await appointment("appt-day", 20 * 60);
  await queue("lead-sms-1440", "appt-day", "reminder_1440", 1440, "sms", PHONE);
  await dispatch();
  await check("a day-before text outside the lead's daytime waits for it instead of being dropped", async () => {
    const row = await rowOf("lead-sms-1440");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "held_for_recipient_daytime");
    assert.equal(row.due_at, DAYTIME_OPENS.toISOString());
    assert.equal(quoSends.length, 1, "nothing was texted at night");
  });
  window = { usedFallback: false, withinWindow: true };

  // Pass 2b: a confirmation text for a call days away waits for daytime too.
  window = { usedFallback: false, withinWindow: false };
  await appointment("appt-later", 3 * 24 * 60);
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
    ) VALUES ('confirm-later', ?, 'appt-later', 'lead-appt-later', 'confirmation', NULL, 'sms', ?, ?, ?, NULL,
      'OASIS AI: Your call is booked.', 'pending', 0, 1, 'dedupe-confirm-later')`,
    args: [OASIS, new Date(Date.now() - 60_000).toISOString(), PHONE, HOST],
  });
  await dispatch();
  await check("a confirmation text for a call days away waits for the lead's daytime", async () => {
    const row = await rowOf("confirm-later");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "held_for_recipient_daytime");
  });
  window = { usedFallback: false, withinWindow: true };

  // Pass 2c: the lead took the "text me" back after booking.
  const withdrawnPhone = "+14165550199";
  const { consentSubjectHash } = await import("../lib/consent/ledger");
  const { normalizeConsentSubject } = await import("../lib/consent/ledger-disclosure");
  const subjectHash = consentSubjectHash("sms", normalizeConsentSubject("sms", withdrawnPhone) || "");
  for (const [id, ticked, at] of [["c1", 1, "2026-10-01T00:00:00.000Z"], ["c2", 0, "2026-10-20T00:00:00.000Z"]] as const) {
    await seed.execute({
      sql: `INSERT INTO consent_events (id, tenant_id, lead_id, form_id, channel, ticked, subject_hash, disclosure_hash,
              disclosure_version, disclosure_text, identity_source, created_at)
            VALUES (?, ?, 'lead-appt-withdrawn', 'form-1', 'sms', ?, ?, 'h', 'v', 't', 'test', ?)`,
      args: [id, OASIS, ticked, subjectHash, at],
    });
  }
  await appointment("appt-withdrawn", 5, withdrawnPhone);
  await queue("lead-sms-withdrawn", "appt-withdrawn", "reminder_5", 5, "sms", withdrawnPhone);
  const textsBefore = quoSends.length;
  await dispatch();
  await check("a lead who withdrew SMS consent after booking is never texted", async () => {
    const row = await rowOf("lead-sms-withdrawn");
    assert.equal(row.status, "skipped");
    assert.equal(row.last_error, "sms_consent_withdrawn");
    assert.equal(quoSends.length, textsBefore);
  });

  // Pass 2d: STOP replies to the Quo number are not read yet: no automated texts.
  stopIntake = false;
  await appointment("appt-nostop", 5);
  await queue("lead-sms-nostop", "appt-nostop", "reminder_5", 5, "sms", PHONE);
  const beforeNoStop = quoSends.length;
  await dispatch();
  await check("without STOP intake on the Quo number, reminders are not texted", async () => {
    const row = await rowOf("lead-sms-nostop");
    assert.equal(row.status, "skipped");
    assert.equal(row.last_error, "quo_stop_intake_not_connected");
    assert.equal(quoSends.length, beforeNoStop);
  });
  stopIntake = true;

  // Pass 2e: the sending number cannot be looked up: nothing was sent, so it retries.
  quoSenderResult = { ok: false, code: "quo_unreachable", reason: "Quo did not answer." };
  await appointment("appt-nosender", 5);
  await queue("lead-sms-nosender", "appt-nosender", "reminder_5", 5, "sms", PHONE);
  await dispatch();
  await check("a failed sender lookup sent nothing and retries", async () => {
    const row = await rowOf("lead-sms-nosender");
    assert.equal(row.status, "pending");
    assert.equal(Number(row.attempts), 1);
    assert.match(String(row.last_error), /^quo_sender:quo_unreachable/);
  });
  quoSenderResult = null;

  // Pass 2f: Quo throttles (HTTP 429): nothing was sent, so it retries.
  quoResult = { ok: false, code: "quo_refused", status: 429, reason: "Too many requests." };
  await appointment("appt-throttled", 5);
  await queue("lead-sms-throttled", "appt-throttled", "reminder_5", 5, "sms", PHONE);
  await dispatch();
  await check("a text Quo throttles goes back to pending for the next run", async () => {
    const row = await rowOf("lead-sms-throttled");
    assert.equal(row.status, "pending");
    assert.equal(Number(row.attempts), 1);
    assert.match(String(row.last_error), /^quo_refused:/);
  });
  quoResult = null;

  // Pass 3: Quo refuses (an international number the Quo line may not text).
  quoResult = { ok: false, code: "quo_refused", status: 403, reason: "Destination not allowed." };
  await appointment("appt-refused", 15, "+2348153169177");
  await queue("lead-sms-refused", "appt-refused", "reminder_15", 15, "sms", "+2348153169177");
  await dispatch();
  await check("a text Quo refuses is failed once, never retried into a double text", async () => {
    const row = await rowOf("lead-sms-refused");
    assert.equal(row.status, "failed");
    assert.equal(Number(row.attempts), 1);
    assert.match(String(row.last_error), /^quo_refused:/);
  });
  quoResult = null;

  // Pass 4: the shared mailbox fails outright: retried, not dropped.
  sharedResult = { ok: false, provider: "oasis_shared_gmail", reason: "send_failed", error: "535 auth" };
  await appointment("appt-retry", 15);
  await queue("lead-email-retry", "appt-retry", "reminder_15", 15, "email", "taylor@example.com");
  await dispatch();
  await check("a shared-mailbox failure goes back to pending for the next run", async () => {
    const row = await rowOf("lead-email-retry");
    assert.equal(row.status, "pending");
    assert.equal(Number(row.attempts), 1);
    assert.match(String(row.last_error), /operator:not_connected; shared:send_failed/);
  });
  sharedResult = null;

  if (failures) {
    console.error(`founder-meeting-reminder-delivery: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("founder-meeting-reminder-delivery: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
