/**
 * workspace-alerts.test.ts - a client workspace's alerts reach that client,
 * never OASIS's Telegram; OASIS's own founder-meeting texts are unchanged.
 *
 * Before 2026-10-02 every alert sender named a Telegram lane, and every lane
 * is an OASIS credential (CC's bot, the retired SunBiz ops bot). The SMS reply
 * agent, which any workspace's Twilio number feeds since #520, escalated a
 * client's customers' texts on the operator lane, so another business's
 * customers reached CC's phone and the business heard nothing; a matched
 * appointment could even be answered as "OASIS AI:". The customer's words then
 * sat in a Feed payload that /api/event-feed handed raw to any member.
 *
 * WHAT RUNS FOR REAL, against a local libSQL file database whose alert, event,
 * credential, receipt, form and ladder tables are the live DDL verbatim: the
 * alert writer, its card and the one audience resolver
 * (lib/notify/alert-route.ts), the workspace Telegram sender and the strict
 * credential store (encrypted rows), the SMS reply agent (queue, claim,
 * matching, classification, conversation state, replies, dead letters),
 * /api/event-feed with real signed sessions, the Feed's own reader, the
 * Needs-you reads and builder, the alert resolve route, the dashboard's alert
 * read, the reconcile-sms cron with the real carrier breaker and line-health
 * rules over real receipt rows, the benched-line announcer and the public-form
 * failure capture. Every OASIS and SunBiz Telegram credential is set to a value
 * a leak would show.
 *
 * STAND-INS replace only what would leave the machine: fetch (records every
 * call; Telegram answers per chat, and can quote the bot token back the way a
 * real error can), Twilio's sender (records the exact reply), the rep's Gmail,
 * the LLM queue, the canonical-touch writer, the conversations nudge, and the
 * two TextTorrent API calls (receipt reconciliation, and the list of tenants
 * with open receipts) plus the destination-health refresh the reconcile cron
 * makes. Rendered rows come from tests/workspace-alerts.render.ts
 * (react-dom/server does not load here).
 *
 * Run: node --conditions=react-server --import tsx tests/workspace-alerts.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = process.cwd();
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
// Real signed sessions for /api/event-feed and the resolve route.
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "workspace-alerts-session-secret-long-enough-000001";
delete process.env.OPERATOR_EMAIL; // the hardcoded default alias is the operator's
delete process.env.ADMIN_EMAILS;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.CRON_SECRET = "workspace-alerts-cron-secret";
delete process.env.CRON_ALLOW_LOCAL;
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
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110"; // retired 2026-09-28
const CLIENT_A = "c1c1c1c1-0000-4000-8000-0000000000a1"; // provisioned ("suga" seed); saved its own bot
const CLIENT_B = "c2c2c2c2-0000-4000-8000-0000000000b2"; // saved nothing
const CLIENT_C = "c3c3c3c3-0000-4000-8000-0000000000c3"; // saved a bot that will not decrypt
const CLIENT_D = "c4c4c4c4-0000-4000-8000-0000000000d4"; // saved nothing; reconcile scenarios
const CLIENT_E = "c5c5c5c5-0000-4000-8000-0000000000e5"; // saved nothing; reconcile scenarios
const CLIENT_A_TOKEN = "2001:client-a-own-bot";
const CLIENT_A_CHAT = "-1009990001";
const OASIS_SAVED_TOKEN = "2002:oasis-saved-workspace-bot";
const HOST = "7a7a7a7a-0000-4000-8000-000000000001";
const HOST_EMAIL = "host@oasisai.work";

type U = { id: string; email: string };
const person = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: person(1, "conaugh@oasisai.work"), // the operator alias; an OASIS owner
  aOwner: person(2, "owner@client-a.test"),
  aRep: person(3, "rep@client-a.test"), // a commission-only closer
  bOwner: person(4, "owner@client-b.test"),
  aMember: person(5, "member@client-a.test"), // team_role member: may see system surfaces and act, not an owner
  aViewer: person(6, "viewer@client-a.test"), // team_role read_only
} as const;

type TelegramCall = { url: string; token: string; chatId: string; text: string };
const calls: TelegramCall[] = [];
/** Answer 400 and quote the request (bot token included) in the description. */
const refusingChats = new Set<string>();
/** Throw, with the request URL (bot token included) in the error message. */
const unreachableChats = new Set<string>();
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  let body: { chat_id?: unknown; text?: unknown } = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {
    body = {};
  }
  const chatId = String(body.chat_id ?? "");
  const token = url.match(/\/bot([^/]+)\//)?.[1] ?? "";
  calls.push({ url, token, chatId, text: String(body.text ?? "") });
  if (!url.startsWith("https://api.telegram.org/")) {
    return new Response("network disabled in test", { status: 503 });
  }
  if (unreachableChats.has(chatId)) throw new Error(`request to ${url} failed, reason: socket hang up`);
  if (refusingChats.has(chatId)) {
    return new Response(JSON.stringify({ ok: false, description: `Bad Request: chat not found (bot${token})` }), { status: 400 });
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
const notCalled = (name: string) => async () => {
  throw new Error(`${name} must not be called in this test`);
};

// Sessions: the real signed cookie, read through a stand-in cookie store.
const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
stubModule(require.resolve("next/headers"), {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stubModule(require.resolve("next/navigation"), {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});

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
// The reconcile cron's TextTorrent API side: which tenants have open receipts,
// and closing them. The receipts it then READS, the carrier breaker over them
// and the line-health rules are the real code (stubbed in main(), over the
// real module, before anything imports it).
let openReceiptTenants: string[] = [];
const reconcileErrors: Record<string, string[]> = {};
stubModule(require.resolve("../lib/sms/destination-health"), {
  refreshDestinationHealth: async () => ({ examined: 0, untextable: 0, verified: 0, written: 0, error: null }),
  isTextable: notCalled("isTextable"),
  resolveSendNumber: notCalled("resolveSendNumber"),
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

const usedEnvToken = (c: TelegramCall) => ENV_TOKENS.includes(c.token);

/** The tags an alert opens with (U+26A0 U+FE0F warn, U+1F6A8 urgent), built here so this file stays ASCII. */
const WARN = String.fromCharCode(0x26a0, 0xfe0f);

/** A JSON column as an object, however the driver hands it back. */
function payloadOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return JSON.parse(String(value || "{}")) as Record<string, unknown>;
}

/** The keys BEA's event router copies into its log (scripts/core/event_router.py _project). */
const ROUTER_LOGGED_KEYS = [
  "note", "preview", "agent", "kind", "lead_id", "channel", "intent", "client", "platform", "post_url",
  "amount_cad", "amount_usd", "net_mrr_usd", "v6_mode", "session_id", "invoice_id", "destination_last4",
];

// -- the lane ratchet: which files may name a Telegram lane ------------------
const LANE_PATTERNS: readonly RegExp[] = [
  /\blane\s*:\s*\[?\s*["'](?:operator|sunbiz-ops)["']/, // lane: "operator" / lane: ["operator", ...]
  /\bTelegramLane\b/, // the lane type itself
  /sendTelegram\([^;]*?\{\s*lane\b/, // sendTelegram(text, { lane }) / { lane: x }
];
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function namesLane(src: string): boolean {
  const code = codeOnly(src);
  return LANE_PATTERNS.some((re) => re.test(code));
}
/**
 * Files still allowed to name a lane, each with the reason. This list may only
 * shrink: a new sender routes through lib/notify/alert-route.ts.
 */
const LANE_ALLOWED: Readonly<Record<string, string>> = {
  "lib/notify/telegram.ts": "defines the lanes",
  "lib/notify/alert-route.ts": "the one resolver: an alert's audience from its workspace",
  "lib/health/runner.ts": "estate health checks, run only under OASIS's own workspace; audiences pinned by tests/health-recovery-delivery.test.ts",
  "lib/health/guard-audit.ts": "estate health checks, run only under OASIS's own workspace",
  "lib/health/form-checks.ts": "estate health checks, run only under OASIS's own workspace",
  "lib/health/calendar-checks.ts": "estate health checks, run only under OASIS's own workspace",
  "lib/health/worker-reporter-checks.ts": "estate health checks, run only under OASIS's own workspace",
  "lib/health/drip-checks.ts": "estate health checks, run only under OASIS's own workspace",
  "lib/health/deploy-checks.ts": "estate health checks, run only under OASIS's own workspace",
  "lib/forms/oasis-funnel-notify.ts": "OASIS's own funnel on oasisai.work: always OASIS's workspace",
  "lib/forms/ai-audit-notify.ts": "OASIS's own AI-audit funnel: always OASIS's workspace",
  "lib/website-sales-booking.ts": "OASIS's own website-sales program",
  "lib/delivery/notify.ts": "OASIS's own support desk (deskUsesOasisLanes); a client desk moves to its own bot in the desk-lanes track",
  "lib/tenant/public-identity.ts": "notifyLanesForTenant: no sender calls it since the form failure moved to the resolver (2026-10-08); tests/tenant-public-identity.test.ts still does",
  "lib/drips/reply-handoff.ts": "LO4: no caller",
};
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(ROOT, rel))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const child = rel ? `${rel}/${name}` : name;
      const full = join(ROOT, child);
      if (statSync(full).isDirectory()) walk(child);
      else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.set(child.split(sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  return out;
}

async function main() {
  console.log("workspace-alerts:");
  const realReceipts = await import("../lib/sms/delivery-receipts");
  stubModule(require.resolve("../lib/sms/delivery-receipts"), {
    ...realReceipts,
    tenantsWithOpenReceipts: async () => openReceiptTenants,
    reconcileReceipts: async (tenantId: string) => ({
      examined: 0, resolved: 0, delivered: 0, failed: 0, stillOpen: 0, abandoned: 0, errors: reconcileErrors[tenantId] ?? [],
    }),
    openReceipt: notCalled("openReceipt"),
  });
  const seed = createClient({ url: `file:${dbFile}` });
  // agent_alerts, agent_events, tenant_integration_credentials,
  // health_alert_state, sms_delivery_receipts, forms and form_submit_failures
  // exactly as the live database defines them (read from sqlite_master
  // 2026-10-08), indexes included; sms_agent_jobs from its migration, CHECKs
  // included.
  await seed.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, logo_url TEXT, custom_fields TEXT);
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      brand TEXT, primary_agent TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      created_at TEXT, updated_at TEXT, deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenant_invites (id TEXT PRIMARY KEY, email TEXT, token_hash TEXT, created_at TEXT,
      redeemed_at TEXT, revoked_at TEXT, expires_at TEXT);
    CREATE TABLE "agent_alerts" (
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
    CREATE UNIQUE INDEX "agent_alerts_pkey" ON "agent_alerts" (id);
    CREATE INDEX "idx_agent_alerts_open" ON "agent_alerts" (tenant_id, severity, created_at DESC) WHERE (resolved_at IS NULL);
    CREATE INDEX "idx_agent_alerts_subject" ON "agent_alerts" (tenant_id, subject_type, subject_id);
    CREATE UNIQUE INDEX "idx_agent_alerts_dedup" ON "agent_alerts" (tenant_id, dedup_key) WHERE ((dedup_key IS NOT NULL) AND (resolved_at IS NULL));
    CREATE TABLE "agent_events" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
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
    CREATE INDEX "idx_agent_events_correlation" ON "agent_events" (correlation_id) WHERE (correlation_id IS NOT NULL);
    CREATE UNIQUE INDEX "idx_agent_events_idem" ON "agent_events" (idempotency_key) WHERE (idempotency_key IS NOT NULL);
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "service" TEXT NOT NULL,
      "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL,
      "last_tested_at" TEXT,
      "last_test_ok" INTEGER,
      "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"),
      FOREIGN KEY ("created_by") REFERENCES "user_profiles" ("id") ON DELETE SET NULL,
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX "tenant_integration_credentials_tenant_id_service_field_key_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
    CREATE TABLE "health_alert_state" (
      "alert_key" TEXT NOT NULL,
      "tenant_id" TEXT,
      "last_signature" TEXT,
      "last_alerted_at" TEXT,
      "repeat_n" INTEGER NOT NULL DEFAULT 0,
      "first_failed_at" TEXT,
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("alert_key"),
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "sms_delivery_receipts" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "drip_run_id" TEXT,
      "lead_id" TEXT,
      "chat_id" TEXT NOT NULL,
      "rep_key" TEXT,
      "act_as_email" TEXT,
      "from_number" TEXT,
      "to_last4" TEXT,
      "body_hash" TEXT NOT NULL,
      "sent_at" TEXT NOT NULL,
      "carrier_status" TEXT NOT NULL DEFAULT 'unknown',
      "msg_sid" TEXT,
      "segments" INTEGER,
      "credits" INTEGER,
      "check_attempts" INTEGER NOT NULL DEFAULT 0,
      "last_checked_at" TEXT,
      "resolved_at" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), purpose TEXT NOT NULL DEFAULT 'drip',
      PRIMARY KEY ("id"),
      CONSTRAINT "sms_delivery_receipts_carrier_status_check" CHECK ((carrier_status IN ('delivered', 'failed', 'pending', 'unknown'))),
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "forms" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "slug" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "branding" TEXT NOT NULL DEFAULT '{}',
      "steps" TEXT NOT NULL DEFAULT '[]',
      "on_complete_stage" TEXT,
      "step_outcomes" TEXT NOT NULL DEFAULT '{}',
      "enabled" INTEGER NOT NULL DEFAULT 1,
      "redirect_url" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"),
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE TABLE form_submit_failures (id TEXT NOT NULL PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), source TEXT NOT NULL, tenant_slug TEXT, form_slug TEXT, step_index INTEGER, error_message TEXT, error_stack TEXT, payload TEXT, user_agent TEXT, recovered_at TEXT, recovered_note TEXT);
    CREATE TABLE drip_runs (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, sequence_id TEXT, step_index INTEGER,
      status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, scheduled_for TEXT, sent_at TEXT,
      from_identity TEXT, provider_message_id TEXT);
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
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
    ${readFileSync("database/turso/170_sms_reply_agent.turso.sql", "utf8")}
  `);
  const stamp = "2026-09-01T00:00:00Z";
  const tenantRow = (id: string, slug: string, name: string) => ({
    sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, ?, ?, '{}')",
    args: [id, slug, name],
  });
  const profile = (id: string, u: U | { id: string; email: string }, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, agents_enabled, brand, primary_agent, joined_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '["bravo"]', 'Workspace', 'bravo', ?, ?, ?)`,
    args: [id, u.id, u.email, tenant, role, owner, stamp, id, stamp, stamp, stamp],
  });
  await seed.batch(
    [
      tenantRow(OASIS, "oasis-ai-cc", "OASIS AI"),
      tenantRow(OASIS_WEBDEV, "oasis-webdev", "OASIS Webdev"),
      tenantRow(SUNBIZ, "submissions", "SunBiz"),
      tenantRow(CLIENT_A, "suga", "Client A"),
      tenantRow(CLIENT_B, "client-b", "Client B"),
      tenantRow(CLIENT_C, "client-c", "Client C"),
      tenantRow(CLIENT_D, "client-d", "Client D"),
      tenantRow(CLIENT_E, "client-e", "Client E"),
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      profile("p-host", { id: HOST, email: HOST_EMAIL }, OASIS, "owner", 0),
      profile("p-cc", USERS.cc, OASIS, "owner", 1),
      profile("p-a-owner", USERS.aOwner, CLIENT_A, "owner", 1),
      profile("p-a-rep", USERS.aRep, CLIENT_A, "closer", 0),
      profile("p-b-owner", USERS.bOwner, CLIENT_B, "owner", 1),
      profile("p-a-member", USERS.aMember, CLIENT_A, "member", 0),
      profile("p-a-viewer", USERS.aViewer, CLIENT_A, "read_only", 0),
    ],
    "write",
  );
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
  // OASIS saved a workspace bot too: its alerts must still reach the operator chat.
  await saveCredential(OASIS, "bot_token", encryptField(OASIS_SAVED_TOKEN));
  await saveCredential(OASIS, "chat_id", encryptField("-1009990009"));

  const rows = async (sql: string, args: Array<string | number | null> = []) =>
    (await seed.execute({ sql, args })).rows as unknown as Array<Record<string, unknown>>;
  const alertCard = async (tenantId: string, alertType: string) =>
    rows(
      "SELECT id, title, body, payload, resolved_at, resolved_by FROM agent_alerts WHERE tenant_id = ? AND alert_type = ?",
      [tenantId, alertType],
    );
  const login = async (u: U | null) => {
    if (!u) {
      sessionCookie = undefined;
      return;
    }
    const { signSession } = await import("../lib/turso-auth");
    sessionCookie = signSession({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };

  const { writeAgentAlert, resolveAgentAlerts } = await import("../lib/notify/agent-alert");
  const { sendWorkspaceTelegram } = await import("../lib/notify/workspace-telegram");
  const { alertAudienceFor, oasisLaneOutcome } = await import("../lib/notify/alert-route");
  const { meetingSmsVoiceFor } = await import("../lib/website-sales-meeting");

  // -- A. The alert writer and the one resolver -------------------------------
  await check("a client alert reaches the bot the client saved, and no OASIS or SunBiz token", async () => {
    calls.length = 0;
    const result = await quietly(() =>
      writeAgentAlert({
        tenantId: CLIENT_A,
        alertType: "drip_missing_app_link",
        severity: "warn",
        title: "Drip email held: Q&A <follow-up>",
        body: "Lead 42 has no application link.",
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
    assert.deepEqual(result, { stored: true, telegram: "Sent to Telegram" });
    const card = await alertCard(CLIENT_A, "drip_missing_app_link");
    assert.equal(card.length, 1, "the client's in-app card is missing");
    assert.deepEqual(payloadOf(card[0].payload), { step_index: 2, telegram: "Sent to Telegram" });
  });

  await check("a caller cannot steer a client alert to a lane, even by passing one", async () => {
    calls.length = 0;
    await quietly(() =>
      writeAgentAlert({
        tenantId: CLIENT_A,
        alertType: "sms_carrier_route_dead",
        severity: "urgent",
        title: "SMS halted",
        // The field no longer exists; a stale caller passing it is ignored.
        ...({ lane: "sunbiz-ops" } as Record<string, unknown>),
      } as Parameters<typeof writeAgentAlert>[0]),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].token, CLIENT_A_TOKEN);
    assert.ok(!calls.some(usedEnvToken));
    await resolveAgentAlerts({ tenantId: CLIENT_A, alertType: "sms_carrier_route_dead", resolvedBy: "test reset" });
  });

  await check("a client with no saved bot: an in-app card that says 'Not sent: no Telegram bot connected', and no Telegram at all", async () => {
    calls.length = 0;
    // No payload: the card must still be written (agent_alerts.payload is NOT NULL).
    const result = await quietly(() =>
      writeAgentAlert({
        tenantId: CLIENT_B,
        alertType: "sms_agent_dead_letter",
        severity: "urgent",
        title: "A customer's text could not be added to your Feed",
        subjectType: "sms_agent_job",
        subjectId: "job-b",
      }),
    );
    assert.deepEqual(calls, [], "a client without a bot was paged somewhere");
    assert.deepEqual(result, { stored: true, telegram: "Not sent: no Telegram bot connected" });
    const card = await alertCard(CLIENT_B, "sms_agent_dead_letter");
    assert.equal(card.length, 1, "no in-app card was written");
    assert.equal(card[0].resolved_at, null);
    assert.equal(payloadOf(card[0].payload).telegram, "Not sent: no Telegram bot connected");
  });

  await check("a saved bot that will not decrypt says so on the card, and nothing falls back", async () => {
    calls.length = 0;
    await quietly(() =>
      writeAgentAlert({ tenantId: CLIENT_C, alertType: "drip_safety_lookup_failed", severity: "warn", title: "x" }),
    );
    assert.deepEqual(calls, []);
    const card = await alertCard(CLIENT_C, "drip_safety_lookup_failed");
    assert.equal(payloadOf(card[0].payload).telegram, "Not sent: the saved Telegram bot could not be read");
  });

  await check("Telegram refusing the client's chat, and quoting the bot token back, is recorded without the token", async () => {
    calls.length = 0;
    refusingChats.add(CLIENT_A_CHAT);
    let result: Awaited<ReturnType<typeof writeAgentAlert>>;
    try {
      result = await quietly(() =>
        writeAgentAlert({ tenantId: CLIENT_A, alertType: "tt_credits_exhausted", severity: "urgent", title: "x" }),
      );
    } finally {
      refusingChats.delete(CLIENT_A_CHAT);
    }
    assert.equal(calls.length, 1, "a refused client alert was re-sent to another chat");
    const recorded = String(payloadOf((await alertCard(CLIENT_A, "tt_credits_exhausted"))[0].payload).telegram);
    assert.match(recorded, /^Not sent: Telegram said: Bad Request: chat not found/);
    assert.equal(result.telegram, recorded);
    assert.ok(!recorded.includes(CLIENT_A_TOKEN), `the bot token reached the card: ${recorded}`);
  });

  await check("an unreachable Telegram whose error quotes the request URL is recorded without the token", async () => {
    calls.length = 0;
    unreachableChats.add(CLIENT_A_CHAT);
    try {
      await quietly(() =>
        writeAgentAlert({ tenantId: CLIENT_A, alertType: "sms_reconcile_errors", severity: "warn", title: "x" }),
      );
    } finally {
      unreachableChats.delete(CLIENT_A_CHAT);
    }
    const recorded = String(payloadOf((await alertCard(CLIENT_A, "sms_reconcile_errors"))[0].payload).telegram);
    assert.equal(recorded, "Not sent: Telegram could not be reached");
    assert.ok(!recorded.includes(CLIENT_A_TOKEN));
    await resolveAgentAlerts({ tenantId: CLIENT_A, alertType: "sms_reconcile_errors", resolvedBy: "test reset" });
  });

  await check("once per open card: a refresh pages nobody and keeps the outcome the first push recorded", async () => {
    calls.length = 0;
    const alert = {
      tenantId: CLIENT_A,
      alertType: "optout_stamp_unrepairable",
      severity: "warn" as const,
      title: "Opt-out timestamp could not be repaired",
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
    assert.equal(payloadOf(card[0].payload).telegram, "Sent to Telegram", "the refresh dropped the recorded outcome");
  });

  await check("OASIS's own alerts reach OASIS's operator chat, even with a workspace bot saved", async () => {
    calls.length = 0;
    await quietly(() => writeAgentAlert({ tenantId: OASIS, alertType: "oasis_operator_check", severity: "warn", title: "Founder check" }));
    await quietly(() => writeAgentAlert({ tenantId: OASIS_WEBDEV, alertType: "oasis_ops_check", severity: "warn", title: "Ops check" }));
    assert.deepEqual(
      calls.map((c) => [c.token, c.chatId]),
      [
        [ENV_TELEGRAM.OASIS_TELEGRAM_BOT_TOKEN, ENV_TELEGRAM.OASIS_TELEGRAM_CHAT_ID],
        [ENV_TELEGRAM.OASIS_TELEGRAM_BOT_TOKEN, ENV_TELEGRAM.OASIS_TELEGRAM_CHAT_ID],
      ],
      "an OASIS alert left OASIS's operator chat (the SunBiz lane is no workspace's any more)",
    );
    assert.ok(!calls.some((c) => c.token === OASIS_SAVED_TOKEN));
    assert.equal(calls[0].text, `${WARN} Founder check`, "the OASIS page's text changed");
    assert.equal(payloadOf((await alertCard(OASIS, "oasis_operator_check"))[0].payload).telegram, "Sent to Telegram");
  });

  await check("the retired SunBiz workspace keeps a card and pages nobody", async () => {
    calls.length = 0;
    const result = await quietly(() =>
      writeAgentAlert({ tenantId: SUNBIZ, alertType: "live_sub_promote_failed", severity: "urgent", title: "x" }),
    );
    assert.deepEqual(calls, [], "the retired workspace paged someone");
    assert.deepEqual(result, { stored: true, telegram: "Not sent: this workspace is retired" });
    assert.equal(alertAudienceFor(SUNBIZ), "card_only");
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

  await check("a failed open-card lookup writes nothing and pages nobody (fails closed)", async () => {
    calls.length = 0;
    await seed.execute("ALTER TABLE agent_alerts RENAME TO agent_alerts_offline");
    let result: Awaited<ReturnType<typeof writeAgentAlert>>;
    try {
      result = await quietly(() =>
        writeAgentAlert({ tenantId: CLIENT_A, alertType: "lookup_blip", severity: "urgent", title: "x" }),
      );
    } finally {
      await seed.execute("ALTER TABLE agent_alerts_offline RENAME TO agent_alerts");
    }
    assert.deepEqual(result, { stored: false, telegram: null });
    assert.deepEqual(calls, [], "a lookup failure paged anyway");
  });

  await check("a delivery that only reached a backup chat is not recorded as 'Sent'", () => {
    assert.equal(oasisLaneOutcome({ ok: true }), "Sent to Telegram");
    assert.equal(
      oasisLaneOutcome({ ok: true, degraded: true, reason: "telegram_http_403: Forbidden: bot was kicked" }),
      "Sent to the backup Telegram chat: the main chat refused it",
    );
    assert.equal(
      oasisLaneOutcome({ ok: false, reason: "telegram_lane_not_configured:operator (set X + Y)" }),
      "Not sent: the Telegram alert chat is not set up",
    );
  });

  await check("resolveAgentAlerts closes only that workspace's open cards of that kind, and says why", async () => {
    await quietly(() => writeAgentAlert({ tenantId: CLIENT_B, alertType: "probe", severity: "info", title: "b1" }));
    await quietly(() => writeAgentAlert({ tenantId: CLIENT_C, alertType: "probe", severity: "info", title: "c1" }));
    assert.equal(await resolveAgentAlerts({ tenantId: CLIENT_B, alertType: "probe", resolvedBy: "auto: test" }), 1);
    const b = await alertCard(CLIENT_B, "probe");
    const c = await alertCard(CLIENT_C, "probe");
    assert.ok(b[0].resolved_at, "B's card stayed open");
    assert.equal(b[0].resolved_by, "auto: test");
    assert.equal(c[0].resolved_at, null, "another workspace's card was closed");
  });

  await check("one answer to 'is this OASIS': the alert audience and the texting voice agree, by exact id", () => {
    for (const id of [OASIS, OASIS_WEBDEV, OASIS.toUpperCase(), ` ${OASIS}`, SUNBIZ, CLIENT_A, "", "oasis"]) {
      const oasisAudience = alertAudienceFor(id) === "oasis_operator";
      assert.equal(meetingSmsVoiceFor(id) !== null, oasisAudience, `voice and audience disagree for "${id}"`);
    }
    assert.equal(meetingSmsVoiceFor(SUNBIZ), null, "the retired SunBiz workspace has no texting voice");
    assert.deepEqual(meetingSmsVoiceFor(OASIS), { prefix: "OASIS AI:", timeZone: "America/Toronto" });
  });

  // -- B. The lane ratchet ----------------------------------------------------
  const sources = sourceFiles();
  await check("the ratchet's detector catches each way of naming a lane, and ignores comments", () => {
    assert.equal(namesLane(`await writeAgentAlert({ tenantId, lane: "operator" });`), true);
    assert.equal(namesLane(`const check = { lane: ["operator", "sunbiz-ops"] };`), true);
    assert.equal(namesLane(`import type { TelegramLane } from "@/lib/notify/telegram";`), true);
    assert.equal(namesLane(`await sendTelegram(text, { lane });`), true);
    assert.equal(namesLane(`// lane: "operator" used to live here\n/* TelegramLane */ const a = 1;`), false);
    assert.equal(namesLane(`const r = { lane: "workspace" };`), false);
    assert.ok(sources.size > 1000, `only ${sources.size} files walked`);
    assert.ok(sources.has("lib/notify/agent-alert.ts") && sources.has("app/api/cron/reconcile-sms/route.ts"));
  });
  await check("no file outside the allow-list names a Telegram lane (every alert goes through the resolver)", () => {
    const offenders = [...sources].filter(([file, src]) => namesLane(src) && !(file in LANE_ALLOWED)).map(([f]) => f);
    assert.deepEqual(offenders, [], "route these through lib/notify/alert-route.ts pushWorkspaceAlert");
  });
  await check("every allow-listed file still names a lane (a stale entry is room for a regression)", () => {
    for (const [file, why] of Object.entries(LANE_ALLOWED)) {
      const src = sources.get(file);
      assert.ok(src, `${file} is allow-listed (${why}) but does not exist`);
      assert.ok(namesLane(src), `${file} no longer names a lane: delete its entry`);
    }
  });

  // -- C. The SMS reply agent --------------------------------------------------
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
    attempts?: number;
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
              intent_source, proposed_action, executed_action, attempts, received_at)
            VALUES (?, ?, 'twilio', ?, ?, '+14385550000', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `job-${input.key}`, input.tenantId, sid, phone, input.phoneLast10, input.body, leadId,
        linked?.appointmentId ?? null, `in-${input.key}`,
        input.carrierStop ? "opt_out" : null,
        input.carrierStop ? "high" : null,
        input.carrierStop ? "rules" : "none",
        input.carrierStop ? "cancel_meeting" : null,
        input.carrierStop ? "suppress_and_cancel_sms" : null,
        input.attempts ?? 0,
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

  await check("...and a Feed item in that workspace, with the customer's words under their own key only", async () => {
    const feed = await feedFor("client-text");
    assert.equal(feed.length, 1);
    assert.equal(feed[0].event_type, "CUSTOMER_TEXT_NEEDS_REPLY");
    assert.equal(feed[0].correlation_id, CLIENT_A);
    assert.equal(feed[0].publisher_agent, "dept:sales");
    assert.equal(feed[0].severity, "info", "an ordinary customer text is not a warning");
    const payload = payloadOf(feed[0].payload);
    assert.deepEqual(payload.customer_message, { phone: text.phone, text: "Do you have any openings Friday? I need a cleaning" });
    assert.equal(payload.lead_id, text.leadId);
    // BEA's event router logs these keys for every workspace: no customer detail in any.
    for (const key of ROUTER_LOGGED_KEYS) {
      const logged = JSON.stringify(payload[key] ?? "");
      assert.ok(!logged.includes("4165550101") && !/openings/i.test(logged), `the router-logged key "${key}" carries the customer: ${logged}`);
    }
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
    const payload = payloadOf(feed[0].payload);
    assert.match(String(payload.note), /replied STOP/);
    assert.deepEqual(payload.customer_message, { phone: stop.phone, text: "STOP" });
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

  await check("a client's dead-lettered text is the client's card, in plain words, and pages no OASIS chat", async () => {
    await inbound({ tenantId: CLIENT_B, key: "client-dead", phoneLast10: "4165550110", body: "hello?", attempts: 3 });
    calls.length = 0;
    await quietly(() => runSmsReplyAgentWorker());
    assert.equal((await job("client-dead")).status, "dead_letter");
    const card = (await rows(
      "SELECT title, body, payload FROM agent_alerts WHERE tenant_id = ? AND alert_type = 'sms_agent_dead_letter' AND subject_id = 'job-client-dead'",
      [CLIENT_B],
    ))[0];
    assert.equal(card.title, "A customer's text could not be added to your Feed");
    assert.match(String(card.body), /^It reached your number and was saved/);
    assert.doesNotMatch(`${card.title} ${card.body}`, /agent|worker|lease|retry budget/i, "worker internals on a client card");
    assert.equal(payloadOf(card.payload).telegram, "Not sent: no Telegram bot connected");
    assert.deepEqual(calls, [], "a client's dead letter paged a chat");
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

  await check("OASIS founder meeting: the rep is paged on OASIS's operator chat, as before", async () => {
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

  // -- D. Who reads a customer's words: /api/event-feed and the Feed ---------
  const now = new Date().toISOString();
  await seed.execute({
    sql: `INSERT INTO agent_events (event_type, publisher_agent, severity, payload, correlation_id, created_at, published_at)
          VALUES ('CUSTOMER_TEXT_NEEDS_REPLY', 'dept:sales', 'info', ?, ?, ?, ?)`,
    args: [JSON.stringify({ note: "x", customer_message: { phone: "+15145550199", text: "OASIS's own customer" } }), OASIS, now, now],
  });
  // A Finance row with money in it, in the client's own workspace: the Feed page
  // shows it to no one outside OASIS (Finance is OASIS-only), so neither may the API.
  await seed.execute({
    sql: `INSERT INTO agent_events (event_type, publisher_agent, severity, payload, correlation_id, created_at, published_at)
          VALUES ('INVOICE_PAID', 'dept:finance', 'info', ?, ?, ?, ?)`,
    args: [JSON.stringify({ amount_cad: 1250, invoice_id: "inv-9" }), CLIENT_A, now, now],
  });
  // Two customer-text rows in another shape: the number and words in `preview`
  // and `phone`, the way this change's own first draft wrote them. None reached
  // production, but a shape the redaction does not know must still be cut.
  const earlier = new Date(Date.now() - 30 * 60_000).toISOString();
  await seed.execute({
    sql: `INSERT INTO agent_events (event_type, publisher_agent, severity, payload, correlation_id, created_at, published_at)
          VALUES ('CUSTOMER_TEXT_NEEDS_REPLY', 'dept:sales', 'warn', ?, ?, ?, ?),
                 ('CUSTOMER_OPTED_OUT_OF_TEXTS', 'dept:sales', 'info', ?, ?, ?, ?)`,
    args: [
      JSON.stringify({ tenant_id: CLIENT_A, preview: "+14165550177: legacy words in preview", channel: "sms", phone: "+14165550177", lead_id: null, sms_agent_job_id: "job-legacy-1" }),
      CLIENT_A, earlier, earlier,
      JSON.stringify({ tenant_id: CLIENT_A, preview: "+14165550178 replied STOP. Texts to this number are off.", channel: "sms", phone: "+14165550178", sms_agent_job_id: "job-legacy-2" }),
      CLIENT_A, earlier, earlier,
    ],
  });
  const eventFeed = await import("../app/api/event-feed/route");
  const { NextRequest } = await import("next/server");
  const readFeed = async () => {
    const res = await quietly(() => eventFeed.GET(new NextRequest("http://localhost/api/event-feed?since_minutes=1440&limit=500")));
    const body = await res.text();
    return { status: res.status, body, rows: res.status === 200 ? (JSON.parse(body).rows as Array<Record<string, unknown>>) : [] };
  };

  await check("event feed: a workspace owner reads its own customers' words, and only its own workspace", async () => {
    await login(USERS.aOwner);
    const r = await readFeed();
    assert.equal(r.status, 200, r.body);
    assert.ok(r.rows.length > 0, "the owner reads nothing");
    assert.ok(r.rows.every((row) => row.correlation_id === CLIENT_A), "another workspace's row reached the owner");
    const own = r.rows.find((row) => row.event_type === "CUSTOMER_TEXT_NEEDS_REPLY");
    assert.deepEqual(payloadOf(own?.payload).customer_message, { phone: text.phone, text: "Do you have any openings Friday? I need a cleaning" });
    assert.doesNotMatch(r.body, /4165550102|running 10 minutes late|5145550199/, "another workspace's customer reached the owner");
    assert.ok(!r.rows.some((row) => row.event_type === "INVOICE_PAID"), "the API showed a row the Feed page cuts (Finance, money)");
  });

  await check("event feed: a commission-only rep reads no customer phone or message (no tape at all: 403)", async () => {
    await login(USERS.aRep);
    const r = await readFeed();
    assert.equal(r.status, 403, r.body);
    assert.doesNotMatch(r.body, /4165550101|openings|customer_message/);
  });

  await check("event feed: the operator's cross-workspace read keeps every event and drops other businesses' customers", async () => {
    await login(USERS.cc);
    const r = await readFeed();
    assert.equal(r.status, 200, r.body);
    const tenants = new Set(r.rows.map((row) => row.correlation_id));
    assert.ok(tenants.has(CLIENT_A) && tenants.has(CLIENT_B) && tenants.has(OASIS), [...tenants].join(","));
    for (const row of r.rows) {
      const hasCustomer = "customer_message" in payloadOf(row.payload);
      assert.equal(hasCustomer, row.correlation_id === OASIS && row.event_type === "CUSTOMER_TEXT_NEEDS_REPLY", JSON.stringify(row));
    }
    assert.doesNotMatch(r.body, /4165550101|4165550102|openings|running 10 minutes late/);
    await login(null);
  });

  await check("event feed: a customer text in another shape (number and words in preview/phone) is cut to its shareable keys for everyone but its own workspace", async () => {
    await login(USERS.cc);
    const op = await readFeed();
    assert.equal(op.status, 200, op.body);
    const legacy = op.rows.filter((row) => String(payloadOf(row.payload).sms_agent_job_id ?? "").startsWith("job-legacy"));
    assert.equal(legacy.length, 2, "the operator lost the rows themselves");
    for (const row of legacy) {
      for (const key of Object.keys(payloadOf(row.payload))) {
        assert.ok(["tenant_id", "note", "channel", "lead_id", "sms_agent_job_id"].includes(key), `kept ${key}`);
      }
    }
    assert.doesNotMatch(op.body, /4165550177|4165550178|legacy words/, "another business's customer reached the operator");
    await login(USERS.aOwner);
    const own = await readFeed();
    assert.match(own.body, /legacy words in preview/, "the workspace's own owner lost its own customer's text");
    await login(null);
  });

  await check("the Feed strips a customer's words for a viewer who may not see client identities", async () => {
    const { withCustomerMessagesFor, customerMessageOf } = await import("../components/os/landings/feed-model");
    const feed = await loadTenantFeed({ tenantId: CLIENT_A });
    assert.ok(feed.ok);
    const kept = withCustomerMessagesFor(feed.rows, () => true);
    const stripped = withCustomerMessagesFor(feed.rows, () => false);
    assert.ok(kept.some((row) => customerMessageOf(row.payload)?.phone === text.phone));
    assert.ok(stripped.every((row) => customerMessageOf(row.payload) === null));
    assert.ok(stripped.every((row) => !/4165550101|4165550177|4165550178|legacy words/.test(JSON.stringify(row.payload))));
    assert.ok(kept.some((row) => JSON.stringify(row.payload).includes("legacy words in preview")), "the reader lost the row itself");
  });

  // -- E. The workspace's open alert cards in Needs you (owners/admins) ------
  const { todayBriefPlan, buildNeedsYou, needsYouTotal } = await import("../components/os/today/model");
  const { capabilitiesFor } = await import("../lib/role-surfaces");
  const { loadWorkspaceAlerts } = await import("../components/os/today/loaders");
  const { connectorHref } = await import("../lib/os/connectors");

  await check("Needs you reads alert cards for a workspace's owners/admins only", () => {
    const planFor = (persona: Parameters<typeof capabilitiesFor>[0]) =>
      todayBriefPlan({ persona, capabilities: capabilitiesFor(persona, "suga"), websiteSalesBoard: false, departments: new Set() });
    assert.equal(planFor("founder").alerts, true);
    for (const persona of ["sales", "manager", "worker", "readonly", "builder", "marketing"] as const) {
      assert.equal(planFor(persona).alerts, false, persona);
    }
  });

  let bCards: Array<{ id: string }> = [];
  await check("a workspace's open cards come back with their Telegram outcome, its own only", async () => {
    const read = await loadWorkspaceAlerts(CLIENT_B);
    assert.ok(read.ok);
    bCards = read.value.cards;
    const ids = new Set((await rows("SELECT id FROM agent_alerts WHERE tenant_id = ? AND resolved_at IS NULL", [CLIENT_B])).map((r) => r.id));
    assert.deepEqual(new Set(bCards.map((c) => c.id)), ids, "not exactly B's open cards");
    assert.equal(read.value.truncated, false);
    const dead = read.value.cards.find((c) => c.title === "A customer's text could not be added to your Feed");
    assert.equal(dead?.telegram, "Not sent: no Telegram bot connected");
    assert.equal(dead?.severity, "urgent");
  });

  await check("each open card is a Needs-you row: title, reason, when, outcome, the Telegram setup link and a Resolve action", async () => {
    const read = await loadWorkspaceAlerts(CLIENT_B);
    const needs = buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, alerts: read, nowMs: Date.now() });
    const alertRows = needs.items.filter((i) => i.resolveAlertId);
    assert.equal(alertRows.length, bCards.length);
    const dead = alertRows.find((i) => i.title === "A customer's text could not be added to your Feed");
    assert.ok(dead);
    assert.equal(dead.icon, "alert");
    assert.equal(dead.tone, "urgent");
    assert.match(String(dead.detail), /Not sent: no Telegram bot connected$/);
    assert.match(String(dead.detail), /^It reached your number and was saved/);
    assert.equal(dead.href, connectorHref("telegram"));
    assert.deepEqual(needsYouTotal(needs), { total: bCards.length, capped: false });
  });

  await check("more open cards than are read make the count a floor", async () => {
    for (let i = 0; i < 11; i += 1) {
      await seed.execute({
        sql: "INSERT INTO agent_alerts (tenant_id, alert_type, severity, title, subject_id) VALUES (?, 'bulk', 'warn', ?, ?)",
        args: [CLIENT_C, `bulk ${i}`, `s-${i}`],
      });
    }
    const read = await loadWorkspaceAlerts(CLIENT_C);
    assert.ok(read.ok);
    assert.equal(read.value.cards.length, 10);
    assert.equal(read.value.truncated, true);
    const needs = buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, alerts: read, nowMs: Date.now() });
    assert.deepEqual(needsYouTotal(needs), { total: 10, capped: true });
  });

  const resolveRoute = await import("../app/api/agent-alerts/[id]/resolve/route");
  const post = (id: string) =>
    quietly(() =>
      resolveRoute.POST(
        new NextRequest(`http://localhost/api/agent-alerts/${id}/resolve`, { method: "POST", headers: { accept: "application/json" } }),
        { params: Promise.resolve({ id }) },
      ),
    );

  await check("the Resolve action refuses a rep, a member and a read-only seat (403), and the card stays open", async () => {
    const aCard = (await alertCard(CLIENT_A, "optout_stamp_unrepairable"))[0];
    assert.ok(aCard, "no open card to try");
    for (const u of [USERS.aRep, USERS.aMember, USERS.aViewer]) {
      await login(u);
      const res = await post(String(aCard.id));
      assert.equal(res.status, 403, `${u.email} was let in`);
    }
    await login(null);
    assert.equal((await rows("SELECT resolved_at FROM agent_alerts WHERE id = ?", [String(aCard.id)]))[0].resolved_at, null);
  });

  await check("the dashboard's System health card reads cards for the workspace's owners and admins only", async () => {
    const { loadDashboardAlerts } = await import("../components/manifest/dashboard-alerts");
    await login(USERS.aOwner);
    const own = await loadDashboardAlerts(CLIENT_A);
    assert.ok(own.length > 0, "the owner reads no cards");
    assert.ok(own.every((c) => c.id && c.title), "not card rows");
    assert.deepEqual(await loadDashboardAlerts(CLIENT_B), [], "an owner read another workspace's cards");
    for (const u of [USERS.aRep, USERS.aMember, USERS.aViewer]) {
      await login(u);
      assert.deepEqual(await loadDashboardAlerts(CLIENT_A), [], `${u.email} read the cards`);
    }
    await login(null);
    assert.deepEqual(await loadDashboardAlerts(CLIENT_A), [], "a signed-out read returned cards");
  });

  await check("the Resolve action closes the owner's own card and no other workspace's", async () => {
    const aCard = (await alertCard(CLIENT_A, "optout_stamp_unrepairable"))[0];
    const bCard = bCards[0];
    await login(USERS.bOwner);
    const own = await post(bCard.id);
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as { resolved: number }).resolved, 1);
    const foreign = await post(String(aCard.id));
    assert.equal(((await foreign.json()) as { resolved: number }).resolved, 0);
    await login(null);
    assert.ok((await rows("SELECT resolved_at FROM agent_alerts WHERE id = ?", [bCard.id]))[0].resolved_at);
    assert.equal((await rows("SELECT resolved_at FROM agent_alerts WHERE id = ?", [String(aCard.id)]))[0].resolved_at, null);
  });

  // The rendered rows (react-dom/server, in its own process).
  const lexText = "Hi it's Lex, can you call me back?";
  const atlasText = "Atlas Roofing here, need a quote";
  const customerRow = (id: string, phone: string, words: string) => ({
    id,
    event_type: "CUSTOMER_TEXT_NEEDS_REPLY",
    publisher_agent: "dept:sales",
    target_agent: null,
    severity: "info",
    payload: { note: "A customer texted your number and is waiting for a reply.", customer_message: { phone, text: words } },
    published_at: now,
    created_at: now,
    status: "pending",
  });
  const needsForRender = buildNeedsYou({
    sales: null, delivery: null, inbound: null, cash: null, alerts: await loadWorkspaceAlerts(CLIENT_A), nowMs: Date.now(),
  });
  // CI runs every suite with NODE_OPTIONS=--conditions=react-server, which the
  // child would inherit, and react-dom/server refuses to load under it. Drop
  // that condition for the child only (the same as tests/clients-hub.test.ts).
  const childNodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions };
  if (!childNodeOptions) delete childEnv.NODE_OPTIONS;
  const rendered = spawnSync(process.execPath, ["--import", "tsx", "tests/workspace-alerts.render.ts"], {
    env: childEnv,
    input: JSON.stringify({
      feedRows: [customerRow("ev-lex", "+14165550188", lexText), customerRow("ev-atlas", "+14165550189", atlasText)],
      oasisWorkspace: false,
      needsItems: needsForRender.items,
    }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const markup = (() => {
    try {
      return JSON.parse(rendered.stdout) as { feed: string; needs: string };
    } catch {
      return { feed: "", needs: "" };
    }
  })();
  const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  await check("the Feed shows a customer's phone and words even when they name a house agent (Lex, Atlas)", () => {
    assert.equal(rendered.status, 0, rendered.stderr);
    const feed = decode(markup.feed);
    assert.ok(feed.includes("+14165550188") && feed.includes(`: ${lexText}`), "Lex's customer line is missing");
    assert.ok(feed.includes("+14165550189") && feed.includes(`: ${atlasText}`), "the Atlas Roofing line is missing");
    assert.ok(feed.includes("A customer texted your number and is waiting for a reply."), "the row's own line is missing");
  });

  await check("an alert row renders its Resolve form beside its link, never inside it", () => {
    const needs = markup.needs;
    const forms = needs.match(/<form\b[^>]*>/g) ?? [];
    assert.ok(forms.length > 0, "no Resolve form rendered");
    for (const form of forms) {
      assert.match(form, /\baction="\/api\/agent-alerts\/[^"]+\/resolve"/);
      assert.match(form, /\bmethod="post"/);
    }
    assert.match(needs, />Resolve<\/button>/);
    for (const anchor of needs.match(/<a\b[\s\S]*?<\/a>/g) ?? []) assert.doesNotMatch(anchor, /<form/);
  });

  // -- F. Recovery closes cards on evidence only; reconcile and benched-line cards --
  const reconcile = await import("../app/api/cron/reconcile-sms/route");
  const cronGet = () =>
    quietly(() =>
      reconcile.GET(
        new NextRequest("http://localhost/api/cron/reconcile-sms", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-vercel-cron": "1" },
        }),
      ),
    );

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  /** One carrier receipt: a send from `from`, `m` minutes ago, with the carrier's verdict so far. */
  const receipt = (tenantId: string, status: "delivered" | "failed" | "pending", m: number, from = "+15145550900", purpose = "drip") => ({
    sql: `INSERT INTO sms_delivery_receipts (tenant_id, chat_id, body_hash, sent_at, carrier_status, from_number, resolved_at, purpose)
          VALUES (?, ?, 'hash', ?, ?, ?, ?, ?)`,
    args: [tenantId, `chat-${from}-${m}-${status}`, minutesAgo(m), status, from, status === "pending" ? null : minutesAgo(m - 1), purpose],
  });
  /** An open carrier-outage card, last written `m` minutes ago. */
  const carrierCard = (tenantId: string, m: number) => ({
    sql: `INSERT INTO agent_alerts (tenant_id, alert_type, severity, title, payload, created_at)
          VALUES (?, 'sms_carrier_route_dead', 'urgent', 'SMS halted', '{"telegram":"Sent to Telegram"}', ?)`,
    args: [tenantId, minutesAgo(m)],
  });
  const openCarrier = async (tenantId: string) =>
    (await alertCard(tenantId, "sms_carrier_route_dead")).filter((c) => c.resolved_at === null);
  type CronBody = { recovered: string[]; route_evidence: Record<string, string>; lines_recovered: Record<string, string[]> };
  const runCron = async () => {
    const res = await cronGet();
    return { status: res.status, body: (await res.json()) as CronBody };
  };

  await check("reconcile: the carrier card closes on a delivery newer than the card, and on nothing else (pending-only, empty, failing)", async () => {
    await seed.batch(
      [
        // Three failures, then a delivery an hour ago; the card is two hours old.
        carrierCard(OASIS, 120), receipt(OASIS, "failed", 100), receipt(OASIS, "failed", 90), receipt(OASIS, "failed", 80),
        receipt(OASIS, "delivered", 60),
        { sql: "INSERT INTO agent_alerts (tenant_id, alert_type, severity, title) VALUES (?, 'sms_reconcile_errors', 'warn', 'errors')", args: [OASIS] },
        // The same delivery, but the card was written after it: the route was seen failing since.
        carrierCard(OASIS_WEBDEV, 10), receipt(OASIS_WEBDEV, "failed", 100), receipt(OASIS_WEBDEV, "delivered", 60),
        // Ten failures in a row: halted.
        ...Array.from({ length: 10 }, (_, i) => receipt(CLIENT_A, "failed", 50 - i)),
        // Pending only: nothing terminal yet.
        carrierCard(CLIENT_B, 120), receipt(CLIENT_B, "pending", 30), receipt(CLIENT_B, "pending", 20),
        // No receipts at all.
        carrierCard(CLIENT_C, 120),
        // A delivery, then two failures: still failing, under the halt thresholds.
        carrierCard(CLIENT_D, 120), receipt(CLIENT_D, "delivered", 100), receipt(CLIENT_D, "failed", 90), receipt(CLIENT_D, "failed", 80),
      ],
      "write",
    );
    openReceiptTenants = [CLIENT_A, CLIENT_B, CLIENT_C, CLIENT_D, OASIS, OASIS_WEBDEV];
    reconcileErrors[CLIENT_A] = ["thread 7: provider answered 502"];
    calls.length = 0;
    const { status, body } = await runCron();
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.route_evidence, {
      [OASIS]: "delivering", [OASIS_WEBDEV]: "delivering", [CLIENT_A]: "halted",
      [CLIENT_B]: "no_evidence", [CLIENT_C]: "no_evidence", [CLIENT_D]: "failing",
    });
    assert.deepEqual(body.recovered, [OASIS]);
    const oasisCarrier = (await alertCard(OASIS, "sms_carrier_route_dead"))[0];
    assert.ok(oasisCarrier.resolved_at, "the recovered route's card stayed open");
    assert.equal(oasisCarrier.resolved_by, "auto: a text delivered after the failures");
    assert.equal((await openCarrier(OASIS_WEBDEV)).length, 1, "a delivery older than the card closed it");
    assert.equal((await openCarrier(CLIENT_B)).length, 1, "a pending-only history closed the card");
    assert.equal((await openCarrier(CLIENT_C)).length, 1, "an empty history closed the card");
    assert.equal((await openCarrier(CLIENT_D)).length, 1, "a route still failing closed the card");
    assert.ok((await alertCard(OASIS, "sms_reconcile_errors"))[0].resolved_at, "a clean reconcile left its error card open");
    const clientCarrier = await openCarrier(CLIENT_A);
    assert.equal(clientCarrier.length, 1);
    assert.equal(payloadOf(clientCarrier[0].payload).telegram, "Sent to Telegram");
    const clientErrors = (await alertCard(CLIENT_A, "sms_reconcile_errors")).filter((c) => c.resolved_at === null);
    assert.equal(clientErrors.length, 1);
    assert.equal(clientErrors[0].body, "thread 7: provider answered 502");
    assert.ok(calls.length >= 2 && calls.every((c) => c.token === CLIENT_A_TOKEN), JSON.stringify(calls.map((c) => c.token)));
  });

  await check("reconcile: a still-halted route pages once per open card, not every tick", async () => {
    calls.length = 0;
    await cronGet();
    assert.deepEqual(calls, [], "the second tick paged again");
  });

  await check("reconcile: a switched-off breaker is no evidence; the card closes only once the breaker reads the delivery", async () => {
    await seed.batch([carrierCard(CLIENT_E, 120), receipt(CLIENT_E, "failed", 100), receipt(CLIENT_E, "delivered", 60)], "write");
    openReceiptTenants = [CLIENT_E];
    process.env.SMS_BREAKER_DISABLED = "1";
    try {
      const off = await runCron();
      assert.equal(off.body.route_evidence[CLIENT_E], "bypassed");
      assert.deepEqual(off.body.recovered, []);
      assert.equal((await openCarrier(CLIENT_E)).length, 1, "the switched-off breaker closed the card");
    } finally {
      delete process.env.SMS_BREAKER_DISABLED;
    }
    const on = await runCron();
    assert.equal(on.body.route_evidence[CLIENT_E], "delivering");
    assert.deepEqual(on.body.recovered, [CLIENT_E]);
  });

  const { announceBenchedLines, closeRecoveredLineCards } = await import("../lib/sms/line-health");
  const benched = (n: string, pool: string[], reason = "3 consecutive carrier failures") => ({
    lines: pool.filter((x) => x !== n),
    blocked: [{ number: n, bench: true, consecutiveFailures: 3, sample: 3, reason }],
    wireHalted: false,
    reason: "benched",
    pool,
  });
  const LINE_1 = "+15145550931";
  const LINE_2 = "+15145550932";
  const lineCard = async (tenantId: string, subject: string) =>
    rows(
      "SELECT id, title, payload, resolved_at, resolved_by FROM agent_alerts WHERE tenant_id = ? AND alert_type = 'sms_line_benched' AND subject_id = ?",
      [tenantId, subject],
    );

  await check("a benched number in a workspace with no Telegram bot is a card in its Needs you, saying it was not sent", async () => {
    calls.length = 0;
    const r = await quietly(() => announceBenchedLines(CLIENT_B, benched(LINE_1, [LINE_1, LINE_2]), { wire: "main" }));
    assert.deepEqual(r.alerted, [`sms-line-benched:main:${LINE_1}`]);
    assert.deepEqual(calls, [], "a page went somewhere");
    const card = (await lineCard(CLIENT_B, `main:${LINE_1}`))[0];
    assert.ok(card, "no card");
    assert.equal(card.title, "A texting number was paused");
    assert.equal(payloadOf(card.payload).telegram, "Not sent: no Telegram bot connected");
    const needs = await loadWorkspaceAlerts(CLIENT_B);
    assert.ok(needs.ok && needs.value.cards.some((c) => c.id === card.id), "the card is not in Needs you");
  });

  await check("a benched line pages the workspace's own audience: a client's bot, OASIS's operator chat", async () => {
    calls.length = 0;
    await quietly(() => announceBenchedLines(CLIENT_A, benched("+15145550901", ["+15145550901"])));
    await quietly(() => announceBenchedLines(OASIS, benched("+15145550902", ["+15145550902"])));
    assert.deepEqual(
      calls.map((c) => c.token),
      [CLIENT_A_TOKEN, ENV_TELEGRAM.OASIS_TELEGRAM_BOT_TOKEN],
      "a benched line paged a lane its workspace does not own",
    );
  });

  await check("a benched number's card closes only when the number delivers again, and its next benching pages at once", async () => {
    assert.deepEqual(await quietly(() => closeRecoveredLineCards(CLIENT_B)), [], "closed with no history from the number");
    await seed.batch([receipt(CLIENT_B, "failed", 40, LINE_1)], "write");
    assert.deepEqual(await quietly(() => closeRecoveredLineCards(CLIENT_B)), [], "closed while its newest verdict is a failure");
    await seed.batch([receipt(CLIENT_B, "delivered", 5, LINE_1)], "write");
    openReceiptTenants = [CLIENT_B];
    const { body } = await runCron();
    assert.deepEqual(body.lines_recovered, { [CLIENT_B]: [`main:${LINE_1}`] });
    const card = (await lineCard(CLIENT_B, `main:${LINE_1}`))[0];
    assert.ok(card.resolved_at, "the card stayed open after the number delivered");
    assert.equal(card.resolved_by, "auto: a text from this number delivered again");
    const again = await quietly(() => announceBenchedLines(CLIENT_B, benched(LINE_1, [LINE_1, LINE_2]), { wire: "main" }));
    assert.deepEqual(again.alerted, [`sms-line-benched:main:${LINE_1}`], "the ladder kept the next benching quiet");
  });

  await check("a number the canary refused stays out, and its card open, even after a delivery", async () => {
    await quietly(() => announceBenchedLines(CLIENT_B, benched(LINE_2, [LINE_1, LINE_2], "refused a canary test send"), { wire: "main" }));
    await seed.batch([receipt(CLIENT_B, "failed", 50, LINE_2, "canary"), receipt(CLIENT_B, "delivered", 3, LINE_2)], "write");
    const closed = await quietly(() => closeRecoveredLineCards(CLIENT_B));
    assert.ok(!closed.includes(`main:${LINE_2}`), "the canary-refused number's card closed");
    assert.equal((await lineCard(CLIENT_B, `main:${LINE_2}`)).filter((c) => c.resolved_at === null).length, 1);
  });

  // -- G. The drip compliance guards: once per open card, with a subject ------
  await check("a batch of rows blocked by the same compliance guard pages once, on the workspace's own audience", async () => {
    const { handleGuardBlock } = await import("../lib/drips/executor");
    const { getServiceSupabase } = await import("../lib/supabase-server");
    const db = getServiceSupabase();
    const claimed = (i: number) => ({
      id: `run-${i}`, tenant_id: CLIENT_A, lead_id: `lead-run-${i}`, sequence_id: "seq-guard",
      sequence_name: "Spring promo", step_index: 0, channel: "sms" as const, attempts: 0,
    });
    for (let i = 0; i < 6; i += 1) {
      await seed.execute({
        sql: "INSERT INTO drip_runs (id, tenant_id, lead_id, sequence_id, step_index, status) VALUES (?, ?, ?, 'seq-guard', 0, 'sending')",
        args: [`run-${i}`, CLIENT_A, `lead-run-${i}`],
      });
    }
    calls.length = 0;
    for (let i = 0; i < 3; i += 1) {
      await quietly(() => handleGuardBlock(db as never, claimed(i), [], { reason: "positioning", message: "Positioning check failed." }, "sms"));
    }
    for (let i = 3; i < 6; i += 1) {
      await quietly(() => handleGuardBlock(db as never, claimed(i), [], { reason: "safety_check_failed", message: "lookup failed" }, "sms"));
    }
    assert.equal(calls.length, 2, `one page per guard, not one per row: ${calls.length}`);
    assert.ok(calls.every((c) => c.token === CLIENT_A_TOKEN));
    const block = await alertCard(CLIENT_A, "drip_blast_safety_block");
    assert.equal(block.length, 1);
    assert.deepEqual(
      (await rows("SELECT subject_type, subject_id FROM agent_alerts WHERE tenant_id = ? AND alert_type = 'drip_safety_lookup_failed'", [CLIENT_A]))[0],
      { subject_type: "tenant", subject_id: CLIENT_A },
    );
  });

  // -- H. A public form that could not submit: the form's own workspace -------
  await seed.execute({
    sql: `INSERT INTO forms (id, tenant_id, slug, name) VALUES
            ('form-a-intake', ?, 'intake', 'Spring intake'), ('form-b-quote', ?, 'quote', 'Quote request'),
            ('form-oasis-audit', ?, 'audit', 'AI audit'), ('form-sunbiz-apply', ?, 'apply', 'Application')`,
    args: [CLIENT_A, CLIENT_B, OASIS, SUNBIZ],
  });
  const { captureSubmitFailure } = await import("../lib/forms/submit-failure-capture");
  const formCards = (tenantId: string) =>
    rows(
      "SELECT id, title, body, payload, subject_id FROM agent_alerts WHERE tenant_id = ? AND alert_type = 'form_submit_blocked' AND resolved_at IS NULL",
      [tenantId],
    );
  const formCardCount = async () =>
    Number((await rows("SELECT COUNT(*) AS n FROM agent_alerts WHERE alert_type = 'form_submit_blocked'"))[0].n);

  await check("a client's blocked form is that client's card and its own bot's page, in plain words, never an OASIS or SunBiz chat", async () => {
    calls.length = 0;
    const r = await quietly(() =>
      captureSubmitFailure({
        source: "client_beacon", tenantSlug: "suga", formSlug: "intake", stepIndex: 1,
        error: "TypeError: cannot read 'or' of jane.doe@example.com", payload: { email: "jane.doe@example.com" },
      }),
    );
    assert.ok(r.id, "the answers were not kept");
    const cards = await formCards(CLIENT_A);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].subject_id, "form-a-intake");
    assert.equal(cards[0].title, "Someone could not submit one of your forms");
    assert.match(String(cards[0].body), /"Spring intake"/);
    assert.ok(String(cards[0].body).includes(String(r.id)), "no reference to the kept answers");
    assert.doesNotMatch(String(cards[0].body), /TypeError|jane\.doe|dead-letter|recovered_at/);
    assert.deepEqual(calls.map((c) => c.token), [CLIENT_A_TOKEN]);
    assert.ok(!calls.some(usedEnvToken));
  });

  await check("the same form failing again inside the ladder's window refreshes its card and pages nobody", async () => {
    calls.length = 0;
    await quietly(() => captureSubmitFailure({ source: "client_beacon", tenantSlug: "suga", formSlug: "intake", error: "again" }));
    assert.equal((await formCards(CLIENT_A)).length, 1);
    assert.deepEqual(calls, [], "paged again inside the window");
  });

  await check("a signed-link failure (no slugs) is attributed by the form's own URL, checked against the form record", async () => {
    calls.length = 0;
    const r = await quietly(() =>
      captureSubmitFailure({
        source: "server_catch", error: "boom", payload: { token: "<redacted>", submission_path: "/f/suga/intake/[signed-link]" },
      }),
    );
    const dead = (await rows("SELECT tenant_slug, form_slug FROM form_submit_failures WHERE id = ?", [String(r.id)]))[0];
    assert.deepEqual({ ...dead }, { tenant_slug: "suga", form_slug: "intake" });
    assert.deepEqual(calls.map((c) => c.token), [CLIENT_A_TOKEN], "the signed-link failure reached no one, or the wrong chat");
  });

  await check("a client with no Telegram bot gets the card, saying it was not sent, and no page", async () => {
    calls.length = 0;
    await quietly(() => captureSubmitFailure({ source: "client_beacon", tenantSlug: "client-b", formSlug: "quote", error: "x" }));
    const cards = await formCards(CLIENT_B);
    assert.equal(cards.length, 1);
    assert.equal(payloadOf(cards[0].payload).telegram, "Not sent: no Telegram bot connected");
    assert.deepEqual(calls, []);
  });

  await check("a failure naming no real form, or a retired workspace's, pages nobody and writes no card; the answers are still kept", async () => {
    const before = await formCardCount();
    calls.length = 0;
    for (const [tenantSlug, formSlug] of [["suga", "no-such-form"], ["no-such-workspace", "intake"], ["submissions", "apply"]]) {
      const r = await quietly(() => captureSubmitFailure({ source: "client_beacon", tenantSlug, formSlug, error: "forged" }));
      assert.ok(r.id, `${tenantSlug}/${formSlug}: the answers were not kept`);
    }
    assert.equal(await formCardCount(), before, "a card was written for a form that is not a live workspace's");
    assert.deepEqual(calls, []);
  });

  await check("OASIS's own blocked form pages OASIS's operator chat with the recovery detail", async () => {
    calls.length = 0;
    const r = await quietly(() =>
      captureSubmitFailure({ source: "client_beacon", tenantSlug: "oasis-ai-cc", formSlug: "audit", stepIndex: 0, error: "RangeError for amy@example.com" }),
    );
    assert.deepEqual(calls.map((c) => c.token), [ENV_TELEGRAM.OASIS_TELEGRAM_BOT_TOKEN]);
    assert.ok(calls[0].text.includes(String(r.id)) && calls[0].text.includes("recovered_at"), calls[0].text);
    assert.doesNotMatch(calls[0].text, /amy@example\.com/);
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
