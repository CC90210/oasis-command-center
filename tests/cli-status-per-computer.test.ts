/**
 * cli-status-per-computer.test.ts - two paired computers report different CLI
 * states and BOTH survive (CC, 2026-10-09: "Ready" one minute and "Needs
 * sign-in" the next, two paired computers writing one row).
 *
 * Real routes on a local libSQL file (tests/_delivery-harness.ts):
 *   POST /api/bridge/ping  x2 computers  ->  integrations_health local_ai_clis
 *   GET  /api/bridge/cli-status          ->  one entry per computer
 *
 * Run: node --conditions=react-server --import tsx tests/cli-status-per-computer.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { OASIS, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

import { dirname } from "node:path";
import * as ReactNS from "react";

// RunnerStatusHeader imports next/link; the pure describeRunner needs none of it.
{
  const p = require.resolve("next/link");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: { __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => ReactNS.createElement("a", { href }, children as ReactNS.ReactNode) },
  } as unknown as NodeModule;
}

type Json = Record<string, unknown>;

const provider = (installed: boolean, authenticated: boolean, version: string | null, probe?: string) => ({
  installed,
  authenticated,
  version,
  ...(probe ? { probe } : {}),
});
const providers = (claude: ReturnType<typeof provider>, codex: ReturnType<typeof provider>, gemini: ReturnType<typeof provider>) => ({ claude, codex, gemini });

const READY = providers(provider(true, true, "2.1.270"), provider(true, true, "codex-cli 0.146.0"), provider(true, true, "0.63.0"));
const SIGNED_OUT = providers(provider(true, false, "2.1.270"), provider(false, false, null), provider(true, false, null));

async function main() {
  const db = await setupDatabase();
  await db.executeMultiple(`
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      profile_id TEXT, service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX "integrations_health_profile_id_service_key" ON integrations_health (profile_id, service);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT,
      bridge_token_hash TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT, tool_capabilities TEXT);
  `);
  const { NextRequest } = await import("next/server");
  const { sha256 } = await import("../lib/api-helpers");
  const pingRoute = await import("../app/api/bridge/ping/route");
  const statusRoute = await import("../app/api/bridge/cli-status/route");
  const { normalizeCliMachines, machinesOfBody } = await import("../lib/bridge-cli-status");
  const { describeCliPanel } = await import("../components/BridgeCliPanel");
  const { describeRunner } = await import("../components/admin/RunnerStatusHeader");

  const WIN = "62d16819-0000-4000-8000-000000000001";
  const MAC = "602eb84b-0000-4000-8000-000000000002";
  for (const [id, label, token] of [[WIN, "CCPC (Windows)", "win-token"], [MAC, "192.168.11.27 (Mac)", "mac-token"]] as const) {
    await db.execute({
      sql: "INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash) VALUES (?, ?, ?, ?, ?)",
      args: [id, OASIS, USERS.cc.id, label, sha256(token)],
    });
  }
  const ping = async (token: string, cliProviders: unknown, extra: Json = {}) => {
    const res = await pingRoute.POST(
      new NextRequest("https://oasisai.work/api/bridge/ping", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          services: {
            local_ai_clis: {
              status: "healthy",
              metadata: { via: "paired_bridge_heartbeat", checked_at: new Date().toISOString(), providers: cliProviders, ...extra },
            },
          },
        }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Json };
  };
  const readStatus = async () => {
    const res = await statusRoute.GET();
    return (await res.json()) as Json;
  };
  const stateWords = (body: Json) => {
    const view = describeCliPanel(true, { kind: "body", status: 200, body: body as never });
    return (view.machines ?? []).map((m) => `${m.label}: ${m.rows.map((r) => `${r.name}=${r.info.installed && r.info.authenticated ? "ready" : r.info.installed ? "signin" : "none"}`).join(",")}`);
  };

  await login(USERS.cc);

  await check("two computers reporting different states both survive and render separately", async () => {
    assert.equal((await ping("win-token", READY)).status, 200);
    assert.equal((await ping("mac-token", SIGNED_OUT)).status, 200);
    // The Windows computer reports again: it must not erase the Mac's entry, and vice versa.
    assert.equal((await ping("win-token", READY)).status, 200);
    const body = await readStatus();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.deepEqual(stateWords(body), [
      "192.168.11.27 (Mac): claude=signin,codex=none,gemini=signin",
      "CCPC (Windows): claude=ready,codex=ready,gemini=ready",
    ]);
    const runner = describeRunner({ warm: null, cli: { status: 200, body: body as never } }).tools;
    assert.match(runner, /192\.168\.11\.27 \(Mac\): .*Needs sign-in/);
    assert.match(runner, /CCPC \(Windows\): Signed in: Claude Code, Codex, Gemini/);
    // One row, not one per computer.
    const rows = await db.execute({ sql: "SELECT metadata FROM integrations_health WHERE profile_id = ? AND service = 'local_ai_clis'", args: [`p-${USERS.cc.id}`] });
    assert.equal(rows.rows.length, 1);
    const meta = JSON.parse(String(rows.rows[0].metadata)) as Json;
    assert.equal(meta.providers, undefined, "no top-level providers once reports are per computer");
    assert.deepEqual(Object.keys(meta.machines as Json).sort(), [MAC, WIN].sort());
    // The agents' computer cannot be proven from the bridge address, so nothing is marked and the readers say so.
    assert.equal(body.agents_run_on, null);
    assert.match(describeCliPanel(true, { kind: "body", status: 200, body: body as never }).detail, /Your agents use the computer your bridge points to\./);
  });

  await check("a computer's own sign-in change is shown for that computer only", async () => {
    await ping("mac-token", READY);
    const body = await readStatus();
    assert.deepEqual(stateWords(body), [
      "192.168.11.27 (Mac): claude=ready,codex=ready,gemini=ready",
      "CCPC (Windows): claude=ready,codex=ready,gemini=ready",
    ]);
    await ping("mac-token", SIGNED_OUT);
  });

  await check("a revoked pairing's computer disappears", async () => {
    await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = ? WHERE id = ?", args: [new Date().toISOString(), MAC] });
    const body = await readStatus();
    assert.deepEqual(stateWords(body), ["CCPC (Windows): claude=ready,codex=ready,gemini=ready"]);
    // A revoked bridge cannot write either.
    assert.equal((await ping("mac-token", READY)).status, 403);
    await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = NULL WHERE id = ?", args: [MAC] });
  });

  await check("a computer that stopped reporting drops out; none left is 'stale', never an old answer", async () => {
    const now = Date.now();
    const old = new Date(now - 10 * 60_000).toISOString();
    const fresh = new Date(now - 30_000).toISOString();
    const entry = (seen: string, label: string) => ({ label, seen_at: seen, checked_at: seen, providers: READY });
    const meta = { machines: { [WIN]: entry(fresh, "CCPC (Windows)"), [MAC]: entry(old, "Mac") } };
    const only = normalizeCliMachines(meta, fresh, null, now);
    assert.ok(only.ok && only.machines.length === 1 && only.machines[0].id === WIN);
    const none = normalizeCliMachines({ machines: { [WIN]: entry(old, "x"), [MAC]: entry(old, "y") } }, fresh, null, now);
    assert.deepEqual(none, { ok: false, reason: "stale" });
  });

  await check("an old-shape row (providers at the top level) still renders as one unlabeled computer", async () => {
    await db.execute({
      sql: "UPDATE integrations_health SET metadata = ?, last_ping_at = ? WHERE profile_id = ? AND service = 'local_ai_clis'",
      args: [JSON.stringify({ via: "paired_bridge_heartbeat", providers: READY }), new Date().toISOString(), `p-${USERS.cc.id}`],
    });
    const body = await readStatus();
    assert.equal(body.ok, true, JSON.stringify(body));
    const machines = machinesOfBody(body as never);
    assert.equal(machines.length, 1);
    assert.equal(machines[0].label, null);
    assert.equal(machines[0].data.claude.authenticated, true);
    const view = describeCliPanel(null, { kind: "body", status: 200, body: body as never });
    assert.equal(view.machines?.length, 1);
    assert.doesNotMatch(view.detail, /bridge points to/);
    // A body from before this change (one `data`) reads the same way.
    assert.equal(machinesOfBody({ data: machines[0].data } as never).length, 1);
    // The next heartbeat upgrades the row without losing the other computer's later report.
    await ping("win-token", READY);
    await ping("mac-token", SIGNED_OUT);
    assert.equal(((await readStatus()).machines as unknown[]).length, 2);
  });

  await check("a report with no providers writes nothing and says so", async () => {
    const res = await ping("win-token", null);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "cli_inventory_persist_failed");
  });

  finish("cli-status-per-computer");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
