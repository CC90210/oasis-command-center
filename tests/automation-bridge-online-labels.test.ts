/**
 * tests/automation-bridge-online-labels.test.ts
 *
 * BUG 2 (2026-10-10): the Automations (and /sequences) banner said "Your
 * computer is connected" whenever ANY non-revoked bridge_pairings row for
 * the tenant pinged within the freshness window (the old getBridgeOnline /
 * getTenantBridgeStatus rule). In the shared OASIS workspace that pairing
 * is always CC's PC, so Adon read a claim about HIS machine that was
 * false. Fix: lib/queries.ts:getOnlineBridgeComputerLabels names WHICH
 * pairing(s) are actually online; lib/bridge-online-copy.ts renders it.
 *
 * This pins the new query against a real local libSQL file (same harness
 * as tests/queries-fail-loud.test.ts), and a source-level check that the
 * lie is gone from every surface that rendered it off the same any-pairing
 * rule.
 *
 * Run: node --conditions=react-server --import tsx tests/automation-bridge-online-labels.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-online-labels-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const ROOT = join(__dirname, "..");

async function main() {
  const q = await import("../lib/queries");
  const db = createClient({ url: `file:${dbFile}` });
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // No tenant: the early answer, no read.
  assert.deepEqual(await q.getOnlineBridgeComputerLabels(null), []);

  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, label TEXT, user_id TEXT,
      last_seen_at TEXT, revoked_at TEXT, tool_capabilities TEXT);
  `);

  // No rows yet for ws-1: readable table, zero matches — online, but empty.
  assert.deepEqual(await q.getOnlineBridgeComputerLabels("ws-1"), []);

  await db.batch(
    [
      { sql: "INSERT INTO bridge_pairings VALUES ('p-cc', 'ws-1', 'CCPC', 'u1', ?, NULL, '[]')", args: [now] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-mac', 'ws-1', 'Mac', 'u2', ?, NULL, '[]')", args: [now] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-stale', 'ws-1', 'Old box', 'u3', ?, NULL, '[]')", args: [hourAgo] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-revoked', 'ws-1', 'Revoked box', 'u4', ?, ?, '[]')", args: [now, now] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-blank', 'ws-2', '', 'u5', ?, NULL, '[]')", args: [now] },
      { sql: "INSERT INTO bridge_pairings VALUES ('p-other', 'ws-3', 'Other workspace', 'u6', ?, NULL, '[]')", args: [now] },
    ],
    "write",
  );

  assert.deepEqual(
    (await q.getOnlineBridgeComputerLabels("ws-1")).slice().sort(),
    ["CCPC", "Mac"],
    "fresh, non-revoked pairings only — the stale and revoked rows are excluded",
  );
  assert.deepEqual(
    await q.getOnlineBridgeComputerLabels("ws-2"),
    [""],
    "an online pairing with a blank label is still reported online — the read never drops a " +
      "real connection for lack of a name; the caller supplies the fallback text",
  );
  assert.deepEqual(
    await q.getOnlineBridgeComputerLabels("ws-3"),
    ["Other workspace"],
    "tenant-scoped: ws-3 gets its own online pairing, never ws-1's or ws-2's",
  );

  await db.executeMultiple("DROP TABLE bridge_pairings;");
  await assert.rejects(
    () => q.getOnlineBridgeComputerLabels("ws-1"),
    /bridge_pairings read failed/,
    "a failed read throws — 'Couldn't check', never a silent empty list read as offline",
  );

  // ── Source-level: the lie is gone everywhere it rendered off the same rule ──
  for (const rel of [
    join("components", "automations", "AutomationsContent.tsx"),
    join("components", "settings", "BridgeInstallLink.tsx"),
  ]) {
    const fileSrc = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(
      !/Your computer is connected/.test(fileSrc),
      `${rel} must not claim "Your computer is connected" off the any-pairing rule`,
    );
  }

  const automationsSrc = readFileSync(
    join(ROOT, "components", "automations", "AutomationsContent.tsx"),
    "utf8",
  );
  assert.ok(
    automationsSrc.includes("getOnlineBridgeComputerLabels"),
    "AutomationsContent must read the NAMED online pairings, not just the any-pairing boolean",
  );
  assert.ok(
    automationsSrc.includes("bridgeConnectionHeadline("),
    "AutomationsContent must render the shared truthful wording function",
  );

  const sequencesSrc = readFileSync(join(ROOT, "app", "sequences", "page.tsx"), "utf8");
  assert.ok(
    sequencesSrc.includes("getOnlineBridgeComputerLabels"),
    "/sequences mirrors the automations banner (per its own comment) and must carry the same fix",
  );
  assert.ok(
    sequencesSrc.includes("onlineLabels={onlineLabels}"),
    "/sequences must pass the named pairings into BridgeStatusBanner",
  );

  console.log("automation-bridge-online-labels.test.ts: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
