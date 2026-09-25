/**
 * deactivated-rep-sunbiz-outbound.test.ts — a deactivated SunBiz rep keeps the
 * deals they worked (history), but NEW outbound mail and alerts never reach them.
 *
 * Six paths resolved a rep by id and handed them live work regardless of
 * user_profiles.deactivated_at:
 *
 *   - lib/forms/next-steps-email.ts         signer name/email/phone + CC on the
 *                                            merchant's funnel email
 *   - lib/renewals/outreach.ts              the renewal-threshold internal email
 *   - lib/notify/sunbiz-events.ts           per-user Telegram alerts (owner + admins)
 *   - POST /api/applications/[id]/shop-out  auto-CC / signer on new lender mail
 *                                            (also resolved the rep in ANY tenant)
 *   - lib/lenders/derive-agent-ccs.ts       the shop-out panel's pre-checked CCs
 *                                            (also resolved ids in ANY tenant)
 *
 * Everything runs for real against a local libSQL database. Stand-ins: the
 * session cookie jar, the SunBiz mailbox credential loader, nodemailer, the
 * Telegram sender and the bridge client, each of which records what it was
 * asked instead of reaching the network.
 *
 * Run: node --conditions=react-server --import tsx tests/deactivated-rep-sunbiz-outbound.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "deactivated-rep-outbound-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "deactivated-rep-outbound-secret-that-is-long-enough-0001";
// Never let a test reach Google, a bridge, SMTP or Telegram, whatever the
// developer's shell holds. The bot token is a dummy: the Telegram sender below
// is a recorder.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|SUNBIZ_TELEGRAM|TELEGRAM_)/.test(key)) delete process.env[key];
}
process.env.SUNBIZ_TELEGRAM_BOT_TOKEN = "test-only-token";
delete process.env.LEAD_SCOPING_ENABLED;

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

// The mailbox is asked for per tenant; record which one, so a fallback can never
// be shown reaching another tenant's inbox.
const credentialAsks: string[] = [];
stubModule(require.resolve("../lib/integrations/submissions-gmail"), {
  getSubmissionsCreds: async (tenantId: string) => {
    credentialAsks.push(tenantId);
    return { fromAddress: "submissions@sun.test", appPassword: "test-only" };
  },
  getSubmissionsFrom: async () => "SunBiz Submissions <submissions@sun.test>",
});

type SentMail = { from: string; to: string; subject: string; text: string };
const mails: SentMail[] = [];
stubModule(require.resolve("nodemailer"), {
  createTransport: () => ({
    sendMail: async (mail: SentMail) => {
      mails.push(mail);
      return { messageId: "test" };
    },
  }),
});

const telegramChats: string[] = [];
stubModule(require.resolve("../lib/notify/telegram"), {
  sendTelegram: async (_text: string, opts: { chatId: string }) => {
    telegramChats.push(opts.chatId);
    return { ok: true };
  },
});

// The merchant funnel email's bridge payload carries signer_* and cc: record it
// and report the send as done.
const bridgeCalls: Array<Record<string, unknown>> = [];
stubModule(require.resolve("../lib/bridge-proxy"), {
  resolveBridgeTarget: () => ({ url: "http://bridge.invalid", bearer: "test-only" }),
  callBridgeExecTool: async (_target: unknown, body: Record<string, unknown>) => {
    bridgeCalls.push(body);
    return { ok: true, httpStatus: 200, output: JSON.stringify({ status: "sent" }) };
  },
});

const TENANT = "8a8a8a8a-0000-4000-8000-00000000008a"; // SunBiz ("submissions")
const OTHER_TENANT = "8b8b8b8b-0000-4000-8000-00000000008b";
const ADMIN = "0f0f0f0f-0000-4000-8000-000000000001";
const RETIRED_ADMIN = "0f0f0f0f-0000-4000-8000-000000000002";
const ACTIVE_REP = "0f0f0f0f-0000-4000-8000-000000000003"; // alex@ on the roster
const RETIRED_REP = "0f0f0f0f-0000-4000-8000-000000000004"; // jordan@ on the roster (has a phone)
const STRANGER = "0f0f0f0f-0000-4000-8000-000000000005"; // a member of OTHER_TENANT only
const RETIRED_NO_EMAIL = "0f0f0f0f-0000-4000-8000-000000000006"; // deactivated, profile has no email
const RETIRED_AT = "2026-09-24T12:00:00Z";

const LENDER = "9c9c9c9c-0000-4000-8000-000000000001";
const APP_ACTIVE = "9c9c9c9c-0000-4000-8000-000000000002";
const APP_RETIRED = "9c9c9c9c-0000-4000-8000-000000000003";
const APP_STRANGER = "9c9c9c9c-0000-4000-8000-000000000004";

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

/** Chainable, thenable stand-in for the merchant-email handoff db
 *  (email-idempotency-marker.test.ts). The SunBiz direct-SMTP reservation comes
 *  back empty, so the send takes the bridge path the stub above records. */
