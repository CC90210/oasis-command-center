/**
 * manifest-records-deactivated-assignee.test.ts — the generic manifest records
 * API can never hand a NEW record to a deactivated teammate, or to someone who
 * is not on the team.
 *
 * Outside OASIS sales leads (which resolve owners against the assignment
 * roster), both writes stored the owner verbatim:
 *
 *   POST  /api/manifest/<slug>/records/<entity>        data.assigned_to
 *   PATCH /api/manifest/<slug>/records/<entity>?id=    patch.assigned_to
 *
 * so an admin could assign a SunBiz lead or application to a retired rep
 * through the API although every UI picker is active-only. Now a NEW owner
 * must be an ACTIVE member: deactivated → 422 member_deactivated, not a member
 * → 400 not_a_tenant_member, a failed standing read → 503 member_check_failed.
 * Re-saving a record a deactivated teammate already owns (no assigned_to, or
 * the same one) keeps working, and an active owner saves exactly as before.
 * The OASIS structured-lead path is untouched and stays pinned by
 * tests/oasis-create-stage-contract.test.ts.
 *
 * Driven for real against a local libSQL database: the real session check,
 * profile resolution, tenant gate and data layer. The only stand-in is the
 * request cookie jar (next/headers), as in tests/leads-import-deactivated-owner.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/manifest-records-deactivated-assignee.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "manifest-records-deactivated-assignee-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "manifest-records-deactivated-assignee-secret-long-01";

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
const ADMIN = "1c1c1c1c-0000-4000-8000-000000000001";
const AGENT = "1c1c1c1c-0000-4000-8000-000000000002";
const AGENT_TWO = "1c1c1c1c-0000-4000-8000-000000000003";
const RETIRED = "1c1c1c1c-0000-4000-8000-000000000004";
const DUPLICATE = "1c1c1c1c-0000-4000-8000-000000000005";
const STRANGER = "1c1c1c1c-0000-4000-8000-000000000006";
const RETIRED_AT = "2026-09-24T12:00:00Z";

const LEAD_RETIRED_OWNED = "7c7c7c7c-0000-4000-8000-000000000001";
const LEAD_AGENT_OWNED = "7c7c7c7c-0000-4000-8000-000000000002";
const APP_AGENT_OWNED = "7c7c7c7c-0000-4000-8000-000000000003";
const LEAD_TO_CLEAR = "7c7c7c7c-0000-4000-8000-000000000004";
const MISSING = "7c7c7c7c-0000-4000-8000-0000000000ff";

type ApiBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  fields?: string[];
  record?: { id: string; data: Record<string, unknown> };
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
  console.log("manifest-records-deactivated-assignee:");
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
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT,
      correlation_id TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE forms (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, enabled INTEGER DEFAULT 1, created_at TEXT);
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
  const record = (id: string, entity: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)",
    args: [id, TENANT, entity, JSON.stringify(data)],
  });
  await seed.batch(
    [
      ...[
        [ADMIN, "admin@sun.test"],
        [AGENT, "agent@sun.test"],
        [AGENT_TWO, "agent2@sun.test"],
        [RETIRED, "retired@sun.test"],
        [DUPLICATE, "dup@sun.test"],
        [STRANGER, "stranger@elsewhere.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-admin", ADMIN, "admin@sun.test", TENANT, "admin"),
      profile("p-agent", AGENT, "agent@sun.test", TENANT, "agent"),
      profile("p-agent-two", AGENT_TWO, "agent2@sun.test", TENANT, "agent"),
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
      // History: a deal the retired rep worked keeps its owner.
      record(LEAD_RETIRED_OWNED, "lead", { name: "Retired Rep Deal", assigned_to: RETIRED, notes: "old" }),
      record(LEAD_AGENT_OWNED, "lead", { name: "Agent Deal", assigned_to: AGENT }),
      record(APP_AGENT_OWNED, "application", { business_name: "Agent Application", assigned_to: AGENT }),
      record(LEAD_TO_CLEAR, "lead", { name: "Clear Me", assigned_to: AGENT }),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const { MEMBER_DEACTIVATED_MESSAGE } = await import("../lib/team");
  const records = await import("../app/api/manifest/[slug]/records/[entity]/route");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@sun.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  const post = async (entity: string, data: Record<string, unknown>) => {
    const req = new NextRequest(`http://localhost/api/manifest/sun/records/${entity}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const res = await records.POST(req, { params: Promise.resolve({ slug: "sun", entity }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const patch = async (entity: string, id: string, body: Record<string, unknown>) => {
    const req = new NextRequest(`http://localhost/api/manifest/sun/records/${entity}?id=${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: body }),
    });
    const res = await records.PATCH(req, { params: Promise.resolve({ slug: "sun", entity }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const recordCount = async () =>
    Number((await seed.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_records WHERE tenant_id = ?", args: [TENANT] })).rows[0].n);
  const stored = async (id: string) => {
    const r = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] });
    assert.equal(r.rows.length, 1, `record ${id} is not in the database`);
    return JSON.parse(String(r.rows[0].data)) as Record<string, unknown>;
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
  const standingReadOffline = async <T>(fn: () => Promise<T>): Promise<T> => {
    // Session and profile resolution never select this column; memberStanding does.
    await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason TO deactivation_reason_offline");
    try {
      return await quietly(fn);
    } finally {
      await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason_offline TO deactivation_reason");
    }
  };

  // ── POST ────────────────────────────────────────────────────────────────
  await check("POST: an ACTIVE owner is stored exactly as sent", async () => {
    const res = await post("lead", { name: "Active Owner Lead", assigned_to: AGENT });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.record?.data.assigned_to, AGENT);
    assert.equal((await stored(res.body.record!.id)).assigned_to, AGENT);

    const app = await post("application", { business_name: "Active Owner App", assigned_to: AGENT_TWO });
    assert.equal(app.status, 200, JSON.stringify(app.body));
    assert.equal((await stored(app.body.record!.id)).assigned_to, AGENT_TWO);
  });

  await check("POST: no owner, or an empty one, saves as before", async () => {
    for (const data of [{ name: "Unowned" }, { name: "Blank owner", assigned_to: "" }, { name: "Null owner", assigned_to: null }]) {
      const res = await post("lead", data);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await stored(res.body.record!.id)).assigned_to, (data as { assigned_to?: unknown }).assigned_to);
    }
  });

  await check("POST: a person with a live row here is active despite a retired duplicate", async () => {
    const res = await post("lead", { name: "Duplicate Owner Lead", assigned_to: DUPLICATE });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await stored(res.body.record!.id)).assigned_to, DUPLICATE);
  });

  await check("POST: a DEACTIVATED owner is refused (422 member_deactivated), nothing written", async () => {
    const before = await recordCount();
    // RETIRED is still active on another tenant: standing here is what counts.
    for (const entity of ["lead", "application"]) {
      for (const retired of [RETIRED, RETIRED.toUpperCase(), `  ${RETIRED} `]) {
        const res = await post(entity, { name: "New Work", assigned_to: retired });
        assert.equal(res.status, 422, `${entity} ${retired}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.error, "member_deactivated");
        assert.equal(res.body.message, MEMBER_DEACTIVATED_MESSAGE);
        assert.deepEqual(res.body.fields, ["assigned_to"]);
      }
    }
    assert.equal(await recordCount(), before, "a retired rep was handed a new record");
  });

  await check("POST: an owner who is not on this tenant is refused (400 not_a_tenant_member)", async () => {
    const before = await recordCount();
    for (const stranger of [STRANGER, "stranger@elsewhere.test", "Mike Reyes"]) {
      const res = await post("lead", { name: "Stranger Work", assigned_to: stranger });
      assert.equal(res.status, 400, `${stranger}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "not_a_tenant_member");
      assert.equal(typeof res.body.message, "string");
    }
    assert.equal(await recordCount(), before);
  });

  await check("POST: a FAILED standing read refuses (503 member_check_failed), nothing written", async () => {
    const before = await recordCount();
    const res = await standingReadOffline(() => post("lead", { name: "Unverified", assigned_to: AGENT }));
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "member_check_failed");
    assert.equal(await recordCount(), before, "an unverified owner was handed a new record");
  });

  // ── PATCH ───────────────────────────────────────────────────────────────
  await check("PATCH: re-saving a record a deactivated teammate owns, without assigned_to, still saves", async () => {
    const res = await patch("lead", LEAD_RETIRED_OWNED, { notes: "follow-up logged" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = await stored(LEAD_RETIRED_OWNED);
    assert.equal(data.notes, "follow-up logged");
    assert.equal(data.assigned_to, RETIRED, "history must keep its owner");
  });

  await check("PATCH: re-sending the SAME deactivated owner still saves", async () => {
    for (const same of [RETIRED, RETIRED.toUpperCase(), ` ${RETIRED} `]) {
      const res = await patch("lead", LEAD_RETIRED_OWNED, { assigned_to: same, notes: `re-save ${same.length}` });
      assert.equal(res.status, 200, `${same}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await stored(LEAD_RETIRED_OWNED)).notes, `re-save ${RETIRED.length + 2}`);
  });

  await check("PATCH: handing a record to a DEACTIVATED teammate is refused (422), nothing changes", async () => {
    for (const [entity, id] of [["lead", LEAD_AGENT_OWNED], ["application", APP_AGENT_OWNED]] as const) {
      for (const retired of [RETIRED, RETIRED.toUpperCase()]) {
        const res = await patch(entity, id, { assigned_to: retired, notes: "handed over" });
        assert.equal(res.status, 422, `${entity} ${retired}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, "member_deactivated");
        assert.equal(res.body.message, MEMBER_DEACTIVATED_MESSAGE);
        const data = await stored(id);
        assert.equal(data.assigned_to, AGENT);
        assert.equal(data.notes, undefined, "a refused patch wrote its other fields");
      }
    }
  });

  await check("PATCH: a non-member new owner is refused (400 not_a_tenant_member), nothing changes", async () => {
    for (const stranger of [STRANGER, "Mike Reyes"]) {
      const res = await patch("lead", LEAD_AGENT_OWNED, { assigned_to: stranger });
      assert.equal(res.status, 400, `${stranger}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "not_a_tenant_member");
    }
    assert.equal((await stored(LEAD_AGENT_OWNED)).assigned_to, AGENT);
  });

  await check("PATCH: a FAILED standing read refuses a changed owner (503) but not a re-save", async () => {
    const refused = await standingReadOffline(() => patch("lead", LEAD_AGENT_OWNED, { assigned_to: AGENT_TWO }));
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "member_check_failed");
    assert.equal((await stored(LEAD_AGENT_OWNED)).assigned_to, AGENT);

    const resave = await standingReadOffline(() =>
      patch("lead", LEAD_RETIRED_OWNED, { assigned_to: RETIRED, notes: "offline re-save" }),
    );
    assert.equal(resave.status, 200, JSON.stringify(resave.body));
    assert.equal((await stored(LEAD_RETIRED_OWNED)).notes, "offline re-save");
  });

  await check("PATCH: an ACTIVE new owner saves exactly as before", async () => {
    const res = await patch("lead", LEAD_AGENT_OWNED, { assigned_to: AGENT_TWO });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.record?.data.assigned_to, AGENT_TWO);
    assert.equal((await stored(LEAD_AGENT_OWNED)).assigned_to, AGENT_TWO);
  });

  await check("PATCH: clearing the owner needs no check", async () => {
    for (const cleared of ["", null]) {
      const res = await patch("lead", LEAD_TO_CLEAR, { assigned_to: cleared });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await stored(LEAD_TO_CLEAR)).assigned_to, cleared);
    }
  });

  await check("PATCH: a missing record is still 404 not_found", async () => {
    const res = await patch("lead", MISSING, { assigned_to: RETIRED });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_found");
  });

  if (failures > 0) {
    console.log(`manifest-records-deactivated-assignee: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("manifest-records-deactivated-assignee: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
