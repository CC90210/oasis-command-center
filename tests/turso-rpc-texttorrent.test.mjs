/**
 * The TextTorrent RPC ports, against a real in-memory libSQL database.
 *
 * Mocks are useless here: every one of these is a claim/lease/merge semantic
 * expressed in SQL, and a mock would agree with a wrong query. The failures
 * these guard against are all silent -- two workers answering one SMS, a lease
 * stolen while live, a handoff owner cleared, a suppression that writes nothing.
 *
 * Run: node --test tests/turso-rpc-texttorrent.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

const {
  claim_texttorrent_partition,
  heartbeat_texttorrent_partition,
  release_texttorrent_partition,
  claim_texttorrent_inbound,
  fail_texttorrent_inbound,
  finalize_texttorrent_inbound,
  suppress_texttorrent_inbound,
  texttorrent_runtime_health,
} = await import("../lib/turso-rpc-texttorrent.ts");

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "11111111-0000-4000-8000-00000000000f";

const SCHEMA = `
CREATE TABLE sunbiz_agent_accounts (
  id TEXT PRIMARY KEY, tenant_id TEXT, handoff_user_id TEXT, knowledge_version TEXT);
CREATE TABLE sunbiz_processing_leases (
  tenant_id TEXT, partition_key TEXT, owner_id TEXT,
  acquired_at TEXT, heartbeat_at TEXT, expires_at TEXT,
  PRIMARY KEY (tenant_id, partition_key));
CREATE TABLE texttorrent_inbound_work (
  id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, status TEXT,
  lease_owner TEXT, claimed_at TEXT, lease_expires_at TEXT, next_attempt_at TEXT,
  priority INTEGER DEFAULT 50, created_at TEXT, attempts INTEGER DEFAULT 0,
  conversation TEXT, provider_conversation_id TEXT, provider_message_id TEXT,
  source_interaction_id TEXT, decision TEXT, completed_at TEXT, last_error TEXT);
CREATE TABLE texttorrent_dead_letters (
  inbound_work_id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT,
  failure_code TEXT, attempts INTEGER, sanitized_metadata TEXT, resolved_at TEXT);
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
CREATE TABLE sunbiz_phone_suppressions (
  tenant_id TEXT, phone_last10 TEXT, reason TEXT, source TEXT,
  source_work_id TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, phone_last10));
CREATE TABLE scheduled_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, channel TEXT,
  status TEXT, thread_key TEXT, to_phone TEXT);
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, publisher_agent TEXT,
  severity TEXT, payload TEXT, correlation_id TEXT);
`;

async function fresh() {
  const c = createClient({ url: ":memory:" });
  for (const stmt of SCHEMA.split(";")) if (stmt.trim()) await c.execute(stmt);
  await c.execute({
    sql: `INSERT INTO sunbiz_agent_accounts VALUES (:id,:tid,:owner,'kv-1')`,
    args: { id: ACCOUNT, tid: TENANT, owner: OWNER },
  });
  return c;
}

const past = () => new Date(Date.now() - 600_000).toISOString();
const future = () => new Date(Date.now() + 600_000).toISOString();

async function seedWork(c, over = {}) {
  const row = {
    id: "w1", tenant_id: TENANT, account_id: ACCOUNT, status: "pending",
    lease_owner: null, next_attempt_at: past(), created_at: past(), attempts: 0,
    conversation: JSON.stringify({ to_phone: "+1 (416) 555-0142",
      thread_key: "thr-1", lead_id: "lead-1" }),
    provider_conversation_id: "conv-1", provider_message_id: "msg-1",
    source_interaction_id: "src-1", ...over,
  };
  await c.execute({
    sql: `INSERT INTO texttorrent_inbound_work
      (id,tenant_id,account_id,status,lease_owner,next_attempt_at,created_at,attempts,
       conversation,provider_conversation_id,provider_message_id,source_interaction_id,
       lease_expires_at)
      VALUES (:id,:tenant_id,:account_id,:status,:lease_owner,:next_attempt_at,
       :created_at,:attempts,:conversation,:provider_conversation_id,
       :provider_message_id,:source_interaction_id,:lease_expires_at)`,
    args: { lease_expires_at: null, ...row },
  });
  return row;
}

/* ----------------------------------------------------------------- leases */

test("partition: first worker wins, second is refused while the lease is live", async () => {
  const c = await fresh();
  const key = `${ACCOUNT}:p0`;
  assert.equal(await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 }), true);
  assert.equal(
    await claim_texttorrent_partition(c, {
      p_partition_key: key, p_worker_id: "w-B", p_lease_seconds: 600 }),
    false,
    "a second worker took a LIVE lease -- both would process the same partition");
});

