/**
 * tests/seat-liveness.test.ts — lib/os/seat.ts liveSeat, the one answer to
 * "is this person still really here" that ping, poll, records and every
 * MCP call share (O3a security rule 6).
 *
 * Pins the three facts liveSeat requires, each failing closed on its own:
 *   1. a user_profiles row for this auth user, IN THE REQUESTED WORKSPACE,
 *      with deactivated_at NULL;
 *   2. the auth user is not banned (a future banned_until) or deleted;
 *   3. when a session_version is passed, it matches the current one.
 * And the resolveOsViewerFor fix this slice makes: a member of two
 * workspaces is resolved IN THE REQUESTED ONE, never refused at random
 * because chooseActiveProfile picked their OTHER workspace's row.
 *
 * Run: node --conditions=react-server --import tsx tests/seat-liveness.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "seat-liveness-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "synthetic-seat-liveness-secret-never-used-outside-tests";
let sessionCookie: string | undefined;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) {
  delete process.env[k];
}
{
  const p = require.resolve("next/headers");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      cookies: async () => ({ get: (name: string) => name === "oasis_session" && sessionCookie ? { value: sessionCookie } : undefined, getAll: () => [], has: () => false, set: () => undefined }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}
{
  const p = require.resolve("next/navigation");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
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
}

const db: Client = createClient({ url: `file:${dbFile}` });

const TENANT_A = "e3e3e3e3-0000-4000-8000-0000000000a1";
const TENANT_B = "e3e3e3e3-0000-4000-8000-0000000000b1";
const stamp = "2026-10-11T00:00:00.000Z";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE tenant_manifests (slug TEXT, tenant_id TEXT, manifest TEXT, updated_at TEXT);
  `);
}

async function seed() {
  sessionCookie = undefined;
  for (const t of ["tenants", "_supabase_auth_users", "user_profiles", "tenant_manifests"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'workspace-a', 'Workspace A')", args: [TENANT_A] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'workspace-b', 'Workspace B')", args: [TENANT_B] },
      // A provisioned manifest row — resolveOsViewerFor treats an
      // unprovisioned workspace differently, but a missing manifest must
      // not be confused with a missing seat.
      {
        sql: "INSERT INTO tenant_manifests (slug, tenant_id, manifest, updated_at) VALUES (?, ?, ?, ?)",
        args: ["workspace-a", TENANT_A, JSON.stringify({ tenant_slug: "workspace-a", brand: { name: "A", subtitle: "s", logo: "oasis", footer_label: "f", footer_tagline: "t" }, agents: [], nav: [] }), stamp],
      },
      {
        sql: "INSERT INTO tenant_manifests (slug, tenant_id, manifest, updated_at) VALUES (?, ?, ?, ?)",
        args: ["workspace-b", TENANT_B, JSON.stringify({ tenant_slug: "workspace-b", brand: { name: "B", subtitle: "s", logo: "oasis", footer_label: "f", footer_tagline: "t" }, agents: [], nav: [] }), stamp],
      },
    ],
    "write",
  );
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await seed();
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  await createSchema();
  const { liveSeat } = await import("../lib/os/seat");
  const { resolveOsViewerFor } = await import("../components/os/department/viewer");

  console.log("seat-liveness:");

  await check("no profile at all: live is false, reason no_profile", async () => {
    const r = await liveSeat(TENANT_A, "auth-nobody");
    assert.deepEqual(r, { live: false, reason: "no_profile" });
  });

  await check("a live, active profile answers with its role flags", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-live', 'live@test')`);
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at)
            VALUES ('p-live', 'auth-live', 'live@test', ?, 'owner', 1, 0, ?)`,
      args: [TENANT_A, stamp],
    });
    const r = await liveSeat(TENANT_A, "auth-live");
    assert.equal(r.live, true);
    if (!r.live) return;
    assert.equal(r.profile.id, "p-live");
    assert.equal(r.profile.teamRole, "owner");
    assert.equal(r.profile.isOwner, true);
    assert.equal(r.profile.adminAccess, false);
  });

  await check(
    "a stale, never-onboarded owner duplicate must NOT outrank a live, onboarded member row for the same person (Codex review)",
    async () => {
      await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-dup-owner', 'dup@test')`);
      // The stale duplicate: is_owner, but never finished onboarding — an
      // abandoned signup, exactly the shape team-activation.ts's own dedup
      // (canonicalizeTenantMembers) already refuses to let outrank a live row.
      await db.execute({
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-dup-stale-owner', 'auth-dup-owner', 'dup@test', ?, 'owner', 1, NULL, '2026-01-01T00:00:00.000Z')`,
        args: [TENANT_A],
      });
      await db.execute({
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-dup-live-member', 'auth-dup-owner', 'dup@test', ?, 'member', 0, ?, ?)`,
        args: [TENANT_A, stamp, stamp],
      });
      const r = await liveSeat(TENANT_A, "auth-dup-owner");
      assert.equal(r.live, true);
      if (!r.live) return;
      assert.equal(r.profile.id, "p-dup-live-member", "the onboarded, live row wins — never the stale owner duplicate");
      assert.equal(r.profile.teamRole, "member");
      assert.equal(r.profile.isOwner, false);
    },
  );

  await check("a profile with deactivated_at set: live is false, reason deactivated", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-gone', 'gone@test')`);
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, deactivated_at)
            VALUES ('p-gone', 'auth-gone', 'gone@test', ?, 'member', ?)`,
      args: [TENANT_A, stamp],
    });
    const r = await liveSeat(TENANT_A, "auth-gone");
    assert.deepEqual(r, { live: false, reason: "deactivated" });
  });

  await check("a banned auth user (banned_until in the future): live is false, reason banned_or_deleted", async () => {
    await db.execute({
      sql: `INSERT INTO "_supabase_auth_users" (id, email, banned_until) VALUES ('auth-banned', 'banned@test', '9999-01-01T00:00:00.000Z')`,
    });
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES ('p-banned', 'auth-banned', 'banned@test', ?, 'member')`,
      args: [TENANT_A],
    });
    const r = await liveSeat(TENANT_A, "auth-banned");
    assert.deepEqual(r, { live: false, reason: "banned_or_deleted" });
  });

  await check("a banned_until in the PAST is not banned anymore", async () => {
    await db.execute({
      sql: `INSERT INTO "_supabase_auth_users" (id, email, banned_until) VALUES ('auth-wasbanned', 'wasbanned@test', '2020-01-01T00:00:00.000Z')`,
    });
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES ('p-wasbanned', 'auth-wasbanned', 'wasbanned@test', ?, 'member')`,
      args: [TENANT_A],
    });
    const r = await liveSeat(TENANT_A, "auth-wasbanned");
    assert.equal(r.live, true);
  });

  await check("a deleted auth user: live is false, reason banned_or_deleted", async () => {
    await db.execute({
      sql: `INSERT INTO "_supabase_auth_users" (id, email, deleted_at) VALUES ('auth-deleted', 'deleted@test', ?)`,
      args: [stamp],
    });
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES ('p-deleted', 'auth-deleted', 'deleted@test', ?, 'member')`,
      args: [TENANT_A],
    });
    const r = await liveSeat(TENANT_A, "auth-deleted");
    assert.deepEqual(r, { live: false, reason: "banned_or_deleted" });
  });

  await check("session_version mismatch: live is false; a matching version is live", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email, session_version) VALUES ('auth-ver', 'ver@test', 3)`);
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES ('p-ver', 'auth-ver', 'ver@test', ?, 'member')`,
      args: [TENANT_A],
    });
    assert.deepEqual(await liveSeat(TENANT_A, "auth-ver", 2), { live: false, reason: "session_version_mismatch" });
    const ok = await liveSeat(TENANT_A, "auth-ver", 3);
    assert.equal(ok.live, true);
  });

  await check("a member of TWO workspaces is resolved IN THE REQUESTED ONE by liveSeat", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-dual', 'dual@test')`);
    // Owner in A, plain member in B — the OLD cross-workspace tiering in
    // chooseActiveProfile would always rank the owner row in A highest,
    // which is exactly the bug: asking for B used to return A's answer or
    // refuse outright.
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at)
            VALUES ('p-dual-a', 'auth-dual', 'dual@test', ?, 'owner', 1, ?)`,
      args: [TENANT_A, stamp],
    });
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at)
            VALUES ('p-dual-b', 'auth-dual', 'dual@test', ?, 'member', 0, ?)`,
      args: [TENANT_B, stamp],
    });
    const inA = await liveSeat(TENANT_A, "auth-dual");
    const inB = await liveSeat(TENANT_B, "auth-dual");
    assert.equal(inA.live, true);
    assert.equal(inB.live, true);
    if (!inA.live || !inB.live) return;
    assert.equal(inA.profile.id, "p-dual-a");
    assert.equal(inA.profile.teamRole, "owner");
    assert.equal(inB.profile.id, "p-dual-b");
    assert.equal(inB.profile.teamRole, "member", "B's own row, not A's owner row, answers for B");
  });

  await check("resolveOsViewerFor: a member of two workspaces is resolved in the requested workspace, not refused as seat_gone", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-dual2', 'dual2@test')`);
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at)
            VALUES ('p-dual2-a', 'auth-dual2', 'dual2@test', ?, 'owner', 1, ?)`,
      args: [TENANT_A, stamp],
    });
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at)
            VALUES ('p-dual2-b', 'auth-dual2', 'dual2@test', ?, 'member', 0, ?)`,
      args: [TENANT_B, stamp],
    });
    const viewerB = await resolveOsViewerFor(TENANT_B, "auth-dual2");
    assert.equal(viewerB.ok, true, JSON.stringify(viewerB));
    if (!viewerB.ok) return;
    assert.equal(viewerB.surface.tenantId, TENANT_B);
    assert.equal(viewerB.surface.teamRole, "member", "B's own seat, not A's owner seat");
    const viewerA = await resolveOsViewerFor(TENANT_A, "auth-dual2");
    assert.equal(viewerA.ok, true);
    if (!viewerA.ok) return;
    assert.equal(viewerA.surface.teamRole, "owner");
  });

  await check("resolveOsViewerFor: a deactivated seat reads as signed_out (seat_gone to the MCP caller), not degraded", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-removed', 'removed@test')`);
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, deactivated_at)
            VALUES ('p-removed', 'auth-removed', 'removed@test', ?, 'member', ?)`,
      args: [TENANT_A, stamp],
    });
    const viewer = await resolveOsViewerFor(TENANT_A, "auth-removed");
    assert.deepEqual(viewer, { ok: false, reason: "signed_out" });
  });

  await check("a valid multi-workspace login never selects its deactivated admin seat", async () => {
    const { signSession, verifySessionAgainstDb } = await import("../lib/turso-auth");
    const { resolveSessionContext } = await import("../lib/api-auth");
    const { resolveApprovalSession } = await import("../lib/os/approvals/session");
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-session', 'session@test')`);
    await db.batch([
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at, deactivated_at) VALUES ('p-removed-admin', 'auth-session', 'session@test', ?, 'admin', 1, ?, '2026-11-02T00:00:00Z', ?)`, args: [TENANT_A, stamp, stamp] },
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, onboarding_completed_at, updated_at) VALUES ('p-active-other', 'auth-session', 'session@test', ?, 'read_only', ?, ?)`, args: [TENANT_B, stamp, stamp] },
    ], "write");
    sessionCookie = signSession({ sub: "auth-session", email: "session@test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
    assert.ok(await verifySessionAgainstDb(db, sessionCookie), "another live workspace intentionally keeps the global login valid");
    const session = await resolveSessionContext();
    assert.ok(session.ok);
    if (!session.ok) return;
    assert.equal(session.tenantId, TENANT_B, "the removed admin seat must never win canonical selection");
    assert.equal(session.isAdmin, false);
    const approval = await resolveApprovalSession();
    assert.ok(approval.ok);
    if (approval.ok) {
      assert.equal(approval.scope.tenantId, TENANT_B);
      assert.equal(approval.scope.canAct, false);
    }
    assert.equal(Number((await db.execute("SELECT count(*) AS n FROM user_profiles")).rows[0].n), 2, "historical rows remain intact");
  });

  await check("removed auth-linked seats cannot revive through a matching-email fallback", async () => {
    const { resolveActiveProfileForUser } = await import("../lib/active-profile-resolver");
    await db.batch([
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, deactivated_at) VALUES ('p-auth-removed', 'auth-no-active', 'fallback@test', ?, 'admin', ?)`, args: [TENANT_A, stamp] },
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES ('p-email-legacy', NULL, 'fallback@test', ?, 'owner')`, args: [TENANT_B] },
    ], "write");
    assert.deepEqual(await resolveActiveProfileForUser({ id: "auth-no-active", email: "fallback@test" }), { profile: null, error: null });
  });

  await check("email-only migration fallback excludes removed rows and retains active ones", async () => {
    const { resolveActiveProfileForUser } = await import("../lib/active-profile-resolver");
    await db.execute({ sql: `INSERT INTO user_profiles (id, email, tenant_id, team_role, deactivated_at) VALUES ('p-email-removed', 'legacy@test', ?, 'admin', ?)`, args: [TENANT_A, stamp] });
    assert.deepEqual(await resolveActiveProfileForUser({ id: "auth-legacy", email: "legacy@test" }), { profile: null, error: null });
    await db.execute({ sql: `INSERT INTO user_profiles (id, email, tenant_id, team_role) VALUES ('p-email-active', 'legacy@test', ?, 'member')`, args: [TENANT_B] });
    assert.equal((await resolveActiveProfileForUser({ id: "auth-legacy", email: "legacy@test" })).profile?.id, "p-email-active");
  });

  await check("a still-valid cookie with zero active seats cannot open approvals", async () => {
    const { signSession } = await import("../lib/turso-auth");
    const { resolveSessionContext } = await import("../lib/api-auth");
    const { resolveApprovalSession } = await import("../lib/os/approvals/session");
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-zero', 'zero@test')`);
    await db.execute({ sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, deactivated_at) VALUES ('p-zero', 'auth-zero', 'zero@test', ?, 'admin', ?)`, args: [TENANT_A, stamp] });
    sessionCookie = signSession({ sub: "auth-zero", email: "zero@test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
    assert.deepEqual(await resolveSessionContext(), { ok: false, reason: "no_profile" });
    const result = await resolveApprovalSession();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
  });

  await check("owner-only approvals ignore removed owners and stale owner duplicates", async () => {
    const { isWorkspaceOwnerForApprovals } = await import("../lib/os/approvals/session");
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-owner', 'owner@test')`);
    await db.batch([
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, is_owner, deactivated_at) VALUES ('p-owner-removed', 'auth-owner', 'owner@test', ?, 1, ?)`, args: [TENANT_A, stamp] },
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, is_owner, onboarding_completed_at) VALUES ('p-owner-current-member', 'auth-owner', 'owner@test', ?, 0, ?)`, args: [TENANT_A, stamp] },
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, is_owner) VALUES ('p-owner-stale', 'auth-owner', 'owner@test', ?, 1)`, args: [TENANT_A] },
    ], "write");
    assert.equal(await isWorkspaceOwnerForApprovals(db, TENANT_A, "auth-owner"), false);
    assert.equal(await isWorkspaceOwnerForApprovals(db, TENANT_B, "auth-owner"), false);
    await db.execute("UPDATE user_profiles SET is_owner = 1 WHERE id = 'p-owner-current-member'");
    assert.equal(await isWorkspaceOwnerForApprovals(db, TENANT_A, "auth-owner"), true);
  });

  await check("more than twenty removed rows cannot hide a remaining active seat", async () => {
    const { resolveActiveProfileForUser } = await import("../lib/active-profile-resolver");
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-history', 'history@test')`);
    await db.batch(Array.from({ length: 21 }, (_, i) => ({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, deactivated_at) VALUES (?, 'auth-history', 'history@test', ?, 'owner', ?)`,
      args: [`p-history-${i}`, TENANT_A, stamp],
    })), "write");
    await db.execute({ sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES ('p-history-active', 'auth-history', 'history@test', ?, 'member')`, args: [TENANT_A] });
    assert.equal((await resolveActiveProfileForUser({ id: "auth-history", email: "history@test" })).profile?.id, "p-history-active");
    const live = await liveSeat(TENANT_A, "auth-history");
    assert.ok(live.live);
    if (live.live) assert.equal(live.profile.id, "p-history-active");
    assert.equal(Number((await db.execute("SELECT count(*) AS n FROM user_profiles")).rows[0].n), 22);
  });

  await check("legacy fallback never reads a matching-email profile linked to another account", async () => {
    const { resolveActiveProfileForUser } = await import("../lib/active-profile-resolver");
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-collision', 'collision@test')`);
    await db.execute({ sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner) VALUES ('p-other-account', 'auth-someone-else', 'collision@test', ?, 'owner', 1)`, args: [TENANT_A] });
    assert.deepEqual(await resolveActiveProfileForUser({ id: "auth-collision", email: "collision@test" }), { profile: null, error: null });
    assert.equal((await liveSeat(TENANT_A, "auth-collision")).live, false);
  });

  await check("legacy live-seat fallback is active, unlinked, authenticated and tenant-specific", async () => {
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-unlinked', 'unlinked@test')`);
    await db.execute({ sql: `INSERT INTO user_profiles (id, email, tenant_id, team_role, is_owner) VALUES ('p-unlinked', 'unlinked@test', ?, 'owner', 1)`, args: [TENANT_B] });
    const own = await liveSeat(TENANT_B, "auth-unlinked");
    assert.ok(own.live);
    if (own.live) assert.equal(own.profile.id, "p-unlinked");
    assert.equal((await liveSeat(TENANT_A, "auth-unlinked")).live, false, "another workspace's matching email confers no access");
    await db.execute("UPDATE user_profiles SET deactivated_at = '2026-11-02' WHERE id = 'p-unlinked'");
    assert.equal((await liveSeat(TENANT_B, "auth-unlinked")).live, false);
    assert.equal((await db.execute("SELECT auth_user_id FROM user_profiles WHERE id = 'p-unlinked'")).rows[0].auth_user_id, null);
  });

  await check("auth-linked history in any workspace forbids unlinked fallback everywhere", async () => {
    const { resolveActiveProfileForUser } = await import("../lib/active-profile-resolver");
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email) VALUES ('auth-historical', 'historical@test')`);
    await db.batch([
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, deactivated_at) VALUES ('p-history-other-tenant', 'auth-historical', 'historical@test', ?, ?)`, args: [TENANT_A, stamp] },
      { sql: `INSERT INTO user_profiles (id, email, tenant_id, team_role, is_owner) VALUES ('p-history-unlinked', 'historical@test', ?, 'owner', 1)`, args: [TENANT_B] },
    ], "write");
    assert.deepEqual(await resolveActiveProfileForUser({ id: "auth-historical", email: "historical@test" }), { profile: null, error: null });
    assert.equal((await liveSeat(TENANT_B, "auth-historical")).live, false);
  });

  if (failures > 0) {
    console.log(`seat-liveness: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("seat-liveness: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
