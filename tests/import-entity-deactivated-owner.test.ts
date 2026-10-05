/**
 * import-entity-deactivated-owner.test.ts — the generic CSV import door
 * (POST /api/import/[entity], lib/import/service.ts) can never hand NEW
 * applications or funded deals to a deactivated teammate, or to someone who is
 * not on the team.
 *
 * The door validated the owner only for OASIS leads. For every other entity the
 * assigned_to cell (applications: "Assigned to", funded deals: "Assigned rep")
 * was copied verbatim into the new record. The sibling door, /api/leads/import,
 * was closed in c5028e8c with createImportAssigneeCheck; this one now reuses it:
 * the cell (an auth user id, or a teammate's email) resolves to an ACTIVE
 * member's auth id before anything is written. A deactivated or non-member
 * owner refuses the whole batch (422, with the row); a failed standing read
 * refuses it too (503). Active owners import as before. The OASIS lead path
 * (active assignment roster) never reaches the check, and stays pinned by
 * tests/oasis-create-stage-contract.test.ts.
 *
 * Driven for real against a local libSQL database: the real session check,
 * profile resolution, entity registry, normalizers and data layer. The only
 * stand-in is the request cookie jar (next/headers), as in
 * tests/leads-import-deactivated-owner.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/import-entity-deactivated-owner.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "import-entity-deactivated-owner-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "import-entity-deactivated-owner-secret-long-01";

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

const TENANT = "4c4c4c4c-0000-4000-8000-00000000004c";
const OTHER_TENANT = "5e5e5e5e-0000-4000-8000-00000000005e";
const OASIS_TENANT = "6f6f6f6f-0000-4000-8000-00000000006f";
const ADMIN = "1c1c1c1c-0000-4000-8000-000000000001";
const AGENT = "1c1c1c1c-0000-4000-8000-000000000002";
const RETIRED = "1c1c1c1c-0000-4000-8000-000000000003";
const DUPLICATE = "1c1c1c1c-0000-4000-8000-000000000004";
const STRANGER = "1c1c1c1c-0000-4000-8000-000000000005";
const OASIS_REP = "1c1c1c1c-0000-4000-8000-000000000006";
const RETIRED_AT = "2026-09-24T12:00:00Z";

type ApiBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  row?: number;
  inserted?: number;
  dry_run?: boolean;
};

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
  console.log("import-entity-deactivated-owner:");
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
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
  `);

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
  await seed.batch(
    [
      ...[
        [ADMIN, "admin@sun.test"],
        [AGENT, "agent@sun.test"],
        [RETIRED, "retired@sun.test"],
        [DUPLICATE, "dup@sun.test"],
        [STRANGER, "stranger@elsewhere.test"],
        [OASIS_REP, "rep@oasis.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-admin", ADMIN, "admin@sun.test", TENANT, "admin"),
      profile("p-agent", AGENT, "agent@sun.test", TENANT, "agent"),
      profile("p-retired", RETIRED, "retired@sun.test", TENANT, "agent", RETIRED_AT),
      // Still active on another tenant; standing is tenant-scoped.
      profile("p-retired-elsewhere", RETIRED, "retired@elsewhere.test", OTHER_TENANT, "agent"),
      // One person, two rows here: an old retired row and a live one.
      profile("p-dup-old", DUPLICATE, "dup-old@sun.test", TENANT, "agent", RETIRED_AT),
      profile("p-dup-new", DUPLICATE, "dup@sun.test", TENANT, "agent"),
      // Active, but only on another tenant: never a member here.
      profile("p-stranger", STRANGER, "stranger@elsewhere.test", OTHER_TENANT, "agent"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS_TENANT] },
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const { MEMBER_DEACTIVATED_MESSAGE } = await import("../lib/team");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { getEntityDefinition } = await import("../lib/import/entities");
  const { importRowsForTenant } = await import("../lib/import/service");
  const genericImport = await import("../app/api/import/[entity]/route");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  let seq = 0;
  const application = (assignedTo?: string) => {
    seq += 1;
    return {
      business_name: `Merchant ${seq} LLC`,
      email: `merchant-${seq}@client.test`,
      state: "FL",
      requested_amount: "75000",
      ...(assignedTo === undefined ? {} : { assigned_to: assignedTo }),
    };
  };
  const fundedDeal = (assignedTo?: string) => {
    seq += 1;
    return {
      business_name: `Funded ${seq} LLC`,
      funded_amount: "50000",
      lender_name: `Lender ${seq}`,
      ...(assignedTo === undefined ? {} : { assigned_to: assignedTo }),
    };
  };
  const postImport = async (entity: string, rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
    const req = new NextRequest(`http://localhost/api/import/${entity}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows, ...extra }),
    });
    const res = await genericImport.POST(req, { params: Promise.resolve({ entity }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const recordCount = async (tenantId = TENANT) =>
    Number((await seed.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_records WHERE tenant_id = ?", args: [tenantId] })).rows[0].n);
  const ownerOf = async (businessName: string, tenantId = TENANT) => {
    const r = await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.business_name') = ?",
      args: [tenantId, businessName],
    });
    assert.equal(r.rows.length, 1, `${businessName} was not imported`);
    return (JSON.parse(String(r.rows[0].data)) as { assigned_to?: string | null }).assigned_to ?? null;
  };
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try {
      return await fn();
    } finally {
      console.error = original;
    }
  };
  const breakStandingRead = () =>
    seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason TO deactivation_reason_offline");
  const restoreStandingRead = () =>
    seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason_offline TO deactivation_reason");

  // ── Active owners: imported as before ──────────────────────────────────
  await check("applications: an ACTIVE owner by auth id imports exactly as before", async () => {
    const r = application(AGENT);
    const res = await postImport("applications", [r]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inserted, 1);
    assert.equal(await ownerOf(r.business_name), AGENT);
  });

  await check("applications: a row with no owner still imports unowned", async () => {
    const r = application();
    const res = await postImport("applications", [r]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(r.business_name), null);
  });

  await check("applications: an ACTIVE owner named by email is stored as their auth id", async () => {
    const r = application("  Agent@Sun.TEST ");
    const res = await postImport("applications", [r]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(r.business_name), AGENT, "assigned_to must hold the auth id every check compares against");
  });

  await check("applications: a person with a live row here is active despite a retired duplicate", async () => {
    const byOldEmail = application("dup-old@sun.test");
    const byId = application(DUPLICATE);
    const res = await postImport("applications", [byOldEmail, byId]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(byOldEmail.business_name), DUPLICATE);
    assert.equal(await ownerOf(byId.business_name), DUPLICATE);
  });

  await check("funded-deals: an ACTIVE rep imports with their auth id", async () => {
    const byId = fundedDeal(AGENT);
    const byEmail = fundedDeal("agent@sun.test");
    const res = await postImport("funded-deals", [byId, byEmail]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inserted, 2);
    assert.equal(await ownerOf(byId.business_name), AGENT);
    assert.equal(await ownerOf(byEmail.business_name), AGENT);
  });

  // ── Deactivated owners: the whole batch is refused ─────────────────────
  await check("applications: a DEACTIVATED owner refuses the whole batch (422, row named), nothing written", async () => {
    const before = await recordCount();
    for (const retired of [RETIRED, RETIRED.toUpperCase(), "retired@sun.test"]) {
      const res = await postImport("applications", [application(AGENT), application(retired), application(AGENT)]);
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, "member_deactivated");
      assert.equal(res.body.row, 2);
      assert.ok(res.body.message?.includes(MEMBER_DEACTIVATED_MESSAGE), res.body.message);
    }
    assert.equal(await recordCount(), before, "a refused import wrote a partial batch");
  });

  await check("funded-deals: a DEACTIVATED rep refuses the whole batch, nothing written", async () => {
    const before = await recordCount();
    const res = await postImport("funded-deals", [fundedDeal(AGENT), fundedDeal(RETIRED)]);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error, "member_deactivated");
    assert.equal(res.body.row, 2);
    assert.equal(await recordCount(), before, "a refused import wrote a partial batch");
  });

  await check("applications: a dry run surfaces the refusal instead of previewing it as importable", async () => {
    const before = await recordCount();
    const res = await postImport("applications", [application(RETIRED)], { dry_run: true });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error, "member_deactivated");
    assert.equal(await recordCount(), before);
  });

  // ── Non-members: refused ───────────────────────────────────────────────
  await check("an owner who is not on this tenant refuses the batch (not_a_tenant_member)", async () => {
    const before = await recordCount();
    for (const stranger of [STRANGER, "stranger@elsewhere.test", "Mike Reyes"]) {
      const res = await postImport("applications", [application(stranger)]);
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(res.body.error, "not_a_tenant_member");
      assert.equal(res.body.row, 1);
    }
    const res = await postImport("funded-deals", [fundedDeal(AGENT), fundedDeal(STRANGER)]);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_a_tenant_member");
    assert.equal(res.body.row, 2);
    assert.equal(await recordCount(), before);
  });

  // ── Read error: fail closed ────────────────────────────────────────────
  await check("a FAILED standing read refuses the import (503), nothing written", async () => {
    const before = await recordCount();
    // Session resolution selects *, so only the standing read breaks.
    await breakStandingRead();
    try {
      for (const owner of [AGENT, "agent@sun.test"]) {
        const res = await quietly(() => postImport("applications", [application(), application(owner)]));
        assert.equal(res.status, 503, JSON.stringify(res.body));
        assert.equal(res.body.error, "member_check_failed");
        assert.equal(res.body.row, 2);
      }
    } finally {
      await restoreStandingRead();
    }
    assert.equal(await recordCount(), before, "an unverified owner was handed new records");
  });

  // ── OASIS lead path: the batch owner comes from the roster, never the check ──
  await check("OASIS leads: the roster-resolved batch owner imports without any member check", async () => {
    const leads = getEntityDefinition("leads");
    assert.ok(leads, "leads entity missing");
    const before = await recordCount(OASIS_TENANT);
    // With the standing read broken, any member check on this path would 503.
    await breakStandingRead();
    let res: Awaited<ReturnType<typeof importRowsForTenant>>;
    try {
      res = await importRowsForTenant({
        db: getServiceSupabase(),
        tenantId: OASIS_TENANT,
        entity: leads,
        rows: [{ business_name: "Oasis Prospect LLC", email: "owner@prospect.test", assigned_to: RETIRED }],
        tenantSlug: "oasis-ai-cc",
        oasisAssigneeUserId: OASIS_REP,
      });
    } finally {
      await restoreStandingRead();
    }
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(await recordCount(OASIS_TENANT), before + 1);
    assert.equal(await ownerOf("Oasis Prospect LLC", OASIS_TENANT), OASIS_REP);
  });

  if (failures > 0) {
    console.log(`import-entity-deactivated-owner: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("import-entity-deactivated-owner: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
