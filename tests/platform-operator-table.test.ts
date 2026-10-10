/**
 * platform-operator-table.test.ts — a founder without an operator alias is an
 * operator when his AUTH USER ID is listed in platform_operators (P0-7 durable,
 * 2026-10-10).
 *
 * WHY. Adon and CC own OASIS equally. CC's email is the hardcoded alias, so CC
 * had the operator console (the shield: Automations, AI brain accounts, coding
 * harness, fleet, runs, inbox); Adon held an admin seat with no alias and had
 * none of it. The fix lists operators by auth user id in a table, never by an
 * email a stranger could register, and keeps the founder-seat half unchanged.
 *
 * WHAT IS PINNED.
 *   - the listed founder is an operator; revoked, non-founder and
 *     founder-elsewhere rows are not;
 *   - the alias path is unchanged (CC needs no row);
 *   - the COST rule: an account off the operators' domain never reads the
 *     table (proved by taking the table away: the answer does not change);
 *   - fail closed: an unreadable table refuses the listed founder, loudly,
 *     and leaves the alias untouched;
 *   - the migration file itself creates the table and is safe to re-run;
 *   - nothing in app/lib/components/workers writes the table.
 *
 * Run: node --conditions=react-server --import tsx tests/platform-operator-table.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "platform-operator-table-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "platform-operator-table-secret-long-enough-0001";
// conaugh@oasisai.work is the hardcoded default alias; nothing else is an alias here.
delete process.env.OPERATOR_EMAIL;
delete process.env.ADMIN_EMAILS;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "11111111-2222-3333-4444-555555555555";
const U = {
  cc: { id: "auth-cc", email: "conaugh@oasisai.work" }, // alias, OASIS owner, NOT listed
  adon: { id: "auth-adon", email: "adon@oasisai.work" }, // admin seat, listed
  revoked: { id: "auth-revoked", email: "former@oasisai.work" }, // admin seat, listed then revoked
  member: { id: "auth-member", email: "rep@oasisai.work" }, // member seat in OASIS, listed
  elsewhere: { id: "auth-elsewhere", email: "founder@oasisai.work" }, // owns OTHER only, listed
  unlisted: { id: "auth-unlisted", email: "staff@oasisai.work" }, // admin seat, not listed
  offdomain: { id: "auth-offdomain", email: "partner@client.test" }, // admin seat, listed, wrong domain
} as const;

async function setup() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, updated_at TEXT, deactivated_at TEXT);
  `);
  // The real migration, run twice: it must create the table and be safe to re-run.
  const migration = readFileSync(join(ROOT, "database/turso/bravo__208_platform_operators.sql"), "utf8");
  await db.executeMultiple(migration);
  await db.executeMultiple(migration);
  const stamp = "2026-10-10T00:00:00Z";
  const seat = (id: string, u: { id: string; email: string }, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    args: [id, u.id, u.email, tenant, role, owner, stamp, stamp],
  });
  const listed = (u: { id: string }, revokedAt: string | null = null) => ({
    sql: "INSERT INTO platform_operators (auth_user_id, added_by, added_at, note, revoked_at) VALUES (?, 'test', ?, 'fixture', ?)",
    args: [u.id, stamp, revokedAt],
  });
  await db.batch(
    [
      seat("p-cc", U.cc, OASIS, "owner", 1),
      seat("p-adon", U.adon, OASIS, "admin", 0),
      seat("p-revoked", U.revoked, OASIS, "admin", 0),
      seat("p-member", U.member, OASIS, "member", 0),
      seat("p-elsewhere", U.elsewhere, OTHER, "owner", 1),
      seat("p-unlisted", U.unlisted, OASIS, "admin", 0),
      seat("p-offdomain", U.offdomain, OASIS, "admin", 0),
      listed(U.adon),
      listed(U.revoked, "2026-10-10T01:00:00Z"),
      listed(U.member),
      listed(U.elsewhere),
      listed(U.offdomain),
    ],
    "write",
  );
  return db;
}

async function captureErrors<T>(run: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), logged };
  } finally {
    console.error = original;
  }
}

async function main() {
  const db = await setup();
  const op = await import("../lib/platform-operator");
  const verdict = (u: { id: string; email: string }) => op.resolvePlatformOperatorForAuthUser(u.id, u.email);

  console.log("platform-operator-table:");
  await check("the listed OASIS founder (admin seat, no alias) is an operator", async () => {
    assert.deepEqual(await verdict(U.adon), { operator: true, userId: U.adon.id });
  });
  await check("the alias path is unchanged: CC needs no row", async () => {
    assert.deepEqual(await verdict(U.cc), { operator: true, userId: U.cc.id });
  });
  await check("a revoked row grants nothing", async () => {
    assert.deepEqual(await verdict(U.revoked), { operator: false, reason: "not_operator_email" });
  });
  await check("a listed member seat is not a founder, so not an operator", async () => {
    assert.deepEqual(await verdict(U.member), { operator: false, reason: "not_operator_email" });
  });
  await check("a listed founder of ANOTHER workspace only is not an operator", async () => {
    assert.deepEqual(await verdict(U.elsewhere), { operator: false, reason: "not_operator_email" });
  });
  await check("an unlisted OASIS admin is not an operator", async () => {
    assert.deepEqual(await verdict(U.unlisted), { operator: false, reason: "not_operator_email" });
  });
  await check("no session is refused before anything is read", async () => {
    assert.deepEqual(await op.resolvePlatformOperatorForAuthUser(null, U.adon.email), { operator: false, reason: "no_session" });
  });

  await db.execute("ALTER TABLE platform_operators RENAME TO platform_operators_offline");
  try {
    await check("cost rule: an account off the operators' domain never reads the table", async () => {
      // A listed row exists for this auth id, but the email is off-domain. With
      // the table gone, a read would fail loudly; the answer must not change.
      const { value, logged } = await captureErrors(() => verdict(U.offdomain));
      assert.deepEqual(value, { operator: false, reason: "not_operator_email" });
      assert.equal(logged.length, 0, `no read may be attempted, got: ${logged.join(" | ")}`);
    });
    await check("fail closed: an unreadable table refuses the listed founder, and says so", async () => {
      const { value, logged } = await captureErrors(() => verdict(U.adon));
      assert.deepEqual(value, { operator: false, reason: "lookup_failed" });
      assert.ok(logged.some((l) => l.includes("[role-surfaces.platform_operator.listed]")), "the failure must be logged");
    });
    await check("an unreadable table does not touch the alias path", async () => {
      assert.deepEqual(await verdict(U.cc), { operator: true, userId: U.cc.id });
    });
  } finally {
    await db.execute("ALTER TABLE platform_operators_offline RENAME TO platform_operators");
  }

  await check("nothing in app/lib/components/workers writes platform_operators", () => {
    const writes: string[] = [];
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === "node_modules" || name === ".next" || name === ".open-next") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          const src = readFileSync(full, "utf8");
          const touches = /platform_operators/.test(src);
          const writesIt =
            /from\(\s*["']platform_operators["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/.test(src) ||
            /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+platform_operators\b/i.test(src);
          if (touches && writesIt) writes.push(full.slice(ROOT.length + 1).split(sep).join("/"));
        }
      }
    };
    for (const d of ["app", "lib", "components", "workers"]) walk(join(ROOT, d));
    assert.deepEqual(writes, [], "operator rows are added and revoked by hand, never by product code");
  });

  await check("the /api/pg bridge refuses platform_operators to every bearer", () => {
    const route = readFileSync(join(ROOT, "app/api/pg/rest/v1/[...path]/route.ts"), "utf8");
    const set = /const FORBIDDEN_TABLES = new Set\(\[([\s\S]*?)\]\);/.exec(route);
    assert.ok(set, "FORBIDDEN_TABLES not found in the bridge route");
    assert.match(set![1], /^\s*"platform_operators",/m, "a leaked bridge bearer must not be able to write itself into operator power");
  });

  if (failures > 0) {
    console.log(`platform-operator-table: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("platform-operator-table: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
