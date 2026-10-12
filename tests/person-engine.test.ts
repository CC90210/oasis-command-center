/**
 * tests/person-engine.test.ts — O3b, "your engine and your computer's status
 * are yours": PER-PERSON engine precedence, the NO-KEY-FALLBACK rule for an
 * explicit 'computer' choice (Adon's override on the original slice design:
 * a workspace default that resolves to 'cli'/'claude' still PAUSES through
 * O1, it is never answered on the workspace key), bridgeCliPolicy's
 * forward-looking department-only-Claude rule (for O4's claim route; the OLD
 * interim workspace-tunnel path, lib/ai/bridge-turn.ts, is untouched by this
 * slice and keeps its own Codex/Gemini coverage in tests/ai-engine.test.ts),
 * and computerAnswerState's five states.
 *
 * Run: node --conditions=react-server --import tsx tests/person-engine.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "person-engine-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "person-engine-test-secret-long-enough-00000001";
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "person-engine-test-field-key-long-enough-0001";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) {
  delete process.env[k];
}

const db: Client = createClient({ url: `file:${dbFile}` });
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT_TENANT = "c2c2c2c2-0000-4000-8000-0000000000c2";
const ADON = "auth-adon-0001";
const CC = "auth-cc-0001";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent_model_config (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, agent_key TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, encrypted_api_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, computer_pairing_id TEXT, fallback_policy TEXT,
      updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_agent_model_config_default_per_agent
      ON agent_model_config (tenant_id, agent_key) WHERE user_id IS NULL;
    CREATE UNIQUE INDEX idx_agent_model_config_engine_per_user
      ON agent_model_config (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__';
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
  `);
}

async function seed() {
  for (const t of ["tenants", "agent_model_config", "bridge_pairings"]) await db.execute(`DELETE FROM ${t}`);
  await db.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis', 'OASIS')", args: [OASIS] });
  await db.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-x', 'Client X')", args: [CLIENT_TENANT] });
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

function pairingRow(opts: {
  id: string;
  tenantId: string;
  userId: string;
  label: string;
  claimEnabledAt?: string | null;
  claimStateAt?: string | null;
  claimBlockedReason?: string | null;
  claimCapacity?: number | null;
}) {
  return db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope,
            claim_enabled_at, claim_state_at, claim_blocked_reason, claim_capacity)
          VALUES (?, ?, ?, ?, 'x', 'connector', ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.tenantId,
      opts.userId,
      opts.label,
      opts.claimEnabledAt ?? null,
      opts.claimStateAt ?? null,
      opts.claimBlockedReason ?? null,
      opts.claimCapacity ?? null,
    ],
  });
}

async function main() {
  await createSchema();
  const { readEffectiveEngine, readPersonEngine, savePersonEngine, clearPersonEngine, saveAgentEngine, readAgentEngine, OASIS_DEFAULT_ENGINE } =
    await import("../lib/ai/agent-engine-store");
  const { bridgeCliPolicy } = await import("../lib/bridge-cli-policy");
  const { computerAnswerState, bestComputerAnswerState, personComputerRefusal } = await import("../lib/devices/presence");

  console.log("person-engine:");

  // ── Engine precedence: person's row > workspace row > OASIS default ────
  await check("with nothing saved anywhere, OASIS's own workspace defaults to Claude Code (the pre-O3b default), unchanged", async () => {
    const eff = await readEffectiveEngine(OASIS, ADON);
    assert.deepEqual(eff, { source: "workspace", engine: OASIS_DEFAULT_ENGINE });
  });

  await check("a non-OASIS workspace with nothing saved defaults to the API account", async () => {
    const eff = await readEffectiveEngine(CLIENT_TENANT, ADON);
    assert.deepEqual(eff, { source: "workspace", engine: { kind: "api" } });
  });

  await check("a saved WORKSPACE row beats the OASIS default", async () => {
    await saveAgentEngine(OASIS, { kind: "api" });
    const eff = await readEffectiveEngine(OASIS, ADON);
    assert.deepEqual(eff, { source: "workspace", engine: { kind: "api" } });
  });

  await check("the PERSON's own row beats the workspace row, for that person only", async () => {
    await savePersonEngine(OASIS, ADON, { kind: "computer" });
    assert.deepEqual(await readEffectiveEngine(OASIS, ADON), { source: "person", kind: "computer" });
    // CC never chose for himself: the workspace row still answers for him.
    assert.deepEqual(await readEffectiveEngine(OASIS, CC), { source: "workspace", engine: OASIS_DEFAULT_ENGINE });
  });

  await check("readPersonEngine round-trips 'api', and clearPersonEngine reverts to the workspace row", async () => {
    await savePersonEngine(OASIS, ADON, { kind: "api" });
    assert.deepEqual(await readPersonEngine(OASIS, ADON), { kind: "api" });
    await clearPersonEngine(OASIS, ADON);
    assert.equal(await readPersonEngine(OASIS, ADON), null);
    assert.deepEqual(await readEffectiveEngine(OASIS, ADON), { source: "workspace", engine: OASIS_DEFAULT_ENGINE });
  });

  // Security review (O3b): a person never opts onto the workspace AI account
  // against the owner's choice. In OASIS (a computer workspace) that would
  // spend the owner's key and undo O1's pause.
  await check("a saved 'api' choice is IGNORED where the workspace runs on computers, and honoured where the workspace runs on the key", async () => {
    await savePersonEngine(OASIS, ADON, { kind: "api" });
    assert.deepEqual(
      await readEffectiveEngine(OASIS, ADON),
      { source: "workspace", engine: OASIS_DEFAULT_ENGINE },
      "OASIS runs on computers: Adon's 'api' row must not reach the owner's key",
    );
    await saveAgentEngine(CLIENT_TENANT, { kind: "api" });
    await savePersonEngine(CLIENT_TENANT, ADON, { kind: "api" });
    assert.deepEqual(await readEffectiveEngine(CLIENT_TENANT, ADON), { source: "person", kind: "api" }, "a key workspace honours it");
    const { workspaceAllowsPersonApiChoice } = await import("../lib/ai/agent-engine-store");
    assert.equal(await workspaceAllowsPersonApiChoice(OASIS), false);
    assert.equal(await workspaceAllowsPersonApiChoice(CLIENT_TENANT), true);
  });

  await check("saving a person's choice does not touch the workspace row or another person's", async () => {
    await savePersonEngine(OASIS, ADON, { kind: "computer" });
    assert.deepEqual(await readAgentEngine(OASIS), OASIS_DEFAULT_ENGINE, "the workspace row is untouched");
    assert.deepEqual(await readEffectiveEngine(OASIS, CC), { source: "workspace", engine: OASIS_DEFAULT_ENGINE }, "CC's effective engine is untouched");
  });

  // ── Override 1 (Adon, 2026-10-11): NO KEY FALLBACK ──────────────────────
  // The original slice design's test — "an OASIS member with no computer and
  // a 'computer' workspace default is answered on the workspace key" — is
  // WRONG for OASIS. Since O1 is live, this still PAUSES: readEffectiveEngine
  // for a person who never chose for themselves returns the WORKSPACE row
  // unchanged, and lib/os/runs/session.ts's existing O1 gate (unchanged by
  // this slice) refuses a non-owner with computer_not_yours / _owner_not_set
  // / _owner_unavailable — never falls back to a key. This file cannot drive
  // the full session/profile/manifest harness (that is department-turn-owner-
  // pause.test.ts, already pinned); what IS this slice's to prove is that
  // readEffectiveEngine hands that workspace engine through UNCHANGED for a
  // person with no choice of their own, so the O1 gate still sees exactly the
  // engine it always did, and that pre-existing test's coverage still applies.
  await check("a person with no engine choice of their own gets the WORKSPACE row verbatim (O1's pause is unaffected, never a key fallback)", async () => {
    const eff = await readEffectiveEngine(OASIS, "auth-rando-member");
    assert.deepEqual(eff, { source: "workspace", engine: OASIS_DEFAULT_ENGINE }, "not api, not fallen back — exactly the pre-O3b value O1 already gates on");
  });

  // ── Override 1: an explicit 'computer' choice never falls back to the key ─
  await check("an explicit 'computer' choice with NO computer connected at all is refused computer_not_connected, never answered on a key", () => {
    assert.equal(personComputerRefusal([], Date.now()), "computer_not_connected");
  });

  await check("an explicit 'computer' choice with the computer OFFLINE is refused computer_offline, never moved to the key", () => {
    const now = Date.now();
    const offline = {
      claimEnabledAt: new Date(now - 60_000).toISOString(),
      claimStateAt: new Date(now - 5 * 60_000).toISOString(), // long past CLAIM_FRESH_MS
      claimBlockedReason: null,
      claimCapacity: 2,
    };
    assert.equal(personComputerRefusal([offline], now), "computer_offline");
  });

  await check("an explicit 'computer' choice awaiting approval is refused computer_not_approved", () => {
    const now = Date.now();
    assert.equal(personComputerRefusal([{ claimEnabledAt: null, claimStateAt: null, claimBlockedReason: null, claimCapacity: null }], now), "computer_not_approved");
  });

  await check("an explicit 'computer' choice with a blocked reason is refused computer_blocked, and the reason survives", () => {
    const now = Date.now();
    const blocked = {
      claimEnabledAt: new Date(now - 60_000).toISOString(),
      claimStateAt: new Date(now - 1000).toISOString(),
      claimBlockedReason: "subscription_auth_failure",
      claimCapacity: 2,
    };
    assert.equal(personComputerRefusal([blocked], now), "computer_blocked");
    assert.equal(computerAnswerState(blocked, now), "blocked:subscription_auth_failure");
  });

  await check("an explicit 'computer' choice with the computer busy (capacity 0) is refused computer_busy, never the key", () => {
    const now = Date.now();
    const busy = { claimEnabledAt: new Date(now - 60_000).toISOString(), claimStateAt: new Date(now - 1000).toISOString(), claimBlockedReason: null, claimCapacity: 0 };
    assert.equal(personComputerRefusal([busy], now), "computer_busy");
  });

  await check("an explicit 'computer' choice with the computer able to answer STILL refuses, honestly, until O4's dispatch ships — never a silent fallback", () => {
    const now = Date.now();
    const ready = { claimEnabledAt: new Date(now - 60_000).toISOString(), claimStateAt: new Date(now - 1000).toISOString(), claimBlockedReason: null, claimCapacity: 2 };
    assert.equal(computerAnswerState(ready, now), "can_answer");
    assert.equal(personComputerRefusal([ready], now), "computer_dispatch_not_ready", "proceeding with no executor would silently answer on whatever the workspace engine is — the exact fallback this rule forbids");
  });

  await check("two of a person's own computers: the BEST one answers for both (one offline does not refuse a person whose OTHER computer can answer)", () => {
    const now = Date.now();
    const offline = { claimEnabledAt: new Date(now - 60_000).toISOString(), claimStateAt: new Date(now - 10 * 60_000).toISOString(), claimBlockedReason: null, claimCapacity: 2 };
    const ready = { claimEnabledAt: new Date(now - 60_000).toISOString(), claimStateAt: new Date(now - 1000).toISOString(), claimBlockedReason: null, claimCapacity: 2 };
    assert.equal(bestComputerAnswerState([computerAnswerState(offline, now), computerAnswerState(ready, now)]), "can_answer");
    assert.equal(personComputerRefusal([offline, ready], now), "computer_dispatch_not_ready");
  });

  // ── getOwnComputers (lib/queries.ts): real rows, scoped to the viewer ───
  await check("getOwnComputers returns only THIS person's own non-revoked pairings, with the claim columns computerAnswerState needs", async () => {
    const { getOwnComputers } = await import("../lib/queries");
    const now = new Date().toISOString();
    await pairingRow({ id: "bp-adon-1", tenantId: OASIS, userId: ADON, label: "UPPAECHELON (Windows)", claimEnabledAt: now, claimStateAt: now, claimCapacity: 2 });
    await pairingRow({ id: "bp-cc-1", tenantId: OASIS, userId: CC, label: "CCPC (Windows)", claimEnabledAt: now, claimStateAt: now, claimCapacity: 1 });
    await db.execute({ sql: "DELETE FROM bridge_pairings WHERE id = ?", args: ["bp-revoked"] });
    await db.execute({
      sql: "INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, revoked_at) VALUES ('bp-revoked', ?, ?, 'Old laptop', 'y', ?)",
      args: [OASIS, ADON, now],
    });
    const adonComputers = await getOwnComputers(OASIS, ADON);
    assert.equal(adonComputers.length, 1, "the revoked pairing is excluded, and CC's pairing never shows up for Adon");
    assert.equal(adonComputers[0].label, "UPPAECHELON (Windows)");
    assert.equal(adonComputers[0].claimCapacity, 2);
    const ccComputers = await getOwnComputers(OASIS, CC);
    assert.equal(ccComputers.length, 1);
    assert.equal(ccComputers[0].label, "CCPC (Windows)");
  });

  // ── computerAnswerState: the five states, each on their own words ──────
  await check("computerAnswerState: not_approved, offline, blocked, busy and can_answer are five distinct states", () => {
    const now = Date.now();
    assert.equal(computerAnswerState({ claimEnabledAt: null, claimStateAt: null, claimBlockedReason: null, claimCapacity: null }, now), "not_approved");
    assert.equal(
      computerAnswerState({ claimEnabledAt: new Date(now - 1000).toISOString(), claimStateAt: null, claimBlockedReason: null, claimCapacity: 2 }, now),
      "offline",
      "approved, but no claim call ever recorded, is offline — never can_answer from a heartbeat alone",
    );
    assert.equal(
      computerAnswerState(
        { claimEnabledAt: new Date(now - 1000).toISOString(), claimStateAt: new Date(now - 500).toISOString(), claimBlockedReason: "cli_not_found", claimCapacity: 2 },
        now,
      ),
      "blocked:cli_not_found",
    );
    assert.equal(
      computerAnswerState(
        { claimEnabledAt: new Date(now - 1000).toISOString(), claimStateAt: new Date(now - 500).toISOString(), claimBlockedReason: null, claimCapacity: 0 },
        now,
      ),
      "busy",
    );
    assert.equal(
      computerAnswerState(
        { claimEnabledAt: new Date(now - 1000).toISOString(), claimStateAt: new Date(now - 500).toISOString(), claimBlockedReason: null, claimCapacity: 1 },
        now,
      ),
      "can_answer",
    );
  });

  // ── Codex and Gemini are invalid for departments ────────────────────────
  // bridgeCliPolicy's `department` flag (O3b) is forward-looking: O4's claim
  // route is the one that will call it with `{ department: true }` once a
  // person's own paired computer actually answers department work. Today
  // NOTHING live passes it — lib/ai/bridge-turn.ts is the OLD, interim
  // workspace-tunnel path (ownership_model: "Interim, until B2 ... O6 deletes
  // this branch"), explicitly out of scope for this slice, so its owner-chosen
  // CLI (including Codex/Gemini, already covered by tests/ai-engine.test.ts)
  // is deliberately left alone. What this slice proves is the PURE rule
  // itself, ready for O4 to call.
  await check("bridgeCliPolicy({department:true}): Claude Code ALWAYS, even for an owner who asked for Codex or Gemini", () => {
    assert.deepEqual(bridgeCliPolicy("owner", "codex", { department: true }), { cliProvider: "claude", disallowedTools: [] });
    assert.deepEqual(bridgeCliPolicy("owner", "gemini", { department: true }), { cliProvider: "claude", disallowedTools: [] });
    assert.deepEqual(bridgeCliPolicy("admin", "codex", { department: true }).cliProvider, "claude");
  });

  await check("bridgeCliPolicy with no department flag (today's only live caller shape) is unchanged — an owner may still pick Codex/Gemini there", () => {
    assert.deepEqual(bridgeCliPolicy("owner", "codex"), { cliProvider: "codex", disallowedTools: [] });
    assert.deepEqual(bridgeCliPolicy("owner", "gemini"), { cliProvider: "gemini", disallowedTools: [] });
    assert.equal(bridgeCliPolicy("member", "codex").cliProvider, "claude", "a non-privileged role is Claude-only regardless");
  });

  // Codex review (O3b), pinned in source.
  const ROOT_DIR = join(__dirname, "..");
  const src = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");

  await check("P1: a failed engine read refuses the send (503 config_unavailable), never an invented API choice", () => {
    const s = src("lib/os/runs/session.ts");
    assert.doesNotMatch(s, /readEffectiveEngine\([^)]*\)\.catch\(/, "no .catch that turns a failed read into a choice");
    assert.match(s, /status: 503, error: "config_unavailable"/);
  });

  await check("P2: the person-engine GET reads the workspace default on its own, whatever the person chose", () => {
    const r = src("app/api/agent-config/person-engine/route.ts");
    assert.match(r, /readAgentEngine\(tenantId\)/);
    assert.match(r, /workspaceDefault: agentsEngineLine\(workspaceEngine\)/);
    assert.doesNotMatch(r, /effective\.source === "workspace" \? effective\.engine : null/);
  });

  await check("the legacy person-engine PUT is read-only and directs writes to the canonical versioned API", () => {
    const r = src("app/api/agent-config/person-engine/route.ts");
    const put = r.slice(r.indexOf("export async function PUT"));
    assert.match(put, /error: "upgrade_required"/);
    assert.match(put, /upgrade_endpoint: "\/api\/ai\/engine"/);
    assert.match(put, /status: 410/);
    assert.doesNotMatch(put, /savePersonEngine|clearPersonEngine|parsePersonEngineChoice|workspaceAllowsPersonApiChoice/);
    assert.match(r, /export async function GET\(\)/, "legacy readers remain compatible during rollout");
    assert.match(r, /readPersonEngine\(tenantId, authUserId\)/);
  });

  await check("/health always scopes to a viewer and fails closed: no unscoped fallback, and a failed owner read is not the owner", () => {
    const h = src("app/health/page.tsx");
    assert.doesNotMatch(h, /AttentionViewer \| undefined/, "the page never passes an omitted (unscoped) viewer");
    assert.match(h, /safe\("health\.agents_owner", isAgentsOwner\(tenantId, viewerAuthId\), false\)/);
  });

  await check("P2: a failed first load of Your computers shows the error and a retry, never an endless spinner", () => {
    const c = src("components/settings/YourComputersCard.tsx");
    const errorBranch = c.indexOf("if (devices === null && error)");
    const spinner = c.indexOf("if (devices === null) {");
    assert.ok(errorBranch > 0, "an error branch for the first load exists");
    assert.ok(errorBranch < spinner, "and it comes before the loading spinner");
  });

  if (failures > 0) {
    console.log(`person-engine: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("person-engine: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
