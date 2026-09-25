/**
 * lead-email-deactivated-assignee-warning.test.ts — an OASIS lead email on a
 * deal whose rep has been deactivated tells the sender why that rep was not
 * copied.
 *
 * A won or in-delivery lead keeps its deactivated owner for history
 * (2026-09-24). resolveAssigneeEmail answers { status: "deactivated" } for that
 * owner, and the send route leaves them off Cc / Reply-To. But the route only
 * turned "lookup_failed" and "no_address" into a tracking warning, so the
 * operator got a plain success and no way to know the rep who holds the deal
 * never saw it.
 *
 * POST /api/leads/[id]/email runs for real — session, lead access, suppression
 * check, brand resolution, the interaction reservation and its receipt — against
 * a local libSQL database. The stand-ins are next/headers' cookie jar and the
 * three mail transports: the operator app-password / OAuth checks (no mailbox
 * connected) and the OASIS shared mailbox, which records what it was asked to
 * send instead of opening SMTP.
 *
 * Run: node --conditions=react-server --import tsx tests/lead-email-deactivated-assignee-warning.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "lead-email-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "lead-email-deactivated-secret-that-is-long-enough-0001";
// Never let a test reach Google, a bridge or a real mailbox, whatever the
// developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|OASIS_MAIL_)/.test(key)) delete process.env[key];
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

// No operator mailbox is connected, as on the live tenant, so the route takes
// the OASIS shared mailbox — the transport that carries Cc and Reply-To.
stubModule(require.resolve("../lib/integrations/gmail-apppassword-send"), {
  operatorHasAppPassword: async () => false,
  sendGmailAppPasswordAsOperator: async () => {
    throw new Error("the operator app-password path must not run in this test");
  },
});
stubModule(require.resolve("../lib/integrations/gmail-oauth-send"), {
  operatorHasGmailOAuth: async () => false,
  sendGmailAsOperator: async () => {
    throw new Error("the operator OAuth path must not run in this test");
  },
});

const MAILBOX = "conaugh@oasisai.work";
type SharedSend = { tenantId: string; to: string; cc?: string[]; replyTo?: string | null };
const sharedSends: SharedSend[] = [];
stubModule(require.resolve("../lib/integrations/oasis-shared-gmail-send"), {
  resolveOasisMailboxFrom: async () => MAILBOX,
  sendOasisSharedGmail: async (args: SharedSend) => {
    sharedSends.push(args);
    return { ok: true, from_address: MAILBOX, gmail_message_id: `gm-${sharedSends.length}` };
  },
});

// OASIS by tenant id (lib/email/brand-for-tenant.ts TENANT_ID_BRAND).
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const ADON = { id: "3e3e3e3e-0000-4000-8000-000000000001", email: "adon@oasisai.work" };
const ACTIVE_REP = { id: "3e3e3e3e-0000-4000-8000-000000000002", email: "active-rep@oasisai.work" };
const RETIRED_REP = { id: "3e3e3e3e-0000-4000-8000-000000000003", email: "retired-rep@oasisai.work" };
const RETIRED_LEAD = "4f4f4f4f-0000-4000-8000-000000000001";
const ACTIVE_LEAD = "4f4f4f4f-0000-4000-8000-000000000002";
const PROSPECT = "owner@prospect-business.test";

type EmailBody = { ok?: boolean; error?: string; tracking_warning?: string | null };

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function main() {
  console.log("lead-email-deactivated-assignee-warning:");
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
    CREATE TABLE tenant_manifests (
      id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT
    );
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
      content_preview TEXT, to_email TEXT, metadata TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE email_suppressions (tenant_id TEXT, email TEXT);
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), correlation_id TEXT,
      event_type TEXT, publisher_agent TEXT, target_agent TEXT, severity TEXT,
      payload TEXT, published_at TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
  `);

  const at = "2026-09-01T00:00:00Z";
  const profile = (u: { id: string; email: string }, role: string, name: string, deactivatedAt?: string) => [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [u.id, u.email] },
    {
      sql: `INSERT INTO user_profiles
              (id, auth_user_id, email, tenant_id, team_role, onboarding_completed_at, full_name,
               joined_at, updated_at, deactivated_at, deactivation_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `p-${u.id}`, u.id, u.email, TENANT, role, at, name, at, at,
        deactivatedAt ?? null, deactivatedAt ? "Sales team retired" : null,
      ],
    },
  ];
  const lead = (id: string, assignedTo: string) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({ name: "Prospect Co", email: PROSPECT, stage: "won", assigned_to: assignedTo })],
  });
  await seed.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [TENANT] },
      ...profile(ADON, "admin", "Adon"),
      ...profile(ACTIVE_REP, "closer", "Active Rep"),
      ...profile(RETIRED_REP, "closer", "Retired Rep", "2026-09-24T12:00:00Z"),
      lead(RETIRED_LEAD, RETIRED_REP.id),
      lead(ACTIVE_LEAD, ACTIVE_REP.id),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const emailRoute = await import("../app/api/leads/[id]/email/route");
  sessionCookie = signSession({ sub: ADON.id, email: ADON.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  const send = async (leadId: string) => {
    const before = sharedSends.length;
    const req = new NextRequest(`http://localhost/api/leads/${leadId}/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_email: PROSPECT, subject: "Following up", body: "Hi there, following up." }),
    });
    const res = await emailRoute.POST(req, { params: Promise.resolve({ id: leadId }) });
    const body = (await res.json()) as EmailBody;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(sharedSends.length, before + 1, "the shared mailbox was not asked to send");
    const warnings = (body.tracking_warning || "").split(",").filter(Boolean);
    return { warnings, sent: sharedSends[sharedSends.length - 1] };
  };
  const deactivatedWarning = (warnings: string[]) => warnings.find((w) => /deactivated/i.test(w));

  await check("a deactivated owner is not copied, and the sender is told why in words", async () => {
    const { warnings, sent } = await send(RETIRED_LEAD);
    assert.equal(sent.tenantId, TENANT, "sent through another tenant's mailbox");
    assert.equal(sent.cc?.includes(RETIRED_REP.email), false, "the deactivated rep was copied");
    assert.equal(sent.replyTo, ADON.email, "the Reply-To fallback is the sender, unchanged");
    const warning = deactivatedWarning(warnings);
    assert.ok(warning, `no deactivated-owner warning in ${JSON.stringify(warnings)}`);
    assert.match(warning, /\s/, `"${warning}" is a code, not a sentence`);
    assert.match(warning, /not copied/i, "the warning must say the rep was left off the email");
    assert.ok(
      !warnings.includes("assignee_has_no_address") && !warnings.includes("assignee_lookup_failed"),
      "a deactivated owner must not read as a missing address or a failed lookup",
    );
  });

  await check("an active owner is copied first and becomes the Reply-To, with no such warning", async () => {
    const { warnings, sent } = await send(ACTIVE_LEAD);
    assert.equal(sent.cc?.[0], ACTIVE_REP.email, "the active owner leads the copy list");
    assert.equal(sent.replyTo, ACTIVE_REP.email);
    assert.equal(deactivatedWarning(warnings), undefined, `unexpected warning in ${JSON.stringify(warnings)}`);
  });

  if (failures) {
    console.log(`lead-email-deactivated-assignee-warning: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("lead-email-deactivated-assignee-warning: all passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