test("partition: an EXPIRED lease may be taken over", async () => {
  const c = await fresh();
  const key = `${ACCOUNT}:p0`;
  await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 });
  await c.execute({
    sql: `UPDATE sunbiz_processing_leases SET expires_at = :past`,
    args: { past: past() },
  });
  assert.equal(await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-B", p_lease_seconds: 600 }), true,
    "an expired lease stayed locked -- the partition would stall forever");
});

test("partition: the owner may re-acquire its own lease (idempotent restart)", async () => {
  const c = await fresh();
  const key = `${ACCOUNT}:p0`;
  await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 });
  assert.equal(await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 }), true);
});

test("heartbeat: only the owner extends, and never a lapsed lease", async () => {
  const c = await fresh();
  const key = `${ACCOUNT}:p0`;
  await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 });

  assert.equal(await heartbeat_texttorrent_partition(c, {
    p_tenant_id: TENANT, p_partition_key: key, p_worker_id: "w-B" }), false,
    "a non-owner extended someone else's lease");
  assert.equal(await heartbeat_texttorrent_partition(c, {
    p_tenant_id: TENANT, p_partition_key: key, p_worker_id: "w-A" }), true);

  await c.execute({ sql: `UPDATE sunbiz_processing_leases SET expires_at = :p`,
    args: { p: past() } });
  assert.equal(await heartbeat_texttorrent_partition(c, {
    p_tenant_id: TENANT, p_partition_key: key, p_worker_id: "w-A" }), false,
    "a LAPSED lease was resurrected -- another worker may already hold it");
});

test("heartbeat/release are tenant-scoped, not global", async () => {
  const c = await fresh();
  const key = `${ACCOUNT}:p0`;
  await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 });
  const other = "00000000-0000-4000-8000-00000000dead";
  assert.equal(await heartbeat_texttorrent_partition(c, {
    p_tenant_id: other, p_partition_key: key, p_worker_id: "w-A" }), false);
  assert.equal(await release_texttorrent_partition(c, {
    p_tenant_id: other, p_partition_key: key, p_worker_id: "w-A" }), false,
    "another tenant released this tenant's lease");
});

test("release: only the owner, and the partition is claimable again after", async () => {
  const c = await fresh();
  const key = `${ACCOUNT}:p0`;
  await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-A", p_lease_seconds: 600 });
  assert.equal(await release_texttorrent_partition(c, {
    p_tenant_id: TENANT, p_partition_key: key, p_worker_id: "w-B" }), false);
  assert.equal(await release_texttorrent_partition(c, {
    p_tenant_id: TENANT, p_partition_key: key, p_worker_id: "w-A" }), true);
  assert.equal(await claim_texttorrent_partition(c, {
    p_partition_key: key, p_worker_id: "w-B", p_lease_seconds: 600 }), true);
});

/* ----------------------------------------------------------- inbound claim */

test("inbound: exactly one worker claims a pending item", async () => {
  const c = await fresh();
  await seedWork(c);
  const a = await claim_texttorrent_inbound(c, {
    p_account_id: ACCOUNT, p_worker_id: "w-A", p_lease_seconds: 600 });
  const b = await claim_texttorrent_inbound(c, {
    p_account_id: ACCOUNT, p_worker_id: "w-B", p_lease_seconds: 600 });
  assert.equal(a.length, 1, "the claimer got nothing back and would skip real work");
  assert.equal(b.length, 0, "TWO workers claimed one inbound SMS -- duplicate reply");
  assert.equal(a[0].lease_owner, "w-A");
  assert.equal(a[0].status, "running");
});

test("inbound: a stale running lease is reclaimable; a live one is not", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A",
    lease_expires_at: future() });
  assert.equal((await claim_texttorrent_inbound(c, {
    p_account_id: ACCOUNT, p_worker_id: "w-B" })).length, 0);

  await c.execute({ sql: `UPDATE texttorrent_inbound_work SET lease_expires_at = :p`,
    args: { p: past() } });
  assert.equal((await claim_texttorrent_inbound(c, {
    p_account_id: ACCOUNT, p_worker_id: "w-B" })).length, 1,
    "an abandoned item was never picked up again");
});

test("inbound: next_attempt_at in the future is respected (backoff holds)", async () => {
  const c = await fresh();
  await seedWork(c, { next_attempt_at: future() });
  assert.equal((await claim_texttorrent_inbound(c, {
    p_account_id: ACCOUNT, p_worker_id: "w-A" })).length, 0,
    "backoff was ignored -- a failing item would spin");
});

