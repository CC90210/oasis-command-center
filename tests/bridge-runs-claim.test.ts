/**
 * tests/bridge-runs-claim.test.ts - POST /api/bridge/runs/claim (O4 pull
 * dispatch), the route itself: auth, approval, agents-owner-only for a
 * daemon pairing, seat liveness, the state-stamp rate limit, the claim
 * compare-and-swap, the idempotent retry, and claim_already_started.
 *
 * Real libSQL file: bravo__192 / bravo__207 / bravo__213 (Turso side) plus
 * the Supabase-shim tables the pairing/seat/viewer checks read (same file,
 * same client in test mode -- confirmed by tests/pairing-ownership.test.ts's
 * schema, reused here). The tenant is seeded with slug 'suga', an
 * IN-CODE seed manifest (lib/manifest/seeds.ts) that already binds
 * department 'sales' to agent 'sdr' -- no tenant_manifests or agents row
 * needed for a real, successful claim to build a full turn.
 *
 * Run: node --conditions=react-server --import tsx tests/bridge-runs-claim.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-runs-claim-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "bridge-runs-claim-test-master-secret-32-chars-min";
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "bridge-runs-claim-test-field-key-long-enough-01";
// A credential-shaped env value (lib/secret-redaction.ts loadPairs caches the
// process.env scan on its FIRST call, so this must be set before any check
// exercises a scrub path, never inside an individual check).
const PASTED_CREDENTIAL = "sk-claim-test-pasted-credential-0123456789abcdef";
process.env.CLAIM_FIXTURE_API_KEY = PASTED_CREDENTIAL;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "OASIS_RUN_TOKEN_KEY", "OASIS_MCP_TOKEN_KID"]) {
  delete process.env[k];
}

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
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
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const db: Client = createClient({ url: `file:${dbFile}` });

const TENANT = "f4f4f4f4-0000-4000-8000-0000000000f4";
const OWNER_ID = "auth-claim-owner-0001"; // the workspace's agents owner
const MEMBER_ID = "auth-claim-member-0001"; // a plain member with their own connector
const OTHER_MEMBER_ID = "auth-claim-other-0001";
const stamp = "2026-10-11T00:00:00.000Z";

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

async function createSchema() {
  for (const file of ["bravo__192_ai_usage.sql", "bravo__207_department_chat_runs.sql", "bravo__213_dept_runs_computer.sql"]) {
    for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", file), "utf8"))) await db.execute(stmt);
  }
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN target_pairing_id TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_kind TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_name TEXT");
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE workspace_agents_owner (
      tenant_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL, set_by TEXT NOT NULL,
      set_at TEXT NOT NULL, note TEXT, revoked_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claude_account_hash TEXT, claim_state_at TEXT, claim_capacity INTEGER, claim_in_flight INTEGER,
      claim_blocked_reason TEXT, last_claim_ip TEXT, previous_token_hash TEXT, token_rotated_at TEXT,
      last_poll_ok_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE tenant_manifests (slug TEXT, tenant_id TEXT, manifest TEXT, updated_at TEXT);
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      service TEXT, field_key TEXT, encrypted_value TEXT, created_at TEXT, updated_at TEXT);
  `);
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'suga', 'Suga Test Workspace')", args: [TENANT] },
      ...[
        [OWNER_ID, "owner@claim-test.oasis"],
        [MEMBER_ID, "member@claim-test.oasis"],
        [OTHER_MEMBER_ID, "other@claim-test.oasis"],
      ].map(([id, email]) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [id, email] })),
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-claim-owner', ?, 'owner@claim-test.oasis', ?, 'owner', 1, 'Owner', ?, ?)`,
        args: [OWNER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-claim-member', ?, 'member@claim-test.oasis', ?, 'member', 0, 'Member', ?, ?)`,
        args: [MEMBER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-claim-other', ?, 'other@claim-test.oasis', ?, 'member', 0, 'Other', ?, ?)`,
        args: [OTHER_MEMBER_ID, TENANT, stamp, stamp],
      },
      { sql: `INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'test', ?)`, args: [TENANT, OWNER_ID, stamp] },
    ],
    "write",
  );
}

let memberSeq = 0;
/**
 * A brand-new member of TENANT, so a check that cares about queue contents
 * (claimComputerRun claims a PERSON's earliest queued computer run, across
 * every conversation they have) never sees another check's leftover queued
 * or deliberately-unclaimed run for the SAME person.
 */
