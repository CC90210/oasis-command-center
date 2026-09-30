/**
 * middleware-turso-onboarding.test.ts - the onboarding gate under Turso auth,
 * and the anonymous "/" loop on a self-hosted server.
 *
 * WHY THIS EXISTS (2026-09-29 audit, onboarding-gate-dead-in-turso-mode and
 * standalone-anon-root-loop). middleware.ts ran the onboarding gate only in its
 * Supabase branch; production runs the Turso branch, which let every page
 * through. It cannot query the database at the edge, so the gate's answer is
 * computed when a session is minted (lib/onboarding-claim.ts) and carried in
 * the signed cookie. Separately, under `next start` the "/" -> "/home" rewrite
 * re-entered middleware, hit the "/home" -> "/" redirect and looped forever.
 *
 * Pinned here, against the REAL middleware and REAL libSQL:
 *   - an un-onboarded session is redirected (wizard / welcome), a done or
 *     legacy (claim-less) session is not, /api/* and /onboarding/* never are;
 *   - a forged claim is worthless without the signature;
 *   - the claim is computed from the database the way the gate decides:
 *     owner of an unprovisioned workspace -> wizard, tenant-less invitee ->
 *     welcome, a member or the owner of a set-up workspace -> done;
 *   - the password login mints the claim;
 *   - the /home internal rewrite is not redirected back to "/".
 *
 * Run: node --conditions=react-server --import tsx tests/middleware-turso-onboarding.test.ts
 */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";
import {
  applyMigration196,
  check,
  createBaseSchema,
  finish,
  OASIS,
  SECRET,
  seedAuthUser,
  seedProfile,
  seedTenant,
  sessionPayloadFromSetCookie,
  setupOnboardingEnv,
  signFor,
  type SeedUser,
} from "./_onboarding-fixture";

const { dbFile } = setupOnboardingEnv("mw-onboarding");

const ACME = "a0c3e000-0000-4000-8000-00000000ac3e"; // not set up
const BAYSIDE = "b0b0b000-0000-4000-8000-00000000b0b0"; // set up
const u = (n: number, email: string, name: string): SeedUser => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email, name });
const CC = u(1, "conaugh@oasisai.work", "Conaugh McKenna");
const FOUNDER = u(2, "founder@acme-plumbing.test", "Ada Founder");
const ACME_STAFF = u(3, "staff@acme-plumbing.test", "Sam Staff");
const ORPHAN = u(4, "orphan@elsewhere.test", "Orla Orphan");
const BAYSIDE_OWNER = u(5, "owner@bayside-hvac.test", "Olive Owner");
const DETACHED = u(6, "detached@nowhere.test", "Dee Tached"); // no workspace, never invited

