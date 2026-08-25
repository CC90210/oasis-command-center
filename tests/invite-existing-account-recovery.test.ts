import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";
import {
  confirmInviteBoundEmail,
  validateActiveInviteForEmail,
} from "../lib/invite-account-recovery";
import { redeem_tenant_invite } from "../lib/turso-rpc-shim";
import { signupUserMetadata } from "../lib/turso-auth";
import { POST as tursoSignup } from "../app/api/auth/turso-signup/route";

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function createInviteDb(url = ":memory:") {
  const db = createClient({ url });
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
    tenant_id TEXT,
    team_role TEXT NOT NULL DEFAULT 'member',
    invited_by TEXT,
    joined_at TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    agents_enabled TEXT NOT NULL DEFAULT '["bravo"]',
    prospect_focus TEXT NOT NULL DEFAULT '["service_trades"]'
  )`);
  return db;
}

async function insertInvite(
  db: Awaited<ReturnType<typeof createInviteDb>>,
  input: {
    id: string;
    raw: string;
    tenantId: string;
    email?: string | null;
    expiresAt?: string;
    revokedAt?: string | null;
    redeemedAt?: string | null;
  },
) {
  await db.execute({
    sql: `INSERT INTO tenant_invites
      (id, tenant_id, email, team_role, token_hash, created_by, expires_at,
       redeemed_at, redeemed_by, revoked_at)
      VALUES (?, ?, ?, 'opener', ?, 'admin-1', ?, ?, NULL, ?)`,
    args: [
      input.id,
      input.tenantId,
      input.email ?? null,
      hash(input.raw),
      input.expiresAt ?? "2099-01-01T00:00:00.000Z",
      input.redeemedAt ?? null,
      input.revokedAt ?? null,
    ],
  });
}

async function testInviteValidationIsEmailPinnedAndFailClosed() {
  const db = await createInviteDb();
  const raw = "valid-existing-account-invite-token-0001";
  await insertInvite(db, {
    id: "invite-valid",
    raw,
    tenantId: "oasis-tenant",
    email: "David@OasisAI.Work",
  });

  assert.deepEqual(
    await validateActiveInviteForEmail(db, {
      rawToken: raw,
      email: "david@oasisai.work",
      now: new Date("2026-08-25T00:00:00.000Z"),
    }),
    { ok: true, tenantId: "oasis-tenant", emailPinned: true },
    "the exact pinned account can carry the active invite through password recovery",
  );
  assert.deepEqual(
    await validateActiveInviteForEmail(db, {
      rawToken: raw,
      email: "someone@else.example",
      now: new Date("2026-08-25T00:00:00.000Z"),
    }),
    { ok: false, error: "email_mismatch" },
    "a reset requested for another email must not inherit this tenant invite",
  );
  assert.deepEqual(
    await validateActiveInviteForEmail(db, {
      rawToken: "not-the-real-active-token-000000000000",
      email: "david@oasisai.work",
      now: new Date("2026-08-25T00:00:00.000Z"),
    }),
    { ok: false, error: "invalid_or_expired" },
    "unknown tokens fail closed without tenant details",
  );

  const openRaw = "active-open-invite-token-00000000000002";
  await insertInvite(db, {
    id: "invite-open",
    raw: openRaw,
    tenantId: "oasis-tenant",
    email: null,
  });
  assert.deepEqual(
    await validateActiveInviteForEmail(db, {
      rawToken: openRaw,
      email: "any-account@example.com",
      now: new Date("2026-08-25T00:00:00.000Z"),
    }),
    { ok: false, error: "invalid_or_expired" },
    "legacy open invites cannot enter account recovery",
  );
  assert.deepEqual(
    await redeem_tenant_invite(db, {
      p_token_hash: hash(openRaw),
      p_redeemer_auth_id: "auth-open",
      p_redeemer_email: "any-account@example.com",
      p_redeemer_full_name: "Open",
    }),
    { ok: false, error: "email_pin_required" },
    "legacy open invites cannot be redeemed by an arbitrary signed-in account",
  );
}

async function testInviteBindingPrecedesEmailConfirmation() {
  const rawToken = "valid-invite-token-with-enough-entropy";
  let confirmationCalls = 0;
  const confirmUserEmail = async () => {
    confirmationCalls += 1;
    return { ok: true } as const;
  };

  const invalid = await confirmInviteBoundEmail(
    { rawToken, userId: "auth-user" },
    {
      previewInvite: async () => null,
      getUserEmail: async () => "david@oasisai.work",
      confirmUserEmail,
    },
  );
  assert.deepEqual(invalid, {
    ok: false,
    stage: "preflight",
    error: "invalid_or_expired",
  });
  assert.equal(confirmationCalls, 0, "an invalid invite cannot confirm any account");

  const mismatch = await confirmInviteBoundEmail(
    { rawToken, userId: "auth-user" },
    {
      previewInvite: async () => ({ emailPinned: "invited@oasisai.work" }),
      getUserEmail: async () => "different@oasisai.work",
      confirmUserEmail,
    },
  );
  assert.deepEqual(mismatch, {
    ok: false,
    stage: "preflight",
    error: "email_mismatch",
  });
  assert.equal(confirmationCalls, 0, "a mismatched invite cannot confirm the target account");

  const valid = await confirmInviteBoundEmail(
    { rawToken, userId: "auth-user" },
    {
      previewInvite: async () => ({ emailPinned: " David@OasisAI.Work " }),
      getUserEmail: async () => "david@oasisai.work",
      confirmUserEmail,
    },
  );
  assert.deepEqual(valid, { ok: true });
  assert.equal(confirmationCalls, 1, "a valid pinned invite confirms exactly once");
}

async function testExistingAccountCanAttachButCannotMoveTenants() {
  const db = await createInviteDb();
  await db.execute(`INSERT INTO user_profiles
    (id, auth_user_id, email, full_name, tenant_id, team_role)
    VALUES ('profile-david', 'auth-david', 'stale-david@example.com',
            'david@oasisai.work00', NULL, 'member')`);
  const recoverRaw = "detached-account-recovery-token-0000001";
  await insertInvite(db, {
    id: "invite-recover",
    raw: recoverRaw,
    tenantId: "oasis-tenant",
    email: "david@oasisai.work",
  });

  const recovered = await redeem_tenant_invite(db, {
    p_token_hash: hash(recoverRaw),
    p_redeemer_auth_id: "auth-david",
    p_redeemer_email: "david@oasisai.work",
    p_redeemer_full_name: "David Smadja",
  });
  assert.equal((recovered as { ok?: boolean }).ok, true, "detached existing account redeems");
  const profile = await db.execute({
    sql: `SELECT tenant_id, team_role, email, full_name FROM user_profiles WHERE id = ?`,
    args: ["profile-david"],
  });
  assert.equal(profile.rows[0]?.tenant_id, "oasis-tenant");
  assert.equal(profile.rows[0]?.team_role, "opener");
  assert.equal(profile.rows[0]?.email, "david@oasisai.work", "verified auth email repairs stale profile identity");
  assert.equal(profile.rows[0]?.full_name, "David Smadja", "verified auth metadata repairs the rep name");

  await db.execute(`INSERT INTO user_profiles
    (id, auth_user_id, email, full_name, tenant_id, team_role)
    VALUES ('profile-other', 'auth-other', 'other@example.com', 'Other', 'tenant-a', 'member')`);
  const crossTenantRaw = "cross-tenant-invite-token-00000000002";
  await insertInvite(db, {
    id: "invite-cross",
    raw: crossTenantRaw,
    tenantId: "tenant-b",
    email: "other@example.com",
  });

  const blocked = await redeem_tenant_invite(db, {
    p_token_hash: hash(crossTenantRaw),
    p_redeemer_auth_id: "auth-other",
    p_redeemer_email: "other@example.com",
    p_redeemer_full_name: "Other",
  });
  assert.deepEqual(blocked, { ok: false, error: "already_member_of_another_tenant" });
  const unchangedProfile = await db.execute(
    `SELECT tenant_id FROM user_profiles WHERE id = 'profile-other'`,
  );
  const unclaimedInvite = await db.execute(
    `SELECT redeemed_at, redeemed_by FROM tenant_invites WHERE id = 'invite-cross'`,
  );
  assert.equal(unchangedProfile.rows[0]?.tenant_id, "tenant-a", "existing tenant remains intact");
  assert.equal(unclaimedInvite.rows[0]?.redeemed_at, null, "blocked invite is not consumed");
  assert.equal(unclaimedInvite.rows[0]?.redeemed_by, null, "blocked invite records no redeemer");
}

async function testExistingSameTenantMembershipIsANoOp() {
  const cases = [
    { suffix: "owner", teamRole: "owner", isOwner: 1 },
    { suffix: "admin", teamRole: "admin", isOwner: 0 },
    { suffix: "member", teamRole: "member", isOwner: 0 },
  ] as const;

  for (const existing of cases) {
    const db = await createInviteDb();
    const authId = `auth-${existing.suffix}`;
    const profileId = `profile-${existing.suffix}`;
    const email = `${existing.suffix}@oasisai.work`;
    await db.execute({
      sql: `INSERT INTO user_profiles
        (id, auth_user_id, email, full_name, tenant_id, team_role, is_owner)
        VALUES (?, ?, ?, ?, 'oasis-tenant', ?, ?)`,
      args: [profileId, authId, email, existing.suffix, existing.teamRole, existing.isOwner],
    });
    const raw = `same-tenant-${existing.suffix}-invite-token-00000001`;
    const inviteId = `invite-${existing.suffix}`;
    await insertInvite(db, {
      id: inviteId,
      raw,
      tenantId: "oasis-tenant",
      email,
    });

    const result = await redeem_tenant_invite(db, {
      p_token_hash: hash(raw),
      p_redeemer_auth_id: authId,
      p_redeemer_email: email,
      p_redeemer_full_name: existing.suffix,
    }) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.already_member, true);
    assert.equal(result.team_role, existing.teamRole, "the existing role wins over the invite role");

    const profile = await db.execute({
      sql: `SELECT tenant_id, team_role, is_owner FROM user_profiles WHERE id = ?`,
      args: [profileId],
    });
    assert.equal(profile.rows[0]?.tenant_id, "oasis-tenant");
    assert.equal(profile.rows[0]?.team_role, existing.teamRole);
    assert.equal(Number(profile.rows[0]?.is_owner), existing.isOwner);
    const invite = await db.execute({
      sql: `SELECT redeemed_at, redeemed_by FROM tenant_invites WHERE id = ?`,
      args: [inviteId],
    });
    assert.equal(invite.rows[0]?.redeemed_at, null, "a redundant invite remains unconsumed");
    assert.equal(invite.rows[0]?.redeemed_by, null);
    db.close();
  }
}

async function testTwoTenantInvitesRaceForOneDetachedProfile() {
  const sharedUrl = "file::memory:?cache=shared";
  const db = await createInviteDb(sharedUrl);
  const contenderA = createClient({ url: sharedUrl });
  const contenderB = createClient({ url: sharedUrl });

  await db.execute(`INSERT INTO user_profiles
    (id, auth_user_id, email, full_name, tenant_id, team_role)
    VALUES ('profile-race', 'auth-race', 'race@oasisai.work', 'Race', NULL, 'member')`);
  const rawA = "concurrent-tenant-a-invite-token-000000001";
  const rawB = "concurrent-tenant-b-invite-token-000000002";
  await insertInvite(db, {
    id: "invite-race-a",
    raw: rawA,
    tenantId: "tenant-a",
    email: "race@oasisai.work",
  });
  await insertInvite(db, {
    id: "invite-race-b",
    raw: rawB,
    tenantId: "tenant-b",
    email: "race@oasisai.work",
  });

  // Gate only the batch call so both real connections complete their detached-
  // profile pre-read before either writes. Releasing both batches together
  // deterministically exercises the stale-precheck race without mocking any
  // SQL or transaction behavior.
  let batchArrivals = 0;
  let releaseBatches!: () => void;
  const batchGate = new Promise<void>((resolve) => { releaseBatches = resolve; });
  const gated = (client: typeof contenderA): typeof contenderA => new Proxy(client, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (...args: Parameters<typeof client.batch>) => {
          batchArrivals += 1;
          if (batchArrivals === 2) releaseBatches();
          await batchGate;
          return target.batch(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const race = Promise.all([
    redeem_tenant_invite(gated(contenderA), {
      p_token_hash: hash(rawA),
      p_redeemer_auth_id: "auth-race",
      p_redeemer_email: "race@oasisai.work",
      p_redeemer_full_name: "Race",
    }),
    redeem_tenant_invite(gated(contenderB), {
      p_token_hash: hash(rawB),
      p_redeemer_auth_id: "auth-race",
      p_redeemer_email: "race@oasisai.work",
      p_redeemer_full_name: "Race",
    }),
  ]);
  const outcomes = (await race) as Array<Record<string, unknown>>;
  assert.equal(
    outcomes.filter((outcome) => outcome.ok === true).length,
    1,
    "exactly one competing tenant invite may attach the detached profile",
  );
  assert.equal(
    outcomes.filter(
      (outcome) => outcome.ok === false && outcome.error === "already_member_of_another_tenant",
    ).length,
    1,
    "the losing tenant fails closed at the atomic profile boundary",
  );

  const profile = await db.execute(
    `SELECT tenant_id FROM user_profiles WHERE id = 'profile-race'`,
  );
  const invites = await db.execute(
    `SELECT id, tenant_id, redeemed_at, redeemed_by
     FROM tenant_invites WHERE id IN ('invite-race-a', 'invite-race-b') ORDER BY id`,
  );
  const redeemed = invites.rows.filter((row) => row.redeemed_at !== null);
  const unredeemed = invites.rows.filter((row) => row.redeemed_at === null);
  assert.equal(redeemed.length, 1, "only the winning invite is consumed");
  assert.equal(unredeemed.length, 1, "the losing invite remains available for admin recovery");
  assert.equal(redeemed[0]?.redeemed_by, "auth-race");
  assert.equal(unredeemed[0]?.redeemed_by, null);
  assert.equal(
    profile.rows[0]?.tenant_id,
    redeemed[0]?.tenant_id,
    "the profile tenant always matches the one invite that was actually consumed",
  );

  contenderA.close();
  contenderB.close();
  db.close();
}

function testBrowserRecoveryPathKeepsTheInvite() {
  const signup = readFileSync("app/signup/page.tsx", "utf8");
  const signupRoute = readFileSync("app/api/auth/turso-signup/route.ts", "utf8");
  const login = readFileSync("app/login/LoginForm.tsx", "utf8");
  const loginPage = readFileSync("app/login/page.tsx", "utf8");
  const forgot = readFileSync("app/forgot-password/page.tsx", "utf8");
  const reset = readFileSync("app/auth/reset-password/page.tsx", "utf8");
  const resetRequest = readFileSync("app/api/auth/turso-reset-request/route.ts", "utf8");
  const resetConfirm = readFileSync("app/api/auth/turso-reset-confirm/route.ts", "utf8");
  const redeemRoute = readFileSync("app/api/auth/redeem-invite/route.ts", "utf8");
  const finalizeRoute = readFileSync("app/api/auth/finalize-invite-signup/route.ts", "utf8");

  assert(signup.includes("invite_token: inviteToken"), "invite signup validates the raw invite");
  assert(
    signupRoute.includes("raw_user_meta_data"),
    "Turso signup persists the teammate's full name",
  );
  assert(signup.includes('b.code === "account_exists"'), "existing account gets recovery UI");
  assert(signup.includes("Sign in &amp; accept") && signup.includes("Reset password"));
  assert(login.includes('query.set("invite", inviteToken)'), "Forgot link preserves invite");
  assert(login.includes("`/invite/${encodeURIComponent(inviteToken)}`"), "Google returns to invite");
  assert(loginPage.includes("redirect(invite ?"), "authenticated /login cannot drop invite");
  assert(forgot.includes("{ inviteToken: inviteToken || undefined }"));
  assert(resetRequest.includes("validateActiveInviteForEmail"));
  assert(resetRequest.includes("validation.ok && validation.emailPinned"));
  assert(resetRequest.includes('resetUrl.searchParams.set("invite", verifiedInvite)'));
  assert(
    resetRequest.indexOf("validateActiveInviteForEmail") <
      resetRequest.indexOf('resetUrl.searchParams.set("invite", verifiedInvite)'),
    "the reset email cannot carry an invite before the server validates its email pin",
  );
  assert(reset.includes('fetch("/api/auth/redeem-invite"'), "reset redeems after authentication");
  assert(resetConfirm.includes("signSession({"), "successful Turso reset establishes a session");
  for (const route of [redeemRoute, finalizeRoute]) {
    assert(
      route.includes("finalizeInviteProfile({"),
      "every invite completion path must apply the same role and manifest roster policy",
    );
    assert(
      route.includes("preserveExistingMember: result.alreadyMember === true"),
      "a redundant same-tenant invite must preserve the existing member's profile",
    );
  }
  assert(
    finalizeRoute.includes("confirmInviteBoundEmail("),
    "the unauthenticated finalize route must bind the invite before confirming email",
  );
}

function testSignupIdentityMetadataIsPreserved() {
  assert.deepEqual(JSON.parse(signupUserMetadata("  David Smadja  ")), {
    full_name: "David Smadja",
  });
  assert.deepEqual(JSON.parse(signupUserMetadata(undefined)), {});
  assert.equal(
    (JSON.parse(signupUserMetadata("x".repeat(200))) as { full_name: string }).full_name.length,
    160,
    "untrusted display names are bounded before storage",
  );
}

async function testTursoSignupActuallyPersistsFullName() {
  const previous = {
    backend: process.env.EMPIRE_AUTH_BACKEND,
    secret: process.env.AUTH_SESSION_SECRET,
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
  };
  const url = "file::memory:?cache=shared";
  process.env.EMPIRE_AUTH_BACKEND = "turso";
  process.env.AUTH_SESSION_SECRET = "signup-metadata-test-secret-that-is-deliberately-long-enough-0001";
  process.env.TURSO_DATABASE_URL = url;
  process.env.TURSO_AUTH_TOKEN = "local-test-token";
  const db = createClient({ url });
  try {
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
    const email = `david-${randomUUID()}@oasisai.work`;
    const response = await tursoSignup(new NextRequest("http://localhost/api/auth/turso-signup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": randomUUID() },
      body: JSON.stringify({
        email,
        password: "ProductionReady123",
        full_name: "  David Smadja  ",
      }),
    }));
    assert.equal(response.status, 200, await response.text());
    const stored = await db.execute({
      sql: `SELECT raw_user_meta_data FROM "_supabase_auth_users" WHERE email = ?`,
      args: [email],
    });
    assert.deepEqual(JSON.parse(String(stored.rows[0]?.raw_user_meta_data)), {
      full_name: "David Smadja",
    });
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

async function main() {
  await testInviteValidationIsEmailPinnedAndFailClosed();
  await testInviteBindingPrecedesEmailConfirmation();
  await testExistingAccountCanAttachButCannotMoveTenants();
  await testExistingSameTenantMembershipIsANoOp();
  await testTwoTenantInvitesRaceForOneDetachedProfile();
  testBrowserRecoveryPathKeepsTheInvite();
  testSignupIdentityMetadataIsPreserved();
  await testTursoSignupActuallyPersistsFullName();
  console.log("Existing-account invite recovery tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