async function freshMember(): Promise<string> {
  memberSeq += 1;
  const id = `auth-claim-fresh-${memberSeq}`;
  await db.execute({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [id, `fresh-${memberSeq}@claim-test.oasis`] });
  await db.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, 'member', 0, 'Fresh', ?, ?)`,
    args: [`p-claim-fresh-${memberSeq}`, id, `fresh-${memberSeq}@claim-test.oasis`, TENANT, stamp, stamp],
  });
  return id;
}

let pairingSeq = 0;
/** A fresh bridge_pairings row, so no test's rate-limit stamp or revocation leaks into another's. */
async function makePairing(opts: { userId: string | null; scope: "connector" | "daemon" | null; approved?: boolean; claudeAccountHash?: string | null }) {
  pairingSeq += 1;
  const id = `bp-claim-${pairingSeq}`;
  const token = `oab_claim_test_${pairingSeq}_${randomUUID()}`;
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope, paired_via, claim_enabled_at, claim_enabled_by, claude_account_hash)
          VALUES (?, ?, ?, ?, ?, ?, 'pair_code', ?, ?, ?)`,
    args: [
      id,
      TENANT,
      opts.userId,
      `Claim test computer ${pairingSeq}`,
      sha256(token),
      opts.scope,
      opts.approved === false ? null : stamp,
      opts.approved === false ? null : (opts.userId ?? "test"),
      opts.claudeAccountHash ?? null,
    ],
  });
  return { id, token };
}

async function enqueueComputerRun(userId: string, text = "hi from the test") {
  const store = await import("../lib/os/runs/store");
  const scope = { tenantId: TENANT, userId };
  const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: new Date() });
  const q = await store.enqueueRun(db, scope, { conversationId: conv.id, text, chatMode: "build", showThinking: false, now: new Date(), executor: "computer" });
  assert.ok(q.ok);
  return { conv, run: q.ok ? q.run : null };
}

function body(claimId: string, over: Partial<{ protocol: string; capacity: number; in_flight: number; blocked_reason: string | null; wait_ms: number; claude_account_hash: string }> = {}) {
  return {
    protocol: over.protocol ?? "department_task_v1",
    claim_id: claimId,
    capacity: over.capacity ?? 2,
    in_flight: over.in_flight ?? 0,
    blocked_reason: over.blocked_reason ?? null,
    wait_ms: over.wait_ms ?? 0,
    ...(over.claude_account_hash ? { claude_account_hash: over.claude_account_hash } : {}),
  };
}

async function claim(token: string | null, claimBody: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest("https://oasisai.work/api/bridge/runs/claim", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(claimBody),
  });
  const res = await route.POST(req);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

