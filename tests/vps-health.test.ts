/**
 * tests/vps-health.test.ts - the daemon VPS reports its registered workers (2026-10-31, CC: "so
 * BackgroundWorkersPanel shows live green health for the VPS workers").
 *
 * Pinned:
 *   1. auth: no secret is 503; a missing, wrong or stale signature is 401; an oversized body is 413;
 *      none of them reads or writes anything;
 *   2. the body: only registered VPS services, a known status, a sane host, no duplicates (422 names
 *      the field);
 *   3. the write: one integrations_health row per (owner profile, service), updated in place, the
 *      error kept only when not healthy; the owner's profiles come from workspace_agents_owner;
 *   4. the endpoint's services are exactly the panel's VPS rows, and the route only delegates.
 *
 * Run: node --conditions=react-server --import tsx tests/vps-health.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "vps-health-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN"]) delete process.env[k];

const db = createClient({ url: `file:${dbFile}` });
const SECRET = "s".repeat(43);
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const NOW = new Date("2026-10-31T17:00:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

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
  const vps = await import("../lib/automations/vps-health");
  const { computeStripeSignature } = await import("../lib/founders-finances/stripe-signature");
  const { OASIS_WORKERS } = await import("../lib/automations/oasis-workers");
  await db.executeMultiple(`
    CREATE TABLE integrations_health (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, profile_id TEXT,
      service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, UNIQUE (profile_id, service));
    CREATE TABLE workspace_agents_owner (tenant_id TEXT PRIMARY KEY, auth_user_id TEXT, set_by TEXT, set_at TEXT, revoked_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, tenant_id TEXT);
  `);

  const heartbeat = {
    host: "oasis-daemon-1",
    services: [
      { service: "vps.oasis-telegram-bridge", status: "healthy", detail: "active (running)" },
      { service: "vps.oasis-inbox-sweep", status: "healthy", detail: "timer active; last run success" },
    ],
  };
  const signed = (body: unknown, ts = nowSec, secret = SECRET, extra: Record<string, string> = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return new Request("https://oasisai.work/api/internal/vps-health", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [vps.HEADER_VPS_TIMESTAMP]: String(ts),
        [vps.HEADER_VPS_SIGNATURE]: computeStripeSignature(raw, secret, ts),
        ...extra,
      },
      body: raw,
    });
  };
  let lookups = 0;
  const deps = (over: Record<string, unknown> = {}) => ({
    env: { CRON_SECRET: SECRET },
    now: () => NOW,
    db: () => db,
    profileIds: async () => (lookups++, ["p-cc"]),
    ...over,
  });
  const call = async (req: Request, over: Record<string, unknown> = {}) => {
    const res = await vps.handleVpsHeartbeat(req, deps(over) as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const rows = async () =>
    (await db.execute("SELECT profile_id, service, status, last_error, metadata, tenant_id, last_ping_at FROM integrations_health ORDER BY service")).rows;

  await check("auth: no secret is 503; missing, wrong or stale signatures are 401; nothing is read or written", async () => {
    assert.deepEqual(await call(signed(heartbeat), { env: {} }), { status: 503, body: { ok: false, error: "not_installed", detail: "secret_not_set" } });
    assert.equal((await call(signed(heartbeat), { env: { CRON_SECRET: "short" } })).status, 503, "a short secret never means open");
    const unsigned = new Request("https://oasisai.work/api/internal/vps-health", { method: "POST", body: JSON.stringify(heartbeat) });
    assert.deepEqual(await call(unsigned), { status: 401, body: { ok: false, error: "unauthorized" } });
    assert.deepEqual(await call(signed(heartbeat, nowSec, "w".repeat(43))), { status: 401, body: { ok: false, error: "unauthorized" } });
    assert.deepEqual(await call(signed(heartbeat, nowSec - 301)), { status: 401, body: { ok: false, error: "stale_timestamp" } });
    // A signature over a different body than the one sent.
    const ts = nowSec;
    const tampered = new Request("https://oasisai.work/api/internal/vps-health", {
      method: "POST",
      headers: { [vps.HEADER_VPS_TIMESTAMP]: String(ts), [vps.HEADER_VPS_SIGNATURE]: computeStripeSignature("{}", SECRET, ts) },
      body: JSON.stringify(heartbeat),
    });
    assert.equal((await call(tampered)).status, 401);
    assert.equal((await call(signed("x".repeat(vps.VPS_HEALTH_BODY_MAX_BYTES + 1)))).status, 413);
    assert.equal(lookups, 0, "no owner lookup for a refused request");
    assert.equal((await rows()).length, 0, "nothing written");
  });

  await check("body: only registered VPS services, a known status, a sane host, no duplicates", async () => {
    assert.deepEqual(await call(signed("{nope")), { status: 422, body: { ok: false, error: "invalid_json" } });
    const field = async (body: unknown) => (await call(signed(body))).body.field;
    assert.equal(await field({ ...heartbeat, host: "bad host!" }), "host");
    assert.equal(await field({ ...heartbeat, services: [] }), "services");
    assert.equal(await field({ ...heartbeat, services: [{ service: "pm2.claude-bridge", status: "healthy" }] }), "service");
    assert.equal(await field({ ...heartbeat, services: [{ service: "vps.oasis-inbox-sweep", status: "on fire" }] }), "status");
    assert.equal(
      await field({ ...heartbeat, services: [heartbeat.services[0], heartbeat.services[0]] }),
      "service",
      "a service reported twice is refused",
    );
    assert.equal((await rows()).length, 0);
  });

  await check("write: one row per (owner profile, service), updated in place; the error only when not healthy", async () => {
    assert.deepEqual(await call(signed(heartbeat)), { status: 200, body: { ok: true, recorded: 2 } });
    let stored = await rows();
    assert.equal(stored.length, 2);
    for (const r of stored) {
      assert.equal(r.profile_id, "p-cc");
      assert.equal(r.tenant_id, OASIS);
      assert.equal(r.status, "healthy");
      assert.equal(r.last_error, null);
      assert.equal(r.last_ping_at, NOW.toISOString());
      assert.equal(JSON.parse(String(r.metadata)).via, "vps-heartbeat");
    }
    const later = new Date(NOW.getTime() + 60_000);
    const sweepDown = { host: "oasis-daemon-1", services: [{ service: "vps.oasis-inbox-sweep", status: "down", detail: "timer inactive" }] };
    const res = await call(signed(sweepDown, Math.floor(later.getTime() / 1000)), { now: () => later });
    assert.equal(res.status, 200);
    stored = await rows();
    assert.equal(stored.length, 2, "updated in place, never a second row");
    const sweep = stored.find((r) => r.service === "vps.oasis-inbox-sweep")!;
    assert.equal(sweep.status, "down");
    assert.equal(sweep.last_error, "timer inactive");
    assert.equal(sweep.last_ping_at, later.toISOString());
    const bridge = stored.find((r) => r.service === "vps.oasis-telegram-bridge")!;
    assert.equal(bridge.last_ping_at, NOW.toISOString(), "a service not in this report keeps its last reading (it goes stale)");
  });

  await check("new daemons: no fabricated rows; mixed live states persist and omitted daemons do not get freshened", async () => {
    assert.equal((await rows()).some((r) => r.service === "vps.oasis-content-tools-runner"), false);
    assert.equal((await rows()).some((r) => r.service === "vps.oasis-workspace-scheduler"), false);
    const report = {
      host: heartbeat.host,
      services: [
        ...heartbeat.services,
        { service: "vps.oasis-scheduler", status: "healthy", detail: "active/running; restarts=0" },
        { service: "vps.oasis-headless-bridge", status: "degraded", detail: "activating/auto-restart; restarts=2" },
        { service: "vps.oasis-content-tools-runner", status: "down", detail: "inactive/dead; restarts=0" },
        { service: "vps.oasis-workspace-scheduler", status: "down", detail: "inactive/dead; awaiting cutover" },
      ],
    };
    assert.deepEqual(await call(signed(report)), { status: 200, body: { ok: true, recorded: 6 } });
    const stored = await rows();
    assert.equal(stored.length, 6);
    for (const service of report.services) {
      const actual = stored.find((r) => r.service === service.service)!;
      assert.equal(actual.status, service.status);
      assert.equal(actual.last_ping_at, NOW.toISOString());
      assert.equal(actual.profile_id, "p-cc");
      assert.equal(actual.tenant_id, OASIS);
      assert.equal(JSON.parse(String(actual.metadata)).detail, service.detail);
    }
    const later = new Date(NOW.getTime() + 6 * 60_000);
    const contentRunning = { host: heartbeat.host, services: [{ service: "vps.oasis-content-tools-runner", status: "healthy", detail: "active/running; restarts=0" }] };
    assert.equal((await call(signed(contentRunning, Math.floor(later.getTime() / 1000)), { now: () => later })).status, 200);
    const updated = await rows();
    const content = updated.find((r) => r.service === "vps.oasis-content-tools-runner")!;
    assert.equal(content.status, "healthy", "only a new report changes a stopped daemon to healthy");
    assert.equal(content.last_error, null);
    assert.equal(content.last_ping_at, later.toISOString());
    assert.equal(updated.find((r) => r.service === "vps.oasis-headless-bridge")!.last_ping_at, NOW.toISOString(), "omitted daemon keeps its old timestamp");
  });

  await check("owner: the agents owner's profiles; a missing or failed owner lookup is 503", async () => {
    await db.execute({ sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, 'auth-cc', 'auth-cc', ?)", args: [OASIS, NOW.toISOString()] });
    await db.execute({ sql: "INSERT INTO user_profiles (id, auth_user_id, tenant_id) VALUES ('p-cc-real', 'auth-cc', ?), ('p-other', 'auth-other', ?), ('p-cc-elsewhere', 'auth-cc', 'other-tenant')", args: [OASIS, OASIS] });
    assert.deepEqual(await vps.ownerProfileIds(db, OASIS), ["p-cc-real"], "the owner's OASIS profile only");
    assert.deepEqual(await call(signed(heartbeat), { profileIds: async () => [] }), { status: 503, body: { ok: false, error: "owner_unavailable" } });
    const original = console.error;
    console.error = () => undefined;
    try {
      const res = await call(signed(heartbeat), { profileIds: async () => { throw new Error("agents_owner_unavailable"); } });
      assert.deepEqual(res, { status: 503, body: { ok: false, error: "owner_unavailable" } });
    } finally {
      console.error = original;
    }
  });

  await check("oneshot: running is pending, not success; other daemon keys reject it; completion clears the phase", async () => {
    const { reportedWorkerStatus } = await import("../lib/automations/worker-status");
    const pending = { host: heartbeat.host, services: [{ service: "vps.oasis-inbox-sweep", status: "running", detail: "sweep running; result pending" }] };
    for (const service of vps.VPS_HEALTH_SERVICES.filter((s) => s !== "vps.oasis-inbox-sweep")) {
      assert.equal((await call(signed({ ...pending, services: [{ ...pending.services[0], service }] }))).status, 422);
    }
    assert.equal((await call(signed(pending))).status, 200);
    let stored = (await rows()).find((r) => r.service === "vps.oasis-inbox-sweep")!;
    assert.equal(stored.status, "unknown");
    assert.equal(stored.last_error, null, "work in progress is not a new error");
    assert.equal(stored.last_ping_at, NOW.toISOString());
    const metadata = JSON.parse(String(stored.metadata));
    assert.equal(metadata.phase, "running");
    assert.equal(reportedWorkerStatus(String(stored.service), stored.status, metadata), "pending", "the UI cannot paint this green");
    assert.equal((await call(signed({ ...pending, services: [{ service: "vps.oasis-inbox-sweep", status: "degraded", detail: "last sweep failed" }] }))).status, 200);
    stored = (await rows()).find((r) => r.service === "vps.oasis-inbox-sweep")!;
    assert.equal(stored.status, "degraded");
    assert.equal(stored.last_error, "last sweep failed");
    assert.equal(JSON.parse(String(stored.metadata)).phase, undefined, "completion replaces the transient phase with the real result");
  });

  await check("contract: the endpoint's services are exactly the panel's VPS rows; the route only delegates", () => {
    const remote = OASIS_WORKERS.filter((w) => w.runtime === "remote");
    assert.deepEqual(remote.map((w) => w.service).sort(), [...vps.VPS_HEALTH_SERVICES].sort());
    for (const w of remote) assert.equal(w.status_source, "integrations_health", `${w.service} reads its live row`);
    const route = readFileSync(join(process.cwd(), "app/api/internal/vps-health/route.ts"), "utf8");
    assert.match(route, /export async function POST\(req: Request\): Promise<Response> \{\r?\n\s*return handleVpsHeartbeat\(req\);\r?\n\}/);
    const middleware = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
    assert.ok(middleware.includes('"/api/internal/vps-health", //'), "the VPS's path is public, with its reason");
  });

  console.log(`vps-health: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