function makeHandoffDb(assignedTo: string, assignedAgentName?: string) {
  const resultFor = (table: string, op: string): { data: unknown; error: unknown } => {
    if (table === "lead_interactions" && op === "select") return { data: [], error: null };
    if (table === "tenant_records" && op === "select") {
      return {
        data: {
          data: {
            email: "merchant@example.com",
            contact_name: "Dana Merchant",
            assigned_to: assignedTo,
            ...(assignedAgentName ? { assigned_agent_name: assignedAgentName } : {}),
          },
        },
        error: null,
      };
    }
    if (table === "tenants" && op === "select") {
      return { data: { slug: "submissions", name: "SunBiz Funding", custom_fields: null }, error: null };
    }
    return { data: null, error: null };
  };
  const from = (table: string) => {
    let op = "select";
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain, eq: chain, neq: chain, ilike: chain, contains: chain, order: chain,
      limit: chain, in: chain, gte: chain, like: chain,
      insert: () => { op = "insert"; return builder; },
      update: () => { op = "update"; return builder; },
      delete: () => { op = "delete"; return builder; },
      maybeSingle: async () => resultFor(table, op),
      single: async () => resultFor(table, op),
      then: (onFulfilled: (v: { data: unknown; error: unknown }) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resultFor(table, op)).then(onFulfilled, onRejected),
    });
    return builder;
  };
  return { from };
}

