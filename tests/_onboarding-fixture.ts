/**
 * tests/_onboarding-fixture.ts - shared real-libSQL fixture for the onboarding
 * and provisioning tests (invite-redeem, onboarding-wizard-authz,
 * middleware-turso-onboarding, admin-installs).
 *
 * Call `setupOnboardingEnv(name)` FIRST, before importing any app module: it
 * points the Turso adapter at a fresh temp file, turns on Turso auth with a
 * test secret, and stands in next/headers + next/navigation (the same way
 * tests/os-approvals.test.ts does) so routes and pages run outside Next.
 *
 * The schema is the production DDL for the columns these flows touch
 * (scratchpad audit schema_prod.json, 2026-09-29), including the NOT NULL
 * columns and the one-owner-per-workspace unique index, so a write the real
 * database would refuse is refused here too.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import type { Client } from "@libsql/client";

export const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // slug oasis-ai-cc
export const SECRET = "onboarding-tests-secret-that-is-long-enough-000001";

let sessionCookie: string | undefined;

export function setSessionCookie(value: string | undefined): void {
  sessionCookie = value;
}

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

export function setupOnboardingEnv(name: string): { dbFile: string } {
  const dbFile = join(mkdtempSync(join(tmpdir(), `${name}-`)), "test.db");
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
  process.env.TURSO_DB_PATH = dbFile;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_DB_URL;
  process.env.EMPIRE_AUTH_BACKEND = "turso";
  process.env.AUTH_SESSION_SECRET = SECRET;
  process.env.FOUNDERS_TENANT_IDS = OASIS;
  // No mail can leave a test: the auth mailer reports "not configured".
  for (const k of ["AUTH_SMTP_HOST", "AUTH_SMTP_USER", "AUTH_SMTP_PASS", "AUTH_SMTP_PASSWORD", "AUTH_EMAIL_FROM"]) delete process.env[k];
  (globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
  stub("next/headers", {
    cookies: async () => ({
      get: (n: string) => (n === "oasis_session" && sessionCookie ? { name: n, value: sessionCookie } : undefined),
      getAll: () => (sessionCookie ? [{ name: "oasis_session", value: sessionCookie }] : []),
      has: (n: string) => n === "oasis_session" && Boolean(sessionCookie),
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
      const err = new Error(`NEXT_REDIRECT;${url}`) as Error & { digest: string };
      err.digest = `NEXT_REDIRECT;replace;${url};307;`;
      throw err;
    },
    useRouter: () => {
      throw new Error("client hook called under react-server");
    },
  });
  const linkPath = require.resolve("next/link");
  require.cache[linkPath] = {
    id: linkPath,
    filename: linkPath,
    path: dirname(linkPath),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      __esModule: true,
      default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: ReactNS.ReactNode }) =>
        ReactNS.createElement("a", { href, ...rest }, children),
    },
  } as unknown as NodeModule;
  return { dbFile };
}

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
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

const NOW_ISO = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** Production DDL (the columns these flows touch). tenant_invites WITHOUT `kind`. */
export async function createBaseSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE tenants (
      id TEXT NOT NULL PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
      plan_tier TEXT NOT NULL DEFAULT 'starter', purchase_status TEXT NOT NULL DEFAULT 'pending',
      custom_fields TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO}, updated_at TEXT NOT NULL DEFAULT ${NOW_ISO});
    CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);
    CREATE TABLE user_profiles (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      auth_user_id TEXT, email TEXT NOT NULL, full_name TEXT NOT NULL, display_name TEXT,
      brand TEXT NOT NULL DEFAULT 'OASIS AI', role TEXT NOT NULL DEFAULT 'operator',
      agents_enabled TEXT NOT NULL, primary_agent TEXT NOT NULL DEFAULT 'bravo',
      custom_fields TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO}, updated_at TEXT NOT NULL DEFAULT ${NOW_ISO},
      tenant_id TEXT, prospect_focus TEXT NOT NULL, onboarding_completed_at TEXT,
      team_role TEXT NOT NULL DEFAULT 'member', is_owner INTEGER NOT NULL DEFAULT 0, invited_by TEXT,
      joined_at TEXT NOT NULL DEFAULT ${NOW_ISO}, admin_access INTEGER NOT NULL DEFAULT 0,
      manager_user_id TEXT, deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE UNIQUE INDEX user_profiles_auth_user_id_key ON user_profiles (auth_user_id);
    CREATE UNIQUE INDEX user_profiles_email_key ON user_profiles (email);
    CREATE UNIQUE INDEX user_profiles_one_owner_per_tenant ON user_profiles (tenant_id) WHERE (is_owner = true);
    CREATE TABLE tenant_invites (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, email TEXT, team_role TEXT NOT NULL DEFAULT 'member',
      token_hash TEXT NOT NULL, created_by TEXT NOT NULL, expires_at TEXT NOT NULL,
      redeemed_at TEXT, redeemed_by TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO});
    CREATE UNIQUE INDEX tenant_invites_token_hash_key ON tenant_invites (token_hash);
    CREATE TABLE tenant_manifests (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT, slug TEXT NOT NULL, manifest TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO}, updated_at TEXT NOT NULL DEFAULT ${NOW_ISO});
    CREATE UNIQUE INDEX tenant_manifests_slug_key ON tenant_manifests (slug);
    CREATE UNIQUE INDEX tenant_manifests_tenant_id_key ON tenant_manifests (tenant_id);
    CREATE TABLE manifest_audit_log (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      manifest_id TEXT, tenant_id TEXT, actor_type TEXT NOT NULL, actor_id TEXT,
      diff TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL DEFAULT ${NOW_ISO});
    CREATE TABLE tenant_audit_log (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, actor_user_id TEXT, actor_email TEXT, action_type TEXT NOT NULL,
      target_table TEXT, target_id TEXT, before TEXT, after TEXT, ip_hash TEXT, user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT ${NOW_ISO});
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT, encrypted_password TEXT, raw_user_meta_data TEXT,
      created_at TEXT, updated_at TEXT, banned_until TEXT, deleted_at TEXT,
      session_version INTEGER NOT NULL DEFAULT 0);
  `);
}

/** Apply database/turso/bravo__196 exactly as the migration runner splits it. */
export async function applyMigration196(db: Client): Promise<void> {
  const sql = readFileSync(join(process.cwd(), "database", "turso", "bravo__196_owner_claim_invites.sql"), "utf8");
  for (const stmt of splitStatements(sql)) await db.execute(stmt);
}

export type SeedUser = { id: string; email: string; name: string };

export async function seedAuthUser(db: Client, u: SeedUser): Promise<void> {
  await db.execute({
    sql: `INSERT INTO "_supabase_auth_users" (id, email, raw_user_meta_data, created_at, updated_at, session_version)
          VALUES (?, ?, ?, ?, ?, 0)`,
    args: [u.id, u.email, JSON.stringify({ full_name: u.name }), new Date().toISOString(), new Date().toISOString()],
  });
}

export async function seedTenant(db: Client, id: string, slug: string, name: string): Promise<void> {
  await db.execute({ sql: `INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)`, args: [id, slug, name] });
}

export async function seedProfile(
  db: Client,
  u: SeedUser,
  tenantId: string | null,
  opts: { role?: string; owner?: boolean; onboarded?: boolean; invitedBy?: string | null; agents?: string[] } = {},
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, tenant_id, team_role, is_owner,
            onboarding_completed_at, invited_by, agents_enabled, primary_agent, prospect_focus)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '["service_trades"]')`,
    args: [
      `p-${u.id.slice(-6)}`,
      u.id,
      u.email,
      u.name,
      tenantId,
      opts.role ?? "member",
      opts.owner ? 1 : 0,
      opts.onboarded ? new Date().toISOString() : null,
      opts.invitedBy ?? null,
      JSON.stringify(opts.agents ?? []),
      opts.agents?.[0] ?? "",
    ],
  });
}

export async function signFor(u: SeedUser, onb?: "done" | "wizard" | "welcome"): Promise<string> {
  const { signSession } = await import("../lib/turso-auth");
  return signSession({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0, ...(onb ? { onb } : {}) });
}

/** Decode (without verifying) the payload of a session cookie a route set. */
export function sessionPayloadFromSetCookie(res: Response): Record<string, unknown> | null {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/oasis_session=([^;]+)/);
  if (!m) return null;
  const body = m[1].slice(0, m[1].lastIndexOf("."));
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

let failures = 0;
let passed = 0;
export async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

export function finish(label: string): void {
  console.log(`${label}: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}
