/**
 * tests/tenant-sender.test.ts - a client workspace registers the identity its
 * email goes out under, and it counts only once its sending address is proven
 * (email-sender-identity, 2026-10-02).
 *
 * What must hold, each pinned below:
 *   - the owner's input is validated: the postal address is REQUIRED (decision
 *     D11), a city alone is not one, the From name cannot inject a header or
 *     carry an address, and no workspace may claim OASIS's or the retired
 *     client's domain;
 *   - "verified" is real: the address is this workspace's Google Workspace
 *     mailbox whose last Test passed (and nothing changed since), or an ACTIVE
 *     member's own Google account with permission to send, read from THIS
 *     tenant's rows only. Untested, failed, another workspace's mailbox, a
 *     deactivated member, an unreadable row: never verified;
 *   - brandForTenant returns the workspace's own brand only when verified, and
 *     OASIS's and SunBiz's brands exactly as before (a stored row can never
 *     override them);
 *   - the footer names the workspace's legal name, postal address, an address
 *     that reaches it, and the reader's opt-out link, and nothing of OASIS's;
 *   - POST /api/settings/sender writes for the session's workspace only (a
 *     tenant in the body is ignored), refuses members below owner/admin and
 *     OASIS's fixed workspaces, and writes its audit row in the same batch;
 *   - before bravo__202 is applied: "not set up yet", and a save changes nothing;
 *   - Settings > Brand shows the form and the live status for a client, and the
 *     read-only identity for OASIS.
 *
 * Real store, real encryption, real migration file, on a local libSQL file.
 * Only the Settings viewer (the session) and two heavy page children are
 * stubbed.
 *
 * Run: node --conditions=react-server --import tsx tests/tenant-sender.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import * as ReactNS from "react";

const dbFile = join(mkdtempSync(join(tmpdir(), "tenant-sender-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "tenant-sender-test-field-encryption-passphrase";

const ROOT = join(__dirname, "..");
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

function stub(path: string, exports: Record<string, unknown>) {
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

// -- Workspaces and people ---------------------------------------------------

const A = "a1000000-0000-4000-8000-0000000000a1"; // its Google Workspace mailbox hello@alpha.test, tested
const B = "b2000000-0000-4000-8000-0000000000b2"; // no workspace mailbox; the owner's own Google account
const C = "c3000000-0000-4000-8000-0000000000c3"; // mailbox saved, never tested
const D = "d4000000-0000-4000-8000-0000000000d4"; // mailbox whose last test failed
const E = "e5000000-0000-4000-8000-0000000000e5"; // nothing connected
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

type Viewer = {
  ok: true;
  persona: string;
  userId: string;
  tenantId: string;
  tenantSlug: string | null;
  access: { canManage: boolean; isOperator: boolean; canSeeTeamPerformance: boolean; oasisWorkspace: boolean };
  viewerAccess: Record<string, unknown>;
};
let viewer: Viewer | { ok: false } = { ok: false };
function signIn(tenantId: string, slug: string, canManage: boolean, userId = `user-${tenantId.slice(0, 2)}`) {
  viewer = {
    ok: true,
    persona: canManage ? "founder" : "rep",
    userId,
    tenantId,
    tenantSlug: slug,
    access: { canManage, isOperator: false, canSeeTeamPerformance: canManage, oasisWorkspace: tenantId === OASIS },
    viewerAccess: { persona: "founder", canSeePersonalSettings: true, canSeeTeamPerformance: true, canSeeSystemSurfaces: true, degraded: false },
  };
}
stub(join(ROOT, "components", "settings", "settings-viewer.ts"), {
  loadSettingsViewer: async () => viewer,
  // The real one 404s anyone the section's gate refuses (Brand: owners and admins).
  requireSettingsSection: async () => {
    if (!viewer.ok || !viewer.access.canManage) throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    return viewer;
  },
  isVerifiedOperator: async () => false,
});
// The page's heavy siblings: the logo card, and the client form (whose props are the contract).
stub(join(ROOT, "components", "settings", "SettingsContent.tsx"), { SettingsContent: () => null });
const formProps: Array<Record<string, unknown>> = [];
stub(join(ROOT, "components", "settings", "TenantSenderForm.tsx"), {
  TenantSenderForm: (props: Record<string, unknown>) => {
    formProps.push(props);
    return null;
  },
});

// -- Harness -----------------------------------------------------------------

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

type El = { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
/** Render a server page's tree: call every function component and collect its text. */
async function render(node: unknown, out: string[] = []): Promise<string[]> {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) await render(n, out);
    return out;
  }
  const el = node as El;
  if (!el.$$typeof || !el.props) return out;
  if (typeof el.type === "function") return render(await (el.type as (p: unknown) => unknown)(el.props), out);
  for (const v of Object.values(el.props)) if (typeof v === "string" && v !== el.props.className) out.push(v);
  return render(el.props.children, out);
}

