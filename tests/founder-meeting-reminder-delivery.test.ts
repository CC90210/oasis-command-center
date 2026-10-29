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
const agentCards: Array<Record<string, unknown>> = [];
let storeCard: ((card: Record<string, unknown>) => Promise<void>) | null = null;
let refuseMetCards = false;
stubModule(require.resolve("../lib/notify/agent-alert"), {
  writeAgentAlert: async (card: Record<string, unknown>) => {
    if (refuseMetCards && card.alertType === "founder_meeting_met_after_no_show") return { stored: false, telegram: null };
    agentCards.push(card);
    if (storeCard) await storeCard(card);
    return { stored: true, telegram: "sent" };
  },
});
const founderAlerts: string[] = [];
stubModule(require.resolve("../lib/notify/alert-route"), {
  pushWorkspaceAlert: async (_tenant: string, text: string) => {
    founderAlerts.push(text);
    return { delivered: true, outcome: "sent" };
  },
});
stubModule(require.resolve("../lib/leads/canonical-touch"), {
  // Production's answer for a lead that no longer exists (record_lead_touch, lib/turso-rpc-shim.ts).
  persistCanonicalLeadTouch: async (_db: unknown, input: { leadId: string }) => {
    if (input.leadId === "lead-deleted") {
      throw new Error("canonical_touch_write_failed:record_lead_touch: lead_not_found_or_wrong_tenant");
    }
    return undefined;
  },
});
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
    CREATE TABLE meet_participants (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))), tenant_id TEXT NOT NULL,
      room_id TEXT NOT NULL, role TEXT NOT NULL, user_id TEXT, joined_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, left_at TEXT, removed_at TEXT);
    CREATE TABLE meet_rooms (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE agent_alerts (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))), tenant_id TEXT, alert_type TEXT,
      subject_id TEXT, payload TEXT, created_at TEXT, resolved_at TEXT);
    INSERT INTO meet_rooms (id, tenant_id) VALUES
      ('room-waiting', '${OASIS}'), ('room-live', '${OASIS}'), ('room-joined', '${OASIS}');
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, full_name TEXT,
      display_name TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
    ${readFileSync("database/turso/bravo__250_founder_meeting_reminder_ladder.sql", "utf8")}
    ${readFileSync("database/turso/bravo__224_public_booking_offer_label.sql", "utf8")}
    ${readFileSync("database/turso/bravo__214_consent_events.sql", "utf8")}
    ${readFileSync("database/turso/bravo__232_booking_meet_room.sql", "utf8")}
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

  storeCard = async (card) => {
    await seed.execute({
      sql: "INSERT INTO agent_alerts (tenant_id, alert_type, subject_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [String(card.tenantId), String(card.alertType), (card.subjectId as string) ?? null, JSON.stringify(card.payload ?? {}), new Date().toISOString()],
    });
  };
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
  await check("a reminder that fails is a card for the founder in the same run, kept whatever its push does", async () => {
    const card = agentCards.find((c) => c.alertType === "founder_meeting_reminder_failed" && c.subjectId === "appt-refused");
    assert.ok(card, "a card was written for the meeting (Codex review r5)");
    assert.equal(card.severity, "urgent");
    assert.equal(card.title, "Meeting reminder failed");
    assert.equal(card.telegramOncePerOpen, true, "the meeting's first failure pages; later ones refresh its card");
    assert.match(String(card.body), /reminder_15 text: quo_refused/);
    assert.match(String(card.body), /\/pipeline\/lead-appt-refused/);
  });
  await seed.execute({ sql: "UPDATE agent_alerts SET resolved_at = ? WHERE subject_id = 'appt-refused'", args: [new Date().toISOString()] });
  const refusedCards = agentCards.filter((c) => c.subjectId === "appt-refused").length;
  await dispatch();
  await check("a failure card the founder dismissed stays dismissed while nothing new fails (Codex review r11)", async () => {
    assert.equal(agentCards.filter((c) => c.subjectId === "appt-refused").length, refusedCards);
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

  // Pass 5: after a missed meeting. The rebook email goes out while the meeting
  // is still the closed no-show and the lead is still at Founder Meeting; its
  // text waits for daytime; a follow-up queued before a rebook is dropped.
  await appointment("appt-missed", -30);
  await seed.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id='appt-missed'", args: [] });
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-missed", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-missed" })],
  });
  const queueAfter = (id: string, kind: string, channel: "email" | "sms", recipient: string, body: string) =>
    seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, 'appt-missed', 'lead-appt-missed', ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?)`,
      args: [id, OASIS, kind, channel, new Date(Date.now() - 60_000).toISOString(), recipient, HOST,
        channel === "email" ? "Sorry we missed each other" : null, body, `dedupe-${id}`],
    });
  await queueAfter("rebook-email", "no_show_rebook", "email", "taylor@example.com", "Hi Taylor,\n\nHere is your link: https://oasisai.work/book/rebook/x.y");
  window = { usedFallback: false, withinWindow: false };
  await queueAfter("rebook-sms", "no_show_rebook", "sms", PHONE, "OASIS AI: Sorry we missed each other. Pick a new time here: https://oasisai.work/book/rebook/x.y");
  await dispatch();
  window = { usedFallback: false, withinWindow: true };
  await check("a missed meeting's rebook email goes out with its own stored text", async () => {
    const row = await rowOf("rebook-email");
    assert.equal(row.status, "sent");
    const sent = sharedSends.find((s) => s.subject === "Sorry we missed each other");
    assert.ok(sent);
    assert.match(sent.body, /book\/rebook\/x\.y/);
  });
  await check("a rebook text at night waits for the lead's daytime", async () => {
    const row = await rowOf("rebook-sms");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "held_for_recipient_daytime");
  });
  await seed.execute({ sql: "UPDATE call_appointments SET status='scheduled', workflow_status='active', revision=2, scheduled_for=? WHERE id='appt-missed'", args: [new Date(Date.now() + 864e5).toISOString()] });
  await queueAfter("follow-up", "no_show_followup", "email", "taylor@example.com", "Still want it? https://oasisai.work/book/rebook/x.y");
  await dispatch();
  await check("a follow-up queued before the lead rebooked is dropped, not sent", async () => {
    const row = await rowOf("follow-up");
    assert.equal(row.status, "skipped");
    assert.equal(row.last_error, "meeting_moved");
  });

  // Pass 5b: queued by the watcher before the close landed: held, not dropped.
  await appointment("appt-closing", -20);
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-closing", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-closing" })],
  });
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
    ) VALUES ('closing-email', ?, 'appt-closing', 'lead-appt-closing', 'no_show_rebook', NULL, 'email', ?, 'taylor@example.com', ?,
      'Sorry we missed each other', 'Your link: https://oasisai.work/book/rebook/x.y', 'pending', 0, 1, 'dedupe-closing-email')`,
    args: [OASIS, new Date(Date.now() - 60_000).toISOString(), HOST],
  });
  await dispatch();
  await check("a rebook message queued before its meeting is closed waits for the close", async () => {
    const row = await rowOf("closing-email");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "waiting_for_no_show_close");
  });

  // Pass 5b2: a follow-up due while the lead's rebook is in flight waits for it
  // to settle. Dropped, a rollback would have nothing to put back (Codex review r4).
  await appointment("appt-rebooking", -40);
  await seed.execute({
    sql: "UPDATE call_appointments SET status='no_answer', workflow_status='pending_transition', pending_operation='reschedule', pending_request_id='req-rebook' WHERE id='appt-rebooking'",
    args: [],
  });
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-rebooking", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-rebooking" })],
  });
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
    ) VALUES ('rebooking-followup', ?, 'appt-rebooking', 'lead-appt-rebooking', 'no_show_followup', NULL, 'email', ?, 'taylor@example.com', ?,
      'Still want a time?', 'Your link: https://oasisai.work/book/rebook/x.y', 'pending', 0, 1, 'dedupe-rebooking-followup')`,
    args: [OASIS, new Date(Date.now() - 60_000).toISOString(), HOST],
  });
  await dispatch();
  await check("a follow-up due while a rebook is in flight waits for it to settle", async () => {
    const row = await rowOf("rebooking-followup");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "waiting_for_rebook_to_settle");
    assert.ok(!sharedSends.some((s) => s.subject === "Still want a time?"), "nothing went out");
  });

  // Pass 5c: a real-length signed rebook link survives the text whole.
  const longLink = `https://oasisai.work/book/rebook/${"e".repeat(210)}.${"s".repeat(43)}`;
  await appointment("appt-longsms", -30, "+14165550177");
  await seed.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id='appt-longsms'", args: [] });
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-longsms", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-longsms" })],
  });
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
    ) VALUES ('long-sms', ?, 'appt-longsms', 'lead-appt-longsms', 'no_show_rebook', NULL, 'sms', ?, '+14165550177', ?, NULL, ?, 'pending', 0, 1, 'dedupe-long-sms')`,
    args: [OASIS, new Date(Date.now() - 60_000).toISOString(), HOST, `OASIS AI: Sorry we missed each other for your AI automation audit. Pick a new time here: ${longLink}`],
  });
  await dispatch();
  await check("a rebook text carries its whole signed link, never the meeting-link fallback", async () => {
    const row = await rowOf("long-sms");
    assert.equal(row.status, "sent");
    const text = quoSends.find((q) => q.to === "+14165550177")?.text || "";
    assert.ok(text.includes(longLink), "the full link is in the text");
    assert.match(text, /Reply STOP to opt out/);
  });

  // Pass 5d: another delivery holds the meeting's lock: a follow-up waits its turn.
  await seed.execute({
    sql: "UPDATE call_appointments SET notification_lease_token = 'someone-else', notification_lease_expires_at = ? WHERE id = 'appt-longsms'",
    args: [new Date(Date.now() + 10 * 60_000).toISOString()],
  });
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
    ) VALUES ('locked-followup', ?, 'appt-longsms', 'lead-appt-longsms', 'no_show_followup', NULL, 'email', ?, 'taylor@example.com', ?,
      'Still want your AI automation audit?', 'Your link: https://oasisai.work/book/rebook/x.y', 'pending', 0, 1, 'dedupe-locked-followup')`,
    args: [OASIS, new Date(Date.now() - 60_000).toISOString(), HOST],
  });
  await dispatch();
  await check("a follow-up waits while the meeting is locked (a rebook can never race it)", async () => {
    const row = await rowOf("locked-followup");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "appointment_delivery_or_transition_in_progress");
  });

  // Pass 5e: the watcher finds a lead waiting alone and the note goes out in the SAME run.
  await appointment("appt-waiting", -2);
  await seed.execute({ sql: "UPDATE call_appointments SET meet_room_id = 'room-waiting' WHERE id = 'appt-waiting'", args: [] });
  await seed.execute({
    sql: "INSERT INTO meet_participants (tenant_id, room_id, role, user_id, joined_at, last_seen_at, left_at) VALUES (?, 'room-waiting', 'guest', NULL, ?, ?, NULL)",
    args: [OASIS, new Date(Date.now() - 90_000).toISOString(), new Date(Date.now() - 2_000).toISOString()],
  });
  await dispatch();
  await check("a lead waiting alone is told to the founder in the same run the watcher sees it", async () => {
    const row = (await seed.execute({
      sql: "SELECT status, recipient FROM website_sales_meeting_notifications WHERE appointment_id = 'appt-waiting' AND kind = 'host_guest_waiting'",
      args: [],
    })).rows[0];
    assert.ok(row, "the note was queued");
    assert.equal(row.status, "sent");
    assert.equal(row.recipient, HOST_EMAIL);
  });

  // Pass 6: the founder's "lead is waiting" note during the call, queued earlier
  // and held up: it goes only if the lead is still waiting with no host, read
  // from the room as it is sent (Codex review r8).
  const queueWaiting = (id: string, appointmentId: string, subject: string) =>
    seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, ?, ?, 'host_guest_waiting', NULL, 'email', ?, ?, ?, ?, 'Join now: https://meet.google.com/abc-defg-hij', 'pending', 0, 1, ?)`,
      args: [id, OASIS, appointmentId, `lead-${appointmentId}`, new Date(Date.now() - 30_000).toISOString(), HOST_EMAIL, HOST, subject, `dedupe-${id}`],
    });
  const inRoom = (room: string, role: string, userId: string | null) =>
    seed.execute({
      sql: "INSERT INTO meet_participants (tenant_id, room_id, role, user_id, joined_at, last_seen_at, left_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      args: [OASIS, room, role, userId, new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 2_000).toISOString()],
    });
  await appointment("appt-live", -3);
  await seed.execute({ sql: "UPDATE call_appointments SET meet_room_id = 'room-live' WHERE id = 'appt-live'", args: [] });
  await inRoom("room-live", "guest", null);
  await queueWaiting("waiting", "appt-live", "Taylor Smith is waiting in the call room now");
  await appointment("appt-joined", -3);
  await seed.execute({ sql: "UPDATE call_appointments SET meet_room_id = 'room-joined' WHERE id = 'appt-joined'", args: [] });
  await inRoom("room-joined", "guest", null);
  await inRoom("room-joined", "host", HOST);
  await queueWaiting("waiting-joined", "appt-joined", "Someone else is waiting in the call room now");
  await dispatch();
  await check("the founder's lead-is-waiting note goes out as internal mail during the call", async () => {
    const row = await rowOf("waiting");
    assert.equal(row.status, "sent");
    const sent = sharedSends.find((s) => s.subject === "Taylor Smith is waiting in the call room now");
    assert.ok(sent);
    assert.equal(sent.internalAlert, true);
  });
  await check("a held-up waiting note whose host has joined since is dropped, not sent", async () => {
    const row = await rowOf("waiting-joined");
    assert.equal(row.status, "skipped");
    assert.equal(row.last_error, "lead_no_longer_waiting");
    assert.ok(!sharedSends.some((s) => s.subject === "Someone else is waiting in the call room now"));
  });

  // Pass 6a (Codex review r12): a waiting note skipped because the lead stepped
  // out for a moment goes back in the queue when they are waiting again, and
  // reaches the founder in that same run.
  await appointment("appt-blip", -3);
  await seed.execute({ sql: "UPDATE call_appointments SET meet_room_id = 'room-blip' WHERE id = 'appt-blip'", args: [] });
  await seed.execute({ sql: "INSERT INTO meet_rooms (id, tenant_id) VALUES ('room-blip', ?)", args: [OASIS] });
  await inRoom("room-blip", "guest", null);
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key, last_error
    ) VALUES ('blip-waiting', ?, 'appt-blip', 'lead-appt-blip', 'host_guest_waiting', NULL, 'email', ?, ?, ?,
      'Blip is waiting in the call room now', 'Join now: https://meet.google.com/abc-defg-hij', 'skipped', 0, 1,
      'appt-blip:1:host_guest_waiting:email', 'lead_no_longer_waiting')`,
    args: [OASIS, new Date(Date.now() - 120_000).toISOString(), HOST_EMAIL, HOST],
  });
  await dispatch();
  await check("a waiting note skipped while the lead stepped out goes again once they are back, the same run", async () => {
    const row = await rowOf("blip-waiting");
    assert.equal(row.status, "sent");
  });

  // Pass 6b (Codex review r11): the call happened after all, and the watcher
  // could not store the founder's card this run. The rebook follow-up is held,
  // never sent; once the card is stored, the watcher stops it.
  await appointment("appt-met-late", -40);
  await seed.execute({
    sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show', meet_room_id='room-met-late' WHERE id='appt-met-late'",
    args: [],
  });
  await seed.execute({ sql: "INSERT INTO meet_rooms (id, tenant_id) VALUES ('room-met-late', ?)", args: [OASIS] });
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-met-late", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-met-late", founder_meeting_status: "no_show" })],
  });
  for (const [role, userId] of [["guest", null], ["host", HOST]] as const) {
    await seed.execute({
      sql: "INSERT INTO meet_participants (tenant_id, room_id, role, user_id, joined_at, last_seen_at, left_at) VALUES (?, 'room-met-late', ?, ?, ?, ?, ?)",
      args: [OASIS, role, userId, new Date(Date.now() - 20 * 60_000).toISOString(), new Date(Date.now() - 10 * 60_000).toISOString(), new Date(Date.now() - 10 * 60_000).toISOString()],
    });
  }
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
    ) VALUES ('met-late-followup', ?, 'appt-met-late', 'lead-appt-met-late', 'no_show_followup', NULL, 'email', ?, 'taylor@example.com', ?,
      'Still want to rebook?', 'Your link: https://oasisai.work/book/rebook/x.y', 'pending', 0, 1, 'dedupe-met-late-followup')`,
    args: [OASIS, new Date(Date.now() - 60_000).toISOString(), HOST],
  });
  refuseMetCards = true;
  await dispatch();
  await check("a rebook follow-up for a call that happened is held, never sent, while the founder's card cannot be stored", async () => {
    const row = await rowOf("met-late-followup");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "held_met_after_no_show");
    assert.ok(!sharedSends.some((s) => s.subject === "Still want to rebook?"));
  });
  refuseMetCards = false;
  await dispatch();
  await check("once the founder's card is stored, the watcher stops it", async () => {
    const row = await rowOf("met-late-followup");
    assert.equal(row.status, "cancelled");
    assert.equal(row.last_error, "met_after_no_show");
    assert.ok(agentCards.some((c) => c.alertType === "founder_meeting_met_after_no_show" && c.subjectId === "appt-met-late"));
  });

  // Pass 7: a sent reminder whose lead is gone (2026-10-28: the canary's cloned
  // lead) stops retrying its timeline write instead of failing every run.
  await seed.execute({
    sql: `INSERT INTO website_sales_meeting_notifications (
      id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
      recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key,
      attempt_token, provider, provider_receipt, sent_at, tracking_status
    ) VALUES ('sent-lead-gone', ?, 'appt-live', 'lead-deleted', 'reminder_15', 15, 'email', ?, 'gone@example.com', ?,
      'In 15 minutes', 'See you soon', 'sent', 1, 1, 'dedupe-sent-lead-gone', 'attempt-gone', 'oasis_shared_gmail', 'receipt-gone', ?, 'pending')`,
    args: [OASIS, new Date(Date.now() - 120_000).toISOString(), HOST, new Date(Date.now() - 60_000).toISOString()],
  });
  const firstGone = (await dispatch()) as { tracking_failed?: number };
  const secondGone = (await dispatch()) as { tracking_failed?: number; failed?: number };
  await check("a sent reminder whose lead is gone stops retrying and stops failing the run", async () => {
    const row = (await seed.execute({
      sql: "SELECT tracking_status, tracking_last_error FROM website_sales_meeting_notifications WHERE id = 'sent-lead-gone'",
      args: [],
    })).rows[0];
    assert.equal(row.tracking_status, "not_required");
    assert.match(String(row.tracking_last_error), /lead_not_found_or_wrong_tenant/);
    assert.equal(firstGone.tracking_failed, 0, "not counted as a failure when found");
    assert.equal(secondGone.tracking_failed, 0, "and not retried after");
    assert.equal(secondGone.failed, 0, "the next run is healthy");
  });

  // Pass 8 (Codex review r6): every failed reminder gets its meeting's card,
  // past the first page of results; one a run died before alerting is caught
  // by the next run; a host's withheld reminders keep their own card.
  agentCards.length = 0;
  const failedRow = async (id: string, appointmentId: string, updatedAt: string, lastError = "send_failed") => {
    // A meeting long over and cancelled, so nothing else in the run touches it.
    await appointment(appointmentId, -120);
    await seed.execute({
      sql: "UPDATE call_appointments SET status='cancelled', workflow_status='cancelled', calendar_status='cancelled' WHERE id = ?",
      args: [appointmentId],
    });
    await seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key, last_error, updated_at
      ) VALUES (?, ?, ?, ?, 'reminder_60', 60, 'email', ?, 'x@example.com', ?, NULL, 'b', 'failed', 3, 1, ?, ?, ?)`,
      args: [id, OASIS, appointmentId, `lead-${appointmentId}`, new Date(Date.now() - 3_600_000).toISOString(), HOST, `dedupe-${id}`, lastError, updatedAt],
    });
  };
  for (let i = 0; i < 105; i++) await failedRow(`bulk-${i}`, `appt-bulk-${i}`, new Date(Date.now() - 60_000).toISOString());
  await failedRow("never-alerted", "appt-never-alerted", new Date(Date.now() - 10 * 60_000).toISOString());
  await failedRow("too-old", "appt-too-old", new Date(Date.now() - 20 * 60_000).toISOString());
  await failedRow("withheld", "appt-withheld", new Date(Date.now() - 60_000).toISOString(), "sender_deactivated");
  await dispatch();
  await check("every failed reminder gets its meeting's card, past the first page, including one a dead run never alerted", async () => {
    const subjects = new Set(agentCards.filter((c) => c.alertType === "founder_meeting_reminder_failed").map((c) => c.subjectId));
    for (let i = 0; i < 105; i++) assert.ok(subjects.has(`appt-bulk-${i}`), `appt-bulk-${i} has its card`);
    assert.ok(subjects.has("appt-never-alerted"), "a failure from ten minutes ago is caught");
    assert.ok(!subjects.has("appt-too-old"), "one older than the window is left alone");
    assert.ok(!subjects.has("appt-withheld"), "a withheld reminder keeps its own card");
  });

  // Pass 9 (Codex review r13): held rows are looked at again a little later,
  // so 51 of them, due before a fresh reminder, never keep it from going out.
  for (let i = 0; i < 51; i++) {
    await appointment(`appt-held-${i}`, -20);
    await seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, ?, ?, 'no_show_followup', NULL, 'email', ?, 'taylor@example.com', ?, 'Held', 'b', 'pending', 0, 1, ?)`,
      args: [`held-${i}`, OASIS, `appt-held-${i}`, `lead-appt-held-${i}`, new Date(Date.now() - 10 * 60_000).toISOString(), HOST, `dedupe-held-${i}`],
    });
  }
  await appointment("appt-fresh", 15);
  await queue("fresh-15", "appt-fresh", "reminder_15", 15, "email", "fresh@example.com");
  await dispatch();
  await dispatch();
  await check("held rows never crowd a fresh reminder out of the batch", async () => {
    const row = await rowOf("fresh-15");
    assert.equal(row.status, "sent");
    const held = await rowOf("held-0");
    assert.equal(held.status, "pending");
    assert.ok(Date.parse(String(held.due_at)) > Date.now(), "a held row is looked at again later");
  });

  // Pass 10 (Codex review r15): after an outage the whole rebook sequence is
  // overdue at once. The rebook email goes; each follow-up waits 20 hours after
  // the last email the lead was actually sent.
  await appointment("appt-outage", -73 * 60);
  await seed.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id='appt-outage'", args: [] });
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-outage", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-outage", founder_meeting_status: "no_show" })],
  });
  for (const [id, kind, hoursAgo, subject] of [
    ["outage-rebook", "no_show_rebook", 72.5, "Sorry we missed each other (outage)"],
    ["outage-24", "no_show_followup", 48.5, "Still want a time? (outage)"],
    ["outage-72", "no_show_followup", 0.5, "Last note (outage)"],
  ] as const) {
    await seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, 'appt-outage', 'lead-appt-outage', ?, NULL, 'email', ?, 'outage@example.com', ?, ?, 'Your link: https://oasisai.work/book/rebook/x.y', 'pending', 0, 1, ?)`,
      args: [id, OASIS, kind, new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), HOST, subject, `dedupe-${id}`],
    });
  }
  await dispatch();
  await check("after an outage the rebook email goes, and each follow-up waits 20 hours after it", async () => {
    assert.equal((await rowOf("outage-rebook")).status, "sent");
    for (const id of ["outage-24", "outage-72"]) {
      const row = await rowOf(id);
      assert.equal(row.status, "pending", id);
      assert.equal(row.last_error, "spaced_from_last_message", id);
      const waits = Date.parse(String(row.due_at)) - Date.now();
      assert.ok(waits > 19 * 3_600_000 && waits <= 20 * 3_600_000, `${id} waits about 20 hours`);
    }
    assert.ok(!sharedSends.some((s) => String(s.subject).includes("(outage)") && s.subject !== "Sorry we missed each other (outage)"));
  });

  // Pass 11 (Codex review r16): after an outage the first rebook email fails
  // once; its follow-up waits for it instead of going first.
  await appointment("appt-outage2", -73 * 60);
  await seed.execute({ sql: "UPDATE call_appointments SET status='no_answer', workflow_status='no_show' WHERE id='appt-outage2'", args: [] });
  await seed.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: ["lead-appt-outage2", OASIS, JSON.stringify({ stage: "founder_meeting_booked", calendar_appointment_id: "appt-outage2", founder_meeting_status: "no_show" })],
  });
  for (const [id, kind, hoursAgo, subject] of [
    ["outage2-rebook", "no_show_rebook", 72.5, "Sorry we missed each other (outage 2)"],
    ["outage2-24", "no_show_followup", 48.5, "Still want a time? (outage 2)"],
  ] as const) {
    await seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, 'appt-outage2', 'lead-appt-outage2', ?, NULL, 'email', ?, 'outage2@example.com', ?, ?, 'Your link: https://oasisai.work/book/rebook/x.y', 'pending', 0, 1, ?)`,
      args: [id, OASIS, kind, new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), HOST, subject, `appt-outage2:1:${id === "outage2-24" ? "no_show_followup_24h" : "no_show_rebook"}:email:0`],
    });
  }
  sharedResult = { ok: false, provider: "oasis_shared_gmail", reason: "send_failed", error: "421 try later" };
  await dispatch();
  sharedResult = null;
  await check("a follow-up waits while the rebook email before it is still to go", async () => {
    assert.equal((await rowOf("outage2-rebook")).status, "pending", "the rebook email failed once and is retried");
    const followUp = await rowOf("outage2-24");
    assert.equal(followUp.status, "pending");
    assert.equal(followUp.last_error, "waiting_for_earlier_message");
  });
  await dispatch();
  await check("the rebook email goes first; the follow-up still waits", async () => {
    assert.equal((await rowOf("outage2-rebook")).status, "sent");
    assert.equal((await rowOf("outage2-24")).status, "pending");
    assert.ok(!sharedSends.some((s) => s.subject === "Still want a time? (outage 2)"));
  });
  await check("a follow-up's order and spacing are read under the appointment lease (Codex review r16)", async () => {
    const source = readFileSync("app/api/cron/dispatch-founder-meeting-reminders/route.ts", "utf8");
    const lease = source.indexOf("const leaseToken = await acquireAppointmentLease(");
    const spacing = source.indexOf("const wait = await followUpNotBefore(db, row);");
    assert.ok(lease > 0 && spacing > lease, "the spacing check comes after the lease is taken");
  });

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
