/**
 * role-gates-and-platform-keys.test.ts — four P1 findings from the 2026-10-19
 * audit, all about who may change what.
 *
 *   1. A read_only seat could act. E-sign create/send/remind, the drip sending
 *      caps and eight manifest writes never asked the caller's role. E-sign and
 *      the manifest writes now need a CRM writer (canWriteCrm, an allowlist) or
 *      an admin; the manifest routes, which take their workspace from the URL
 *      slug, go through sessionMayWriteCrm (lib/api-auth.ts), which also needs
 *      the session's ACTIVE workspace to be that one. Drip caps are admin only.
 *   2. SCAN_TRIGGER_SECRET, a platform automation key, took the workspace from
 *      the request body on cold-sending/blast, cold-sending/mailboxes and
 *      operator-email/connect-imap. It now acts only in OASIS's own workspaces
 *      (tenantMayUseEnvFallback, by exact id).
 *   3. Kixie business ids could be squatted: sync-webhooks stamped the typed-in
 *      id before Kixie accepted anything and never asked who held it. Now a held
 *      id is refused (409) and the id is stamped only after Kixie accepted.
 *   4. cron/operator-email-agent took the scan key (or the cron secret alone).
 *      It now uses checkCronAuth like every other cron route.
 *
 * Every route runs for real through tests/_delivery-harness.ts: real signed
 * sessions, real profiles, real SQL against a local libSQL file. The seats
 * this needs (read_only, an unknown role, a member, an admin, an admin by
 * grant, a two-workspace member) are created here rather than in the shared
 * harness, so no other test's roster changes. Nothing leaves the machine:
 * nodemailer and imapflow are stand-ins, and fetch answers only Kixie's API
 * (from a stand-in) and refuses everything else, which the last check asserts.
 *
 * Run: node --conditions=react-server --import tsx tests/role-gates-and-platform-keys.test.ts
 */
import { CLIENT_A, CLIENT_B, OASIS, USERS, check, finish, login, setupDatabase, splitSql } from "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextRequest } from "next/server";

const SCAN_KEY = "scan-trigger-key-role-gates-test-0001";
const CRON_KEY = "cron-secret-role-gates-test-000000001";
process.env.SCAN_TRIGGER_SECRET = SCAN_KEY;
process.env.CRON_SECRET = CRON_KEY;
delete process.env.CRON_ALLOW_LOCAL;
delete process.env.CRON_ATTEST_SECRET;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "role-gates-and-platform-keys-field-key-0001";
process.env.KIXIE_WEBHOOK_SECRET = "kixie-webhook-secret-role-gates-test";
// OASIS's env Kixie account must not stand in for anyone's stored key here.
for (const k of ["KIXIE_API_KEY", "KIXIE_BUSINESS_ID", "KIXIE_FROM_NUMBER", "KIXIE_DEFAULT_AGENT_EMAIL", "ESIGN_FROM_EMAIL", "ESIGN_FROM_APP_PASSWORD"]) {
  delete process.env[k];
}

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

// SMTP: verify() passes, sendMail() is recorded, nothing is sent.
type Mail = { from?: unknown; to?: unknown; subject?: unknown };
const mails: Mail[] = [];
stub("nodemailer", {
  createTransport: () => ({
    verify: async () => true,
    sendMail: async (m: Mail) => {
      mails.push(m);
      return { messageId: `<role-gates-${mails.length}@test>` };
    },
  }),
});
// IMAP: a login that succeeds and is recorded.
const imapLogins: string[] = [];
stub("imapflow", {
  ImapFlow: class {
    private readonly user: string;
    constructor(opts: { auth: { user: string } }) {
      this.user = opts.auth.user;
    }
    async connect() {
      imapLogins.push(this.user);
    }
    async logout() {}
  },
});
// The network: Kixie's API answers from here; anything else is refused.
// "ambiguous" is a 200 that neither confirms nor says success:false.
let kixieAnswer: "accept" | "reject" | "ambiguous" = "reject";
const kixieCalls: Array<Record<string, unknown>> = [];
// Runs once, before the next Kixie call is answered: what another request
// does while this one's registrations are in flight.
let beforeNextKixieCall: (() => Promise<void>) | null = null;
const strayFetches: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://apig.kixie.com/")) {
    if (beforeNextKixieCall) {
      const hook = beforeNextKixieCall;
      beforeNextKixieCall = null;
      await hook();
    }
    kixieCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const answer =
      kixieAnswer === "accept"
        ? { success: true, webhookid: kixieCalls.length }
        : kixieAnswer === "ambiguous"
          ? { error: "apiKey is invalid" }
          : { success: false, error: "apiKey is invalid" };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }
  strayFetches.push(url);
  throw new Error(`network refused in this test: ${url}`);
}) as typeof fetch;

const UUID_SQL =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))";
const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