const UNSUB = "https://oasisai.work/unsubscribe?email=reader%40example.test&brand=x";

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
    CREATE TABLE tenant_integration_credentials (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (id));
    CREATE UNIQUE INDEX tic_key ON tenant_integration_credentials (tenant_id, service, field_key);
    CREATE TABLE user_integration_credentials (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (id));
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, tenant_id TEXT, auth_user_id TEXT, email TEXT NOT NULL,
      full_name TEXT NOT NULL DEFAULT '', display_name TEXT, team_role TEXT NOT NULL DEFAULT 'member',
      is_owner INTEGER NOT NULL DEFAULT 0, admin_access INTEGER NOT NULL DEFAULT 0, invited_by TEXT,
      joined_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z', manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenant_audit_log (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, actor_user_id TEXT, actor_email TEXT, action_type TEXT NOT NULL,
      target_table TEXT, target_id TEXT, before TEXT, after TEXT, ip_hash TEXT, user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (id));
  `);

  const { encryptField } = await import("../lib/field-encryption");
  const sender = await import("../lib/email/tenant-sender");
  const { brandForTenant, mailboxBrandConflict, isReservedSendingDomain } = await import("../lib/email/brand-for-tenant");
  const { ALL_BRAND_KEYS, getBrand } = await import("../lib/email/brands");
  const { appendSignatureAndFooter, tenantSenderFooter } = await import("../lib/config/email-signature");
  const route = await import("../app/api/settings/sender/route");
  const { default: SettingsBrandPage } = await import("../app/settings/brand/page");

  const count = async (sql: string, args: unknown[] = []) =>
    Number((await db.execute({ sql, args: args as never })).rows[0]?.[0] ?? 0);
  const post = async (body: unknown) => {
    const res = await route.POST(new Request("https://oasisai.work/api/settings/sender", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // Stored keys exactly as the Connections drawer and its Test write them.
  const T = "2026-10-02T12:00:00.000Z";
  async function workspaceMailbox(tenantId: string, address: string, test: { at: string | null; ok: 0 | 1 | null }) {
    for (const [field, value] of [["from_address", address], ["app_password", "abcdabcdabcdabcd"]] as const) {
      await db.execute({
        sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value, last_tested_at, last_test_ok)
              VALUES (?, 'gws', ?, ?, ?, ?)
              ON CONFLICT (tenant_id, service, field_key) DO UPDATE SET encrypted_value = excluded.encrypted_value,
                last_tested_at = excluded.last_tested_at, last_test_ok = excluded.last_test_ok`,
        args: [tenantId, field, encryptField(value), test.at, test.ok],
      });
    }
  }
  // A member's own Google account, as /api/auth/google-oauth/callback stores it.
  async function memberGoogle(tenantId: string, userId: string, address: string, scope: string) {
    for (const [field, value] of [["gmail_address", address], ["refresh_token", `rt-${userId}`], ["scope", scope], ["access_token", "at"]] as const) {
      await db.execute({
        sql: "INSERT INTO user_integration_credentials (tenant_id, user_id, service, field_key, encrypted_value) VALUES (?, ?, 'gmail_oauth', ?, ?)",
        args: [tenantId, userId, field, encryptField(value)],
      });
    }
  }
  const SEND_SCOPE = "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events";
  const READ_SCOPE = "openid email https://www.googleapis.com/auth/gmail.readonly";

  const good = {
    display_name: "Alpha Plumbing",
    legal_name: "Alpha Plumbing Inc.",
    postal_address: "  12 King St W,\n  Suite 300\nToronto, ON M5H 1A1  ",
    from_address: " Hello@Alpha.test ",
    reply_to: "",
  };

  // -- 1. What the owner may enter -----------------------------------------
  await check("valid input is normalised: one-line address, lower-case addresses, no reply-to", () => {
    const v = sender.validateSenderInput({ ...good, tenant_id: E, verified_via: "gws", sending_domain: "evil.test" });
    assert.ok(v.ok, JSON.stringify(v));
    assert.deepEqual(v.value, {
      displayName: "Alpha Plumbing",
      legalName: "Alpha Plumbing Inc.",
      postalAddress: "12 King St W, Suite 300, Toronto, ON M5H 1A1",
      fromAddress: "hello@alpha.test",
      replyTo: null,
    });
  });
  await check("the postal address is required (D11), and says why", () => {
    const v = sender.validateSenderInput({ ...good, postal_address: "   \n " });
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.field, "postal_address");
    assert.match(!v.ok ? v.message : "", /CASL/);
  });
  await check("a city on its own is not a mailing address", () => {
    const v = sender.validateSenderInput({ ...good, postal_address: "Montreal, QC, Canada" });
    assert.equal(!v.ok && v.field, "postal_address");
  });
  await check("the From name cannot inject a header or pose as another address", () => {
    for (const bad of ['Alpha "Support"', "Alpha <ceo@bank.test>", "help@bank.test", "Alpha\u0000"]) {
      const v = sender.validateSenderInput({ ...good, display_name: bad });
      assert.equal(!v.ok && v.field, "display_name", bad);
    }
    const folded = sender.validateSenderInput({ ...good, display_name: "Alpha\r\nPlumbing" });
    assert.ok(folded.ok && folded.value.displayName === "Alpha Plumbing", "a line break folds to a space and cannot start a header");
  });
  await check("no workspace may send from or route replies to OASIS's or the retired client's domains", () => {
    for (const domain of ALL_BRAND_KEYS.map((k) => getBrand(k).sendingDomain)) {
      assert.equal(isReservedSendingDomain(domain), true, domain);
      assert.equal(isReservedSendingDomain(`mail.${domain}`), true, `subdomain of ${domain}`);
      const from = sender.validateSenderInput({ ...good, from_address: `boss@${domain}` });
      assert.equal(!from.ok && from.field, "from_address", domain);
      const reply = sender.validateSenderInput({ ...good, reply_to: `boss@${domain}` });
      assert.equal(!reply.ok && reply.field, "reply_to", domain);
    }
    assert.equal(isReservedSendingDomain("notoasisai.work"), false, "a lookalike is not OASIS's, and is the owner's to prove");
  });
  await check("addresses must be addresses", () => {
    for (const bad of ["alpha.test", "a@b", "a b@c.test", "a@@c.test", "a@c..test", ".a@c.test"]) {
      assert.equal(!sender.validateSenderInput({ ...good, from_address: bad }).ok && "x", "x", bad);
    }
    const reply = sender.validateSenderInput({ ...good, reply_to: "not-an-address" });
    assert.equal(!reply.ok && reply.field, "reply_to");
    assert.equal(sender.validateSenderInput("nope").ok, false);
    assert.equal(sender.validateSenderInput([good]).ok, false);
  });

  // -- 2. The rule that makes an address count -----------------------------
  await check("decideVerification: each case, and the workspace mailbox wins when both prove it", () => {
    const d = sender.decideVerification;
    const mailbox = (address: string, tested: boolean | null) => ({ saved: true as const, address, tested });
    assert.deepEqual(d("hello@a.test", { workspace: mailbox("hello@a.test", true), memberGoogle: ["hello@a.test"] }), { verified: true, via: "gws", mailbox: "hello@a.test" });
    assert.deepEqual(d("Hello@A.test", { workspace: { saved: false }, memberGoogle: ["hello@a.test"] }), { verified: true, via: "gmail_oauth", mailbox: "hello@a.test" });
    assert.deepEqual(d("hello@a.test", { workspace: mailbox("hello@a.test", null), memberGoogle: [] }), { verified: false, reason: "not_tested" });
    assert.deepEqual(d("hello@a.test", { workspace: mailbox("hello@a.test", false), memberGoogle: [] }), { verified: false, reason: "test_failed" });
    assert.deepEqual(d("hello@a.test", { workspace: mailbox("other@a.test", true), memberGoogle: [] }), { verified: false, reason: "other_mailbox", mailbox: "other@a.test" });
    assert.deepEqual(d("hello@a.test", { workspace: { saved: false }, memberGoogle: ["jane@a.test"] }), { verified: false, reason: "no_mailbox" }, "a teammate on the same domain proves nothing about this address");
  });

  // -- 3. brandForTenant: the workspace's own brand, only when verified -----
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    tenant_id: A,
    display_name: "Alpha Plumbing",
    legal_name: "Alpha Plumbing Inc.",
    postal_address: "12 King St W, Suite 300, Toronto, ON M5H 1A1",
    from_address: "hello@alpha.test",
    reply_to: null,
    sending_domain: "alpha.test",
    verified_via: "gws",
    verified_at: T,
    created_by: "user-a1",
    created_at: T,
    updated_at: T,
    ...over,
  }) as never;
  const verified = { verified: true as const, via: "gws" as const, mailbox: "hello@alpha.test" };
  const lookup = (r: unknown, verification: unknown = verified) => ({ state: "saved" as const, sender: r, verification }) as never;

  await check("a verified client sender becomes the workspace's own brand", () => {
    const brand = brandForTenant({ tenantId: A, sender: lookup(row()) });
    assert.deepEqual(brand, {
      kind: "tenant",
      tenantId: A,
      displayName: "Alpha Plumbing",
      legalName: "Alpha Plumbing Inc.",
      postalAddress: "12 King St W, Suite 300, Toronto, ON M5H 1A1",
      fromAddress: "hello@alpha.test",
      replyTo: null,
      sendingDomain: "alpha.test",
      verifiedVia: "gws",
    });
  });
  await check("an unverified sender is null, whatever the reason (fail closed)", () => {
    for (const reason of ["no_mailbox", "other_mailbox", "not_tested", "test_failed", "check_failed"]) {
      assert.equal(brandForTenant({ tenantId: A, sender: lookup(row(), { verified: false, reason }) }), null, reason);
      // Even naming the very address it was asked about, a check that did not
      // verify is not a verification.
      assert.equal(brandForTenant({ tenantId: A, sender: lookup(row(), { verified: false, reason, mailbox: "hello@alpha.test" }) }), null, `${reason} + mailbox`);
    }
    assert.equal(brandForTenant({ tenantId: A, sender: { state: "not_set_up" } }), null);
    assert.equal(brandForTenant({ tenantId: A, sender: { state: "unavailable" } }), null);
    assert.equal(brandForTenant({ tenantId: A, sender: null }), null);
    assert.equal(brandForTenant({ tenantId: A }), null, "without a sender, exactly as before");
  });
  await check("a row that is not exactly this workspace's verified, aligned, complete identity is null", () => {
    assert.equal(brandForTenant({ tenantId: E, sender: lookup(row()) }), null, "another workspace's row");
    assert.equal(brandForTenant({ tenantId: A, sender: lookup(row(), { ...verified, mailbox: "other@alpha.test" }) }), null, "the check proved a different address");
    assert.equal(brandForTenant({ tenantId: A, sender: lookup(row({ sending_domain: "beta.test" })) }), null, "From off its own domain");
    assert.equal(brandForTenant({ tenantId: A, sender: lookup(row({ postal_address: "  " })) }), null, "no postal address (D11)");
    assert.equal(brandForTenant({ tenantId: A, sender: lookup(row({ legal_name: "" })) }), null, "no legal name");
    const oasisDomain = getBrand("oasis").sendingDomain;
    assert.equal(
      brandForTenant({ tenantId: A, sender: lookup(row({ from_address: `ceo@${oasisDomain}`, sending_domain: oasisDomain }), { ...verified, mailbox: `ceo@${oasisDomain}` }) }),
      null,
      "never a client brand on OASIS's domain",
    );
    assert.equal(brandForTenant({ tenantSlug: "alpha", sender: lookup(row()) }), null, "a slug alone names no workspace");
    assert.equal(brandForTenant({ tenantId: A, tenantSlug: "submissions", sender: lookup(row()) }), null, "an id the map does not know beside a slug it does: refuse");
  });
  await check("OASIS's and SunBiz's brands are untouched: a stored row can never override them", () => {
    assert.equal(brandForTenant({ tenantId: OASIS, sender: lookup(row({ tenant_id: OASIS })) }), "oasis");
    assert.equal(brandForTenant({ tenantId: SUNBIZ, sender: lookup(row({ tenant_id: SUNBIZ })) }), "sunbiz");
    assert.equal(brandForTenant({ tenantSlug: "oasis-ai-cc", sender: lookup(row()) }), "oasis");
  });
  await check("mailboxBrandConflict holds a workspace's brand to its own domain", () => {
    const brand = brandForTenant({ tenantId: A, sender: lookup(row()) });
    assert.ok(brand && typeof brand === "object");
    assert.equal(mailboxBrandConflict(brand, "hello@alpha.test"), null);
    assert.equal(mailboxBrandConflict(brand, "Jane <jane@alpha.test>"), null, "a member's own mailbox on the same domain");
    assert.equal(mailboxBrandConflict(brand, "bot@mail.alpha.test"), null);
    assert.match(String(mailboxBrandConflict(brand, "jane@gmail.test")), /must send from alpha\.test/);
    assert.ok(mailboxBrandConflict(brand, "x@notalpha.test"), "a lookalike");
    assert.ok(mailboxBrandConflict(brand, getBrand("oasis").fromAddress), "OASIS's mailbox");
  });

  // -- 4. The footer --------------------------------------------------------
  await check("the footer names the workspace's legal name, postal address, contact and opt-out, and nothing of OASIS's", () => {
    const brand = brandForTenant({ tenantId: A, sender: lookup(row({ reply_to: "office@alpha.test" })) });
    assert.ok(brand && typeof brand === "object");
    const body = appendSignatureAndFooter("Hi Sam,\n\nYour quote is attached.", {
      brand,
      fromAddress: "hello@alpha.test",
      unsubscribeUrl: UNSUB,
    });
    assert.equal(
      body,
      "Hi Sam,\n\nYour quote is attached.\n\n---\nAlpha Plumbing Inc.\n12 King St W, Suite 300, Toronto, ON M5H 1A1\noffice@alpha.test\n\n" +
        `To stop receiving these emails, unsubscribe here: ${UNSUB}`,
      "no sign-off from OASIS's roster, then the workspace's own footer",
    );
    for (const key of ALL_BRAND_KEYS) {
      const other = getBrand(key);
      assert.ok(!body.includes(other.legalName), `names ${other.legalName}`);
      assert.ok(!body.includes(other.postalAddress.split(",")[0]), `carries ${key}'s street`);
    }
    assert.doesNotMatch(body, /OASIS/);
    const signed = appendSignatureAndFooter("Hi", { brand, signer: { name: "Sam Alpha", phone: "416-555-0100" }, unsubscribeUrl: UNSUB });
    assert.match(signed, /^Hi\n\nSam Alpha\n416-555-0100\n\n---\nAlpha Plumbing Inc\./, "an explicit signer signs");
    assert.match(tenantSenderFooter({ ...brand, replyTo: null }, UNSUB), /\nhello@alpha\.test\n/, "the sending address when there is no reply-to");
  });
  await check("no footer, so no email, without the postal address, the legal name or a real opt-out link", () => {
    const brand = brandForTenant({ tenantId: A, sender: lookup(row()) });
    assert.ok(brand && typeof brand === "object");
    assert.throws(() => tenantSenderFooter({ ...brand, postalAddress: " " }, UNSUB), /postal address/);
    assert.throws(() => tenantSenderFooter({ ...brand, legalName: "" }, UNSUB), /legal name/);
    assert.throws(() => appendSignatureAndFooter("Hi", { brand }), /unsubscribe link/);
    assert.throws(() => appendSignatureAndFooter("Hi", { brand, unsubscribeUrl: "reply UNSUBSCRIBE" }), /unsubscribe link/);
    assert.throws(() => appendSignatureAndFooter("Hi", { brand, unsubscribeUrl: UNSUB, purpose: "support" }), /support mail is OASIS's/);
  });

  // -- 5. Before bravo__202 is applied --------------------------------------
  await check("before the migration: the page state is 'not set up yet' and a save changes nothing", async () => {
    assert.deepEqual(await sender.loadTenantSender(db, A), { state: "not_set_up" });
    assert.equal(sender.describeSender({ state: "not_set_up" }).label, "Not set up yet");
    await workspaceMailbox(A, "hello@alpha.test", { at: T, ok: 1 });
    signIn(A, "alpha", true);
    const r = await post(good);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_set_up");
    assert.match(String(r.body.message), /can't be saved yet/);
    assert.doesNotMatch(String(r.body.message), /tenant_sender|bravo__|Turso|migration/i, "no internal names on screen");
    assert.equal(await count("SELECT COUNT(*) FROM tenant_audit_log"), 0, "the audit row went with the failed batch");
  });

  // The real migration file, exactly as Bravo will apply it.
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__202_tenant_sender.sql"), "utf8"));

  await check("the migration: one row per workspace, a required postal address, and a tenant that never moves", async () => {
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO tenant_sender (tenant_id, display_name, legal_name, postal_address, from_address, sending_domain, created_at, updated_at) VALUES ('t-x', 'X', 'X Inc', '   ', 'a@x.test', 'x.test', ?, ?)",
        args: [T, T],
      }),
      /CHECK constraint/i,
    );
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO tenant_sender (tenant_id, display_name, legal_name, postal_address, from_address, sending_domain, verified_via, created_at, updated_at) VALUES ('t-x', 'X', 'X Inc', '1 Main St, X 1A1', 'a@x.test', 'x.test', 'guess', ?, ?)",
        args: [T, T],
      }),
      /CHECK constraint/i,
    );
    await db.execute({
      sql: "INSERT INTO tenant_sender (tenant_id, display_name, legal_name, postal_address, from_address, sending_domain, created_at, updated_at) VALUES ('t-x', 'X', 'X Inc', '1 Main St, X 1A1', 'a@x.test', 'x.test', ?, ?)",
      args: [T, T],
    });
    await assert.rejects(db.execute("UPDATE tenant_sender SET tenant_id = 't-y' WHERE tenant_id = 't-x'"), /immutable/);
    await db.execute("DELETE FROM tenant_sender WHERE tenant_id = 't-x'");
  });

  // -- 6. Verified is real: the live rows of THIS workspace -----------------
  await memberGoogle(B, "user-b-owner", "owner@bravo.test", SEND_SCOPE);
  await memberGoogle(B, "user-b-reader", "reader@bravo.test", READ_SCOPE);
  await db.execute("INSERT INTO user_profiles (id, tenant_id, auth_user_id, email, team_role, is_owner) VALUES ('p-b1', ?, 'user-b-owner', 'owner@bravo.test', 'owner', 1)", [B] as never);
  await db.execute("INSERT INTO user_profiles (id, tenant_id, auth_user_id, email, team_role) VALUES ('p-b2', ?, 'user-b-reader', 'reader@bravo.test', 'member')", [B] as never);
  await workspaceMailbox(C, "info@charlie.test", { at: null, ok: null });
  await workspaceMailbox(D, "info@delta.test", { at: T, ok: 0 });
  // E's own member connected Google with A's address: that account is A's
  // owner's, signed in to E. It still has to be an active member of E.
  const verify = (tenantId: string, address: string) => sender.verifySenderMailbox(db, tenantId, address);

  await check("the workspace's Google Workspace mailbox, tested, verifies exactly its own address", async () => {
    assert.deepEqual(await verify(A, "hello@alpha.test"), { verified: true, via: "gws", mailbox: "hello@alpha.test" });
    assert.deepEqual(await verify(A, "HELLO@alpha.TEST"), { verified: true, via: "gws", mailbox: "hello@alpha.test" });
    assert.deepEqual(await verify(A, "sales@alpha.test"), { verified: false, reason: "other_mailbox", mailbox: "hello@alpha.test" });
  });
  await check("untested and failed mailboxes do not count, and say which", async () => {
    assert.deepEqual(await verify(C, "info@charlie.test"), { verified: false, reason: "not_tested" });
    assert.deepEqual(await verify(D, "info@delta.test"), { verified: false, reason: "test_failed" });
    // Saving a new App Password clears its test result: the old pass no longer describes the mailbox.
    await db.execute("UPDATE tenant_integration_credentials SET last_tested_at = NULL, last_test_ok = NULL WHERE tenant_id = ? AND field_key = 'app_password'", [A] as never);
    assert.deepEqual(await verify(A, "hello@alpha.test"), { verified: false, reason: "not_tested" });
    await workspaceMailbox(A, "hello@alpha.test", { at: T, ok: 1 });
  });
  await check("another workspace's mailbox never verifies this one", async () => {
    assert.deepEqual(await verify(E, "hello@alpha.test"), { verified: false, reason: "no_mailbox" });
    assert.deepEqual(await verify(B, "hello@alpha.test"), { verified: false, reason: "no_mailbox" });
  });
  await check("an active member's own Google account, allowed to send, verifies its own address only", async () => {
    assert.deepEqual(await verify(B, "owner@bravo.test"), { verified: true, via: "gmail_oauth", mailbox: "owner@bravo.test" });
    assert.deepEqual(await verify(B, "reader@bravo.test"), { verified: false, reason: "no_mailbox" }, "read-only Google access cannot send");
    assert.deepEqual(await verify(B, "hello@bravo.test"), { verified: false, reason: "no_mailbox" }, "a teammate's account on the domain is not this address");
    assert.deepEqual(await verify(E, "owner@bravo.test"), { verified: false, reason: "no_mailbox" }, "B's member proves nothing for E");
    await db.execute("UPDATE user_profiles SET deactivated_at = ? WHERE id = 'p-b1'", [T] as never);
    assert.deepEqual(await verify(B, "owner@bravo.test"), { verified: false, reason: "no_mailbox" }, "a deactivated member proves nothing");
    await db.execute("UPDATE user_profiles SET deactivated_at = NULL WHERE id = 'p-b1'");
  });
  await check("a row that cannot be read is 'couldn't check', never verified", async () => {
    await db.execute("UPDATE tenant_integration_credentials SET encrypted_value = 'garbage' WHERE tenant_id = ? AND field_key = 'from_address'", [D] as never);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      assert.deepEqual(await verify(D, "info@delta.test"), { verified: false, reason: "check_failed" });
    } finally {
      console.error = original;
    }
    assert.ok(errors.length > 0, "the failure is logged, not swallowed");
    assert.equal(sender.describeSender(lookup(row(), { verified: false, reason: "check_failed" })).label, "Couldn't check");
  });

  // -- 7. POST /api/settings/sender -----------------------------------------
  await check("a member below owner/admin cannot save, and nothing is written", async () => {
    signIn(A, "alpha", false);
    const r = await post(good);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    assert.equal(await count("SELECT COUNT(*) FROM tenant_sender"), 0);
    viewer = { ok: false };
    assert.equal((await post(good)).status, 401);
  });
  await check("the owner saves for the session's workspace only: a tenant in the body is ignored", async () => {
    signIn(A, "alpha", true, "user-a-owner");
    const r = await post({ ...good, tenant_id: E });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, true);
    assert.deepEqual(r.body.status, {
      kind: "connected",
      label: "Verified through hello@alpha.test",
      detail: "hello@alpha.test is this workspace's Google Workspace mailbox, and its last test passed.",
    });
    assert.equal(await count("SELECT COUNT(*) FROM tenant_sender"), 1);
    assert.equal(await count("SELECT COUNT(*) FROM tenant_sender WHERE tenant_id = ?", [E]), 0, "nothing for the tenant named in the body");
    const saved = (await db.execute({ sql: "SELECT * FROM tenant_sender WHERE tenant_id = ?", args: [A] })).rows[0] as unknown as Record<string, unknown>;
    assert.equal(saved.postal_address, "12 King St W, Suite 300, Toronto, ON M5H 1A1");
    assert.equal(saved.from_address, "hello@alpha.test");
    assert.equal(saved.sending_domain, "alpha.test");
    assert.equal(saved.verified_via, "gws");
    assert.equal(saved.created_by, "user-a-owner");
    const audit = (await db.execute({ sql: "SELECT * FROM tenant_audit_log", args: [] })).rows as unknown as Array<Record<string, unknown>>;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].tenant_id, A);
    assert.equal(audit[0].actor_user_id, "user-a-owner");
    assert.equal(audit[0].action_type, "sending_identity.saved");
    assert.equal(audit[0].target_table, "sending identity", "the Activity log's 'About' column reads words, not a table name");
    assert.equal(audit[0].before, null);
    assert.equal(JSON.parse(String(audit[0].after)).from_address, "hello@alpha.test");
  });
  await check("a second save updates the row, keeps who created it, and audits the before and after", async () => {
    signIn(A, "alpha", true, "user-a-admin");
    const created = (await db.execute({ sql: "SELECT created_at, created_by FROM tenant_sender WHERE tenant_id = ?", args: [A] })).rows[0] as unknown as Record<string, unknown>;
    const r = await post({ ...good, display_name: "Alpha Plumbing & Heating", reply_to: "Office@Alpha.test" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const now = (await db.execute({ sql: "SELECT * FROM tenant_sender WHERE tenant_id = ?", args: [A] })).rows[0] as unknown as Record<string, unknown>;
    assert.equal(now.display_name, "Alpha Plumbing & Heating");
    assert.equal(now.reply_to, "office@alpha.test");
    assert.equal(now.created_at, created.created_at);
    assert.equal(now.created_by, "user-a-owner");
    const last = (await db.execute("SELECT before, after, actor_user_id FROM tenant_audit_log ORDER BY created_at DESC, rowid DESC LIMIT 1")).rows[0] as unknown as Record<string, unknown>;
    assert.equal(JSON.parse(String(last.before)).display_name, "Alpha Plumbing");
    assert.equal(JSON.parse(String(last.after)).display_name, "Alpha Plumbing & Heating");
    assert.equal(last.actor_user_id, "user-a-admin");
  });
  await check("an invalid save is refused with the field, and changes nothing", async () => {
    const audits = await count("SELECT COUNT(*) FROM tenant_audit_log");
    const r = await post({ ...good, postal_address: "" });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "postal_address");
    assert.equal(await count("SELECT COUNT(*) FROM tenant_audit_log"), audits);
    assert.equal((await post("{not json")).status, 400);
  });
  await check("OASIS's own workspace keeps its fixed identity: the route refuses to store one", async () => {
    signIn(OASIS, "oasis-ai-cc", true);
    const r = await post({ ...good, from_address: "hello@alpha.test" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "identity_fixed");
    assert.equal(await count("SELECT COUNT(*) FROM tenant_sender WHERE tenant_id = ?", [OASIS]), 0);
  });
  await check("an unverified identity saves, and says exactly what is missing", async () => {
    signIn(E, "echo", true);
    const r = await post({ ...good, from_address: "hello@echo.test" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, false);
    assert.deepEqual(r.body.status, {
      kind: "attention",
      label: "Not verified yet",
      detail: "Connect hello@echo.test in Settings > Connections > Google Workspace and press Test. Until then no email goes out under this identity.",
    });
    signIn(B, "bravo", true, "user-b-owner");
    const viaGoogle = await post({ ...good, from_address: "owner@bravo.test" });
    assert.equal(viaGoogle.body.verified, true);
    assert.equal((viaGoogle.body.status as Record<string, unknown>).label, "Verified through owner@bravo.test");
  });

  // -- 8. Read back: the brand every send path will use --------------------
  await check("loadTenantSender + brandForTenant: A sends as itself, E (unverified) cannot send", async () => {
    const a = await sender.loadTenantSender(db, A);
    const brandA = brandForTenant({ tenantId: A, sender: a });
    assert.ok(brandA && typeof brandA === "object" && brandA.kind === "tenant", JSON.stringify(a));
    assert.equal(brandA.legalName, "Alpha Plumbing Inc.");
    assert.equal(brandA.replyTo, "office@alpha.test");
    const footer = appendSignatureAndFooter("Hello", { brand: brandA, unsubscribeUrl: UNSUB });
    assert.match(footer, /Alpha Plumbing Inc\.\n12 King St W, Suite 300, Toronto, ON M5H 1A1\noffice@alpha\.test/);
    const e = await sender.loadTenantSender(db, E);
    assert.equal(e.state, "saved");
    assert.equal(brandForTenant({ tenantId: E, sender: e }), null);
    // The mailbox is disconnected after the save: the next read stops it.
    await db.execute("DELETE FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'gws'", [A] as never);
    assert.equal(brandForTenant({ tenantId: A, sender: await sender.loadTenantSender(db, A) }), null, "verified is checked on every read, not stored");
    await workspaceMailbox(A, "hello@alpha.test", { at: T, ok: 1 });
    assert.equal((await sender.loadTenantSender(null, A)).state, "unavailable");
  });

  // -- 9. Settings > Brand --------------------------------------------------
  await check("a client's page shows its saved identity in the form with the live status", async () => {
    signIn(A, "alpha", true);
    formProps.length = 0;
    const text = (await render(await SettingsBrandPage())).join(" ");
    assert.equal(formProps.length, 1);
    const p = formProps[0] as { initial: Record<string, string>; status: Record<string, string>; connectHref: string; disabled: boolean };
    assert.equal(p.initial.legal_name, "Alpha Plumbing Inc.");
    assert.equal(p.initial.postal_address, "12 King St W, Suite 300, Toronto, ON M5H 1A1");
    assert.equal(p.initial.reply_to, "office@alpha.test");
    assert.equal(p.status.label, "Verified through hello@alpha.test");
    assert.equal(p.connectHref, "/settings/connections?app=google-workspace");
    assert.equal(p.disabled, false);
    assert.doesNotMatch(text, /verifies your sending domain during your install/, "the old dead end is gone");
  });
  await check("a client with nothing saved sees 'not set up yet'; one that is not verified sees what is missing", async () => {
    signIn(C, "charlie", true);
    formProps.length = 0;
    await render(await SettingsBrandPage());
    assert.equal((formProps[0] as { status: { label: string } }).status.label, "Not set up yet");
    assert.deepEqual((formProps[0] as { initial: Record<string, string> }).initial, { display_name: "", legal_name: "", postal_address: "", from_address: "", reply_to: "" });
    signIn(E, "echo", true);
    formProps.length = 0;
    await render(await SettingsBrandPage());
    assert.match((formProps[0] as { status: { detail: string } }).status.detail, /^Connect hello@echo\.test in Settings > Connections > Google Workspace and press Test\./);
  });
  await check("OASIS's page shows its fixed identity read-only, with no form", async () => {
    signIn(OASIS, "oasis-ai-cc", true);
    formProps.length = 0;
    const text = (await render(await SettingsBrandPage())).join(" ");
    assert.equal(formProps.length, 0);
    assert.ok(text.includes(getBrand("oasis").fromAddress), text);
    assert.match(text, /Read-only here/);
  });
  await check("a member below owner/admin never reaches the page", async () => {
    signIn(A, "alpha", false);
    await assert.rejects(SettingsBrandPage(), /404/);
  });

  console.log(`\ntenant-sender.test.ts: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
