/**
 * lender-thread-cc-deactivated.test.ts — a NEW reply or retry on an existing
 * lender thread never CCs a teammate deactivated since the original shop-out.
 *
 * A thread's cc_emails is frozen at the first send, and the per-reply override
 * was checked only against agents.config.json, so a rep deactivated afterwards
 * was copied on every later message to the lender:
 *
 *   POST .../lender-threads/[threadId]/reply   stored or operator-supplied CCs
 *   POST .../lender-threads/[threadId]/retry   FunMate: CCs sent directly
 *                                              SunBiz: CCs the bridge sender
 *                                              reads off the pending row
 *
 * Both now pass the list through dropDeactivatedEmails
 * (lib/lenders/derive-agent-ccs.ts). Active teammates and outside addresses are
 * untouched; the check is scoped to the thread's tenant.
 *
 * Everything runs for real against a local libSQL database. Stand-ins: the
 * session cookie jar, the SunBiz Gmail sender, the FunMate SMTP sender and the
 * bridge fetch, each of which records what it was asked instead of sending.
 *
 * Run: node --conditions=react-server --import tsx tests/lender-thread-cc-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "lender-thread-cc-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "lender-thread-cc-deactivated-secret-long-enough-0001";
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|FUNMATE_)/.test(key)) delete process.env[key];
}

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

// The reply route's SunBiz Gmail send: record the CC list it was handed.
const gmailSends: Array<{ to: string; cc?: string[] }> = [];
stubModule(require.resolve("../lib/integrations/submissions-gmail-send"), {
  sendGmail: async (payload: { to: string; cc?: string[] }) => {
    gmailSends.push({ to: payload.to, cc: payload.cc });
    return {
      ok: true,
      message_id: "smtp-id",
      rfc822_message_id: `<reply-${gmailSends.length}@sun.test>`,
      thread_id: "<original@sun.test>",
    };
  },
});

// The retry route's FunMate path sends over SMTP directly.
const funmateSends: Array<{ to: string; cc?: string[] }> = [];
stubModule(require.resolve("../lib/integrations/funmate-mail-send"), {
  sendFunmateMail: async (input: { to: string; cc?: string[] }) => {
    funmateSends.push({ to: input.to, cc: input.cc });
    return { ok: true, rfc822MessageId: `<funmate-${funmateSends.length}@fm.test>` };
  },
});
stubModule(require.resolve("../lib/integrations/funmate-mail"), {
  verifyFunmateSmtp: async () => ({ ok: true }),
  getFunmateMailCredentials: () => ({}),
});

const TENANT = "7a7a7a7a-0000-4000-8000-00000000007a"; // SunBiz ("submissions")
const OTHER_TENANT = "7b7b7b7b-0000-4000-8000-00000000007b";
const ADMIN = "0e0e0e0e-0000-4000-8000-000000000001";
const RETIRED_AT = "2026-09-24T12:00:00Z";

const ALEX = "alex@sunbizfunding.com"; // roster, active here
const JORDAN = "jordan@sunbizfunding.com"; // roster, deactivated here, ACTIVE in OTHER_TENANT
const CASEY = "casey@sun.test"; // two profiles here: one deactivated, one active
const RILEY = "riley@sun.test"; // not on the roster, deactivated here (an old assigned rep)
const LENDER_CC = "ops@lender.test"; // the lender's own CC: no profile anywhere

const LENDER = "4d4d4d4d-0000-4000-8000-000000000001";
const APP_REPLY = "4d4d4d4d-0000-4000-8000-000000000002";
const APP_RETRY_RETIRED = "4d4d4d4d-0000-4000-8000-000000000003";
const APP_RETRY_ACTIVE = "4d4d4d4d-0000-4000-8000-000000000004";
const APP_RETRY_FUNMATE = "4d4d4d4d-0000-4000-8000-000000000005";

const T_REPLY_STORED = "5e5e5e5e-0000-4000-8000-000000000001";
const T_REPLY_ACTIVE = "5e5e5e5e-0000-4000-8000-000000000002";
const T_REPLY_OVERRIDE = "5e5e5e5e-0000-4000-8000-000000000003";
const T_RETRY_RETIRED = "5e5e5e5e-0000-4000-8000-000000000004";
const T_RETRY_ACTIVE = "5e5e5e5e-0000-4000-8000-000000000005";
const T_RETRY_FUNMATE = "5e5e5e5e-0000-4000-8000-000000000006";

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

/** Run fn with console.warn captured and console.error silenced. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: unknown[][] }> {
  const warned: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  console.error = () => undefined;
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}
const tagged = (warned: unknown[][], tag: string) => warned.find((args) => args[0] === tag);
const DROPPED_TAG = "[derive-agent-ccs] deactivated teammate dropped from cc";
const FAILED_TAG = "[derive-agent-ccs] cc teammate check failed";

async function main() {
  console.log("lender-thread-cc-deactivated:");
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, invited_by TEXT,
      joined_at TEXT, manager_user_id TEXT, updated_at TEXT, custom_fields TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_by TEXT, created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE application_lender_threads (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      application_id TEXT NOT NULL, lender_id TEXT NOT NULL, status TEXT, last_error TEXT,
      email_identity TEXT, subject TEXT, body_template TEXT, attachments TEXT, cc_emails TEXT,
      gmail_thread_id TEXT, last_message_id TEXT, message_id_history TEXT, sent_at TEXT,
      updated_at TEXT);
  `);
  const profile = (id: string, tenantId: string, email: string, role: string, deactivatedAt: string | null = null) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name,
            onboarding_completed_at, joined_at, updated_at, deactivated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?)`,
    args: [
      id, id === "p-admin" ? ADMIN : `auth-${id}`, email, tenantId, role, id === "p-admin" ? 1 : 0,
      email.split("@")[0], deactivatedAt,
    ],
  });
  const record = (id: string, entityType: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)",
    args: [id, TENANT, entityType, JSON.stringify(data)],
  });
  const thread = (
    id: string, applicationId: string, status: string, cc: string[], emailIdentity: string | null = null,
  ) => ({
    sql: `INSERT INTO application_lender_threads (id, tenant_id, application_id, lender_id, status,
            email_identity, subject, body_template, attachments, cc_emails, gmail_thread_id,
            last_message_id, message_id_history, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'New Deal', 'Hello lender', '[]', ?, ?, ?, ?, '2026-09-20T00:00:00Z')`,
    args: [
      id, TENANT, applicationId, LENDER, status, emailIdentity, JSON.stringify(cc),
      status === "sent" ? "<original@sun.test>" : null,
      status === "sent" ? "<original@sun.test>" : null,
      status === "sent" ? JSON.stringify(["<original@sun.test>"]) : null,
    ],
  });
  await seed.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, 'admin@sun.test')`, args: [ADMIN] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'Sun Biz Funding')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },
      profile("p-admin", TENANT, "admin@sun.test", "owner"),
      profile("p-alex", TENANT, ALEX, "agent"),
      profile("p-jordan", TENANT, JORDAN, "agent", RETIRED_AT),
      // Same address, still active in another workspace. Must not keep Jordan here.
      profile("p-jordan-other", OTHER_TENANT, JORDAN, "agent"),
      profile("p-casey-old", TENANT, CASEY, "agent", RETIRED_AT),
      profile("p-casey", TENANT, CASEY, "agent"),
      profile("p-riley", TENANT, RILEY, "agent", RETIRED_AT),
      record(LENDER, "lender", { name: "Lender One", contact: "deals@lender.test" }),
      record(APP_REPLY, "application", { business_name: "Reply Co" }),
      record(APP_RETRY_RETIRED, "application", { business_name: "Retry Retired Co" }),
      record(APP_RETRY_ACTIVE, "application", { business_name: "Retry Active Co" }),
      record(APP_RETRY_FUNMATE, "application", { business_name: "Retry FunMate Co" }),
      thread(T_REPLY_STORED, APP_REPLY, "sent", [ALEX, JORDAN, LENDER_CC, CASEY, RILEY]),
      thread(T_REPLY_ACTIVE, APP_REPLY, "sent", [ALEX, LENDER_CC]),
      thread(T_REPLY_OVERRIDE, APP_REPLY, "sent", [ALEX]),
      thread(T_RETRY_RETIRED, APP_RETRY_RETIRED, "error", [ALEX, JORDAN, LENDER_CC, RILEY]),
      thread(T_RETRY_ACTIVE, APP_RETRY_ACTIVE, "error", [ALEX, LENDER_CC]),
      thread(T_RETRY_FUNMATE, APP_RETRY_FUNMATE, "error", [JORDAN, ALEX, LENDER_CC], "funmate"),
    ],
    "write",
  );
  const storedCc = async (threadId: string): Promise<string[]> => {
    const rs = await seed.execute({ sql: "SELECT cc_emails FROM application_lender_threads WHERE id = ?", args: [threadId] });
    return JSON.parse(String(rs.rows[0].cc_emails));
  };

  // The SunBiz retry fires the bridge over HTTP; the bridge sends each pending
  // row's stored cc_emails. Record exactly what it would read at that moment.
  const bridgeReads: Array<{ applicationId: string; cc: string[][] }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.match(url, /\/api\/bridge\/exec-tool$/, `unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as { tool_name: string; application_id: string };
    assert.equal(body.tool_name, "shop_out_send_batch");
    const rs = await seed.execute({
      sql: "SELECT cc_emails FROM application_lender_threads WHERE application_id = ? AND status = 'pending'",
      args: [body.application_id],
    });
    bridgeReads.push({
      applicationId: body.application_id,
      cc: rs.rows.map((row) => JSON.parse(String(row.cc_emails)) as string[]),
    });
    return new Response(JSON.stringify({ output: JSON.stringify({ sent: rs.rows.length, failed: 0 }) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { signSession } = await import("../lib/turso-auth");
  const { NextRequest } = await import("next/server");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  // ── POST .../reply ────────────────────────────────────────────────────────
  const replyRoute = await import("../app/api/applications/[id]/lender-threads/[threadId]/reply/route");
  const reply = async (threadId: string, extra: Record<string, unknown> = {}) => {
    gmailSends.length = 0;
    const req = new NextRequest(`http://localhost/api/applications/${APP_REPLY}/lender-threads/${threadId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Following up on this file.", ...extra }),
    });
    const { result: res, warned } = await captureWarn(() =>
      replyRoute.POST(req, { params: Promise.resolve({ id: APP_REPLY, threadId }) }),
    );
    const body = (await res.json()) as { ok?: boolean; error?: string };
    assert.equal(res.status, 200, `reply status (${body.error ?? ""})`);
    assert.equal(gmailSends.length, 1, "exactly one reply is sent");
    return { cc: gmailSends[0].cc, warned };
  };

  await check("reply: stored CCs drop the deactivated agent and teammate; active agents and the lender's CC stay", async () => {
    const { cc, warned } = await reply(T_REPLY_STORED);
    assert.deepEqual(cc, [ALEX, LENDER_CC, CASEY], "jordan@ and riley@ are deactivated here");
    assert.deepEqual(await storedCc(T_REPLY_STORED), [ALEX, LENDER_CC, CASEY], "the thread keeps the trimmed list");
    const tag = tagged(warned, DROPPED_TAG);
    assert.ok(tag, "dropping a CC must be visible in the logs");
    assert.deepEqual((tag[1] as { dropped?: string[] }).dropped, [JORDAN, RILEY]);
  });

  await check("reply: an all-active CC list is sent exactly as stored, with no warning", async () => {
    const { cc, warned } = await reply(T_REPLY_ACTIVE);
    assert.deepEqual(cc, [ALEX, LENDER_CC]);
    assert.deepEqual(await storedCc(T_REPLY_ACTIVE), [ALEX, LENDER_CC]);
    assert.equal(tagged(warned, DROPPED_TAG), undefined);
  });

  await check("reply: an operator-supplied CC of a deactivated roster agent is dropped too", async () => {
    const { cc } = await reply(T_REPLY_OVERRIDE, { cc_emails: ["Jordan@SunBizFunding.com", ALEX] });
    assert.deepEqual(cc, [ALEX]);
  });

  // ── POST .../retry ────────────────────────────────────────────────────────
  const retryRoute = await import("../app/api/applications/[id]/lender-threads/[threadId]/retry/route");
  const retry = async (applicationId: string, threadId: string) => {
    bridgeReads.length = 0;
    funmateSends.length = 0;
    const req = new NextRequest(`http://localhost/api/applications/${applicationId}/lender-threads/${threadId}/retry`, {
      method: "POST",
    });
    const { result: res, warned } = await captureWarn(() =>
      retryRoute.POST(req, { params: Promise.resolve({ id: applicationId, threadId }) }),
    );
    const body = (await res.json()) as { ok?: boolean; error?: string; new_status?: string };
    assert.equal(res.status, 200, `retry status (${body.error ?? ""})`);
    assert.equal(body.ok, true);
    return { body, warned };
  };

  await check("retry (SunBiz): the pending row the bridge sends no longer CCs the deactivated agent", async () => {
    const { body, warned } = await retry(APP_RETRY_RETIRED, T_RETRY_RETIRED);
    assert.equal(body.new_status, "pending");
    assert.deepEqual(bridgeReads, [{ applicationId: APP_RETRY_RETIRED, cc: [[ALEX, LENDER_CC]] }]);
    assert.ok(tagged(warned, DROPPED_TAG), "dropping a CC must be visible in the logs");
  });

  await check("retry (SunBiz): an all-active row is re-sent with its CCs untouched", async () => {
    const { warned } = await retry(APP_RETRY_ACTIVE, T_RETRY_ACTIVE);
    assert.deepEqual(bridgeReads, [{ applicationId: APP_RETRY_ACTIVE, cc: [[ALEX, LENDER_CC]] }]);
    assert.equal(tagged(warned, DROPPED_TAG), undefined);
  });

  await check("retry (FunMate): the direct SMTP send drops the deactivated agent, keeps the rest", async () => {
    await retry(APP_RETRY_FUNMATE, T_RETRY_FUNMATE);
    assert.equal(funmateSends.length, 1);
    assert.deepEqual(funmateSends[0].cc, [ALEX, LENDER_CC]);
    assert.equal(bridgeReads.length, 0, "the FunMate path never reaches the bridge");
  });

  // ── dropDeactivatedEmails directly ────────────────────────────────────────
  const { dropDeactivatedEmails } = await import("../lib/lenders/derive-agent-ccs");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const db = getServiceSupabase();
  const drop = async (tenantId: string, emails: string[]) =>
    captureWarn(() => dropDeactivatedEmails(db as never, tenantId, emails));

  await check("tenant scoping: active in another workspace does not keep a teammate deactivated here", async () => {
    assert.deepEqual((await drop(TENANT, [JORDAN, LENDER_CC])).result, [LENDER_CC]);
    // ...and the reverse: in the workspace where Jordan is active, Jordan stays.
    assert.deepEqual((await drop(OTHER_TENANT, [JORDAN, LENDER_CC])).result, [JORDAN, LENDER_CC]);
  });

  await check("read error: roster agents are dropped (unverifiable), every other address is kept", async () => {
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      const { result, warned } = await drop(TENANT, [ALEX, "SUBMISSIONS@sunbizfunding.com", LENDER_CC, CASEY]);
      assert.deepEqual(result, [LENDER_CC, CASEY]);
      const tag = tagged(warned, FAILED_TAG);
      assert.ok(tag, "a failed check must be visible in the logs");
      assert.deepEqual((tag[1] as { dropped?: string[] }).dropped, [ALEX, "SUBMISSIONS@sunbizfunding.com"]);
    } finally {
      await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
  });

  if (failures) {
    console.error(`lender-thread-cc-deactivated: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("lender-thread-cc-deactivated: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
