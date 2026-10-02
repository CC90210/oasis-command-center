/**
 * workspace-alerts.test.ts - a client workspace's alerts reach that client,
 * never OASIS's Telegram; OASIS's own founder-meeting texts are unchanged.
 *
 * Before 2026-10-02 writeAgentAlert pushed every alert on the lane its caller
 * named, and every lane is an OASIS credential (CC's bot, the retired SunBiz
 * ops bot). The SMS reply agent, which any workspace's Twilio number feeds
 * since #520, escalated a client's customers' texts on the operator lane, so
 * another business's customers reached CC's phone and the business heard
 * nothing; a matched appointment could even be answered as "OASIS AI:".
 *
 * Everything runs for real against a local libSQL file database: the alert
 * writer and its card, the workspace Telegram sender and the strict credential
 * store (encrypted rows), the SMS reply agent's queue, claim, matching, rules
 * classification, conversation state and replies, and the Feed's own reader.
 * Every OASIS and SunBiz Telegram credential is set to a value a leak would
 * show. Stand-ins replace only what would leave the machine: `fetch` (records
 * every call; Telegram answers per chat), Twilio's sender (records the exact
 * reply), the rep's Gmail, the LLM queue, the canonical-touch writer and the
 * conversations nudge.
 *
 * Run: node --conditions=react-server --import tsx tests/workspace-alerts.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "workspace-alerts-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "workspace-alerts-test-key-material";
process.env.SMS_AGENT_AUTONOMY = "propose";
delete process.env.BRAVO_FORCE_DRY_RUN;
delete process.env.SMS_AGENT_LLM;
// Replies reach the recording Twilio stand-in below, so their exact words show.
process.env.LIVE_SEND_TWILIO = "1";
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_)/.test(key)) delete process.env[key];
}

// Every OASIS and SunBiz Telegram credential, set to values a leak would show.
const ENV_TELEGRAM: Record<string, string> = {
  OASIS_TELEGRAM_BOT_TOKEN: "1001:oasis-operator-token",
  OASIS_TELEGRAM_CHAT_ID: "5550001",
  TELEGRAM_BOT_TOKEN: "1002:bare-telegram-token",
  TELEGRAM_CHAT_ID: "5550002",
  SUNBIZ_OPS_TELEGRAM_BOT_TOKEN: "1003:sunbiz-ops-token",
  SUNBIZ_TELEGRAM_BOT_TOKEN: "1004:sunbiz-token",
  SUNBIZ_OPS_TELEGRAM_CHAT_ID: "-1005550003",
  SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID: "5550004",
};
Object.assign(process.env, ENV_TELEGRAM);
const ENV_TOKENS = Object.entries(ENV_TELEGRAM)
  .filter(([key]) => key.endsWith("_TOKEN"))
  .map(([, value]) => value);

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // slug "oasis-ai-cc"
const OASIS_WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d"; // slug "oasis-webdev"
const CLIENT_A = "c1c1c1c1-0000-4000-8000-0000000000a1"; // saved its own bot
const CLIENT_B = "c2c2c2c2-0000-4000-8000-0000000000b2"; // saved nothing
const CLIENT_C = "c3c3c3c3-0000-4000-8000-0000000000c3"; // saved a bot that will not decrypt
const CLIENT_A_TOKEN = "2001:client-a-own-bot";
const CLIENT_A_CHAT = "-1009990001";
const OASIS_SAVED_TOKEN = "2002:oasis-saved-workspace-bot";
const HOST = "7a7a7a7a-0000-4000-8000-000000000001";
const HOST_EMAIL = "host@oasisai.work";

type TelegramCall = { url: string; token: string; chatId: string; text: string };
const calls: TelegramCall[] = [];
const refusingChats = new Set<string>();
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  let body: { chat_id?: unknown; text?: unknown } = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {
    body = {};
  }
  const chatId = String(body.chat_id ?? "");
  calls.push({ url, token: url.match(/\/bot([^/]+)\//)?.[1] ?? "", chatId, text: String(body.text ?? "") });
  if (!url.startsWith("https://api.telegram.org/")) {
    return new Response("network disabled in test", { status: 503 });
  }
  if (refusingChats.has(chatId)) {
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
}) as typeof fetch;

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

type TwilioSend = { tenantId: string; to: string; body: string };
const twilioSends: TwilioSend[] = [];
stubModule(require.resolve("../lib/sms-direct-twilio"), {
  sendSmsDirectTwilio: async (args: TwilioSend) => {
    twilioSends.push({ tenantId: args.tenantId, to: args.to, body: args.body });
    return { ok: true, message_sid: `SM-out-${twilioSends.length}` };
  },
});
const repMails: Array<{ tenantId: string; to: string }> = [];
stubModule(require.resolve("../lib/integrations/gmail-oauth-send"), {
  sendGmailAsOperator: async (args: { tenantId: string; to: string; expectedFromAddress: string }) => {
    repMails.push({ tenantId: args.tenantId, to: args.to });
    return { ok: true, provider: "gmail_oauth", gmail_message_id: "gm-1", thread_id: "th-1", from_address: args.expectedFromAddress };
  },
});
stubModule(require.resolve("../lib/bridge-infer"), {
  queueInfer: async () => {
    throw new Error("the LLM classifier is off in this test");
  },
});
stubModule(require.resolve("../lib/leads/canonical-touch"), {
  persistCanonicalLeadTouch: async () => undefined,
});
stubModule(require.resolve("../lib/realtime/conversations-nudge"), {
  nudgeConversations: async () => undefined,
});

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(error as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

/** Silence the code under test's expected log lines. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** The tag a warn alert opens with (U+26A0 U+FE0F), built here so this file stays ASCII. */
const WARN = String.fromCharCode(0x26a0, 0xfe0f);
const usedEnvToken = (c: TelegramCall) => ENV_TOKENS.includes(c.token);

