/**
 * founder-meeting-reminders-deactivated-host.test.ts — a founder-meeting
 * reminder EMAIL goes out from the host's own Gmail, so a row queued before the
 * host was deactivated must never fire from the retired person's mailbox. SMS
 * reminders leave from the tenant's Twilio line and are unchanged.
 *
 * Mirrors tests/dispatch-scheduled-sends-deactivated-sender.test.ts. Drives
 * GET /api/cron/dispatch-founder-meeting-reminders for real against a local
 * libSQL file database: claim, the appointment lease, the standing check
 * (lib/team memberStanding over user_profiles), the queue state transitions,
 * the lead_interactions touch and the worker-health row all execute. Stand-ins
 * record what they were asked instead of reaching the network: the Gmail
 * sender, the Twilio sender, the TCPA clock, the operator alert, the
 * canonical-touch writer, and the saga reconciler/backfill (run first by the
 * route; tested in tests/founder-meeting-service.test.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/founder-meeting-reminders-deactivated-host.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "founder-reminders-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.CRON_SECRET = "founder-reminders-deactivated-cron-secret";
delete process.env.CRON_ALLOW_LOCAL;
// SMS must take the LIVE Twilio branch so an SMS send is observable; the
// sender below is a recorder.
delete process.env.BRAVO_FORCE_DRY_RUN;
process.env.LIVE_SEND_TWILIO = "1";

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

type GmailSend = { tenantId: string; userId: string; to: string; idempotencyKey: string; expectedFromAddress: string };
const gmailSends: GmailSend[] = [];
let onGmailSend: (() => Promise<void>) | null = null;
stubModule(require.resolve("../lib/integrations/gmail-oauth-send"), {
  sendGmailAsOperator: async (args: GmailSend) => {
    gmailSends.push({
      tenantId: args.tenantId,
      userId: args.userId,
      to: args.to,
      idempotencyKey: args.idempotencyKey,
      expectedFromAddress: args.expectedFromAddress,
    });
    const hook = onGmailSend;
    onGmailSend = null;
    if (hook) await hook();
    return {
      ok: true,
      provider: "gmail_oauth",
      gmail_message_id: `gm-${gmailSends.length}`,
      thread_id: `th-${gmailSends.length}`,
      from_address: args.expectedFromAddress,
    };
  },
});
const smsSends: Array<{ tenantId: string; to: string }> = [];
stubModule(require.resolve("../lib/sms-direct-twilio"), {
  tenantHasDirectTwilio: async () => true,
  sendSmsDirectTwilio: async (input: { tenantId: string; to: string }) => {
    smsSends.push({ tenantId: input.tenantId, to: input.to });
    return { ok: true, provider: "twilio_direct", message_sid: `SM${smsSends.length}`, status: "queued" };
  },
});
stubModule(require.resolve("../lib/tcpa-window"), {
  checkTcpaWindow: () => ({ usedFallback: false, withinWindow: true }),
  dispatchByTcpaWindow: async (_check: unknown, effects: { send: () => unknown }) => effects.send(),
});
type Alert = { tenantId: string; alertType: string; severity: string; lane: string; payload?: Record<string, unknown> };
const alerts: Alert[] = [];
stubModule(require.resolve("../lib/notify/agent-alert"), {
  writeAgentAlert: async (input: Alert) => void alerts.push(input),
});
stubModule(require.resolve("../lib/leads/canonical-touch"), {
  persistCanonicalLeadTouch: async () => undefined,
});
stubModule(require.resolve("../lib/website-sales-founder-meeting"), {
  reconcileFounderMeetingSagas: async () => ({
    considered: 0, activated: 0, cancelled: 0, compensated: 0, released: 0, failed: 0, errors: [],
  }),
  backfillFounderMeetingNotifications: async () => ({ considered: 0, repaired: 0, failed: 0, errors: [] }),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // brand "oasis"
const AVA = "6f6f6f6f-0000-4000-8000-000000000001"; // active host
const BEN = "6f6f6f6f-0000-4000-8000-000000000002"; // active host
const ETHAN = "6f6f6f6f-0000-4000-8000-000000000003"; // deactivated host
const RETIRED_AT = "2026-09-24T12:00:00Z";
const CLIENT_PHONE = "+14165550101";

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

const WARN_TAG = "[founder-meeting-reminders] sender deactivated";
const ERROR_TAG = "[founder-meeting-reminders] sender standing check failed";

async function main() {
  console.log("founder-meeting-reminders-deactivated-host:");
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
  `);
  const profile = (id: string, authId: string, name: string, deactivatedAt: string | null = null) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at, deactivated_at)
          VALUES (?, ?, ?, ?, 'closer', ?, '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, `${name.toLowerCase()}@oasisai.work`, OASIS, name, deactivatedAt],
  });
  await seed.batch([
    profile("p-ava", AVA, "Ava"),
    profile("p-ben", BEN, "Ben"),
    profile("p-ethan", ETHAN, "Ethan", RETIRED_AT),
  ], "write");

  const meetingAt = new Date(Date.now() + 2 * 864e5).toISOString();
  const appointment = (id: string, host: string) =>
    seed.execute({
      sql: `INSERT INTO call_appointments (
        id, tenant_id, lead_id, scheduled_for, assigned_to, status, created_by, meeting_kind,
        timezone, client_name_snapshot, company_snapshot, client_phone_snapshot, client_agenda,
        google_meet_link, calendar_status, organizer_email_snapshot, revision, workflow_status, sms_consent
      ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, 'founder_audit', 'America/Toronto', 'Taylor Smith',
        'North Star Dental', ?, 'Review the site.', 'https://meet.google.com/abc-defg-hij', 'verified',
        ?, 1, 'active', 1)`,
      args: [id, OASIS, `lead-${id}`, meetingAt, host, host, CLIENT_PHONE, `${id}@oasisai.work`],
    });
  let dueMinutesAgo = 120;
  const queue = async (id: string, appointmentId: string, sender: string, channel: "email" | "sms") => {
    dueMinutesAgo -= 1; // due_at ascending == processing order
    await seed.execute({
      sql: `INSERT INTO website_sales_meeting_notifications (
        id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before, channel, due_at,
        recipient, sender_user_id, subject, body, status, attempts, appointment_revision, dedupe_key
      ) VALUES (?, ?, ?, ?, 'confirmation', NULL, ?, ?, ?, ?, ?, 'Your OASIS audit is confirmed.',
        'pending', 0, 1, ?)`,
      args: [
        id, OASIS, appointmentId, `lead-${appointmentId}`, channel,
        new Date(Date.now() - dueMinutesAgo * 60_000).toISOString(),
        channel === "email" ? "taylor@example.com" : CLIENT_PHONE,
        sender, channel === "email" ? "Your OASIS audit" : null, `dedupe-${id}`,
      ],
    });
  };
  const rowOf = async (id: string) =>
    (await seed.execute({
      sql: "SELECT status, attempts, last_error, claimed_at, sent_at FROM website_sales_meeting_notifications WHERE id = ?",
      args: [id],
    })).rows[0];
  const leaseOf = async (id: string) =>
    (await seed.execute({ sql: "SELECT notification_lease_token FROM call_appointments WHERE id = ?", args: [id] }))
      .rows[0].notification_lease_token;

  const { GET } = await import("../app/api/cron/dispatch-founder-meeting-reminders/route");
  const { NextRequest } = await import("next/server");
  type DispatchBody = { ok: boolean; claimed?: number; sent?: number; skipped?: number; failed?: number };
  const dispatch = async () => {
    gmailSends.length = 0;
    smsSends.length = 0;
    alerts.length = 0;
    const warned: unknown[][] = [];
    const errored: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => void warned.push(args);
    console.error = (...args: unknown[]) => void errored.push(args);
    try {
      const res = await GET(
        new NextRequest("http://localhost/api/cron/dispatch-founder-meeting-reminders", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-vercel-cron": "1" },
        }),
      );
      return { status: res.status, body: (await res.json()) as DispatchBody, warned, errored };
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  };
  const tagged = (logged: unknown[][], tag: string) => logged.filter((args) => args[0] === tag);

  // ── Pass 1: active and deactivated hosts mixed in one batch ───────────────
  await appointment("appt-ava", AVA);
  await appointment("appt-ethan-1", ETHAN);
  await appointment("appt-ethan-2", ETHAN);
  await queue("n-ava-email", "appt-ava", AVA, "email");
  await queue("n-ethan-email-1", "appt-ethan-1", ETHAN, "email");
  await queue("n-ethan-sms", "appt-ethan-1", ETHAN, "sms");
  await queue("n-ethan-email-2", "appt-ethan-2", ETHAN, "email");
  const pass1 = await dispatch();

  await check("a deactivated host's reminder emails are failed as sender_deactivated and never sent", async () => {
    for (const id of ["n-ethan-email-1", "n-ethan-email-2"]) {
      const row = await rowOf(id);
      assert.equal(row.status, "failed", id);
      assert.equal(row.last_error, "sender_deactivated", id);
      assert.equal(Number(row.attempts), 1, id);
      assert.equal(row.claimed_at, null, id);
      assert.equal(row.sent_at, null, id);
    }
    assert.ok(!gmailSends.some((s) => s.userId === ETHAN), "nothing may leave Ethan's mailbox");
    assert.equal(await leaseOf("appt-ethan-2"), null, "the appointment lease is released");
  });

  await check("ONE operator alert for the pass names every withheld reminder", async () => {
    assert.equal(alerts.length, 1, JSON.stringify(alerts));
    assert.equal(alerts[0].tenantId, OASIS);
    assert.equal(alerts[0].alertType, "founder_meeting_sender_deactivated");
    assert.equal(alerts[0].severity, "warn");
    assert.equal(alerts[0].lane, "operator");
    assert.deepEqual(alerts[0].payload, {
      notification_ids: ["n-ethan-email-1", "n-ethan-email-2"],
      appointment_ids: ["appt-ethan-1", "appt-ethan-2"],
      sender_user_ids: [ETHAN],
    });
    assert.deepEqual(
      tagged(pass1.warned, WARN_TAG).map((args) => args[1]),
      [{ id: "n-ethan-email-1", tenant: OASIS }, { id: "n-ethan-email-2", tenant: OASIS }],
    );
  });

  await check("SMS rows are unchanged: the deactivated host's SMS reminder still leaves the tenant line", async () => {
    assert.deepEqual(smsSends, [{ tenantId: OASIS, to: CLIENT_PHONE }]);
    assert.equal((await rowOf("n-ethan-sms")).status, "sent");
  });

  // Scoped to the active host, so these hold on the unfixed route too.
  await check("an active host's reminder email goes out exactly as before, from their own mailbox", async () => {
    const row = await rowOf("n-ava-email");
    assert.equal(row.status, "sent");
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.last_error, null);
    const sends = gmailSends.filter((s) => s.userId === AVA);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].tenantId, OASIS);
    assert.equal(sends[0].to, "taylor@example.com");
    assert.equal(sends[0].expectedFromAddress, "appt-ava@oasisai.work");
    const touched = await seed.execute({
      sql: `SELECT actor_user_id FROM lead_interactions
            WHERE agent_source = 'founder_meeting_reminder' AND json_extract(metadata, '$.notification_id') = ?`,
      args: ["n-ava-email"],
    });
    assert.deepEqual(touched.rows.map((r) => r.actor_user_id), [AVA]);
  });

  await check("the pass reports the withheld rows as failed and only real sends as sent", async () => {
    assert.equal(pass1.body.claimed, 4);
    assert.equal(pass1.body.sent, 2);
    assert.equal(pass1.body.failed, 2);
    assert.equal(pass1.status, 503, "a failed row degrades the pass, as every failed row already did");
  });

  // ── Pass 2: the standing read fails ───────────────────────────────────────
  await appointment("appt-ava-2", AVA);
  await queue("n-ava-retry", "appt-ava-2", AVA, "email");
  await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
  const pass2 = await dispatch();
  await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");

  await check("a failed standing read requeues the email through the retry path and sends nothing", async () => {
    const row = await rowOf("n-ava-retry");
    assert.equal(row.status, "pending");
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.last_error, "sender_standing_check_failed");
    assert.equal(row.claimed_at, null);
    assert.deepEqual(gmailSends, [], "an unknown standing must not send as the person");
    assert.deepEqual(alerts, [], "a read failure is not a deactivation");
    const errors = tagged(pass2.errored, ERROR_TAG);
    assert.equal(errors.length, 1, "the failed read is logged loudly");
    assert.equal((errors[0][1] as { id?: string }).id, "n-ava-retry");
    assert.equal(await leaseOf("appt-ava-2"), null, "the appointment lease is released");
  });

  // ── Pass 3: the requeued row once standing reads again ────────────────────
  await dispatch();

  await check("the requeued email sends on the next pass once standing can be read", async () => {
    assert.deepEqual(gmailSends.map((s) => s.userId), [AVA]);
    const row = await rowOf("n-ava-retry");
    assert.equal(row.status, "sent");
    assert.equal(Number(row.attempts), 2);
  });

  // ── Pass 4: standing is read once per (tenant, sender) per pass ───────────
  await appointment("appt-ava-3", AVA);
  await appointment("appt-ava-4", AVA);
  await appointment("appt-ben", BEN);
  await queue("n-ava-first", "appt-ava-3", AVA, "email");
  await queue("n-ava-second", "appt-ava-4", AVA, "email");
  await queue("n-ben", "appt-ben", BEN, "email");
  // Take the roster away the moment Ava's first reminder is handed to Gmail:
  // any standing read after that point fails.
  onGmailSend = async () => {
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
  };
  await dispatch();
  onGmailSend = null;
  await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");

  await check("a second email by the same host reuses the standing already read this pass", async () => {
    assert.deepEqual(gmailSends.map((s) => s.userId), [AVA, AVA]);
    assert.equal((await rowOf("n-ava-second")).status, "sent");
  });

  await check("a host not yet read this pass is read, and its failure retries only that row", async () => {
    const row = await rowOf("n-ben");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "sender_standing_check_failed");
    assert.ok(!gmailSends.some((s) => s.userId === BEN));
  });

  seed.close();
  if (failures) {
    console.error(`founder-meeting-reminders-deactivated-host: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("founder-meeting-reminders-deactivated-host: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