let route: typeof import("../app/api/bridge/runs/claim/route");

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 10).join("\n        ")}`);
  }
}

const realError = console.error;
console.error = () => undefined;

async function main() {
  await createSchema();
  route = await import("../app/api/bridge/runs/claim/route");

  console.log("bridge-runs-claim:");

  await check("an Origin header is refused, even with a valid bearer", async () => {
    const { token } = await makePairing({ userId: MEMBER_ID, scope: "connector" });
    const r = await claim(token, body(randomUUID()), { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });
  await check("no bearer, or an unknown one, is 401", async () => {
    assert.equal((await claim(null, body(randomUUID()))).status, 401);
    assert.equal((await claim("oab_not_a_real_token", body(randomUUID()))).status, 401);
  });
  await check("a revoked pairing is refused (the live code: 403 pairing_revoked, never a silent pass)", async () => {
    const { id, token } = await makePairing({ userId: MEMBER_ID, scope: "connector" });
    await db.execute({ sql: `UPDATE bridge_pairings SET revoked_at = ? WHERE id = ?`, args: [stamp, id] });
    const r = await claim(token, body(randomUUID()));
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "pairing_revoked");
  });
  await check("an unapproved computer cannot claim (403 not_approved)", async () => {
    const { token } = await makePairing({ userId: MEMBER_ID, scope: "connector", approved: false });
    const r = await claim(token, body(randomUUID()));
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "not_approved");
  });
  await check("a pairing with no person at all is refused 409 pairing_has_no_owner", async () => {
    const { token } = await makePairing({ userId: null, scope: "connector" });
    const r = await claim(token, body(randomUUID()));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "pairing_has_no_owner");
  });
  await check("a daemon pairing whose person is NOT the workspace's agents owner is refused 403 agents_owner_only", async () => {
    const { token } = await makePairing({ userId: MEMBER_ID, scope: "daemon" });
    const r = await claim(token, body(randomUUID()));
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "agents_owner_only");
  });
  await check("a daemon pairing for the actual agents owner is allowed through the gate (reaches the claim attempt, not refused at auth)", async () => {
    const { token } = await makePairing({ userId: OWNER_ID, scope: "daemon" });
    const r = await claim(token, body(randomUUID(), { wait_ms: 0 }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, run: null }, "nothing was ever enqueued for the owner in this check");
  });
  await check("an inactive (deactivated) seat is refused 403 seat_inactive, with an otherwise-valid approved pairing", async () => {
    const { token } = await makePairing({ userId: MEMBER_ID, scope: "connector" });
    await db.execute({ sql: `UPDATE user_profiles SET deactivated_at = ? WHERE auth_user_id = ? AND tenant_id = ?`, args: [stamp, MEMBER_ID, TENANT] });
    try {
      const r = await claim(token, body(randomUUID()));
      assert.equal(r.status, 403);
      assert.equal(r.json.error, "seat_inactive");
    } finally {
      await db.execute({ sql: `UPDATE user_profiles SET deactivated_at = NULL WHERE auth_user_id = ? AND tenant_id = ?`, args: [MEMBER_ID, TENANT] });
    }
  });
  await check("an unsupported protocol, or a missing claim_id, is 400", async () => {
    const { token } = await makePairing({ userId: MEMBER_ID, scope: "connector" });
    assert.equal((await claim(token, { ...body(randomUUID()), protocol: "infer_v1" })).status, 400);
    assert.equal((await claim(token, { ...body(randomUUID()), claim_id: "" })).status, 400);
  });
  await check("a computer that reports zero capacity, or a blocked reason, gets no work and does not even attempt the CAS", async () => {
    const member = await freshMember();
    const owner = await makePairing({ userId: member, scope: "connector" });
    const { run } = await enqueueComputerRun(member);
    assert.ok(run);
    const zeroCapacity = await claim(owner.token, body(randomUUID(), { capacity: 0 }));
    assert.deepEqual(zeroCapacity.json, { ok: true, run: null });
    // Backdate the rate limit so the SAME computer may call again at once.
    await db.execute({ sql: `UPDATE bridge_pairings SET claim_state_at = ? WHERE id = ?`, args: [new Date(Date.now() - 5000).toISOString(), owner.id] });
    const blocked = await claim(owner.token, body(randomUUID(), { blocked_reason: "cli_not_found" }));
    assert.deepEqual(blocked.json, { ok: true, run: null });
    // The run is still queued, untouched by either call: it never attempted to claim.
    const row = await db.execute({ sql: `SELECT status FROM dept_chat_runs WHERE id = ?`, args: [run!.id] });
    assert.equal(row.rows[0].status, "queued");
  });
  await check("the state stamp + rate limit: a second claim call inside 1 second is 429 claim_too_fast", async () => {
    const { token } = await makePairing({ userId: await freshMember(), scope: "connector" });
    const first = await claim(token, body(randomUUID()));
    assert.equal(first.status, 200);
    const second = await claim(token, body(randomUUID()));
    assert.equal(second.status, 429);
    assert.equal(second.json.error, "claim_too_fast");
  });
  await check("a claude_account_hash that differs from the one recorded at approval overrides blocked_reason to claude_account_changed, recorded on the pairing row", async () => {
    const member = await freshMember();
    const { id, token } = await makePairing({ userId: member, scope: "connector", claudeAccountHash: "approved-hash-abc" });
    const { run } = await enqueueComputerRun(member);
    assert.ok(run);
    const r = await claim(token, body(randomUUID(), { claude_account_hash: "a-different-hash-xyz" }));
    assert.deepEqual(r.json, { ok: true, run: null }, "the override blocks the claim even though capacity was 2");
    const row = await db.execute({ sql: `SELECT claim_blocked_reason FROM bridge_pairings WHERE id = ?`, args: [id] });
    assert.equal(row.rows[0].claim_blocked_reason, "claude_account_changed");
  });

  console.log("Claiming a real run: the CAS, the turn it builds, idempotency, claim_already_started");
  await check("Ann's computer can never claim Ben's run, and the reverse", async () => {
    const annId = await freshMember();
    const benId = await freshMember();
    const annComputer = await makePairing({ userId: annId, scope: "connector" });
    const benComputer = await makePairing({ userId: benId, scope: "connector" });
    const ann = await enqueueComputerRun(annId, "ann's message");
    const ben = await enqueueComputerRun(benId, "ben's message");
    assert.ok(ann.run && ben.run);

    const annResult = await claim(annComputer.token, body(randomUUID()));
    assert.equal(annResult.status, 200);
    const annRun = (annResult.json.run ?? null) as { id: string } | null;
    assert.ok(annRun);
    assert.equal(annRun!.id, ann.run!.id, "Ann's computer claimed exactly Ann's run, never Ben's");

    const benResult = await claim(benComputer.token, body(randomUUID()));
    assert.equal(benResult.status, 200);
    const benRun = (benResult.json.run ?? null) as { id: string } | null;
    assert.ok(benRun);
    assert.equal(benRun!.id, ben.run!.id);
  });
  await check("a claimed run's body: the real department block, the run token, the pinned MCP URL, the palette, max_turns 24", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const { run } = await enqueueComputerRun(member, "build me a real turn");
    assert.ok(run);
    const r = await claim(pairing.token, body(randomUUID()));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const claimed = r.json.run as Record<string, unknown>;
    assert.equal(claimed.id, run!.id);
    assert.equal(claimed.protocol, "department_task_v1");
    assert.equal(claimed.cli, "claude");
    assert.equal(claimed.origin, "chat");
    assert.equal(claimed.max_turns, 24);
    assert.ok(claimed.claim_id);
    assert.match(String(claimed.events_url), new RegExp(`/api/os/runs/${run!.id}/events$`));
    assert.ok(claimed.deadline_at);
    assert.ok(typeof claimed.run_token === "string" && claimed.run_token.startsWith("orun1."));
    assert.ok(typeof claimed.system === "string" && claimed.system.length > 0);
    assert.match(String(claimed.prompt), /build me a real turn/);
    assert.ok(Array.isArray(claimed.allowed_tools) && (claimed.allowed_tools as unknown[]).length > 0);
    const dept = claimed.department as Record<string, unknown>;
    assert.equal(dept.name, "sales");
    assert.equal(dept.mcp_url, "https://oasisai.work/api/mcp");
    assert.equal(dept.sid, run!.conversationId);
    assert.equal(dept.history_hash, "");
    assert.ok(typeof dept.token === "string" && dept.token.startsWith("omcp1."));
    assert.equal(dept.profile, "propose", "build mode (the default chatMode) proposes, plan mode reads");
    // The run row itself now shows running/producer, deadline set, claimed by this pairing.
    const row = await db.execute({ sql: `SELECT status, source, executor, claimed_pairing_id, deadline_at FROM dept_chat_runs WHERE id = ?`, args: [run!.id] });
    assert.deepEqual(
      [row.rows[0].status, row.rows[0].source, row.rows[0].executor, row.rows[0].claimed_pairing_id],
      ["running", "producer", "computer", pairing.id],
    );
    assert.ok(row.rows[0].deadline_at);
  });
  await check("department_task_v2 keeps the exact tested pairing and Codex runtime through claim, with a read-only sandbox", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    await db.execute({
      sql: "UPDATE bridge_pairings SET claim_protocols = ? WHERE id = ?",
      args: [JSON.stringify(["department_task_v1", "department_task_v2"]), pairing.id],
    });
    const store = await import("../lib/os/runs/store");
    const scope = { tenantId: TENANT, userId: member };
    const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: new Date() });
    const queued = await store.enqueueRun(db, scope, {
      conversationId: conv.id,
      text: "answer with Codex on this computer",
      chatMode: "build",
      showThinking: false,
      now: new Date(),
      executor: "computer",
      targetPairingId: pairing.id,
      runtimeEngineKind: "cli",
      runtimeEngineName: "codex",
    });
    assert.ok(queued.ok);
    const response = await claim(pairing.token, body(randomUUID(), { protocol: "department_task_v2" }));
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const run = response.json.run as Record<string, unknown>;
    assert.equal(run.protocol, "department_task_v2");
    assert.deepEqual(run.engine, { kind: "cli", name: "codex" });
    assert.deepEqual(run.sandbox, { mode: "read_only", repo_writes: false });
    assert.equal(run.cli, undefined, "v2 never falls back to v1's hard-coded Claude field");
    const builder = readFileSync(join(ROOT, "lib/os/runs/computer-turn.ts"), "utf8");
    assert.match(
      builder,
      /engineInput:\s*\{\s*kind:\s*"computer",\s*label,\s*engine:\s*runtime\.engine\s*\}/,
      "the same snapshotted runtime used in the claim payload must prepare the turn metadata",
    );
  });
  await check("a pasted credential-shaped string in the message never reaches the claim payload (env-secret redaction, [P1] Codex finding)", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const { run } = await enqueueComputerRun(member, `Here is my key, please use it: ${PASTED_CREDENTIAL}`);
    assert.ok(run);
    const r = await claim(pairing.token, body(randomUUID()));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const claimed = r.json.run as Record<string, unknown>;
    assert.doesNotMatch(String(claimed.prompt), /sk-claim-test-pasted-credential/, "the credential reached the prompt unredacted");
    assert.doesNotMatch(String(claimed.system), /sk-claim-test-pasted-credential/, "the credential reached the system prompt unredacted");
    assert.match(String(claimed.prompt), /\[REDACTED:CLAIM_FIXTURE_API_KEY\]/);
  });
  await check("a tenant-vault secret in the conversation is also scrubbed from the claim payload, and an undecryptable vault entry refuses the whole claim rather than send a partial scrub", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const { encryptField } = await import("../lib/field-encryption");
    const vaultValue = "vault-claim-test-secret-zyxwvutsrqpo";
    await db.execute({
      sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value, created_at, updated_at) VALUES (?, 'custom', 'claim_vault_key', ?, ?, ?)`,
      args: [TENANT, encryptField(vaultValue), stamp, stamp],
    });
    try {
      const { run } = await enqueueComputerRun(member, `My vault value is ${vaultValue}, use it`);
      assert.ok(run);
      const r = await claim(pairing.token, body(randomUUID()));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const claimed = r.json.run as Record<string, unknown>;
      assert.doesNotMatch(String(claimed.prompt), /vault-claim-test-secret/);

      // Now break the SAME workspace's vault (one undecryptable entry) and
      // claim a SECOND message: the whole claim must refuse, never send a
      // scrub covering only the entry that happened to decrypt.
      await db.execute({
        sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value, created_at, updated_at) VALUES (?, 'custom', 'claim_broken_key', 'not-a-ciphertext', ?, ?)`,
        args: [TENANT, stamp, stamp],
      });
      try {
        const second = await enqueueComputerRun(member, "a second message, while the vault is broken");
        assert.ok(second.run);
        await db.execute({ sql: `UPDATE bridge_pairings SET claim_state_at = ? WHERE id = ?`, args: [new Date(Date.now() - 5000).toISOString(), pairing.id] });
        const refused = await claim(pairing.token, body(randomUUID()));
        assert.deepEqual(refused.json, { ok: true, run: null }, "the claim route must refuse a run rather than send a partially-scrubbed prompt");
        const row = await db.execute({ sql: `SELECT status, error_code FROM dept_chat_runs WHERE id = ?`, args: [second.run!.id] });
        assert.deepEqual([row.rows[0].status, row.rows[0].error_code], ["failed", "scrub_unavailable"]);
      } finally {
        await db.execute("DELETE FROM tenant_integration_credentials WHERE field_key = 'claim_broken_key'");
      }
    } finally {
      await db.execute("DELETE FROM tenant_integration_credentials WHERE field_key = 'claim_vault_key'");
    }
  });
  // Security review (O4): exact-value redaction cannot recognise a secret that
  // a clip cut in half, so the scrub must run BEFORE any clip. A secret that
  // straddles the 2,000-character history clip must leave no fragment.
  await check("a vault secret straddling the history clip boundary is scrubbed before the clip: no fragment of it reaches the computer", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const { encryptField } = await import("../lib/field-encryption");
    const vaultValue = "straddle-vault-secret-qrstuvwxyz0123";
    await db.execute({
      sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value, created_at, updated_at) VALUES (?, 'custom', 'claim_straddle_key', ?, ?, ?)`,
      args: [TENANT, encryptField(vaultValue), stamp, stamp],
    });
    try {
      const first = await enqueueComputerRun(member, `${"x".repeat(1990)}${vaultValue} trailing words`);
      assert.ok(first.run);
      await db.execute({ sql: "UPDATE dept_chat_runs SET status = 'done', final_text = 'noted' WHERE id = ?", args: [first.run!.id] });
      const store = await import("../lib/os/runs/store");
      const q = await store.enqueueRun(db, { tenantId: TENANT, userId: member }, {
        conversationId: first.conv.id, text: "what did I say before?", chatMode: "build", showThinking: false, now: new Date(), executor: "computer",
      });
      assert.ok(q.ok);
      const r = await claim(pairing.token, body(randomUUID()));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const prompt = String((r.json.run as Record<string, unknown>).prompt);
      assert.doesNotMatch(prompt, /straddle-v/, "no fragment of the secret survives the clip");
    } finally {
      await db.execute("DELETE FROM tenant_integration_credentials WHERE field_key = 'claim_straddle_key'");
    }
  });

  await check("plan mode claims a 'read' profile, never 'propose'", async () => {
    const store = await import("../lib/os/runs/store");
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const scope = { tenantId: TENANT, userId: member };
    const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: new Date() });
    const q = await store.enqueueRun(db, scope, { conversationId: conv.id, text: "just reading", chatMode: "plan", showThinking: false, now: new Date(), executor: "computer" });
    assert.ok(q.ok);
    const r = await claim(pairing.token, body(randomUUID()));
    assert.equal(r.status, 200);
    const dept = (r.json.run as Record<string, unknown>).department as Record<string, unknown>;
    assert.equal(dept.profile, "read");
  });
  await check("a lost claim answer retried with the same claim_id gets the same run again, with fresh tokens", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const { run } = await enqueueComputerRun(member, "retry me through the route");
    assert.ok(run);
    const claimId = randomUUID();
    const first = await claim(pairing.token, body(claimId));
    assert.equal(first.status, 200);
    await db.execute({ sql: `UPDATE bridge_pairings SET claim_state_at = ? WHERE id = ?`, args: [new Date(Date.now() - 5000).toISOString(), pairing.id] });
    const second = await claim(pairing.token, body(claimId));
    assert.equal(second.status, 200);
    const firstRun = first.json.run as Record<string, unknown>;
    const secondRun = second.json.run as Record<string, unknown>;
    assert.equal(secondRun.id, firstRun.id);
    // "Fresh tokens" means freshly MINTED, not necessarily byte-different:
    // two mints inside the same wall-clock second produce the identical
    // HMAC-signed credential by construction (no nonce). Both must still be
    // independently valid for this run right now.
    const auth = await import("../lib/os/runs/producer-auth");
    const key = await auth.runSigningKey();
    assert.ok(key);
    const verified = await auth.verifyRunCredential(key!, String(secondRun.run_token));
    assert.ok(verified.ok && verified.claims.rid === firstRun.id);
  });
  await check("once the computer has posted an event under a claim_id, retrying that claim_id is 409 claim_already_started", async () => {
    const store = await import("../lib/os/runs/store");
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const { run } = await enqueueComputerRun(member, "started already");
    assert.ok(run);
    const claimId = randomUUID();
    const first = await claim(pairing.token, body(claimId));
    assert.equal(first.status, 200);
    await store.appendEvents(db, { tenantId: TENANT, userId: member }, run!.id, [{ seq: 100, kind: "status", data: { phase: "thinking", label: "Working" } }], new Date());
    await db.execute({ sql: `UPDATE bridge_pairings SET claim_state_at = ? WHERE id = ?`, args: [new Date(Date.now() - 5000).toISOString(), pairing.id] });
    const second = await claim(pairing.token, body(claimId));
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "claim_already_started");
  });
  await check("nothing to claim: a short wait_ms long-polls briefly, then {ok:true, run:null}", async () => {
    const { token } = await makePairing({ userId: await freshMember(), scope: "connector" });
    const started = Date.now();
    const r = await claim(token, body(randomUUID(), { wait_ms: 500 }));
    assert.deepEqual(r.json, { ok: true, run: null });
    assert.ok(Date.now() - started < 10_000, "the long-poll must not hang far past wait_ms");
  });

  console.log("Revocation during the long-poll ([P1] Codex finding)");
  await check("a pairing revoked WHILE its claim request is long-polling claims nothing, even once work arrives", async () => {
    const member = await freshMember();
    const pairing = await makePairing({ userId: member, scope: "connector" });
    const claimId = randomUUID();
    // Nothing is queued yet: the first (immediate) attempt finds nothing and
    // the request enters its poll loop (POLL_EVERY_MS = 2000, wait_ms = 3000
    // guarantees exactly one 2s sleep before the deadline).
    const claimPromise = claim(pairing.token, body(claimId, { wait_ms: 3000 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The computer is disconnected MID-WAIT (its pairing is revoked), and
    // only THEN does new work arrive for this person -- exactly the order
    // the finding describes: a newly queued message during the poll.
    await db.execute({ sql: `UPDATE bridge_pairings SET revoked_at = ? WHERE id = ?`, args: [new Date().toISOString(), pairing.id] });
    const { run } = await enqueueComputerRun(member, "arrives after the pairing was revoked, mid-poll");
    assert.ok(run);
    const result = await claimPromise;
    assert.deepEqual(result.json, { ok: true, run: null }, "a revoked pairing must claim nothing, even though work existed to claim");
    // Nobody's revoked pairing silently consumed it: the run is still queued.
    const row = await db.execute({ sql: `SELECT status, claimed_pairing_id FROM dept_chat_runs WHERE id = ?`, args: [run!.id] });
    assert.equal(row.rows[0].status, "queued");
    assert.equal(row.rows[0].claimed_pairing_id, null);
  });
  await check("pairingLiveForClaim: the SECOND re-check buildAndRespond runs, in direct isolation (revoked / de-approved / signup_secret / missing / live)", async () => {
    // The claim route's own top-level gates (resolvePairingFromBearer,
    // pairingCanClaim) already catch a revoked or de-approved pairing on
    // the VERY NEXT request -- that is what the long-poll test above
    // exercises end to end. The narrower window this finding also names
    // ("again before building the response") is the few milliseconds
    // between a successful claim/lookup and the response being built,
    // WITHIN the same request: too small to force deterministically without
    // mocking, so this tests the exact mechanism buildAndRespond calls
    // (pairingLiveForClaim) directly, over every state it must get right.
    const { pairingLiveForClaim } = await import("../lib/bridge/pairing-auth");
    const approved = await makePairing({ userId: await freshMember(), scope: "connector" });
    assert.equal(await pairingLiveForClaim(approved.id), true);

    const revoked = await makePairing({ userId: await freshMember(), scope: "connector" });
    await db.execute({ sql: `UPDATE bridge_pairings SET revoked_at = ? WHERE id = ?`, args: [stamp, revoked.id] });
    assert.equal(await pairingLiveForClaim(revoked.id), false);

    const deApproved = await makePairing({ userId: await freshMember(), scope: "connector" });
    await db.execute({ sql: `UPDATE bridge_pairings SET claim_enabled_at = NULL, claim_enabled_by = NULL WHERE id = ?`, args: [deApproved.id] });
    assert.equal(await pairingLiveForClaim(deApproved.id), false);

    const signup = await makePairing({ userId: await freshMember(), scope: "connector" });
    await db.execute({ sql: `UPDATE bridge_pairings SET paired_via = 'signup_secret' WHERE id = ?`, args: [signup.id] });
    assert.equal(await pairingLiveForClaim(signup.id), false, "a signup_secret pairing can never be approved for claiming, however claim_enabled_at reads");

    assert.equal(await pairingLiveForClaim("no-such-pairing-id"), false);
    assert.equal(await pairingLiveForClaim(""), false);
  });
  await check("buildAndRespond still calls the re-check (source pin, since the exact few-millisecond race is not reproducible on demand)", () => {
    const src = readFileSync(join(ROOT, "app/api/bridge/runs/claim/route.ts"), "utf8");
    assert.match(src, /pairingLiveForClaim\(/, "buildAndRespond must re-validate the pairing before building the response");
    const buildAndRespondBody = src.slice(src.indexOf("async function buildAndRespond"), src.indexOf("export async function POST"));
    assert.match(buildAndRespondBody, /pairingLiveForClaim\(/, "the re-check must live INSIDE buildAndRespond, not only at the route's top-level gate");
  });

  console.error = realError;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error = realError;
  console.error(err);
  process.exit(1);
});
