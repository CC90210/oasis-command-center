/**
 * texttorrent-handoff-deactivated.test.ts — when the SunBiz SMS agent escalates
 * a conversation, the NEW human owner is never a deactivated teammate.
 *
 * finalize_texttorrent_inbound (lib/turso-rpc-texttorrent.ts) sets
 * sunbiz_conversation_state.human_owner_id to the agent account's configured
 * handoff_user_id. Before 2026-09-24 it did so with no standing check, so a
 * retired rep kept receiving escalations for an account nobody re-pointed.
 *
 * Driven for real against a local libSQL file database — the RPC is SQL, and a
 * mock would agree with a wrong query. Pinned here:
 *   - an active handoff user is recorded exactly as before, with no warning
 *   - a deactivated (or absent) handoff user leaves the escalation unowned, the
 *     event still fires, and the skip is logged
 *   - standing is tenant-scoped, and any active row for the person wins
 *   - an owner the thread already has is kept (history), never cleared
 *   - a failed standing read keeps today's owner and warns (SunBiz runtime
 *     must not stall on a hiccup)
 *   - a draft pass does not read user_profiles at all
 *
 * Run: node --conditions=react-server --import tsx tests/texttorrent-handoff-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { finalize_texttorrent_inbound } from "../lib/turso-rpc-texttorrent";

const dir = mkdtempSync(join(tmpdir(), "texttorrent-handoff-deactivated-"));

const TENANT = "7e7e7e7e-0000-4000-8000-00000000007e";
const OTHER_TENANT = "8f8f8f8f-0000-4000-8000-00000000008f";
const ACCOUNT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ACTIVE = "1e1e1e1e-0000-4000-8000-000000000001";
const RETIRED = "1e1e1e1e-0000-4000-8000-000000000002";
const DUPLICATE = "1e1e1e1e-0000-4000-8000-000000000003";
const NOBODY = "1e1e1e1e-0000-4000-8000-000000000004";
const PRIOR_OWNER = "1e1e1e1e-0000-4000-8000-000000000005";
const RETIRED_AT = "2026-09-24T12:00:00Z";

const SCHEMA = `
CREATE TABLE sunbiz_agent_accounts (
  id TEXT PRIMARY KEY, tenant_id TEXT, handoff_user_id TEXT, knowledge_version TEXT);
CREATE TABLE texttorrent_inbound_work (
  id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, status TEXT,
  lease_owner TEXT, claimed_at TEXT, lease_expires_at TEXT, next_attempt_at TEXT,
  priority INTEGER DEFAULT 50, created_at TEXT, attempts INTEGER DEFAULT 0,
  conversation TEXT, provider_conversation_id TEXT, provider_message_id TEXT,
  source_interaction_id TEXT, decision TEXT, completed_at TEXT, last_error TEXT);
CREATE TABLE sunbiz_conversation_state (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id TEXT, provider TEXT, provider_conversation_id TEXT, lead_id TEXT,
  agent_account_id TEXT, qualification_state TEXT, last_intent TEXT,
  last_action TEXT, automation_paused INTEGER, human_owner_id TEXT,
  knowledge_version TEXT, updated_at TEXT,
  UNIQUE (tenant_id, provider, provider_conversation_id));
CREATE TABLE sunbiz_reply_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, conversation_state_id TEXT,
  agent_account_id TEXT, lead_id TEXT, thread_key TEXT, to_phone TEXT,
  original_text TEXT, intent TEXT, confidence REAL, model_id TEXT,
  model_version TEXT, knowledge_version TEXT, source_interaction_id TEXT,
  provider_message_id TEXT, UNIQUE (tenant_id, source_interaction_id));
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, publisher_agent TEXT,
  severity TEXT, payload TEXT, correlation_id TEXT);
CREATE TABLE user_profiles (
  id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
  team_role TEXT, deactivated_at TEXT);
`;

let dbSeq = 0;
async function fresh(handoffUserId: string | null): Promise<Client> {
  dbSeq += 1;
  const c = createClient({ url: `file:${join(dir, `t${dbSeq}.db`)}` });
  await c.executeMultiple(SCHEMA);
  const profile = (id: string, authId: string, tenant: string, deactivatedAt: string | null) => ({
    sql: "INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, deactivated_at) VALUES (?, ?, ?, ?, 'agent', ?)",
    args: [id, authId, `${id}@sun.test`, tenant, deactivatedAt],
  });
  await c.batch(
    [
      {
        sql: "INSERT INTO sunbiz_agent_accounts VALUES (?, ?, ?, 'kv-1')",
        args: [ACCOUNT, TENANT, handoffUserId],
      },
      profile("p-active", ACTIVE, TENANT, null),
      profile("p-retired", RETIRED, TENANT, RETIRED_AT),
      // Still active on ANOTHER tenant: must never make them active here.
      profile("p-retired-elsewhere", RETIRED, OTHER_TENANT, null),
      // Two rows for one person here, one retired: active wins.
      profile("p-dup-old", DUPLICATE, TENANT, RETIRED_AT),
      profile("p-dup-new", DUPLICATE, TENANT, null),
      profile("p-prior", PRIOR_OWNER, TENANT, null),
      {
        sql: `INSERT INTO texttorrent_inbound_work
                (id, tenant_id, account_id, status, lease_owner, next_attempt_at, created_at,
                 conversation, provider_conversation_id, provider_message_id, source_interaction_id)
              VALUES ('w1', ?, ?, 'running', 'w-A', ?, ?, ?, 'conv-1', 'msg-1', 'src-1')`,
        args: [
          TENANT, ACCOUNT, new Date().toISOString(), new Date().toISOString(),
          JSON.stringify({ to_phone: "+14165550142", thread_key: "thr-1", lead_id: "lead-1" }),
        ],
      },
    ],
    "write",
  );
  return c;
}

async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: unknown[][] }> {
  const warned: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = original;
  }
}

const escalate = (c: Client, extra: Record<string, unknown> = {}) =>
  captureWarn(() =>
    finalize_texttorrent_inbound(c, {
      p_work_id: "w1", p_worker_id: "w-A", p_status: "escalated",
      p_decision: { intent: "HUMAN" }, ...extra,
    }),
  );

async function stateOf(c: Client) {
  const st = await c.execute("SELECT human_owner_id, last_action FROM sunbiz_conversation_state");
  const ev = await c.execute("SELECT event_type, severity FROM agent_events");
  const work = await c.execute("SELECT status FROM texttorrent_inbound_work WHERE id = 'w1'");
  return {
    owner: (st.rows[0]?.human_owner_id ?? null) as string | null,
    action: st.rows[0]?.last_action as string | undefined,
    events: ev.rows.map((r) => `${r.event_type}/${r.severity}`),
    work: work.rows[0]?.status as string | undefined,
  };
}

const tagged = (warned: unknown[][], tag: string) =>
  warned.find((args) => args[0] === tag) as [string, Record<string, unknown>] | undefined;

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

async function main() {
  console.log("texttorrent-handoff-deactivated:");

  await check("an ACTIVE handoff user is recorded exactly as before, with no warning", async () => {
    const c = await fresh(ACTIVE);
    const { result, warned } = await escalate(c);
    assert.equal(result, true);
    const s = await stateOf(c);
    assert.equal(s.owner, ACTIVE);
    assert.equal(s.action, "escalated");
    assert.deepEqual(s.events, ["TEXTTORRENT_HANDOFF_REQUIRED/warn"]);
    assert.equal(s.work, "escalated");
    assert.deepEqual(warned, [], "an active owner must not produce a warning");
  });

  await check("a handoff id in another case still resolves the active teammate", async () => {
    const c = await fresh(ACTIVE.toUpperCase());
    const { warned } = await escalate(c);
    assert.equal((await stateOf(c)).owner, ACTIVE.toUpperCase(), "an active owner was dropped over letter case");
    assert.deepEqual(warned, []);
  });

  await check("a DEACTIVATED handoff user: escalation lands unowned, still fires, and is logged", async () => {
    const c = await fresh(RETIRED);
    const { result, warned } = await escalate(c);
    assert.equal(result, true, "the escalation itself must still finalize");
    const s = await stateOf(c);
    assert.equal(s.owner, null, "new inbound work reached a deactivated teammate");
    assert.equal(s.action, "escalated");
    assert.deepEqual(s.events, ["TEXTTORRENT_HANDOFF_REQUIRED/warn"], "the handoff event must still fire");
    assert.equal(s.work, "escalated");
    const w = tagged(warned, "[texttorrent-rpc] handoff user deactivated");
    assert.ok(w, "skipping the retired owner must be visible in the logs");
    assert.equal(w[1].handoff_user_id, RETIRED);
    assert.equal(w[1].standing, "deactivated");
    assert.equal(w[1].tenant_id, TENANT);
  });

  await check("a handoff user with NO profile on this tenant is not handed the thread", async () => {
    const c = await fresh(NOBODY);
    const { warned } = await escalate(c);
    assert.equal((await stateOf(c)).owner, null);
    assert.equal(tagged(warned, "[texttorrent-rpc] handoff user deactivated")?.[1].standing, "not_member");
  });

  await check("a person with an active row here is active, whatever their retired duplicate says", async () => {
    const c = await fresh(DUPLICATE);
    const { warned } = await escalate(c);
    assert.equal((await stateOf(c)).owner, DUPLICATE);
    assert.deepEqual(warned, []);
  });

  await check("an owner the thread already has is KEPT when the handoff user is deactivated", async () => {
    const c = await fresh(RETIRED);
    await c.execute({
      sql: `INSERT INTO sunbiz_conversation_state
              (tenant_id, provider, provider_conversation_id, qualification_state, human_owner_id, last_action)
            VALUES (?, 'texttorrent', 'conv-1', '{}', ?, 'handoff')`,
      args: [TENANT, PRIOR_OWNER],
    });
    await escalate(c);
    const s = await stateOf(c);
    assert.equal(s.owner, PRIOR_OWNER, "the COALESCE must keep the existing owner (history)");
    assert.equal(s.action, "escalated");
  });

  await check("a FAILED standing read keeps today's owner and warns", async () => {
    const c = await fresh(RETIRED);
    await c.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    const { result, warned } = await escalate(c);
    assert.equal(result, true, "a standing hiccup must never stall the SMS runtime");
    assert.equal((await stateOf(c)).owner, RETIRED, "a failed check must keep today's behaviour");
    const w = tagged(warned, "[texttorrent-rpc] handoff user check failed");
    assert.ok(w, "the failed check must be logged");
    assert.equal(w[1].handoff_user_id, RETIRED);
    assert.equal(tagged(warned, "[texttorrent-rpc] handoff user deactivated"), undefined);
  });

  await check("a DRAFT pass never reads user_profiles (behaviour unchanged)", async () => {
    const c = await fresh(RETIRED);
    await c.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    const { result, warned } = await captureWarn(() =>
      finalize_texttorrent_inbound(c, {
        p_work_id: "w1", p_worker_id: "w-A", p_status: "drafted",
        p_decision: { intent: "QUALIFY", response: "Happy to help." },
      }),
    );
    assert.equal(result, true);
    const s = await stateOf(c);
    assert.equal(s.owner, null);
    assert.deepEqual(s.events, ["TEXTTORRENT_DRAFT_READY/info"]);
    assert.deepEqual(warned, [], "a draft pass touched the standing check");
  });

  if (failures > 0) {
    console.log(`texttorrent-handoff-deactivated: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("texttorrent-handoff-deactivated: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
