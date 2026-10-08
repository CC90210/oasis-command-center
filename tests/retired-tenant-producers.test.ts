/**
 * retired-tenant-producers.test.ts — nothing automated writes for a retired
 * tenant (SunBiz, retired 2026-09-28; runbook C-6a in
 * docs/os-revamp/02-data-safety-sunbiz-retirement.md).
 *
 * A retired tenant's rows are exported and then deleted. Any cron, health lane,
 * webhook or metrics snapshot that still writes for it refills the tables
 * between the export and the delete, and the deletion certificate is wrong the
 * moment it is written. Every producer below was observed writing SunBiz rows
 * after its outbound freeze.
 *
 * The real functions and route handlers run against a local libSQL database
 * wherever that is practical. Each retired-tenant case has a control case that
 * runs the same path for OASIS and proves it still writes: a guard that stops
 * everything would pass the retired half of this file on its own.
 * Stand-ins replace only what would leave the machine: the SMS receipt
 * reconciler and carrier breaker (TextTorrent API reads), the agent-alert
 * writer, the TextTorrent sender resolver, the conversations nudge, and
 * `fetch` itself, which records and refuses.
 *
 * Run: node --conditions=react-server --import tsx tests/retired-tenant-producers.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import {
  isRetiredTenant,
  RETIRED_TENANT_IDS,
  RETIRED_TENANT_ID_LIST,
  SUNBIZ_RETIRED_TENANT_ID,
} from "../lib/tenant/retired";

const dbFile = join(mkdtempSync(join(tmpdir(), "retired-tenant-producers-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.CRON_SECRET = "retired-tenant-producers-cron-secret";
delete process.env.CRON_ALLOW_LOCAL;
process.env.KIXIE_WEBHOOK_SECRET = "retired-tenant-producers-kixie-token";
process.env.TEXTTORRENT_WEBHOOK_SECRET = "retired-tenant-producers-tt-secret";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "retired-tenant-producers-field-key";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ_USER = "7a7a7a7a-0000-4000-8000-00000000007a";
const OASIS_USER = "7b7b7b7b-0000-4000-8000-00000000007b";

// Nothing in this file may reach the network. Every call is recorded and
// answered with a refusal, so a path that DID try to page or call a provider
// is visible in `fetchCalls` rather than silently succeeding.
const fetchCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  fetchCalls.push(String(input instanceof Request ? input.url : input));
  return new Response(JSON.stringify({ ok: false, description: "network disabled in test" }), { status: 503 });
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

// reconcile-sms: the receipt reconciler and carrier breaker call TextTorrent.
// They record which tenants they were asked about.
let openReceiptTenants: string[] = [];
const reconciledTenants: string[] = [];
const breakerTenants: string[] = [];
stubModule(require.resolve("../lib/sms/delivery-receipts"), {
  tenantsWithOpenReceipts: async () => openReceiptTenants,
  reconcileReceipts: async (tenantId: string) => {
    reconciledTenants.push(tenantId);
    return { examined: 0, resolved: 0, delivered: 0, failed: 0, stillOpen: 0, abandoned: 0, errors: [] };
  },
  openReceipt: notCalled("openReceipt"),
  readRecentReceiptsByLine: notCalled("readRecentReceiptsByLine"),
  readRecentReceipts: notCalled("readRecentReceipts"),
  newestOpenReceiptAt: notCalled("newestOpenReceiptAt"),
});
stubModule(require.resolve("../lib/sms/send-breaker"), {
  smsSendAllowed: async (tenantId: string) => {
    breakerTenants.push(tenantId);
    return { halt: false, reason: "ok", sample: 0, failRatio: 0 };
  },
  resetBreakerCache: () => undefined,
  claimBreakerProbe: notCalled("claimBreakerProbe"),
});
const agentAlerts: string[] = [];
stubModule(require.resolve("../lib/notify/agent-alert"), {
  writeAgentAlert: async (input: { tenantId: string }) => {
    agentAlerts.push(input.tenantId);
    return { ok: true };
  },
  // reconcile-sms closes a recovered tenant's carrier card through this.
  resolveAgentAlerts: async () => 0,
});
stubModule(require.resolve("../lib/integrations/texttorrent-sender"), {
  resolveTextTorrentSenderId: async () => undefined,
});
stubModule(require.resolve("../lib/realtime/conversations-nudge"), {
  nudgeConversations: async () => undefined,
});

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Silence expected log lines from the code under test, keep them for asserts. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => void logged.push(a);
  console.warn = (...a: unknown[]) => void logged.push(a);
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    return { result: await fn(), logged };
  } finally {
    Object.assign(console, saved);
  }
}

const read = (p: string) => readFileSync(p, "utf8");

async function main() {
  // ── isRetiredTenant ──────────────────────────────────────────────────────
  await check("isRetiredTenant: SunBiz is retired, in any case and with stray whitespace", () => {
    assert.equal(SUNBIZ_RETIRED_TENANT_ID, SUNBIZ);
    assert.equal(isRetiredTenant(SUNBIZ), true);
    assert.equal(isRetiredTenant(SUNBIZ.toUpperCase()), true);
    assert.equal(isRetiredTenant(`  ${SUNBIZ}\n`), true);
  });
  await check("isRetiredTenant: OASIS tenants, blanks and non-strings are not retired", () => {
    assert.equal(isRetiredTenant(OASIS), false);
    assert.equal(isRetiredTenant("42423fde-be8b-454f-932a-750e8c9b743d"), false);
    assert.equal(isRetiredTenant(""), false);
    assert.equal(isRetiredTenant(null), false);
    assert.equal(isRetiredTenant(undefined), false);
    assert.equal(isRetiredTenant(42 as unknown as string), false);
  });
  await check("RETIRED_TENANT_IDS holds exactly SunBiz, lowercase; the list literal matches it", () => {
    assert.deepEqual([...RETIRED_TENANT_IDS], [SUNBIZ]);
    assert.equal(RETIRED_TENANT_ID_LIST, `(${SUNBIZ})`);
  });

  // ── Schema ───────────────────────────────────────────────────────────────
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  const ID_SQL = "(lower(hex(randomblob(16))))";
  await seed.executeMultiple(`
    CREATE TABLE probe_rows (id TEXT PRIMARY KEY, tenant_id TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, full_name TEXT,
      display_name TEXT, joined_at TEXT, deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, data TEXT, created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE health_check_runs (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, check_id TEXT,
      surface TEXT, verdict TEXT, observed REAL, baseline REAL, reason TEXT, ran_at TEXT);
    CREATE TABLE health_alert_state (alert_key TEXT PRIMARY KEY, tenant_id TEXT, last_signature TEXT,
      last_alerted_at TEXT, repeat_n INTEGER, first_failed_at TEXT, updated_at TEXT);
    CREATE TABLE sms_delivery_receipts (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT,
      drip_run_id TEXT, carrier_status TEXT, sent_at TEXT, purpose TEXT);
    CREATE TABLE drip_runs (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, status TEXT);
    CREATE TABLE sms_destination_health (tenant_id TEXT NOT NULL, phone_last10 TEXT NOT NULL,
      delivered INTEGER, failed INTEGER, textable INTEGER, verified INTEGER, reason TEXT,
      last_seen_at TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, phone_last10));
    CREATE TABLE agent_email_settings (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, mode TEXT,
      work_enabled INTEGER, personal_enabled INTEGER, daily_send_cap INTEGER, last_processed_at TEXT,
      UNIQUE (tenant_id, user_id));
    CREATE TABLE agent_email_snapshots (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, user_id TEXT,
      emails_in INTEGER, emails_out INTEGER, deals_with_email INTEGER, lender_declines INTEGER,
      awaiting_reply INTEGER DEFAULT 0, detail TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, lead_id TEXT,
      type TEXT, channel TEXT, direction TEXT, agent_source TEXT, provider TEXT, provider_message_id TEXT,
      actor_user_id TEXT, from_phone TEXT, to_phone TEXT, to_email TEXT, subject TEXT, content TEXT,
      content_preview TEXT, kixie_call_id TEXT UNIQUE, call_duration_sec INTEGER, recording_url TEXT,
      transcript_url TEXT, disposition TEXT, call_outcome TEXT, metadata TEXT, sent_at TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, event_type TEXT, publisher_agent TEXT,
      severity TEXT, payload TEXT, correlation_id TEXT, published_at TEXT DEFAULT ${NOW_SQL},
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE sunbiz_provider_rate_state (bucket TEXT PRIMARY KEY, tenant_id TEXT, provider TEXT,
      window_started_at TEXT, request_count INTEGER, updated_at TEXT);
    CREATE TABLE scheduled_calls (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT,
      reminded_at TEXT, scheduled_for TEXT);
    CREATE TABLE plan_templates (id TEXT PRIMARY KEY, profile_id TEXT, enabled INTEGER);
    CREATE TABLE call_appointments (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, lead_id TEXT,
      entity_type TEXT, scheduled_for TEXT, assigned_to TEXT, pre_call_note TEXT, created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE scheduled_sends (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT, lead_id TEXT,
      thread_key TEXT, channel TEXT, to_phone TEXT, body TEXT, actor_user_id TEXT, from_identity TEXT,
      scheduled_for TEXT, status TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE tenant_integration_credentials (tenant_id TEXT, service TEXT, field_key TEXT,
      encrypted_value TEXT);
    CREATE TABLE user_integration_credentials (tenant_id TEXT, user_id TEXT, service TEXT, field_key TEXT,
      encrypted_value TEXT);
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT NOT NULL, phone_last10 TEXT NOT NULL,
      reason TEXT, source TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, phone_last10));
    CREATE TABLE texttorrent_inbound_work (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT,
      account_id TEXT, provider_message_id TEXT, status TEXT, UNIQUE (tenant_id, provider_message_id));
    CREATE TABLE email_open_events (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT,
      outbound_message_id TEXT, lead_id TEXT, user_agent TEXT, ip_hash TEXT, suspicious_prefetch INTEGER,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE UNIQUE INDEX email_open_events_dedupe ON email_open_events (outbound_message_id, ip_hash);
    CREATE TABLE email_click_events (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT,
      outbound_message_id TEXT, lead_id TEXT, clicked_url TEXT, user_agent TEXT, ip_hash TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
    CREATE UNIQUE INDEX email_click_events_dedupe ON email_click_events (outbound_message_id, ip_hash);
  `);
  const rows = async (sql: string, args: Array<string | number | null> = []) =>
    (await seed.execute({ sql, args })).rows as unknown as Array<Record<string, unknown>>;
  const countFor = async (table: string, tenantId: string, column = "tenant_id") =>
    Number((await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [tenantId]))[0].n);

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { NextRequest } = await import("next/server");
  const cronHeaders = { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-vercel-cron": "1" };

  // ── The query-level exclusion itself ─────────────────────────────────────
  // Ordered, LIMITed claim queues exclude retired tenants IN the query, so a
  // retired tenant's rows can neither be claimed nor take the batch's slots.
  await check("query exclusion: .not(tenant_id in RETIRED_TENANT_ID_LIST) drops SunBiz before the LIMIT", async () => {
    await seed.execute({
      sql: "INSERT INTO probe_rows (id, tenant_id) VALUES ('a', ?), ('b', ?), ('c', ?), ('d', ?)",
      args: [SUNBIZ, SUNBIZ, OASIS, SUNBIZ],
    });
    const r = await getServiceSupabase()
      .from("probe_rows")
      .select("id, tenant_id")
      .not("tenant_id", "in", RETIRED_TENANT_ID_LIST)
      .order("id", { ascending: true })
      .limit(1);
    assert.equal(r.error, null);
    assert.deepEqual(r.data, [{ id: "c", tenant_id: OASIS }], "SunBiz rows took the only slot");
  });

  // ── Health lanes: health_check_runs + health_alert_state ─────────────────
  const { runHealthChecks, ESTATE_WIDE_CHECKS } = await import("../lib/health/runner");
  const synthetic = {
    id: "retired.synthetic_failure",
    severity: "critical" as const,
    lane: "operator" as const,
    rule: { kind: "must_be_zero" as const },
    observe: async () => 1,
    describe: () => "synthetic failure",
  };
  const pages: string[] = [];
  const send = async (message: string) => {
    pages.push(message);
    return { ok: true };
  };

  await check("runHealthChecks: a retired tenant is not checked, persisted or paged", async () => {
    const observed: string[] = [];
    const summary = await runHealthChecks(SUNBIZ, {
      checks: [{ ...synthetic, observe: async (_db: unknown, t: string) => (observed.push(t), 1) }],
      sendTelegramImpl: send as never,
    });
    assert.equal(summary.ran, 0);
    assert.deepEqual(summary.results, []);
    assert.deepEqual(summary.alerted, []);
    assert.deepEqual(observed, [], "a check observed the retired tenant");
    assert.equal(await countFor("health_check_runs", SUNBIZ), 0);
    assert.equal(await countFor("health_alert_state", SUNBIZ), 0);
    assert.deepEqual(pages, []);
  });

  await check("runHealthChecks: control — the same failing check for OASIS persists and pages", async () => {
    const summary = await runHealthChecks(OASIS, { checks: [synthetic], sendTelegramImpl: send as never });
    assert.equal(summary.ran, 1);
    assert.deepEqual(summary.alerted, [synthetic.id]);
    assert.ok(await countFor("health_check_runs", OASIS) >= 2, "result + run summary rows");
    assert.equal(await countFor("health_alert_state", OASIS), 1);
    assert.equal(pages.length, 1);
  });

  await check("health-check route: SunBiz's lane is gone; estate-wide checks run under OASIS", () => {
    const route = read("app/api/cron/health-check/route.ts");
    assert.ok(!route.includes("aa04fa1f"), "the route still names the SunBiz tenant");
    assert.ok(!/SUNBIZ_TENANT_ID/.test(route));
    assert.ok(!/tenantOutcomeChecks|runGuardAudit|announceGuardAudit/.test(route), "a SunBiz-only lane still runs");
    assert.match(route, /runHealthChecks\(WEBDEV_TENANT_ID, \{\s*notify,\s*checks: ESTATE_WIDE_CHECKS,/);
    assert.deepEqual(
      ESTATE_WIDE_CHECKS.map((c) => c.id).sort(),
      ["alerting.delivery_failures", "deploy.prod_serves_main", "forms.submit_failures_open"],
      "estate-wide checks must be exactly the ones that ignore the tenant they run under",
    );
  });

  const { announceGuardAudit } = await import("../lib/health/guard-audit");
  const audit = { readings: [], findings: [{ id: "guard.synthetic", severity: "high" as const, message: "x" }], summary: "1 broken" };
  await check("announceGuardAudit: a retired tenant writes no health_alert_state and pages nobody", async () => {
    const before = fetchCalls.length;
    await seed.execute("DELETE FROM health_alert_state WHERE alert_key = 'guard-audit:broken-instruments'");
    assert.deepEqual(await announceGuardAudit(SUNBIZ, audit), { alerted: [] });
    assert.equal(await countFor("health_alert_state", SUNBIZ), 0);
    assert.equal(fetchCalls.length, before, "the retired path reached the network");
  });
  await check("announceGuardAudit: control — OASIS still records the alert episode", async () => {
    const r = await announceGuardAudit(OASIS, audit);
    assert.deepEqual(r.alerted, ["guard-audit:broken-instruments"]);
    assert.equal(
      (await rows("SELECT tenant_id FROM health_alert_state WHERE alert_key = 'guard-audit:broken-instruments'"))[0]?.tenant_id,
      OASIS,
    );
  });

  const { announceBenchedLines } = await import("../lib/sms/line-health");
  const benched = (n: string) => ({
    lines: [],
    blocked: [{ number: n, bench: true, consecutiveFailures: 5, sample: 5, reason: "5 failed in a row" }],
    wireHalted: false,
    reason: "benched",
  });
  await check("announceBenchedLines: a retired tenant writes no health_alert_state", async () => {
    const before = fetchCalls.length;
    assert.deepEqual(await announceBenchedLines(SUNBIZ, benched("+15145550901")), { alerted: [] });
    assert.equal(await countFor("health_alert_state", SUNBIZ), 0);
    assert.equal(fetchCalls.length, before, "the retired path reached the network");
  });
  await check("announceBenchedLines: control — OASIS records the benched line", async () => {
    const r = await announceBenchedLines(OASIS, benched("+15145550902"));
    assert.deepEqual(r.alerted, ["sms-line-benched:sms:+15145550902"]);
    assert.equal(
      (await rows("SELECT tenant_id FROM health_alert_state WHERE alert_key = ?", ["sms-line-benched:sms:+15145550902"]))[0]?.tenant_id,
      OASIS,
    );
  });

  // ── SMS destination health + reconcile-sms ───────────────────────────────
  await seed.batch(
    [
      {
        sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES ('lead-sb', ?, 'lead', ?), ('lead-oa', ?, 'lead', ?)",
        args: [SUNBIZ, JSON.stringify({ phone: "+15145550111" }), OASIS, JSON.stringify({ phone: "+15145550222" })],
      },
    ],
    "write",
  );
  const { refreshDestinationHealth } = await import("../lib/sms/destination-health");
  await check("refreshDestinationHealth: a retired tenant is skipped and says why", async () => {
    const r = await refreshDestinationHealth(SUNBIZ);
    assert.deepEqual(r, { examined: 0, untextable: 0, verified: 0, written: 0, error: "skipped: tenant retired" });
    assert.equal(await countFor("sms_destination_health", SUNBIZ), 0);
  });
  await check("refreshDestinationHealth: control — OASIS verdicts are still written", async () => {
    const r = await refreshDestinationHealth(OASIS);
    assert.equal(r.error, null);
    assert.equal(r.written, 1);
    assert.equal(await countFor("sms_destination_health", OASIS), 1);
  });

  await check("reconcile-sms route: the retired tenant is neither reconciled, refreshed nor breaker-read", async () => {
    openReceiptTenants = [SUNBIZ, OASIS];
    await seed.execute("DELETE FROM sms_destination_health");
    const { GET } = await import("../app/api/cron/reconcile-sms/route");
    const res = await GET(new NextRequest("http://localhost/api/cron/reconcile-sms", { headers: cronHeaders }));
    const body = (await res.json()) as {
      ok: boolean; tenants: number; breakers: Record<string, unknown>; destination_health: Record<string, unknown>;
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.tenants, 1);
    assert.deepEqual(reconciledTenants, [OASIS]);
    assert.deepEqual(breakerTenants, [OASIS]);
    assert.deepEqual(Object.keys(body.breakers), [OASIS]);
    assert.deepEqual(Object.keys(body.destination_health), [OASIS]);
    assert.equal(await countFor("sms_destination_health", SUNBIZ), 0);
    assert.equal(await countFor("sms_destination_health", OASIS), 1, "OASIS health stopped refreshing");
  });
  await check("reconcile-sms route: an empty receipt queue no longer drags SunBiz in", async () => {
    openReceiptTenants = [];
    reconciledTenants.length = 0;
    // OASIS's benched-line control above writes its card; this run must add none.
    const alertsBefore = agentAlerts.length;
    const { GET } = await import("../app/api/cron/reconcile-sms/route");
    const res = await GET(new NextRequest("http://localhost/api/cron/reconcile-sms", { headers: cronHeaders }));
    const body = (await res.json()) as { ok: boolean; tenants: number };
    assert.equal(res.status, 200);
    assert.equal(body.tenants, 0);
    assert.deepEqual(reconciledTenants, []);
    assert.deepEqual(agentAlerts.slice(alertsBefore), []);
    assert.ok(!agentAlerts.includes(SUNBIZ), "an alert was written for the retired workspace");
  });

  // ── Operator-email agent: agent_email_snapshots ──────────────────────────
  await seed.execute({
    sql: `INSERT INTO agent_email_settings (tenant_id, user_id, mode, work_enabled, personal_enabled, daily_send_cap, last_processed_at)
          VALUES (?, ?, 'monitor', 1, 0, 100, NULL), (?, ?, 'monitor', 1, 0, 100, '2026-09-01T00:00:00Z')`,
    args: [SUNBIZ, SUNBIZ_USER, OASIS, OASIS_USER],
  });
  const { listActiveAgents } = await import("../lib/agents/operator-email/settings");
  await check("listActiveAgents: a retired tenant's agent never takes a polling slot", async () => {
    // SunBiz's cursor is NULL, so it sorts first (nullsFirst). Filtered after
    // the LIMIT, it would hold the only slot forever.
    const agents = await listActiveAgents(1);
    assert.deepEqual(agents.map((a) => a.tenantId), [OASIS]);
  });
  const { writeSnapshot } = await import("../lib/agents/operator-email/snapshots");
  await check("writeSnapshot: no agent_email_snapshots row for a retired tenant", async () => {
    await writeSnapshot(SUNBIZ, SUNBIZ_USER);
    assert.equal(await countFor("agent_email_snapshots", SUNBIZ), 0);
  });
  await check("writeSnapshot: control — OASIS still gets its snapshot", async () => {
    await writeSnapshot(OASIS, OASIS_USER);
    assert.equal(await countFor("agent_email_snapshots", OASIS), 1);
  });

  // ── TextTorrent rate bucket: sunbiz_provider_rate_state ──────────────────
  const { consume_texttorrent_rate_token } = await import("../lib/turso-rpc-shim");
  await check("consume_texttorrent_rate_token: no token and no bucket row for a retired tenant", async () => {
    for (const bucket of [`${SUNBIZ}:parent-sid`, `${SUNBIZ.toUpperCase()}:parent-sid`]) {
      assert.equal(await consume_texttorrent_rate_token(seed, { p_bucket: bucket, p_worker_id: "t", p_priority: 90 }), false);
    }
    assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM sunbiz_provider_rate_state"))[0].n), 0);
  });
  await check("consume_texttorrent_rate_token: control — another tenant still gets a token", async () => {
    assert.equal(await consume_texttorrent_rate_token(seed, { p_bucket: `${OASIS}:parent-sid`, p_worker_id: "t", p_priority: 90 }), true);
    assert.equal(await countFor("sunbiz_provider_rate_state", OASIS), 1);
  });
  const tt = await import("../lib/integrations/texttorrent");
  await check("TextTorrent client: a retired tenant is refused before the rate gate or any call", async () => {
    const before = fetchCalls.length;
    await assert.rejects(
      () => tt.meAccountInfo({ tenantId: SUNBIZ, apiSid: "sid", publicKey: "pk", actAsEmail: null } as never),
      (err: unknown) => err instanceof tt.TextTorrentError && err.code === "tenant_retired" && err.status === 410,
    );
    assert.equal(fetchCalls.length, before, "a TextTorrent request left the machine");
    assert.equal(await countFor("sunbiz_provider_rate_state", SUNBIZ), 0);
  });

  // ── Multi-tenant crons that keep running ─────────────────────────────────
  await check("dispatch-scheduled-calls: a retired tenant's calls are neither reminded nor marked missed", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 72 * 3_600_000).toISOString();
    await seed.execute({
      sql: `INSERT INTO scheduled_calls (id, tenant_id, status, reminded_at, scheduled_for) VALUES
              ('sb-due', ?, 'pending', NULL, ?), ('sb-stale', ?, 'pending', NULL, ?),
              ('oa-due', ?, 'pending', NULL, ?), ('oa-stale', ?, 'pending', NULL, ?)`,
      args: [SUNBIZ, due, SUNBIZ, stale, OASIS, due, OASIS, stale],
    });
    const { GET } = await import("../app/api/cron/dispatch-scheduled-calls/route");
    const res = await GET(new NextRequest("http://localhost/api/cron/dispatch-scheduled-calls", { headers: cronHeaders }));
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(
      (await rows("SELECT id, status, reminded_at FROM scheduled_calls")).map((r) => [r.id, r]),
    );
    assert.equal(byId["sb-due"].reminded_at, null);
    assert.equal(byId["sb-due"].status, "pending");
    assert.equal(byId["sb-stale"].status, "pending");
    assert.ok(byId["oa-due"].reminded_at, "OASIS due call was not reminded");
    assert.equal(byId["oa-stale"].status, "missed", "OASIS overdue call was not marked missed");
  });

  await check("materialize-plans: a retired tenant's profiles get no daily plan", async () => {
    await seed.batch(
      [
        {
          sql: "INSERT INTO user_profiles (id, tenant_id, full_name) VALUES ('prof-sb', ?, 'Sun Rep'), ('prof-oa', ?, 'Oasis Rep')",
          args: [SUNBIZ, OASIS],
        },
        "INSERT INTO plan_templates (id, profile_id, enabled) VALUES ('pt-1', 'prof-sb', 1), ('pt-2', 'prof-oa', 1), ('pt-3', 'prof-sb', 1)",
      ],
      "write",
    );
    const { GET } = await import("../app/api/cron/materialize-plans/route");
    const res = await GET(new NextRequest("http://localhost/api/cron/materialize-plans", { headers: cronHeaders }));
    const body = (await res.json()) as { ok: boolean; results: Array<{ profile_id: string }> };
    assert.equal(res.status, 200, JSON.stringify(body));
    // The OASIS attempt errors here (no daily_plans schema in this fixture);
    // what matters is that it was ATTEMPTED and SunBiz's was not.
    assert.deepEqual(body.results.map((r) => r.profile_id), ["prof-oa"]);
  });

  await check("claim queues exclude retired tenants in the query, before the LIMIT", () => {
    const FILTER = String.raw`\.not\("tenant_id", "in", RETIRED_TENANT_ID_LIST\)`;
    const cases: Array<[string, RegExp]> = [
      ["app/api/cron/dispatch-scheduled-sends/route.ts",
        new RegExp(String.raw`\.from\("scheduled_sends"\)\s*\.select\("id"\)[^;]*?${FILTER}[^;]*?\.limit\(BATCH_LIMIT\)`)],
      ["app/api/cron/dispatch-founder-meeting-reminders/route.ts",
        new RegExp(String.raw`\.from\("website_sales_meeting_notifications"\)\s*\.select\("id,tenant_id"\)[^;]*?${FILTER}[^;]*?\.limit\(BATCH_LIMIT\)`)],
      ["app/api/cron/collect-cc-metrics/route.ts",
        new RegExp(String.raw`\.from\("campaign_runs"\)[^;]*?${FILTER}[^;]*?\.limit\(50\)`)],
      ["lib/drips/enroller.ts",
        new RegExp(String.raw`\.from\("drip_sequences"\)[^;]*?\.eq\("enabled", true\)\s*${FILTER};`)],
      ["lib/drips/executor.ts",
        new RegExp(String.raw`\.from\("drip_runs"\)\s*\.select\("id"\)\s*\.eq\("status", "scheduled"\)[^;]*?${FILTER}[^;]*?\.limit\(claimBudget\)`)],
      ["lib/drips/executor.ts",
        new RegExp(String.raw`\.update\(\{ status: "scheduled" \}\)\s*\.eq\("status", "sending"\)[^;]*?${FILTER}`)],
    ];
    for (const [file, pattern] of cases) assert.match(read(file), pattern, `${file} lost its retired-tenant exclusion`);
  });

  await check("sms-reply-agent: a retired tenant's job is skipped before it can be claimed or dead-lettered", () => {
    assert.match(
      read("lib/sms/reply-agent.ts"),
      /if \(isRetiredTenant\(candidate\.tenant_id\)\) continue;\s*if \(candidate\.attempts >= MAX_ATTEMPTS\)/,
    );
  });

  await check("drip telemetry backfill skips retired tenants' rows", () => {
    assert.match(
      read("lib/drips/reconcile-email-telemetry.ts"),
      /\.filter\(\(row\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(isRetiredTenant\(row\.tenant_id\)\) return false;/,
    );
  });

  // ── Schedules: SunBiz-only routes are gone from all three places ─────────
  await check("SunBiz-only cron routes are scheduled nowhere; the multi-tenant ones still are", async () => {
    const { CRON_TABLE } = await import("../workers/oasis-cc-cron/src/index");
    const registry = JSON.parse(read("config/cron-registry.json")) as { crons: Array<{ path: string }> };
    const driver = read(".github/workflows/cron-driver.yml");
    const base = (p: string) => p.split("?")[0];
    const REMOVED = [
      "collect-outreach-intel", "scan-lender-replies", "sync-tt-inbox", "scan-bounces", "scan-funmate-replies",
      "sweep-stale-sent-app", "kixie-compliance-scan", "enroll-accelerated", "tps-enroll", "tps-backlog-watch",
      "renewal-thresholds", "sync-sms-numbers", "dispatch-bulk-email",
    ].map((r) => `/api/cron/${r}`);
    for (const path of REMOVED) {
      assert.ok(!CRON_TABLE.some((c) => base(c.path) === path), `Worker still schedules ${path}`);
      assert.ok(!registry.crons.some((c) => base(c.path) === path), `registry still lists ${path}`);
      assert.ok(!new RegExp(`${path}(?![\\w-])`).test(driver), `cron-driver.yml still drives ${path}`);
    }
    const KEPT = [
      "materialize-plans", "collect-cc-metrics", "dispatch-scheduled-sends", "dispatch-scheduled-calls",
      "sms-reply-agent", "enroll-drips", "dispatch-drips", "reconcile-drip-telemetry",
      "reconcile-website-sales-payments", "dispatch-founder-meeting-reminders", "operator-email-agent",
      "health-check", "sla-check", "reconcile-sms",
      // OASIS OS Connections (2026-09-29): multi-tenant, per-connection probes.
      "connection-health",
      // The OASIS business book's daily upkeep (2026-09-29): rates, Stripe, Wise.
      // Tenant-free: the Finances book carries no tenant key, and SunBiz has none.
      "finance-books",
    ].map((r) => `/api/cron/${r}`);
    assert.deepEqual([...new Set(CRON_TABLE.map((c) => base(c.path)))].sort(), [...KEPT].sort());
  });

  // ── Webhooks: 200-ack, nothing stored ────────────────────────────────────
  await seed.execute({
    sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'submissions', 'SunBiz', ?), (?, 'oasis-ai-cc', 'OASIS', ?)",
    args: [SUNBIZ, JSON.stringify({ kixie_business_id: "7001" }), OASIS, JSON.stringify({ kixie_business_id: "7002" })],
  });
  const kixie = await import("../app/api/webhooks/kixie/route");
  const postKixie = (businessid: number, callid: string) =>
    quietly(async () => {
      const res = await kixie.POST(
        new NextRequest("http://localhost/api/webhooks/kixie", {
          method: "POST",
          headers: { "content-type": "application/json", "x-kixie-token": process.env.KIXIE_WEBHOOK_SECRET! },
          body: JSON.stringify({ businessid, eventname: "endcall", callid, calltype: "outgoing", duration: 12 }),
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
  await check("kixie webhook: a retired tenant's event gets 200 and writes nothing", async () => {
    const { result, logged } = await postKixie(7001, "call-retired");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, ignored: "tenant_retired" });
    assert.equal(await countFor("agent_events", SUNBIZ, "correlation_id"), 0);
    assert.equal(await countFor("lead_interactions", SUNBIZ), 0);
    assert.equal(await countFor("call_appointments", SUNBIZ), 0);
    assert.equal(await countFor("scheduled_sends", SUNBIZ), 0);
    assert.ok(logged.some((a) => String(a[0]).includes("tenant retired")), "the dropped event left no trace in the logs");
  });
  await check("kixie webhook: control — another tenant's event is still stored", async () => {
    const { result } = await postKixie(7002, "call-live");
    assert.notEqual(result.body.ignored, "tenant_retired");
    assert.equal(await countFor("agent_events", OASIS, "correlation_id"), 1);
  });

  const { encryptField } = await import("../lib/field-encryption");
  await seed.execute({
    sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value)
          VALUES (?, 'texttorrent', 'from_number', ?), (?, 'texttorrent', 'from_number', ?)`,
    args: [SUNBIZ, encryptField("+15145550301"), OASIS, encryptField("+15145550302")],
  });
  const ttInbound = await import("../app/api/webhooks/texttorrent/sms-inbound/route");
  const postTt = (to: string, messageId: string) =>
    quietly(async () => {
      const raw = JSON.stringify({ from: "+15145559876", to, message: "STOP", message_id: messageId });
      const sig = createHmac("sha256", process.env.TEXTTORRENT_WEBHOOK_SECRET!).update(raw, "utf8").digest("base64");
      const res = await ttInbound.POST(
        new NextRequest("http://localhost/api/webhooks/texttorrent/sms-inbound", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tt-signature": sig },
          body: raw,
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
  await check("texttorrent webhook: a retired tenant's message gets 200 and writes nothing, even a STOP", async () => {
    const { result, logged } = await postTt("+15145550301", "tt-retired");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, ignored: "tenant_retired" });
    assert.equal(await countFor("sunbiz_phone_suppressions", SUNBIZ), 0);
    assert.equal(await countFor("lead_interactions", SUNBIZ), 0);
    assert.equal(await countFor("texttorrent_inbound_work", SUNBIZ), 0);
    assert.equal(await countFor("agent_events", SUNBIZ, "correlation_id"), 0);
    assert.ok(logged.some((a) => String(a[0]).includes("tenant retired")), "the dropped message left no trace in the logs");
  });
  await check("texttorrent webhook: control — another tenant's STOP is still recorded", async () => {
    await postTt("+15145550302", "tt-live");
    assert.equal(await countFor("sunbiz_phone_suppressions", OASIS), 1);
  });

  // ── Email tracking pixels and links: agent_events + open/click events ────
  await seed.execute({
    sql: `INSERT INTO lead_interactions (id, tenant_id, lead_id, channel, direction, subject, sent_at)
          VALUES ('msg-sunbiz-0001', ?, 'lead-sb', 'email', 'outbound', 'Old SunBiz mail', '2026-09-01T00:00:00Z'),
                 ('msg-oasis-00001', ?, 'lead-oa', 'email', 'outbound', 'OASIS mail', '2026-09-01T00:00:00Z')`,
    args: [SUNBIZ, OASIS],
  });
  const open = await import("../app/api/track/open/[id]/route");
  const click = await import("../app/api/track/click/[id]/route");
  const hit = (mod: { GET: (req: never, ctx: never) => Promise<Response> }, kind: string, id: string) =>
    quietly(() =>
      mod.GET(
        new NextRequest(`http://localhost/api/track/${kind}/${id}`, {
          headers: { "user-agent": "Mail/1.0", "x-forwarded-for": "203.0.113.9" },
        }) as never,
        { params: Promise.resolve({ id }) } as never,
      ),
    );
  await check("open pixel: a retired tenant's open serves the pixel and records nothing", async () => {
    const { result } = await hit(open, "open", "msg-sunbiz-0001");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), "image/gif");
    assert.equal(await countFor("email_open_events", SUNBIZ), 0);
    assert.equal(await countFor("agent_events", SUNBIZ, "correlation_id"), 0);
  });
  await check("open pixel: control — an OASIS open is still recorded", async () => {
    const { result } = await hit(open, "open", "msg-oasis-00001");
    assert.equal(result.status, 200);
    assert.equal(await countFor("email_open_events", OASIS), 1);
  });
  await check("click link: a retired tenant's click still redirects but records nothing", async () => {
    const { result } = await hit(click, "click", "msg-sunbiz-0001");
    assert.equal(result.status, 302);
    assert.ok(result.headers.get("location"), "the recipient was not redirected");
    assert.equal(await countFor("email_click_events", SUNBIZ), 0);
    assert.equal(await countFor("agent_events", SUNBIZ, "correlation_id"), 0);
  });
  await check("click link: control — an OASIS click is still recorded", async () => {
    const { result } = await hit(click, "click", "msg-oasis-00001");
    assert.equal(result.status, 302);
    assert.equal(await countFor("email_click_events", OASIS), 1);
  });

  // Every write for the retired tenant, across the whole file: none.
  await check("across every path above, no table holds a row written for the retired tenant", async () => {
    const tables = [
      "health_check_runs", "health_alert_state", "sms_destination_health", "agent_email_snapshots",
      "sunbiz_provider_rate_state", "sunbiz_phone_suppressions", "texttorrent_inbound_work",
      "email_open_events", "email_click_events", "call_appointments", "scheduled_sends",
    ];
    for (const t of tables) assert.equal(await countFor(t, SUNBIZ), 0, `${t} has a SunBiz row`);
    assert.equal(await countFor("agent_events", SUNBIZ, "correlation_id"), 0, "agent_events has a SunBiz row");
    // lead_interactions holds only the fixture row seeded above.
    assert.deepEqual((await rows("SELECT id FROM lead_interactions WHERE tenant_id = ?", [SUNBIZ])).map((r) => r.id), ["msg-sunbiz-0001"]);
  });

  if (failures) {
    console.log(`retired-tenant-producers: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("retired-tenant-producers: ok");
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
