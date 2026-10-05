/**
 * POST /api/auth/provision-cli must not report a profile it did not claim.
 * Run: node --conditions=react-server --import tsx tests/provision-cli-relink.test.ts
 *
 * WHY. The setup-wizard route relinks a profile found by email only while its
 * auth_user_id is NULL, and the write re-asserts that (`.is("auth_user_id",
 * null)`) so a concurrent claim cannot be overwritten. But the route never read
 * how many rows the guarded UPDATE changed. When another account claimed the
 * row between the route's read and its write, the UPDATE matched nothing,
 * returned no error, and the route answered `ok: true` with that profile's id
 * and tenant, then went on to edit the profile's agents_enabled. The account it
 * reported linked was not the account that owned the row (CodeRabbit on #465;
 * lib/auth-provisioning.ts already refuses the same case with a 409).
 *
 * What this pins, through the route itself and the production PostgREST
 * adapter over a real libSQL file:
 *   - an unclaimed row is claimed and reported (the path still works);
 *   - a row claimed by another account between the read and the write is a
 *     409 profile_owned_by_another_account, carries no profile or tenant id,
 *     and the route touches nothing else on that profile;
 *   - a row another account already owns is refused before any write.
 *
 * Stand-in: lib/supabase-server. Its `from()` is the real Turso adapter; its
 * `auth.admin` answers the one lookup the route makes and fails loudly on
 * anything else, so the test can never reach Supabase.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { NextRequest } from "next/server";
import { createTursoPostgrest } from "../lib/turso-postgrest";

const SECRET = "provision-cli-relink-test-secret-0001";
process.env.CLI_SIGNUP_SECRET = SECRET;

const EMAIL = "owner@relink.test";
const AUTH_ME = "auth-me";
const AUTH_OTHER = "auth-other";
const TENANT = "tenant-relink";

const dbFile = join(mkdtempSync(join(tmpdir(), "provision-cli-relink-")), "test.db");
const raw: Client = createClient({ url: `file:${dbFile}` });

// ── The race: another account claims the row just before the route's write ──
// Armed per test. Fires once, on the route's guarded relink UPDATE, and runs
// the competing claim on the same database first, so the route's read saw an
// unclaimed row but its write finds it owned.
let raceClaimBy: string | null = null;
let raceFired = false;
let relinkWrites = 0;
const RELINK_UPDATE = /^UPDATE "user_profiles" SET "auth_user_id" = \?/;

function sqlOf(stmt: InStatement): string {
  return typeof stmt === "string" ? stmt : stmt.sql;
}

const racing = new Proxy(raw, {
  get(target, prop, receiver) {
    if (prop === "execute") {
      return async (stmt: InStatement) => {
        if (RELINK_UPDATE.test(sqlOf(stmt))) {
          relinkWrites += 1;
          if (raceClaimBy) {
            const who = raceClaimBy;
            raceClaimBy = null;
            raceFired = true;
            await target.execute({
              sql: "UPDATE user_profiles SET auth_user_id = ? WHERE email = ?",
              args: [who, EMAIL],
            });
          }
        }
        return target.execute(stmt);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Client;

const pg = createTursoPostgrest(racing);

function refuse(what: string): never {
  throw new Error(`provision-cli test: the route called ${what}, which this test does not expect`);
}

const serviceDb = {
  from: (table: string) => pg.from(table),
  rpc: (name: string) => refuse(`rpc("${name}")`),
  auth: {
    admin: {
      // The route's only auth call: the operator's auth account already exists.
      listUsers: async () => ({ data: { users: [{ id: AUTH_ME, email: EMAIL }] }, error: null }),
      createUser: () => refuse("auth.admin.createUser"),
      inviteUserByEmail: () => refuse("auth.admin.inviteUserByEmail"),
    },
  },
};

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

stubModule(require.resolve("../lib/supabase-server"), {
  getServiceSupabase: () => serviceDb,
  getSessionUser: async () => null,
});

async function resetProfile(authUserId: string | null) {
  await raw.execute("DELETE FROM user_profiles");
  await raw.execute({
    sql: `INSERT INTO user_profiles (id, tenant_id, auth_user_id, email, agents_enabled)
          VALUES ('profile-1', ?, ?, ?, NULL)`,
    args: [TENANT, authUserId, EMAIL],
  });
  raceClaimBy = null;
  raceFired = false;
  relinkWrites = 0;
}

async function profileRow() {
  const r = await raw.execute("SELECT auth_user_id, agents_enabled FROM user_profiles WHERE id = 'profile-1'");
  return r.rows[0] as unknown as { auth_user_id: string | null; agents_enabled: string | null };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/auth/provision-cli", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}

async function main() {
  await raw.execute(`CREATE TABLE user_profiles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    auth_user_id TEXT,
    email TEXT NOT NULL,
    agents_enabled TEXT
  )`);

  const { POST } = await import("../app/api/auth/provision-cli/route");

  await check("an unclaimed row is claimed and reported", async () => {
    await resetProfile(null);
    const res = await POST(request({ email: EMAIL }));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.profile_id, "profile-1");
    assert.equal(body.tenant_id, TENANT);
    assert.equal(relinkWrites, 1, "the relink went through the guarded UPDATE");
    assert.equal((await profileRow()).auth_user_id, AUTH_ME);
  });

  await check("a row claimed by another account between the read and the write is a 409, not success", async () => {
    await resetProfile(null);
    raceClaimBy = AUTH_OTHER;
    const res = await POST(request({ email: EMAIL, agent: "atlas" }));
    const body = await res.json();
    assert.equal(raceFired, true, "the competing claim must land between the read and the write, or this proves nothing");
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.ok, false);
    assert.equal(body.error, "profile_owned_by_another_account");
    assert.equal(body.profile_id, undefined, "a refused relink reports no profile");
    assert.equal(body.tenant_id, undefined, "a refused relink reports no tenant");
    const row = await profileRow();
    assert.equal(row.auth_user_id, AUTH_OTHER, "the other account keeps its profile");
    assert.equal(row.agents_enabled, null, "the route stops before editing a profile it does not own");
  });

  await check("a row another account already owns is refused before any write", async () => {
    await resetProfile(AUTH_OTHER);
    const res = await POST(request({ email: EMAIL }));
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.error, "profile_owned_by_another_account");
    assert.equal(relinkWrites, 0, "no relink write is attempted");
    assert.equal((await profileRow()).auth_user_id, AUTH_OTHER);
  });

  if (failures) {
    console.error(`provision-cli-relink: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("provision-cli-relink: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
