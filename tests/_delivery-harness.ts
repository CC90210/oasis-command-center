/**
 * Shared harness for tests/delivery-*.test.ts.
 *
 * A throwaway local libSQL file with the REAL migration 183 applied on top of
 * the prerequisite tables it builds on (tenants, forms, form_submissions,
 * user_profiles, tenant_records — shapes copied from the live schema), plus
 * the same next/headers stand-in and signed-session login that
 * tests/find-existing-lead-phone.test.ts uses. Route handlers run for real:
 * real session resolution, real persona, real SQL.
 *
 * IMPORT THIS FIRST. It sets the env the data layer reads before any app
 * module is loaded; tests load app modules with dynamic import() after it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

export const dbFile = join(mkdtempSync(join(tmpdir(), "delivery-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "delivery-harness-session-secret-that-is-long-enough-0001";
// Never let a test reach a real channel, whatever the developer's shell holds.
for (const k of [
  "OASIS_TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "OASIS_TELEGRAM_CHAT_ID",
  "TELEGRAM_CHAT_ID",
  "OASIS_MAIL_FROM",
  "OASIS_MAIL_APP_PASSWORD",
  "R2_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
]) {
  delete process.env[k];
}

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

// lib/role-surfaces-session.ts imports notFound from next/navigation, whose
// real module pulls the client router context (React.createContext), which
// does not exist under the react-server condition these tests run with. The
// server helpers are all that is needed here, and they throw exactly as Next's do.
const navigationPath = require.resolve("next/navigation");
require.cache[navigationPath] = {
  id: navigationPath,
  filename: navigationPath,
  path: dirname(navigationPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    notFound: () => {
      throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    },
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT;${url}`);
    },
  },
} as unknown as NodeModule;

export const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
export const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const CLIENT_B = "bbbbbbbb-0000-4000-8000-00000000000b";

export const USERS = {
  cc: { id: "0d000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" },
  adon: { id: "0d000000-0000-4000-8000-000000000002", email: "adon@oasisai.work" },
  rep: { id: "0d000000-0000-4000-8000-000000000003", email: "david@oasisai.work" },
  gone: { id: "0d000000-0000-4000-8000-000000000004", email: "former@oasisai.work" },
  clientA: { id: "0d000000-0000-4000-8000-00000000000a", email: "owner@client-a.test" },
  clientB: { id: "0d000000-0000-4000-8000-00000000000b", email: "owner@client-b.test" },
} as const;

/** Split a migration the way scripts/apply_turso_migration.py does (no triggers here). */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    buf.push(line);
    if (t.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, ""));
      buf = [];
    }
  }
  if (buf.join("").trim()) out.push(buf.join("\n").trim());
  return out;
}

export const MIGRATION_PATH = join(__dirname, "..", "database", "turso", "183_delivery_and_support.turso.sql");

const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const UUID_SQL =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))";

export async function setupDatabase(): Promise<Client> {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, invited_by TEXT,
      joined_at TEXT, manager_user_id TEXT, updated_at TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, logo_url TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE forms (
      id TEXT NOT NULL DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW_SQL}, updated_at TEXT NOT NULL DEFAULT ${NOW_SQL},
      PRIMARY KEY (id));
    CREATE TABLE form_submissions (
      id TEXT NOT NULL DEFAULT ${UUID_SQL}, form_id TEXT NOT NULL, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '{}',
      file_attachments TEXT NOT NULL DEFAULT '[]', ip_address TEXT, user_agent TEXT,
      submitted_at TEXT NOT NULL DEFAULT ${NOW_SQL}, PRIMARY KEY (id));
    CREATE TABLE email_suppressions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, email TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT, agent_source TEXT,
      subject TEXT, content TEXT, content_preview TEXT, to_email TEXT, metadata TEXT,
      created_at TEXT DEFAULT ${NOW_SQL});
  `);
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-a', 'Client A Plumbing')", args: [CLIENT_A] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-b', 'Client B Dental')", args: [CLIENT_B] },
    ],
    "write",
  );
  // The migration itself, statement by statement — it seeds the support form.
  for (const stmt of splitSql(readFileSync(MIGRATION_PATH, "utf8"))) await db.execute(stmt);

  const profile = (u: { id: string; email: string }, tenant: string, role: string, owner = 0, name = "", deactivated: string | null = null) => [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [u.id, u.email] },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at, deactivated_at)
            VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?)`,
      args: [`p-${u.id}`, u.id, u.email, tenant, role, owner, name, deactivated],
    },
  ];
  await db.batch(
    [
      ...profile(USERS.cc, OASIS, "owner", 1, "Conaugh McKenna"),
      ...profile(USERS.adon, OASIS, "admin", 0, "Adon"),
      ...profile(USERS.rep, OASIS, "opener", 0, "David"),
      ...profile(USERS.gone, OASIS, "closer", 0, "Former Rep", "2026-09-20T00:00:00Z"),
      ...profile(USERS.clientA, CLIENT_A, "owner", 1, "Alice Client"),
      ...profile(USERS.clientB, CLIENT_B, "owner", 1, "Bob Client"),
    ],
    "write",
  );
  return db;
}

export async function login(user: { id: string; email: string } | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
export async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 3).join("\n        ")}`);
  }
}

export function finish(label: string): void {
  if (failures) {
    console.log(`${label}: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`${label}: all passed`);
  // Detached after() fallbacks may still hold the event loop; the verdict is in.
  process.exit(0);
}
