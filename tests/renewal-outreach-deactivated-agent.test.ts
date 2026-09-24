/**
 * renewal-outreach-deactivated-agent.test.ts — the 50%-term lender email is
 * sent AS the deal's agent, from their own mailbox, and the lender replies to
 * them. A deactivated agent keeps the deal (history) but must never send it.
 *
 * Two paths queued that email with no standing check:
 *
 *   - GET/POST /api/cron/renewal-thresholds   raises the event and queues the send
 *   - POST /api/renewals/[id]/outreach        approve / retry from the drawer
 *
 * Both now refuse a deactivated agent before resolving any mailbox, record the
 * event blocked with last_error `assigned_agent_deactivated`, and queue nothing.
 * A failed standing read queues nothing either (the send speaks as the person).
 * The approve/retry route sends as the lead's NEW owner once the deal has been
 * reassigned to an active teammate. Active agents behave exactly as before.
 *
 * Everything runs for real against a local libSQL database. Stand-ins: the
 * session cookie jar, the per-user mailbox store, the SunBiz mailbox credential
 * loader, nodemailer and the Telegram sender, each of which records what it was
 * asked instead of reaching the network.
 *
 * Run: node --conditions=react-server --import tsx tests/renewal-outreach-deactivated-agent.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "renewal-outreach-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "renewal-outreach-deactivated-secret-long-enough-0001";
process.env.CRON_SECRET = "renewal-outreach-test-cron";
process.env.CRON_ALLOW_LOCAL = "1";
// Never let a test reach Google, a bridge, SMTP or Telegram, whatever the
// developer's shell holds. The bot token is a dummy: the sender below records.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|SUNBIZ_TELEGRAM|TELEGRAM_)/.test(key)) delete process.env[key];
}
process.env.SUNBIZ_TELEGRAM_BOT_TOKEN = "test-only-token";

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

const TENANT = "8a8a8a8a-0000-4000-8000-00000000008a"; // SunBiz ("submissions")
const ADMIN = "0f0f0f0f-0000-4000-8000-000000000001";
const ACTIVE_AGENT = "0f0f0f0f-0000-4000-8000-000000000003";
const RETIRED_AGENT = "0f0f0f0f-0000-4000-8000-000000000004";
const FLAKY_AGENT = "0f0f0f0f-0000-4000-8000-000000000005"; // active; its read is made to fail
const RETIRED_AT = "2026-09-24T12:00:00Z";

// Each agent's own connected mailbox. Record every ask: a deactivated agent's
// mailbox must never even be resolved.
const MAILBOXES: Record<string, string> = {
  [ACTIVE_AGENT]: "alex@sunbizfunding.com",
  [RETIRED_AGENT]: "jordan@sunbizfunding.com",
  [FLAKY_AGENT]: "fran@sunbizfunding.com",
};
const mailboxAsks: string[] = [];
stubModule(require.resolve("../lib/user-integration-store"), {
  getUserIntegrationBundle: async (_tenantId: string, userId: string, service: string) => {
    mailboxAsks.push(userId);
    return service === "gmail_imap" && MAILBOXES[userId] ? { address: MAILBOXES[userId] } : {};
  },
});
stubModule(require.resolve("../lib/integrations/submissions-gmail"), {
  getSubmissionsCreds: async () => ({ fromAddress: "submissions@sun.test", appPassword: "test-only" }),
  getSubmissionsFrom: async () => "SunBiz Submissions <submissions@sun.test>",
});
type SentMail = { to: string; text: string };
const mails: SentMail[] = [];
stubModule(require.resolve("nodemailer"), {
  createTransport: () => ({
    sendMail: async (mail: SentMail) => {
      mails.push(mail);
      return { messageId: "test" };
    },
  }),
});
stubModule(require.resolve("../lib/notify/telegram"), {
  sendTelegram: async () => ({ ok: true }),
});

const LENDER = "9c9c9c9c-0000-4000-8000-000000000001";
const LEAD_ACTIVE = "9c9c9c9c-0000-4000-8000-000000000011";
const LEAD_RETIRED = "9c9c9c9c-0000-4000-8000-000000000012";
const LEAD_RETIRED_OLD = "9c9c9c9c-0000-4000-8000-000000000013";
const LEAD_ACTIVE_OLD = "9c9c9c9c-0000-4000-8000-000000000014";
const LEAD_FLAKY = "9c9c9c9c-0000-4000-8000-000000000015";
const DEAL_ACTIVE = "7d7d7d7d-0000-4000-8000-000000000001"; // due today, active agent
const DEAL_RETIRED = "7d7d7d7d-0000-4000-8000-000000000002"; // due today, deactivated agent
const DEAL_RETIRED_OLD = "7d7d7d7d-0000-4000-8000-000000000003"; // long past, deactivated agent
const DEAL_ACTIVE_OLD = "7d7d7d7d-0000-4000-8000-000000000004"; // long past, active agent
const DEAL_FLAKY = "7d7d7d7d-0000-4000-8000-000000000005"; // due today; standing read fails

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

async function main() {
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  const ID_SQL = "(lower(hex(randomblob(16))))";
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
    CREATE TABLE funded_deals (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT, lender_id TEXT,
      merchant_name TEXT NOT NULL, lender_name TEXT, funded_amount_usd REAL NOT NULL, funded_at TEXT NOT NULL,
      term_months INTEGER, term_value INTEGER, term_unit TEXT, next_renewal_date TEXT);
    CREATE TABLE scheduled_sends (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT NOT NULL, lead_id TEXT,
      thread_key TEXT, channel TEXT, to_email TEXT, subject TEXT, body TEXT, actor_user_id TEXT,
      from_identity TEXT, scheduled_for TEXT, status TEXT NOT NULL, sent_at TEXT, last_error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT ${NOW_SQL});
    -- database/132_renewal_outreach.sql, transpiled: the status CHECK is the real one.
    CREATE TABLE renewal_outreach_events (id TEXT PRIMARY KEY DEFAULT ${ID_SQL}, tenant_id TEXT NOT NULL,
      funded_deal_id TEXT NOT NULL, lead_id TEXT, lender_id TEXT, assigned_agent_id TEXT,
      event_kind TEXT NOT NULL DEFAULT '50_percent' CHECK (event_kind IN ('50_percent')),
      threshold_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('review_required','pending','queued','sent','blocked','failed','cancelled')),
      scheduled_send_id TEXT, internal_email_at TEXT, telegram_at TEXT, sent_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW_SQL}, updated_at TEXT NOT NULL DEFAULT ${NOW_SQL},
      UNIQUE (funded_deal_id, event_kind));
  `);
  const profile = (id: string, authId: string, email: string, name: string, role: string, opts: { owner?: boolean; deactivatedAt?: string } = {}) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name,
            onboarding_completed_at, joined_at, updated_at, deactivated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, email, TENANT, role, opts.owner ? 1 : 0, name, opts.deactivatedAt ?? null],
  });
  const record = (id: string, entityType: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)",
    args: [id, TENANT, entityType, JSON.stringify(data)],
  });
  const today = new Date().toISOString().slice(0, 10);
  const deal = (id: string, leadId: string, merchant: string, due: string) => ({
    sql: `INSERT INTO funded_deals (id, tenant_id, lead_id, lender_id, merchant_name, lender_name,
            funded_amount_usd, funded_at, term_value, term_unit, next_renewal_date)
          VALUES (?, ?, ?, ?, ?, 'Lender One', 50000, '2026-03-01', 6, 'months', ?)`,
    args: [id, TENANT, leadId, LENDER, merchant, due],
  });
  await seed.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, 'admin@sun.test')`, args: [ADMIN] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'Sun Biz Funding')", args: [TENANT] },
      profile("p-admin", ADMIN, "admin@sun.test", "Ada Admin", "owner", { owner: true }),
      profile("p-alex", ACTIVE_AGENT, "alex@sunbizfunding.com", "Alex Active", "agent"),
      profile("p-jordan", RETIRED_AGENT, "jordan@sunbizfunding.com", "Jordan Retired", "agent", { deactivatedAt: RETIRED_AT }),
      profile("p-fran", FLAKY_AGENT, "fran@sunbizfunding.com", "Fran Flaky", "agent"),
      record(LENDER, "lender", { name: "Lender One", contact_email: "deals@lender.test" }),
      record(LEAD_ACTIVE, "lead", { business_name: "Active Co", assigned_to: ACTIVE_AGENT }),
      record(LEAD_RETIRED, "lead", { business_name: "Retired Co", assigned_to: RETIRED_AGENT }),
      record(LEAD_RETIRED_OLD, "lead", { business_name: "Retired Old Co", assigned_to: RETIRED_AGENT }),
      record(LEAD_ACTIVE_OLD, "lead", { business_name: "Active Old Co", assigned_to: ACTIVE_AGENT }),
      record(LEAD_FLAKY, "lead", { business_name: "Flaky Co", assigned_to: FLAKY_AGENT }),
      deal(DEAL_ACTIVE, LEAD_ACTIVE, "Active Co", today),
      deal(DEAL_RETIRED, LEAD_RETIRED, "Retired Co", today),
      deal(DEAL_RETIRED_OLD, LEAD_RETIRED_OLD, "Retired Old Co", "2026-01-15"),
      deal(DEAL_ACTIVE_OLD, LEAD_ACTIVE_OLD, "Active Old Co", "2026-01-15"),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const cron = await import("../app/api/cron/renewal-thresholds/route");
  const outreach = await import("../app/api/renewals/[id]/outreach/route");

  type EventRow = { status: string; last_error: string | null; assigned_agent_id: string | null; scheduled_send_id: string | null };
  const eventFor = async (dealId: string) =>
    (await seed.execute({
      sql: "SELECT status, last_error, assigned_agent_id, scheduled_send_id FROM renewal_outreach_events WHERE funded_deal_id = ?",
      args: [dealId],
    })).rows[0] as unknown as EventRow | undefined;
  type SendRow = { actor_user_id: string; from_identity: string; to_email: string; status: string };
  const sendsFor = async (dealId: string) =>
    (await seed.execute({
      sql: "SELECT actor_user_id, from_identity, to_email, status FROM scheduled_sends WHERE thread_key = ?",
      args: [`renewal-lender:${dealId}`],
    })).rows as unknown as SendRow[];

  // Make every standing read fail while fn runs: the shared helper selects this
  // column, the session resolver and the Telegram lookup do not.
  const withBrokenStanding = async <T>(fn: () => Promise<T>): Promise<T> => {
    await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason TO deactivation_reason_gone");
    try {
      return await fn();
    } finally {
      await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason_gone TO deactivation_reason");
    }
  };

  const runCron = async () => {
    mailboxAsks.length = 0;
    mails.length = 0;
    const req = new NextRequest("http://localhost/api/cron/renewal-thresholds", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const { result: res, warned } = await captureWarn(() => cron.GET(req));
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, `cron status (${JSON.stringify(body)})`);
    return { body, warned };
  };

  // ── Cron: first pass over the four seeded deals ──────────────────────────
  const first = await runCron();

  await check("cron: an active agent's lender email is still queued from their own mailbox", async () => {
    const event = await eventFor(DEAL_ACTIVE);
    assert.equal(event?.status, "queued");
    assert.equal(event?.last_error, null);
    assert.equal(event?.assigned_agent_id, ACTIVE_AGENT);
    const sends = await sendsFor(DEAL_ACTIVE);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].actor_user_id, ACTIVE_AGENT);
    assert.equal(sends[0].from_identity, "alex@sunbizfunding.com");
    assert.equal(sends[0].to_email, "deals@lender.test");
    assert.ok(mailboxAsks.includes(ACTIVE_AGENT));
  });

  await check("cron: an active agent's long-past deal still waits for review, unchanged", async () => {
    const event = await eventFor(DEAL_ACTIVE_OLD);
    assert.equal(event?.status, "review_required");
    assert.equal(event?.last_error, null);
    assert.equal((await sendsFor(DEAL_ACTIVE_OLD)).length, 0);
  });

  await check("cron: a deactivated agent's lender email is not queued; the event is blocked with the reason", async () => {
    const event = await eventFor(DEAL_RETIRED);
    assert.equal(event?.status, "blocked");
    assert.equal(event?.last_error, "assigned_agent_deactivated");
    assert.equal(event?.assigned_agent_id, RETIRED_AGENT, "history keeps the funding agent on the event");
    assert.equal(event?.scheduled_send_id, null);
    assert.equal((await sendsFor(DEAL_RETIRED)).length, 0, "nothing may go out as the retired agent");
  });

  await check("cron: a deactivated agent's long-past deal is blocked too, not offered for approval", async () => {
    const event = await eventFor(DEAL_RETIRED_OLD);
    assert.equal(event?.status, "blocked");
    assert.equal(event?.last_error, "assigned_agent_deactivated");
    assert.equal((await sendsFor(DEAL_RETIRED_OLD)).length, 0);
  });

  await check("cron: a deactivated agent's mailbox is never resolved, and the block is logged", async () => {
    assert.ok(!mailboxAsks.includes(RETIRED_AGENT), `mailbox asks: ${mailboxAsks.join(",")}`);
    const tag = tagged(first.warned, "[renewal-thresholds] assigned agent deactivated");
    assert.ok(tag, "withholding the send must be visible in the logs");
    assert.equal((tag[1] as { agentId?: string }).agentId, RETIRED_AGENT);
    assert.equal(first.body.queued, 1);
    assert.equal(first.body.review_required, 1);
    assert.equal(first.body.blocked, 2);
  });

  await check("cron: the deactivated agent's internal notice still reaches the submissions inbox", async () => {
    const retiredNotices = mails.filter((mail) => /Retired/.test(mail.text));
    assert.equal(retiredNotices.length, 2);
    for (const mail of retiredNotices) assert.equal(mail.to, "submissions@sun.test");
    assert.ok(retiredNotices.every((mail) => /Outreach: blocked/.test(mail.text)));
  });

  // ── Cron: a standing read that fails queues nothing ──────────────────────
  await seed.execute(deal(DEAL_FLAKY, LEAD_FLAKY, "Flaky Co", today));
  const flaky = await withBrokenStanding(runCron);

  await check("cron: a failed standing read queues nothing and blocks the event with its own reason", async () => {
    const event = await eventFor(DEAL_FLAKY);
    assert.equal(event?.status, "blocked");
    assert.equal(event?.last_error, "assigned_agent_check_failed");
    assert.equal((await sendsFor(DEAL_FLAKY)).length, 0);
    assert.ok(!mailboxAsks.includes(FLAKY_AGENT), "no mailbox is resolved on an unknown standing");
    assert.ok(tagged(flaky.warned, "[renewal-thresholds] assigned agent check failed"), "the failed check is logged");
  });

  // ── POST /api/renewals/[id]/outreach ─────────────────────────────────────
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  const act = async (dealId: string, action: string) => {
    mailboxAsks.length = 0;
    const req = new NextRequest(`http://localhost/api/renewals/${dealId}/outreach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const { result: res, warned } = await captureWarn(() => outreach.POST(req, { params: Promise.resolve({ id: dealId }) }));
    const body = (await res.json()) as { ok?: boolean; error?: string; message?: string; status?: string };
    return { res, body, warned };
  };

  await check("outreach: approving an active agent's deal queues it from their mailbox, unchanged", async () => {
    const { res, body } = await act(DEAL_ACTIVE_OLD, "approve");
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "queued");
    const sends = await sendsFor(DEAL_ACTIVE_OLD);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].actor_user_id, ACTIVE_AGENT);
    assert.equal(sends[0].from_identity, "alex@sunbizfunding.com");
    const event = await eventFor(DEAL_ACTIVE_OLD);
    assert.equal(event?.status, "queued");
    assert.equal(event?.assigned_agent_id, ACTIVE_AGENT);
  });

  await check("outreach: retrying a deactivated agent's deal is refused with a clear 409 and queues nothing", async () => {
    const { res, body, warned } = await act(DEAL_RETIRED, "retry");
    assert.equal(res.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.error, "assigned_agent_deactivated");
    assert.match(String(body.message), /deactivated/);
    assert.match(String(body.message), /Reassign the deal to an active teammate/);
    assert.equal((await sendsFor(DEAL_RETIRED)).length, 0);
    assert.ok(!mailboxAsks.includes(RETIRED_AGENT), "the retired agent's mailbox is never resolved");
    const event = await eventFor(DEAL_RETIRED);
    assert.equal(event?.status, "blocked");
    assert.equal(event?.last_error, "assigned_agent_deactivated");
    assert.ok(tagged(warned, "[renewal-outreach] assigned agent deactivated"));
  });

  await check("outreach: approving a deactivated agent's deal (any action but cancel) is refused the same way", async () => {
    const { res, body } = await act(DEAL_RETIRED_OLD, "approve");
    assert.equal(res.status, 409);
    assert.equal(body.error, "assigned_agent_deactivated");
    assert.equal((await sendsFor(DEAL_RETIRED_OLD)).length, 0);
  });

  await check("outreach: once the deal is reassigned to an active teammate, retry sends as the new owner", async () => {
    await seed.execute({
      sql: "UPDATE tenant_records SET data = ? WHERE id = ?",
      args: [JSON.stringify({ business_name: "Retired Co", assigned_to: ACTIVE_AGENT }), LEAD_RETIRED],
    });
    const { res, body } = await act(DEAL_RETIRED, "retry");
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "queued");
    const sends = await sendsFor(DEAL_RETIRED);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].actor_user_id, ACTIVE_AGENT);
    assert.equal(sends[0].from_identity, "alex@sunbizfunding.com");
    assert.ok(!mailboxAsks.includes(RETIRED_AGENT));
    const event = await eventFor(DEAL_RETIRED);
    assert.equal(event?.status, "queued");
    assert.equal(event?.last_error, null);
    assert.equal(event?.assigned_agent_id, ACTIVE_AGENT, "the ledger names who actually sent it");
  });

  await check("outreach: a failed standing read on retry queues nothing and answers 503", async () => {
    const { res, body, warned } = await withBrokenStanding(() => act(DEAL_FLAKY, "retry"));
    assert.equal(res.status, 503);
    assert.equal(body.error, "assigned_agent_check_failed");
    assert.equal((await sendsFor(DEAL_FLAKY)).length, 0);
    assert.ok(!mailboxAsks.includes(FLAKY_AGENT));
    const event = await eventFor(DEAL_FLAKY);
    assert.equal(event?.status, "blocked");
    assert.equal(event?.last_error, "assigned_agent_check_failed");
    assert.ok(tagged(warned, "[renewal-outreach] assigned agent check failed"));
  });

  await check("outreach: once the read recovers, the same retry sends as the (active) agent", async () => {
    const { res, body } = await act(DEAL_FLAKY, "retry");
    assert.equal(res.status, 200, JSON.stringify(body));
    const sends = await sendsFor(DEAL_FLAKY);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].actor_user_id, FLAKY_AGENT);
    assert.equal(sends[0].from_identity, "fran@sunbizfunding.com");
  });

  if (failures) {
    console.error(`renewal outreach deactivated agent: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("renewal outreach deactivated agent: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
