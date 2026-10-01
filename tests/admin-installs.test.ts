/**
 * admin-installs.test.ts - OASIS sets up a client workspace and invites its
 * founder, against REAL libSQL, the real routes and the real page gate.
 *
 * WHY THIS EXISTS (2026-09-29 audit, no-operator-provisioning-path). OASIS had
 * no way to set up a client workspace: the manifest routes judge a write by the
 * caller's own workspace (OASIS's), team invites never mint an owner, and
 * production had 0 provisioning runs. An invited founder landed on "being set
 * up" forever.
 *
 * Pinned here:
 *   - /admin/installs and every /api/admin/installs route are operator-only
 *     (a client owner, an OASIS rep and a signed-out browser get a 404);
 *   - Provision writes the manifest under the workspace's own address with
 *     neutral department teammates, records every step in provisioning_runs,
 *     writes the manifest audit row and the operator-exemption audit row, and
 *     gives members who joined earlier the new teammates;
 *   - OASIS's own and retired workspaces are refused;
 *   - "Send owner invite" mints kind='owner_claim' and ONLY that route can
 *     (team invites keep refusing "owner"); it refuses a workspace that has an
 *     owner, and says so (503) before migration 196 is applied;
 *   - redeeming that invite makes the founder the owner, who then sees the
 *     workspace's own name in the header and the real setup steps;
 *   - no workspace name defaults to "OASIS AI" any more.
 *
 * Run: node --conditions=react-server --import tsx tests/admin-installs.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  setSessionCookie,
  setupOnboardingEnv,
  signFor,
  type SeedUser,
} from "./_onboarding-fixture";

const { dbFile } = setupOnboardingEnv("admin-installs");
process.env.OPERATOR_EMAIL = "conaugh@oasisai.work";

const BAYSIDE = "b0b0b000-0000-4000-8000-00000000b0b0";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const u = (n: number, email: string, name: string): SeedUser => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email, name });
const CC = u(1, "conaugh@oasisai.work", "Conaugh McKenna");
const REP = u(2, "rep@oasisai.work", "Riley Rep");
const EARLY = u(3, "early@bayside-hvac.test", "Eli Early");
const FOUNDER = u(4, "founder@acme-plumbing.test", "Ada Founder");

async function one(db: Client, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown> | undefined> {
  return (await db.execute({ sql, args })).rows[0] as Record<string, unknown> | undefined;
}

function post(path: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`https://oasisai.work${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `oasis_session=${cookie}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function as(who: SeedUser | null): Promise<void> {
  setSessionCookie(who ? await signFor(who) : undefined);
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await createBaseSchema(db); // tenant_invites WITHOUT kind: migration 196 not applied yet
  await db.execute(`CREATE TABLE IF NOT EXISTS provisioning_runs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, tenant_slug TEXT,
    stripe_invoice TEXT, status TEXT DEFAULT 'pending', steps_json TEXT DEFAULT '[]', error_message TEXT,
    started_at TEXT, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await seedTenant(db, OASIS, "oasis-ai-cc", "OASIS AI");
  await seedTenant(db, BAYSIDE, "bayside-hvac", "Bayside HVAC");
  await seedTenant(db, SUNBIZ, "submissions", "Sun Biz Funding");
  for (const who of [CC, REP, EARLY, FOUNDER]) await seedAuthUser(db, who);
  await seedProfile(db, CC, OASIS, { role: "owner", owner: true, onboarded: true, agents: ["bravo"] });
  await seedProfile(db, REP, OASIS, { role: "closer", onboarded: true, agents: ["bravo"] });
  await seedProfile(db, EARLY, BAYSIDE, { role: "member", invitedBy: CC.id }); // joined before setup: no agents

  const list = await import("../app/api/admin/installs/route");
  const provision = await import("../app/api/admin/installs/[tenantId]/provision/route");
  const ownerInvite = await import("../app/api/admin/installs/[tenantId]/owner-invite/route");
  const params = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) });
  const choices = { departments: ["sales", "client_success", "finance"], modules: ["content", "prospects"], chat_apps: ["slack"], jev: "off" };

  await check("/admin/installs and its API are operator-only (404 for everyone else)", async () => {
    const { default: Page } = await import("../app/admin/installs/page");
    for (const who of [null, REP, EARLY]) {
      await as(who);
      await assert.rejects(Page(), /NEXT_HTTP_ERROR_FALLBACK;404/, `page for ${who?.email ?? "signed out"}`);
      const res = await list.GET();
      assert.equal(res.status, 404, `GET for ${who?.email ?? "signed out"}`);
      const p = await provision.POST(post(`/api/admin/installs/${BAYSIDE}/provision`, choices), params(BAYSIDE));
      assert.equal(p.status, 404);
      const i = await ownerInvite.POST(post(`/api/admin/installs/${BAYSIDE}/owner-invite`, { email: "x@y.test" }), params(BAYSIDE));
      assert.equal(i.status, 404);
    }
    const runs = await one(db, `SELECT COUNT(*) AS n FROM provisioning_runs`);
    assert.equal(Number(runs?.n), 0, "a refused caller wrote nothing");
  });

  await check("the operator sees every workspace: name, owner, members, set up or not, last activity", async () => {
    await as(CC);
    const res = await list.GET();
    const json = (await res.json()) as { ok: boolean; installs: Array<Record<string, unknown>> };
    assert.equal(res.status, 200);
    const bayside = json.installs.find((i) => i.tenantId === BAYSIDE);
    assert.equal(bayside?.name, "Bayside HVAC");
    assert.equal(bayside?.kind, "client");
    assert.equal(bayside?.members, 1);
    assert.equal(bayside?.ownerEmail, null);
    assert.equal(bayside?.manifestSlug, null, "not set up yet");
    assert.ok(bayside?.lastActivity, "last activity comes from real rows");
    assert.equal(json.installs.find((i) => i.tenantId === OASIS)?.kind, "oasis");
    assert.equal(json.installs.find((i) => i.tenantId === SUNBIZ)?.kind, "retired");
  });

  await check("Provision writes the manifest and provisioning_runs, with audit rows", async () => {
    await as(CC);
    const res = await provision.POST(post(`/api/admin/installs/${BAYSIDE}/provision`, choices), params(BAYSIDE));
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    const row = await one(db, `SELECT slug, tenant_id, manifest, version FROM tenant_manifests WHERE tenant_id = ?`, [BAYSIDE]);
    assert.equal(row?.slug, "bayside-hvac", "saved under the workspace's own address");
    const m = JSON.parse(String(row?.manifest)) as {
      agents: Array<{ slug: string; display_name: string }>;
      os: { departments: string[]; modules: string[] };
      integrations: { chat_apps: string[]; jev: string };
      brand: { name: string };
      permissions: Record<string, boolean>;
    };
    assert.deepEqual(m.agents.map((a) => a.display_name), ["Sales lead", "Client Success lead"]);
    assert.doesNotMatch(JSON.stringify(m), /\b(bravo|atlas|maven|aura|solara|helios)\b/i, "no house or SunBiz agent in a client manifest");
    assert.deepEqual(m.os.departments, ["chief_of_staff", "sales", "client_success", "finance"]);
    assert.deepEqual(m.os.modules, ["content", "finance"], "OASIS-only modules are not offered to a client; the Finance department records its module");
    assert.deepEqual(m.integrations, { chat_apps: ["slack"], jev: "off" });
    assert.equal(m.brand.name, "Bayside HVAC");
    assert.deepEqual(m.permissions, { local_files: false, computer_control: false, web_access: false });
    const run = await one(db, `SELECT status, steps_json, completed_at FROM provisioning_runs WHERE tenant_id = ?`, [BAYSIDE]);
    assert.equal(run?.status, "complete");
    assert.ok(run?.completed_at);
    const steps = (JSON.parse(String(run?.steps_json)) as Array<{ title: string }>).map((s) => s.title);
    assert.ok(steps.some((t) => /Saved the workspace setup \(version 1\)/.test(t)), steps.join(" | "));
    assert.ok(steps.some((t) => /Gave 1 existing member/.test(t)), "members who joined before setup get the teammates");
    assert.equal(steps[steps.length - 1], "Workspace ready");
    const early = await one(db, `SELECT agents_enabled, primary_agent FROM user_profiles WHERE auth_user_id = ?`, [EARLY.id]);
    assert.deepEqual(JSON.parse(String(early?.agents_enabled)), ["sdr", "customer-support"]);
    assert.equal(early?.primary_agent, "sdr");
    const audit = await one(db, `SELECT actor_type, actor_id, message FROM manifest_audit_log WHERE tenant_id = ?`, [BAYSIDE]);
    assert.equal(audit?.actor_id, CC.id, "the manifest audit row names the operator");
    const exemption = await one(db, `SELECT action_type FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'manifest.operator_provisioning_exemption'`, [BAYSIDE]);
    assert.ok(exemption, "the operator exemption is audited");
  });

  await check("the operator can create a new workspace and set it up in one step", async () => {
    await as(CC);
    const res = await list.POST(post("/api/admin/installs", { name: "Acme Plumbing", slug: "acme-plumbing", ...choices }));
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 201, JSON.stringify(json));
    const t = await one(db, `SELECT id, name FROM tenants WHERE slug = 'acme-plumbing'`);
    assert.equal(t?.name, "Acme Plumbing");
    const m = await one(db, `SELECT slug FROM tenant_manifests WHERE tenant_id = ?`, [String(t?.id)]);
    assert.equal(m?.slug, "acme-plumbing");
    const dup = await list.POST(post("/api/admin/installs", { name: "Other", slug: "acme-plumbing", ...choices }));
    assert.equal(dup.status, 409, "an address already in use is refused");
  });

  await check("OASIS's own and retired workspaces are refused", async () => {
    await as(CC);
    for (const id of [OASIS, SUNBIZ]) {
      const res = await provision.POST(post(`/api/admin/installs/${id}/provision`, choices), params(id));
      assert.equal(res.status, 403, id);
      const inv = await ownerInvite.POST(post(`/api/admin/installs/${id}/owner-invite`, { email: "x@y.test" }), params(id));
      assert.equal(inv.status, 403, id);
    }
    const oasisManifest = await one(db, `SELECT COUNT(*) AS n FROM tenant_manifests WHERE tenant_id = ?`, [OASIS]);
    assert.equal(Number(oasisManifest?.n), 0);
  });

  await check("the manifest guard's operator exemption refuses a caller who is not an operator", async () => {
    const { crossTenantGuard } = await import("../lib/manifest/guards");
    const refused = await crossTenantGuard("bayside-hvac", OASIS, {
      kind: "operator_provisioning",
      operatorAuthUserId: REP.id,
      operatorEmail: REP.email,
      targetTenantId: BAYSIDE,
      reason: "test",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "operator_required");
    const plain = await crossTenantGuard("bayside-hvac", OASIS);
    assert.equal(plain.ok, false, "without the exemption OASIS still cannot write a client's manifest");
  });

  const acme = String((await one(db, `SELECT id FROM tenants WHERE slug = 'acme-plumbing'`))?.id);

  await check("before migration 196, the owner invite says what is missing (503)", async () => {
    await as(CC);
    const res = await ownerInvite.POST(post(`/api/admin/installs/${acme}/owner-invite`, { email: FOUNDER.email }), params(acme));
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 503, JSON.stringify(json));
    assert.equal(json.error, "migration_196_not_applied");
  });

  await applyMigration196(db);

  await check("'Send owner invite' mints kind='owner_claim' for the founder's email", async () => {
    await as(CC);
    const res = await ownerInvite.POST(post(`/api/admin/installs/${acme}/owner-invite`, { email: FOUNDER.email }), params(acme));
    const json = (await res.json()) as { ok: boolean; invite: { email_sent: boolean; invite_url: string | null } };
    assert.equal(res.status, 201, JSON.stringify(json));
    const row = await one(db, `SELECT kind, team_role, email, redeemed_at FROM tenant_invites WHERE tenant_id = ?`, [acme]);
    assert.equal(row?.kind, "owner_claim");
    assert.equal(row?.team_role, "owner");
    assert.equal(row?.email, FOUNDER.email);
    assert.equal(json.invite.email_sent, false, "no mailer in tests");
    assert.ok(json.invite.invite_url?.includes("/invite/"), "the link comes back once when the email did not send");
    const audit = await one(db, `SELECT action_type FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'invite.owner_claim.create'`, [acme]);
    assert.ok(audit);

    // The founder redeems it and becomes the owner.
    const token = new URL(json.invite.invite_url as string).pathname.split("/").pop() as string;
    const { redeemInvite } = await import("../lib/team");
    const r = await redeemInvite(decodeURIComponent(token), FOUNDER.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    const p = await one(db, `SELECT is_owner, team_role, agents_enabled FROM user_profiles WHERE auth_user_id = ?`, [FOUNDER.id]);
    assert.equal(Number(p?.is_owner), 1);
    assert.equal(p?.team_role, "owner");
    assert.deepEqual(JSON.parse(String(p?.agents_enabled)), ["sdr"], "the founder gets the workspace's teammates");
    assert.equal(createHash("sha256").update(decodeURIComponent(token)).digest("hex").length, 64);
  });

  await check("a workspace that already has an owner gets no second owner invite", async () => {
    await as(CC);
    const res = await ownerInvite.POST(post(`/api/admin/installs/${acme}/owner-invite`, { email: "second@acme-plumbing.test" }), params(acme));
    assert.equal(res.status, 409);
  });

  await check("only the owner-invite route can mint an owner; team invites keep refusing 'owner'", async () => {
    const { isInvitableRole } = await import("../lib/team-roles");
    assert.equal(isInvitableRole("owner"), false);
    const importers = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]
      .filter((f) => /from\s+["']@\/lib\/provisioning\/owner-invite["']/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(/\\/g, "/"));
    assert.deepEqual(importers, ["app/api/admin/installs/[tenantId]/owner-invite/route.ts"]);
    const mints = [...sourceFiles("app"), ...sourceFiles("lib")].filter((f) => /["']owner_claim["']/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
    assert.deepEqual(
      mints.map((f) => f.replace(/\\/g, "/")).sort(),
      ["lib/provisioning/owner-invite.ts", "lib/turso-rpc-shim.ts"],
      "only the minter writes the kind, and only redemption reads it",
    );
  });

  await check("the founder's setup page shows the real steps and the one OASIS contact address", async () => {
    await as(EARLY);
    const { ProvisioningProgress } = await import("../components/onboarding/ProvisioningProgress");
    const el = await ProvisioningProgress();
    const text = JSON.stringify(el);
    assert.ok(text.includes("Workspace ready"), "reads the recorded steps");
    assert.ok(text.includes("support@oasisai.work"), "Questions? <CONTACT_EMAIL>");
    const src = readFileSync("components/onboarding/ProvisioningProgress.tsx", "utf8");
    assert.ok(src.includes('import { CONTACT_EMAIL } from "@/lib/marketing/routes"'));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "no hard-coded address");
    assert.doesNotMatch(code, /Payment verified|setInterval|router\.refresh/, "claims nothing it did not read");
    const pending = readFileSync("components/os/today/WorkspaceSetupPending.tsx", "utf8");
    assert.ok(pending.includes("<ProvisioningProgress />"));
  });

  await check("the client shell header shows the workspace's own name", async () => {
    const { workspaceDisplayName, defaultWorkspaceName } = await import("../lib/provisioning/workspace-name");
    assert.equal(
      workspaceDisplayName({ tenantName: "Acme Plumbing", manifestBrand: "Something", profileBrand: "OASIS AI", isOasisWorkspace: false }),
      "Acme Plumbing",
      "tenants.name wins over the profile brand",
    );
    assert.equal(
      workspaceDisplayName({ tenantName: "OASIS AI", manifestBrand: "Your workspace", profileBrand: "OASIS AI", isOasisWorkspace: false }),
      "Your workspace",
      "a stranger's workspace never reads as OASIS's",
    );
    assert.equal(workspaceDisplayName({ tenantName: "OASIS AI", manifestBrand: null, profileBrand: null, isOasisWorkspace: true }), "OASIS AI");
    assert.equal(defaultWorkspaceName("Ada Founder", "founder@acme-plumbing.test"), "Ada's workspace");
    assert.equal(defaultWorkspaceName("", "sam.staff@x.test"), "Sam's workspace");
    const layout = readFileSync("app/layout.tsx", "utf8");
    assert.ok(layout.includes("const osWorkspaceName = ownWorkspaceName;"), "the OS header uses the rule");
    assert.ok(layout.includes(": ownWorkspaceName"), "so does the sidebar brand on the viewer's own shell");
    assert.doesNotMatch(layout, /profile\?\.brand \|\| manifest\??\.brand\.name/);
  });

  await check("no account path defaults a workspace to 'OASIS AI'", async () => {
    assert.doesNotMatch(readFileSync("app/auth/callback/route.ts", "utf8"), /\|\|\s*"OASIS AI"/);
    assert.doesNotMatch(readFileSync("app/api/auth/provision-cli/route.ts", "utf8"), /\|\|\s*"OASIS AI"/);
    const { signup_tenant } = await import("../lib/turso-rpc-shim");
    const out = (await signup_tenant(db, { p_auth_user_id: "0f000000-0000-4000-8000-000000000099", p_email: "new@nowhere.test", p_full_name: "Nell New" })) as { tenant_id: string };
    const t = await one(db, `SELECT name FROM tenants WHERE id = ?`, [out.tenant_id]);
    assert.equal(t?.name, "Nell's workspace");
    const p = await one(db, `SELECT brand, agents_enabled, primary_agent FROM user_profiles WHERE tenant_id = ?`, [out.tenant_id]);
    assert.equal(p?.brand, "Nell's workspace");
    assert.equal(p?.agents_enabled, "[]", "a new workspace starts with no agents, never OASIS's");
  });

  await check("provision-cli refuses every shell a new workspace must not get: retired SunBiz, OASIS's own, one client's", async () => {
    process.env.CLI_SIGNUP_SECRET = "provision-cli-test-secret-0000000001";
    const cli = await import("../app/api/auth/provision-cli/route");
    const before = await one(db, `SELECT (SELECT COUNT(*) FROM tenants) AS t, (SELECT COUNT(*) FROM "_supabase_auth_users") AS u`);
    for (const [shell, why] of [
      ["sun", /retired workspace/],
      ["suga", /one named client/],
      ["oasis-ai-cc", /OASIS's own shell/],
      ["default", /OASIS's own shell/],
      ["sunrise", /not a registered shell/],
    ] as const) {
      const res = await cli.POST(
        new NextRequest("https://oasisai.work/api/auth/provision-cli", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CLI_SIGNUP_SECRET}` },
          body: JSON.stringify({ email: `new-${shell}@client.test`, full_name: "New Client", client_profile_slug: shell }),
        }),
      );
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 400, `${shell}: ${JSON.stringify(json)}`);
      assert.match(JSON.stringify(json), why, shell);
    }
    const after = await one(db, `SELECT (SELECT COUNT(*) FROM tenants) AS t, (SELECT COUNT(*) FROM "_supabase_auth_users") AS u`);
    assert.deepEqual(after, before, "nothing was created for a refused shell");
    delete process.env.CLI_SIGNUP_SECRET;

    // And the retired SunBiz shell is never written onto any workspace, whoever asks.
    const { applyClientProvisioningProfile } = await import("../lib/client-provisioning");
    const { getServiceSupabase } = await import("../lib/supabase-server");
    await assert.rejects(
      applyClientProvisioningProfile({ db: getServiceSupabase(), tenantId: BAYSIDE, profileId: "p-x", clientProfileSlug: "sun" }),
      /retired workspace's shell/,
    );
    await assert.rejects(
      applyClientProvisioningProfile({ db: getServiceSupabase(), tenantId: BAYSIDE, profileId: "p-x", clientProfileSlug: "oasis-ai-cc" }),
      /OASIS's own shell/,
    );
    const bay = await one(db, `SELECT custom_fields FROM tenants WHERE id = ?`, [BAYSIDE]);
    assert.doesNotMatch(String(bay?.custom_fields), /"sun"/);
  });

  // ── Fix pass (2026-09-30): the review findings on this console ───────────
  const CUSTOM = "c0570000-0000-4000-8000-00000000c057";
  const GAP = "9a900000-0000-4000-8000-000000009a90";
  const BROKEN = "b0e00000-0000-4000-8000-00000000b0e0";
  const TYPO = "7e900000-0000-4000-8000-000000007e90";
  const SOLO = "50105010-0000-4000-8000-000000005010";
  const GAP_STAFF = u(5, "staff@gap.test", "Gil Gap");
  const CREATOR = u(6, "creator@solo.test", "Cleo Creator");
  await seedTenant(db, CUSTOM, "custom-co", "Custom Co");
  await seedTenant(db, GAP, "gap-co", "Gap Co");
  await seedTenant(db, BROKEN, "broken-co", "Broken Co");
  await seedTenant(db, TYPO, "typo-co", "Typo Co");
  await seedTenant(db, SOLO, "solo", "Solo Studio");
  for (const who of [GAP_STAFF, CREATOR]) await seedAuthUser(db, who);
  await seedProfile(db, GAP_STAFF, GAP, { role: "member", invitedBy: CC.id });
  await seedProfile(db, CREATOR, SOLO, { role: "member" }); // signup_tenant never set is_owner

  await check("'Set up again' keeps a customised setup's own parts; the audit diff is taken against what was stored", async () => {
    const { buildProvisionedManifest } = await import("../lib/provisioning/manifest");
    const base = buildProvisionedManifest({
      slug: "custom-co",
      name: "Custom Co",
      departments: ["chief_of_staff", "sales", "client_success"],
      modules: ["content"],
      chatApps: ["email"],
      jev: "off",
    });
    const stored = {
      ...base,
      brand: { ...base.brand, footer_tagline: "Our own tagline" },
      agents: [
        ...base.agents.map((a) => (a.slug === "sdr" ? { ...a, display_name: "Sam" } : a)),
        { slug: "report-writer", display_name: "Report writer", enabled: true },
      ],
      default_prompts: [{ agent_slug: "report-writer", label: "Weekly report", prompt: "Summarise the week." }],
    };
    await db.execute({
      sql: `INSERT INTO tenant_manifests (tenant_id, slug, manifest, version) VALUES (?, 'custom-co', ?, 3)`,
      args: [CUSTOM, JSON.stringify(stored)],
    });

    await as(CC);
    const listed = (await (await list.GET()).json()) as { installs: Array<{ tenantId: string; currentSetup: unknown }> };
    const current = listed.installs.find((i) => i.tenantId === CUSTOM)?.currentSetup as { departments: string[]; chatApps: string[] };
    assert.deepEqual(current.departments, ["chief_of_staff", "sales", "client_success"], "the console reads the stored choices");
    const { initialChoices } = await import("../components/admin/installs/outcome");
    const pre = initialChoices(current as never, ["chief_of_staff", "sales", "marketing", "client_success"], ["content", "ads"]);
    assert.deepEqual(pre, { departments: ["chief_of_staff", "sales", "client_success"], modules: ["content"], chatApps: ["email"], jev: "off" }, "the form starts from them, not the defaults");

    const res = await provision.POST(
      post(`/api/admin/installs/${CUSTOM}/provision`, { departments: ["sales", "finance"], modules: ["ads"], chat_apps: ["teams"], jev: "shadow" }),
      params(CUSTOM),
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const row = await one(db, `SELECT id, manifest, version FROM tenant_manifests WHERE tenant_id = ?`, [CUSTOM]);
    assert.equal(Number(row?.version), 4);
    const m = JSON.parse(String(row?.manifest)) as {
      brand: { footer_tagline: string; name: string };
      default_prompts: Array<{ label: string }>;
      agents: Array<{ slug: string; display_name: string; primary?: boolean }>;
      os: { departments: string[]; modules: string[] };
      integrations: { chat_apps: string[]; jev: string };
    };
    assert.equal(m.brand.footer_tagline, "Our own tagline", "the workspace's tagline stays");
    assert.deepEqual(m.default_prompts.map((p) => p.label), ["Weekly report"], "saved prompts stay");
    assert.deepEqual(
      m.agents.map((a) => [a.slug, a.display_name, !!a.primary]),
      [["sdr", "Sam", true], ["report-writer", "Report writer", false]],
      "a kept teammate keeps its name; a removed department's teammate goes; an added teammate stays",
    );
    assert.deepEqual(m.os, { departments: ["chief_of_staff", "sales", "finance"], modules: ["ads", "finance"] });
    assert.deepEqual(m.integrations, { chat_apps: ["teams"], jev: "shadow" });

    const audit = await one(
      db,
      `SELECT diff, message FROM manifest_audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
      [CUSTOM],
    );
    const diff = JSON.parse(String(audit?.diff)) as Array<{ op: string; path: string }>;
    assert.ok(diff.some((d) => d.op === "remove" && d.path === "agent[customer-support]"), JSON.stringify(diff));
    assert.ok(!diff.some((d) => d.path.startsWith("brand.") || d.path.startsWith("prompt[")), "nothing unchanged is recorded as changed");
    assert.match(String(audit?.message), /^Set up again by OASIS/);
    const run = await one(db, `SELECT steps_json FROM provisioning_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [CUSTOM]);
    assert.match(String(run?.steps_json), /and 1 teammate it added/);

    const { setupConfirmation } = await import("../components/admin/installs/outcome");
    assert.match(setupConfirmation("Custom Co", true), /replaces its departments.*Its own name, tagline, pages, saved prompts and the teammates it added stay/s);

    // The first-time confirmation must not promise that members see the chosen
    // departments: the rail draws every department without a module gate
    // whatever was ticked (2026-09-30 verifier walk: Operations, never chosen,
    // was in Delta Dental's rail). It promises what the save does change.
    const { OS_DEPARTMENTS } = await import("../lib/os/departments");
    const ungated = OS_DEPARTMENTS.filter((d) => !d.module).map((d) => d.key);
    assert.ok(ungated.includes("marketing") && ungated.includes("operations"), JSON.stringify(ungated));
    const first = setupConfirmation("Acme Plumbing", false);
    assert.doesNotMatch(first, /departments/i, first);
    assert.match(first, /see the workspace and its AI teammates on their next page load/);
  });

  await check("a stored setup that does not parse is never replaced, and the console says it is unreadable", async () => {
    await db.execute({ sql: `INSERT INTO tenant_manifests (tenant_id, slug, manifest, version) VALUES (?, 'broken-co', '{"not":"a manifest"}', 2)`, args: [BROKEN] });
    await as(CC);
    const res = await provision.POST(post(`/api/admin/installs/${BROKEN}/provision`, choices), params(BROKEN));
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 409, JSON.stringify(json));
    assert.equal(json.error, "stored_setup_unreadable");
    const row = await one(db, `SELECT manifest, version FROM tenant_manifests WHERE tenant_id = ?`, [BROKEN]);
    assert.equal(row?.manifest, '{"not":"a manifest"}');
    assert.equal(Number(row?.version), 2);
    const listed = (await (await list.GET()).json()) as { installs: Array<{ tenantId: string; currentSetup: unknown }> };
    assert.equal(listed.installs.find((i) => i.tenantId === BROKEN)?.currentSetup, "unreadable");
  });

  await check("'Create and set up' refuses a reserved or taken address BEFORE creating anything", async () => {
    await as(CC);
    await db.execute({ sql: `INSERT INTO tenant_manifests (tenant_id, slug, manifest) VALUES (?, 'nodeops-control-center', '{}')`, args: [TYPO] });
    for (const slug of ["sun", "suga", "default", "oasis", "sunbiz", "oasis-webdev", "unprovisioned", "nodeops-control-center"]) {
      const res = await list.POST(post("/api/admin/installs", { name: "Sunny Plumbing", slug, ...choices }));
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 409, `${slug}: ${JSON.stringify(json)}`);
      assert.ok(typeof json.message === "string" && /Pick another address/.test(json.message), slug);
      const t = await one(db, `SELECT COUNT(*) AS n FROM tenants WHERE slug = ?`, [slug]);
      assert.equal(Number(t?.n), 0, `no workspace row was left behind for "${slug}"`);
    }
    await db.execute({ sql: `DELETE FROM tenant_manifests WHERE slug = 'nodeops-control-center' AND tenant_id = ?`, args: [TYPO] });
  });

  await check("when the operator action cannot be audited, nothing is set up, and a workspace this run created is removed", async () => {
    await as(CC);
    await db.execute(`ALTER TABLE tenant_audit_log RENAME TO tenant_audit_log_hidden`);
    try {
      const existing = await provision.POST(post(`/api/admin/installs/${GAP}/provision`, choices), params(GAP));
      const ej = (await existing.json()) as Record<string, unknown>;
      assert.equal(existing.status, 503, JSON.stringify(ej));
      assert.equal(ej.error, "operator_exemption_unaudited");
      const created = await list.POST(post("/api/admin/installs", { name: "Audit Gap", slug: "audit-gap", ...choices }));
      const cj = (await created.json()) as Record<string, unknown>;
      assert.equal(created.status, 503, JSON.stringify(cj));
      assert.equal(cj.error, "operator_exemption_unaudited");
      assert.match(String(cj.message), /The new workspace was not kept\./);
    } finally {
      await db.execute(`ALTER TABLE tenant_audit_log_hidden RENAME TO tenant_audit_log`);
    }
    const gapManifest = await one(db, `SELECT COUNT(*) AS n FROM tenant_manifests WHERE tenant_id = ?`, [GAP]);
    assert.equal(Number(gapManifest?.n), 0, "no manifest without its audit row");
    const leftover = await one(db, `SELECT COUNT(*) AS n FROM tenants WHERE slug = 'audit-gap'`);
    assert.equal(Number(leftover?.n), 0, "the workspace the failed run created is gone");
  });

  await check("the client's setup page shows a failed run neutrally: 'Setup stopped', no internal reason, no promise", async () => {
    const run = await one(db, `SELECT steps_json, error_message FROM provisioning_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [GAP]);
    const steps = (JSON.parse(String(run?.steps_json)) as Array<{ title: string }>).map((s) => s.title);
    assert.equal(steps[steps.length - 1], "Setup stopped");
    assert.ok(!steps.some((t) => /operator|audit|Could not record/i.test(t) && t !== "Checked the workspace address and recorded the operator action"), steps.join(" | "));
    assert.match(String(run?.error_message), /^operator_exemption_unaudited: /, "the reason is kept for OASIS");
    await as(GAP_STAFF);
    const { ProvisioningProgress } = await import("../components/onboarding/ProvisioningProgress");
    // Render the server components all the way down: the words a person reads.
    const render = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(render);
      if (!node || typeof node !== "object") return node;
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (typeof el.type === "function") return render((el.type as (p: unknown) => unknown)(el.props));
      return el.props ? { type: el.type, children: render(el.props.children), href: el.props.href } : node;
    };
    const text = JSON.stringify(render(await ProvisioningProgress()));
    assert.ok(text.includes("Setup stopped before it finished."), text);
    assert.doesNotMatch(text, /operator_exemption_unaudited|Could not record/, "the internal reason is not shown to the client");
    assert.doesNotMatch(text, /will pick it up|has the details/);
    assert.ok(text.includes("support@oasisai.work"), "the next step is the contact line");
    // Add-ons are shown by their labels, never their keys.
    const bay = await one(db, `SELECT steps_json FROM provisioning_runs WHERE tenant_id = ? AND status = 'complete' LIMIT 1`, [BAYSIDE]);
    assert.match(String(bay?.steps_json), /add-ons requested: Content"/);
    assert.doesNotMatch(String(bay?.steps_json), /add-ons requested: content/);
  });

  await check("a new owner invite revokes every open owner invite for the workspace; each one can be revoked", async () => {
    await as(CC);
    const typo = await ownerInvite.POST(post(`/api/admin/installs/${TYPO}/owner-invite`, { email: "fonder@typo.test" }), params(TYPO));
    assert.equal(typo.status, 201);
    const right = await ownerInvite.POST(post(`/api/admin/installs/${TYPO}/owner-invite`, { email: "founder@typo.test" }), params(TYPO));
    assert.equal(right.status, 201);
    const rows = (await db.execute({ sql: `SELECT id, email, revoked_at FROM tenant_invites WHERE tenant_id = ? ORDER BY created_at`, args: [TYPO] })).rows as unknown as Array<{ id: string; email: string; revoked_at: string | null }>;
    assert.ok(rows.find((r) => r.email === "fonder@typo.test")?.revoked_at, "the mistyped invite no longer works");
    assert.equal(rows.find((r) => r.email === "founder@typo.test")?.revoked_at, null);
    let listed = (await (await list.GET()).json()) as { installs: Array<{ tenantId: string; pendingOwnerInvites: Array<{ id: string; email: string }> }> };
    assert.deepEqual(
      (listed.installs.find((i) => i.tenantId === TYPO)?.pendingOwnerInvites ?? []).map((p) => p.email),
      ["founder@typo.test"],
      "only the newest owner invite is still open",
    );
    // An open owner invite left over from before this fix (the old minter kept
    // them): the console must list it too, not just the newest, so it can be
    // revoked.
    await db.execute({
      sql: `INSERT INTO tenant_invites (id, tenant_id, email, team_role, kind, token_hash, created_by, expires_at, created_at)
            VALUES ('inv-legacy-typo', ?, 'legacy@typo.test', 'owner', 'owner_claim', 'h-legacy-typo', ?, ?, '2026-09-01T00:00:00.000Z')`,
      args: [TYPO, CC.id, new Date(Date.now() + 864e5).toISOString()],
    });
    listed = (await (await list.GET()).json()) as typeof listed;
    const pending = listed.installs.find((i) => i.tenantId === TYPO)?.pendingOwnerInvites ?? [];
    assert.deepEqual(pending.map((p) => p.email), ["founder@typo.test", "legacy@typo.test"], "the console lists every open owner invite");

    const del = (body: unknown) =>
      new NextRequest(`https://oasisai.work/api/admin/installs/${TYPO}/owner-invite`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await as(REP);
    assert.equal((await ownerInvite.DELETE(del({ invite_id: pending[0].id }), params(TYPO))).status, 404, "operator-only");
    await as(CC);
    const revoked = await ownerInvite.DELETE(del({ invite_id: pending[0].id }), params(TYPO));
    assert.equal(revoked.status, 200, JSON.stringify(await revoked.clone().json()));
    const inv = await one(db, `SELECT revoked_at FROM tenant_invites WHERE id = ?`, [pending[0].id]);
    assert.ok(inv?.revoked_at);
    assert.equal((await ownerInvite.DELETE(del({ invite_id: pending[0].id }), params(TYPO))).status, 404, "an invite that is no longer open");
    // A revoke is scoped to the workspace in the URL: another workspace's invite id does nothing.
    assert.equal((await ownerInvite.DELETE(del({ invite_id: "inv-legacy-typo" }), params(GAP))).status, 404);
    assert.equal((await one(db, `SELECT revoked_at FROM tenant_invites WHERE id = 'inv-legacy-typo'`))?.revoked_at, null);
    assert.equal((await ownerInvite.DELETE(del({ invite_id: "inv-legacy-typo" }), params(TYPO))).status, 200);
    listed = (await (await list.GET()).json()) as typeof listed;
    assert.deepEqual(listed.installs.find((i) => i.tenantId === TYPO)?.pendingOwnerInvites, []);
    const audit = await one(db, `SELECT COUNT(*) AS n FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'invite.owner_claim.revoke'`, [TYPO]);
    assert.equal(Number(audit?.n), 2, "each revoke is audited");
  });

  await check("an owner invite to the workspace's own (non-owner) creator makes them the owner", async () => {
    await as(CC);
    const res = await ownerInvite.POST(post(`/api/admin/installs/${SOLO}/owner-invite`, { email: CREATOR.email }), params(SOLO));
    const json = (await res.json()) as { invite: { invite_url: string } };
    assert.equal(res.status, 201);
    setSessionCookie(await signFor(CREATOR));
    const { POST: redeem } = await import("../app/api/auth/redeem-invite/route");
    const token = decodeURIComponent(new URL(json.invite.invite_url).pathname.split("/").pop() as string);
    const r = await redeem(
      new NextRequest("https://oasisai.work/api/auth/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `oasis_session=${await signFor(CREATOR)}` },
        body: JSON.stringify({ raw_token: token }),
      }),
    );
    const rj = (await r.json()) as Record<string, unknown>;
    assert.equal(r.status, 200, JSON.stringify(rj));
    assert.equal(rj.team_role, "owner");
    const p = await one(db, `SELECT is_owner, team_role FROM user_profiles WHERE auth_user_id = ?`, [CREATOR.id]);
    assert.deepEqual([Number(p?.is_owner), p?.team_role], [1, "owner"]);
    const inv = await one(db, `SELECT redeemed_at FROM tenant_invites WHERE tenant_id = ? AND team_role = 'owner'`, [SOLO]);
    assert.ok(inv?.redeemed_at, "claimed: the console no longer shows it as sent");
  });

  await check("an owner invite whose audit row could not be written tells the operator so", async () => {
    const { outcomeFrom, AUDIT_NOT_RECORDED } = await import("../components/admin/installs/outcome");
    await as(CC);
    await db.execute(`ALTER TABLE tenant_audit_log RENAME TO tenant_audit_log_hidden`);
    let json: Record<string, unknown> = {};
    try {
      const res = await ownerInvite.POST(post(`/api/admin/installs/${GAP}/owner-invite`, { email: "boss@gap.test" }), params(GAP));
      json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 201, JSON.stringify(json));
    } finally {
      await db.execute(`ALTER TABLE tenant_audit_log_hidden RENAME TO tenant_audit_log`);
    }
    assert.equal((json.invite as { audited: boolean }).audited, false);
    const shown = outcomeFrom(json, "x");
    assert.equal(shown.ok, true, "the invite was still created");
    assert.ok(shown.message.endsWith(AUDIT_NOT_RECORDED), shown.message);
    assert.equal(outcomeFrom({ ok: true, message: "Done.", invite: { audited: true } }, "x").message, "Done.");
  });

  db.close();
  finish("admin-installs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
