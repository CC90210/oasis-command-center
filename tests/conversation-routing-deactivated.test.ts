/**
 * conversation-routing-deactivated.test.ts — a deactivated teammate never
 * receives LIVE conversation work, while the threads and deals they already
 * hold keep their name (history).
 *
 * Three paths, each driven for real against a local libSQL database:
 *
 *   lib/agents/operator-email/ingest.ts    an inbound client reply routes its
 *                                          thread to the lead's owner, else the
 *                                          mailbox owner — only if ACTIVE here
 *   PATCH /api/conversations/threads/[key] assigning a thread: a deactivated NEW
 *                                          assignee is refused; re-saving the
 *                                          current one and null still work
 *   PATCH /api/conversations/drafts/[id]   SunBiz SMS-draft handoff: refused for
 *                                          a deactivated target before any write
 *
 * Stand-ins: next/headers' cookie jar (same pattern as
 * tests/lead-assign-collaborators-deactivated.test.ts) and the deal-email
 * classifier, which would otherwise queue real inference.
 *
 * Run: node --conditions=react-server --import tsx tests/conversation-routing-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "conversation-routing-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "conversation-routing-deactivated-secret-long-enough-01";

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
stubModule(require.resolve("next/headers"), {
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});

// Never reach the inference queue from a test: every matched email is "other".
stubModule(require.resolve("../lib/agents/operator-email/classify"), {
  classifyDealEmail: async () => ({ type: "other", needs_attention: false, summary: "" }),
});

const TENANT = "5c5c5c5c-0000-4000-8000-00000000005c";
const OTHER_TENANT = "6d6d6d6d-0000-4000-8000-00000000006d";
const ADMIN = "1c1c1c1c-0000-4000-8000-000000000001";
const AGENT = "1c1c1c1c-0000-4000-8000-000000000002";
const AGENT_2 = "1c1c1c1c-0000-4000-8000-000000000003";
const RETIRED = "1c1c1c1c-0000-4000-8000-000000000004";
const RETIRED_MAILBOX = "1c1c1c1c-0000-4000-8000-000000000005";
const STRANGER = "1c1c1c1c-0000-4000-8000-000000000006";

// ingest leads
const LEAD_ACTIVE_OWNER = "2c2c2c2c-0000-4000-8000-000000000001";
const LEAD_RETIRED_OWNER = "2c2c2c2c-0000-4000-8000-000000000002";
const LEAD_STRANGER_OWNER = "2c2c2c2c-0000-4000-8000-000000000003";
const LEAD_ALL_RETIRED = "2c2c2c2c-0000-4000-8000-000000000004";
const LEAD_CHECK_FAILS = "2c2c2c2c-0000-4000-8000-000000000005";
// threads route
const THREAD_LIVE_LEAD = "2c2c2c2c-0000-4000-8000-000000000011";
const THREAD_RETIRED_LEAD = "2c2c2c2c-0000-4000-8000-000000000012";
// drafts route
const ACCOUNT = "3c3c3c3c-0000-4000-8000-000000000001";
const STATE = "3c3c3c3c-0000-4000-8000-000000000002";
const DRAFT = "3c3c3c3c-0000-4000-8000-000000000003";

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

type ApiBody = { ok?: boolean; error?: string; message?: string };

async function main() {
  console.log("conversation-routing-deactivated:");
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT,
      invited_by TEXT, manager_user_id TEXT, joined_at TEXT, updated_at TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, to_email TEXT, sent_at TEXT, metadata TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE conversation_threads (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, thread_key TEXT NOT NULL, lead_id TEXT,
      assigned_to TEXT, status TEXT NOT NULL DEFAULT 'open',
      unread_count INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT, last_read_at TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL},
      UNIQUE (tenant_id, thread_key)
    );
    CREATE TABLE conversation_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, thread_id TEXT, lead_id TEXT, event_type TEXT,
      actor_user_id TEXT, metadata TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE sunbiz_agent_accounts (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, provider TEXT, mode TEXT,
      enabled INTEGER, from_number TEXT, timezone TEXT
    );
    CREATE TABLE sunbiz_conversation_state (
      id TEXT PRIMARY KEY, tenant_id TEXT, human_owner_id TEXT,
      automation_paused INTEGER NOT NULL DEFAULT 0, last_action TEXT, updated_at TEXT
    );
    CREATE TABLE sunbiz_reply_drafts (
      id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, original_text TEXT, to_phone TEXT,
      lead_id TEXT, thread_key TEXT, conversation_state_id TEXT, agent_account_id TEXT,
      handoff_user_id TEXT, handoff_at TEXT, rejected_by TEXT, rejected_at TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
  `);

  const RETIRED_AT = "2026-09-24T12:00:00Z";
  const profile = (id: string, authId: string, email: string, tenant: string, role: string, deactivatedAt?: string) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, onboarding_completed_at,
             full_name, joined_at, updated_at, deactivated_at, deactivation_reason)
          VALUES (?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z',
                  '2026-09-01T00:00:00Z', ?, ?)`,
    args: [
      id, authId, email, tenant, role, email.split("@")[0],
      deactivatedAt ?? null, deactivatedAt ? "Sales team retired" : null,
    ],
  });
  const lead = (id: string, email: string, assignedTo: string | null, stage = "funded") => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({ business_name: `Merchant ${id.slice(-2)}`, email, stage, assigned_to: assignedTo })],
  });
  const thread = (leadId: string, assignedTo: string | null) => ({
    sql: "INSERT INTO conversation_threads (tenant_id, thread_key, lead_id, assigned_to, status) VALUES (?, ?, ?, ?, 'needs_reply')",
    args: [TENANT, `lead:${leadId}`, leadId, assignedTo],
  });

  await seed.batch(
    [
      ...[
        [ADMIN, "admin@sun.test"],
        [AGENT, "agent@sun.test"],
        [AGENT_2, "agent2@sun.test"],
        [RETIRED, "retired@sun.test"],
        [RETIRED_MAILBOX, "retired-mailbox@sun.test"],
        [STRANGER, "stranger@elsewhere.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-admin", ADMIN, "admin@sun.test", TENANT, "admin"),
      profile("p-agent", AGENT, "agent@sun.test", TENANT, "agent"),
      profile("p-agent-2", AGENT_2, "agent2@sun.test", TENANT, "agent"),
      profile("p-retired", RETIRED, "retired@sun.test", TENANT, "agent", RETIRED_AT),
      profile("p-retired-mailbox", RETIRED_MAILBOX, "retired-mailbox@sun.test", TENANT, "agent", RETIRED_AT),
      // Active, but on another tenant: never a member here.
      profile("p-stranger", STRANGER, "stranger@elsewhere.test", OTHER_TENANT, "agent"),
      // The retired rep is still active on the other tenant; the check is
      // tenant-scoped, so this row must never make them active here.
      profile("p-retired-elsewhere", RETIRED, "retired@elsewhere.test", OTHER_TENANT, "agent"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },

      lead(LEAD_ACTIVE_OWNER, "active-owner@client.test", AGENT, "contacted"),
      lead(LEAD_RETIRED_OWNER, "retired-owner@client.test", RETIRED),
      lead(LEAD_STRANGER_OWNER, "stranger-owner@client.test", STRANGER),
      lead(LEAD_ALL_RETIRED, "all-retired@client.test", RETIRED),
      lead(LEAD_CHECK_FAILS, "check-fails@client.test", RETIRED),
      ...[LEAD_ACTIVE_OWNER, LEAD_RETIRED_OWNER, LEAD_STRANGER_OWNER, LEAD_ALL_RETIRED, LEAD_CHECK_FAILS].map(
        (id) => thread(id, null),
      ),

      thread(THREAD_LIVE_LEAD, AGENT),
      // The retired rep's thread on a deal they closed: history.
      thread(THREAD_RETIRED_LEAD, RETIRED),

      {
        sql: `INSERT INTO sunbiz_agent_accounts (id, tenant_id, user_id, provider, mode, enabled, from_number, timezone)
              VALUES (?, ?, ?, 'texttorrent', 'semi', 1, '+15555550100', 'America/New_York')`,
        args: [ACCOUNT, TENANT, AGENT],
      },
      { sql: "INSERT INTO sunbiz_conversation_state (id, tenant_id) VALUES (?, ?)", args: [STATE, TENANT] },
      {
        sql: `INSERT INTO sunbiz_reply_drafts
                (id, tenant_id, status, original_text, to_phone, lead_id, thread_key,
                 conversation_state_id, agent_account_id, created_at, updated_at)
              VALUES (?, ?, 'pending', 'Thanks, we can fund this week.', '+15555550199', NULL,
                      'phone:+15555550199', ?, ?, ?, ?)`,
        args: [DRAFT, TENANT, STATE, ACCOUNT, new Date().toISOString(), new Date().toISOString()],
      },
    ],
    "write",
  );

  const threadAssignee = async (leadId: string) => {
    const res = await seed.execute({
      sql: "SELECT assigned_to FROM conversation_threads WHERE tenant_id = ? AND thread_key = ?",
      args: [TENANT, `lead:${leadId}`],
    });
    return (res.rows[0]?.assigned_to ?? null) as string | null;
  };
  const leadOwner = async (leadId: string) => {
    const res = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [leadId] });
    return (JSON.parse(String(res.rows[0]?.data)) as { assigned_to?: string | null }).assigned_to ?? null;
  };

  // ── lib/agents/operator-email/ingest.ts ─────────────────────────────────
  const { ingestMessages } = await import("../lib/agents/operator-email/ingest");
  let msgSeq = 0;
  const inbound = async (clientEmail: string, mailbox: { userId: string; address: string }) => {
    msgSeq += 1;
    return captureWarn(() =>
      ingestMessages({ tenantId: TENANT, userId: mailbox.userId, mailbox: "work", dryRun: false }, [
        {
          id: `gmail-msg-${msgSeq}`,
          threadId: `gmail-thread-${msgSeq}`,
          subject: "Re: your offer",
          from: `Client <${clientEmail}>`,
          to: mailbox.address,
          date: new Date().toUTCString(),
          internalDate: String(Date.now()),
          body: "Sounds good, what are the next steps?",
          mailboxAddress: mailbox.address,
        },
      ]),
    );
  };
  const ACTIVE_MAILBOX = { userId: AGENT_2, address: "agent2@sun.test" };
  const skipped = (warned: unknown[][], role: string) =>
    warned.find(
      (args) =>
        args[0] === "[operator-email] thread assignee skipped" && (args[1] as { role?: string }).role === role,
    ) as [string, { userId?: string; standing?: string; tenantId?: string }] | undefined;

  await check("ingest: a reply on an active rep's lead routes to that rep, unchanged", async () => {
    const { result, warned } = await inbound("active-owner@client.test", ACTIVE_MAILBOX);
    assert.equal(result.ingested, 1, JSON.stringify(result));
    assert.equal(await threadAssignee(LEAD_ACTIVE_OWNER), AGENT);
    assert.equal(skipped(warned, "lead_owner"), undefined);
  });

  await check("ingest: a reply on a deactivated rep's deal routes to the mailbox owner, and is logged", async () => {
    const { result, warned } = await inbound("retired-owner@client.test", ACTIVE_MAILBOX);
    assert.equal(result.ingested, 1, JSON.stringify(result));
    assert.equal(await threadAssignee(LEAD_RETIRED_OWNER), AGENT_2, "a client's reply landed in a retired rep's queue");
    assert.equal(await leadOwner(LEAD_RETIRED_OWNER), RETIRED, "the deal must keep its retired owner (history)");
    const tagged = skipped(warned, "lead_owner");
    assert.ok(tagged, "skipping the retired owner must be visible in the logs");
    assert.equal(tagged[1].userId, RETIRED);
    assert.equal(tagged[1].standing, "deactivated");
    assert.equal(tagged[1].tenantId, TENANT);
  });

  await check("ingest: a lead owner who is not on this tenant is skipped for the mailbox owner", async () => {
    const { result, warned } = await inbound("stranger-owner@client.test", ACTIVE_MAILBOX);
    assert.equal(result.ingested, 1, JSON.stringify(result));
    assert.equal(await threadAssignee(LEAD_STRANGER_OWNER), AGENT_2);
    assert.equal(skipped(warned, "lead_owner")?.[1].standing, "not_member");
  });

  await check("ingest: when the mailbox owner is deactivated too, the thread stays unassigned", async () => {
    const { result, warned } = await inbound("all-retired@client.test", {
      userId: RETIRED_MAILBOX,
      address: "retired-mailbox@sun.test",
    });
    assert.equal(result.ingested, 1, JSON.stringify(result));
    assert.equal(await threadAssignee(LEAD_ALL_RETIRED), null, "new inbound work reached a deactivated teammate");
    assert.equal(skipped(warned, "mailbox_owner")?.[1].userId, RETIRED_MAILBOX);
  });

  await check("ingest: a failed standing read falls through, warns, and never throws out of ingest", async () => {
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      const { result, warned } = await inbound("check-fails@client.test", ACTIVE_MAILBOX);
      assert.equal(result.ingested, 1, `the interaction row is the ledger and must still land: ${JSON.stringify(result)}`);
      const failed = warned.filter((args) => args[0] === "[operator-email] thread assignee check failed");
      assert.deepEqual(
        failed.map((args) => (args[1] as { role?: string }).role),
        ["lead_owner", "mailbox_owner"],
        "a failed check must fall through to the next candidate, logged each time",
      );
      assert.equal(await threadAssignee(LEAD_CHECK_FAILS), null, "an unverified owner was handed the thread");
    } finally {
      await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
  });

  // ── PATCH /api/conversations/threads/[key] ─────────────────────────────
  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const { MEMBER_DEACTIVATED_MESSAGE } = await import("../lib/team");
  const threadsRoute = await import("../app/api/conversations/threads/[key]/route");
  const draftsRoute = await import("../app/api/conversations/drafts/[id]/route");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  const patchThread = async (leadId: string, body: Record<string, unknown>) => {
    const key = encodeURIComponent(`lead:${leadId}`);
    const req = new NextRequest(`http://localhost/api/conversations/threads/${key}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await threadsRoute.PATCH(req, { params: Promise.resolve({ key }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const threadRow = async (leadId: string) => {
    const res = await seed.execute({
      sql: "SELECT id, assigned_to, status FROM conversation_threads WHERE thread_key = ?",
      args: [`lead:${leadId}`],
    });
    return res.rows[0] as unknown as { id: string; assigned_to: string | null; status: string };
  };
  const eventCount = async (threadId: string) => {
    const res = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM conversation_events WHERE thread_id = ?",
      args: [threadId],
    });
    return Number(res.rows[0]?.n ?? 0);
  };

  await check("threads PATCH: a deactivated new assignee is refused (400 member_deactivated), nothing written", async () => {
    const before = await threadRow(THREAD_LIVE_LEAD);
    for (const target of [RETIRED, RETIRED.toUpperCase()]) {
      const refused = await patchThread(THREAD_LIVE_LEAD, { assigned_to: target, status: "open" });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "member_deactivated");
      assert.equal(refused.body.message, MEMBER_DEACTIVATED_MESSAGE);
    }
    const after = await threadRow(THREAD_LIVE_LEAD);
    assert.equal(after.assigned_to, AGENT, "a refused assignment moved the thread");
    assert.equal(after.status, before.status, "a refused request still applied its other fields");
    assert.equal(await eventCount(before.id), 0, "a refused assignment was audited as an assignment");
  });

  await check("threads PATCH: a user from another tenant is still not_a_tenant_member", async () => {
    const refused = await patchThread(THREAD_LIVE_LEAD, { assigned_to: STRANGER });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "not_a_tenant_member");
  });

  await check("threads PATCH: an active teammate is accepted", async () => {
    const ok = await patchThread(THREAD_LIVE_LEAD, { assigned_to: AGENT_2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await threadRow(THREAD_LIVE_LEAD)).assigned_to, AGENT_2);
  });

  await check("threads PATCH: re-saving the thread's current deactivated assignee still works", async () => {
    const ok = await patchThread(THREAD_RETIRED_LEAD, { assigned_to: RETIRED.toUpperCase(), status: "closed" });
    assert.equal(ok.status, 200, `editing a thread a retired rep still holds was blocked: ${JSON.stringify(ok.body)}`);
    const row = await threadRow(THREAD_RETIRED_LEAD);
    assert.equal(row.assigned_to, RETIRED, "history lost its assignee");
    assert.equal(row.status, "closed");
  });

  await check("threads PATCH: null unassigns, and the retired rep cannot be put back", async () => {
    const cleared = await patchThread(THREAD_RETIRED_LEAD, { assigned_to: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((await threadRow(THREAD_RETIRED_LEAD)).assigned_to, null);
    const back = await patchThread(THREAD_RETIRED_LEAD, { assigned_to: RETIRED });
    assert.equal(back.status, 400, JSON.stringify(back.body));
    assert.equal(back.body.error, "member_deactivated");
    assert.equal((await threadRow(THREAD_RETIRED_LEAD)).assigned_to, null);
  });

  // ── PATCH /api/conversations/drafts/[id] (SunBiz SMS handoff) ──────────
  const handoff = async (handoffUserId: string) => {
    const req = new NextRequest(`http://localhost/api/conversations/drafts/${DRAFT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "handoff", handoff_user_id: handoffUserId }),
    });
    const res = await draftsRoute.PATCH(req, { params: Promise.resolve({ id: DRAFT }) });
    return { status: res.status, body: (await res.json()) as ApiBody & { handoff_user_id?: string } };
  };
  const handoffState = async () => {
    const draft = await seed.execute({ sql: "SELECT handoff_user_id, handoff_at FROM sunbiz_reply_drafts WHERE id = ?", args: [DRAFT] });
    const state = await seed.execute({
      sql: "SELECT human_owner_id, automation_paused, last_action FROM sunbiz_conversation_state WHERE id = ?",
      args: [STATE],
    });
    return {
      handoffUserId: (draft.rows[0]?.handoff_user_id ?? null) as string | null,
      handoffAt: (draft.rows[0]?.handoff_at ?? null) as string | null,
      humanOwnerId: (state.rows[0]?.human_owner_id ?? null) as string | null,
      paused: Number(state.rows[0]?.automation_paused ?? 0),
      lastAction: (state.rows[0]?.last_action ?? null) as string | null,
    };
  };

  await check("drafts handoff: a deactivated target is refused (422) before any write", async () => {
    const refused = await handoff(RETIRED);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "handoff_user_deactivated");
    assert.equal(refused.body.message, MEMBER_DEACTIVATED_MESSAGE);
    assert.deepEqual(
      await handoffState(),
      { handoffUserId: null, handoffAt: null, humanOwnerId: null, paused: 0, lastAction: null },
      "a refused handoff still wrote the draft or paused the conversation",
    );
  });

  await check("drafts handoff: a user from another tenant is still handoff_user_not_found", async () => {
    const refused = await handoff(STRANGER);
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "handoff_user_not_found");
    assert.equal((await handoffState()).handoffUserId, null);
  });

  await check("drafts handoff: an active teammate takes the conversation and automation pauses", async () => {
    const ok = await handoff(AGENT_2);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.handoff_user_id, AGENT_2);
    const state = await handoffState();
    assert.equal(state.handoffUserId, AGENT_2);
    assert.equal(state.humanOwnerId, AGENT_2);
    assert.equal(state.paused, 1);
    assert.equal(state.lastAction, "handoff");
  });

  if (failures) {
    console.error(`conversation-routing-deactivated: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("conversation-routing-deactivated: ok");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
