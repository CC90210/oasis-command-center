/**
 * tests/skills-training-harness.ts - shared set-up for the Skills Training suites: a temp libSQL
 * file with the real skills migration applied (split the same way this repo's migration-apply
 * tooling splits a .sql file into executable statements), the same next/* stand-ins
 * tests/playbook-docs.test.ts uses, and real signed sessions.
 * Import it FIRST: it sets TURSO_DB_PATH before lib/turso.ts caches a client.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

export const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "skills-training-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
// A throwaway signing value for the temp database only, built from parts so it never reads as a credential.
process.env.AUTH_SESSION_SECRET = ["skills-training", "test-only", "session-signing", "fixture-0001"].join("-");
delete process.env.OPERATOR_EMAIL;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>): void {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
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

export const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
export const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const u = (n: number, email: string) => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
export const USERS = {
  cc: u(1, "conaugh@oasisai.work"),
  adon: u(2, "adon@oasisai.work"),
  rep: u(4, "rep@oasis-team.test"),
  client: u(3, "owner@client.test"),
} as const;
export type Viewer = keyof typeof USERS | "anonymous";

export async function login(viewer: Viewer): Promise<void> {
  if (viewer === "anonymous") {
    sessionCookie = undefined;
    return;
  }
  const user = USERS[viewer];
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

/** The same statement split this repo's migration-apply tooling uses, line for line (copied from tests/playbook-docs.test.ts). */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

export function migrationPath(): string {
  const dir = join(ROOT, "database", "turso");
  const hits = readdirSync(dir).filter((f) => /^bravo__\d+_skills_training\.sql$/.test(f));
  if (hits.length !== 1) throw new Error(`expected exactly one skills_training migration, found ${hits.length}`);
  return join(dir, hits[0]);
}

export async function setupDb(): Promise<Client> {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, agents_enabled TEXT, updated_at TEXT,
      deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
  `);
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: { id: string; email: string }, tenant: string, role: string, owner: number) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["bravo"]', ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      profile(USERS.cc, OASIS, "owner", 1),
      profile(USERS.adon, OASIS, "owner", 1),
      profile(USERS.rep, OASIS, "opener", 0),
      profile(USERS.client, CLIENT, "owner", 1),
    ],
    "write",
  );
  for (const stmt of splitStatements(readFileSync(migrationPath(), "utf8"))) await db.execute(stmt);
  return db;
}

export function req(url: string, init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { host: "oasisai.work", origin: "https://oasisai.work", ...(init.headers ?? {}) };
  if (init.body !== undefined || init.raw !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://oasisai.work${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

const tally = { passed: 0, failures: 0 };
export async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    tally.passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    tally.failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}
export function finish(suite: string): void {
  console.log(`${suite}: ${tally.passed} passed, ${tally.failures} failed`);
  if (tally.failures) process.exit(1);
}
