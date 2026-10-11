/**
 * one-agent-roster.test.ts - OASIS OS track W4a: the workspace manifest is the
 * ONE roster of AI teammates (audit S2-01, S2-02, S2-06, S2-12, S2-14, S5-F04;
 * decisions 21 and 22).
 *
 * WHAT IS PINNED, against a local libSQL file with real signed sessions and the
 * real route handlers (next/headers, next/navigation and next/link are the only
 * stand-ins):
 *
 *   1. A binding's `departments` is parsed leniently (known keys, no repeats,
 *      never fails the manifest) and makes it a department lead.
 *   2. OASIS's seed is its five department leads, named for their departments;
 *      CC's own agents (aura, lex, hermes, life-preservation) are not on any
 *      business roster. A stored OASIS manifest from before `departments` keeps
 *      its channels (OASIS's static fallback), and its house extras drop off.
 *   3. A client's roster is its manifest: neutral leads, its own teammates,
 *      never a house agent, whatever its manifest says.
 *   4. POST /api/tenant/agents/toggle: a client owner cannot add an OASIS house
 *      agent (the OASIS-only rule used to live only in the Settings card), nor
 *      switch on one a self-signup's manifest still binds; can turn on a
 *      teammate it built that its manifest never bound; cannot add another
 *      workspace's; a member changes nothing; a core lead never goes off; a
 *      lead switched off takes its department channel (and the chat route)
 *      down with it; every message names the teammate the roster's way. A
 *      workspace OASIS has not set up has no lineup to change.
 *   5. POST /api/agents binds the new teammate the moment it exists: it is On
 *      on the AI Team, never "Off with no control". In a workspace that runs
 *      on an in-code seed (OASIS's own), the row holds only its own bindings
 *      (a seed overlay), so later code edits to the seed still reach it.
 *   6. The builder opens prefilled from ?template=, and the AI Team's On/Off
 *      switch says what it is (client components rendered in
 *      tests/one-agent-roster.render.ts, where React is whole).
 *   7. Provisioning writes each neutral lead's departments, and "Set up again"
 *      gives a kept lead (renamed by its owner) the departments chosen now.
 *   8. OASIS's operator surfaces (a tenant cron's agent, /operations, /health)
 *      list the house agents its bridge runs, not its business roster.
 *
 * Run: node --conditions=react-server --import tsx tests/one-agent-roster.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "one-agent-roster-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "one-agent-roster-test-secret-long-enough-000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";

// Nothing here may reach the network.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

// tsconfig sets jsx:"preserve", so tsx compiles JSX with the classic runtime.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
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
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// resolveOwnedSlug swallows both of its reads and answers a failed one with
// null (lib/manifest/tenant-scope.ts). Section 9 sets this to make it answer
// that null; every other check gets the real function.
let ownedSlugReadFails = false;
{
  const real = require("../lib/manifest/tenant-scope") as typeof import("../lib/manifest/tenant-scope");
  stub("../lib/manifest/tenant-scope", {
    __esModule: true,
    ...real,
    resolveOwnedSlug: async (tenantId: string | null) => (ownedSlugReadFails ? null : real.resolveOwnedSlug(tenantId)),
  });
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const OTHER = "7d7d7d7d-0000-4000-8000-00000000007d";
// A self-signup whose wizard manifest binds house agents (the two live junk
// rows bind bravo + atlas and bravo + atlas + maven), and a workspace OASIS
// has not set up at all (no row, no seed).
const SELFSIGNUP = "5e5e5e5e-0000-4000-8000-00000000005e";
const FRESH = "4f4f4f4f-0000-4000-8000-00000000004f";
// A workspace on the in-code SUGA_SEED (no row), whose leads are not core.
const SUGA = "3c3c3c3c-0000-4000-8000-00000000003c";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // OASIS owner
  owner: u(2, "owner@client.test"), // a client workspace's owner
  member: u(3, "riley@client.test"), // a plain member there
  other: u(4, "owner@other.test"), // another client's owner
  signup: u(5, "owner@selfsignup.test"), // the self-signup's owner
  fresh: u(6, "owner@fresh.test"), // the owner of a workspace nobody has set up
  suga: u(7, "owner@suga.test"), // the owner of the seed-backed SUGA workspace
} as const;

async function login(user: U | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT, invited_by TEXT, joined_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, logo_url TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT UNIQUE,
      slug TEXT UNIQUE, manifest TEXT, version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (slug TEXT PRIMARY KEY, name TEXT, category TEXT, short_description TEXT, description TEXT,
      base_prompt TEXT, required_tools TEXT, suggested_model TEXT, pricing TEXT, is_public INTEGER,
      is_oasis_managed INTEGER, created_by TEXT, tenant_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, enabled INTEGER, updated_at TEXT);
    CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      agent_key TEXT, name TEXT, description TEXT, schedule TEXT, action_type TEXT, action_payload TEXT,
      enabled INTEGER, created_by TEXT, created_at TEXT, updated_at TEXT);
  `);

  const { buildProvisionedManifest, mergeProvisionedManifest } = await import("../lib/provisioning/manifest");
  const { DEFAULT_DEPARTMENTS, neutralTeamFor } = await import("../lib/provisioning/team");
  const stamp = "2026-09-01T00:00:00Z";
  const provisioned = (slug: string, name: string) =>
    buildProvisionedManifest({ slug, name, departments: DEFAULT_DEPARTMENTS, modules: [], now: stamp });
  const profile = (who: keyof typeof USERS, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
            full_name, agents_enabled, updated_at, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Person', '[]', ?, ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, stamp, stamp],
  });
  const agentRow = (slug: string, name: string, tenant: string) => ({
    sql: `INSERT INTO agents (slug, name, category, short_description, base_prompt, is_public, is_oasis_managed, tenant_id, created_at, updated_at)
          VALUES (?, ?, 'support', 'Answers intake questions.', 'You help {{tenant.brand.name}} with intake questions.', 0, 0, ?, ?, ?)`,
    args: [slug, name, tenant, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'other-co', 'Other Co')", args: [OTHER] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'selfsignup', 'Self Signup')", args: [SELFSIGNUP] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'fresh-co', 'Fresh Co')", args: [FRESH] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'suga', 'Suga')", args: [SUGA] },
      {
        sql: "INSERT INTO tenant_manifests (id, tenant_id, slug, manifest, version, schema_version) VALUES ('m-client', ?, 'client-co', ?, 1, 1)",
        args: [CLIENT, JSON.stringify(provisioned("client-co", "Client Co"))],
      },
      {
        sql: "INSERT INTO tenant_manifests (id, tenant_id, slug, manifest, version, schema_version) VALUES ('m-other', ?, 'other-co', ?, 1, 1)",
        args: [OTHER, JSON.stringify(provisioned("other-co", "Other Co"))],
      },
      {
        sql: "INSERT INTO tenant_manifests (id, tenant_id, slug, manifest, version, schema_version) VALUES ('m-signup', ?, 'fun', ?, 1, 1)",
        args: [
          SELFSIGNUP,
          JSON.stringify({
            ...provisioned("fun", "Self Signup"),
            agents: [
              { slug: "bravo", display_name: "Bravo", enabled: true },
              { slug: "atlas", display_name: "Atlas", enabled: true },
              { slug: "maven", display_name: "Maven", enabled: false },
            ],
          }),
        ],
      },
      profile("cc", OASIS, "owner", 1),
      profile("owner", CLIENT, "owner", 1),
      profile("member", CLIENT, "member", 0),
      profile("other", OTHER, "owner", 1),
      profile("signup", SELFSIGNUP, "owner", 1),
      profile("fresh", FRESH, "owner", 1),
      profile("suga", SUGA, "owner", 1),
      // Built by the client before new teammates were bound on creation.
      agentRow("intake-helper", "Intake Helper", CLIENT),
      // Another workspace's teammate.
      agentRow("renewals-desk", "Renewals Desk", OTHER),
      // Built in a workspace OASIS has not set up.
      agentRow("fresh-helper", "Fresh Helper", FRESH),
    ],
    "write",
  );

  const { parseManifest, agentBindingKind } = await import("../lib/manifest/schema");
  const { OASIS_SEED, OASIS_AI_CC_SEED } = await import("../lib/manifest/seeds");
  const { workspaceTeammates } = await import("../lib/os/teammates");
  const { departmentChannelFor } = await import("../components/os/department/config");
  const { loadWorkspaceRoster, loadAiTeam } = await import("../components/os/aiteam/roster");
  const { resolveOsViewer } = await import("../components/os/department/viewer");
  const { prepareAgentTurn } = await import("../lib/os/department-agent");
  const { departmentBySlug } = await import("../lib/os/departments");
  const identity = await import("../lib/os/channel/identity");
  const toggleRoute = await import("../app/api/tenant/agents/toggle/route");
  const agentsRoute = await import("../app/api/agents/route");
  const { TEAMMATE_TEMPLATES } = await import("../components/os/aiteam/templates");
  const { NextRequest } = await import("next/server");

  const post = (route: { POST: (req: InstanceType<typeof NextRequest>) => Promise<Response> }, path: string, body: unknown) =>
    route.POST(
      new NextRequest(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const cronRowRoute = await import("../app/api/cron-jobs/[id]/route");
  // Reassigning an existing script job's agent (PATCH /api/cron-jobs/[id]),
  // the path a client's roster still governs now that only verified operators
  // create script jobs.
  const reassignCron = async (jobId: string, agentKey: string) => {
    const res = await cronRowRoute.PATCH(
      new NextRequest(`http://localhost/api/cron-jobs/${jobId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_key: agentKey, source: "tenant" }),
      }),
      { params: Promise.resolve({ id: jobId }) },
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
  };
  const toggle = async (body: { action: string; slug: string }) => {
    const res = await post(toggleRoute, "/api/tenant/agents/toggle", body);
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; message?: string } };
  };
  const rawStored = async (tenant: string) => {
    const rs = await db.execute({ sql: "SELECT manifest FROM tenant_manifests WHERE tenant_id = ?", args: [tenant] });
    const raw = rs.rows[0]?.manifest;
    return raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : null;
  };
  const stored = async (tenant: string) => {
    const raw = await rawStored(tenant);
    return raw ? parseManifest(raw) : null;
  };
  const clientScope = async () => ({ oasis: false, manifest: await stored(CLIENT) });

  console.log("one-agent-roster:");

  // ── 1. The schema ─────────────────────────────────────────────────────────
  await check("schema: departments are parsed leniently (known keys, no repeats) and make a binding a lead", () => {
    const base = provisioned("parse-co", "Parse Co");
    const m = parseManifest(
      JSON.parse(
        JSON.stringify({
          ...base,
          agents: [
            { slug: "sdr", display_name: "Sales lead", enabled: true, departments: ["sales", "nope", "sales", 3, "client_success"] },
            { slug: "helper", display_name: "Helper", enabled: true, departments: "sales" },
            { slug: "plain", display_name: "Plain", enabled: true },
          ],
        }),
      ),
    );
    assert.deepEqual(m.agents[0].departments, ["sales", "client_success"]);
    assert.equal(m.agents[1].departments, undefined, "a non-array value is dropped, not thrown");
    assert.ok(!("departments" in m.agents[2]), "an absent field stays absent");
    assert.deepEqual(m.agents.map(agentBindingKind), ["lead", "custom", "custom"]);
    assert.equal(agentBindingKind({ departments: [] }), "custom");
  });
  await check("a seed overlay stores only the workspace's own bindings and serves the CURRENT seed with them (review R2)", async () => {
    const overlay = await import("../lib/manifest/seed-overlay");
    const { SUGA_SEED } = await import("../lib/manifest/seeds");
    const custom = { slug: "renewal-chaser", display_name: "Renewal chaser", enabled: true, core: false };
    // The writer keeps what the seed does not say: an appended teammate, and
    // the switch on a seed binding that is not core. A core lead's switch is
    // not the workspace's to store (it is always on).
    const lineup = [
      ...OASIS_AI_CC_SEED.agents.map((a) => (a.slug === "maven" ? { ...a, enabled: false } : a)),
      custom,
    ];
    assert.deepEqual(overlay.seedOverlayAgents(OASIS_AI_CC_SEED, lineup), [custom]);
    assert.deepEqual(Object.keys(overlay.seedOverlayBody(OASIS_AI_CC_SEED, lineup)).sort(), ["agents", "seed_overlay"], "no copy of the seed");
    // A reader serves the seed as it is in code now, plus those bindings.
    const served = overlay.resolveStoredManifest({ seed_overlay: true, agents: [custom] }, "oasis-ai-cc", OASIS);
    assert.ok(served.ok);
    assert.equal(served.ok && served.manifest.nav, OASIS_AI_CC_SEED.nav, "nav comes from the seed itself");
    assert.deepEqual(served.ok ? served.manifest.agents.map((a) => a.slug) : [], [...OASIS_AI_CC_SEED.agents.map((a) => a.slug), "renewal-chaser"]);
    // A switch on a non-core seed binding (SUGA's leads are not core) is applied; its name stays the seed's.
    const suga = overlay.applySeedOverlay(SUGA_SEED, [{ slug: "sdr", display_name: "Renamed", enabled: false }]);
    const sdr = suga.agents.find((a) => a.slug === "sdr");
    assert.deepEqual(sdr && [sdr.display_name, sdr.enabled], ["Sales lead", false]);
    // An overlay is applied to a real seed only: none for a slug that has none.
    assert.equal(overlay.resolveStoredManifest({ seed_overlay: true, agents: [custom] }, "client-co", CLIENT).ok, false);
    assert.equal(overlay.overlaySeedFor("oasis", CLIENT), null, "the 'oasis' alias is OASIS's own tenants' only");
    // A stored body that is a workspace's own manifest parses as it always did.
    assert.ok(overlay.resolveStoredManifest(provisioned("client-co", "Client Co"), "client-co", CLIENT).ok);
  });

  // ── 2. OASIS's roster ─────────────────────────────────────────────────────
  await check("OASIS's seed is its five department leads, named for their departments; CC's own agents are on no business roster", () => {
    const team = workspaceTeammates({ oasis: true, manifest: OASIS_AI_CC_SEED });
    assert.deepEqual(
      team.map((t) => [t.slug, t.name, t.kind, t.core, t.departments]),
      [
        ["bravo", "Chief of Staff · Operations", "lead", true, ["chief_of_staff", "operations"]],
        ["sdr", "Sales", "lead", true, ["sales"]],
        ["maven", "Marketing", "lead", true, ["marketing"]],
        ["customer-support", "Client Success", "lead", true, ["client_success"]],
        ["atlas", "Finance", "lead", true, ["finance"]],
      ],
    );
    assert.equal(OASIS_AI_CC_SEED.agents, OASIS_SEED.agents, "oasis-ai-cc runs on OASIS_SEED's roster");
    // A stored OASIS manifest written from the old seed: bravo, atlas, maven,
    // aura (core) and lex, none with departments. Its channels keep working on
    // OASIS's static leads, named for their departments, and the house extras drop off.
    const legacy = {
      agents: [
        { slug: "bravo", display_name: "Bravo", enabled: true, primary: true, core: true },
        { slug: "atlas", display_name: "Atlas", enabled: true, core: true },
        { slug: "maven", display_name: "Maven", enabled: true, core: true },
        { slug: "aura", display_name: "Aura", enabled: true, core: true },
        { slug: "lex", display_name: "Lex", enabled: false, core: false },
      ],
    };
    const old = workspaceTeammates({ oasis: true, manifest: legacy });
    assert.deepEqual(
      old.map((t) => [t.slug, t.name, t.bound]),
      [
        ["bravo", "Chief of Staff · Operations", true],
        ["sdr", "Sales", false],
        ["maven", "Marketing", true],
        ["customer-support", "Client Success", false],
        ["atlas", "Finance", true],
      ],
      "a legacy OASIS manifest keeps its five leads, named for their departments, and drops aura and lex",
    );
    for (const t of [...team, ...old]) assert.ok(!identity.namesPersona(t.name), `${t.slug} is named "${t.name}"`);
  });

  // ── 3. A client's roster ──────────────────────────────────────────────────
  await check("a client's roster is its manifest: its neutral leads and its own teammates, never a house agent", async () => {
    const scope = await clientScope();
    assert.deepEqual(
      workspaceTeammates(scope).map((t) => [t.slug, t.name, t.kind]),
      [
        ["sdr", "Sales lead", "lead"],
        ["customer-support", "Client Success lead", "lead"],
      ],
    );
    // A manifest that names house agents, as leads or as teammates, gets none of them.
    const forged = {
      oasis: false,
      manifest: {
        agents: [
          ...(scope.manifest?.agents ?? []),
          { slug: "maven", display_name: "Maven", enabled: true, departments: ["marketing" as const] },
          { slug: "aura", display_name: "Aura", enabled: true },
          { slug: "sunbiz", display_name: "Solara", enabled: true },
        ],
      },
    };
    assert.deepEqual(workspaceTeammates(forged).map((t) => t.slug), ["sdr", "customer-support"]);
    assert.equal(departmentChannelFor("marketing", forged).kind, "unavailable");
    // The Settings card and the AI Team list the same teammates (one loader).
    const roster = await loadWorkspaceRoster({ tenantId: CLIENT, scope });
    assert.deepEqual(roster.leads.map((l) => l.slug), ["sdr", "customer-support"]);
    assert.ok(roster.custom.ok);
    assert.deepEqual(
      roster.custom.ok ? roster.custom.value.map((c) => [c.slug, c.name, c.enabled, c.bound]) : null,
      [["intake-helper", "Intake Helper", false, false]],
      "a teammate the client built, never bound, is listed Off (not hidden)",
    );
  });
  // Verifier E4: SUGA's saved prompts still named Maven after its roster went neutral.
  await check("a client seed's saved prompts name its own teammates, never a house agent", async () => {
    const { SEED_MANIFESTS } = await import("../lib/manifest/seeds");
    const { isHouseAgentSlug } = await import("../lib/agents");
    const clientSeeds = Object.entries(SEED_MANIFESTS).filter(([, m]) => m !== OASIS_SEED && m !== OASIS_AI_CC_SEED);
    assert.ok(clientSeeds.length > 0, "no client seed to check");
    for (const [key, seed] of clientSeeds) {
      const bound = new Set(seed.agents.map((a) => a.slug));
      for (const p of seed.default_prompts ?? []) {
        assert.ok(!isHouseAgentSlug(p.agent_slug), `${key}: the prompt "${p.label}" names the house agent "${p.agent_slug}"`);
        assert.ok(bound.has(p.agent_slug), `${key}: the prompt "${p.label}" names "${p.agent_slug}", which the seed does not bind`);
      }
    }
  });

  // ── 4. The toggle API ─────────────────────────────────────────────────────
  await check("toggle: a client owner cannot add an OASIS house agent (the rule used to live only in the card)", async () => {
    await login(USERS.owner);
    const before = JSON.stringify(await stored(CLIENT));
    for (const slug of ["maven", "aura", "hermes", "lex", "life-preservation", "sunbiz", "BRAVO"]) {
      const r = await toggle({ action: "add", slug });
      assert.equal(r.status, 403, `${slug}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "house_agent_not_offered");
      assert.ok(!identity.namesPersona(r.body.message ?? ""), r.body.message);
    }
    assert.equal(JSON.stringify(await stored(CLIENT)), before, "a refused add wrote the manifest");
  });
  await check("toggle: another workspace's teammate cannot be added, and a member changes nothing", async () => {
    await login(USERS.owner);
    const r = await toggle({ action: "add", slug: "renewals-desk" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "unknown_agent");
    await login(USERS.member);
    const m = await toggle({ action: "add", slug: "intake-helper" });
    assert.equal(m.status, 403);
    assert.equal(m.body.error, "forbidden");
  });
  await check("toggle: a client owner turns on a teammate it built but never bound; the binding is added and named by its row", async () => {
    await login(USERS.owner);
    const r = await toggle({ action: "add", slug: "intake-helper" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message, "Added Intake Helper");
    const binding = (await stored(CLIENT))?.agents.find((a) => a.slug === "intake-helper");
    assert.deepEqual(
      binding && [binding.slug, binding.display_name, binding.enabled, binding.core, binding.departments],
      ["intake-helper", "Intake Helper", true, false, undefined],
      "a custom teammate: on, not core, no departments",
    );
    const roster = await loadWorkspaceRoster({ tenantId: CLIENT, scope: await clientScope() });
    assert.deepEqual(roster.custom.ok ? roster.custom.value.map((c) => [c.slug, c.enabled, c.bound]) : null, [["intake-helper", true, true]]);
    assert.equal((await toggle({ action: "add", slug: "intake-helper" })).status, 409, "added twice");
  });
  await check("toggle: switching a lead off takes its channel and the chat route down; messages name the teammate, never a persona", async () => {
    await login(USERS.owner);
    const off = await toggle({ action: "disable", slug: "sdr" });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.message, "Disabled Sales lead");
    const sales = departmentChannelFor("sales", await clientScope());
    assert.equal(sales.kind, "unavailable");
    assert.match(sales.kind === "unavailable" ? sales.reason : "", /turned off/);
    const turn = await prepareAgentTurn({
      tenantId: CLIENT,
      tenantSlug: "client-co",
      agentSlug: "sdr",
      department: departmentBySlug("sales"),
      operator: { name: "Alex", email: "owner@client.test" },
      platformFallback: null,
      revealModel: false,
      userId: USERS.owner.id,
    });
    assert.deepEqual(turn.ok ? null : { status: turn.status, error: turn.error }, { status: 400, error: "department_agent_mismatch" });
    // The AI Team says so, and the owner can switch it back.
    const viewer = await resolveOsViewer();
    assert.ok(viewer.ok);
    const team = await loadAiTeam(viewer as Extract<typeof viewer, { ok: true }>);
    const row = team.leads.find((l) => l.id === "sdr");
    assert.equal(row?.web, "off");
    assert.deepEqual(row?.toggle, { slug: "sdr", enabled: false, bound: true });
    const on = await toggle({ action: "enable", slug: "sdr" });
    assert.equal(on.body.message, "Enabled Sales lead");
    assert.equal(departmentChannelFor("sales", await clientScope()).kind, "agent");
  });
  await check("an agent turn whose manifest read fails is 'could not confirm your workspace' (503), never a department mismatch (review R3)", async () => {
    await db.execute("ALTER TABLE tenant_manifests RENAME TO tenant_manifests_offline");
    let turn: Awaited<ReturnType<typeof prepareAgentTurn>>;
    try {
      turn = await prepareAgentTurn({
        tenantId: CLIENT,
        tenantSlug: "client-co",
        agentSlug: "sdr",
        department: departmentBySlug("sales"),
        operator: { name: "Alex", email: "owner@client.test" },
        platformFallback: null,
        revealModel: false,
        userId: USERS.owner.id,
      });
    } finally {
      await db.execute("ALTER TABLE tenant_manifests_offline RENAME TO tenant_manifests");
    }
    assert.deepEqual(turn.ok ? null : { status: turn.status, error: turn.error }, { status: 503, error: "workspace_unavailable" });
  });
  await check("toggle: OASIS's core leads never go off, and OASIS may still add a house agent it never shows", async () => {
    await login(USERS.cc);
    const r = await toggle({ action: "disable", slug: "bravo" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "core_locked");
    assert.equal(await rawStored(OASIS), null, "a refused change wrote OASIS a manifest row");
    const add = await toggle({ action: "add", slug: "aura" });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.ok(!identity.namesPersona(add.body.message ?? ""), `the API named a persona: ${add.body.message}`);
    // The row now exists and holds ONLY OASIS's own binding (a seed overlay,
    // never a copy of its seed); its roster still holds only the leads.
    assert.deepEqual(await rawStored(OASIS), { seed_overlay: true, agents: [{ slug: "aura", display_name: "Aura", enabled: true, core: false }] });
    const { getManifest } = await import("../lib/manifest/loader");
    const oasis = await getManifest("oasis-ai-cc", OASIS);
    assert.deepEqual(oasis.agents.map((a) => a.slug), ["bravo", "sdr", "maven", "customer-support", "atlas", "aura"]);
    assert.deepEqual(workspaceTeammates({ oasis: true, manifest: oasis }).map((t) => t.slug), ["bravo", "sdr", "maven", "customer-support", "atlas"]);
    // Its own binding can be removed again: the overlay is left empty, never a seed copy.
    const remove = await toggle({ action: "remove", slug: "aura" });
    assert.equal(remove.status, 200, JSON.stringify(remove.body));
    assert.deepEqual(await rawStored(OASIS), { seed_overlay: true, agents: [] });
  });
  await check("toggle in a seed-backed workspace whose leads are not core: the switch is stored in the overlay; a seed lead cannot be removed", async () => {
    await login(USERS.suga);
    const { getManifest } = await import("../lib/manifest/loader");
    const remove = await toggle({ action: "remove", slug: "sdr" });
    assert.equal(remove.status, 409, JSON.stringify(remove.body));
    assert.equal(remove.body.error, "comes_with_setup");
    assert.equal(await rawStored(SUGA), null, "a refused removal wrote a row");
    const off = await toggle({ action: "disable", slug: "sdr" });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const raw = await rawStored(SUGA);
    assert.deepEqual(Object.keys(raw ?? {}).sort(), ["agents", "seed_overlay"]);
    assert.deepEqual((raw?.agents as Array<{ slug: string; enabled: boolean }>).map((a) => [a.slug, a.enabled]), [["sdr", false]]);
    const served = await getManifest("suga", SUGA);
    assert.equal(departmentChannelFor("sales", { oasis: false, manifest: served }).kind, "unavailable", "the switch reaches the channel");
    const on = await toggle({ action: "enable", slug: "sdr" });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(await rawStored(SUGA), { seed_overlay: true, agents: [] }, "back on: nothing of its own left to store");
  });
  await check("toggle: a house agent a self-signup's manifest still binds cannot be switched on (CodeRabbit #517); switching one off is allowed", async () => {
    await login(USERS.signup);
    const before = JSON.stringify(await rawStored(SELFSIGNUP));
    const on = await toggle({ action: "enable", slug: "maven" });
    assert.equal(on.status, 403, JSON.stringify(on.body));
    assert.equal(on.body.error, "house_agent_not_offered");
    assert.equal(JSON.stringify(await rawStored(SELFSIGNUP)), before, "a refused enable wrote the manifest");
    const off = await toggle({ action: "disable", slug: "bravo" });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.ok(!identity.namesPersona(off.body.message ?? ""), `the API named a persona: ${off.body.message}`);
    assert.equal((await stored(SELFSIGNUP))?.agents.find((a) => a.slug === "bravo")?.enabled, false);
  });
  await check("toggle: a workspace OASIS has not set up has no lineup to change; nothing is written", async () => {
    await login(USERS.fresh);
    const r = await toggle({ action: "add", slug: "fresh-helper" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_set_up");
    assert.equal(await rawStored(FRESH), null, "an unprovisioned workspace was given a manifest row");
  });

  // ── 5. A new teammate is bound when it is created ─────────────────────────
  await check("POST /api/agents: the new teammate is bound and On the moment it exists", async () => {
    await login(USERS.owner);
    const res = await post(agentsRoute, "/api/agents", {
      slug: "setter",
      name: "Setter",
      category: "sales",
      short_description: "Replies to new leads fast and books the call.",
      base_prompt: "You are the appointment setter for {{tenant.brand.name}}. Draft every message for approval.",
    });
    const body = (await res.json()) as { ok: boolean; bound?: boolean; agent?: { slug: string } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.bound, true);
    const binding = (await stored(CLIENT))?.agents.find((a) => a.slug === "setter");
    assert.ok(binding?.enabled === true && binding.core === false && !binding.departments, JSON.stringify(binding));
    const viewer = await resolveOsViewer();
    const team = await loadAiTeam(viewer as Extract<typeof viewer, { ok: true }>);
    const setter = team.custom.ok ? team.custom.value.find((c) => c.slug === "setter") : undefined;
    assert.equal(setter?.enabled, true, "the new teammate shows Off on the AI Team");
    assert.deepEqual(setter?.toggle, { slug: "setter", enabled: true, bound: true }, "and has a switch");
  });
  await check("POST /api/agents in OASIS's own workspace (it has no row): the binding sticks and the AI Team shows it On", async () => {
    await db.execute({ sql: "DELETE FROM tenant_manifests WHERE tenant_id = ?", args: [OASIS] });
    await login(USERS.cc);
    const res = await post(agentsRoute, "/api/agents", {
      slug: "renewal-chaser",
      name: "Renewal chaser",
      category: "sales",
      short_description: "Chases renewals before they lapse.",
      base_prompt: "You chase renewals for {{tenant.brand.name}} before they lapse. Draft every message for approval.",
    });
    const body = (await res.json()) as { ok: boolean; bound?: boolean };
    assert.equal(body.bound, true, JSON.stringify(body));
    // The first write stores OASIS's own binding only (a seed overlay), never
    // a copy of its seed, and every reader serves the seed plus that binding.
    const raw = await rawStored(OASIS);
    assert.deepEqual(Object.keys(raw ?? {}).sort(), ["agents", "seed_overlay"], `OASIS's row holds a copy of its seed: ${Object.keys(raw ?? {}).join(", ")}`);
    assert.deepEqual((raw?.agents as Array<{ slug: string }>).map((a) => a.slug), ["renewal-chaser"]);
    const { getManifest, getManifestByTenantId } = await import("../lib/manifest/loader");
    const served = await getManifest("oasis-ai-cc", OASIS);
    assert.ok(served.agents.some((a) => a.slug === "renewal-chaser" && a.enabled), "OASIS is served a manifest without its new teammate");
    const viewer = await resolveOsViewer();
    const team = await loadAiTeam(viewer as Extract<typeof viewer, { ok: true }>);
    const row = team.custom.ok ? team.custom.value.find((c) => c.slug === "renewal-chaser") : undefined;
    assert.equal(row?.enabled, true, "the new OASIS teammate shows Off");
    assert.deepEqual(team.leads.map((l) => l.name), ["Chief of Staff · Operations", "Sales", "Marketing", "Client Success", "Finance"]);
    // A code change to the seed still reaches OASIS after that write: a nav
    // label and a lead's name edited in code are served with the new binding.
    const nav0 = OASIS_AI_CC_SEED.nav[0].label;
    const sales = OASIS_AI_CC_SEED.agents.find((a) => a.slug === "sdr")!;
    const salesName = sales.display_name;
    try {
      OASIS_AI_CC_SEED.nav[0].label = "Edited in code";
      sales.display_name = "Sales (edited in code)";
      for (const after of [await getManifest("oasis-ai-cc", OASIS), await getManifestByTenantId(OASIS)]) {
        assert.equal(after?.nav[0].label, "Edited in code", "a seed edit stopped reaching OASIS after its first owner write");
        assert.equal(after?.agents.find((a) => a.slug === "sdr")?.display_name, "Sales (edited in code)");
        assert.ok(after?.agents.some((a) => a.slug === "renewal-chaser" && a.enabled), "and its own teammate is still there");
      }
    } finally {
      OASIS_AI_CC_SEED.nav[0].label = nav0;
      sales.display_name = salesName;
    }
  });

  // ── 6. Client components ──────────────────────────────────────────────────
  await check("the builder opens prefilled from ?template=, and the AI Team's switch says what it is", () => {
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/one-agent-roster.render.ts"], { encoding: "utf8", env });
    assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
    const html = JSON.parse(r.stdout) as Record<string, string>;
    const setter = TEAMMATE_TEMPLATES.find((t) => t.key === "setter")!;
    const text = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
    assert.match(html.setter, /value="Setter"/, "the name");
    assert.ok(text(html.setter).includes(setter.brief), "the brief, in the describe field");
    assert.ok(text(html.setter).includes(`value="${setter.summary}"`), "the one-line summary");
    assert.match(html.setter, /<option value="sales" selected="">/, "the category");
    for (const id of ["unknown", "none"]) {
      assert.doesNotMatch(html[id], /value="Setter"/, `${id}: an unknown or absent template starts empty`);
      assert.ok(!text(html[id]).includes(setter.brief), id);
    }
    assert.match(html.editing, /value="Existing agent"/, "editing ignores the template");
    assert.doesNotMatch(html.editing, /value="Setter"/);
    assert.match(html.toggleOn, /role="switch"/);
    assert.match(html.toggleOn, /aria-checked="true"/);
    assert.match(html.toggleOn, /aria-label="Sales lead: on"/);
    assert.match(html.toggleOn, />On</);
    assert.match(html.toggleOff, /aria-checked="false"/);
    assert.match(html.toggleOff, />Off</);
  });

  // ── 7. Provisioning ───────────────────────────────────────────────────────
  await check("provisioning writes each lead's departments; Set up again keeps a renamed lead and gives it the departments chosen now", () => {
    assert.deepEqual(
      neutralTeamFor(["chief_of_staff", "sales", "client_success"]).map((a) => [a.slug, a.display_name, a.departments]),
      [
        ["sdr", "Sales lead", ["sales"]],
        ["customer-support", "Client Success lead", ["client_success"]],
      ],
    );
    // A workspace provisioned before `departments`: its owner renamed Sales lead.
    const legacy = provisioned("legacy-co", "Legacy Co");
    legacy.agents = legacy.agents.map((a) => {
      const { departments: _drop, ...rest } = a;
      void _drop;
      return a.slug === "sdr" ? { ...rest, display_name: "Sam" } : rest;
    });
    const merged = mergeProvisionedManifest(legacy, provisioned("legacy-co", "Legacy Co"));
    assert.deepEqual(
      merged.agents.map((a) => [a.slug, a.display_name, a.departments]),
      [
        ["sdr", "Sam", ["sales"]],
        ["customer-support", "Client Success lead", ["client_success"]],
      ],
    );
    assert.equal(departmentChannelFor("sales", { oasis: false, manifest: merged }).kind, "agent", "the re-set-up lead answers again");
  });

  // ── 8. OASIS's operator surfaces keep the agents its bridge runs ──────────
  // Review R4: OASIS's business roster is its department leads now, but a
  // tenant cron's agent key maps to the repo the bridge runs it in
  // (bravo_cli/cron_runner.py SIBLING_ROOT_BY_AGENT_KEY), and CC's own agents
  // still run there. /operations and /health read the same list.
  await check("a tenant cron in OASIS may name any agent its bridge runs (Aura too), never a lead's library template; a client keeps its roster", async () => {
    const cronRoute = await import("../app/api/cron-jobs/route");
    const { oasisOperatorAgents } = await import("../lib/manifest/tenant-scope");
    const { OASIS_RUNTIME_AGENT_KEYS, isHouseAgentSlug } = await import("../lib/agents");
    assert.deepEqual(oasisOperatorAgents(OASIS), ["bravo", "atlas", "maven", "aura"]);
    assert.equal(oasisOperatorAgents(CLIENT), null, "a client workspace keeps its own roster");
    for (const k of OASIS_RUNTIME_AGENT_KEYS) assert.ok(isHouseAgentSlug(k), `${k} is not a house agent`);
    const create = async (agentKey: string) => {
      const res = await post(cronRoute, "/api/cron-jobs", {
        name: `Daily ${agentKey}`,
        schedule: "0 9 * * *",
        action_type: "snapshot_run",
        action_payload: { snapshot: "daily" },
        agent_key: agentKey,
      });
      return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
    };
    const reassign = (jobId: string, agentKey: string) => reassignCron(jobId, agentKey);
    await login(USERS.cc);
    const aura = await create("aura");
    assert.equal(aura.status, 200, `OASIS cannot schedule Aura: ${JSON.stringify(aura.body)}`);
    const sdr = await create("sdr");
    assert.equal(sdr.status, 403, JSON.stringify(sdr.body));
    assert.equal(sdr.body.error, "agent_key_not_allowed_for_tenant:sdr", "no bridge root maps a lead's library template");
    // A client owner no longer CREATES script jobs at all: that is for verified
    // platform operators (Automations guided setup PR1,
    // tests/script-automations-operator-only.test.ts). Its roster still governs
    // the scripts it already has, through the reassign (PATCH) path.
    await login(USERS.owner);
    const clientCreate = await create("sdr");
    assert.equal(clientCreate.status, 403, JSON.stringify(clientCreate.body));
    assert.equal(clientCreate.body.error, "script_automations_operator_only");
    await db.execute({
      sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, agent_key, name, schedule, action_type, action_payload, enabled)
            VALUES ('client-existing-job', ?, 'sdr', 'Existing client job', '0 9 * * *', 'snapshot_run', '{"snapshot":"daily"}', 1)`,
      args: [CLIENT],
    });
    assert.equal((await reassign("client-existing-job", "sdr")).status, 200, "a client reassigns a job to its own teammate");
    const house = await reassign("client-existing-job", "aura");
    assert.equal(house.status, 403, "a client reassigns a job to an OASIS house agent");
    assert.equal(house.body.error, "agent_key_not_allowed_for_tenant:aura");
    // Reassigning a job (PATCH), /operations and /health read the same list.
    for (const page of ["app/api/cron-jobs/[id]/route.ts", "app/operations/page.tsx", "app/health/page.tsx"]) {
      assert.match(readFileSync(join(ROOT, page), "utf8"), /oasisOperatorAgents\(/, `${page} lists OASIS's business roster`);
    }
  });
  // Verifier D3: the job picker on /automations was built from OASIS's roster,
  // so it offered sdr and customer-support (the API refuses them) and not Aura.
  await check("/automations offers a job only agents the cron API accepts: OASIS's bridge agents, a client's own roster", async () => {
    const { AutomationsContent } = await import("../components/automations/AutomationsContent");
    const { CronJobsManager } = await import("../components/automations/CronJobsManager");
    const { oasisOperatorAgents } = await import("../lib/manifest/tenant-scope");
    const { isHouseAgentSlug } = await import("../lib/agents");
    const cronRoute = await import("../app/api/cron-jobs/route");
    const find = (node: unknown, type: unknown): { props: Record<string, unknown> } | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const hit = find(n, type);
          if (hit) return hit;
        }
        return null;
      }
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (el.type === type && el.props) return el as { props: Record<string, unknown> };
      return el.props ? find(el.props.children, type) : null;
    };
    // The picker feeds two forms: create (verified operators only, so only
    // where the page grants canCreateScripts) and reassign on an existing job
    // (every admin). Each key offered must be accepted by the route that form
    // posts to.
    const offered = async (who: U, scriptAccess: "allowed" | "not_allowed", existingJobId?: string) => {
      await login(who);
      const picker = find(await AutomationsContent({ scriptAccess }), CronJobsManager);
      assert.ok(picker, `no job picker for ${who.email}`);
      assert.equal(picker.props.canCreateScripts, scriptAccess === "allowed", `${who.email}: create offered against the verdict`);
      const keys = picker.props.agentKeys as string[];
      for (const key of keys) {
        if (scriptAccess === "allowed") {
          const res = await post(cronRoute, "/api/cron-jobs", {
            name: `Picked ${key}`,
            schedule: "0 8 * * *",
            action_type: "snapshot_run",
            action_payload: { snapshot: "daily" },
            agent_key: key,
          });
          assert.equal(res.status, 200, `${who.email} was offered "${key}", which the cron API refuses: ${JSON.stringify(await res.json())}`);
        }
        if (existingJobId) {
          const res = await reassignCron(existingJobId, key);
          assert.equal(res.status, 200, `${who.email} was offered "${key}", which the reassign API refuses: ${JSON.stringify(res.body)}`);
        }
      }
      return keys;
    };
    assert.deepEqual(await offered(USERS.cc, "allowed"), oasisOperatorAgents(OASIS), "OASIS is offered the agents its bridge runs");
    const client = await offered(USERS.owner, "not_allowed", "client-existing-job");
    assert.ok(client.includes("sdr"), `the client's own lead is not offered: ${client.join(", ")}`);
    assert.ok(!client.some((k) => isHouseAgentSlug(k)), `a client is offered a house agent: ${client.join(", ")}`);
  });

  // ── 9. A workspace slug that cannot be read is a retry, never "not set up" ──
  // Verifier D1: resolveOwnedSlug answers a read that failed with null. The
  // Slack job and the channel map read that null as "no roster": a client's
  // mention was told "<Department> is not set up", and a channel mapping was
  // refused "no AI teammate", for departments that have one.
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__187_os_connections.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__209_connection_vendor_principal.sql"), "utf8"));
  await db.executeMultiple(`
    CREATE TABLE approvals (id TEXT PRIMARY KEY, tenant_id TEXT, idempotency_key TEXT);
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
  `);
  // The client's Slack is connected; no bot token is stored, so nothing can be posted.
  await db.batch(
    [
      {
        sql: `INSERT INTO tenant_connections (id, tenant_id, provider, scope_kind, auth_kind, external_account_id, external_account_label,
                status, last_health_verdict, last_health_at, connected_at, created_at, updated_at)
              VALUES ('conn-slack-client', ?, 'slack', 'tenant', 'app_install', 'T0CLIENT', 'Client Co', 'connected', 'healthy', ?, ?, ?, ?)`,
        args: [CLIENT, stamp, stamp, stamp, stamp],
      },
      {
        sql: `INSERT INTO provider_webhook_routes (id, tenant_id, provider, external_key, connection_id, created_at)
              VALUES ('route-slack-client', ?, 'slack', 'T0CLIENT', 'conn-slack-client', ?)`,
        args: [CLIENT, stamp],
      },
    ],
    "write",
  );
  const jobs = await import("../lib/slack/jobs");
  const channelsRoute = await import("../app/api/slack/channels/route");
  const mention = {
    v: 1 as const,
    kind: "mention" as const,
    tenantId: CLIENT,
    teamId: "T0CLIENT",
    channelId: "C0CLIENTS",
    channelName: "clients",
    threadTs: "1727700000.000100",
    eventId: "EvSLUGREAD1",
    slackUserId: "UCLIENT1",
    profileId: null,
    authorName: "Riley",
    text: "<@UBOTCLIENT> Client Success, draft a reply to Acme",
    channelDepartment: null,
    customerId: null,
  };
  let prepared = 0;
  const jobDeps = {
    db,
    now: () => new Date(),
    prepare: (async () => {
      prepared += 1;
      return { ok: false, status: 500, error: "should_not_run" };
    }) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
  };
  await check("a Slack mention whose workspace slug cannot be read is retried (the job throws): no 'not set up' notice, no model call", async () => {
    let out: { value?: unknown; error?: unknown };
    ownedSlugReadFails = true;
    try {
      out = await jobs.runSlackMentionJob(mention, jobDeps).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } finally {
      ownedSlugReadFails = false;
    }
    assert.ok(out.error instanceof Error, `the job answered instead of being retried: ${JSON.stringify(out.value)}`);
    assert.match(out.error.message, /no manifest slug/);
    assert.equal(prepared, 0, "a turn was prepared on a roster nobody could read");
    // The same mention with the slug readable reaches the Client Success lead's turn.
    const readable = await jobs.runSlackMentionJob({ ...mention, eventId: "EvSLUGREAD2" }, jobDeps);
    assert.equal(prepared, 1, `the readable mention never reached its lead: ${JSON.stringify(readable)}`);
  });
  await check("mapping a Slack channel when the workspace slug cannot be read answers 500, never 'no AI teammate'", async () => {
    await login(USERS.owner);
    const put = () =>
      channelsRoute.PUT(
        new NextRequest("http://localhost/api/slack/channels", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel_id: "C0SALES1", department: "sales" }),
        }),
      );
    let res: Response;
    ownedSlugReadFails = true;
    try {
      res = await put();
    } finally {
      ownedSlugReadFails = false;
    }
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.notEqual(body.error, "department_not_set_up");
    // With the slug readable, Sales (the client's own lead) passes the department check.
    const readable = (await (await put()).json()) as { error?: string };
    assert.notEqual(readable.error, "department_not_set_up", JSON.stringify(readable));
  });

  if (failures > 0) {
    console.log(`one-agent-roster: ${failures} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log("one-agent-roster: ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
