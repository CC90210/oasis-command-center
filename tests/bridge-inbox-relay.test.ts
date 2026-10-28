/**
 * tests/bridge-inbox-relay.test.ts - the agent inbox relay, run for real against libSQL (2026-10-28).
 *
 * app/api/bridge/inbox lets the agents owner's computer deliver the operator's directives into its
 * agents' local inboxes and report them read. Pinned here:
 *   1. bravo__246 applies on the live agent_messages shape, and postMessageDb marks a directive relay
 *      eligible only for an agent with a local reader (never Aura, never without the operator's say-so);
 *   2. every gate refuses: an Origin header, no bearer, an unapproved pairing, a computer that is not the
 *      agents owner's, one that does not advertise agent_inbox_v1, a deactivated seat, a workspace that is
 *      not OASIS's own;
 *   3. pending lists only this workspace's undelivered, unread, eligible directives, oldest first;
 *   4. delivery is first writer wins, and only the computer that delivered a note may report it read;
 *   5. a malformed body is a 400, and an eleventh request in a minute is a 429.
 *
 * Run: node --conditions=react-server --import tsx tests/bridge-inbox-relay.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-inbox-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[key];

const db = createClient({ url: `file:${dbFile}` });
const OASIS = "tenant-oasis";
const CLIENT = "tenant-client";
const OWNER = "user-owner";
const MEMBER = "user-member";
const CLIENT_OWNER = "user-client-owner";
const NOW = "2026-10-28T09:00:00.000Z";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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

function statements(sql: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("--")) continue;
    buffer.push(line);
    if (line.trim().endsWith(";")) {
      out.push(buffer.join("\n").replace(/;\s*$/, ""));
      buffer = [];
    }
  }
  return out;
}

async function seed(): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT,
      bridge_token_hash TEXT NOT NULL, previous_token_hash TEXT, token_rotated_at TEXT,
      revoked_at TEXT, scope TEXT, paired_via TEXT, claim_enabled_at TEXT,
      claim_enabled_by TEXT, claim_protocols TEXT, last_seen_at TEXT, created_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, tenant_id TEXT, auth_user_id TEXT, email TEXT,
      team_role TEXT, is_owner INTEGER, admin_access INTEGER, deactivated_at TEXT,
      onboarding_completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT);
    CREATE TABLE _supabase_auth_users (id TEXT PRIMARY KEY, email TEXT, banned_until TEXT, deleted_at TEXT, session_version INTEGER);
    CREATE TABLE workspace_agents_owner (tenant_id TEXT PRIMARY KEY, auth_user_id TEXT, revoked_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT, created_at TEXT);
    -- agent_messages exactly as the live database holds it before bravo__246 (no foreign key here).
    CREATE TABLE agent_messages (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      message_id TEXT NOT NULL, tenant_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      subject TEXT, body TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
      requires_response INTEGER NOT NULL DEFAULT 0, in_reply_to TEXT, thread_id TEXT, read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (id)
    );
  `);
  // A note that existed before the migration must stay out of the relay.
  await db.execute({
    sql: "INSERT INTO agent_messages (id, message_id, tenant_id, from_agent, to_agent, body, created_at) VALUES ('old-note', 'old1', ?, 'cc', 'bravo', 'from before delivery', '2026-10-01T00:00:00.000Z')",
    args: [OASIS],
  });
  for (const statement of statements(readFileSync(join(ROOT, "database", "turso", "bravo__246_agent_messages_delivery.sql"), "utf8"))) {
    await db.execute(statement);
  }
  for (const [tenant, slug] of [[OASIS, "oasis-ai-cc"], [CLIENT, "acme-plumbing"]]) {
    await db.execute({ sql: "INSERT INTO tenants VALUES (?, ?)", args: [tenant, slug] });
  }
  for (const [id, tenant, user, role, owner, deactivated] of [
    ["p-owner", OASIS, OWNER, "owner", 1, null],
    ["p-member", OASIS, MEMBER, "member", 0, null],
    ["p-client", CLIENT, CLIENT_OWNER, "owner", 1, null],
  ] as const) {
    await db.execute({
      sql: "INSERT INTO user_profiles VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
      args: [id, tenant, user, `${user}@example.test`, role, owner, deactivated, NOW, NOW],
    });
    await db.execute({ sql: "INSERT OR IGNORE INTO _supabase_auth_users VALUES (?, ?, NULL, NULL, 0)", args: [user, `${user}@example.test`] });
  }
  await db.execute({ sql: "INSERT INTO workspace_agents_owner VALUES (?, ?, NULL)", args: [OASIS, OWNER] });
  await db.execute({ sql: "INSERT INTO workspace_agents_owner VALUES (?, ?, NULL)", args: [CLIENT, CLIENT_OWNER] });
}

async function computer(opts: { tenant?: string; user?: string; approved?: boolean; protocols?: string[]; label?: string } = {}) {
  const id = `pair-${randomUUID()}`;
  const token = `oab_${randomUUID()}`;
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope, paired_via, claim_enabled_at, claim_enabled_by, claim_protocols, last_seen_at, created_at)
          VALUES (?, ?, ?, ?, ?, 'connector', 'pair_code', ?, ?, ?, ?, ?)`,
    args: [
      id,
      opts.tenant ?? OASIS,
      opts.user ?? OWNER,
      opts.label ?? "CC's Mac",
      sha256(token),
      opts.approved === false ? null : NOW,
      opts.user ?? OWNER,
      JSON.stringify(opts.protocols ?? ["department_task_v2", "agent_inbox_v1"]),
      NOW,
      NOW,
    ],
  });
  return { id, token };
}

function request(method: "GET" | "POST", verb: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return {
    req: new NextRequest(`https://app.test/api/bridge/inbox/${verb}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ path: [verb] }) },
  };
}

async function main(): Promise<void> {
  await seed();
  const route = await import("../app/api/bridge/inbox/[[...path]]/route");
  const inbox = await import("../lib/agent-inbox-db");
  type Json = { ok?: boolean; error?: string; messages?: Array<{ id: string; to: string; body: string; message_id: string }>; delivered?: string[]; acked?: string[] };
  const call = async (method: "GET" | "POST", verb: string, token: string | null, body?: unknown, headers?: Record<string, string>) => {
    const { req, ctx } = request(method, verb, token, body, headers);
    const res = method === "GET" ? await route.GET(req, ctx) : await route.POST(req, ctx);
    return { status: res.status, json: (await res.json()) as Json };
  };
  const row = async (id: string) =>
    (await db.execute({ sql: "SELECT * FROM agent_messages WHERE id = ?", args: [id] })).rows[0] as unknown as Record<string, unknown>;

  console.log("bridge-inbox-relay:");

  await check("bravo__246 keeps a pre-existing note out of the relay", async () => {
    assert.equal(Number((await row("old-note")).relay_eligible), 0);
  });

  // Directives, in posting order.
  const post = (to: string, body: string, relayEligible: boolean, tenantId = OASIS) =>
    inbox.postMessageDb({ tenantId, from: "cc", to, subject: body, body, relayEligible });
  const first = await post("bravo", "first directive", true);
  await new Promise((r) => setTimeout(r, 5));
  const second = await post("maven", "second directive", true);
  const aura = await post("aura", "aura has no reader", true);
  const agentNote = await post("bravo", "an agent's note", false);
  const dismissed = await post("atlas", "dismissed before delivery", true);
  const elsewhere = await post("bravo", "another workspace", true, CLIENT);
  await check("postMessageDb: eligible only for an agent with a local reader, and only when asked", async () => {
    for (const r of [first, second, aura, agentNote, dismissed, elsewhere]) assert.ok(r.ok, r.error);
    assert.equal(Number((await row(first.message!.id)).relay_eligible), 1);
    assert.equal(Number((await row(aura.message!.id)).relay_eligible), 0, "Aura has no local reader");
    assert.equal(Number((await row(agentNote.message!.id)).relay_eligible), 0, "a note nobody asked to relay stays put");
  });
  await inbox.markReadDb(OASIS, dismissed.message!.id, "dashboard");

  const mac = await computer({ label: "CC's Mac" });
  const laptop = await computer({ label: "Spare laptop" });

  await check("gates: Origin header, no bearer, unknown path", async () => {
    assert.equal((await call("GET", "pending", mac.token, undefined, { origin: "https://evil.test" })).status, 403);
    assert.equal((await call("GET", "pending", null)).status, 401);
    const { req, ctx } = request("GET", "nope", mac.token);
    assert.equal((await route.GET(req, { ...ctx, params: Promise.resolve({ path: ["nope"] }) })).status, 404);
  });
  await check("gates: unapproved, not the agents owner, no agent_inbox_v1, not OASIS, deactivated seat", async () => {
    const unapproved = await computer({ approved: false });
    assert.deepEqual((await call("GET", "pending", unapproved.token)).json.error, "not_approved");
    const members = await computer({ user: MEMBER });
    assert.deepEqual((await call("GET", "pending", members.token)).json.error, "agents_owner_only");
    const oldBridge = await computer({ protocols: ["department_task_v2"] });
    const old = await call("GET", "pending", oldBridge.token);
    assert.equal(old.status, 400);
    assert.equal(old.json.error, "unsupported_protocol");
    const client = await computer({ tenant: CLIENT, user: CLIENT_OWNER });
    assert.deepEqual((await call("GET", "pending", client.token)).json.error, "oasis_workspace_only");
    await db.execute("UPDATE user_profiles SET deactivated_at = '2026-10-28T08:00:00.000Z' WHERE id = 'p-owner'");
    try {
      const gone = await computer();
      assert.deepEqual((await call("GET", "pending", gone.token)).json.error, "seat_inactive");
    } finally {
      await db.execute("UPDATE user_profiles SET deactivated_at = NULL WHERE id = 'p-owner'");
    }
  });

  await check("pending: this workspace's undelivered, unread, eligible directives, oldest first", async () => {
    const res = await call("GET", "pending", mac.token);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json.messages!.map((m) => m.body), ["first directive", "second directive"]);
    assert.deepEqual(res.json.messages![0], {
      ...res.json.messages![0],
      id: first.message!.id,
      to: "bravo",
      message_id: first.message!.message_id,
    });
  });

  await check("delivered: first writer wins, and the stamp names the computer", async () => {
    const won = await call("POST", "delivered", mac.token, { ids: [first.message!.id] });
    assert.deepEqual(won.json.delivered, [first.message!.id]);
    const lost = await call("POST", "delivered", laptop.token, { ids: [first.message!.id, second.message!.id] });
    assert.deepEqual(lost.json.delivered, [second.message!.id], "the laptop wins only what nobody delivered yet");
    const stamped = await row(first.message!.id);
    assert.equal(stamped.delivered_pairing_id, mac.id);
    assert.equal(stamped.delivered_label, "CC's Mac");
    assert.ok(stamped.delivered_at);
    assert.deepEqual((await call("GET", "pending", mac.token)).json.messages, [], "nothing left to deliver");
    const noOne = await call("POST", "delivered", mac.token, { ids: [agentNote.message!.id, elsewhere.message!.id] });
    assert.deepEqual(noOne.json.delivered, [], "an ineligible note and another workspace's are never stamped");
  });

  await check("acked: only the computer that delivered a note may say it was read, once", async () => {
    const wrong = await call("POST", "acked", laptop.token, { ids: [first.message!.id] });
    assert.deepEqual(wrong.json.acked, []);
    const right = await call("POST", "acked", mac.token, { ids: [first.message!.id] });
    assert.deepEqual(right.json.acked, [first.message!.id]);
    const read = await row(first.message!.id);
    assert.ok(read.acked_at && read.read_at);
    assert.equal(read.read_via, "agent");
    assert.deepEqual((await call("POST", "acked", mac.token, { ids: [first.message!.id] })).json.acked, [], "once");
  });

  await check("a malformed body is a 400", async () => {
    const shaky = await computer({ label: "Shaky" });
    for (const body of ["{nope", { ids: [] }, { ids: ["x"], extra: 1 }, { ids: ["../etc"] }, { ids: Array.from({ length: 21 }, (_, i) => `id-${i}`) }]) {
      const res = await call("POST", "delivered", shaky.token, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  await check("an eleventh request in a minute is a 429", async () => {
    const busy = await computer({ label: "Busy" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await call("GET", "pending", busy.token)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429);
  });

  console.log(`bridge-inbox-relay: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