/** A JSON column as an object, however the driver hands it back. */
function payloadOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return JSON.parse(String(value || "{}")) as Record<string, unknown>;
}

async function main() {
  console.log("workspace-alerts:");
  const seed = createClient({ url: `file:${dbFile}` });
  // agent_alerts and agent_events exactly as the live database defines them.
  await seed.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE agent_alerts (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "alert_type" TEXT NOT NULL,
      "severity" TEXT NOT NULL DEFAULT 'info',
      "subject_type" TEXT,
      "subject_id" TEXT,
      "title" TEXT NOT NULL,
      "body" TEXT,
      "payload" TEXT NOT NULL DEFAULT '{}',
      "dedup_key" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "resolved_at" TEXT,
      "resolved_by" TEXT,
      PRIMARY KEY ("id"),
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE TABLE agent_events (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "event_type" TEXT NOT NULL,
      "publisher_agent" TEXT NOT NULL,
      "target_agent" TEXT,
      "severity" TEXT NOT NULL DEFAULT 'info',
      "payload" TEXT NOT NULL DEFAULT '{}',
      "correlation_id" TEXT,
      "published_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "consumed_by" TEXT DEFAULT '[]',
      "expires_at" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "source_agent" TEXT NOT NULL DEFAULT 'unknown',
      "idempotency_key" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "processed_at" TEXT,
      "processed_by" TEXT,
      "retry_count" INTEGER NOT NULL DEFAULT 0,
      "last_error" TEXT,
      "visibility_until" TEXT,
      PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "idx_agent_events_idem" ON "agent_events" (idempotency_key) WHERE (idempotency_key IS NOT NULL);
    CREATE TABLE tenant_integration_credentials (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT,
      created_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, service, field_key)
    );
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
  await seed.execute({
    sql: "INSERT INTO tenants (id) VALUES (?), (?), (?), (?), (?)",
    args: [OASIS, OASIS_WEBDEV, CLIENT_A, CLIENT_B, CLIENT_C],
  });
  const { encryptField } = await import("../lib/field-encryption");
  const saveCredential = (tenantId: string, field: string, encrypted: string) =>
    seed.execute({
      sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value)
            VALUES (?, 'telegram', ?, ?)`,
      args: [tenantId, field, encrypted],
    });
  await saveCredential(CLIENT_A, "bot_token", encryptField(CLIENT_A_TOKEN));
  await saveCredential(CLIENT_A, "chat_id", encryptField(CLIENT_A_CHAT));
  await saveCredential(CLIENT_C, "bot_token", "not-a-ciphertext");
  await saveCredential(CLIENT_C, "chat_id", encryptField("-1009990003"));
  // OASIS saved a workspace bot too: its alerts must still ride the lane.
  await saveCredential(OASIS, "bot_token", encryptField(OASIS_SAVED_TOKEN));
  await saveCredential(OASIS, "chat_id", encryptField("-1009990009"));
  await seed.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at)
          VALUES ('p-host', ?, ?, ?, 'owner', 'Ava', '2026-09-01T00:00:00Z')`,
    args: [HOST, HOST_EMAIL, OASIS],
  });

  const rows = async (sql: string, args: Array<string | number | null> = []) =>
    (await seed.execute({ sql, args })).rows as unknown as Array<Record<string, unknown>>;
  const alertCard = async (tenantId: string, alertType: string) => {
    const found = await rows(
      "SELECT id, title, body, payload, resolved_at FROM agent_alerts WHERE tenant_id = ? AND alert_type = ?",
      [tenantId, alertType],
    );
    return found;
  };

  const { writeAgentAlert } = await import("../lib/notify/agent-alert");
  const { sendWorkspaceTelegram } = await import("../lib/notify/workspace-telegram");

  // -- Part A: the alert writer ------------------------------------------------
  await check("a client alert reaches the bot the client saved, and no OASIS or SunBiz token", async () => {
    calls.length = 0;
    const result = await quietly(() =>
      writeAgentAlert({
        tenantId: CLIENT_A,
        alertType: "drip_missing_app_link",
        severity: "warn",
        title: "Drip email held: Q&A <follow-up>",
        body: "Lead 42 has no application link.",
        lane: "operator",
        subjectType: "drip_sequence",
        subjectId: "seq-a",
        payload: { step_index: 2 },
      }),
    );
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0].token, CLIENT_A_TOKEN, "the push used another bot than the client's own");
    assert.equal(calls[0].chatId, CLIENT_A_CHAT);
    assert.ok(!calls.some(usedEnvToken), "a client alert touched an OASIS or SunBiz token");
    assert.match(calls[0].text, /Q&amp;A &lt;follow-up&gt;/, "client text reaches Telegram HTML unescaped");
    assert.deepEqual(result, { telegram: "sent" });
    const card = await alertCard(CLIENT_A, "drip_missing_app_link");
    assert.equal(card.length, 1, "the client's in-app card is missing");
    assert.deepEqual(payloadOf(card[0].payload), { step_index: 2, telegram: "sent" });
  });

  await check("the lane a caller names is ignored for a client, sunbiz-ops included", async () => {
    calls.length = 0;
    await quietly(() =>
      writeAgentAlert({
        tenantId: CLIENT_A,
        alertType: "sms_carrier_route_dead",
        severity: "urgent",
        title: "SMS halted",
        lane: "sunbiz-ops",
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].token, CLIENT_A_TOKEN);
    assert.ok(!calls.some(usedEnvToken));
  });

  await check("a client with no saved bot: an in-app card that says 'not connected', and no Telegram at all", async () => {
    calls.length = 0;
    // No payload: the card must still be written (agent_alerts.payload is NOT NULL).
    const result = await quietly(() =>
      writeAgentAlert({
        tenantId: CLIENT_B,
        alertType: "sms_agent_dead_letter",
        severity: "urgent",
        title: "A customer's text could not be added to your Feed",
        lane: "operator",
        subjectType: "sms_agent_job",
        subjectId: "job-b",
      }),
    );
    assert.deepEqual(calls, [], "a client without a bot was paged somewhere");
    assert.deepEqual(result, { telegram: "not connected" });
    const card = await alertCard(CLIENT_B, "sms_agent_dead_letter");
    assert.equal(card.length, 1, "no in-app card was written");
    assert.equal(card[0].resolved_at, null);
    assert.equal(payloadOf(card[0].payload).telegram, "not connected");
  });

  await check("a saved bot that will not decrypt says so on the card, and nothing falls back", async () => {
    calls.length = 0;
    await quietly(() =>
      writeAgentAlert({ tenantId: CLIENT_C, alertType: "drip_safety_lookup_failed", severity: "warn", title: "x", lane: "operator" }),
    );
    assert.deepEqual(calls, []);
    const card = await alertCard(CLIENT_C, "drip_safety_lookup_failed");
    assert.equal(payloadOf(card[0].payload).telegram, "saved bot could not be read");
  });

  await check("Telegram refusing the client's chat is recorded in plain words, without the token, and is not retried elsewhere", async () => {
    calls.length = 0;
    refusingChats.add(CLIENT_A_CHAT);
    try {
      const result = await quietly(() =>
        writeAgentAlert({ tenantId: CLIENT_A, alertType: "tt_credits_exhausted", severity: "urgent", title: "x", lane: "operator" }),
      );
      assert.deepEqual(result, { telegram: "failed: Bad Request: chat not found" });
    } finally {
      refusingChats.delete(CLIENT_A_CHAT);
    }
    assert.equal(calls.length, 1, "a refused client alert was re-sent to another chat");
    const card = await alertCard(CLIENT_A, "tt_credits_exhausted");
    const recorded = String(payloadOf(card[0].payload).telegram);
    assert.equal(recorded, "failed: Bad Request: chat not found");
    assert.ok(!recorded.includes(CLIENT_A_TOKEN));
  });

  await check("once per open card: a refresh pages nobody and keeps the outcome the first push recorded", async () => {
    calls.length = 0;
    const alert = {
      tenantId: CLIENT_A,
      alertType: "optout_stamp_unrepairable",
      severity: "warn" as const,
      title: "Opt-out timestamp could not be repaired",
      lane: "operator" as const,
      subjectType: "lead",
      subjectId: "lead-a",
      telegramOncePerOpen: true,
    };
    await quietly(() => writeAgentAlert(alert));
    await quietly(() => writeAgentAlert({ ...alert, body: "second sighting" }));
    assert.equal(calls.length, 1, "the refresh paged again");
    const card = await alertCard(CLIENT_A, "optout_stamp_unrepairable");
    assert.equal(card.length, 1, "the refresh opened a second card");
    assert.equal(card[0].body, "second sighting");
    assert.equal(payloadOf(card[0].payload).telegram, "sent", "the refresh dropped the recorded outcome");
  });

  await check("OASIS's own alerts keep the lane their caller names, even with a workspace bot saved", async () => {
    calls.length = 0;
    await quietly(() =>
      writeAgentAlert({ tenantId: OASIS, alertType: "oasis_operator_check", severity: "warn", title: "Founder check", lane: "operator" }),
    );
    await quietly(() =>
      writeAgentAlert({ tenantId: OASIS, alertType: "oasis_ops_check", severity: "warn", title: "Ops check", lane: "sunbiz-ops" }),
    );
    assert.deepEqual(
      calls.map((c) => [c.token, c.chatId]),
      [
        [ENV_TELEGRAM.OASIS_TELEGRAM_BOT_TOKEN, ENV_TELEGRAM.OASIS_TELEGRAM_CHAT_ID],
        [ENV_TELEGRAM.SUNBIZ_OPS_TELEGRAM_BOT_TOKEN, ENV_TELEGRAM.SUNBIZ_OPS_TELEGRAM_CHAT_ID],
      ],
    );
    assert.ok(!calls.some((c) => c.token === OASIS_SAVED_TOKEN));
    assert.equal(calls[0].text, `${WARN} Founder check`, "the OASIS page's text changed");
    const card = await alertCard(OASIS, "oasis_operator_check");
    assert.equal(payloadOf(card[0].payload).telegram, "sent");
  });

  await check("the workspace sender never reads an env value, even for an OASIS workspace with none saved", async () => {
    calls.length = 0;
    const result = await quietly(() => sendWorkspaceTelegram(OASIS_WEBDEV, "hello"));
    assert.deepEqual(result, { ok: false, reason: "workspace_telegram_not_connected" });
    assert.deepEqual(calls, []);
    assert.deepEqual(await quietly(() => sendWorkspaceTelegram("", "hello")), {
      ok: false,
      reason: "workspace_telegram_not_connected",
    });
  });

  await check("drip alerts never name the retired SunBiz lane", () => {
    assert.doesNotMatch(readFileSync("lib/drips/executor.ts", "utf8"), /lane:\s*"sunbiz-ops"/);
  });

  // -- Part B: the SMS reply agent ---------------------------------------------
  let received = 0;
  const appointmentFor = async (tenantId: string, key: string, phone: string) => {
    const appointmentId = `appt-${key}`;
    const leadId = `lead-${key}`;
    const scheduledFor = new Date(Date.now() + 2 * 864e5).toISOString();
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
      args: [appointmentId, tenantId, leadId, scheduledFor, HOST, HOST, phone, `event-${key}`, HOST_EMAIL, `booking-${key}`],
    });
    return { appointmentId, leadId };
  };
  const inbound = async (input: {
    tenantId: string;
    key: string;
    phoneLast10: string;
    body: string;
    withAppointment?: boolean;
    carrierStop?: boolean;
  }) => {
    const phone = `+1${input.phoneLast10}`;
    const linked = input.withAppointment ? await appointmentFor(input.tenantId, input.key, phone) : null;
    const leadId = linked?.leadId ?? `lead-${input.key}`;
    await seed.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [leadId, input.tenantId, JSON.stringify({ stage: "founder_meeting_booked", assigned_to: HOST, phone })],
    });
    received += 1;
    const receivedAt = new Date(Date.now() - (100 - received) * 1_000).toISOString();
    const sid = `SM-${input.key}`;
    await seed.execute({
      sql: `INSERT INTO lead_interactions (id, tenant_id, lead_id, type, channel, direction, provider,
              provider_message_id, content, created_at)
            VALUES (?, ?, ?, 'sms_received', 'sms', 'inbound', 'twilio', ?, ?, ?)`,
      args: [`in-${input.key}`, input.tenantId, leadId, sid, input.body, receivedAt],
    });
    await seed.execute({
      sql: `INSERT INTO sms_agent_jobs (id, tenant_id, provider, provider_message_id, from_phone, to_phone,
              phone_last10, body, lead_id, appointment_id, interaction_id, status, intent, intent_confidence,
              intent_source, proposed_action, executed_action, received_at)
            VALUES (?, ?, 'twilio', ?, ?, '+14385550000', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      args: [
        `job-${input.key}`, input.tenantId, sid, phone, input.phoneLast10, input.body, leadId,
        linked?.appointmentId ?? null, `in-${input.key}`,
        input.carrierStop ? "opt_out" : null,
        input.carrierStop ? "high" : null,
        input.carrierStop ? "rules" : "none",
        input.carrierStop ? "cancel_meeting" : null,
        input.carrierStop ? "suppress_and_cancel_sms" : null,
        receivedAt,
      ],
    });
    return { phone, leadId, appointmentId: linked?.appointmentId ?? null };
  };
  const job = async (key: string) =>
    (await rows("SELECT status, proposed_action, executed_action, last_error, intent FROM sms_agent_jobs WHERE id = ?", [`job-${key}`]))[0];
  const feedFor = async (jobKey: string) =>
    rows("SELECT event_type, publisher_agent, severity, correlation_id, payload FROM agent_events WHERE idempotency_key = ?", [
      `sms-agent:job-${jobKey}:workspace-feed`,
    ]);

  const { runSmsReplyAgentWorker } = await import("../lib/sms/reply-agent");
  const { loadTenantFeed } = await import("../components/os/landings/feed-data");

  // Run 1: only client workspaces' texts are queued.
  const text = await inbound({ tenantId: CLIENT_A, key: "client-text", phoneLast10: "4165550101", body: "Do you have any openings Friday?  I need a cleaning" });
  const matched = await inbound({
    tenantId: CLIENT_B,
    key: "client-matched",
    phoneLast10: "4165550102",
    body: "I'm running 10 minutes late",
    withAppointment: true,
  });
  const stop = await inbound({ tenantId: CLIENT_A, key: "client-stop", phoneLast10: "4165550103", body: "STOP", carrierStop: true });
  calls.length = 0;
  twilioSends.length = 0;
  repMails.length = 0;
  const alertsBefore = (await rows("SELECT COUNT(*) AS n FROM agent_alerts"))[0].n;
  const run1 = await quietly(() => runSmsReplyAgentWorker());

  await check("a client's customer text becomes needs_reply on the job, with no Telegram push to anyone", async () => {
    const row = await job("client-text");
    assert.equal(row.status, "escalated", JSON.stringify(row));
    assert.equal(row.proposed_action, "needs_reply");
    assert.equal(row.executed_action, "workspace_feed_posted");
    assert.equal(row.last_error, null);
    assert.deepEqual(calls, [], "an inbound client text paged a Telegram chat");
    assert.equal((await rows("SELECT COUNT(*) AS n FROM agent_alerts"))[0].n, alertsBefore, "an alert card was written");
  });

  await check("...and a Feed item in that workspace, which the Feed's own reader returns", async () => {
    const feed = await feedFor("client-text");
    assert.equal(feed.length, 1);
    assert.equal(feed[0].event_type, "CUSTOMER_TEXT_NEEDS_REPLY");
    assert.equal(feed[0].correlation_id, CLIENT_A);
    assert.equal(feed[0].publisher_agent, "dept:sales");
    const payload = payloadOf(feed[0].payload);
    assert.equal(payload.preview, `${text.phone}: Do you have any openings Friday? I need a cleaning`);
    assert.equal(payload.lead_id, text.leadId);
    const clientFeed = await loadTenantFeed({ tenantId: CLIENT_A });
    assert.ok(clientFeed.ok && clientFeed.rows.some((r) => r.event_type === "CUSTOMER_TEXT_NEEDS_REPLY"));
    const oasisFeed = await loadTenantFeed({ tenantId: OASIS });
    assert.ok(oasisFeed.ok && oasisFeed.rows.length === 0, "a client's text reached OASIS's Feed");
  });

  await check("a client text matching a founder appointment is never answered as OASIS", async () => {
    const row = await job("client-matched");
    assert.equal(row.status, "escalated");
    assert.equal(row.proposed_action, "needs_reply");
    assert.deepEqual(twilioSends, [], "the agent texted a client's customer");
    assert.deepEqual(repMails, []);
    const conversation = await rows("SELECT state FROM sms_agent_conversations WHERE tenant_id = ?", [CLIENT_B]);
    assert.deepEqual(conversation, [], "the founder flow ran for a client workspace");
    const appointment = (await rows("SELECT revision, workflow_status FROM call_appointments WHERE id = ?", [matched.appointmentId]))[0];
    assert.equal(Number(appointment.revision), 1);
    assert.equal(appointment.workflow_status, "active");
    assert.equal((await feedFor("client-matched")).length, 1);
  });

  await check("a client customer's STOP is posted as an opt-out, closed, and never answered", async () => {
    const row = await job("client-stop");
    assert.equal(row.status, "done", JSON.stringify(row));
    assert.equal(row.proposed_action, "cancel_meeting", "the carrier ledger was rewritten");
    assert.equal(row.executed_action, "suppress_and_cancel_sms,workspace_feed_posted");
    const feed = await feedFor("client-stop");
    assert.equal(feed.length, 1);
    assert.equal(feed[0].event_type, "CUSTOMER_OPTED_OUT_OF_TEXTS");
    assert.equal(feed[0].severity, "info");
    assert.equal(payloadOf(feed[0].payload).preview, `${stop.phone} replied STOP. Texts to this number are off.`);
  });

  await check("the run counts the hand-offs, and none of them as a failure", async () => {
    assert.equal(run1.processed, 3);
    assert.equal(run1.escalated, 2);
    assert.equal(run1.done, 1);
    assert.equal(run1.failed, 0);
  });

  await check("a retried hand-off posts its Feed item once", async () => {
    await seed.execute({
      sql: "UPDATE sms_agent_jobs SET status = 'pending', completed_at = NULL, executed_action = NULL WHERE id = ?",
      args: ["job-client-text"],
    });
    const retry = await quietly(() => runSmsReplyAgentWorker());
    assert.equal(retry.failed, 0);
    assert.equal((await job("client-text")).status, "escalated");
    assert.equal((await feedFor("client-text")).length, 1, "the retry posted the text twice");
  });

  // Run 2: OASIS's own founder-meeting texts, pinned to their pre-change words.
  const late = await inbound({ tenantId: OASIS, key: "oasis-late", phoneLast10: "4165550104", body: "I'm running 10 minutes late", withAppointment: true });
  const resched = await inbound({ tenantId: OASIS, key: "oasis-resched", phoneLast10: "4165550105", body: "I need to reschedule", withAppointment: true });
  calls.length = 0;
  twilioSends.length = 0;
  repMails.length = 0;
  await quietly(() => runSmsReplyAgentWorker());

  await check("OASIS founder meeting: the running-late reply is word for word what it was", async () => {
    const sent = twilioSends.find((s) => s.to === late.phone);
    assert.ok(sent, JSON.stringify(twilioSends));
    assert.equal(sent.tenantId, OASIS);
    assert.equal(
      sent.body,
      "OASIS AI: Thanks for letting us know. Your OASIS rep has been notified.\n" +
        "Reply STOP to opt out. HELP for help. Msg & data rates may apply.",
    );
    const row = await job("oasis-late");
    assert.equal(row.status, "escalated");
    assert.equal(row.executed_action, "reply_send_reserved,reply_sent");
  });

  await check("OASIS founder meeting: slot offers read in Toronto time, inside its business hours", async () => {
    const sent = twilioSends.find((s) => s.to === resched.phone);
    assert.ok(sent, JSON.stringify(twilioSends));
    const state = (await rows("SELECT state, proposed_slots FROM sms_agent_conversations WHERE tenant_id = ? AND phone_last10 = ?", [OASIS, "4165550105"]))[0];
    assert.equal(state.state, "awaiting_slot_choice");
    const slots = JSON.parse(String(state.proposed_slots)) as Array<{ localIso: string; meetingAt: string; label: string }>;
    assert.equal(slots.length, 3);
    const toronto = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const torontoClock = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    for (const slot of slots) {
      assert.equal(slot.label, toronto.format(new Date(slot.meetingAt)), "a slot label is not Toronto time");
      const parts = Object.fromEntries(torontoClock.formatToParts(new Date(slot.meetingAt)).map((p) => [p.type, p.value]));
      const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
      assert.ok(minuteOfDay >= 9 * 60 && minuteOfDay + 15 <= 18 * 60, `slot outside 9-18 Toronto: ${slot.localIso}`);
      assert.ok(!["Sat", "Sun"].includes(String(parts.weekday)), `weekend slot: ${slot.localIso}`);
    }
    assert.equal(
      sent.body,
      `OASIS AI: Would one of these work? 1) ${slots[0].label}; 2) ${slots[1].label}; 3) ${slots[2].label}. Reply 1, 2, or 3.\n` +
        "Reply STOP to opt out. HELP for help. Msg & data rates may apply.",
    );
  });

  await check("OASIS founder meeting: the rep is paged on OASIS's operator lane, as before", async () => {
    const pages = calls.filter((c) => c.text.includes("Inbound meeting SMS needs rep attention"));
    assert.equal(pages.length, 2, JSON.stringify(calls));
    for (const page of pages) {
      assert.equal(page.token, ENV_TELEGRAM.OASIS_TELEGRAM_BOT_TOKEN);
      assert.equal(page.chatId, ENV_TELEGRAM.OASIS_TELEGRAM_CHAT_ID);
    }
    assert.ok(pages.some((p) => p.text === `${WARN} Inbound meeting SMS needs rep attention\nIntent: running_late. Calendar unchanged.`));
    assert.equal(repMails.length, 2, "the host's rep copy stopped");
    const cards = await rows(
      "SELECT subject_id FROM agent_alerts WHERE alert_type = 'sms_agent_human_review' AND tenant_id = ? ORDER BY subject_id",
      [OASIS],
    );
    assert.deepEqual(cards.map((c) => c.subject_id), [late.appointmentId, resched.appointmentId]);
  });

  seed.close();
  if (failures) {
    console.error(`workspace-alerts: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("workspace-alerts: ok");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
