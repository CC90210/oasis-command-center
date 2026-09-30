/**
 * queries-fail-loud.test.ts — a failed read in lib/queries.ts reaches its
 * caller as an error, never as empty data (OASIS OS plan F1.5, 2026-09-29).
 *
 * WHY. A 2026-09-29 scan found exported reads in lib/queries.ts that ignored
 * the read's `.error`, so a failed query came back as [] / 0 / "offline" and
 * the page drew "No decisions yet", "worker not running", "Computer not
 * connected yet", every AI provider "Not connected", 0 won / 0 lost. PR #477
 * fixed integrationsHealth that way (tests/integrations-health-read.test.ts);
 * this is the same fix for the rest, driven against a real local libSQL file:
 * a missing table must throw, naming the table, and a healthy one must still
 * return the tenant's rows and nobody else's.
 *
 * It also pins the reads that were DELETED because nothing called them, the
 * two lib callers that turn the throw into an explicit unknown (shell status,
 * setup readiness), and a source guard: every exported read that calls
 * `.from(` must look at its error.
 *
 * Run: node --conditions=react-server --import tsx tests/queries-fail-loud.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "queries-fail-loud-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const A = "tenant-a";
const B = "tenant-b";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function main() {
  const q = await import("../lib/queries");
  const { getShellStatus } = await import("../lib/shell-status");
  const { loadReadinessReport } = await import("../lib/setup-readiness");
  const db = createClient({ url: `file:${dbFile}` });
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  console.log("queries-fail-loud:");

  // ── 1. No table: every read fails, naming the table, never the params ────
  const missing: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["getTenantBridgeStatus", () => q.getTenantBridgeStatus(A), /bridge_pairings read failed/],
    ["getBridgeOnline", () => q.getBridgeOnline(A), /bridge_pairings read failed/],
    ["getBridgeToolCapabilities", () => q.getBridgeToolCapabilities(A), /bridge_pairings read failed/],
    ["pipelineBreakdown", () => q.pipelineBreakdown(A), /tenant_records read failed/],
    ["recentDecisions", () => q.recentDecisions(A, ["bravo"]), /agent_decisions read failed/],
    ["agentStates", () => q.agentStates(["bravo"]), /agent_state_snapshot read failed/],
    ["recentEvents", () => q.recentEvents(10, { tenantId: A, agentNames: ["bravo"] }), /agent_events read failed/],
    ["recentActions", () => q.recentActions(A), /agent_events read failed/],
    ["aiServicesWithKey", () => q.aiServicesWithKey(A), /agent_model_config read failed/],
  ];
  for (const [name, run, pattern] of missing) {
    await check(`${name}: a failed read throws, naming the table`, async () => {
      await assert.rejects(run, (err: Error) => {
        assert.match(err.message, pattern);
        assert.ok(!err.message.includes(A), `the tenant id leaked into the error: ${err.message}`);
        return true;
      });
    });
  }

  // The guards that answer before any read still answer, and still do not read.
  await check("no tenant / no agents: the early answers stand without a read", async () => {
    assert.deepEqual(await q.getTenantBridgeStatus(null), { online: false, tools: null });
    assert.equal(await q.getBridgeOnline(null), false);
    assert.deepEqual(await q.recentDecisions(null, ["bravo"]), []);
    assert.deepEqual(await q.recentDecisions(A, []), []);
    assert.deepEqual(await q.agentStates([]), []);
    assert.deepEqual(await q.recentEvents(10, { tenantId: null, agentNames: ["bravo"] }), []);
    assert.equal((await q.aiServicesWithKey(null)).size, 0);
  });

  // The lib callers turn the throw into an explicit unknown, not a default.
  await check("getShellStatus: an unreadable bridge is null (\"couldn't check\"), not offline", async () => {
    const status = await getShellStatus("bravo", A);
    assert.equal(status.bridgeOnline, null);
  });
  await check("loadReadinessReport: an unreadable key store is \"Couldn't check\", not \"No AI provider key\"", async () => {
    const report = await loadReadinessReport({ tenantId: A, authUserId: null, isOwnerOrAdmin: true });
    const ai = report.tenant?.find((i) => i.key === "tenant.ai_provider");
    assert.ok(ai, JSON.stringify(report.tenant));
    assert.equal(ai.status, "info");
    assert.match(ai.detail, /Couldn't check/);
    assert.doesNotMatch(ai.detail, /No AI provider key/);
  });

  // ── 2. Healthy tables: each read returns its tenant's rows only ───────────
  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, label TEXT, user_id TEXT,
      last_seen_at TEXT, revoked_at TEXT, tool_capabilities TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_decisions (id TEXT PRIMARY KEY, tenant_id TEXT, agent_name TEXT, tick_id TEXT,
      decision_type TEXT, target_description TEXT, created_at TEXT);
    CREATE TABLE agent_state_snapshot (agent_name TEXT PRIMARY KEY, tick_count INTEGER, last_tick_at TEXT,
      last_tick_id TEXT, health_status TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT, source_agent TEXT,
      correlation_id TEXT, severity TEXT, payload TEXT, published_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, provider TEXT,
      encrypted_api_key TEXT, enabled INTEGER, user_id TEXT);
  `);
  await db.batch(
    [
      { sql: "INSERT INTO bridge_pairings VALUES ('p-a', ?, 'CC laptop', 'u1', ?, NULL, '[\"read_file\"]')", args: [A, now] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-b', ?, 'old box', 'u2', ?, NULL, '[]')", args: [B, hourAgo] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-b2', ?, 'revoked', 'u2', ?, ?, '[]')", args: [B, now, now] },
      { sql: "INSERT INTO tenant_records VALUES ('l1', ?, 'lead', '{\"stage\":\"won\",\"source\":\"referral\"}', ?, ?)", args: [A, now, now] },
      { sql: "INSERT INTO tenant_records VALUES ('l2', ?, 'lead', '{\"stage\":\"lost\",\"source\":\"web\"}', ?, ?)", args: [A, now, now] },
      { sql: "INSERT INTO tenant_records VALUES ('l3', ?, 'lead', '{\"stage\":\"won\",\"source\":\"web\"}', ?, ?)", args: [B, now, now] },
      { sql: "INSERT INTO agent_decisions VALUES ('d1', ?, 'bravo', 't1', 'send', 'Acme', ?)", args: [A, now] },
      { sql: "INSERT INTO agent_decisions VALUES ('d2', ?, 'bravo', 't2', 'send', 'Other tenant', ?)", args: [B, now] },
      { sql: "INSERT INTO agent_state_snapshot VALUES ('bravo', 7, ?, 't1', 'healthy')", args: [now] },
      { sql: "INSERT INTO agent_events VALUES ('e1', 'dashboard_action', 'bravo', 'bravo', ?, 'info', '{}', ?)", args: [A, now] },
      { sql: "INSERT INTO agent_events VALUES ('e2', 'dashboard_action', 'bravo', 'bravo', ?, 'info', '{}', ?)", args: [B, now] },
      { sql: "INSERT INTO agent_model_config VALUES ('m1', ?, 'anthropic', 'enc', 1, NULL)", args: [A] },
      { sql: "INSERT INTO agent_model_config VALUES ('m2', ?, 'openrouter', 'enc', 1, 'someone-else')", args: [A] },
      { sql: "INSERT INTO agent_model_config VALUES ('m3', ?, 'openai', 'enc', 1, NULL)", args: [B] },
    ],
    "write",
  );

  await check("bridge status: A's fresh pairing is online with its tools; B's stale one is offline", async () => {
    assert.deepEqual(await q.getTenantBridgeStatus(A), { online: true, tools: ["read_file"] });
    assert.equal(await q.getBridgeOnline(A), true);
    assert.deepEqual(await q.getBridgeToolCapabilities(A), { online: true, tools: ["read_file"] });
    assert.equal(await q.getBridgeOnline(B), false, "B's only fresh pairing is revoked");
    assert.equal((await getShellStatus("bravo", A)).bridgeOnline, true);
  });
  await check("pipelineBreakdown: A's funnel only", async () => {
    const p = await q.pipelineBreakdown(A);
    assert.equal(p.total, 2);
    assert.deepEqual(p.stages, { won: 1, lost: 1 });
    assert.deepEqual(p.sources, { referral: 1, web: 1 });
  });
  await check("recentDecisions / recentEvents / recentActions: A's rows only", async () => {
    assert.deepEqual((await q.recentDecisions(A, ["bravo"])).map((d) => d.id), ["d1"]);
    assert.deepEqual((await q.recentEvents(10, { tenantId: A, agentNames: ["bravo"], sinceDays: 0 })).map((e) => e.id), ["e1"]);
    assert.deepEqual((await q.recentActions(A)).map((e) => e.id), ["e1"]);
  });
  await check("agentStates: the enabled agent's heartbeat", async () => {
    const rows = await q.agentStates(["bravo"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tick_count, 7);
  });
  await check("aiServicesWithKey: A's workspace key only, not a teammate's personal key, not B's", async () => {
    const set = await q.aiServicesWithKey(A);
    assert.deepEqual([...set], [q.PROVIDER_TO_SERVICE.anthropic]);
  });
  await check("loadReadinessReport: a readable key store reports the key", async () => {
    const report = await loadReadinessReport({ tenantId: A, authUserId: null, isOwnerOrAdmin: true });
    const ai = report.tenant?.find((i) => i.key === "tenant.ai_provider");
    assert.equal(ai?.status, "ok", JSON.stringify(ai));
  });

  // ── 3. Reads nothing called are gone, not left to lie to a future caller ──
  await check("reads with no caller were deleted", () => {
    const gone = [
      "getTenantBridgeOwner", "getTodayPlan", "getPlanTemplates", "getLeadById", "todayCounts",
      "recentOutbound", "channelUtilization", "outreachReplyRate", "activePipeline", "topOpenLead",
      "getApplicationsCount", "mrrHistory", "mrrSnapshot",
    ];
    for (const name of gone) assert.equal(name in q, false, `${name} is still exported`);
  });

  // ── 4. Source guard: an exported read that queries must look at its error ─
  await check("every exported read in lib/queries.ts that calls .from( checks the read's error", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "queries.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const starts = [...src.matchAll(/^export (?:async function|const) (\w+)/gm)];
    assert.ok(starts.length > 10, "the scan found the exports");
    const unchecked: string[] = [];
    starts.forEach((m, i) => {
      const body = src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length);
      if (body.includes(".from(") && !/\berror\b/.test(body)) unchecked.push(m[1]);
    });
    assert.deepEqual(unchecked, [], `reads that never look at their error: ${unchecked.join(", ")}`);
  });

  if (failures > 0) {
    console.error(`queries-fail-loud: ${failures} failed`);
    process.exit(1);
  }
  console.log("queries-fail-loud: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
