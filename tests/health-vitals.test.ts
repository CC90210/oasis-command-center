/**
 * tests/health-vitals.test.ts - System health's Platform vitals (2026-10-28).
 *
 * Pinned:
 *   1. the Worker tile: "not connected" (with what to add) until a read-only analytics token AND the
 *      account id exist; a live answer is parsed (CPU quantiles are microseconds); an HTTP or GraphQL
 *      error is a failed read, never a zero; the deploy token is never used;
 *   2. the database round trip, AI calls (count, failed, median latency), browser errors and health-check
 *      runs, on real libSQL: tenant-scoped, last 24 hours only, "no data yet" instead of a made-up zero
 *      where nothing ran, and one missing table fails only its own tile.
 *
 * Run: node --conditions=react-server --import tsx tests/health-vitals.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "health-vitals-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "CLOUDFLARE_ANALYTICS_TOKEN"]) delete process.env[k];

const db = createClient({ url: `file:${dbFile}` });
const T = "tenant-a";
const OTHER = "tenant-b";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main(): Promise<void> {
  const vitals = await import("../lib/admin/platform-vitals");
  type Fetch = typeof fetch;
  const answer = (status: number, body: unknown): Fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as Fetch;
  const env = { CLOUDFLARE_ANALYTICS_TOKEN: "read-only", CLOUDFLARE_ACCOUNT_ID: "acct" };

  await check("Worker: not connected until both the read-only token and the account id exist", async () => {
    for (const e of [{}, { CLOUDFLARE_ANALYTICS_TOKEN: "x" }, { CLOUDFLARE_ACCOUNT_ID: "acct" }, { CLOUDFLARE_API_TOKEN: "deploy", CLOUDFLARE_ACCOUNT_ID: "acct" }]) {
      const v = await vitals.workerVitals(NOW, e, answer(200, {}));
      assert.equal(v.state, "not_connected", JSON.stringify(e));
      assert.match((v as { reason: string }).reason, /read-only Cloudflare Analytics token/);
    }
  });

  await check("Worker: a live answer is parsed, CPU from microseconds to milliseconds", async () => {
    let sent: { url: string; auth: string; body: { variables: Record<string, string> } } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, auth: String((init.headers as Record<string, string>).authorization), body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 105654, errors: 3 }, quantiles: { cpuTimeP50: 16758, cpuTimeP99: 425987 } }] }] } }, errors: null }), { status: 200 });
    }) as unknown as Fetch;
    const v = await vitals.workerVitals(NOW, env, fetchImpl);
    assert.deepEqual(v, { state: "live", value: { requests: 105654, errors: 3, cpuP50Ms: 16.8, cpuP99Ms: 426 } });
    assert.equal(sent!.url, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(sent!.auth, "Bearer read-only");
    assert.deepEqual(sent!.body.variables, { accountTag: "acct", from: "2026-10-27T12:00:00Z", to: "2026-10-28T12:00:00Z", script: "oasis-command-center" });
  });

  await check("Worker: an HTTP or GraphQL error is a failed read; an empty answer is no data", async () => {
    assert.equal((await vitals.workerVitals(NOW, env, answer(403, {}))).state, "error");
    assert.equal((await vitals.workerVitals(NOW, env, answer(200, { errors: [{ message: "denied" }] }))).state, "error");
    assert.equal((await vitals.workerVitals(NOW, env, answer(200, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }))).state, "no_data");
  });

  await db.executeMultiple(`
    CREATE TABLE ai_usage_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, outcome TEXT NOT NULL, latency_ms INTEGER);
    CREATE TABLE client_error_reports (id TEXT PRIMARY KEY, tenant_id TEXT, created_at TEXT NOT NULL);
  `);
  const rows = [
    ["a1", T, hoursAgo(1), "ok", 900],
    ["a2", T, hoursAgo(2), "ok", 1200],
    ["a3", T, hoursAgo(3), "provider_error", 300],
    ["a4", T, hoursAgo(30), "ok", 99999],
    ["a5", OTHER, hoursAgo(1), "ok", 5],
  ];
  for (const r of rows) await db.execute({ sql: "INSERT INTO ai_usage_events VALUES (?, ?, ?, ?, ?)", args: r });
  for (const [id, tenant, at] of [["e1", T, hoursAgo(2)], ["e2", T, hoursAgo(25)], ["e3", OTHER, hoursAgo(1)]]) {
    await db.execute({ sql: "INSERT INTO client_error_reports VALUES (?, ?, ?)", args: [id, tenant, at] });
  }

  await check("the strip: tenant-scoped, 24 hours, and one missing table fails only its own tile", async () => {
    const v = await vitals.loadPlatformVitals(T, NOW);
    assert.equal(v.databaseMs.state, "live");
    assert.deepEqual(v.ai24h, { state: "live", value: { calls: 3, failed: 1, p50Ms: 900 } }, "the 30-hour-old call and the other workspace's are not counted");
    assert.deepEqual(v.browserErrors24h, { state: "live", value: 1 });
    assert.equal(v.checks24h.state, "error", "health_check_runs is missing here: that tile fails, the rest stand");
    assert.equal(v.worker24h.state, "not_connected");
  });

  await check("no data yet, never a made-up zero, where nothing ran", async () => {
    await db.executeMultiple(`
      CREATE TABLE health_check_runs (id TEXT PRIMARY KEY, tenant_id TEXT, check_id TEXT NOT NULL, surface TEXT NOT NULL, verdict TEXT NOT NULL, ran_at TEXT NOT NULL);
    `);
    const quiet = await vitals.loadPlatformVitals("tenant-quiet", NOW);
    assert.equal(quiet.ai24h.state, "no_data");
    assert.equal(quiet.checks24h.state, "no_data");
    assert.deepEqual(quiet.browserErrors24h, { state: "live", value: 0 }, "a browser that reported nothing is a real zero");
    await db.execute({ sql: "INSERT INTO health_check_runs VALUES ('h1', ?, 'c', 's', 'failing', ?), ('h2', ?, 'c', 's', 'ok', ?)", args: [T, hoursAgo(1), T, hoursAgo(2)] });
    assert.deepEqual((await vitals.loadPlatformVitals(T, NOW)).checks24h, { state: "live", value: { ok: 1, degraded: 0, failing: 1 } });
  });

  await check("the page draws the strip in the default export, and no lead list", () => {
    const page = readFileSync(join(__dirname, "..", "app", "health", "page.tsx"), "utf8");
    assert.match(page, /<VitalsStrip vitals=\{vitals\} \/>/);
    assert.match(page, /loadPlatformVitals\(tenantId, now\)/);
    assert.doesNotMatch(page, /loadColdLeadList|Cold leads/);
    assert.match(page, /<PageFrame/);
  });

  console.log(`health-vitals: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
