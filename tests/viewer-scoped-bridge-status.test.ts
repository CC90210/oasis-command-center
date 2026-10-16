/**
 * tests/viewer-scoped-bridge-status.test.ts — O3b, "your engine and your
 * computer's status are yours": with two people's pairings in the SAME
 * workspace and the NEWER one being a non-owner's connector —
 *
 *   - the operator chat's bridge tools and the rail dot (getTenantBridgeStatus
 *     / getBridgeOnline / getOnlineBridgeComputerLabels, lib/queries.ts) stay
 *     scoped to DAEMON pairings only: regression coverage for "Live code to
 *     reuse, not reimplement" — these were already correct before O3b and
 *     must stay that way (a newer connector heartbeat must never make an
 *     offline daemon read as online, nor widen the operator chat's tools);
 *   - /health's machine list and verdict (lib/admin/attention.ts loadMachines,
 *     lib/admin/system-health.ts loadSystemHealth) describe CCPC to CC and
 *     the connector to its own person, never whichever pairing is newest;
 *   - the fleet reporter and background workers (describeBackground) show
 *     only for the agents owner (CC), never for a non-owner viewer (Adon);
 *   - the Devices app lines' truthfulness rule (signed in is never "ready"),
 *     in the shared words that replaced departmentInventoryLine (CC 2026-10-16).
 *
 * Run: node --conditions=react-server --import tsx tests/viewer-scoped-bridge-status.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "viewer-bridge-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "viewer-bridge-test-secret-long-enough-00000001";
process.env.EMPIRE_AUTH_BACKEND = "turso";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) {
  delete process.env[k];
}

const db: Client = createClient({ url: `file:${dbFile}` });
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CC = "auth-cc-0001";
const ADON = "auth-adon-0001";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE workspace_agents_owner (tenant_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL,
      set_by TEXT NOT NULL, set_at TEXT NOT NULL, note TEXT, revoked_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT,
      claim_enabled_at TEXT, claim_enabled_by TEXT, claude_account_hash TEXT,
      claim_state_at TEXT, claim_capacity INTEGER, claim_in_flight INTEGER, claim_blocked_reason TEXT,
      last_claim_ip TEXT, previous_token_hash TEXT, token_rotated_at TEXT, last_poll_ok_at TEXT);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      profile_id TEXT, service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, schedule TEXT,
      action_type TEXT, owner_agent_key TEXT, last_run_at TEXT, last_result TEXT, fail_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);
    CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT,
      name TEXT, schedule TEXT, last_run_at TEXT, last_run_status TEXT, last_run_error TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT,
      severity TEXT, publisher_agent TEXT, payload TEXT, correlation_id TEXT, published_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      entity_type TEXT, data TEXT, created_at TEXT, updated_at TEXT);
  `);
}

async function seed() {
  for (const t of ["tenants", "workspace_agents_owner", "bridge_pairings", "integrations_health", "cron_jobs", "tenant_cron_jobs", "agent_events", "tenant_records"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis', 'OASIS')", args: [OASIS] });
  await db.execute({
    sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'ops', ?)",
    args: [OASIS, CC, new Date().toISOString()],
  });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await seed();
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 10).join("\n        ")}`);
  }
}

async function main() {
  await createSchema();
  const { getTenantBridgeStatus, getBridgeOnline, getOnlineBridgeComputerLabels } = await import("../lib/queries");
  const { loadMachines, describeBackground } = await import("../lib/admin/attention");
  const { loadSystemHealth } = await import("../lib/admin/system-health");
  const cliStatus = await import("../lib/bridge-cli-status");
  const { appStatusLines } = await import("../components/settings/YourComputersCard");
  const { getServiceSupabase } = await import("../lib/supabase-server");

  console.log("viewer-scoped-bridge-status:");

  const now = new Date();
  const fresh = now.toISOString();
  const stale = new Date(now.getTime() - 60 * 60_000).toISOString(); // 1h ago, well offline

  async function pair(id: string, userId: string, label: string, scope: "daemon" | "connector", lastSeenAt: string) {
    await db.execute({
      sql: "INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [id, OASIS, userId, label, `tok-${id}`, scope, lastSeenAt],
    });
  }

  // ── Regression: daemon-only readers never move for a newer connector ────
  await check("getTenantBridgeStatus/getBridgeOnline: CC's daemon offline stays offline even with Adon's connector online and newer", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", stale);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", fresh);
    const status = await getTenantBridgeStatus(OASIS);
    assert.equal(status.online, false, "a connector's heartbeat never stands in for the daemon's");
    assert.equal(await getBridgeOnline(OASIS), false);
  });

  await check("getTenantBridgeStatus/getBridgeOnline: CC's daemon online reads online regardless of Adon's connector", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", fresh);
    assert.equal((await getTenantBridgeStatus(OASIS)).online, true);
    assert.equal(await getBridgeOnline(OASIS), true);
  });

  await check("getOnlineBridgeComputerLabels: lists only the online DAEMON, never Adon's connector, with or without an authUserId filter", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", fresh);
    assert.deepEqual(await getOnlineBridgeComputerLabels(OASIS), ["CCPC (Windows)"]);
    assert.deepEqual(await getOnlineBridgeComputerLabels(OASIS, ADON), [], "Adon's own pairing is a connector, not a daemon, so it names nothing here");
  });

  // ── loadMachines (lib/admin/attention.ts): viewer-scoped ────────────────
  await check("loadMachines with no authUserId: every pairing in the tenant (pre-O3b behaviour, unchanged)", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", stale);
    const db2 = getServiceSupabase();
    const machines = await loadMachines(db2, OASIS, now.getTime());
    assert.deepEqual(machines.map((m) => m.label).sort(), ["CCPC (Windows)", "UPPAECHELON (Windows)"]);
  });

  await check("loadMachines(authUserId): CC sees only CCPC, Adon sees only his own — never the other's, never 'whichever is newest'", async () => {
    // Adon's connector is NEWER (fresher last_seen_at) than CC's daemon — the
    // bug this proves fixed: the old tenant-wide "pick [0]" pulled whichever
    // pairing was newest, which in OASIS's shared workspace was never Adon's.
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", stale);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", fresh);
    const db2 = getServiceSupabase();
    const ccMachines = await loadMachines(db2, OASIS, now.getTime(), { authUserId: CC, isAgentsOwner: true });
    assert.deepEqual(ccMachines.map((m) => m.label), ["CCPC (Windows)"]);
    const adonMachines = await loadMachines(db2, OASIS, now.getTime(), { authUserId: ADON, isAgentsOwner: false });
    assert.deepEqual(adonMachines.map((m) => m.label), ["UPPAECHELON (Windows)"]);
  });

  await check("loadMachines(viewer): a LEGACY pairing with no recorded owner (predates O0) still shows to every viewer, unchanged", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    await db.execute({
      sql: "INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, last_seen_at) VALUES ('bp-legacy', ?, NULL, 'Old legacy box', 'tok-legacy', ?)",
      args: [OASIS, fresh],
    });
    const db2 = getServiceSupabase();
    const adonMachines = await loadMachines(db2, OASIS, now.getTime(), { authUserId: ADON, isAgentsOwner: false });
    assert.deepEqual(adonMachines.map((m) => m.label).sort(), ["Old legacy box"], "Adon sees the ownerless legacy row, but never CC's explicitly-owned CCPC");
  });

  // ── /health: machines + verdict describe the VIEWER's own computer ──────
  await check("loadSystemHealth({viewer}): CC's machine card names CCPC, Adon's names his own connector", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", fresh);
    const ccHealth = await loadSystemHealth(OASIS, { now: now.getTime(), viewer: { authUserId: CC, isAgentsOwner: true } });
    assert.deepEqual(ccHealth.machines?.map((m) => m.label), ["CCPC (Windows)"]);
    const adonHealth = await loadSystemHealth(OASIS, { now: now.getTime(), viewer: { authUserId: ADON, isAgentsOwner: false } });
    assert.deepEqual(adonHealth.machines?.map((m) => m.label), ["UPPAECHELON (Windows)"]);
  });

  await check("loadSystemHealth with no viewer (omitted): the pre-O3b behaviour, every pairing shows", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    await pair("bp-adon", ADON, "UPPAECHELON (Windows)", "connector", fresh);
    const health = await loadSystemHealth(OASIS, { now: now.getTime() });
    assert.equal(health.machines?.length, 2);
  });

  // ── Fleet reporter / background workers: agents owner only ──────────────
  await check("describeBackground(viewer): CC (the agents owner) sees the workers list; Adon (not the owner) sees none, not 'unknown'", () => {
    const workerRows = new Map();
    const machines = [{ label: "CCPC (Windows)", lastSeenAt: fresh, state: "online" as const }];
    const forCC = describeBackground(workerRows, machines, now.getTime(), { authUserId: CC, isAgentsOwner: true });
    assert.ok(Array.isArray(forCC.workers) && forCC.workers.length > 0);
    const forAdon = describeBackground(workerRows, machines, now.getTime(), { authUserId: ADON, isAgentsOwner: false });
    assert.deepEqual(forAdon, { workers: [], reporter: null, workersDown: 0 }, "not the agents owner's question to ask — zero known problems, never 'unknown'");
  });

  await check("loadSystemHealth threads the viewer into describeBackground: Adon's /health shows no House-worker rows", async () => {
    await pair("bp-cc", CC, "CCPC (Windows)", "daemon", fresh);
    const adonHealth = await loadSystemHealth(OASIS, { now: now.getTime(), viewer: { authUserId: ADON, isAgentsOwner: false } });
    assert.deepEqual(adonHealth.workers, []);
    assert.equal(adonHealth.attention.workersDown, 0);
  });

  // ── Inventory wording (truthfulness rule) ──────────────────────────────
  // CC 2026-10-16: Devices' own inventory words (departmentInventoryLine) are
  // retired; its app lines read AI brain's per-app label for the same device
  // (YourComputersCard appStatusLines). The rule they kept still holds there:
  // signed in is never "ready"; only a real probe on that computer is.
  await check("Devices app lines: signed in reads Needs test, readiness belongs to a real probe", () => {
    const runtime = (over: Record<string, unknown>) => ({
      installed: false, signedIn: false, executionReady: false, unsupported: false, version: null, lastTestedAt: null, code: null, ...over,
    });
    const device = (runtimes: Record<string, unknown>) => ({
      pairingId: "bp-cc", label: "CCPC (Windows)", ownerName: null, ownedByViewer: true, workspaceEligible: true, agentClaimEligible: true,
      os: "windows", lastSeenAt: fresh, approved: true, online: true, busy: false,
      protocols: ["runtime_action_v1", "department_task_v2", "coding_harness_task_v1"], localModels: [],
      runtimes: { claude: runtime({}), codex: runtime({}), gemini: runtime({}), ...runtimes },
    }) as unknown as Parameters<typeof appStatusLines>[0];
    assert.deepEqual(
      appStatusLines(device({ claude: runtime({ installed: true, signedIn: true }), codex: runtime({ installed: true }) }), true),
      ["Claude Code: Needs test", "Codex: Sign-in needed"],
    );
    assert.deepEqual(appStatusLines(device({ claude: runtime({ installed: true, signedIn: true, executionReady: true }) }), true), ["Claude Code: Ready for agents"]);
    assert.deepEqual(appStatusLines(device({}), true), [], "an app the computer does not have is not listed");
    assert.equal("departmentInventoryLine" in cliStatus, false, "the second vocabulary is gone");
  });

  if (failures > 0) {
    console.log(`viewer-scoped-bridge-status: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("viewer-scoped-bridge-status: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
