/**
 * invite-redeem.test.ts - joining a workspace by invite, against REAL libSQL.
 *
 * WHY THIS EXISTS (2026-09-29 audit, invite-redeem-500-new-workspace). Every
 * invite into a workspace other than OASIS's died at the last step: the invite
 * was claimed and the profile committed, THEN finalization looked the manifest
 * up by the wrong key, found the empty placeholder, threw
 * invite_profile_has_no_enabled_agent, and the route answered 500 with the raw
 * code "profile_finalize_failed". The invite was used up, the person was
 * half-joined, and a retry failed the same way forever.
 *
 * Pinned here:
 *   - a member invite into a workspace with NO manifest joins (200), claims the
 *     invite exactly once, gives no agents (never OASIS's), and a retry is
 *     idempotent;
 *   - the manifest is found by TENANT ID, so a workspace whose manifest was
 *     saved under another slug still gives its teammates;
 *   - a failure while deciding the profile, or inside the write itself, leaves
 *     the invite UNCLAIMED and no profile behind;
 *   - an owner_claim invite makes an owner; a member invite whose row says
 *     "owner" does not; a second owner is refused with the invite untouched;
 *   - before bravo__196 is applied (no `kind` column) redemption still works;
 *   - the route answers with a sentence, never a raw code, and the signup page
 *     shows sentences and hides Google signup under Turso auth.
 *
 * Run: node --conditions=react-server --import tsx tests/invite-redeem.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";
import {
  applyMigration196,
  check,
  createBaseSchema,
  finish,
  OASIS,
  seedAuthUser,
  seedProfile,
  seedTenant,
  sessionPayloadFromSetCookie,
  setSessionCookie,
  setupOnboardingEnv,
  signFor,
  type SeedUser,
} from "./_onboarding-fixture";

const { dbFile } = setupOnboardingEnv("invite-redeem");

const BAYSIDE = "b0b0b000-0000-4000-8000-00000000b0b0"; // unprovisioned client workspace
const NODEOPS = "c0c0c000-0000-4000-8000-00000000c0c0"; // wizard manifest under ANOTHER slug
const ACME = "a0c3e000-0000-4000-8000-00000000ac3e"; // owner-claim target
const u = (n: number, email: string, name: string): SeedUser => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email, name });
const CC = u(1, "conaugh@oasisai.work", "Conaugh McKenna");
const STAFF = u(2, "staff@bayside-hvac.test", "Sam Staff");
const TEAMMATE = u(3, "ops@nodeops.test", "Nia Ops");
const FOUNDER = u(4, "founder@acme-plumbing.test", "Ada Founder");
const SECOND = u(5, "second@acme-plumbing.test", "Sid Second");
const FAKE_OWNER = u(6, "boss@bayside-hvac.test", "Bo Boss");
const RETRY = u(7, "retry@bayside-hvac.test", "Rae Retry");

const in7d = () => new Date(Date.now() + 7 * 864e5).toISOString();

async function mintInvite(
  db: Client,
  tenantId: string,
  email: string,
  opts: { role?: string; kind?: "member" | "owner_claim" } = {},
): Promise<{ id: string; raw: string }> {
  const raw = randomBytes(24).toString("base64url");
  const id = `inv-${randomBytes(4).toString("hex")}`;
  await db.execute({
    sql: `INSERT INTO tenant_invites (id, tenant_id, email, team_role, token_hash, created_by, expires_at${opts.kind ? ", kind" : ""})
          VALUES (?, ?, ?, ?, ?, ?, ?${opts.kind ? ", ?" : ""})`,
    args: [
      id,
      tenantId,
      email,
      opts.role ?? "member",
      createHash("sha256").update(raw).digest("hex"),
      CC.id,
      in7d(),
      ...(opts.kind ? [opts.kind] : []),
    ],
  });
  return { id, raw };
}

async function one(db: Client, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown> | undefined> {
  const rs = await db.execute({ sql, args });
  return rs.rows[0] as Record<string, unknown> | undefined;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await createBaseSchema(db);

  // ── Before bravo__196: no `kind` column. Redemption must still work. ──────
  await seedTenant(db, OASIS, "oasis-ai-cc", "OASIS AI");
  await seedAuthUser(db, CC);
  await seedProfile(db, CC, OASIS, { role: "owner", owner: true, onboarded: true, agents: ["bravo", "atlas", "maven", "aura"] });
  await seedTenant(db, BAYSIDE, "bayside-hvac", "Bayside HVAC");
  const { redeemInvite } = await import("../lib/team");

  await check("before bravo__196 (no kind column), a member invite still redeems", async () => {
    const early = u(8, "early@bayside-hvac.test", "Eli Early");
    await seedAuthUser(db, early);
    const inv = await mintInvite(db, BAYSIDE, early.email);
    const r = await redeemInvite(inv.raw, early.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    const p = await one(db, `SELECT tenant_id, is_owner, team_role FROM user_profiles WHERE auth_user_id = ?`, [early.id]);
    assert.equal(p?.tenant_id, BAYSIDE);
    assert.equal(Number(p?.is_owner), 0);
  });

  await applyMigration196(db);

  await check("migration 196: existing invites read as 'member', and a bad kind is refused", async () => {
    const row = await one(db, `SELECT kind FROM tenant_invites LIMIT 1`);
    assert.equal(row?.kind, "member");
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO tenant_invites (tenant_id, email, token_hash, created_by, expires_at, kind) VALUES (?, 'x@y.z', 'h-bad', ?, ?, 'admin')`,
        args: [BAYSIDE, CC.id, in7d()],
      }),
      /CHECK constraint failed/,
    );
    const runs = await one(db, `SELECT COUNT(*) AS n FROM provisioning_runs`);
    assert.equal(Number(runs?.n), 0, "provisioning_runs exists after 196");
  });

  // ── A member invite into a workspace with NO manifest ────────────────────
  await seedAuthUser(db, STAFF);
  const staffInvite = await mintInvite(db, BAYSIDE, STAFF.email);

  await check("route: a member invite into a workspace with no manifest returns 200 and attaches the profile", async () => {
    setSessionCookie(await signFor(STAFF));
    const { POST } = await import("../app/api/auth/redeem-invite/route");
    const res = await POST(
      new NextRequest("https://oasisai.work/api/auth/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `oasis_session=${await signFor(STAFF)}` },
        body: JSON.stringify({ raw_token: staffInvite.raw }),
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.tenant_id, BAYSIDE);
    assert.equal(body.tenant_slug, "bayside-hvac");
    const p = await one(db, `SELECT tenant_id, team_role, is_owner, agents_enabled, primary_agent, brand FROM user_profiles WHERE auth_user_id = ?`, [STAFF.id]);
    assert.equal(p?.tenant_id, BAYSIDE, "profile attached to the inviting workspace");
    assert.equal(p?.team_role, "member");
    assert.equal(Number(p?.is_owner), 0);
    assert.equal(p?.agents_enabled, "[]", "a workspace not set up gives no agents, never OASIS's bravo");
    assert.equal(p?.primary_agent, "");
    assert.equal(p?.brand, "Bayside HVAC", "the profile carries the workspace's own name");
    const inv = await one(db, `SELECT redeemed_at, redeemed_by FROM tenant_invites WHERE id = ?`, [staffInvite.id]);
    assert.ok(inv?.redeemed_at, "invite claimed");
    assert.equal(inv?.redeemed_by, STAFF.id);
    // The session was re-minted with the onboarding claim for the new state.
    const payload = sessionPayloadFromSetCookie(res as unknown as Response);
    assert.equal(payload?.onb, "done", "a member of a workspace is not gated");
  });

  await check("a retry is idempotent: ok, nothing rewritten, invite claimed exactly once", async () => {
    const before = await one(db, `SELECT redeemed_at FROM tenant_invites WHERE id = ?`, [staffInvite.id]);
    const r = await redeemInvite(staffInvite.raw, STAFF.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.alreadyMember, true, "the retry recovers instead of re-running finalization");
      assert.equal(r.tenantSlug, "bayside-hvac");
    }
    const after = await one(db, `SELECT redeemed_at FROM tenant_invites WHERE id = ?`, [staffInvite.id]);
    assert.equal(after?.redeemed_at, before?.redeemed_at, "the claim is not re-stamped");
    const n = await one(db, `SELECT COUNT(*) AS n FROM user_profiles WHERE auth_user_id = ?`, [STAFF.id]);
    assert.equal(Number(n?.n), 1);
  });

  // ── The manifest is found by TENANT ID ───────────────────────────────────
  await check("a workspace whose manifest is saved under another slug still gives its teammates", async () => {
    await seedTenant(db, NODEOPS, "malikfaysalawan", "NodeOps");
    const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
    const manifest = finalizeManifestFromWizard({
      template: "custom",
      slug: "nodeops-control-center",
      answers: { departments: ["sales", "client_success"] },
    });
    await db.execute({
      sql: `INSERT INTO tenant_manifests (tenant_id, slug, manifest) VALUES (?, 'nodeops-control-center', ?)`,
      args: [NODEOPS, JSON.stringify(manifest)],
    });
    await seedAuthUser(db, TEAMMATE);
    const inv = await mintInvite(db, NODEOPS, TEAMMATE.email);
    const r = await redeemInvite(inv.raw, TEAMMATE.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    const p = await one(db, `SELECT agents_enabled, primary_agent FROM user_profiles WHERE auth_user_id = ?`, [TEAMMATE.id]);
    assert.deepEqual(JSON.parse(String(p?.agents_enabled)), ["sdr"], "the manifest's primary neutral teammate");
    assert.equal(p?.primary_agent, "sdr");
  });

  // ── A failure never uses up the invite ───────────────────────────────────
  await seedAuthUser(db, RETRY);
  const retryInvite = await mintInvite(db, BAYSIDE, RETRY.email);

  await check("a failure while deciding the profile leaves the invite unclaimed and no profile", async () => {
    await db.execute(`ALTER TABLE tenant_manifests RENAME TO tenant_manifests_hidden`);
    try {
      const r = await redeemInvite(retryInvite.raw, RETRY.id);
      assert.deepEqual(r, { ok: false, error: "profile_finalize_failed" });
    } finally {
      await db.execute(`ALTER TABLE tenant_manifests_hidden RENAME TO tenant_manifests`);
    }
    const inv = await one(db, `SELECT redeemed_at, redeemed_by FROM tenant_invites WHERE id = ?`, [retryInvite.id]);
    assert.equal(inv?.redeemed_at, null, "invite NOT used up");
    assert.equal(inv?.redeemed_by, null);
    const n = await one(db, `SELECT COUNT(*) AS n FROM user_profiles WHERE auth_user_id = ?`, [RETRY.id]);
    assert.equal(Number(n?.n), 0, "no half-made member");
  });

  await check("a failure inside the write itself rolls the claim back", async () => {
    await db.execute(`CREATE TRIGGER refuse_profile BEFORE INSERT ON user_profiles
                      BEGIN SELECT RAISE(ABORT, 'forced profile failure'); END`);
    try {
      const r = await redeemInvite(retryInvite.raw, RETRY.id);
      assert.equal(r.ok, false);
    } finally {
      await db.execute(`DROP TRIGGER refuse_profile`);
    }
    const inv = await one(db, `SELECT redeemed_at FROM tenant_invites WHERE id = ?`, [retryInvite.id]);
    assert.equal(inv?.redeemed_at, null, "claim and profile commit together or not at all");
  });

  await check("after either failure, the same invite still works", async () => {
    const r = await redeemInvite(retryInvite.raw, RETRY.id);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  // ── Ownership comes only from an owner_claim invite ──────────────────────
  await seedTenant(db, ACME, "acme-plumbing", "Acme Plumbing");

  await check("an owner_claim invite yields is_owner=1 and team_role owner", async () => {
    await seedAuthUser(db, FOUNDER);
    const inv = await mintInvite(db, ACME, FOUNDER.email, { role: "owner", kind: "owner_claim" });
    const r = await redeemInvite(inv.raw, FOUNDER.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.equal(r.teamRole, "owner");
    const p = await one(db, `SELECT is_owner, team_role, brand FROM user_profiles WHERE auth_user_id = ?`, [FOUNDER.id]);
    assert.equal(Number(p?.is_owner), 1);
    assert.equal(p?.team_role, "owner");
    assert.equal(p?.brand, "Acme Plumbing");
  });

  await check("a second owner_claim invite is refused and stays unclaimed", async () => {
    await seedAuthUser(db, SECOND);
    const inv = await mintInvite(db, ACME, SECOND.email, { role: "owner", kind: "owner_claim" });
    const r = await redeemInvite(inv.raw, SECOND.id);
    assert.deepEqual(r, { ok: false, error: "workspace_already_has_owner" });
    const row = await one(db, `SELECT redeemed_at FROM tenant_invites WHERE id = ?`, [inv.id]);
    assert.equal(row?.redeemed_at, null);
  });

  // ── The founder is ALREADY a member (every signup_tenant / CLI workspace) ──
  const SOLO = "50105010-0000-4000-8000-000000005010";
  const CREATOR = u(10, "creator@solo.test", "Cleo Creator");
  const SLEEPER = u(11, "sleeper@solo.test", "Sol Sleeper");
  await seedTenant(db, SOLO, "solo", "Solo Studio");
  for (const who of [CREATOR, SLEEPER]) await seedAuthUser(db, who);
  await seedProfile(db, CREATOR, SOLO, { role: "member" }); // creator, never made owner
  await seedProfile(db, SLEEPER, SOLO, { role: "member" });
  await db.execute({ sql: `UPDATE user_profiles SET deactivated_at = ? WHERE auth_user_id = ?`, args: [new Date().toISOString(), SLEEPER.id] });

  await check("an owner invite to someone already in the workspace makes them the owner (claimed, not a silent no-op)", async () => {
    const inv = await mintInvite(db, SOLO, CREATOR.email, { role: "owner", kind: "owner_claim" });
    const r = await redeemInvite(inv.raw, CREATOR.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.teamRole, "owner");
      assert.notEqual(r.alreadyMember, true, "something was written");
    }
    const p = await one(db, `SELECT is_owner, team_role, tenant_id FROM user_profiles WHERE auth_user_id = ?`, [CREATOR.id]);
    assert.equal(Number(p?.is_owner), 1);
    assert.equal(p?.team_role, "owner");
    assert.equal(p?.tenant_id, SOLO, "still the same workspace");
    const row = await one(db, `SELECT redeemed_at, redeemed_by FROM tenant_invites WHERE id = ?`, [inv.id]);
    assert.ok(row?.redeemed_at, "the invite is claimed, so the console stops showing it as pending");
    assert.equal(row?.redeemed_by, CREATOR.id);
    const again = await redeemInvite(inv.raw, CREATOR.id);
    assert.equal(again.ok, true, "a retry is idempotent");
    const owners = await one(db, `SELECT COUNT(*) AS n FROM user_profiles WHERE tenant_id = ? AND is_owner = 1`, [SOLO]);
    assert.equal(Number(owners?.n), 1);
  });

  await check("a deactivated member's owner invite is refused and stays unclaimed", async () => {
    await db.execute({ sql: `UPDATE user_profiles SET is_owner = 0, team_role = 'member' WHERE auth_user_id = ?`, args: [CREATOR.id] });
    try {
      const inv = await mintInvite(db, SOLO, SLEEPER.email, { role: "owner", kind: "owner_claim" });
      const r = await redeemInvite(inv.raw, SLEEPER.id);
      assert.deepEqual(r, { ok: false, error: "member_deactivated" });
      const row = await one(db, `SELECT redeemed_at FROM tenant_invites WHERE id = ?`, [inv.id]);
      assert.equal(row?.redeemed_at, null);
      const p = await one(db, `SELECT is_owner FROM user_profiles WHERE auth_user_id = ?`, [SLEEPER.id]);
      assert.equal(Number(p?.is_owner), 0);
      const { inviteRedeemFailure } = await import("../lib/invite-redeem-errors");
      assert.doesNotMatch(inviteRedeemFailure("member_deactivated").message, /member_deactivated/);
    } finally {
      await db.execute({ sql: `UPDATE user_profiles SET is_owner = 1, team_role = 'owner' WHERE auth_user_id = ?`, args: [CREATOR.id] });
    }
  });

  await check("a MEMBER invite to someone already in the workspace changes nothing and is not claimed", async () => {
    const inv = await mintInvite(db, SOLO, CREATOR.email);
    const r = await redeemInvite(inv.raw, CREATOR.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.equal(r.alreadyMember, true);
    const p = await one(db, `SELECT is_owner, team_role FROM user_profiles WHERE auth_user_id = ?`, [CREATOR.id]);
    assert.equal(p?.team_role, "owner", "their role is untouched");
  });

  await check("a MEMBER invite whose row says team_role 'owner' joins as a member, never an owner", async () => {
    await seedAuthUser(db, FAKE_OWNER);
    const inv = await mintInvite(db, BAYSIDE, FAKE_OWNER.email, { role: "owner" });
    const r = await redeemInvite(inv.raw, FAKE_OWNER.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    const p = await one(db, `SELECT is_owner, team_role FROM user_profiles WHERE auth_user_id = ?`, [FAKE_OWNER.id]);
    assert.equal(Number(p?.is_owner), 0);
    assert.equal(p?.team_role, "member");
  });

  // ── What the person is told ──────────────────────────────────────────────
  await check("route: a failed redemption answers with a sentence, never the raw code", async () => {
    const stranger = u(9, "stranger@elsewhere.test", "Stan Ger");
    await seedAuthUser(db, stranger);
    const { POST } = await import("../app/api/auth/redeem-invite/route");
    setSessionCookie(await signFor(stranger));
    const res = await POST(
      new NextRequest("https://oasisai.work/api/auth/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_token: randomBytes(24).toString("base64url") }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(res.status, 410);
    assert.match(body.message, /no longer active/);
    assert.doesNotMatch(body.message, /^[a-z_]+$/, "a person reads a sentence");
  });

  await check("every failure code maps to a sentence; profile_finalize_failed says the invite still works", async () => {
    const { inviteRedeemFailure, inviteRedeemMessage } = await import("../lib/invite-redeem-errors");
    const f = inviteRedeemFailure("profile_finalize_failed");
    assert.equal(f.retryable, true);
    assert.match(f.message, /invite is still valid/);
    assert.equal(inviteRedeemMessage({ error: "profile_finalize_failed" }), f.message);
    assert.equal(inviteRedeemMessage({ message: "profile_finalize_failed" }), f.message, "a bare code in `message` is still translated");
    assert.doesNotMatch(inviteRedeemMessage({ error: "something_new" }), /something_new/);
  });

  await check("signup page: sentences not codes, a retry that keeps the invite, no Google button under Turso", () => {
    const page = readFileSync("app/signup/page.tsx", "utf8");
    assert.ok(page.includes("setErr(inviteRedeemMessage(rb))"), "redeem failures render the sentence");
    assert.ok(!/setErr\(rb\.message \|\| rb\.error/.test(page), "the raw rb.error fallback is gone");
    assert.ok(page.includes("Try joining again"), "a retryable failure offers a retry that reuses the session");
    assert.match(page, /googleSignup === true && \(/, "Google signup renders only when the backend supports it");
    assert.ok(page.includes('setGoogleSignup(mode !== "turso")'));
    const invite = readFileSync("app/invite/[token]/page.tsx", "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert.doesNotMatch(invite, /leave\s+the workspace at any time/, "no promise of a leave control that does not exist");
  });

  db.close();
  finish("invite-redeem");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
