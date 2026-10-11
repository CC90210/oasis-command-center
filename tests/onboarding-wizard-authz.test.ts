/**
 * onboarding-wizard-authz.test.ts - who may set up a workspace in the wizard,
 * and what the wizard and welcome screens say. REAL libSQL.
 *
 * WHY THIS EXISTS (2026-09-29 audit, wizard-member-becomes-owner and
 * onboarding-leaks-internal-agents-and-sunbiz). POST /api/onboarding/wizard
 * let any member with a workspace save a manifest, then promoted the first
 * caller in a workspace with no owner to OWNER: an invited member became the
 * owner by opening a URL (reproduced: {member,0} -> {owner,1}). The wizard's
 * agent picker offered OASIS's own house agents and the SunBiz pack, and the
 * welcome screen labelled teammates "Bravo (lead architect)", "Solara",
 * "Helios".
 *
 * Pinned here:
 *   - a member gets 403 and stays a member, and no manifest is written;
 *   - the page shows a member "only the owner" and never the form;
 *   - the owner can set up their workspace: saved under the workspace's OWN
 *     address, neutral department teammates, chat apps and Jev recorded where
 *     the Slack/Jev work reads them, onboarding marked done, the session claim
 *     refreshed;
 *   - no route path promotes anyone to owner;
 *   - no OASIS house-agent or SunBiz name in the wizard or welcome screens.
 *
 * Run: node --conditions=react-server --import tsx tests/onboarding-wizard-authz.test.ts
 */
import assert from "node:assert/strict";
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
  splitStatements,
  type SeedUser,
} from "./_onboarding-fixture";

const { dbFile } = setupOnboardingEnv("wizard-authz");
// The logo pulls next/image, whose client context cannot load under the
// react-server condition. The pages under test only need it as an element.
{
  const logo = require.resolve("../components/brand/OasisLogo");
  require.cache[logo] = {
    id: logo,
    filename: logo,
    path: logo,
    loaded: true,
    children: [],
    paths: [],
    exports: { __esModule: true, OasisLogo: () => null },
  } as unknown as NodeModule;
}

const BAYSIDE = "b0b0b000-0000-4000-8000-00000000b0b0";
const u = (n: number, email: string, name: string): SeedUser => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email, name });
const CC = u(1, "conaugh@oasisai.work", "Conaugh McKenna");
const OWNER = u(2, "owner@bayside-hvac.test", "Olive Owner");
const MEMBER = u(3, "staff@bayside-hvac.test", "Sam Staff");
const OASIS_MEMBER = u(4, "rep@oasisai.work", "Riley Rep");

const FORBIDDEN = /\b(bravo|atlas|maven|solara|helios|sunbiz|sun biz)\b/i;

async function one(db: Client, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown> | undefined> {
  return (await db.execute({ sql, args })).rows[0] as Record<string, unknown> | undefined;
}

function wizardPost(body: unknown, cookie: string): NextRequest {
  return new NextRequest("https://oasisai.work/api/onboarding/wizard", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `oasis_session=${cookie}` },
    body: JSON.stringify(body),
  });
}

/**
 * Every string a person can read in a rendered element tree (props and
 * children), for name scans. `slug` and `value` are skipped: an agent's slug is
 * its internal id (the <option value> the form posts back), never shown.
 */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out);
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "_owner" || k === "_store" || k === "slug" || k === "value" || k === "primary_agent" || typeof v === "function") continue;
      textOf(v, out);
    }
  }
  return out;
}

