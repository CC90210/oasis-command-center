/**
 * OASIS OS signup is invite-only, and provisioning never mints a tenant (P0-8).
 * Run: node --conditions=react-server --import tsx tests/signup-invite-only.test.ts
 *
 * WHY. Signup was open. 47 of 49 tenants were strangers' self-signups: the
 * account route asked for no proof of the address, /api/auth/provision called
 * signup_tenant for anyone without a profile, and the shell was picked from
 * whatever brand text they typed, so a "Sunrise Funding" signup got SunBiz's
 * shell. Worse, provisioning relinked ANY profile whose email matched,
 * whatever auth account already owned it. Registering someone's address and
 * calling provision took over their profile.
 *
 * What this pins, against a real libSQL database (the route runs for real, and
 * provisioning goes through the same PostgREST adapter production uses):
 *   - signup with no invite token, or a token pinned to another email, is 403
 *     and creates no account;
 *   - a valid team invite still completes end to end: account, redemption into
 *     the inviting tenant, and provisioning that finds that profile;
 *   - provisioning without an invite creates no tenant and no profile;
 *   - the email relink refuses a row another auth account already owns, and
 *     claims a detached row only with an active invite for that email AND that
 *     row's tenant;
 *   - brand text selects no shell; only an explicit, registered slug does.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { POST as tursoSignup } from "../app/api/auth/turso-signup/route";
import {
  ProvisioningRefusedError,
  provisionAuthenticatedUser,
} from "../lib/auth-provisioning";
import { getClientProfileSlugForBrand } from "../lib/client-profiles";
import { applyClientProvisioningProfile } from "../lib/client-provisioning";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import { redeem_tenant_invite } from "../lib/turso-rpc-shim";
import { SESSION_COOKIE } from "../lib/turso-auth";

const TENANT_A = "tenant-invite-a";
const TENANT_B = "tenant-invite-b";

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function createSchema(db: Client) {
  await db.execute(`CREATE TABLE "_supabase_auth_users" (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    encrypted_password TEXT,
    raw_user_meta_data TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  )`);
  await db.execute(`CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    plan_tier TEXT,
    purchase_status TEXT,
    custom_fields TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  await db.execute(`CREATE TABLE tenant_invites (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    email TEXT,
    team_role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    redeemed_by TEXT,
    revoked_at TEXT
  )`);
  await db.execute(`CREATE TABLE user_profiles (
    id TEXT PRIMARY KEY,
    auth_user_id TEXT,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    display_name TEXT,
    brand TEXT,
    role TEXT,
    tenant_id TEXT,
    team_role TEXT NOT NULL DEFAULT 'member',
    invited_by TEXT,
    joined_at TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    agents_enabled TEXT NOT NULL DEFAULT '["bravo"]',
    primary_agent TEXT,
    prospect_focus TEXT NOT NULL DEFAULT '["service_trades"]',
    onboarding_completed_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  await db.execute({
    sql: `INSERT INTO tenants (id, slug, name) VALUES (?, 'workspace-a', 'Workspace A'),
                                                      (?, 'workspace-b', 'Workspace B')`,
    args: [TENANT_A, TENANT_B],
  });
}

async function insertInvite(
  db: Client,
  input: { raw: string; tenantId: string; email: string },
) {
  await db.execute({
    sql: `INSERT INTO tenant_invites
      (id, tenant_id, email, team_role, token_hash, created_by, expires_at)
      VALUES (?, ?, ?, 'member', ?, 'admin-1', '2099-01-01T00:00:00.000Z')`,
    args: [randomUUID(), input.tenantId, input.email, hash(input.raw)],
  });
}

async function count(db: Client, sql: string, args: string[] = []): Promise<number> {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]?.n ?? 0);
}

function signupRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/auth/turso-signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": randomUUID() },
    body: JSON.stringify(body),
  });
}

async function refusal(work: Promise<unknown>): Promise<ProvisioningRefusedError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProvisioningRefusedError) return error;
    throw error;
  }
  assert.fail("expected provisioning to be refused");
}

async function testSignupRequiresAnInviteForThatEmail(db: Client) {
  const accountsBefore = await count(db, `SELECT count(*) AS n FROM "_supabase_auth_users"`);

  for (const token of [undefined, "", "   "]) {
    const res = await tursoSignup(signupRequest({
      email: "stranger@example.com",
      password: "ProductionReady123",
      full_name: "Stranger",
      ...(token === undefined ? {} : { invite_token: token }),
    }));
    assert.equal(res.status, 403, `no invite (${JSON.stringify(token)}) must be refused`);
    assert.equal(((await res.json()) as { code?: string }).code, "invite_required");
  }

  const raw = "invite-for-someone-else-token-000000001";
  await insertInvite(db, { raw, tenantId: TENANT_A, email: "invited@example.com" });
  const mismatch = await tursoSignup(signupRequest({
    email: "attacker@example.com",
    password: "ProductionReady123",
    invite_token: raw,
  }));
  assert.equal(mismatch.status, 403, "a token pinned to another address mints nothing");
  assert.equal(((await mismatch.json()) as { code?: string }).code, "invite_email_mismatch");

  const unknown = await tursoSignup(signupRequest({
    email: "invited@example.com",
    password: "ProductionReady123",
    invite_token: "not-a-real-invite-token-000000000000",
  }));
  assert.equal(unknown.status, 403, "an unknown token is a refusal, not a malformed request");
  assert.equal(((await unknown.json()) as { code?: string }).code, "invite_invalid");

  assert.equal(
    await count(db, `SELECT count(*) AS n FROM "_supabase_auth_users"`),
    accountsBefore,
    "no refused signup may leave an account behind",
  );
}

async function testTeamInviteStillCompletesEndToEnd(db: Client) {
  const pg = createTursoPostgrest(db) as unknown as SupabaseClient;
  const email = "new-rep@example.com";
  const raw = "valid-team-invite-token-00000000000001";
  await insertInvite(db, { raw, tenantId: TENANT_A, email });
  const tenantsBefore = await count(db, `SELECT count(*) AS n FROM tenants`);

  const res = await tursoSignup(signupRequest({
    // The invite's address, typed with different case and spacing.
    email: "  New-Rep@Example.com ",
    password: "ProductionReady123",
    full_name: "New Rep",
    invite_token: raw,
  }));
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { ok?: boolean; user?: { id?: string } };
  assert.equal(body.ok, true);
  const authUserId = body.user?.id ?? "";
  assert.ok(authUserId, "the account id comes back to the browser");
  assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=`),
    "the invitee is signed in, so redeem-invite can run with their session");
  const stored = await db.execute({
    sql: `SELECT raw_user_meta_data FROM "_supabase_auth_users" WHERE id = ?`,
    args: [authUserId],
  });
  assert.deepEqual(JSON.parse(String(stored.rows[0]?.raw_user_meta_data)), { full_name: "New Rep" },
    "the invitee's name is stored, so their profile is not named after their email");

  // What /api/auth/redeem-invite does with that session (lib/team.ts redeemInvite
  // hands the verified auth email and name to this RPC).
  const redeemed = (await redeem_tenant_invite(db, {
    p_token_hash: hash(raw),
    p_redeemer_auth_id: authUserId,
    p_redeemer_email: email,
    p_redeemer_full_name: "New Rep",
  })) as { ok?: boolean; tenant_id?: string };
  assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
  assert.equal(redeemed.tenant_id, TENANT_A, "the invitee joins the inviting tenant");

  const provisioned = await provisionAuthenticatedUser({ db: pg, authUserId, email });
  assert.equal(provisioned.tenant_id, TENANT_A, "provisioning finds the invited profile");
  assert.equal(provisioned.already_provisioned, true);
  assert.equal(
    await count(db, `SELECT count(*) AS n FROM tenants`),
    tenantsBefore,
    "joining by invite creates no tenant",
  );
}

async function testProvisionWithoutInviteCreatesNoTenant(db: Client) {
  const pg = createTursoPostgrest(db) as unknown as SupabaseClient;
  const tenantsBefore = await count(db, `SELECT count(*) AS n FROM tenants`);
  const profilesBefore = await count(db, `SELECT count(*) AS n FROM user_profiles`);

  const refused = await refusal(provisionAuthenticatedUser({
    db: pg,
    authUserId: "auth-self-signup",
    email: "self-signup@example.com",
    // What the old signup page sent. Neither is read any more.
    fullName: "Sunrise Funding CEO",
    brand: "Sunrise Funding",
  }));
  assert.equal(refused.code, "invite_required");
  assert.equal(refused.status, 403);
  assert.equal(await count(db, `SELECT count(*) AS n FROM tenants`), tenantsBefore,
    "a self-signup must not get a tenant");
  assert.equal(await count(db, `SELECT count(*) AS n FROM user_profiles`), profilesBefore,
    "nor a profile");
}

async function testRelinkRefusesARowAnotherAccountOwns(db: Client) {
  const pg = createTursoPostgrest(db) as unknown as SupabaseClient;
  const email = "owner@example.com";
  await db.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, tenant_id, team_role, is_owner)
          VALUES ('profile-owned', 'auth-original', ?, 'Owner', ?, 'owner', 1)`,
    args: [email, TENANT_A],
  });

  // No invite: the old code overwrote auth_user_id here, which was the takeover.
  const bare = await refusal(provisionAuthenticatedUser({
    db: pg, authUserId: "auth-attacker", email,
  }));
  assert.equal(bare.code, "invite_required");

  // Even a genuine invite for that email and tenant cannot move an owned row.
  const raw = "invite-for-owned-profile-token-000000001";
  await insertInvite(db, { raw, tenantId: TENANT_A, email });
  const withInvite = await refusal(provisionAuthenticatedUser({
    db: pg, authUserId: "auth-attacker", email, invite: { rawToken: raw, db },
  }));
  assert.equal(withInvite.code, "profile_owned_by_another_account");
  assert.equal(withInvite.status, 409);

  const row = await db.execute(`SELECT auth_user_id FROM user_profiles WHERE id = 'profile-owned'`);
  assert.equal(row.rows[0]?.auth_user_id, "auth-original", "the owner keeps their profile");
}

async function testDetachedRowIsClaimedOnlyWithAnInviteForItsTenant(db: Client) {
  const pg = createTursoPostgrest(db) as unknown as SupabaseClient;
  const email = "precreated@example.com";
  const authUserId = "auth-precreated";
  await db.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, tenant_id)
          VALUES ('profile-detached', NULL, ?, 'Pre Created', ?)`,
    args: [email, TENANT_A],
  });
  const authOf = async () =>
    (await db.execute(`SELECT auth_user_id FROM user_profiles WHERE id = 'profile-detached'`))
      .rows[0]?.auth_user_id ?? null;

  const noInvite = await refusal(provisionAuthenticatedUser({ db: pg, authUserId, email }));
  assert.equal(noInvite.code, "invite_required");
  assert.equal(await authOf(), null, "no invite, no relink");

  const otherEmailRaw = "invite-pinned-elsewhere-token-00000001";
  await insertInvite(db, { raw: otherEmailRaw, tenantId: TENANT_A, email: "someone@example.com" });
  const otherEmail = await refusal(provisionAuthenticatedUser({
    db: pg, authUserId, email, invite: { rawToken: otherEmailRaw, db },
  }));
  assert.equal(otherEmail.code, "invite_email_mismatch");
  assert.equal(await authOf(), null);

  const otherTenantRaw = "invite-from-another-tenant-token-000001";
  await insertInvite(db, { raw: otherTenantRaw, tenantId: TENANT_B, email });
  const otherTenant = await refusal(provisionAuthenticatedUser({
    db: pg, authUserId, email, invite: { rawToken: otherTenantRaw, db },
  }));
  assert.equal(otherTenant.code, "no_claimable_profile",
    "tenant B's invite cannot claim a profile that belongs to tenant A");
  assert.equal(await authOf(), null);

  const tenantsBefore = await count(db, `SELECT count(*) AS n FROM tenants`);
  const raw = "invite-for-detached-profile-token-00001";
  await insertInvite(db, { raw, tenantId: TENANT_A, email });
  const claimed = await provisionAuthenticatedUser({
    db: pg, authUserId, email, invite: { rawToken: raw, db },
  });
  assert.deepEqual(claimed, {
    ok: true,
    already_provisioned: true,
    relinked: true,
    tenant_id: TENANT_A,
    profile_id: "profile-detached",
  });
  assert.equal(await authOf(), authUserId, "the invited mailbox owner now holds the profile");
  assert.equal(await count(db, `SELECT count(*) AS n FROM tenants`), tenantsBefore);

  // Idempotent on retry: it is now found by auth id and nothing is rewritten.
  const again = await provisionAuthenticatedUser({ db: pg, authUserId, email });
  assert.equal(again.profile_id, "profile-detached");
  assert.equal(again.relinked, undefined);
}

async function testBrandTextSelectsNoShell(db: Client) {
  const pg = createTursoPostgrest(db) as unknown as SupabaseClient;
  for (const [brand, email] of [
    ["Sunrise Funding", "ceo@sunrisefunding.com"],
    ["Sun Biz Funding", "ops@sunbizfunding.com"],
    ["Suga Brand Command", null],
  ] as const) {
    assert.equal(getClientProfileSlugForBrand(brand, email), null, `${brand} must pick no shell`);
  }

  await db.execute({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, tenant_id, brand)
          VALUES ('profile-shell', 'auth-shell', 'ceo@sunrisefunding.com', 'CEO', ?, 'Sunrise Funding')`,
    args: [TENANT_B],
  });
  const fromBrand = await applyClientProvisioningProfile({
    db: pg,
    tenantId: TENANT_B,
    profileId: "profile-shell",
    brand: "Sunrise Funding",
    email: "ceo@sunrisefunding.com",
  });
  assert.deepEqual(fromBrand, { clientProfileSlug: null, primaryAgent: null });
  const untouched = await db.execute({
    sql: `SELECT custom_fields FROM tenants WHERE id = ?`, args: [TENANT_B] });
  assert.equal(untouched.rows[0]?.custom_fields, null, "brand text writes no shell");

  await assert.rejects(
    applyClientProvisioningProfile({
      db: pg, tenantId: TENANT_B, profileId: "profile-shell", clientProfileSlug: "sunrise",
    }),
    /unknown client profile "sunrise"/,
    "an unregistered slug fails loudly instead of degrading to the default shell",
  );

  // The one way a shell is set now: an operator names it.
  const explicit = await applyClientProvisioningProfile({
    db: pg, tenantId: TENANT_B, profileId: "profile-shell", clientProfileSlug: "suga",
  });
  assert.deepEqual(explicit, { clientProfileSlug: "suga", primaryAgent: "maven" });
  const shelled = await db.execute({
    sql: `SELECT custom_fields FROM tenants WHERE id = ?`, args: [TENANT_B] });
  assert.equal(
    (JSON.parse(String(shelled.rows[0]?.custom_fields)) as Record<string, unknown>)
      .command_center_profile_slug,
    "suga",
  );
}

function testSourcesCarryTheRule() {
  const page = readFileSync("app/signup/page.tsx", "utf8");
  assert.match(page, /if \(!inviteToken\) return <InviteOnly \/>;/,
    "/signup without a token renders the invite-only card, not the form");
  assert.ok(page.includes("OASIS OS is invite-only"));
  assert.ok(page.includes("href={AUDIT_FUNNEL.path}"), "it points at the existing OASIS funnel");
  assert.ok(!page.includes("/api/auth/provision"), "the page never asks for a new workspace");
  assert.ok(!page.includes("Brand or company name"), "brand text is no longer collected");

  const provisioning = readFileSync("lib/auth-provisioning.ts", "utf8");
  assert.ok(!provisioning.includes('"signup_tenant"'), "provisioning cannot call signup_tenant");

  const route = readFileSync("app/api/auth/provision/route.ts", "utf8");
  assert.match(route, /status: err\.status/, "refusals keep their 403/409 at the route");
}

async function main() {
  const previous = {
    backend: process.env.EMPIRE_AUTH_BACKEND,
    secret: process.env.AUTH_SESSION_SECRET,
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
  };
  const url = "file::memory:?cache=shared";
  process.env.EMPIRE_AUTH_BACKEND = "turso";
  process.env.AUTH_SESSION_SECRET = "signup-invite-only-test-secret-deliberately-long-enough-0001";
  process.env.TURSO_DATABASE_URL = url;
  process.env.TURSO_AUTH_TOKEN = "local-test-token";
  // Held open for the whole run: the shared in-memory database lives only while
  // a connection does, and the route opens its own against the same URL.
  const db = createClient({ url });
  try {
    await createSchema(db);
    await testSignupRequiresAnInviteForThatEmail(db);
    await testTeamInviteStillCompletesEndToEnd(db);
    await testProvisionWithoutInviteCreatesNoTenant(db);
    await testRelinkRefusesARowAnotherAccountOwns(db);
    await testDetachedRowIsClaimedOnlyWithAnInviteForItsTenant(db);
    await testBrandTextSelectsNoShell(db);
    testSourcesCarryTheRule();
    console.log("signup invite-only tests passed");
  } finally {
    db.close();
    if (previous.backend === undefined) delete process.env.EMPIRE_AUTH_BACKEND;
    else process.env.EMPIRE_AUTH_BACKEND = previous.backend;
    if (previous.secret === undefined) delete process.env.AUTH_SESSION_SECRET;
    else process.env.AUTH_SESSION_SECRET = previous.secret;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
