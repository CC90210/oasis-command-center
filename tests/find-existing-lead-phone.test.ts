/**
 * find-existing-lead-phone.test.ts — a returning merchant is found by PHONE.
 *
 * THE DEFECT (2026-09-11). findExistingLead built
 *
 *     .or("data->>email.eq.<email>,data->>phone.eq.<phone>")
 *
 * and the Turso adapter's .or() grammar types an all-digit literal as a
 * NUMBER. json_extract returns the stored phone as TEXT, and SQLite never
 * equals TEXT to an INTEGER, so from the Turso move (2026-08-09) a phone of
 * digits matched nothing: 1,089 of SunBiz's 1,450 leads store exactly that
 * shape. A comma in a typed phone ("..., ext 2") also split the grammar and
 * threw. Email matching was unaffected.
 *
 * The matcher now binds each key with .eq(). This file drives the REAL matcher
 * and the REAL quick-add route through the real adapter against a local libSQL
 * database (next/headers is the only stand-in, as in
 * oasis-create-stage-contract.test.ts), and pins what a SunBiz or OASIS user
 * sees on every matched-lead path that phone matching makes reachable.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "find-existing-lead-phone-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "find-existing-lead-phone-secret-that-is-long-enough-01";

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
const headersPath = require.resolve("next/headers");
require.cache[headersPath] = {
  id: headersPath,
  filename: headersPath,
  path: dirname(headersPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    cookies: async () => ({
      get: (name: string) =>
        name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
      getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
      has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
      set: () => undefined,
    }),
    headers: async () => new Headers(),
    draftMode: async () => ({ isEnabled: false }),
  },
} as unknown as NodeModule;

const OWNER = "0a0a0a0a-0000-4000-8000-000000000001";
const OPENER = "0a0a0a0a-0000-4000-8000-000000000002";
const SUN_ADMIN = "0a0a0a0a-0000-4000-8000-000000000003";
const SUN_AGENT = "0a0a0a0a-0000-4000-8000-000000000004";
const OTHER_REP = "0a0a0a0a-0000-4000-8000-000000000005";
const SUN = "5a5a5a5a-0000-4000-8000-00000000005a";
const OTHER_TENANT = "6b6b6b6b-0000-4000-8000-00000000006b";

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
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { findExistingLead } = await import("../lib/forms/agent-routing");
  const quickAdd = await import("../app/api/leads/quick-add/route");

  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, updated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT,
      correlation_id TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE forms (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, enabled INTEGER DEFAULT 1, created_at TEXT);
  `);
  const profile = (id: string, authId: string, email: string, tenant: string, role: string, owner = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [id, authId, email, tenant, role, owner],
  });
  let t = 0;
  const lead = (id: string, tenant: string, data: Record<string, unknown>, entity = "lead") => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, tenant, entity, JSON.stringify(data), `2026-09-01T00:00:${String(t++).padStart(2, "0")}.000Z`],
  });
  await seed.batch(
    [
      ...[
        [OWNER, "cc@oasis.test"],
        [OPENER, "opener@oasis.test"],
        [SUN_ADMIN, "admin@sun.test"],
        [SUN_AGENT, "agent@sun.test"],
      ].map(([id, email]) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [id, email] })),
      profile("p-owner", OWNER, "cc@oasis.test", WEBDEV_TENANT_ID, "owner", 1),
      profile("p-opener", OPENER, "opener@oasis.test", WEBDEV_TENANT_ID, "opener"),
      // SunBiz production runs owner / admin / member today; `agent` is the
      // ownership-scoped role the gate treats narrowly, so both are driven.
      profile("p-sun-admin", SUN_ADMIN, "admin@sun.test", SUN, "admin"),
      profile("p-sun-agent", SUN_AGENT, "agent@sun.test", SUN, "agent"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [WEBDEV_TENANT_ID] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [SUN] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'other', 'Other')", args: [OTHER_TENANT] },
      lead("m-digits", SUN, { business_name: "Digits Co", phone: "3055550100", stage: "follow_up" }),
      lead("m-other-tenant", OTHER_TENANT, { business_name: "Digits Co", phone: "3055550101", stage: "follow_up" }),
      lead("m-app", SUN, { business_name: "App Only", phone: "3055550102" }, "application"),
      lead("m-email-old", SUN, { business_name: "Twin Co", email: "twin@sun.test", stage: "follow_up" }),
      lead("m-phone-new", SUN, { business_name: "Twin Co", phone: "3055550103", stage: "follow_up" }),
      lead("m-owner-biz1", SUN, { business_name: "Owner First LLC", phone: "3055550104", stage: "signed_application" }),
      lead("m-noname", SUN, { phone: "3055550105", stage: "follow_up" }),
      lead("m-formatted", SUN, { business_name: "Format Co", phone: "(305) 555-0120", stage: "follow_up" }),
      lead("q-theirs", SUN, { business_name: "Theirs Co", phone: "3055550110", stage: "follow_up", assigned_to: OTHER_REP }),
      lead("q-follow", SUN, { business_name: "Follow Co", phone: "3055550111", stage: "follow_up", assigned_to: SUN_AGENT }),
      lead("q-signed", SUN, { business_name: "Signed Co", phone: "3055550112", stage: "signed_application", assigned_to: SUN_AGENT }),
      lead("q-optout", SUN, { business_name: "Optout Co", phone: "3055550113", stage: "opted_out", assigned_to: SUN_AGENT }),
      lead("q-declined", SUN, { business_name: "Declined Co", phone: "3055550114", stage: "declined", assigned_to: SUN_AGENT }),
      lead("o-pool", WEBDEV_TENANT_ID, { business_name: "Pool Two", email: "pool2@oasis.test", state: "ON", stage: "researched" }),
    ],
    "write",
  );

  console.log("find-existing-lead-phone:");

  // ── the matcher ─────────────────────────────────────────────────────────
  await check("an all-digit phone finds the lead that stores it", async () => {
    assert.equal((await findExistingLead(SUN, { phone: "3055550100" }))?.id, "m-digits");
  });
  await check("a phone never crosses tenants or entity types", async () => {
    assert.equal(await findExistingLead(SUN, { phone: "3055550101" }), null);
    assert.equal(await findExistingLead(SUN, { phone: "3055550102" }), null);
  });
  await check("email and phone on different leads: the newest match wins", async () => {
    assert.equal((await findExistingLead(SUN, { email: "twin@sun.test", phone: "3055550103" }))?.id, "m-phone-new");
  });
  await check("a comma in a typed phone does not throw", async () => {
    assert.equal(await findExistingLead(SUN, { phone: "305-555-0100, ext 2" }), null);
  });
  await check("a phone shared by a DIFFERENT business is not a match", async () => {
    assert.equal(
      await findExistingLead(SUN, { phone: "3055550104", business: "Owner Second LLC" }, { matchOnBusinessName: false }),
      null,
    );
  });
  await check("same business, different case: still a match", async () => {
    assert.equal((await findExistingLead(SUN, { phone: "3055550104", business: "owner first llc" }))?.id, "m-owner-biz1");
  });
  await check("a formatted phone finds the lead that stores bare digits", async () => {
    assert.equal((await findExistingLead(SUN, { phone: "(305) 555-0100" }))?.id, "m-digits");
    assert.equal((await findExistingLead(SUN, { phone: "+1 305-555-0100" }))?.id, "m-digits", "a leading US 1 is dropped");
  });
  await check("a formatted phone still finds the lead that stores it formatted", async () => {
    assert.equal((await findExistingLead(SUN, { phone: "(305) 555-0120" }))?.id, "m-formatted");
  });
  await check("the digits form never crosses a different business either", async () => {
    assert.equal(
      await findExistingLead(SUN, { phone: "(305) 555-0104", business: "Owner Second LLC" }, { matchOnBusinessName: false }),
      null,
    );
  });
  await check("a lead with no business name still matches on phone", async () => {
    assert.equal((await findExistingLead(SUN, { phone: "3055550105", business: "Anything" }))?.id, "m-noname");
  });
  await check("matchOnBusinessName:false never matches on the name alone", async () => {
    assert.equal(await findExistingLead(SUN, { business: "Digits Co" }, { matchOnBusinessName: false }), null);
    assert.equal((await findExistingLead(SUN, { business: "Digits Co" }))?.id, "m-digits", "the default keeps step 2");
  });

  // ── quick-add, every matched-lead path ─────────────────────────────────
  const { signSession } = await import("../lib/turso-auth");
  const { NextRequest } = await import("next/server");
  const login = (userId: string, email: string) => {
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const post = async (body: Record<string, unknown>) => {
    const res = await quickAdd.POST(
      new NextRequest("http://localhost/api/leads/quick-add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const stageOf = async (id: string) =>
    JSON.parse(String((await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] })).rows[0].data)).stage;
  const leads = async (tenant: string) =>
    Number((await seed.execute({ sql: "SELECT count(*) AS n FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead'", args: [tenant] })).rows[0].n);
  const readable = (body: Record<string, unknown>) => {
    assert.equal(typeof body.message, "string", "no message");
    assert.notEqual(body.message, body.error, "the message is just the code");
    assert.match(String(body.message), /\s/, "message is not a sentence");
  };

  login(SUN_AGENT, "agent@sun.test");
  await check("SunBiz agent, phone of another rep's lead: 409 with a sentence, nothing written", async () => {
    const n = await leads(SUN);
    const r = await post({ business_name: "Theirs Co", phone: "(305) 555-0110" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "lead_exists_not_yours");
    readable(r.body);
    assert.equal("id" in r.body, false, "must not leak the other rep's lead id");
    assert.equal(await leads(SUN), n);
  });
  await check("SunBiz agent, phone of own Follow Up lead: advanced to Sent Application", async () => {
    const r = await post({ business_name: "Follow Co", phone: "305.555.0111" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existing, true);
    assert.equal(r.body.advanced, true);
    assert.equal(await stageOf("q-follow"), "sent_application");
  });
  await check("SunBiz agent, phone of own Signed lead: kept, with a message naming the stage", async () => {
    const r = await post({ business_name: "Signed Co", phone: "3055550112" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existing, true);
    assert.equal(r.body.advanced, false);
    assert.equal(r.body.stage, "signed_application");
    assert.match(String(r.body.message), /Signed Application/);
    assert.equal(await stageOf("q-signed"), "signed_application");
  });
  await check("SunBiz agent, phone of own opted-out lead: never moved into a drip stage", async () => {
    await post({ business_name: "Optout Co", phone: "3055550113" });
    assert.equal(await stageOf("q-optout"), "opted_out");
  });
  await check("SunBiz agent, phone of own declined lead: revived to Sent Application exactly as before", async () => {
    const r = await post({ business_name: "Declined Co", phone: "3055550114" });
    assert.equal(r.body.advanced, true, JSON.stringify(r.body));
    assert.equal(await stageOf("q-declined"), "sent_application");
  });
  login(SUN_ADMIN, "admin@sun.test");
  await check("SunBiz admin, owner's phone on a different business: a new lead, the first untouched", async () => {
    const n = await leads(SUN);
    const r = await post({ business_name: "Owner Second LLC", phone: "3055550104" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existing, false);
    assert.equal(await leads(SUN), n + 1);
    assert.equal(await stageOf("m-owner-biz1"), "signed_application");
  });
  await check("SunBiz admin, phone of a Signed lead (newest lead on that phone is another business): found, not moved back", async () => {
    const n = await leads(SUN);
    const r = await post({ business_name: "Owner First LLC", phone: "305-555-0104" });
    assert.equal(r.body.existing, true, JSON.stringify(r.body));
    assert.equal(await leads(SUN), n);
    assert.equal(await stageOf("m-owner-biz1"), "signed_application");
  });

  login(OPENER, "opener@oasis.test");
  await check("OASIS opener, email of an unassigned pool lead: 409 with a sentence", async () => {
    const r = await post({ business_name: "Pool Two", email: "pool2@oasis.test", state: "ON" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "lead_exists_not_yours");
    readable(r.body);
  });

  await check("QuickAddLeadModal alerts the server's message for an existing lead", async () => {
    const src = readFileSync("components/manifest/QuickAddLeadModal.tsx", "utf8");
    assert.match(src, /json\.message \?\?/, "the modal still hard-codes the existing-lead text");
  });

  seed.close();
  if (failures > 0) {
    console.error(`find-existing-lead-phone: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("find-existing-lead-phone: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