type Seat = { id: string; email: string };
const seatUser = (n: number, email: string): Seat => ({ id: `0d000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, email });
const SEATS = {
  viewer: seatUser(1, "viewer@client-a.test"), // read_only in Client A
  odd: seatUser(2, "odd@client-a.test"), // "intern": a role nobody defined
  writer: seatUser(3, "writer@client-a.test"), // member in Client A: a CRM writer, not an admin
  admin: seatUser(4, "admin@client-a.test"), // admin in Client A, not the owner
  toggled: seatUser(5, "toggled@client-a.test"), // read_only, but an admin by the admin_access grant
  rolling: seatUser(6, "rolling@client-a.test"), // its role is set per check
  dual: seatUser(7, "dual@client-a.test"), // member in Client A AND Client B; B is the active one
} as const;

const SLUG = "client-a";
const LIST_1 = "11111111-0000-4000-8000-000000000001";
const LIST_2 = "11111111-0000-4000-8000-000000000002";
const OBJECT_1 = "22222222-0000-4000-8000-000000000001";
const VIEW_1 = "33333333-0000-4000-8000-000000000001";
const OFFER_1 = "offer-client-a-1";
const ENVELOPE_DRAFT = "44444444-0000-4000-8000-000000000001";
const ENVELOPE_SENT = "44444444-0000-4000-8000-000000000002";
const MAILBOX_A = "55555555-0000-4000-8000-000000000001";

type Res = { status: number; body: Record<string, unknown> };
type Handler = (req: never, ctx: never) => Promise<Response>;

async function call(handler: unknown, request: NextRequest, params?: Record<string, string>): Promise<Res> {
  const res = await (handler as Handler)(request as never, (params ? { params: Promise.resolve(params) } : undefined) as never);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function assertSentence(value: unknown, label: string) {
  assert.equal(typeof value, "string", `${label}: no sentence`);
  const text = String(value);
  assert.ok(/^[A-Z]/.test(text) && text.split(/\s+/).length >= 6, `${label}: "${text}" is not a sentence`);
}

function assertRefused(r: Res, error: string, label: string) {
  assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, error, `${label}: ${JSON.stringify(r.body)}`);
  assertSentence(r.body.message, label);
}

async function main() {
  console.log("role-gates-and-platform-keys:");
  const db = await setupDatabase();
  const n = async (sql: string, args: Array<string | number | null> = []) => Number((await db.execute({ sql, args })).rows[0].n);
  const value = async (sql: string, args: Array<string | number | null> = []) => (await db.execute({ sql, args })).rows[0]?.v ?? null;

  // ── the tables these routes write, shaped like the live schema ──────────
  await db.executeMultiple(`
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL,
      service TEXT NOT NULL, field_key TEXT NOT NULL, encrypted_value TEXT NOT NULL, last_tested_at TEXT,
      last_test_ok INTEGER, last_test_error TEXT, created_by TEXT, created_at TEXT DEFAULT ${NOW_SQL},
      updated_at TEXT DEFAULT ${NOW_SQL}, UNIQUE (tenant_id, service, field_key));
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL, encrypted_value TEXT NOT NULL,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL},
      UNIQUE (tenant_id, user_id, service, field_key));
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, event_type TEXT, publisher_agent TEXT,
      source_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT, published_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE esign_envelopes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT, title TEXT,
      status TEXT, source_storage_key TEXT, source_document_id TEXT, source_pdf_sha256 TEXT, signed_storage_key TEXT,
      signed_document_id TEXT, signed_pdf_sha256 TEXT, lead_id TEXT, application_id TEXT, unlinked_reason TEXT,
      consent_disclosure_version TEXT, message TEXT, expires_at TEXT, completed_at TEXT, void_reason TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE esign_signers (id TEXT PRIMARY KEY, envelope_id TEXT REFERENCES esign_envelopes (id), tenant_id TEXT, email TEXT, name TEXT,
      sign_order INTEGER, status TEXT, token_sha256 TEXT, expires_at TEXT, viewed_at TEXT, signed_at TEXT,
      signed_ip TEXT, signed_user_agent TEXT, consented INTEGER, decline_reason TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE esign_events (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, envelope_id TEXT, signer_id TEXT,
      tenant_id TEXT, event TEXT, actor TEXT, at TEXT DEFAULT ${NOW_SQL}, ip TEXT, user_agent TEXT, meta TEXT);
    CREATE TABLE cold_lead_lists (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, name TEXT,
      source TEXT, row_count INTEGER DEFAULT 0, promoted_count INTEGER DEFAULT 0, created_by_user_id TEXT,
      archived_at TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE cold_leads (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, list_id TEXT NOT NULL,
      business_name TEXT, contact_name TEXT, phone TEXT, email TEXT, raw TEXT, stage TEXT,
      attempt_count INTEGER DEFAULT 0, promoted_lead_id TEXT, created_at TEXT DEFAULT ${NOW_SQL},
      updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE cold_outreach_campaigns (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, name TEXT,
      channel TEXT, message_body TEXT, subject TEXT, cold_list_id TEXT, recipient_filter TEXT, status TEXT,
      daily_cap INTEGER, scheduled_for TEXT, total_recipients INTEGER, sent_count INTEGER, failed_count INTEGER,
      created_by_user_id TEXT, started_at TEXT, completed_at TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE cold_outreach_recipients (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL,
      campaign_id TEXT, cold_lead_id TEXT, contact_address TEXT, status TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE object_metadata (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT);
    CREATE TABLE field_metadata (id TEXT PRIMARY KEY, object_id TEXT, name TEXT);
    CREATE TABLE views (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, object_metadata_id TEXT,
      slug TEXT, name TEXT, kind TEXT, owner_user_id TEXT, is_default INTEGER DEFAULT 0, kanban_field_name TEXT,
      description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE cold_sending_mailboxes (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL,
      domain TEXT NOT NULL, address TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'app_password',
      app_password_enc TEXT, api_ref TEXT, daily_cap INTEGER NOT NULL DEFAULT 30,
      sends_today INTEGER NOT NULL DEFAULT 0, sends_date TEXT, last_send_at TEXT,
      warmup_status TEXT NOT NULL DEFAULT 'warming', active INTEGER NOT NULL DEFAULT 1, notes TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}, UNIQUE (tenant_id, address));
    CREATE TABLE cc_email_templates (id TEXT PRIMARY KEY DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, name TEXT,
      category TEXT, subject TEXT, preheader TEXT, html TEXT, created_by TEXT, updated_at TEXT DEFAULT ${NOW_SQL});
  `);
  // The drip caps' real migration.
  for (const stmt of splitSql(readFileSync(join(__dirname, "..", "database", "turso", "144_drip_channel_limits.turso.sql"), "utf8"))) {
    await db.execute(stmt);
  }

  // ── the seats ────────────────────────────────────────────────────────────
  const seat = (user: Seat, tenant: string, role: string | null, opts: { owner?: number; adminAccess?: number; updatedAt?: string; profileId?: string } = {}) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, joined_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z', ?)`,
    args: [opts.profileId ?? `p-${user.id}`, user.id, user.email, tenant, role, opts.owner ?? 0, opts.adminAccess ?? 0, user.email, opts.updatedAt ?? "2026-09-01T00:00:00Z"],
  });
  await db.batch(
    [
      ...Object.values(SEATS).map((s) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [s.id, s.email] })),
      seat(SEATS.viewer, CLIENT_A, "read_only"),
      seat(SEATS.odd, CLIENT_A, "intern"),
      seat(SEATS.writer, CLIENT_A, "member"),
      seat(SEATS.admin, CLIENT_A, "admin"),
      seat(SEATS.toggled, CLIENT_A, "read_only", { adminAccess: 1 }),
      seat(SEATS.rolling, CLIENT_A, "member"),
      // Two workspaces: the newer seat (Client B) is the active one.
      seat(SEATS.dual, CLIENT_A, "member", { profileId: `p-${SEATS.dual.id}-a`, updatedAt: "2026-09-01T00:00:00Z" }),
      seat(SEATS.dual, CLIENT_B, "member", { profileId: `p-${SEATS.dual.id}-b`, updatedAt: "2026-10-01T00:00:00Z" }),
    ],
    "write",
  );

  // ── Client A's workspace: a manifest that declares offers and funded deals ─
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const draft = finalizeManifestFromWizard({ template: "custom", slug: SLUG, answers: {} });
  const manifest = parseManifest(
    JSON.parse(
      JSON.stringify({
        ...draft,
        data_model: [
          ...(draft.data_model || []),
          { name: "offer", label: "Offer", fields: [{ name: "stage", type: "string" }, { name: "lead_id", type: "string" }, { name: "amount", type: "number" }] },
          { name: "funded_deal", label: "Funded deal", fields: [{ name: "lead_id", type: "string" }, { name: "amount_funded", type: "number" }] },
        ],
      }),
    ),
  );
  const { encryptField } = await import("../lib/field-encryption");
  await db.batch(
    [
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client-a', ?, ?, ?, 1, 1, '2026-09-01', '2026-09-01')",
        args: [CLIENT_A, SLUG, JSON.stringify(manifest)],
      },
      { sql: "INSERT INTO cold_lead_lists (id, tenant_id, name, source, row_count) VALUES (?, ?, 'Spring list', 'csv_upload', 2)", args: [LIST_1, CLIENT_A] },
      { sql: "INSERT INTO cold_lead_lists (id, tenant_id, name, source, row_count) VALUES (?, ?, 'Old list', 'csv_upload', 0)", args: [LIST_2, CLIENT_A] },
      { sql: "INSERT INTO cold_leads (tenant_id, list_id, business_name, email, stage) VALUES (?, ?, 'Acme', 'a@acme.test', 'imported')", args: [CLIENT_A, LIST_1] },
      { sql: "INSERT INTO cold_leads (tenant_id, list_id, business_name, email, stage) VALUES (?, ?, 'Bolt', 'b@bolt.test', 'imported')", args: [CLIENT_A, LIST_1] },
      { sql: "INSERT INTO object_metadata (id, tenant_id, name) VALUES (?, ?, 'lead')", args: [OBJECT_1, CLIENT_A] },
      {
        sql: "INSERT INTO views (id, tenant_id, object_metadata_id, slug, name, kind, owner_user_id) VALUES (?, ?, ?, 'hot', 'Hot leads', 'table', NULL)",
        args: [VIEW_1, CLIENT_A, OBJECT_1],
      },
      {
        sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'offer', ?)",
        args: [OFFER_1, CLIENT_A, JSON.stringify({ stage: "approved_open_offers", lead_id: "lead-a-1", amount: 50000 })],
      },
      {
        sql: `INSERT INTO esign_envelopes (id, tenant_id, created_by, title, status, source_storage_key, source_pdf_sha256, consent_disclosure_version)
              VALUES (?, ?, ?, 'Retainer', 'draft', 'k/draft.pdf', 'sha-draft', 'v1')`,
        args: [ENVELOPE_DRAFT, CLIENT_A, USERS.clientA.id],
      },
      {
        sql: `INSERT INTO esign_envelopes (id, tenant_id, created_by, title, status, source_storage_key, source_pdf_sha256, consent_disclosure_version)
              VALUES (?, ?, ?, 'Renewal', 'sent', 'k/sent.pdf', 'sha-sent', 'v1')`,
        args: [ENVELOPE_SENT, CLIENT_A, USERS.clientA.id],
      },
      {
        sql: `INSERT INTO esign_signers (id, envelope_id, tenant_id, email, name, sign_order, status, token_sha256, expires_at)
              VALUES ('signer-draft', ?, ?, 'client@customer.test', 'Casey Client', 1, 'pending', 'seed-token-draft', '2026-12-01T00:00:00Z')`,
        args: [ENVELOPE_DRAFT, CLIENT_A],
      },
      {
        sql: `INSERT INTO esign_signers (id, envelope_id, tenant_id, email, name, sign_order, status, token_sha256, expires_at)
              VALUES ('signer-sent', ?, ?, 'client@customer.test', 'Casey Client', 1, 'pending', 'seed-token-sent', '2026-12-01T00:00:00Z')`,
        args: [ENVELOPE_SENT, CLIENT_A],
      },
      {
        sql: `INSERT INTO cold_sending_mailboxes (id, tenant_id, domain, address, app_password_enc, warmup_status, active)
              VALUES (?, ?, 'client-a-mail.test', 'cold@client-a-mail.test', ?, 'ready', 1)`,
        args: [MAILBOX_A, CLIENT_A, encryptField("client-a-app-password")],
      },
    ],
    "write",
  );

  const apiAuth = await import("../lib/api-auth");
  const { CRM_WRITE_ROLES } = await import("../lib/role-gates");
  const esignEnvelopes = await import("../app/api/esign/envelopes/route");
  const esignSend = await import("../app/api/esign/envelopes/[id]/send/route");
  const esignRemind = await import("../app/api/esign/envelopes/[id]/remind/route");
  const dripLimits = await import("../app/api/drips/limits/route");
  const coldLists = await import("../app/api/manifest/[slug]/cold-lists/route");
  const coldList = await import("../app/api/manifest/[slug]/cold-lists/[list_id]/route");
  const coldImport = await import("../app/api/manifest/[slug]/cold-lists/[list_id]/import/route");
  const coldUpload = await import("../app/api/manifest/[slug]/cold-lists/upload/route");
  const campaigns = await import("../app/api/manifest/[slug]/cold-outreach/campaigns/route");
  const offerAccept = await import("../app/api/manifest/[slug]/offer/[id]/accept/route");
  const views = await import("../app/api/manifest/[slug]/views/route");
  const view = await import("../app/api/manifest/[slug]/views/[id]/route");
  const blast = await import("../app/api/cold-sending/blast/route");
  const mailboxes = await import("../app/api/cold-sending/mailboxes/route");
  const connectImap = await import("../app/api/agents/operator-email/connect-imap/route");
  const kixieSync = await import("../app/api/integrations/kixie/sync-webhooks/route");
  const operatorCron = await import("../app/api/cron/operator-email-agent/route");
  const dripTemplates = await import("../app/api/drip-templates/route");

  // ── 1. sessionMayWriteCrm ────────────────────────────────────────────────
  const mayWrite = async (user: Seat | null, tenantId: string) => {
    await login(user);
    return apiAuth.sessionMayWriteCrm(tenantId);
  };
  const setRollingRole = (role: string | null) =>
    db.execute({ sql: "UPDATE user_profiles SET team_role = ? WHERE auth_user_id = ?", args: [role, SEATS.rolling.id] });

  await check("sessionMayWriteCrm: the owner, an admin and an admin by grant may write in their workspace", async () => {
    assert.equal(await mayWrite(USERS.clientA, CLIENT_A), true, "owner");
    assert.equal(await mayWrite(SEATS.admin, CLIENT_A), true, "admin");
    assert.equal(await mayWrite(SEATS.toggled, CLIENT_A), true, "read_only seat with the admin_access grant");
  });
  await check("sessionMayWriteCrm: every CRM writer role may write", async () => {
    for (const role of CRM_WRITE_ROLES) {
      await setRollingRole(role);
      assert.equal(await mayWrite(SEATS.rolling, CLIENT_A), true, role);
    }
  });
  await check("sessionMayWriteCrm: read_only, an unknown role and a missing role may not", async () => {
    assert.equal(await mayWrite(SEATS.viewer, CLIENT_A), false, "read_only");
    assert.equal(await mayWrite(SEATS.odd, CLIENT_A), false, "intern");
    for (const role of ["READ_ONLY", "superuser", "", null]) {
      await setRollingRole(role);
      assert.equal(await mayWrite(SEATS.rolling, CLIENT_A), false, JSON.stringify(role));
    }
    await setRollingRole("member");
  });
  await check("sessionMayWriteCrm: never for a workspace other than the session's active one", async () => {
    assert.equal(await mayWrite(SEATS.writer, CLIENT_B), false, "a Client A writer, asking for Client B");
    assert.equal(await mayWrite(USERS.clientA, OASIS), false, "Client A's owner, asking for OASIS");
    assert.equal(await mayWrite(USERS.cc, CLIENT_A), false, "OASIS's owner, asking for Client A");
    assert.equal(await mayWrite(USERS.clientA, ""), false, "no workspace named");
    // A writer seat in Client A does not count while Client B is the active workspace.
    assert.equal(await mayWrite(SEATS.dual, CLIENT_A), false, "two seats, Client B active: Client A");
    assert.equal(await mayWrite(SEATS.dual, CLIENT_B), true, "two seats, Client B active: Client B");
    assert.equal(await mayWrite(null, CLIENT_A), false, "signed out");
  });

  // ── 2. e-sign ────────────────────────────────────────────────────────────
  const envelopeBody = {
    title: "Service agreement",
    signers: [{ email: "client@customer.test", name: "Casey Client" }],
    pdfBase64: Buffer.from("this is not a pdf").toString("base64"),
    filename: "agreement.pdf",
  };
  const signerToken = (id: string) => value("SELECT token_sha256 AS v FROM esign_signers WHERE id = ?", [id]);

  await check("e-sign create: a read_only seat and an unknown role are refused (403); no envelope is created", async () => {
    const before = await n("SELECT COUNT(*) AS n FROM esign_envelopes");
    for (const who of [SEATS.viewer, SEATS.odd]) {
      await login(who);
      assertRefused(await call(esignEnvelopes.POST, request("/api/esign/envelopes", "POST", envelopeBody)), "forbidden_role", who.email);
    }
    assert.equal(await n("SELECT COUNT(*) AS n FROM esign_envelopes"), before);
  });
  await check("e-sign send: a read_only seat is refused (403); the envelope stays a draft, no token rotates, nothing is logged or mailed", async () => {
    mails.length = 0;
    for (const who of [SEATS.viewer, SEATS.odd]) {
      await login(who);
      const r = await call(esignSend.POST, request(`/api/esign/envelopes/${ENVELOPE_DRAFT}/send`, "POST"), { id: ENVELOPE_DRAFT });
      assertRefused(r, "forbidden_role", who.email);
    }
    assert.equal(await value("SELECT status AS v FROM esign_envelopes WHERE id = ?", [ENVELOPE_DRAFT]), "draft");
    assert.equal(await signerToken("signer-draft"), "seed-token-draft", "the signing link was re-minted");
    assert.equal(await n("SELECT COUNT(*) AS n FROM esign_events WHERE envelope_id = ?", [ENVELOPE_DRAFT]), 0);
    assert.equal(mails.length, 0);
  });
  await check("e-sign remind: a read_only seat is refused (403); no token rotates, nothing is logged or mailed", async () => {
    mails.length = 0;
    for (const who of [SEATS.viewer, SEATS.odd]) {
      await login(who);
      const r = await call(esignRemind.POST, request(`/api/esign/envelopes/${ENVELOPE_SENT}/remind`, "POST"), { id: ENVELOPE_SENT });
      assertRefused(r, "forbidden_role", who.email);
    }
    assert.equal(await signerToken("signer-sent"), "seed-token-sent", "the signing link was re-minted");
    assert.equal(await n("SELECT COUNT(*) AS n FROM esign_events WHERE envelope_id = ?", [ENVELOPE_SENT]), 0);
    assert.equal(mails.length, 0);
  });
  await check("e-sign: a CRM writer (a member, not an admin) gets through to the work", async () => {
    await login(SEATS.writer);
    const created = await call(esignEnvelopes.POST, request("/api/esign/envelopes", "POST", envelopeBody));
    // Past the role gate, the same request stops at PDF validation.
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error, "invalid_pdf");
    const sent = await call(esignSend.POST, request(`/api/esign/envelopes/${ENVELOPE_DRAFT}/send`, "POST"), { id: ENVELOPE_DRAFT });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((sent.body.results as unknown[]).length, 1, "the signer was attempted");
    assert.notEqual(await signerToken("signer-draft"), "seed-token-draft", "a fresh link was minted for the send");
    const reminded = await call(esignRemind.POST, request(`/api/esign/envelopes/${ENVELOPE_SENT}/remind`, "POST"), { id: ENVELOPE_SENT });
    assert.equal(reminded.status, 200, JSON.stringify(reminded.body));
    assert.equal((reminded.body.results as unknown[]).length, 1, "the signer was attempted");
  });
  await check("e-sign: an admin by the admin_access grant gets through, though its role is read_only", async () => {
    // Review of #716: dropping `isAdmin` from these gates locked out an admin
    // by grant, and nothing else noticed.
    await login(SEATS.toggled);
    const created = await call(esignEnvelopes.POST, request("/api/esign/envelopes", "POST", envelopeBody));
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error, "invalid_pdf", "past the role gate, stopped at PDF validation");
    const reminded = await call(esignRemind.POST, request(`/api/esign/envelopes/${ENVELOPE_SENT}/remind`, "POST"), { id: ENVELOPE_SENT });
    assert.equal(reminded.status, 200, JSON.stringify(reminded.body));
  });

  // ── drip email templates (a sibling write the review of #716 found) ───────
  const templatesIn = (tenantId: string) => n("SELECT COUNT(*) AS n FROM cc_email_templates WHERE tenant_id = ?", [tenantId]);
  const templateBody = { name: "Follow-up", subject: "Checking in", preheader: "A short plain body" };
  await check("drip templates: a read_only seat and an unknown role cannot create one (403); nothing is stored", async () => {
    const before = await templatesIn(CLIENT_A);
    for (const who of [SEATS.viewer, SEATS.odd]) {
      await login(who);
      assertRefused(await call(dripTemplates.POST, request("/api/drip-templates", "POST", templateBody)), "forbidden_role", who.email);
    }
    assert.equal(await templatesIn(CLIENT_A), before);
  });
  await check("drip templates: a CRM writer and an admin by grant still create one; a read_only seat still lists them", async () => {
    const before = await templatesIn(CLIENT_A);
    for (const who of [SEATS.writer, SEATS.toggled]) {
      await login(who);
      const r = await call(dripTemplates.POST, request("/api/drip-templates", "POST", templateBody));
      assert.equal(r.status, 200, `${who.email}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(await templatesIn(CLIENT_A), before + 2);
    await login(SEATS.viewer);
    assert.equal((await call(dripTemplates.GET, request("/api/drip-templates", "GET"))).status, 200);
  });

  // ── drip sending caps ────────────────────────────────────────────────────
  const capsRow = () => n("SELECT COUNT(*) AS n FROM drip_channel_limits WHERE tenant_id = ?", [CLIENT_A]);
  await check("drip caps: a read_only seat and a member who is not an admin cannot change them; nothing is stored", async () => {
    for (const who of [SEATS.viewer, SEATS.writer]) {
      await login(who);
      const r = await call(dripLimits.PATCH, request("/api/drips/limits", "PATCH", { smsDaily: 500 }));
      assert.equal(r.status, 403, `${who.email}: ${JSON.stringify(r.body)}`);
      // The form shows `error` as written, followed by ". Nothing was changed."
      assertSentence(r.body.error, who.email);
    }
    assert.equal(await capsRow(), 0);
  });
  await check("drip caps: the owner and an admin still change them", async () => {
    await login(USERS.clientA);
    const owner = await call(dripLimits.PATCH, request("/api/drips/limits", "PATCH", { smsDaily: 450 }));
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.equal((owner.body.limits as Record<string, number>).smsDaily, 450);
    await login(SEATS.admin);
    const admin = await call(dripLimits.PATCH, request("/api/drips/limits", "PATCH", { smsHourly: 20 }));
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(await value("SELECT sms_daily AS v FROM drip_channel_limits WHERE tenant_id = ?", [CLIENT_A]), 450);
    assert.equal(await value("SELECT sms_hourly AS v FROM drip_channel_limits WHERE tenant_id = ?", [CLIENT_A]), 20);
  });
  await check("drip caps: an admin by the admin_access grant changes them too", async () => {
    await login(SEATS.toggled);
    const r = await call(dripLimits.PATCH, request("/api/drips/limits", "PATCH", { smsHourly: 25 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await value("SELECT sms_hourly AS v FROM drip_channel_limits WHERE tenant_id = ?", [CLIENT_A]), 25);
  });

  // ── manifest writes, one check per route ─────────────────────────────────
  type Attempt = { label: string; run: () => Promise<Res>; state: () => Promise<unknown> };
  const manifestWrites: Attempt[] = [
    {
      label: "cold-lists POST (create a list)",
      run: () => call(coldLists.POST, request(`/api/manifest/${SLUG}/cold-lists`, "POST", { name: "Read-only list" }), { slug: SLUG }),
      state: () => n("SELECT COUNT(*) AS n FROM cold_lead_lists WHERE tenant_id = ?", [CLIENT_A]),
    },
    {
      label: "cold-lists/[list_id] DELETE (archive a list)",
      run: () => call(coldList.DELETE, request(`/api/manifest/${SLUG}/cold-lists/${LIST_1}`, "DELETE"), { slug: SLUG, list_id: LIST_1 }),
      state: () => value("SELECT archived_at AS v FROM cold_lead_lists WHERE id = ?", [LIST_1]),
    },
    {
      label: "cold-lists/[list_id]/import POST",
      run: () =>
        call(coldImport.POST, request(`/api/manifest/${SLUG}/cold-lists/${LIST_1}/import`, "POST", { rows: [{ email: "new@lead.test" }] }), {
          slug: SLUG,
          list_id: LIST_1,
        }),
      state: () => n("SELECT COUNT(*) AS n FROM cold_leads WHERE tenant_id = ?", [CLIENT_A]),
    },
    {
      label: "cold-lists/upload POST",
      run: () =>
        call(coldUpload.POST, request(`/api/manifest/${SLUG}/cold-lists/upload`, "POST", { name: "Pasted", csv: "email\nup@lead.test" }), { slug: SLUG }),
      state: async () => [await n("SELECT COUNT(*) AS n FROM cold_lead_lists WHERE tenant_id = ?", [CLIENT_A]), await n("SELECT COUNT(*) AS n FROM cold_leads WHERE tenant_id = ?", [CLIENT_A])],
    },
    {
      label: "cold-outreach/campaigns POST (queue a campaign)",
      run: () =>
        call(
          campaigns.POST,
          request(`/api/manifest/${SLUG}/cold-outreach/campaigns`, "POST", { cold_list_id: LIST_1, channel: "email", subject: "Hi", message_body: "Hello there" }),
          { slug: SLUG },
        ),
      state: async () => [await n("SELECT COUNT(*) AS n FROM cold_outreach_campaigns"), await n("SELECT COUNT(*) AS n FROM cold_outreach_recipients")],
    },
    {
      label: "offer/[id]/accept POST (fund a deal)",
      run: () => call(offerAccept.POST, request(`/api/manifest/${SLUG}/offer/${OFFER_1}/accept`, "POST"), { slug: SLUG, id: OFFER_1 }),
      state: async () => [
        await value("SELECT json_extract(data, '$.stage') AS v FROM tenant_records WHERE id = ?", [OFFER_1]),
        await n("SELECT COUNT(*) AS n FROM tenant_records WHERE entity_type = 'funded_deal'"),
      ],
    },
    {
      label: "views POST (create a shared view)",
      run: () =>
        call(views.POST, request(`/api/manifest/${SLUG}/views`, "POST", { object_metadata_id: OBJECT_1, name: "Mine", slug: "mine", shared: true }), { slug: SLUG }),
      state: () => n("SELECT COUNT(*) AS n FROM views WHERE tenant_id = ?", [CLIENT_A]),
    },
    {
      label: "views/[id] DELETE (delete the shared view)",
      run: () => call(view.DELETE, request(`/api/manifest/${SLUG}/views/${VIEW_1}`, "DELETE"), { slug: SLUG, id: VIEW_1 }),
      state: () => value("SELECT is_active AS v FROM views WHERE id = ?", [VIEW_1]),
    },
  ];
  for (const write of manifestWrites) {
    await check(`manifest ${write.label}: a read_only seat and an unknown role are refused (403) with a sentence; nothing changes`, async () => {
      const before = await write.state();
      for (const who of [SEATS.viewer, SEATS.odd]) {
        await login(who);
        assertRefused(await write.run(), "forbidden_role", `${who.email}, ${write.label}`);
      }
      assert.deepEqual(await write.state(), before, "the write happened");
    });
  }
  await check("manifest writes: each one calls sessionMayWriteCrm after its workspace check and before its first write", () => {
    const routes: Array<{ file: string; method: string; scope: string; write: string }> = [
      { file: "app/api/manifest/[slug]/cold-lists/route.ts", method: "POST", scope: "resolveContext(user.id, slug)", write: ".insert(" },
      { file: "app/api/manifest/[slug]/cold-lists/[list_id]/route.ts", method: "DELETE", scope: "resolveDataTenant(slug, userTenantId)", write: ".update(" },
      { file: "app/api/manifest/[slug]/cold-lists/[list_id]/import/route.ts", method: "POST", scope: "resolveContext(user.id, slug)", write: "insertChunkSalvagingDuplicates(" },
      { file: "app/api/manifest/[slug]/cold-lists/upload/route.ts", method: "POST", scope: "resolveContext(user.id, slug)", write: ".insert(" },
      { file: "app/api/manifest/[slug]/cold-outreach/campaigns/route.ts", method: "POST", scope: "resolveContext(user.id, slug)", write: ".insert(" },
      { file: "app/api/manifest/[slug]/offer/[id]/accept/route.ts", method: "POST", scope: "resolveDataTenant(slug, userTenantId)", write: "updateRecord(" },
      { file: "app/api/manifest/[slug]/views/route.ts", method: "POST", scope: "resolveContext(user.id, slug)", write: ".insert(" },
      { file: "app/api/manifest/[slug]/views/[id]/route.ts", method: "DELETE", scope: "resolveContext(user.id, slug)", write: ".update(" },
    ];
    for (const r of routes) {
      const src = readFileSync(join(__dirname, "..", r.file), "utf8");
      const start = src.indexOf(`export async function ${r.method}(`);
      assert.ok(start >= 0, `${r.file}: no ${r.method}`);
      const next = src.indexOf("export async function ", start + 1);
      const body = src
        .slice(start, next === -1 ? undefined : next)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const scope = body.indexOf(r.scope);
      const gate = body.search(/if \(!\(await sessionMayWriteCrm\((?:context\.tenantId|dataTenantId)\)\)\) \{\s*return NextResponse\.json\(/);
      const write = body.indexOf(r.write);
      assert.ok(scope >= 0, `${r.file} ${r.method}: workspace check not found`);
      assert.ok(gate > scope, `${r.file} ${r.method}: sessionMayWriteCrm must follow the workspace check`);
      assert.ok(write > gate, `${r.file} ${r.method}: sessionMayWriteCrm must come before the first write`);
      assert.match(body.slice(gate, gate + 400), /status: 403/, `${r.file} ${r.method}: the refusal is a 403`);
    }
  });
  await check("manifest writes: a CRM writer (a member, not an admin) still does all eight", async () => {
    await login(SEATS.writer);
    const created = await call(coldLists.POST, request(`/api/manifest/${SLUG}/cold-lists`, "POST", { name: "Writer list" }), { slug: SLUG });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const imported = await call(coldImport.POST, request(`/api/manifest/${SLUG}/cold-lists/${LIST_1}/import`, "POST", { rows: [{ email: "c@corp.test" }] }), {
      slug: SLUG,
      list_id: LIST_1,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.inserted, 1);
    const uploaded = await call(coldUpload.POST, request(`/api/manifest/${SLUG}/cold-lists/upload`, "POST", { name: "Pasted", csv: "email\nd@corp.test" }), { slug: SLUG });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const campaign = await call(
      campaigns.POST,
      request(`/api/manifest/${SLUG}/cold-outreach/campaigns`, "POST", { cold_list_id: LIST_1, channel: "email", subject: "Hi", message_body: "Hello there" }),
      { slug: SLUG },
    );
    assert.equal(campaign.status, 200, JSON.stringify(campaign.body));
    assert.equal(campaign.body.total_recipients, 3);
    const archived = await call(coldList.DELETE, request(`/api/manifest/${SLUG}/cold-lists/${LIST_2}`, "DELETE"), { slug: SLUG, list_id: LIST_2 });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const saved = await call(views.POST, request(`/api/manifest/${SLUG}/views`, "POST", { object_metadata_id: OBJECT_1, name: "Mine", slug: "mine", shared: true }), {
      slug: SLUG,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const deleted = await call(view.DELETE, request(`/api/manifest/${SLUG}/views/${VIEW_1}`, "DELETE"), { slug: SLUG, id: VIEW_1 });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const accepted = await call(offerAccept.POST, request(`/api/manifest/${SLUG}/offer/${OFFER_1}/accept`, "POST"), { slug: SLUG, id: OFFER_1 });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(await value("SELECT json_extract(data, '$.stage') AS v FROM tenant_records WHERE id = ?", [OFFER_1]), "funded");
    assert.equal(await n("SELECT COUNT(*) AS n FROM tenant_records WHERE entity_type = 'funded_deal' AND tenant_id = ?", [CLIENT_A]), 1);
  });
  await check("reads are untouched: a read_only seat still lists envelopes, cold lists and views, and reads the drip caps", async () => {
    await login(SEATS.viewer);
    assert.equal((await call(esignEnvelopes.GET, request("/api/esign/envelopes", "GET"))).status, 200);
    assert.equal((await call(coldLists.GET, request(`/api/manifest/${SLUG}/cold-lists`, "GET"), { slug: SLUG })).status, 200);
    assert.equal((await call(views.GET, request(`/api/manifest/${SLUG}/views?object_metadata_id=${OBJECT_1}`, "GET"), { slug: SLUG })).status, 200);
    const caps = await call(dripLimits.GET, request("/api/drips/limits", "GET"));
    assert.equal(caps.status, 200);
    assert.equal((caps.body.limits as Record<string, number>).smsDaily, 450);
  });

  // ── 2. the scan key ──────────────────────────────────────────────────────
  const scanKey = { authorization: `Bearer ${SCAN_KEY}` };
  const blastBody = (tenantId: string) => ({ tenantId, subject: "Quick question", body: "Do you have a minute this week?", recipients: ["owner@prospect.test"] });

  await check("scan key, cold-sending/blast: refused (403) for a client workspace; nothing is sent from its pool", async () => {
    await login(null);
    mails.length = 0;
    for (const tenantId of [CLIENT_A, CLIENT_B]) {
      const r = await call(blast.POST, request("/api/cold-sending/blast", "POST", blastBody(tenantId), scanKey));
      assertRefused(r, "key_not_allowed_for_workspace", tenantId);
    }
    assert.equal(mails.length, 0, "a cold email went out");
    assert.equal(await value("SELECT sends_today AS v FROM cold_sending_mailboxes WHERE id = ?", [MAILBOX_A]), 0);
  });
  await check("scan key, cold-sending/blast: accepted for OASIS's own workspace; a signed-in admin is unchanged", async () => {
    await login(null);
    const oasis = await call(blast.POST, request("/api/cold-sending/blast", "POST", blastBody(OASIS), scanKey));
    // Past the key check, OASIS's (empty) cold pool is what answers.
    assert.equal(oasis.status, 409, JSON.stringify(oasis.body));
    assert.equal(oasis.body.error, "no_cold_infra");
    await login(USERS.clientA);
    const signedIn = await call(blast.POST, request("/api/cold-sending/blast", "POST", { ...blastBody(CLIENT_B), tenantId: undefined }));
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.requested, 1);
  });
  await check("scan key, cold-sending/mailboxes: POST, PATCH and DELETE refused (403) for a client workspace; its pool is untouched", async () => {
    await login(null);
    const register = await call(
      mailboxes.POST,
      request("/api/cold-sending/mailboxes", "POST", { tenantId: CLIENT_A, domain: "evil.test", address: "x@evil.test", app_password: "abcd efgh ijkl mnop" }, scanKey),
    );
    assertRefused(register, "key_not_allowed_for_workspace", "POST");
    const pause = await call(mailboxes.PATCH, request("/api/cold-sending/mailboxes", "PATCH", { tenantId: CLIENT_A, id: MAILBOX_A, warmup_status: "paused", daily_cap: 0 }, scanKey));
    assertRefused(pause, "key_not_allowed_for_workspace", "PATCH");
    const off = await call(mailboxes.DELETE, request("/api/cold-sending/mailboxes", "DELETE", { tenantId: CLIENT_A, id: MAILBOX_A }, scanKey));
    assertRefused(off, "key_not_allowed_for_workspace", "DELETE");
    assert.equal(await n("SELECT COUNT(*) AS n FROM cold_sending_mailboxes WHERE tenant_id = ?", [CLIENT_A]), 1);
    const row = (await db.execute({ sql: "SELECT warmup_status, active, daily_cap FROM cold_sending_mailboxes WHERE id = ?", args: [MAILBOX_A] })).rows[0];
    assert.deepEqual([row.warmup_status, Number(row.active), Number(row.daily_cap)], ["ready", 1, 30]);
  });
  await check("scan key, cold-sending/mailboxes: accepted for OASIS's own workspace", async () => {
    await login(null);
    const r = await call(
      mailboxes.POST,
      request("/api/cold-sending/mailboxes", "POST", { tenantId: OASIS, domain: "oasis-cold.test", address: "hi@oasis-cold.test", app_password: "abcd efgh ijkl mnop" }, scanKey),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await n("SELECT COUNT(*) AS n FROM cold_sending_mailboxes WHERE tenant_id = ?", [OASIS]), 1);
  });
  const imapBody = (tenantId: string | undefined, userId: string | undefined) => ({ tenantId, userId, address: "inbox@gmail.test", app_password: "abcd efgh ijkl mnop" });
  const loginsStoredFor = (tenantId: string, userId: string) =>
    n("SELECT COUNT(*) AS n FROM user_integration_credentials WHERE tenant_id = ? AND user_id = ?", [tenantId, userId]);
  await check("scan key, operator-email/connect-imap: refused (403) for a client workspace; no login stored, no IMAP connection made", async () => {
    await login(null);
    imapLogins.length = 0;
    const r = await call(connectImap.POST, request("/api/agents/operator-email/connect-imap", "POST", imapBody(CLIENT_A, USERS.clientA.id), scanKey));
    assertRefused(r, "key_not_allowed_for_workspace", "connect-imap");
    assert.equal(await n("SELECT COUNT(*) AS n FROM user_integration_credentials WHERE tenant_id = ?", [CLIENT_A]), 0);
    assert.equal(imapLogins.length, 0, "the mailbox was logged into");
  });
  await check("scan key, operator-email/connect-imap: accepted for OASIS's own workspace; the signed-in path is unchanged", async () => {
    await login(null);
    const oasis = await call(connectImap.POST, request("/api/agents/operator-email/connect-imap", "POST", imapBody(OASIS, USERS.cc.id), scanKey));
    assert.equal(oasis.status, 200, JSON.stringify(oasis.body));
    assert.equal(await loginsStoredFor(OASIS, USERS.cc.id), 2);
    await login(USERS.clientA);
    const own = await call(connectImap.POST, request("/api/agents/operator-email/connect-imap", "POST", imapBody(undefined, undefined)));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(await loginsStoredFor(CLIENT_A, USERS.clientA.id), 2);
  });
  await check("scan key, operator-email/connect-imap: refused (403) in OASIS for a person who is not an active member there; nothing stored", async () => {
    // Review of #716: the key named any user id, so a login was stored under
    // OASIS for Client A's owner.
    await login(null);
    imapLogins.length = 0;
    const r = await call(connectImap.POST, request("/api/agents/operator-email/connect-imap", "POST", imapBody(OASIS, USERS.clientA.id), scanKey));
    assertRefused(r, "user_not_in_workspace", "Client A's owner in OASIS");
    assert.equal(await loginsStoredFor(OASIS, USERS.clientA.id), 0);
    assert.deepEqual(imapLogins, [], "no IMAP connection was made");
  });

  // ── 3. Kixie business ids ────────────────────────────────────────────────
  const setKixieKey = async (businessId: string) => {
    await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'kixie'", args: [CLIENT_A] });
    for (const [field, plain] of [["api_key", "client-a-kixie-key"], ["business_id", businessId]]) {
      await db.execute({
        sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'kixie', ?, ?)",
        args: [CLIENT_A, field, encryptField(plain)],
      });
    }
  };
  const stampOf = async (tenantId: string) => value("SELECT json_extract(custom_fields, '$.kixie_business_id') AS v FROM tenants WHERE id = ?", [tenantId]);
  await db.execute({ sql: "UPDATE tenants SET custom_fields = ? WHERE id = ?", args: [JSON.stringify({ kixie_business_id: "7001" }), CLIENT_B] });

  await check("Kixie: a business id another workspace holds is refused (409) with a sentence; nothing is stamped and Kixie is never called", async () => {
    await setKixieKey("7001");
    await db.execute({ sql: "UPDATE tenants SET custom_fields = '{}' WHERE id = ?", args: [CLIENT_A] });
    kixieCalls.length = 0;
    kixieAnswer = "accept";
    await login(USERS.clientA);
    const r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "business_id_in_use");
    assertSentence(r.body.message, "409");
    assert.equal(await stampOf(CLIENT_A), null, "the squatter was stamped");
    assert.equal(await stampOf(CLIENT_B), "7001", "the holder lost its id");
    assert.equal(kixieCalls.length, 0, "Kixie was called");
  });
  await check("Kixie: an unheld id is NOT stamped while Kixie rejects every registration", async () => {
    await setKixieKey("7002");
    await db.execute({ sql: "UPDATE tenants SET custom_fields = '{}' WHERE id = ?", args: [CLIENT_A] });
    kixieCalls.length = 0;
    kixieAnswer = "reject";
    await login(USERS.clientA);
    const r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.registered, 0);
    assert.equal(r.body.business_id_linked, false);
    assert.ok(kixieCalls.length > 0, "Kixie was asked");
    assert.equal(await stampOf(CLIENT_A), null, "stamped before Kixie accepted anything");
  });
  await check("Kixie: stamped once Kixie accepts the registrations, and the receiver's lookup finds only this workspace", async () => {
    await setKixieKey("7002");
    await db.execute({ sql: "UPDATE tenants SET custom_fields = '{}' WHERE id = ?", args: [CLIENT_A] });
    kixieCalls.length = 0;
    kixieAnswer = "accept";
    await login(USERS.clientA);
    const r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.business_id_linked, true);
    assert.ok(kixieCalls.length > 0 && kixieCalls.every((c) => c.businessid === "7002"), "every registration was for this id");
    assert.equal(await stampOf(CLIENT_A), "7002");
    const holders = await db.execute({ sql: "SELECT id FROM tenants WHERE json_extract(custom_fields, '$.kixie_business_id') = ?", args: ["7002"] });
    assert.deepEqual(holders.rows.map((row) => row.id), [CLIENT_A]);
  });
  // Review of #716: the next five were promises of the route that no check held.
  const setCustomFields = (tenantId: string, cf: string) => db.execute({ sql: "UPDATE tenants SET custom_fields = ? WHERE id = ?", args: [cf, tenantId] });
  const holdersOf = async (businessId: string) =>
    (await db.execute({ sql: "SELECT id FROM tenants WHERE json_extract(custom_fields, '$.kixie_business_id') = ?", args: [businessId] })).rows.map((row) => row.id);
  await check("Kixie: the workspace that already holds its id re-syncs and stays linked; its own id is never 'held by another'", async () => {
    // The settings card tells people to run this again whenever the URL changes.
    await setKixieKey("7002");
    kixieCalls.length = 0;
    kixieAnswer = "accept";
    await login(USERS.clientA);
    const r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.business_id_linked, true);
    assert.deepEqual(await holdersOf("7002"), [CLIENT_A]);
  });
  await check("Kixie: a 200 that neither confirms nor refuses does not link the workspace", async () => {
    await setKixieKey("7005");
    await setCustomFields(CLIENT_A, "{}");
    kixieCalls.length = 0;
    kixieAnswer = "ambiguous";
    await login(USERS.clientA);
    const r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    kixieAnswer = "accept";
    assert.equal(r.body.business_id_linked, false, JSON.stringify(r.body));
    assert.equal(await stampOf(CLIENT_A), null, "linked on an answer that proves nothing");
  });
  await check("Kixie: a holder lookup that fails answers 503; Kixie is never called and nothing is stamped", async () => {
    await setKixieKey("7003");
    await setCustomFields(CLIENT_A, "{}");
    const clientB = String(await value("SELECT custom_fields AS v FROM tenants WHERE id = ?", [CLIENT_B]));
    await setCustomFields(CLIENT_B, "not json"); // json_extract fails on this row, as on any malformed one
    kixieCalls.length = 0;
    await login(USERS.clientA);
    let r: Res;
    try {
      r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    } finally {
      await setCustomFields(CLIENT_B, clientB);
    }
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "business_id_check_failed");
    assertSentence(r.body.message, "a failed holder lookup");
    assert.equal(kixieCalls.length, 0, "Kixie was called");
    assert.equal(await stampOf(CLIENT_A), null, "stamped after a failed lookup");
  });
  await check("Kixie: another workspace takes the id while the registrations run; this one answers 409 and is not stamped", async () => {
    await setKixieKey("7004");
    await setCustomFields(CLIENT_A, "{}");
    kixieCalls.length = 0;
    kixieAnswer = "accept";
    beforeNextKixieCall = () => setCustomFields(CLIENT_B, JSON.stringify({ kixie_business_id: "7004" })).then(() => undefined);
    await login(USERS.clientA);
    const r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "business_id_in_use");
    assert.deepEqual(await holdersOf("7004"), [CLIENT_B], "two workspaces hold one id");
  });
  await check("Kixie: OASIS never borrows the Worker's env Kixie account (the retired client's); with no key of its own it is told to add one", async () => {
    process.env.KIXIE_API_KEY = "env-kixie-key";
    process.env.KIXIE_BUSINESS_ID = "9009";
    kixieCalls.length = 0;
    await login(USERS.cc);
    let r: Res;
    try {
      r = await call(kixieSync.POST, request("/api/integrations/kixie/sync-webhooks", "POST"));
    } finally {
      delete process.env.KIXIE_API_KEY;
      delete process.env.KIXIE_BUSINESS_ID;
    }
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "missing_credentials");
    assert.equal(kixieCalls.length, 0, "the env account was used");
    assert.deepEqual(await holdersOf("9009"), []);
  });

  // ── 4. the operator-email cron ───────────────────────────────────────────
  const cronRequest = (method: string, headers: Record<string, string>) =>
    new NextRequest("http://localhost/api/cron/operator-email-agent?write=1", { method, headers });
  await check("operator-email cron: the scan key is refused (401), with or without the platform header", async () => {
    for (const method of ["GET", "POST"] as const) {
      for (const headers of [{ authorization: `Bearer ${SCAN_KEY}` }, { authorization: `Bearer ${SCAN_KEY}`, "x-vercel-cron": "1" }]) {
        const r = await call(operatorCron[method], cronRequest(method, headers));
        assert.equal(r.status, 401, `${method} ${JSON.stringify(headers)}: ${JSON.stringify(r.body)}`);
      }
    }
  });
  await check("operator-email cron: the cron secret without the platform proof is refused (401)", async () => {
    const r = await call(operatorCron.GET, cronRequest("GET", { authorization: `Bearer ${CRON_KEY}` }));
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });
  await check("operator-email cron: the cron credential is accepted, GET and POST", async () => {
    for (const method of ["GET", "POST"] as const) {
      const r = await call(operatorCron[method], cronRequest(method, { authorization: `Bearer ${CRON_KEY}`, "x-vercel-cron": "1" }));
      assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, true);
    }
  });

  await check("no request left the machine", () => {
    assert.deepEqual(strayFetches, []);
  });

  finish("role-gates-and-platform-keys");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