/* ------------------------------------------------------------------- fail */

test("fail: retries below the cap, dead-letters at the cap", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A", attempts: 0 });
  assert.equal(await fail_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_error_code: "boom",
    p_max_attempts: 3, p_next_attempt_at: null }), "pending");

  await c.execute(`UPDATE texttorrent_inbound_work
    SET status='running', lease_owner='w-A', attempts=2`);
  assert.equal(await fail_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_error_code: "boom",
    p_max_attempts: 3, p_next_attempt_at: null }), "dead_letter");

  const dl = await c.execute(`SELECT COUNT(*) AS n FROM texttorrent_dead_letters`);
  assert.equal(Number(dl.rows[0].n), 1, "no dead-letter row was written");
});

test("fail: rejects a foreign worker and a bad guard, writing nothing", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  assert.equal(await fail_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-OTHER", p_error_code: "x",
    p_max_attempts: 3 }), null, "a worker failed an item it does not hold");
  assert.equal(await fail_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_error_code: "",
    p_max_attempts: 3 }), null);
  assert.equal(await fail_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_error_code: "x",
    p_max_attempts: 0 }), null);
});

/* --------------------------------------------------------------- finalize */

test("finalize: a draft with a response closes the item and stages the reply", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  const ok = await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "drafted",
    p_decision: { intent: "QUALIFY", response: "  hello there  ",
      qualification_updates: { budget: "10k" }, confidence: 0.8 },
  });
  assert.equal(ok, true);

  const wk = await c.execute(`SELECT status, lease_owner FROM texttorrent_inbound_work`);
  assert.equal(wk.rows[0].status, "drafted");
  assert.equal(wk.rows[0].lease_owner, null, "the lease was not released");

  const d = await c.execute(`SELECT original_text, intent FROM sunbiz_reply_drafts`);
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].original_text, "hello there", "btrim() was not applied");

  const ev = await c.execute(`SELECT event_type, severity FROM agent_events`);
  assert.equal(ev.rows[0].event_type, "TEXTTORRENT_DRAFT_READY");
  assert.equal(ev.rows[0].severity, "info");
});

test("finalize: a BLANK draft response returns false and leaves the item open", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  const ok = await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "drafted",
    p_decision: { intent: "QUALIFY", response: "   " },
  });
  assert.equal(ok, false);
  const wk = await c.execute(`SELECT status FROM texttorrent_inbound_work`);
  assert.equal(wk.rows[0].status, "running",
    "the work item was closed despite no draft being written");
  const d = await c.execute(`SELECT COUNT(*) AS n FROM sunbiz_reply_drafts`);
  assert.equal(Number(d.rows[0].n), 0);
  // And the documented partial write: the state row IS committed, as in Postgres.
  const st = await c.execute(`SELECT COUNT(*) AS n FROM sunbiz_conversation_state`);
  assert.equal(Number(st.rows[0].n), 1,
    "conversation state was rolled back -- the source commits it");
});

test("finalize: escalation records the handoff owner and warns", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  assert.equal(await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "escalated",
    p_decision: { intent: "HUMAN" } }), true);
  const st = await c.execute(`SELECT human_owner_id, last_action FROM sunbiz_conversation_state`);
  assert.equal(st.rows[0].human_owner_id, OWNER);
  assert.equal(st.rows[0].last_action, "escalated");
  const ev = await c.execute(`SELECT event_type, severity FROM agent_events`);
  assert.equal(ev.rows[0].event_type, "TEXTTORRENT_HANDOFF_REQUIRED");
  assert.equal(ev.rows[0].severity, "warn");
});

test("finalize: qualification_state MERGES, and a later draft keeps the handoff owner", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "escalated",
    p_decision: { intent: "HUMAN", qualification_updates: { budget: "10k" } } });

  await c.execute(`UPDATE texttorrent_inbound_work
    SET status='running', lease_owner='w-A', source_interaction_id='src-2'`);
  await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "drafted",
    p_decision: { intent: "QUALIFY", response: "ok",
      qualification_updates: { timeline: "Q3" } } });

  const st = await c.execute(`SELECT qualification_state, human_owner_id
                                FROM sunbiz_conversation_state`);
  const merged = JSON.parse(st.rows[0].qualification_state);
  assert.equal(merged.budget, "10k", "the merge REPLACED instead of merging");
  assert.equal(merged.timeline, "Q3");
  assert.equal(st.rows[0].human_owner_id, OWNER,
    "a later draft cleared the human handoff owner");
});

