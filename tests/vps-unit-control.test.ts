/**
 * tests/vps-unit-control.test.ts - CC switches the daemon VPS's always-on workers on and off
 * (2026-11-03, CC: "for the background workers i'm unable to like turn them off and on").
 *
 * Pinned:
 *   1. the switch: anyone but CC is told nothing, cross-site is refused, only registered VPS
 *      workers and known actions, a critical worker's Stop/Restart needs confirm; Stop/Start/Restart
 *      write the row and an audit row; a refused request writes nothing;
 *   2. the server's poll: signed like the heartbeat (503/401/413 before anything is read), returns
 *      the rows, records a result only against the stamp it answers;
 *   3. the heartbeat: a switched-off unit that is down reads "disabled by operator", never an outage;
 *      one still running reads as running; an unreadable switch table changes nothing;
 *   4. the rules: server_switch control only for CC on a remote row; a failure report counts only for
 *      the newest switch;
 *   5. the wiring: the control route sends vps.* here before any bridge call, the route is public in
 *      middleware only by its exact path, the panel sends the confirm, the migration is additive.
 *
 * Run: node --conditions=react-server --import tsx tests/vps-unit-control.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "vps-unit-control-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN"]) delete process.env[k];

const db = createClient({ url: `file:${dbFile}` });
const SECRET = "s".repeat(43);
const NOW = new Date("2026-11-03T20:00:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const CC = { ok: true as const, tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452", userId: "c88bdce9-b11c-4731-bdc8-4357f96f820c" };

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
  const ctl = await import("../lib/automations/vps-unit-control");
  const vps = await import("../lib/automations/vps-health");
  const status = await import("../lib/automations/worker-status");
  const { computeStripeSignature } = await import("../lib/founders-finances/stripe-signature");
  const { OASIS_WORKERS, controllableOasisWorker } = await import("../lib/automations/oasis-workers");
  await db.executeMultiple(readFileSync("database/turso/bravo__253_vps_unit_controls.sql", "utf8"));
  await db.executeMultiple(`
    CREATE TABLE integrations_health (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, profile_id TEXT,
      service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, UNIQUE (profile_id, service));
  `);
  const controls = async () =>
    (await db.execute("SELECT service, desired, changed_at, changed_by, restart_requested_at, applied_for, applied_ok, applied_detail FROM vps_unit_controls ORDER BY service")).rows;

  const post = (body: unknown, headers: Record<string, string> = { origin: "https://oasisai.work", "x-forwarded-host": "oasisai.work" }) =>
    new Request("https://oasisai.work/api/automations/background-workers/control", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const audits: Array<Record<string, unknown>> = [];
  let at = NOW;
  const deps = (authorize: () => Promise<unknown>) => ({
    authorize: authorize as never,
    db: () => db,
    audit: async (row: unknown) => (audits.push(row as Record<string, unknown>), { ok: true as const }),
    now: () => at,
  });
  const sw = async (body: Record<string, unknown>, authorize: () => Promise<unknown> = async () => CC, req?: Request) => {
    const res = await ctl.handleVpsUnitSwitch(req ?? post(body), body, deps(authorize));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  await check("switch: anyone but CC is told nothing; cross-site, unknown workers and bad actions change nothing", async () => {
    const stop = { service: "vps.oasis-content-tools-runner", action: "stop" };
    assert.deepEqual(await sw(stop, async () => ({ ok: false, status: 401, error: "unauthorized" })), { status: 401, body: { ok: false, error: "unauthenticated" } });
    assert.deepEqual(await sw(stop, async () => ({ ok: false, status: 404, error: "not_found" })), { status: 404, body: { ok: false, error: "not_found" } });
    const crossSite = post(stop, { origin: "https://evil.example", "x-forwarded-host": "oasisai.work" });
    assert.equal((await sw(stop, async () => CC, crossSite)).status, 403);
    assert.equal((await sw(stop, async () => CC, post(stop, { "x-forwarded-host": "oasisai.work" }))).status, 403, "no Origin or Referer fails closed");
    for (const service of ["pm2.claude-bridge", "vps.oasis-vps-health", "vps.oasis-unit-control", "oasis-scheduler.service", ""]) {
      assert.equal((await sw({ service, action: "stop" })).body.error, "unknown_worker", `${service} is not switchable`);
    }
    for (const action of ["kill", "enable", "", undefined]) {
      assert.equal((await sw({ service: "vps.oasis-meet-runner", action })).body.error, "invalid_action");
    }
    assert.equal((await controls()).length, 0, "nothing written");
    assert.equal(audits.length, 0, "nothing audited");
  });

  await check("switch: a critical worker's Stop or Restart needs confirm; Start never does", async () => {
    for (const service of ["vps.oasis-telegram-bridge", "vps.oasis-headless-bridge", "vps.oasis-scheduler", "vps.oasis-workspace-scheduler", "vps.atlas-telegram", "vps.maven-telegram"]) {
      for (const action of ["stop", "restart"]) {
        const res = await sw({ service, action });
        assert.equal(res.status, 409, `${service} ${action} without confirm`);
        assert.equal(res.body.error, "confirm_required");
        assert.equal((await sw({ service, action, confirm: "yes" })).status, 409, "only the boolean true confirms");
      }
    }
    assert.equal((await controls()).length, 0, "a refused confirm writes nothing");
    assert.equal((await sw({ service: "vps.oasis-telegram-bridge", action: "stop", confirm: true })).status, 200);
    assert.equal((await sw({ service: "vps.oasis-telegram-bridge", action: "start" })).status, 200, "Start needs no confirm");
  });

  await check("switch: Stop, Start and Restart write the row and an audit row", async () => {
    audits.length = 0;
    at = new Date("2026-11-03T20:01:00.000Z");
    const off = await sw({ service: "vps.oasis-content-tools-runner", action: "stop" });
    assert.equal(off.status, 200);
    assert.equal(off.body.desired, "off");
    assert.match(String(off.body.output), /switched off/);
    let row = (await controls()).find((r) => r.service === "vps.oasis-content-tools-runner")!;
    assert.equal(row.desired, "off");
    assert.equal(row.changed_at, "2026-11-03T20:01:00.000Z");
    assert.equal(row.changed_by, CC.userId);
    assert.equal(row.restart_requested_at, null);
    assert.equal(audits[0].actionType, "vps_worker_switch");
    assert.equal(audits[0].targetTable, "vps_unit_controls");
    assert.equal(audits[0].targetId, "vps.oasis-content-tools-runner");

    at = new Date("2026-11-03T20:02:00.000Z");
    await sw({ service: "vps.oasis-content-tools-runner", action: "restart" });
    row = (await controls()).find((r) => r.service === "vps.oasis-content-tools-runner")!;
    assert.equal(row.desired, "on", "a restart turns the worker on");
    assert.equal(row.restart_requested_at, "2026-11-03T20:02:00.000Z");

    at = new Date("2026-11-03T20:03:00.000Z");
    await sw({ service: "vps.oasis-content-tools-runner", action: "stop" });
    row = (await controls()).find((r) => r.service === "vps.oasis-content-tools-runner")!;
    assert.equal(row.desired, "off");
    assert.equal(row.changed_at, "2026-11-03T20:03:00.000Z");
    assert.equal(row.restart_requested_at, "2026-11-03T20:02:00.000Z", "a later Stop keeps the restart stamp (already acted on)");
    assert.equal(audits.length, 3);
  });

  const signed = (body: unknown, ts = nowSec, secret = SECRET) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return new Request("https://oasisai.work/api/internal/vps-control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [vps.HEADER_VPS_TIMESTAMP]: String(ts),
        [vps.HEADER_VPS_SIGNATURE]: computeStripeSignature(raw, secret, ts),
      },
      body: raw,
    });
  };
  const poll = async (req: Request, over: Record<string, unknown> = {}) => {
    const res = await ctl.handleVpsControlPoll(req, { env: { CRON_SECRET: SECRET }, now: () => NOW, db: () => db, ...over } as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  await check("poll: signed like the heartbeat; a refused request reads and writes nothing", async () => {
    const spy = { execute: () => { throw new Error("read for a refused request"); }, batch: () => { throw new Error("write for a refused request"); } } as unknown as Client;
    assert.deepEqual(await poll(signed({ host: "oasis-daemon-1" }), { env: {}, db: () => spy }), { status: 503, body: { ok: false, error: "not_installed", detail: "secret_not_set" } });
    const unsigned = new Request("https://oasisai.work/api/internal/vps-control", { method: "POST", body: "{}" });
    assert.equal((await poll(unsigned, { db: () => spy })).status, 401);
    assert.equal((await poll(signed({ host: "oasis-daemon-1" }, nowSec, "w".repeat(43)), { db: () => spy })).status, 401);
    assert.equal((await poll(signed({ host: "oasis-daemon-1" }, nowSec - 301), { db: () => spy })).body.error, "stale_timestamp");
    assert.equal((await poll(signed("x".repeat(ctl.VPS_CONTROL_BODY_MAX_BYTES + 1)), { db: () => spy })).status, 413);
    // A heartbeat signature is not a control request: the body it signs is a different body.
    for (const [body, field] of [
      [{ host: "bad host!" }, "host"],
      [{ host: "oasis-daemon-1", results: "x" }, "results"],
      [{ host: "oasis-daemon-1", results: [{ service: "pm2.claude-bridge", applied_for: "2026-11-03T20:03:00.000Z", ok: true }] }, "service"],
      [{ host: "oasis-daemon-1", results: [{ service: "vps.oasis-meet-runner", applied_for: "yesterday", ok: true }] }, "applied_for"],
      [{ host: "oasis-daemon-1", results: [{ service: "vps.oasis-meet-runner", applied_for: "2026-11-03T20:03:00.000Z", ok: "true" }] }, "ok"],
    ] as const) {
      const res = await poll(signed(body), { db: () => spy });
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(res.body.field, field);
    }
  });

  await check("poll: returns the rows; a result is recorded only against the stamp it answers", async () => {
    const first = await poll(signed({ host: "oasis-daemon-1" }));
    assert.equal(first.status, 200);
    const list = first.body.controls as Array<Record<string, unknown>>;
    const tools = list.find((c) => c.service === "vps.oasis-content-tools-runner")!;
    assert.deepEqual(tools, { service: "vps.oasis-content-tools-runner", desired: "off", changed_at: "2026-11-03T20:03:00.000Z", restart_requested_at: "2026-11-03T20:02:00.000Z" });
    assert.ok(!("changed_by" in tools), "the server is not told who switched it");

    // An old report (for the 20:01 stop) never marks the newer 20:03 stop as applied.
    await poll(signed({ host: "oasis-daemon-1", results: [{ service: "vps.oasis-content-tools-runner", applied_for: "2026-11-03T20:01:00.000Z", ok: true, detail: "stopped" }] }));
    let row = (await controls()).find((r) => r.service === "vps.oasis-content-tools-runner")!;
    assert.equal(row.applied_for, null);
    await poll(signed({ host: "oasis-daemon-1", results: [{ service: "vps.oasis-content-tools-runner", applied_for: "2026-11-03T20:03:00.000Z", ok: false, detail: "Job for x failed\u0007" }] }));
    row = (await controls()).find((r) => r.service === "vps.oasis-content-tools-runner")!;
    assert.equal(row.applied_for, "2026-11-03T20:03:00.000Z");
    assert.equal(Number(row.applied_ok), 0);
    assert.equal(row.applied_detail, "Job for x failed", "control characters are stripped");
    const broken = { execute: async () => { throw new Error("blip"); }, batch: async () => { throw new Error("blip"); } } as unknown as Client;
    assert.deepEqual(await poll(signed({ host: "oasis-daemon-1" }), { db: () => broken }), { status: 503, body: { ok: false, error: "unavailable" } });
  });

  await check("heartbeat: a switched-off unit that is down reads 'disabled by operator', not an outage", async () => {
    const hb = {
      host: "oasis-daemon-1",
      services: [
        { service: "vps.oasis-content-tools-runner", status: "down", detail: "inactive (dead)" },
        { service: "vps.oasis-meet-runner", status: "down", detail: "timer inactive" },
        { service: "vps.oasis-telegram-bridge", status: "healthy", detail: "active (running)" },
      ],
    };
    const hbReq = (body: unknown) => {
      const raw = JSON.stringify(body);
      return new Request("https://oasisai.work/api/internal/vps-health", {
        method: "POST",
        headers: { [vps.HEADER_VPS_TIMESTAMP]: String(nowSec), [vps.HEADER_VPS_SIGNATURE]: computeStripeSignature(raw, SECRET, nowSec) },
        body: raw,
      });
    };
    const res = await vps.handleVpsHeartbeat(hbReq(hb), { env: { CRON_SECRET: SECRET }, now: () => NOW, db: () => db, profileIds: async () => ["p-cc"] });
    assert.equal(res.status, 200);
    const rows = (await db.execute("SELECT service, status, last_error, metadata FROM integrations_health ORDER BY service")).rows;
    const byService = new Map(rows.map((r) => [String(r.service), r]));
    const tools = byService.get("vps.oasis-content-tools-runner")!;
    assert.equal(tools.status, "degraded");
    assert.equal(tools.last_error, null);
    assert.equal(JSON.parse(String(tools.metadata)).pm2_status, status.SUPERVISOR_DISABLED);
    assert.ok(status.isOperatorStopped({ status: "degraded", metadata: JSON.parse(String(tools.metadata)) }), "the panel reads it as Off");
    const meet = byService.get("vps.oasis-meet-runner")!;
    assert.equal(meet.status, "down", "a worker CC never switched off is still an outage");
    assert.equal(meet.last_error, "timer inactive");

    // Still running after the switch: reported as running (the server has not applied it yet).
    const running = vps.asReported({ service: "vps.oasis-content-tools-runner", status: "healthy", detail: "active (running)" }, new Set(["vps.oasis-content-tools-runner"]));
    assert.equal(running.status, "healthy");
    // An unreadable switch table never blocks the heartbeat; the stopped unit reads honestly down.
    const blind = await vps.handleVpsHeartbeat(hbReq(hb), {
      env: { CRON_SECRET: SECRET }, now: () => NOW, db: () => db, profileIds: async () => ["p-cc"],
      switchedOff: async () => { throw new Error("no such table: vps_unit_controls"); },
    });
    assert.equal(blind.status, 200);
    const after = (await db.execute("SELECT status FROM integrations_health WHERE service = 'vps.oasis-content-tools-runner'")).rows[0];
    assert.equal(after.status, "down");
  });

  await check("rules: server_switch only for CC on a remote row; a failure counts only for the newest switch", () => {
    const base = { runtime: "remote" as const, configuredMode: "server_switch" as const, isTrueAdmin: true, adminAccess: true };
    assert.equal(status.resolveWorkerControlMode({ ...base, serverSwitchAllowed: true }), "server_switch");
    assert.equal(status.resolveWorkerControlMode({ ...base, serverSwitchAllowed: false }), "none");
    assert.equal(status.resolveWorkerControlMode({ ...base }), "none", "missing means no");
    assert.equal(status.resolveWorkerControlMode({ ...base, runtime: "local", serverSwitchAllowed: true }), "none");
    assert.equal(status.resolveWorkerControlMode({ ...base, runtime: "retired", serverSwitchAllowed: true }), "none");
    assert.equal(status.resolveWorkerControlMode({ ...base, configuredMode: "none", serverSwitchAllowed: true }), "none");
    const sw0 = { desired: "off" as const, changed_at: "2026-11-03T20:03:00.000Z", restart_requested_at: "2026-11-03T20:02:00.000Z", applied_at: "x", applied_for: "2026-11-03T20:03:00.000Z", applied_ok: false, applied_detail: "Job failed" };
    assert.equal(status.serverSwitchFailure(sw0), "Job failed");
    assert.equal(status.serverSwitchFailure({ ...sw0, applied_ok: true }), null);
    assert.equal(status.serverSwitchFailure({ ...sw0, applied_for: "2026-11-03T20:02:00.000Z" }), null, "a failure for an older stamp is history");
    assert.equal(status.serverSwitchFailure({ ...sw0, restart_requested_at: "2026-11-03T20:04:00.000Z" }), null, "a newer restart supersedes it");
    assert.equal(status.serverSwitchFailure(undefined), null);
    for (const w of OASIS_WORKERS.filter((x) => x.service.startsWith("vps."))) {
      assert.equal(w.control_mode, "server_switch", `${w.service} is switched by the server`);
      assert.equal(controllableOasisWorker(w.service), null, `${w.service} is never reached through a bridge`);
    }
    assert.deepEqual(
      [...status.VPS_CRITICAL_WORKERS.keys()].every((s) => (vps.VPS_HEALTH_SERVICES as readonly string[]).includes(s)),
      true,
      "every critical worker is a registered VPS worker",
    );
  });

  await check("wiring: vps.* goes to the switch before any bridge call; exact public path; confirm sent; additive migration", () => {
    const route = readFileSync("app/api/automations/background-workers/control/route.ts", "utf8");
    const post = route.slice(route.indexOf("export async function POST"));
    assert.ok(post.indexOf("handleVpsUnitSwitch(req, vps)") > 0);
    assert.ok(post.indexOf("handleVpsUnitSwitch(req, vps)") < post.indexOf("authorizeBridgeRequest"), "the VPS branch comes before any bridge resolution");
    assert.match(route, /body\.service\.startsWith\("vps\."\)/);
    const middleware = readFileSync("middleware.ts", "utf8");
    assert.match(middleware, /"\/api\/internal\/vps-control",/);
    const panel = readFileSync("components/automations/BackgroundWorkersPanel.tsx", "utf8");
    assert.match(panel, /runWorkerAction\(service, action, \{ confirm: Boolean\(serverConsequence\) \}\)/);
    assert.match(panel, /controlMode === "server_switch"/);
    const sql = readFileSync("database/turso/bravo__253_vps_unit_controls.sql", "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS vps_unit_controls/);
    assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DROP|DELETE|ALTER|UPDATE)\b/i, "additive only");
    const workers = readFileSync("app/api/automations/background-workers/route.ts", "utf8");
    assert.match(workers, /serverSwitchAllowed = isOasis \? await cloudJobsSwitchableForViewer\(\) : false/);
  });

  console.log(`\nvps-unit-control: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
