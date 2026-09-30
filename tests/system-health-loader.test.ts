/**
 * system-health-loader.test.ts — the one System health (2026-09-30, OASIS OS
 * S2 T3) against a real local libSQL file.
 *
 * WHY. /system-health fetched its own API with no session, got the
 * middleware's 401 and showed CC "Local guard substrate not active here … Last
 * fetch error: unauthorized" with a docker command for a file that does not
 * exist; behind it, a fallback labelled Turso data as another database, named
 * the wrong host and drew every guard "off". /health now reads everything
 * in-process through lib/admin/system-health.ts and lib/admin/attention.ts.
 * This file pins what that loader says:
 *
 *   - guards: missing -> "Not reported yet", stale -> "Not verified since T",
 *     a report that says it failed -> failing; never "off" unless a FRESH
 *     report says off; enforce/report/off -> On / Watching only / Off;
 *   - the verdict line for fresh, stale, missing and not-enforce reports;
 *   - the computer's state at the /operations thresholds (90 s / 5 min);
 *   - the newest heartbeat per service wins over stale duplicates;
 *   - cron failures and events are this tenant's (events: its own or
 *     untenanted), inside 24 h, with 'warning' read as 'warn';
 *   - cold leads is COUNT(*), not a 50-row list's length;
 *   - a failed read is null ("Couldn't check"), never 0;
 *   - the rendered /health page names no retired host or engine (docker,
 *     Vercel, state-api, Supabase) and no "unauthorized", and draws no card
 *     for a retired provider. The integration cards themselves are drawn in
 *     full React by tests/system-health.render.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/system-health-loader.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "system-health-loader-"));
const dbFile = join(scratch, "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "system-health-loader-secret-long-enough-000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "adon@oasisai.work";

// No read here may reach the network. The page's bridge probe resolves no
// target (no bridge_url) before it would fetch; anything else fails loudly.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => {
    throw new Error("client hook called under react-server");
  },
  usePathname: () => {
    throw new Error("client hook called under react-server");
  },
  useSearchParams: () => {
    throw new Error("client hook called under react-server");
  },
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const CC = { id: "0f000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };
const NOW = Date.now();
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// ── A server-tree walker that awaits async components (as in
// tests/queries-fail-loud-callers.test.ts): client components are recorded
// with the props the page handed them.
type Recorded = { name: string; props: Record<string, unknown> };
const NOT_TEXT = new Set(["className", "id", "role", "style", "key", "href", "src"]);
const CLIENT_ONLY = /is not a function|client hook called|Invalid hook call|reading 'use/;
async function walk(node: unknown, out: string[], client: Recorded[], depth = 0): Promise<void> {
  if (depth > 120 || node === null || node === undefined || typeof node === "boolean") return;
  if (node instanceof Promise) return walk(await node, out, client, depth + 1);
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) await walk(n, out, client, depth + 1);
    return;
  }
  if (!isValidElement(node)) return;
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof node.type === "function") {
    const fn = node.type as (p: unknown) => unknown;
    let rendered: unknown;
    try {
      rendered = await fn(props);
    } catch (err) {
      if (CLIENT_ONLY.test((err as Error).message)) {
        client.push({ name: fn.name, props });
        return;
      }
      throw err;
    }
    return walk(rendered, out, client, depth + 1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") await walk(v, out, client, depth + 1);
    else if (typeof v === "string" && !NOT_TEXT.has(k)) out.push(v);
    else if (isValidElement(v)) await walk(v, out, client, depth + 1);
  }
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, lifecycle TEXT);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL,
      last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY, profile_id TEXT, tenant_id TEXT, service TEXT NOT NULL,
      status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT, metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT);
    CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, action_type TEXT,
      owner_agent_key TEXT, last_run_at TEXT, last_result TEXT, fail_count INTEGER DEFAULT 0, tenant_id TEXT NOT NULL);
    CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, schedule TEXT NOT NULL,
      last_run_at TEXT, last_run_status TEXT, last_run_error TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, publisher_agent TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info', payload TEXT NOT NULL DEFAULT '{}', correlation_id TEXT, published_at TEXT NOT NULL);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, provider TEXT, encrypted_api_key TEXT,
      enabled INTEGER, user_id TEXT);
  `);

  const allOn = {
    contract: 1,
    guards: {
      exec_guard: { mode: "enforce", blocked_24h: 9, would_block_24h: 0, last_block_at: ago(2 * H), categories_24h: { "hard-blocklist": 9 } },
      secret_guard: { mode: "enforce", blocked_24h: 123, would_block_24h: 0, last_block_at: ago(10 * MIN) },
      state_guard: { mode: "enforce", blocked_24h: 0, would_block_24h: 0, last_block_at: null },
      coord_guard: { mode: "enforce", blocked_24h: 0, would_block_24h: 0, last_block_at: null },
      subprocess_guard: { mode: "enforce", blocked_24h: 0, would_block_24h: 0, last_block_at: null },
    },
  };
  const stmts: Array<{ sql: string; args: unknown[] }> = [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
    { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
    { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
            VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, '["bravo"]', ?)`,
      args: [CC.id, CC.email, OASIS, ago(30 * 24 * H), ago(30 * 24 * H)],
    },
    // Computers: CCPC 40 s ago; an old Mac; a revoked one that pinged just now
    // (never "your computer"); another workspace's (never listed here).
    { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('bp-1', ?, 'CCPC (Windows)', ?)", args: [OASIS, ago(40 * S)] },
    { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('bp-2', ?, 'Old Mac', ?)", args: [OASIS, ago(30 * 24 * H)] },
    { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at, revoked_at) VALUES ('bp-3', ?, 'Revoked box', ?, ?)", args: [OASIS, ago(5 * S), ago(1 * H)] },
    { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('bp-4', ?, 'CLIENT-PC-DO-NOT-LIST', ?)", args: [CLIENT, ago(5 * S)] },
    // Guards: a month-old duplicate saying "off" beside the fresh report. The
    // newest must win: the old one would say "Can't verify".
    {
      sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at, metadata) VALUES ('g-old', NULL, ?, 'guard_substrate', 'healthy', ?, ?)",
      args: [OASIS, ago(30 * 24 * H), JSON.stringify({ guards: { exec_guard: { mode: "off" } } })],
    },
    {
      sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at, metadata) VALUES ('g-new', 'p-cc', ?, 'guard_substrate', 'healthy', ?, ?)",
      args: [OASIS, ago(50 * S), JSON.stringify(allOn)],
    },
    // Workers. Scheduler: fresh, with a stale profile_id NULL duplicate.
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('w1-old', NULL, ?, 'pm2.bravo-scheduler', 'down', ?)", args: [OASIS, ago(45 * 24 * H)] },
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('w1', 'p-cc', ?, 'pm2.bravo-scheduler', 'healthy', ?)", args: [OASIS, ago(30 * S)] },
    // The setter stopped reporting two hours ago: down.
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('w2', 'p-cc', ?, 'pm2.bravo-ig-dm', 'healthy', ?)", args: [OASIS, ago(2 * H)] },
    // Atlas's bridge stopped by the operator: not down.
    {
      sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at, metadata) VALUES ('w3', 'p-cc', ?, 'pm2.atlas-telegram', 'degraded', ?, ?)",
      args: [OASIS, ago(30 * S), JSON.stringify({ pm2_status: "disabled by operator" })],
    },
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('w4', 'p-cc', ?, 'fleet_watchdog', 'healthy', ?)", args: [OASIS, ago(30 * S)] },
    // Another workspace's fresh scheduler must not count for OASIS.
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('w5', NULL, ?, 'pm2.bravo-ig-dm', 'healthy', ?)", args: [CLIENT, ago(10 * S)] },
    // Heartbeat cards: a retired host with a ping (never drawn) and a live one a day and a half old.
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('h1', 'p-cc', ?, 'vercel', 'healthy', ?)", args: [OASIS, ago(10 * MIN)] },
    { sql: "INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at) VALUES ('h2', 'p-cc', ?, 'cloudflare', 'healthy', ?)", args: [OASIS, ago(36 * H)] },
    // Cron: two OASIS failures inside 24 h; one outside; a success; a client's failure.
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c1', 'Post Analytics Sync', '17 * * * *', ?, 'ERROR: script_run timed out (600s)', ?)", args: [ago(1 * H), OASIS] },
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c2', 'Old Failure', '0 3 * * *', ?, 'ERROR: exit 1', ?)", args: [ago(30 * H), OASIS] },
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c3', 'Fine Job', '0 4 * * *', ?, 'ok: synced 298', ?)", args: [ago(1 * H), OASIS] },
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c4', 'CLIENT-CRON-DO-NOT-COUNT', '0 5 * * *', ?, 'ERROR: exit 1', ?)", args: [ago(1 * H), CLIENT] },
    { sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, last_run_at, last_run_status, last_run_error) VALUES ('t1', ?, 'Atlas Inbound Email', '*/15 * * * *', ?, 'error', 'unknown_action_type: x')", args: [OASIS, ago(2 * H)] },
    { sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, last_run_at, last_run_status, last_run_error) VALUES ('t2', ?, 'Client Job', '0 1 * * *', ?, 'error', 'boom')", args: [CLIENT, ago(1 * H)] },
    // Failure is a shape, not a prefix (lib/cron-empire-row.ts, the classifier
    // /automations draws with): a JSON summary reporting its own errors, a
    // "failed: N" counter, and unresolved failures on the counter are all
    // failures; a "failed: 0" counter is not. A workspace error stored as JSON
    // text arrives from the shim as an object and must not throw.
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c5', 'Inbound Email Sweep', '*/5 * * * *', ?, ?, ?)", args: [ago(10 * MIN), '{"errors": 3, "sent": 0}', OASIS] },
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c6', 'Library Post Linker', '0 * * * *', ?, 'synced: 10, failed: 4', ?)", args: [ago(20 * MIN), OASIS] },
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, tenant_id) VALUES ('c7', 'Healthy Counter', '0 * * * *', ?, 'synced: 157, failed: 0', ?)", args: [ago(30 * MIN), OASIS] },
    { sql: "INSERT INTO cron_jobs (id, name, schedule, last_run_at, last_result, fail_count, tenant_id) VALUES ('c8', 'Morning Brief', '0 7 * * *', ?, 'SKIPPED: bridge offline', 2, ?)", args: [ago(3 * H), OASIS] },
    { sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, last_run_at, last_run_status, last_run_error) VALUES ('t3', ?, 'Webhook Relay', '0 * * * *', ?, 'error', ?)", args: [OASIS, ago(4 * H), '{"error":"HTTP 500"}'] },
    // Events: OASIS error; untenanted legacy 'warning'; OASIS warn; client
    // error (never counted); old OASIS error; OASIS info.
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at) VALUES ('e1', 'CRON_FAILED', 'bravo', 'error', ?, ?)", args: [OASIS, ago(1 * H)] },
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at) VALUES ('e2', 'CLASSIFIER_SLOW', 'inbound_classifier', 'warning', NULL, ?)", args: [ago(2 * H)] },
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at) VALUES ('e3', 'SYNC_PARTIAL', 'maven', 'warn', ?, ?)", args: [OASIS, ago(3 * H)] },
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at, payload) VALUES ('e4', 'CLIENT_ERR', 'bravo', 'error', ?, ?, '{\"note\":\"CLIENT-EVENT-DO-NOT-COUNT\"}')", args: [CLIENT, ago(1 * H)] },
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at) VALUES ('e5', 'OLD_ERR', 'bravo', 'error', ?, ?)", args: [OASIS, ago(30 * H)] },
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at) VALUES ('e6', 'TICK', 'bravo', 'info', ?, ?)", args: [OASIS, ago(1 * H)] },
    // The event bus's top severity (BEA event_bus.py accepts info|warn|error|
    // critical): an untenanted critical counts as an error; a client's never.
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at) VALUES ('e7', 'BRAVO_CLASSIFIER_DEGRADED', 'inbound_classifier', 'critical', NULL, ?)", args: [ago(30 * MIN)] },
    { sql: "INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, published_at, payload) VALUES ('e8', 'CLIENT_CRIT', 'bravo', 'critical', ?, ?, '{\"note\":\"CLIENT-EVENT-DO-NOT-COUNT\"}')", args: [CLIENT, ago(20 * MIN)] },
  ];
  // Sixty cold OASIS leads (more than the 50-row list), five fresh ones, ten cold client leads.
  for (let i = 0; i < 60; i++) {
    stmts.push({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at) VALUES (?, ?, 'lead', ?, ?)", args: [`cold-${i}`, OASIS, JSON.stringify({ company: `Cold Co ${i}` }), ago((20 + i) * 24 * H)] });
  }
  for (let i = 0; i < 5; i++) {
    stmts.push({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at) VALUES (?, ?, 'lead', '{}', ?)", args: [`warm-${i}`, OASIS, ago(1 * 24 * H)] });
  }
  for (let i = 0; i < 10; i++) {
    stmts.push({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at) VALUES (?, ?, 'lead', '{}', ?)", args: [`client-${i}`, CLIENT, ago(40 * 24 * H)] });
  }
  await db.batch(stmts as Array<{ sql: string; args: Array<string | number | null> }>, "write");

  const sh = await import("../lib/admin/system-health");
  const at = await import("../lib/admin/attention");
  console.log("system-health-loader:");

  // ── Pure rules ──────────────────────────────────────────────────────────
  await check("guards: no report is 'Not reported yet' for all five, never off", () => {
    const r = sh.describeGuards(null, NOW);
    assert.equal(r.freshness, "missing");
    assert.deepEqual(r.guards.map((g) => g.key), ["exec_guard", "secret_guard", "state_guard", "coord_guard", "subprocess_guard"]);
    for (const g of r.guards) {
      assert.equal(g.state, "not_reported");
      assert.equal(g.label, "Not reported yet");
    }
  });
  await check("guards: a stale report is 'Not verified since T', even when it said enforce", () => {
    const r = sh.describeGuards({ status: "healthy", last_ping_at: ago(10 * MIN), metadata: JSON.stringify(allOn) }, NOW);
    assert.equal(r.freshness, "stale");
    for (const g of r.guards) {
      assert.equal(g.state, "not_verified");
      assert.match(g.label, /^Not verified since \d{4}-\d{2}-\d{2}T/);
      assert.notEqual(g.label, "Off");
    }
  });
  await check("guards: a fresh report maps enforce/report/off to On / Watching only / Off, with counts", () => {
    const meta = {
      guards: {
        exec_guard: { mode: "enforce", blocked_24h: 9, would_block_24h: 1, last_block_at: ago(2 * H) },
        secret_guard: { mode: "enforce", blocked_24h: "123" },
        state_guard: { mode: "enforce" },
        coord_guard: { mode: "report", blocked_24h: 0 },
        subprocess_guard: { mode: "off" },
      },
    };
    const r = sh.describeGuards({ status: "healthy", last_ping_at: ago(40 * S), metadata: meta }, NOW);
    assert.equal(r.freshness, "fresh");
    assert.deepEqual(r.guards.map((g) => g.label), ["On", "On", "On", "Watching only", "Off"]);
    assert.equal(r.guards[0].blocked24h, 9);
    assert.equal(r.guards[0].wouldBlock24h, 1);
    assert.equal(r.guards[1].blocked24h, 123, "a numeric string is a count");
    assert.equal(r.guards[2].blocked24h, null, "an absent count is unknown, not 0");
  });
  await check("guards: a fresh report missing one guard says that one is not reported; a failing report verifies none", () => {
    const partial = sh.describeGuards({ status: "healthy", last_ping_at: ago(40 * S), metadata: { guards: { exec_guard: { mode: "enforce" } } } }, NOW);
    assert.deepEqual(partial.guards.map((g) => g.state), ["on", "not_reported", "not_reported", "not_reported", "not_reported"]);
    const failing = sh.describeGuards({ status: "down", last_ping_at: ago(40 * S), metadata: allOn }, NOW);
    assert.equal(failing.freshness, "failing");
    assert.ok(failing.guards.every((g) => g.state === "failing"));
  });
  const pc = (lastSeenMsAgo: number) => [{ label: "CCPC (Windows)", lastSeenAt: ago(lastSeenMsAgo), state: at.machineState(ago(lastSeenMsAgo), NOW) }];
  await check("verdict: fresh and all on", () => {
    const guards = sh.describeGuards({ status: "healthy", last_ping_at: ago(40 * S), metadata: allOn }, NOW);
    const v = sh.describeVerdict({ machines: pc(40 * S), guards, now: NOW });
    assert.equal(v.tone, "ok");
    assert.equal(v.text, "Everything is protected. CCPC (Windows) checked in 40 s ago.");
  });
  await check("verdict: stale", () => {
    const guards = sh.describeGuards({ status: "healthy", last_ping_at: ago(3 * H), metadata: allOn }, NOW);
    const v = sh.describeVerdict({ machines: pc(3 * H), guards, now: NOW });
    assert.equal(v.tone, "warn");
    assert.equal(v.text, "Can't verify your guards: CCPC (Windows) last reported them 3 h ago.");
  });
  await check("verdict: missing, and not-enforce", () => {
    const missing = sh.describeVerdict({ machines: pc(40 * S), guards: sh.describeGuards(null, NOW), now: NOW });
    assert.equal(missing.tone, "unknown");
    assert.match(missing.text, /^Your guards aren't reported here yet: they run on your computer/);
    assert.match(missing.text, /CCPC \(Windows\) checked in 40 s ago\.$/);
    const meta = { guards: { ...allOn.guards, coord_guard: { mode: "report" }, subprocess_guard: { mode: "off" } } };
    const partly = sh.describeVerdict({
      machines: pc(40 * S),
      guards: sh.describeGuards({ status: "healthy", last_ping_at: ago(40 * S), metadata: meta }, NOW),
      now: NOW,
    });
    assert.equal(partly.tone, "warn");
    assert.match(partly.text, /^3 of 5 guards are on\. Not fully on: shared-file guard \(watching only\), pop-up guard \(off\)\./);
  });
  await check("verdict: an unreadable computer, none paired, and an offline one", () => {
    assert.match(sh.describeVerdict({ machines: null, guards: null, now: NOW }).text, /^Couldn't check your computer/);
    assert.match(sh.describeVerdict({ machines: [], guards: null, now: NOW }).text, /^No computer is paired/);
    const offline = sh.describeVerdict({ machines: pc(3 * H), guards: sh.describeGuards(null, NOW), now: NOW });
    assert.match(offline.text, /CCPC \(Windows\) last checked in 3 h ago\.$/);
  });
  await check("computer: online under 90 s, idle under 5 min, else offline", () => {
    assert.equal(at.machineState(ago(89 * S), NOW), "online");
    assert.equal(at.machineState(ago(91 * S), NOW), "idle");
    assert.equal(at.machineState(ago(5 * MIN - S), NOW), "idle");
    assert.equal(at.machineState(ago(5 * MIN + S), NOW), "offline");
    assert.equal(at.machineState(null, NOW), "offline");
  });
  await check("attention: 'warning' is 'warn'; each failure gets a what-to-do", () => {
    assert.equal(at.normaliseSeverity("warning"), "warn");
    assert.equal(at.normaliseSeverity(" WARN "), "warn");
    assert.equal(at.normaliseSeverity("error"), "error");
    assert.match(at.whatToDoForCronFailure("ERROR: script_run timed out (600s)"), /time limit/);
    assert.match(at.whatToDoForCronFailure("unknown_action_type: x"), /doesn't know this job's action/);
    assert.match(at.whatToDoForCronFailure("ERROR: script_run exit 1: [full: x.log]"), /stopped with an error/);
    assert.match(at.whatToDoForCronFailure(null), /Open the job in Automations/);
  });

  // ── The loader against the database ────────────────────────────────────
  const probeCloud = async () => sh.describeCloudReach("ok");
  const health = await sh.loadSystemHealth(OASIS, { now: NOW, probeCloud });
  await check("computer: this workspace's unrevoked machines, freshest first", () => {
    assert.deepEqual(health.machines?.map((m) => [m.label, m.state]), [["CCPC (Windows)", "online"], ["Old Mac", "offline"]]);
    assert.equal(health.cloud?.sentence, "The Command Center can reach your computer's bridge right now.");
  });
  await check("guards: the newest report wins over a month-old duplicate", () => {
    assert.equal(health.guards?.freshness, "fresh");
    assert.ok(health.guards?.guards.every((g) => g.state === "on"));
    assert.equal(health.verdict.text, "Everything is protected. CCPC (Windows) checked in 40 s ago.");
  });
  await check("workers: newest row per service; stale is down, stopped-by-you is not; another workspace's ping is not OASIS's", () => {
    const byService = new Map(health.workers?.map((w) => [w.service, w]));
    assert.equal(byService.get("pm2.bravo-scheduler")?.state, "running", "the fresh row beats the month-old 'down' duplicate");
    assert.equal(byService.get("pm2.bravo-ig-dm")?.state, "stale");
    assert.match(byService.get("pm2.bravo-ig-dm")?.sentence ?? "", /^Stopped reporting since \d{4}-/);
    assert.equal(byService.get("pm2.atlas-telegram")?.state, "stopped_by_you");
    assert.equal(byService.get("pm2.maven-telegram")?.state, "no_report");
    assert.equal(health.reporter?.state, "ok");
    assert.equal(health.attention.workersDown, 1);
  });
  await check("cron: this workspace's failures in 24 h, both registries, each with what to do", () => {
    assert.equal(health.cron?.count, 6);
    assert.deepEqual(health.cron?.rows.map((r) => [r.name, r.source]), [
      ["Inbound Email Sweep", "platform"],
      ["Library Post Linker", "platform"],
      ["Post Analytics Sync", "platform"],
      ["Atlas Inbound Email", "workspace"],
      ["Morning Brief", "platform"],
      ["Webhook Relay", "workspace"],
    ]);
    const byName = new Map(health.cron?.rows.map((r) => [r.name, r]));
    assert.match(byName.get("Post Analytics Sync")?.whatToDo ?? "", /time limit/);
    assert.equal(health.attention.cronFailures, 6);
  });
  await check("cron: the same verdict /automations draws: JSON errors, 'failed: N' and the unresolved counter count; 'failed: 0' does not", async () => {
    const { normalizeEmpireRow } = await import("../lib/cron-empire-row");
    const byName = new Map(health.cron?.rows.map((r) => [r.name, r]));
    assert.match(byName.get("Inbound Email Sweep")?.lastResult ?? "", /^reported errors=3/);
    assert.match(byName.get("Inbound Email Sweep")?.whatToDo ?? "", /its own summary reports failures/);
    assert.match(byName.get("Library Post Linker")?.lastResult ?? "", /^reported failed=4/);
    assert.match(byName.get("Morning Brief")?.lastResult ?? "", /^2 unresolved failures\./);
    assert.ok(!byName.has("Healthy Counter"), "a zero counter is not a failure");
    // Parity with /automations: every OASIS platform row that ran in the
    // window is listed here exactly when the shared normaliser calls it error.
    const all = await db.execute({ sql: "SELECT * FROM cron_jobs WHERE tenant_id = ? AND last_run_at >= ?", args: [OASIS, ago(24 * H)] });
    const shaped = all.rows.map((r) => (typeof r.last_result === "string" && r.last_result.startsWith("{") ? { ...r, last_result: JSON.parse(r.last_result) } : r));
    const red = shaped.map((r) => normalizeEmpireRow(r as never)).filter((j) => j.last_run_status === "error").map((j) => j.name).sort();
    const listed = (health.cron?.rows ?? []).filter((r) => r.source === "platform").map((r) => r.name).sort();
    assert.deepEqual(listed, red);
  });
  await check("cron: a workspace error stored as JSON reads as its text, and never throws", () => {
    const relay = health.cron?.rows.find((r) => r.name === "Webhook Relay");
    assert.equal(relay?.lastResult, '{"error":"HTTP 500"}');
    assert.equal(typeof relay?.whatToDo, "string");
    assert.doesNotThrow(() => at.whatToDoForCronFailure({ error: "HTTP 500" }));
    assert.match(at.whatToDoForCronFailure({ error: "timed out after 600s" }), /time limit/);
  });
  await check("events: own or untenanted, inside 24 h; warnings normalised; another workspace's never counted", () => {
    assert.equal(health.events?.warnings, 2);
    assert.deepEqual(
      health.events?.rows.filter((e) => e.severity === "warn" || e.severity === "error").map((e) => [e.id, e.severity]),
      [["e1", "error"], ["e2", "warn"], ["e3", "warn"]],
    );
  });
  await check("events: a critical event is an error (counted, listed, labelled Critical); a client's is not", () => {
    assert.equal(health.events?.errors, 2, "the OASIS error and the untenanted critical");
    assert.deepEqual(health.events?.rows.map((e) => [e.id, e.severity]), [["e7", "critical"], ["e1", "error"], ["e2", "warn"], ["e3", "warn"]]);
    assert.equal(health.attention.errors, 2);
    assert.equal(at.attentionSeverity("CRITICAL"), "critical");
    assert.equal(at.attentionSeverity("warning"), "warn");
  });
  await check("cold leads: COUNT(*) of 60, not the 50-row list", () => {
    assert.equal(health.attention.coldLeads, 60);
  });
  await check("the /operations tiles read the same numbers", async () => {
    const tiles = await at.loadAttentionSummary(OASIS, { now: NOW });
    assert.deepEqual(tiles, health.attention);
    assert.equal(at.nothingNeedsYou(tiles), false);
  });
  await check("a failed read is null, never 0: cron_jobs missing leaves the rest standing", async () => {
    await db.execute("ALTER TABLE cron_jobs RENAME TO cron_jobs_parked");
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      const h = await sh.loadSystemHealth(OASIS, { now: NOW, probeCloud });
      assert.equal(h.cron, null);
      assert.equal(h.attention.cronFailures, null);
      assert.equal(h.attention.errors, 2, "the other reads still answer");
      assert.equal(at.nothingNeedsYou({ ...h.attention, errors: 0, workersDown: 0 }), false, "an unread count is not a zero");
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE cron_jobs_parked RENAME TO cron_jobs");
    }
    assert.ok(logged.some((l) => l.includes("system_health.cron_failures")), "the failure is logged");
  });
  await check("a fleet reporter that can't read the process table makes the down count unknown", async () => {
    await db.execute("UPDATE integrations_health SET status = 'down', metadata = '{\"error\":\"pm2 jlist EPERM\"}' WHERE id = 'w4'");
    try {
      const h = await sh.loadSystemHealth(OASIS, { now: NOW, probeCloud });
      assert.equal(h.reporter?.state, "failing");
      assert.equal(h.attention.workersDown, null);
    } finally {
      await db.execute("UPDATE integrations_health SET status = 'healthy', metadata = '{}' WHERE id = 'w4'");
    }
  });

  // ── The page ────────────────────────────────────────────────────────────
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: CC.id, email: CC.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  const HealthPage = (await import("../app/health/page")).default;
  const out: string[] = [];
  const client: Recorded[] = [];
  await walk(await HealthPage(), out, client);
  const text = out.join(" ").replace(/\s+/g, " ");
  await check("/health: the verdict, the sections and the COUNT tile render", () => {
    assert.match(text, /Everything is protected\. CCPC \(Windows\) checked in \d+ s ago\./);
    for (const section of ["Your computer", "Safety guards", "Background work", "Automation signals", "Integration heartbeats"]) {
      assert.ok(text.includes(section), `missing section: ${section}`);
    }
    assert.match(text, /Cold leads 60 /, "the tile is the count, not the list length");
    assert.match(text, /Showing the 50 oldest of 60/);
    assert.match(text, /What to do: It ran past its time limit/);
    assert.match(text, /Errors today 2 /, "a critical event is in the errors tile");
    assert.match(text, /Critical .{0,40}BRAVO|Critical .{0,80}classifier/i, "the critical event is listed and labelled Critical");
    assert.ok(!text.includes("CLIENT-PC-DO-NOT-LIST") && !text.includes("CLIENT-CRON-DO-NOT-COUNT") && !text.includes("CLIENT-EVENT-DO-NOT-COUNT"));
  });
  await check("/health: no docker, Vercel, state-api, Supabase or 'unauthorized' anywhere on the page", () => {
    assert.doesNotMatch(text, /docker|vercel|state-api|supabase|unauthorized/i);
  });
  const dots = client.filter((c) => c.name === "IntegrationDot");
  await check("/health: no card for a retired provider, even one with a fresh ping", () => {
    const services = dots.map((d) => (d.props.health as { service: string }).service);
    assert.ok(services.includes("cloudflare"), `the live card is drawn (saw ${services.join(", ")})`);
    for (const retired of ["supabase", "vercel", "n8n_inbound"]) assert.ok(!services.includes(retired), `${retired} card drawn`);
  });
  await check("the integration cards, drawn in full React, say Stale / Key on file and name no retired host (tests/system-health.render.ts)", () => {
    const propsFile = join(scratch, "dots.json");
    writeFileSync(propsFile, JSON.stringify(dots.map((d) => d.props)));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/system-health.render.ts", propsFile], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(r.status, 0, `render process failed:\n${r.stderr}\n${r.stdout}`);
    const html = JSON.parse(r.stdout) as { page: string[]; staleHealthy: string; keyOnly: string; healthyNoPing: string; freshHealthy: string; unknownKey: string };
    const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
    assert.match(plain(html.healthyNoPing), /Key on file/);
    assert.doesNotMatch(plain(html.healthyNoPing), /Connected/, "a stored 'healthy' with no check-in is not Connected");
    for (const card of html.page) assert.doesNotMatch(plain(card), /vercel|supabase|docker|state-api/i);
    const cloudflare = html.page.map(plain).find((c) => c.includes("Cloudflare"));
    assert.match(cloudflare ?? "", /Stale/, "a 36-hour-old healthy ping is Stale");
    assert.doesNotMatch(cloudflare ?? "", /Connected/);
    assert.match(plain(html.staleHealthy), /Stale/);
    assert.doesNotMatch(plain(html.staleHealthy), /Connected/);
    assert.match(plain(html.keyOnly), /Key on file/);
    assert.doesNotMatch(plain(html.keyOnly), /Connected/, "a stored key is never Connected");
    assert.match(plain(html.freshHealthy), /Connected/, "a healthy ping inside the day is Connected");
    assert.match(plain(html.unknownKey), /Couldn't check/);
  });

  if (failures > 0) {
    console.error(`system-health-loader: ${failures} failed`);
    process.exit(1);
  }
  console.log("system-health-loader: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