function page(path: string, cookie?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://oasisai.work${path}`, {
    headers: { ...(cookie ? { cookie: `oasis_session=${cookie}` } : {}), ...headers },
  });
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await createBaseSchema(db);
  await applyMigration196(db);
  await seedTenant(db, OASIS, "oasis-ai-cc", "OASIS AI");
  await seedTenant(db, ACME, "acme-plumbing", "Acme Plumbing");
  await seedTenant(db, BAYSIDE, "bayside-hvac", "Bayside HVAC");
  for (const who of [CC, FOUNDER, ACME_STAFF, ORPHAN, BAYSIDE_OWNER, DETACHED]) await seedAuthUser(db, who);
  await seedProfile(db, DETACHED, null, {});
  await seedProfile(db, CC, OASIS, { role: "owner", owner: true, onboarded: false, agents: ["bravo"] });
  await seedProfile(db, FOUNDER, ACME, { role: "owner", owner: true, invitedBy: CC.id });
  await seedProfile(db, ACME_STAFF, ACME, { role: "member", invitedBy: CC.id });
  await seedProfile(db, ORPHAN, null, { invitedBy: CC.id });
  await seedProfile(db, BAYSIDE_OWNER, BAYSIDE, { role: "owner", owner: true, invitedBy: CC.id });
  await db.execute({
    sql: `INSERT INTO tenant_manifests (tenant_id, slug, manifest) VALUES (?, 'bayside-hvac', '{}')`,
    args: [BAYSIDE],
  });

  const { middleware } = await import("../middleware");

  await check("the Turso-mode middleware redirects an un-onboarded session to the wizard", async () => {
    const res = await middleware(page("/pipeline", await signFor(FOUNDER, "wizard")));
    assert.equal(res.status, 307);
    assert.equal(new URL(res.headers.get("location") || "").pathname, "/onboarding/wizard");
  });

  await check("an invitee whose join did not finish goes to the welcome flow", async () => {
    const res = await middleware(page("/", await signFor(ORPHAN, "welcome")));
    assert.equal(res.status, 307);
    assert.equal(new URL(res.headers.get("location") || "").pathname, "/onboarding/welcome");
  });

  await check("a finished session and a legacy cookie with no claim pass through", async () => {
    for (const cookie of [await signFor(BAYSIDE_OWNER, "done"), await signFor(BAYSIDE_OWNER)]) {
      const res = await middleware(page("/pipeline", cookie));
      assert.equal(res.headers.get("x-middleware-next"), "1", "passed to the page");
      assert.equal(res.headers.get("location"), null);
    }
  });

  await check("API calls and the onboarding flows themselves are never redirected", async () => {
    const cookie = await signFor(FOUNDER, "wizard");
    for (const path of ["/api/onboarding/wizard", "/onboarding/wizard", "/onboarding/welcome"]) {
      const res = await middleware(page(path, cookie));
      assert.equal(res.headers.get("location"), null, path);
    }
  });

  await check("a claim without a valid signature is worthless", async () => {
    const good = await signFor(FOUNDER, "done");
    const body = good.slice(0, good.lastIndexOf("."));
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, onb: "welcome" }), "utf8").toString("base64url");
    const res = await middleware(page("/pipeline", `${forgedBody}.${good.slice(good.lastIndexOf(".") + 1)}`));
    assert.equal(res.status, 307);
    assert.equal(new URL(res.headers.get("location") || "").pathname, "/login", "a tampered cookie is no session");
  });

  await check("the claim is computed from the database the way the gate decides", async () => {
    const { computeOnboardingState } = await import("../lib/onboarding-claim");
    assert.equal((await computeOnboardingState(db, FOUNDER.id)).claim, "wizard", "owner of a workspace not set up");
    assert.equal((await computeOnboardingState(db, ACME_STAFF.id)).claim, "done", "a member is never sent to the wizard");
    assert.equal((await computeOnboardingState(db, ORPHAN.id)).claim, "welcome", "tenant-less invitee");
    assert.equal((await computeOnboardingState(db, BAYSIDE_OWNER.id)).claim, "done", "owner of a set-up workspace");
    assert.equal((await computeOnboardingState(db, CC.id)).claim, "done", "OASIS's own workspace is set up in code");
    assert.equal((await computeOnboardingState(db, "no-such-user")).claim, "done", "no profile: no gate");
  });

  await check("an account with no workspace and no invite is never sent to the wizard (it would loop)", async () => {
    // The wizard serves only a workspace owner and refuses anyone without a
    // workspace; its refusal page linked to "/", which this claim sent straight
    // back to the wizard, on every page until the next login.
    const { computeOnboardingState } = await import("../lib/onboarding-claim");
    assert.equal((await computeOnboardingState(db, DETACHED.id)).claim, "done");
    const { wizardAccess } = await import("../lib/provisioning/wizard-access");
    const access = await wizardAccess({ id: DETACHED.id, email: DETACHED.email });
    assert.equal(access.ok, false, "the wizard would refuse this account");
  });

  await check("the password login mints the claim into the session cookie", async () => {
    const bcrypt = await import("bcryptjs");
    await db.execute({
      sql: `UPDATE "_supabase_auth_users" SET encrypted_password = ? WHERE id = ?`,
      args: [bcrypt.hashSync("Local-test-pass-1", 4).replace(/^\$2b\$/, "$2a$"), FOUNDER.id],
    });
    process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
    process.env.TURSO_AUTH_TOKEN = "local-test-token";
    try {
      const { POST } = await import("../app/api/auth/turso-login/route");
      const res = await POST(
        new NextRequest("https://oasisai.work/api/auth/turso-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: FOUNDER.email, password: "Local-test-pass-1" }),
        }),
      );
      assert.equal(res.status, 200);
      assert.equal(sessionPayloadFromSetCookie(res as unknown as Response)?.onb, "wizard");
    } finally {
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_AUTH_TOKEN;
    }
  });

  await check("the onboarding-refresh route re-mints a stale claim and continues same-origin only", async () => {
    const { setSessionCookie } = await import("./_onboarding-fixture");
    const stale = await signFor(BAYSIDE_OWNER, "wizard");
    setSessionCookie(stale);
    const { GET } = await import("../app/api/auth/onboarding-refresh/route");
    const res = await GET(page("/api/auth/onboarding-refresh?next=/pipeline", stale));
    assert.equal(new URL(res.headers.get("location") || "").pathname, "/pipeline");
    assert.equal(sessionPayloadFromSetCookie(res as unknown as Response)?.onb, "done");
    const evil = await GET(page("/api/auth/onboarding-refresh?next=//evil.example/x", stale));
    assert.equal(new URL(evil.headers.get("location") || "").host, "oasisai.work");
  });

  await check("the /home internal rewrite is not redirected back to '/' (standalone server loop)", async () => {
    const anon = await middleware(page("/"));
    assert.ok(anon.headers.get("x-middleware-rewrite")?.endsWith("/home"), "anonymous / is rewritten to /home");
    const override = anon.headers.get("x-middleware-override-headers") || "";
    assert.ok(override.includes("x-oasis-home-rewrite"), "the rewrite marks its request");
    const rerun = await middleware(page("/home", undefined, { "x-oasis-home-rewrite": "1" }));
    assert.equal(rerun.headers.get("location"), null, "the re-run of the rewrite is served, not redirected");
    const direct = await middleware(page("/home"));
    assert.equal(direct.status, 307, "a visitor typing /home still lands on the one canonical address");
    assert.equal(new URL(direct.headers.get("location") || "").pathname, "/");
  });

  assert.ok(SECRET.length >= 32);
  db.close();
  finish("middleware-turso-onboarding");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