test("finalize: a null in qualification_updates is KEPT, not deleted", async () => {
  // jsonb `||` keeps nulls; SQLite json_patch would delete the key. This is the
  // exact difference that makes json_patch the wrong tool here.
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "escalated",
    p_decision: { qualification_updates: { budget: "10k" } } });
  await c.execute(`UPDATE texttorrent_inbound_work SET status='running', lease_owner='w-A'`);
  await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "escalated",
    p_decision: { qualification_updates: { budget: null } } });

  const st = await c.execute(`SELECT qualification_state FROM sunbiz_conversation_state`);
  const merged = JSON.parse(st.rows[0].qualification_state);
  assert.ok("budget" in merged, "the null-valued key was DELETED (json_patch semantics)");
  assert.equal(merged.budget, null);
});

test("finalize: rejects an unknown status and a foreign worker", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  assert.equal(await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-A", p_status: "done", p_decision: {} }), false);
  assert.equal(await finalize_texttorrent_inbound(c, {
    p_work_id: "w1", p_worker_id: "w-OTHER", p_status: "escalated",
    p_decision: {} }), false);
  const st = await c.execute(`SELECT COUNT(*) AS n FROM sunbiz_conversation_state`);
  assert.equal(Number(st.rows[0].n), 0, "a rejected call still wrote state");
});

/* --------------------------------------------------------------- suppress */

test("suppress: records the number, parks the thread, cancels queued sends", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  await c.execute({
    sql: `INSERT INTO scheduled_sends (tenant_id,channel,status,thread_key,to_phone)
          VALUES (:t,'sms','pending','thr-1','+14165550142')`,
    args: { t: TENANT } });

  assert.equal(await suppress_texttorrent_inbound(c, {
    p_inbound_work_id: "w1", p_tenant_id: TENANT, p_account_id: ACCOUNT,
    p_reason: "STOP", p_worker_id: "w-A" }), true);

  const s = await c.execute(`SELECT phone_last10 FROM sunbiz_phone_suppressions`);
  assert.equal(s.rows[0].phone_last10, "4165550142", "digits were not normalised");

  const q = await c.execute(`SELECT status FROM scheduled_sends`);
  assert.equal(q.rows[0].status, "cancelled",
    "a queued SMS survived an opt-out -- that is a compliance breach");

  const st = await c.execute(`SELECT automation_paused, last_action
                                FROM sunbiz_conversation_state`);
  assert.equal(Number(st.rows[0].automation_paused), 1);
  assert.equal(st.rows[0].last_action, "suppressed");

  const wk = await c.execute(`SELECT status FROM texttorrent_inbound_work`);
  assert.equal(wk.rows[0].status, "suppressed");
});

test("suppress: an unusable phone writes NOTHING at all", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A",
    conversation: JSON.stringify({ to_phone: "123", thread_key: "thr-1" }) });
  assert.equal(await suppress_texttorrent_inbound(c, {
    p_inbound_work_id: "w1", p_tenant_id: TENANT, p_account_id: ACCOUNT,
    p_reason: "STOP", p_worker_id: "w-A" }), false);
  const s = await c.execute(`SELECT COUNT(*) AS n FROM sunbiz_phone_suppressions`);
  assert.equal(Number(s.rows[0].n), 0, "a partial suppression was written");
  const wk = await c.execute(`SELECT status FROM texttorrent_inbound_work`);
  assert.equal(wk.rows[0].status, "running");
});

test("suppress: refuses a work item held by another worker", async () => {
  const c = await fresh();
  await seedWork(c, { status: "running", lease_owner: "w-A" });
  assert.equal(await suppress_texttorrent_inbound(c, {
    p_inbound_work_id: "w1", p_tenant_id: TENANT, p_account_id: ACCOUNT,
    p_reason: "STOP", p_worker_id: "w-OTHER" }), false);
});

/* ----------------------------------------------------------------- health */

test("health: counts leases, queue depth and dead letters", async () => {
  const c = await fresh();
  await seedWork(c);
  await claim_texttorrent_partition(c, {
    p_partition_key: `${ACCOUNT}:p0`, p_worker_id: "w-A", p_lease_seconds: 600 });

  const h = await texttorrent_runtime_health(c, { p_worker_id: "w-A" });
  assert.equal(h.worker_id, "w-A");
  assert.equal(h.active_leases, 1);
  assert.equal(h.pending, 1);
  assert.equal(h.running, 0);
  assert.equal(h.dead, 0);
  assert.ok(h.oldest_pending_at, "oldest_pending_at should be populated");
});
