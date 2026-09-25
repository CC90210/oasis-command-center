/**
 * leads-import-deactivated-owner.test.ts — a SunBiz (non-OASIS) CSV import can
 * never hand NEW leads to a deactivated teammate, or to someone who is not on
 * the team.
 *
 * Both import entry points took the owner from each row's assigned_to cell and
 * stored it verbatim, with no membership or standing check:
 *
 *   POST /api/leads/import         the Leads > Import page
 *   lib/leads-import-service.ts    the chat attachment importer
 *
 * Now the cell (an auth user id, or a teammate's email) resolves to an ACTIVE
 * member's auth id before anything is written. A deactivated or non-member
 * owner refuses the whole batch (422, with the row); a failed standing read
 * refuses it too (503), since an import creates ownership. Active owners import
 * exactly as before. The OASIS path (active assignment roster) is untouched and
 * stays pinned by tests/oasis-create-stage-contract.test.ts.
 *
 * Driven for real against a local libSQL database: the real session check,
 * profile resolution, tenant gate and data layer. The only stand-in is the
 * request cookie jar (next/headers), as in tests/conversation-routing-deactivated.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/leads-import-deactivated-owner.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "leads-import-deactivated-owner-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "leads-import-deactivated-owner-secret-long-enough-01";

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

const TENANT = "4b4b4b4b-0000-4000-8000-00000000004b";
const OTHER_TENANT = "5d5d5d5d-0000-4000-8000-00000000005d";
const ADMIN = "1b1b1b1b-0000-4000-8000-000000000001";
const AGENT = "1b1b1b1b-0000-4000-8000-000000000002";
const RETIRED = "1b1b1b1b-0000-4000-8000-000000000003";
const DUPLICATE = "1b1b1b1b-0000-4000-8000-000000000004";
const STRANGER = "1b1b1b1b-0000-4000-8000-000000000005";
const RETIRED_AT = "2026-09-24T12:00:00Z";

type ApiBody = { ok?: boolean; error?: string; message?: string; row?: number; inserted?: number };

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
  console.log("leads-import-deactivated-owner:");
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
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const { MEMBER_DEACTIVATED_MESSAGE } = await import("../lib/team");
  const leadImport = await import("../app/api/leads/import/route");
  const { importLeadsForTenant } = await import("../lib/leads-import-service");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  let seq = 0;
  const row = (assignedTo?: string) => {
    seq += 1;
    return {
      name: `Merchant ${seq}`,
      email: `merchant-${seq}@client.test`,
      business_name: `Merchant ${seq} LLC`,
      state: "FL",
      stage: "New",
      ...(assignedTo === undefined ? {} : { assigned_to: assignedTo }),
    };
  };
  const postImport = async (rows: Array<Record<string, unknown>>) => {
    const req = new NextRequest("http://localhost/api/leads/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const res = await leadImport.POST(req);
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const leadCount = async () =>
    Number((await seed.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_records WHERE tenant_id = ?", args: [TENANT] })).rows[0].n);
  const ownerOf = async (email: string) => {
    const r = await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.email') = ?",
      args: [TENANT, email],
    });
    assert.equal(r.rows.length, 1, `${email} was not imported`);
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

  // ── POST /api/leads/import ─────────────────────────────────────────────
  await check("route: an ACTIVE owner by auth id imports exactly as before", async () => {
    const r = row(AGENT);
    const res = await postImport([r]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inserted, 1);
    assert.equal(await ownerOf(r.email), AGENT);
  });

  await check("route: a row with no owner still imports unowned", async () => {
    const r = row();
    const res = await postImport([r]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(r.email), null);
  });

  await check("route: an ACTIVE owner named by email is stored as their auth id", async () => {
    const r = row("  Agent@Sun.TEST ");
    const res = await postImport([r]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(r.email), AGENT, "assigned_to must hold the auth id every check compares against");
  });

  await check("route: a person with a live row here is active despite a retired duplicate", async () => {
    const byOldEmail = row("dup-old@sun.test");
    const byId = row(DUPLICATE);
    const res = await postImport([byOldEmail, byId]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(byOldEmail.email), DUPLICATE);
    assert.equal(await ownerOf(byId.email), DUPLICATE);
  });

  await check("route: a DEACTIVATED owner refuses the whole batch (422, row named), nothing written", async () => {
    const before = await leadCount();
    for (const retired of [RETIRED, RETIRED.toUpperCase(), "retired@sun.test"]) {
      const res = await postImport([row(AGENT), row(retired), row(AGENT)]);
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, "member_deactivated");
      assert.equal(res.body.row, 2);
      assert.ok(res.body.message?.includes(MEMBER_DEACTIVATED_MESSAGE), res.body.message);
    }
    assert.equal(await leadCount(), before, "a refused import wrote a partial batch");
  });

  await check("route: an owner who is not on this tenant refuses the batch (not_a_tenant_member)", async () => {
    const before = await leadCount();
    for (const stranger of [STRANGER, "stranger@elsewhere.test", "Mike Reyes"]) {
      const res = await postImport([row(stranger)]);
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(res.body.error, "not_a_tenant_member");
      assert.equal(res.body.row, 1);
    }
    assert.equal(await leadCount(), before);
  });

  await check("route: a FAILED standing read refuses the import (503), nothing written", async () => {
    const before = await leadCount();
    // Session resolution selects *, so only the standing read breaks.
    await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason TO deactivation_reason_offline");
    try {
      for (const owner of [AGENT, "agent@sun.test"]) {
        const res = await quietly(() => postImport([row(), row(owner)]));
        assert.equal(res.status, 503, JSON.stringify(res.body));
        assert.equal(res.body.error, "member_check_failed");
        assert.equal(res.body.row, 2);
      }
    } finally {
      await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason_offline TO deactivation_reason");
    }
    assert.equal(await leadCount(), before, "an unverified owner was handed new leads");
  });

  // ── lib/leads-import-service.ts (chat attachment importer) ─────────────
  await check("service: an ACTIVE owner imports; email resolves to the auth id", async () => {
    const byId = row(AGENT);
    const byEmail = row("agent@sun.test");
    const res = await importLeadsForTenant({ tenantId: TENANT, rows: [byId, byEmail] });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(await ownerOf(byId.email), AGENT);
    assert.equal(await ownerOf(byEmail.email), AGENT);
  });

  await check("service: a DEACTIVATED owner refuses the batch with the row, nothing written", async () => {
    const before = await leadCount();
    const res = await importLeadsForTenant({ tenantId: TENANT, rows: [row(AGENT), row(RETIRED)] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error, "member_deactivated");
    assert.equal(res.row, 2);
    assert.equal(await leadCount(), before);
  });

  await check("service: a non-member owner refuses the batch", async () => {
    const before = await leadCount();
    const res = await importLeadsForTenant({ tenantId: TENANT, rows: [row(STRANGER)] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error, "not_a_tenant_member");
    assert.equal(res.row, 1);
    assert.equal(await leadCount(), before);
  });

  await check("service: the OASIS-only batch assignee is ignored here; the row's owner is checked", async () => {
    const before = await leadCount();
    const res = await importLeadsForTenant({ tenantId: TENANT, assignee: AGENT, rows: [row(RETIRED)] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error, "member_deactivated");
    assert.equal(await leadCount(), before);
  });

  await check("service: a FAILED standing read refuses the import", async () => {
    const before = await leadCount();
    await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason TO deactivation_reason_offline");
    try {
      const res = await importLeadsForTenant({ tenantId: TENANT, rows: [row(AGENT)] });
      assert.equal(res.ok, false);
      if (res.ok) return;
      assert.equal(res.error, "member_check_failed");
    } finally {
      await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason_offline TO deactivation_reason");
    }
    assert.equal(await leadCount(), before);
  });

  if (failures > 0) {
    console.log(`leads-import-deactivated-owner: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("leads-import-deactivated-owner: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