/** Every value of prop `key` anywhere in an element tree (not rendered further). */
function propValues(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) propValues(n, key, out);
    return out;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props) {
    if (key in props) out.push(props[key]);
    propValues(props.children, key, out);
  }
  return out;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await createBaseSchema(db);
  await applyMigration196(db);
  // tenant_connections, so the welcome page's "is Slack connected?" read is real.
  for (const stmt of splitStatements(readFileSync("database/turso/bravo__187_os_connections.sql", "utf8"))) {
    await db.execute(stmt);
  }
  for (const stmt of splitStatements(readFileSync("database/turso/bravo__209_connection_vendor_principal.sql", "utf8"))) {
    await db.execute(stmt);
  }
  await seedTenant(db, OASIS, "oasis-ai-cc", "OASIS AI");
  await seedTenant(db, BAYSIDE, "bayside-hvac", "Bayside HVAC");
  for (const who of [CC, OWNER, MEMBER, OASIS_MEMBER]) await seedAuthUser(db, who);
  await seedProfile(db, CC, OASIS, { role: "owner", owner: true, onboarded: true, agents: ["bravo", "atlas", "maven", "aura"] });
  await seedProfile(db, OWNER, BAYSIDE, { role: "owner", owner: true, invitedBy: CC.id });
  await seedProfile(db, MEMBER, BAYSIDE, { role: "member", invitedBy: CC.id });
  await seedProfile(db, OASIS_MEMBER, OASIS, { role: "closer", invitedBy: CC.id, agents: ["bravo"] });

  const { POST } = await import("../app/api/onboarding/wizard/route");
  const body = {
    template: "agency",
    answers: {
      brand_name: "Bayside HVAC",
      departments: ["sales", "client_success", "finance"],
      modules: ["content", "enablement"],
      chat_apps: ["slack", "telegram"],
      jev: "shadow",
    },
  };

  await check("a member calling POST /api/onboarding/wizard gets 403 and stays a member", async () => {
    setSessionCookie(await signFor(MEMBER));
    const res = await POST(wizardPost(body, await signFor(MEMBER)));
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 403, JSON.stringify(json));
    assert.equal(json.error, "owner_required");
    const p = await one(db, `SELECT team_role, is_owner FROM user_profiles WHERE auth_user_id = ?`, [MEMBER.id]);
    assert.equal(p?.team_role, "member", "no promotion");
    assert.equal(Number(p?.is_owner), 0, "no promotion");
    const m = await one(db, `SELECT COUNT(*) AS n FROM tenant_manifests`);
    assert.equal(Number(m?.n), 0, "nothing was saved");
  });

  await check("even in a workspace with NO owner, a member cannot promote themselves", async () => {
    await db.execute({ sql: `UPDATE user_profiles SET is_owner = 0, team_role = 'admin' WHERE auth_user_id = ?`, args: [OWNER.id] });
    try {
      setSessionCookie(await signFor(MEMBER));
      const res = await POST(wizardPost(body, await signFor(MEMBER)));
      assert.equal(res.status, 403);
      const owners = await one(db, `SELECT COUNT(*) AS n FROM user_profiles WHERE tenant_id = ? AND is_owner = 1`, [BAYSIDE]);
      assert.equal(Number(owners?.n), 0, "the first-owner auto-promotion is gone");
    } finally {
      await db.execute({ sql: `UPDATE user_profiles SET is_owner = 1, team_role = 'owner' WHERE auth_user_id = ?`, args: [OWNER.id] });
    }
  });

  await check("an OASIS member (not an operator) is refused too", async () => {
    setSessionCookie(await signFor(OASIS_MEMBER));
    const res = await POST(wizardPost(body, await signFor(OASIS_MEMBER)));
    assert.equal(res.status, 403);
  });

  await check("the wizard page shows a member 'only the owner' and never the form", async () => {
    setSessionCookie(await signFor(MEMBER));
    const { default: Page } = await import("../app/onboarding/wizard/page");
    const el = (await Page()) as { props: Record<string, unknown>; type: unknown };
    const text = textOf(el).join(" ");
    assert.match(String(el.props.reason ?? text), /Only the workspace owner/);
    assert.equal(typeof el.type === "function" && (el.type as { name?: string }).name === "OnboardingWizardClient", false);
  });

  await check("the refusal page's link refreshes the gate claim instead of looping back to the wizard", async () => {
    // A stale "wizard" claim sent "/" straight back here, on every page, until
    // the next login. The link goes through /api/auth/onboarding-refresh.
    setSessionCookie(await signFor(MEMBER, "wizard"));
    const { default: Page } = await import("../app/onboarding/wizard/page");
    const el = (await Page()) as { props: Record<string, unknown>; type: (p: Record<string, unknown>) => unknown };
    const rendered = el.type(el.props);
    const hrefs = propValues(rendered, "href");
    assert.deepEqual(hrefs, ["/api/auth/onboarding-refresh?next=/"], JSON.stringify(hrefs));
  });

  await check("the owner sets up their workspace: own address, neutral team, chat apps + Jev recorded", async () => {
    setSessionCookie(await signFor(OWNER, "wizard"));
    const res = await POST(wizardPost(body, await signFor(OWNER, "wizard")));
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.slug, "bayside-hvac", "saved under the workspace's own address, not a typed slug");
    const row = await one(db, `SELECT slug, tenant_id, manifest FROM tenant_manifests WHERE tenant_id = ?`, [BAYSIDE]);
    assert.equal(row?.slug, "bayside-hvac");
    const manifest = JSON.parse(String(row?.manifest)) as {
      agents: Array<{ slug: string; display_name: string; primary?: boolean }>;
      integrations: { chat_apps: string[]; jev: string };
      os: { departments: string[]; modules: string[] };
      brand: { name: string };
    };
    assert.deepEqual(manifest.agents.map((a) => [a.slug, a.display_name, !!a.primary]), [
      ["sdr", "Sales lead", true],
      ["customer-support", "Client Success lead", false],
    ]);
    assert.deepEqual(manifest.integrations.chat_apps, ["slack", "telegram"]);
    assert.equal(manifest.integrations.jev, "shadow");
    assert.deepEqual(manifest.os.departments, ["chief_of_staff", "sales", "client_success", "finance"], "Chief of Staff always included");
    assert.deepEqual(manifest.os.modules, ["content", "finance"], "OASIS-only modules (enablement) are dropped; the Finance department records its module");
    assert.equal(manifest.brand.name, "Bayside HVAC");
    assert.doesNotMatch(JSON.stringify(manifest.agents), FORBIDDEN);
    const p = await one(db, `SELECT onboarding_completed_at, is_owner FROM user_profiles WHERE auth_user_id = ?`, [OWNER.id]);
    assert.ok(p?.onboarding_completed_at, "the owner's onboarding is marked done");
    const payload = sessionPayloadFromSetCookie(res as unknown as Response);
    assert.equal(payload?.onb, "done", "the session claim is refreshed so the gate stops sending them to the wizard");
  });

  await check("a workspace already set up cannot be re-created by the wizard", async () => {
    setSessionCookie(await signFor(OWNER));
    const res = await POST(wizardPost(body, await signFor(OWNER)));
    assert.equal(res.status, 409);
  });

  // "Name your workspace" says the name shows in the header. The header reads
  // tenants.name first, and a workspace made by signup_tenant or the setup CLI
  // is named "<First name>'s workspace", so the wizard must save the owner's
  // name there (2026-09-30 verifier: it saved only the manifest brand, and the
  // header kept "Dana's workspace").
  const DELTA = "de17a000-0000-4000-8000-0000000de17a";
  const DANA = u(6, "dana@delta-dental.test", "Dana Dentist");
  const HALO = "4a100000-0000-4000-8000-0000000004a1";
  const HAL = u(7, "hal@halo.test", "Hal Owner");
  await seedTenant(db, DELTA, "dana", "Dana's workspace");
  await seedTenant(db, HALO, "hal", "Hal's workspace");
  for (const who of [DANA, HAL]) await seedAuthUser(db, who);
  await seedProfile(db, DANA, DELTA, { role: "owner", owner: true });
  await seedProfile(db, HAL, HALO, { role: "owner", owner: true });

  await check("the name the owner types in the wizard becomes the workspace name the header shows", async () => {
    setSessionCookie(await signFor(DANA, "wizard"));
    const res = await POST(
      wizardPost({ template: "custom", answers: { brand_name: "  Delta Dental  ", departments: ["sales"] } }, await signFor(DANA, "wizard")),
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const t = await one(db, `SELECT name FROM tenants WHERE id = ?`, [DELTA]);
    assert.equal(t?.name, "Delta Dental", "tenants.name is the owner's answer, trimmed");
    const m = await one(db, `SELECT manifest FROM tenant_manifests WHERE tenant_id = ?`, [DELTA]);
    const { workspaceDisplayName } = await import("../lib/provisioning/workspace-name");
    const header = workspaceDisplayName({
      tenantName: String(t?.name),
      manifestBrand: (JSON.parse(String(m?.manifest)) as { brand: { name: string } }).brand.name,
      profileBrand: null,
      isOasisWorkspace: false,
    });
    assert.equal(header, "Delta Dental", "the header shows the name typed in 'Name your workspace'");
    const client = readFileSync("components/onboarding/OnboardingWizardClient.tsx", "utf8");
    assert.ok(client.includes("The name shows in the header and across every page."), "the promise this pins");
  });

  await check("when the workspace name cannot be saved, nothing is saved and the owner is told", async () => {
    await db.execute(`CREATE TRIGGER refuse_halo_rename BEFORE UPDATE OF name ON tenants
                        WHEN OLD.id = '${HALO}' BEGIN SELECT RAISE(ABORT, 'rename refused'); END`);
    try {
      setSessionCookie(await signFor(HAL, "wizard"));
      const res = await POST(
        wizardPost({ template: "custom", answers: { brand_name: "Halo Studio", departments: ["sales"] } }, await signFor(HAL, "wizard")),
      );
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 503, JSON.stringify(json));
      assert.equal(json.error, "workspace_name_unsaved");
      assert.match(String(json.reason), /nothing was saved/);
      const m = await one(db, `SELECT COUNT(*) AS n FROM tenant_manifests WHERE tenant_id = ?`, [HALO]);
      assert.equal(Number(m?.n), 0, "the create-only setup was not saved, so the owner can retry");
      const p = await one(db, `SELECT onboarding_completed_at FROM user_profiles WHERE auth_user_id = ?`, [HAL.id]);
      assert.equal(p?.onboarding_completed_at, null, "onboarding is not marked done");
      const t = await one(db, `SELECT name FROM tenants WHERE id = ?`, [HALO]);
      assert.equal(t?.name, "Hal's workspace");
    } finally {
      await db.execute(`DROP TRIGGER refuse_halo_rename`);
    }
  });

  await check("no route path promotes anyone to owner", () => {
    const route = readFileSync("app/api/onboarding/wizard/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(route, /is_owner\s*:\s*true/);
    assert.doesNotMatch(route, /team_role\s*:\s*["']owner["']/);
    assert.doesNotMatch(route, /buildSunbizSequenceRows|business_funding/, "SunBiz drip seeding is gone");
  });

  await check("the business-funding template and every house/SunBiz agent are gone from the wizard", async () => {
    const { TEMPLATES, TEMPLATE_KEYS, WIZARD_QUESTIONS } = await import("../lib/manifest/templates");
    assert.deepEqual([...TEMPLATE_KEYS].sort(), ["agency", "custom", "ecommerce", "real_estate"]);
    assert.doesNotMatch(JSON.stringify({ TEMPLATES, WIZARD_QUESTIONS }), FORBIDDEN);
    assert.doesNotMatch(JSON.stringify(TEMPLATES), /OASIS AI"?\s*,?\s*"?placeholder/);
    const client = readFileSync("components/onboarding/OnboardingWizardClient.tsx", "utf8");
    const code = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, FORBIDDEN, "no house-agent or SunBiz name in the wizard's rendered strings");
    assert.doesNotMatch(code, /AGENT_PACKAGES|AGENT_REGISTRY/);
    assert.doesNotMatch(code, /placeholder="OASIS AI"/, "the brand placeholder is the business name");
    assert.ok(code.includes("Where does your team talk?"));
    assert.ok(code.includes("Fast classifier (Jev, optional)"));
    assert.ok(code.includes("Slack connects in Settings > Chat apps."));
    const welcome = readFileSync("app/onboarding/welcome/WelcomeWizardClient.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(welcome, FORBIDDEN, "no house-agent or SunBiz name in the welcome screen");
    assert.doesNotMatch(welcome, /"telegram"/, "briefing channels match lib/profile-custom-fields.ts");
  });

  await check("the welcome page labels an OASIS member's teammates by department, never by persona", async () => {
    setSessionCookie(await signFor(OASIS_MEMBER));
    const { default: Welcome } = await import("../app/onboarding/welcome/page");
    const el = await Welcome({ searchParams: Promise.resolve({ settings: "1" }) });
    const text = textOf(el).join(" | ");
    assert.doesNotMatch(text, FORBIDDEN, text);
    assert.match(text, /Chief of Staff/);
    // W4a: the labels are the workspace roster's (each binding's display_name,
    // lib/os/teammates.ts), not a page-local map; CC's own agents are not on it.
    const teammates = propValues(el, "teammates")[0] as Array<{ slug: string; label: string }>;
    assert.deepEqual(
      teammates.map((t) => [t.slug, t.label]),
      [
        ["bravo", "Chief of Staff · Operations"],
        ["sdr", "Sales"],
        ["maven", "Marketing"],
        ["customer-support", "Client Success"],
        ["atlas", "Finance"],
      ],
    );
    assert.doesNotMatch(readFileSync("app/onboarding/welcome/page.tsx", "utf8"), /HOUSE_AGENT_LABELS|Personal assistant/);
  });

  await check("a failed teammate read says so; it is never shown as 'not set up yet'", async () => {
    // Bayside IS set up (the owner ran the wizard above). With the manifest
    // table unreadable, the page used to fall through to the seed and tell this
    // member the teammates "appear once it is set up".
    await db.execute(`ALTER TABLE tenant_manifests RENAME TO tenant_manifests_hidden`);
    try {
      setSessionCookie(await signFor(MEMBER));
      const { default: Welcome } = await import("../app/onboarding/welcome/page");
      const el = await Welcome({ searchParams: Promise.resolve({ settings: "1" }) });
      assert.deepEqual(propValues(el, "teammatesUnknown"), [true], "the client is told the read failed");
      assert.deepEqual(propValues(el, "teammates"), [[]]);
    } finally {
      await db.execute(`ALTER TABLE tenant_manifests_hidden RENAME TO tenant_manifests`);
    }
    const client = readFileSync("app/onboarding/welcome/WelcomeWizardClient.tsx", "utf8");
    assert.ok(client.includes("We could not load your teammates just now; you can pick a default one later in Settings."));
    setSessionCookie(await signFor(MEMBER));
    const { default: Welcome } = await import("../app/onboarding/welcome/page");
    const ok = await Welcome({ searchParams: Promise.resolve({ settings: "1" }) });
    assert.deepEqual(propValues(ok, "teammatesUnknown"), [false], "a good read is not 'unknown'");
  });

  await check("an account with no workspace is not told it has joined one", async () => {
    // Login sends a tenant-less account to the welcome page (lib/auth-routing.ts);
    // the local E2E walk found it saying "You've joined the workspace".
    const detached = u(5, "detached@nowhere.test", "Dee Tached");
    await seedAuthUser(db, detached);
    await seedProfile(db, detached, null, {});
    setSessionCookie(await signFor(detached));
    const { default: Welcome } = await import("../app/onboarding/welcome/page");
    const text = textOf(await Welcome({ searchParams: Promise.resolve({}) })).join(" ");
    assert.match(text, /not linked to a workspace/);
    assert.doesNotMatch(text, /joined/);
    setSessionCookie(await signFor(MEMBER));
    const member = textOf(await Welcome({ searchParams: Promise.resolve({ settings: "1" }) })).join(" ");
    assert.match(member, /joined\s+\|?\s*Bayside HVAC|joined.*Bayside HVAC/s);
  });

  await check("the welcome page gives a member of an unset-up workspace no teammate and no fallback agent", async () => {
    await db.execute({ sql: `DELETE FROM tenant_manifests WHERE tenant_id = ?`, args: [BAYSIDE] });
    setSessionCookie(await signFor(MEMBER));
    const { default: Welcome } = await import("../app/onboarding/welcome/page");
    const el = await Welcome({ searchParams: Promise.resolve({ settings: "1" }) });
    const text = textOf(el).join(" | ");
    assert.doesNotMatch(text, FORBIDDEN, text);
    assert.ok(!/"slug":"bravo"/.test(JSON.stringify(textOf(el))));
  });

  db.close();
  finish("onboarding-wizard-authz");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