async function main() {
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
  `);
  const profile = (
    id: string, tenantId: string, authId: string, email: string, name: string, role: string,
    opts: { owner?: boolean; chat?: string; deactivatedAt?: string } = {},
  ) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name,
            onboarding_completed_at, joined_at, updated_at, custom_fields, deactivated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?, ?)`,
    args: [
      id, authId, email, tenantId, role, opts.owner ? 1 : 0, name,
      opts.chat ? JSON.stringify({ telegram_chat_id: opts.chat }) : null, opts.deactivatedAt ?? null,
    ],
  });
  const record = (id: string, entityType: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)",
    args: [id, TENANT, entityType, JSON.stringify(data)],
  });
  await seed.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, 'admin@sun.test')`, args: [ADMIN] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'Sun Biz Funding')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },
      profile("p-admin", TENANT, ADMIN, "admin@sun.test", "Ada Admin", "owner", { owner: true, chat: "chat-admin" }),
      profile("p-retired-admin", TENANT, RETIRED_ADMIN, "radmin@sun.test", "Rae Retired", "admin", {
        chat: "chat-retired-admin", deactivatedAt: RETIRED_AT,
      }),
      profile("p-alex", TENANT, ACTIVE_REP, "alex@sunbizfunding.com", "Alex Active", "agent", { chat: "chat-alex" }),
      profile("p-jordan", TENANT, RETIRED_REP, "jordan@sunbizfunding.com", "Jordan Retired", "agent", {
        chat: "chat-jordan", deactivatedAt: RETIRED_AT,
      }),
      // The retired rep is still active on another tenant. Every lookup below is
      // scoped to TENANT, so this row must never be what resolves them.
      profile("p-jordan-other", OTHER_TENANT, RETIRED_REP, "jordan@other.test", "Jordan Elsewhere", "agent"),
      // A roster address, but only ever a member of the OTHER tenant.
      profile("p-stranger", OTHER_TENANT, STRANGER, "Submissions@sunbizfunding.com", "Sam Stranger", "agent"),
      // A retired rep whose profile never had an email: still recognised as
      // deactivated, so the lead's cached name for them never signs either.
      profile("p-quinn", TENANT, RETIRED_NO_EMAIL, "", "Quinn Retired", "agent", { deactivatedAt: RETIRED_AT }),
      record(LENDER, "lender", { name: "Lender One", contact: "deals@lender.test" }),
      record(APP_ACTIVE, "application", { business_name: "Active Rep Co", assigned_to: ACTIVE_REP }),
      record(APP_RETIRED, "application", { business_name: "Retired Rep Co", assigned_to: RETIRED_REP }),
      record(APP_STRANGER, "application", { business_name: "Stranger Co", assigned_to: STRANGER }),
    ],
    "write",
  );
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const db = getServiceSupabase();

  // ── lib/forms/next-steps-email.ts: the merchant's funnel email ────────────
  const { maybeSendApplicationReceivedEmail } = await import("../lib/forms/next-steps-email");
  const sendReceipt = async (assignedTo: string, assignedAgentName?: string) => {
    bridgeCalls.length = 0;
    credentialAsks.length = 0;
    const { warned } = await captureWarn(() =>
      maybeSendApplicationReceivedEmail({
        db: makeHandoffDb(assignedTo, assignedAgentName) as never,
        form: { id: "form-1", tenant_id: TENANT, slug: "full-application" },
        link: { tenant: "submissions", lead_id: "lead-1" },
        payload: {},
        origin: "https://oasisai.work",
      }),
    );
    assert.equal(bridgeCalls.length, 1, "exactly one merchant email is sent");
    return { call: bridgeCalls[0], warned };
  };

  await check("funnel email: an active agent still signs with their address and is CC'd", async () => {
    const { call, warned } = await sendReceipt(ACTIVE_REP);
    assert.equal(call.signer_name, "Alex Active");
    assert.equal(call.signer_email, "alex@sunbizfunding.com");
    assert.equal(call.cc, "alex@sunbizfunding.com");
    assert.deepEqual(credentialAsks, [], "no inbox fallback is needed");
    assert.equal(tagged(warned, "[forms.handoff] assigned agent deactivated"), undefined);
  });

  await check("funnel email: a deactivated agent does not sign (the team does) and gets no address, phone or CC; submissions@ is CC'd", async () => {
    // The lead still caches the retired agent's name, as a real lead row does.
    const { call, warned } = await sendReceipt(RETIRED_REP, "Jordan Retired");
    assert.equal(call.signer_name, "the SunBiz team", "a new message is never signed by a deactivated agent");
    assert.match(String(call.body), /^- the SunBiz team$/m);
    assert.doesNotMatch(
      JSON.stringify(call),
      /jordan/i,
      "the retired agent's name and address appear nowhere in the rendered email",
    );
    assert.equal(call.signer_email, undefined, "a merchant reply must not reach a deactivated agent");
    assert.equal(call.signer_phone, undefined, "nor may their phone number appear");
    assert.equal(call.cc, "submissions@sun.test", "the tenant's own submissions inbox takes the copy");
    assert.deepEqual(credentialAsks, [TENANT], "only this tenant's mailbox supplies the fallback");
    const tag = tagged(warned, "[forms.handoff] assigned agent deactivated");
    assert.ok(tag, "withholding the agent must be visible in the logs");
    assert.equal((tag[1] as { assignedTo?: string }).assignedTo, RETIRED_REP);
  });

  await check("funnel email: a deactivated agent with no profile email is still withheld, never signed by the cached name", async () => {
    const { call, warned } = await sendReceipt(RETIRED_NO_EMAIL, "Quinn Retired");
    assert.equal(call.signer_name, "the SunBiz team");
    assert.doesNotMatch(JSON.stringify(call), /quinn/i, "the retired agent's cached name must not sign");
    assert.equal(call.cc, "submissions@sun.test");
    const tag = tagged(warned, "[forms.handoff] assigned agent deactivated");
    assert.ok(tag, "withholding the agent must be visible in the logs");
    assert.equal((tag[1] as { assignedTo?: string }).assignedTo, RETIRED_NO_EMAIL);
  });

  // ── lib/notify/sunbiz-events.ts: per-user Telegram recipients ─────────────
  const { resolveSunbizRecipients } = await import("../lib/notify/sunbiz-events");

  await check("telegram: a deactivated owner gets no alert and reads as unlinked; admins still do", async () => {
    const res = await resolveSunbizRecipients(db as never, TENANT, RETIRED_REP);
    assert.deepEqual(res.chatIds.sort(), ["chat-admin"]);
    assert.equal(res.ownerLinked, false);
  });

  await check("telegram: an active owner and the active admin are alerted; a deactivated admin never is", async () => {
    const res = await resolveSunbizRecipients(db as never, TENANT, ACTIVE_REP);
    assert.deepEqual(res.chatIds.sort(), ["chat-admin", "chat-alex"]);
    assert.equal(res.ownerLinked, true);
  });

  // ── lib/renewals/outreach.ts ──────────────────────────────────────────────
  const { notifyRenewalAgent } = await import("../lib/renewals/outreach");
  const renewal = async (agentId: string) => {
    mails.length = 0;
    telegramChats.length = 0;
    credentialAsks.length = 0;
    return captureWarn(() =>
      notifyRenewalAgent({
        db: db as never,
        tenantId: TENANT,
        leadId: "lead-1",
        agentId,
        merchant: "Digits Co",
        lender: "Lender One",
        amount: 50000,
        fundedAt: "2026-06-01",
        termLabel: "6 months",
        thresholdDate: "2026-09-01",
        dealId: "deal-1",
        status: "queued",
      }),
    );
  };

  await check("renewal notice: an active agent is emailed at their own address, unchanged", async () => {
    const { result } = await renewal(ACTIVE_REP);
    assert.equal(result.email, true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "alex@sunbizfunding.com");
    assert.doesNotMatch(mails[0].text, /agent inactive/);
    assert.deepEqual(telegramChats.sort(), ["chat-admin", "chat-alex"]);
  });

  await check("renewal notice: a deactivated agent's notice goes to this tenant's submissions inbox, marked inactive", async () => {
    const { result, warned } = await renewal(RETIRED_REP);
    assert.equal(result.email, true, "the renewal must still reach a human");
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "submissions@sun.test", "a deactivated agent must not be emailed");
    assert.match(mails[0].text, /\(agent inactive: Jordan Retired\)/);
    assert.deepEqual(credentialAsks, [TENANT], "only this tenant's mailbox is used");
    assert.deepEqual(telegramChats, ["chat-admin"], "neither the deactivated agent nor a deactivated admin is pinged");
    const tag = tagged(warned, "[renewal-outreach] deactivated-agent");
    assert.ok(tag, "the reroute must be visible in the logs");
    assert.equal((tag[1] as { agentId?: string }).agentId, RETIRED_REP);
  });

  await check("renewal notice: an id matching no member still sends no email", async () => {
    const { result } = await renewal(STRANGER);
    assert.equal(result.email, false);
    assert.equal(mails.length, 0);
  });

  // ── POST /api/applications/[id]/shop-out (dry run) ────────────────────────
  const { signSession } = await import("../lib/turso-auth");
  const { NextRequest } = await import("next/server");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  const shopOut = await import("../app/api/applications/[id]/shop-out/route");
  type PlanRow = { recipient_cc_emails: string[]; rendered_body: string };
  const dryRun = async (applicationId: string) => {
    const req = new NextRequest(`http://localhost/api/applications/${applicationId}/shop-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lender_ids: [LENDER],
        cc_emails: [],
        attachments: [],
        body_template: "Signed by {{agent.first_name}}",
        dry_run: true,
      }),
    });
    const { result: res, warned } = await captureWarn(() =>
      shopOut.POST(req, { params: Promise.resolve({ id: applicationId }) }),
    );
    const body = (await res.json()) as { ok?: boolean; error?: string; message?: string; plan?: PlanRow[] };
    assert.equal(res.status, 200, `dry run status (${body.error ?? ""} ${body.message ?? ""})`);
    assert.equal(body.plan?.length, 1);
    return { row: body.plan![0], warned };
  };

  await check("shop-out: an active assigned rep is still CC'd and signs", async () => {
    const { row } = await dryRun(APP_ACTIVE);
    assert.deepEqual(row.recipient_cc_emails, ["alex@sunbizfunding.com"]);
    assert.equal(row.rendered_body, "Signed by Alex");
  });

  await check("shop-out: a deactivated assigned rep is not CC'd and does not sign; the shared identity does", async () => {
    const { row, warned } = await dryRun(APP_RETIRED);
    assert.deepEqual(row.recipient_cc_emails, [], "neither jordan@ (retired here) nor jordan@other.test");
    assert.equal(row.rendered_body, "Signed by SunBiz Submissions");
    const tag = tagged(warned, "[shop-out] assigned rep deactivated");
    assert.ok(tag, "withholding the rep must be visible in the logs");
    assert.equal((tag[1] as { assignedTo?: string }).assignedTo, RETIRED_REP);
  });

  await check("shop-out: a rep id from another tenant is never resolved to a CC", async () => {
    const { row } = await dryRun(APP_STRANGER);
    assert.deepEqual(row.recipient_cc_emails, []);
    assert.equal(row.rendered_body, "Signed by SunBiz Submissions");
  });

  // ── lib/lenders/derive-agent-ccs.ts: the panel's pre-checked CCs ──────────
  const { deriveAgentCcs } = await import("../lib/lenders/derive-agent-ccs");
  const derive = async (appData: Record<string, unknown>) =>
    (await captureWarn(() => deriveAgentCcs(db as never, TENANT, appData))).result.map((a) => a.key);

  await check("pre-checked CCs: an active rep id resolves, unchanged", async () => {
    assert.deepEqual(await derive({ assigned_rep_id: ACTIVE_REP }), ["alex"]);
  });

  await check("pre-checked CCs: a deactivated rep id is not pre-checked", async () => {
    assert.deepEqual(await derive({ assigned_rep_id: RETIRED_REP }), []);
    assert.deepEqual(await derive({ assigned_rep_id: RETIRED_REP, owner_id: ACTIVE_REP }), ["alex"]);
  });

  await check("pre-checked CCs: an id that is a member of another tenant only is not resolved", async () => {
    assert.deepEqual(await derive({ owner_id: STRANGER }), []);
  });

  await check("pre-checked CCs: a typed address of a deactivated teammate is not pre-checked either", async () => {
    assert.deepEqual(await derive({ assigned_rep_email: "Jordan@SunBizFunding.com" }), []);
    assert.deepEqual(await derive({ assigned_rep_email: "alex@sunbizfunding.com" }), ["alex"]);
    // A roster address with no profile in THIS tenant is left to the roster gate.
    assert.deepEqual(await derive({ agent: "submissions@sunbizfunding.com" }), ["matt"]);
  });

  if (failures) {
    console.error(`deactivated-rep sunbiz outbound: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("deactivated-rep sunbiz outbound: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
