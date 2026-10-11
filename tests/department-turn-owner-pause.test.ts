/**
 * department-turn-owner-pause.test.ts — O1: PAUSE, NOT FALLBACK (Adon).
 *
 * When the bridge gate refuses a department turn because the person is not
 * the workspace's agents owner (lib/agents-owner.ts), prepareAgentTurn
 * (lib/os/department-agent.ts) must answer with its own refusal — never the
 * workspace key, never the platform key, never a model call, never a record
 * on the channel's shared last-turn row (agent_turn_outcomes). The design
 * doc's first draft had this falling back to a key labelled "your computer
 * is not connected yet"; Adon rejected that explicitly: no fallback, pause
 * with a clear message instead.
 *
 * WHAT IS PINNED:
 *   - bridgeResolutionForSession (lib/ai/bridge-turn.ts) maps all three new
 *     authorizeBridgeRequest codes to { refused: <code> }, never null (which
 *     would mean "fall back by design") and never BridgeUnavailable (which
 *     would mean "a real outage, fall back and say so");
 *   - prepareAgentTurn, given a refused resolution: returns 409
 *     computer_not_yours with no recordAs, decrypts no key (proved by a
 *     deliberately broken saved key that would otherwise surface as
 *     key_unreadable), ignores a platformFallback that is otherwise valid
 *     (proved by it not being used), and writes NO ai_usage_events row;
 *   - the owner path (a real BridgeCaller resolution) is unchanged;
 *   - lib/os/runs/session.ts resolveRunSession intercepts the SAME refusal
 *     before sendMessage/executeRun ever run, so a non-owner's message never
 *     becomes a queued run row at all (source-pinned: the full live-DB path
 *     through resolveRunSession is exercised in tests/ai-engine.test.ts-style
 *     fixtures elsewhere; this file pins the ordering in source since
 *     reproducing that whole harness here would test lib/os/runs/send.ts's
 *     behavior, not O1's).
 *
 * Run: node --conditions=react-server --import tsx tests/department-turn-owner-pause.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "department-turn-owner-pause-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "department-turn-owner-pause-secret-long-enough-01";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "department-turn-owner-pause-field-key-long-enough1";
process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = "bearer-oasis-test";
delete process.env.OPERATOR_EMAIL;
delete process.env.ADMIN_EMAILS;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const BRIDGE = "https://bridge.oasis.test";
const CC = { id: "0b000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT, updated_at TEXT,
      deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (slug TEXT PRIMARY KEY, name TEXT, category TEXT, short_description TEXT, description TEXT,
      base_prompt TEXT, required_tools TEXT, suggested_model TEXT, pricing TEXT, is_public INTEGER,
      is_oasis_managed INTEGER, created_by TEXT, tenant_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      encrypted_api_key TEXT, system_prompt_override TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      user_id TEXT, display_name_override TEXT);
    CREATE UNIQUE INDEX idx_agent_model_config_default_per_agent ON agent_model_config (tenant_id, agent_key) WHERE (user_id IS NULL);
    CREATE UNIQUE INDEX idx_agent_model_config_override_per_user ON agent_model_config (tenant_id, user_id, agent_key) WHERE (user_id IS NOT NULL);
  `);
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__192_ai_usage.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__191_agent_turn_outcomes.sql"), "utf8"));

  const { encryptField } = await import("../lib/field-encryption");
  const stamp = "2026-10-10T00:00:00Z";
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', ?)", args: [OASIS, JSON.stringify({ bridge_url: BRIDGE })] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, agents_enabled, updated_at)
              VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, 'CC', '["sdr"]', ?)`,
        args: [CC.id, CC.email, OASIS, stamp, stamp],
      },
      // OASIS's workspace AI account: a VALID key, so any route to it (the
      // refusal must never take) would otherwise succeed and be mistaken for
      // "it also happened to refuse for some other reason".
      { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)", args: [OASIS, encryptField("sk-ant-should-never-be-read-0001"), stamp] },
    ],
    "write",
  );

  const { prepareAgentTurn } = await import("../lib/os/department-agent");
  const { departmentBySlug } = await import("../lib/os/departments");
  const bridgeTurn = await import("../lib/ai/bridge-turn");
  const { saveAgentEngine } = await import("../lib/ai/agent-engine-store");
  await saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
  const sales = departmentBySlug("sales")!;
  const ccCaller = { target: { baseUrl: BRIDGE, bearerToken: "bearer-oasis-test" }, tenantId: OASIS, userId: CC.id, teamRole: "owner" };

  const usageRows = async () => (await db.execute("SELECT * FROM ai_usage_events")).rows;
  const outcomeRows = async () => (await db.execute("SELECT * FROM agent_turn_outcomes")).rows;

  // A platformFallback that would be perfectly usable if the refusal ever
  // fell through to it — proof that it never is.
  const unmistakableFallback = { provider: "anthropic" as const, model: "claude-opus-4", apiKey: "sk-PLATFORM-KEY-MUST-NEVER-BE-USED" };

  const nonOwnerTurn = (bridge: (() => Promise<unknown>) | null) =>
    prepareAgentTurn({
      tenantId: OASIS,
      tenantSlug: "oasis-ai-cc",
      agentSlug: "sdr",
      department: sales,
      operator: { name: "Adon", email: "adon@oasisai.work" },
      platformFallback: unmistakableFallback,
      revealModel: true,
      userId: "adon-auth-id",
      bridge: bridge as never,
    });

  console.log("department-turn-owner-pause:");

  await check("bridgeResolutionForSession maps all three O1 gate codes to {refused}, never null or BridgeUnavailable", async () => {
    const via = (error: string) => bridgeTurn.bridgeResolutionForSession(OASIS, (async () => ({ ok: false, status: 403, error })) as never);
    assert.deepEqual(await via("not_your_computer"), { refused: "not_your_computer" });
    assert.deepEqual(await via("agents_owner_not_set"), { refused: "agents_owner_not_set" });
    assert.deepEqual(await via("agents_owner_unavailable"), { refused: "agents_owner_unavailable" });
    // Unchanged from before O1: a DIFFERENT refusal is still "no by design" (null).
    assert.equal(await via("bridge_not_enabled_for_tenant"), null);
  });

  for (const reason of ["not_your_computer", "agents_owner_not_set", "agents_owner_unavailable"] as const) {
    await check(`prepareAgentTurn: a non-owner refused as ${reason} gets the pause refusal, no key, no platform fallback, no usage row`, async () => {
      await db.execute("DELETE FROM ai_usage_events");
      await db.execute("DELETE FROM agent_turn_outcomes");
      const refused = await nonOwnerTurn(async () => ({ refused: reason }));
      assert.ok(!refused.ok, JSON.stringify(refused));
      if (refused.ok) return;
      assert.equal(refused.status, 409);
      assert.equal(refused.error, "computer_not_yours");
      assert.equal(refused.recordAs, undefined, "never a verdict on the workspace's AI account");
      assert.match(String((refused.extra as { hint?: string })?.hint), /Nothing was sent/);
      assert.doesNotMatch(String((refused.extra as { hint?: string })?.hint), /—/, "no em dash in client-facing copy");
      assert.equal((await usageRows()).length, 0, "no ai_usage_events row: never counted toward the department-chat failure-rate alert");
      assert.equal((await outcomeRows()).length, 0, "no agent_turn_outcomes row: never turns the shared department header red for the owner");
    });
  }

  await check("the refusal is returned even when the saved workspace key is broken AND the platform key is valid (proves neither was ever reached)", async () => {
    await db.execute("UPDATE agent_model_config SET encrypted_api_key = 'not-a-cipher' WHERE tenant_id = ? AND agent_key = 'bravo'", [OASIS]);
    try {
      const refused = await nonOwnerTurn(async () => ({ refused: "not_your_computer" }));
      assert.ok(!refused.ok && refused.error === "computer_not_yours", JSON.stringify(refused));
    } finally {
      await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = ? WHERE tenant_id = ? AND agent_key = 'bravo'", args: [(await import("../lib/field-encryption")).encryptField("sk-ant-should-never-be-read-0001"), OASIS] });
    }
  });

  await check("a gate that answers null (no by design, unrelated to O1) still falls back to the API account as before", async () => {
    const prepared = await nonOwnerTurn(async () => null);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.turn.engine.kind, "api");
    assert.equal(prepared.turn.engine.notUsedFor, "Codex on your paired computer");
  });

  await check("the owner path is unchanged: a real BridgeCaller resolution still runs on the paired computer, no key, no platform fallback", async () => {
    const prepared = await nonOwnerTurn(async () => ccCaller);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok || prepared.turn.engine.kind === "api") return assert.fail("not a bridge turn");
    assert.equal(prepared.turn.apiKey, "");
    assert.equal(prepared.turn.engine.spend, "cli_subscription");
  });

  await check("source: lib/os/runs/session.ts intercepts a BridgeRefused BEFORE returning ok:true (so sendMessage, which saves/queues the run, is never reached)", () => {
    const src = readFileSync(join(ROOT, "lib/os/runs/session.ts"), "utf8");
    const refusedAt = src.indexOf('"refused" in bridge');
    const okTrueAt = src.indexOf("ok: true,");
    assert.ok(refusedAt > 0, "resolveRunSession must check the bridge resolution for a BridgeRefused");
    assert.ok(okTrueAt > 0 && refusedAt < okTrueAt, "the refused check must come before the ok:true session is returned");
    assert.match(src, /status: 409, error: "computer_not_yours"/);
    const route = readFileSync(join(ROOT, "app/api/os/runs/route.ts"), "utf8");
    assert.ok(
      route.indexOf("resolveRunSession(") < route.indexOf("sendMessage("),
      "the route must resolve the session (and so this refusal) BEFORE sendMessage can save/queue a run",
    );
  });

  if (failures > 0) {
    console.log(`department-turn-owner-pause: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("department-turn-owner-pause: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
