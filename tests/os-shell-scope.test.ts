/**
 * os-shell-scope.test.ts - which shell a page renders in, and who may open one
 * workspace's agent pages (OASIS OS W1a: U1-02, U1-04, U1-16..U1-18, and the
 * marketplace cross-workspace read).
 *
 * PINNED, run for real against a local libSQL file with real signed sessions.
 * next/headers, next/navigation, next/link, the stylesheet and the client
 * shell components are the only stand-ins (as in
 * tests/client-route-gating.test.ts); app/layout.tsx itself is executed.
 *
 *   1. A signed-in owner on /t/<own-slug>/leads gets the OS shell: rail
 *      sections and the breadcrumb/Ask header. The layout used to set the
 *      manifest override for the viewer's own slug, which switched the OS shell
 *      off and drew the legacy manifest sidebar around the workspace's own page.
 *   2. A verified operator previewing ANOTHER workspace's /t/<slug> still gets
 *      that workspace's manifest shell (unchanged). On their own slug, and on a
 *      slug their workspace's manifest row claims, they get the OS shell.
 *   3. Full-bleed pages render with no shell at all: /sign/<token>,
 *      /unsubscribe and /link-expired for an anonymous visitor (they drew the
 *      rail, "Your workspace" and Sign out around a signer), /desktop-link for
 *      a signed-in one (two headers, two logos).
 *   4. /t/<slug>/marketplace, /marketplace/<agent>, /marketplace/new and
 *      /editor answer 404 to a signed-in member of ANOTHER workspace. They
 *      checked only that a manifest existed, so anyone signed in could read
 *      another workspace's agents, display names, prompt overlays, private
 *      prompts and whole manifest. The workspace's own members and a verified
 *      operator still open them.
 *   5. The AI team's OS pages read only the session's workspace: /agents/new
 *      mounts the builder on the viewer's own slug, and /agents/<slug> serves
 *      only a teammate this workspace built; another workspace's private agent
 *      and a platform agent are 404s, the operator included. The roster links
 *      them and never /t/<slug>.
 *   6. "new" cannot be a teammate's slug (it is the builder's URL), and the
 *      breadcrumb names /t/<slug>/<page> by its page, not "T".
 *
 * Run: node --conditions=react-server --import tsx tests/os-shell-scope.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "os-shell-scope-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "os-shell-scope-test-secret-long-enough-000000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";
for (const k of [
  "PLATFORM_DEFAULT_OPENROUTER_API_KEY",
  "PLATFORM_DEFAULT_ANTHROPIC_API_KEY",
  "PLATFORM_DEFAULT_OPENAI_API_KEY",
  "PLATFORM_DEFAULT_GOOGLE_API_KEY",
]) {
  delete process.env[k];
}

// No page here may reach the network; a stray fetch fails loudly.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

// tsconfig sets jsx:"preserve", so tsx compiles JSX with the classic runtime,
// which expects a global React.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
/** The path middleware stamps as x-pathname; the root layout reads it. */
let currentPath = "/";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
function stubFile(rel: string, exports: Record<string, unknown>) {
  const p = join(ROOT, rel);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers({ "x-pathname": currentPath, host: "oasisai.work" }),
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
  usePathname: () => currentPath,
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// Client components (they cannot load under react-server). The trees under
// test only mount them, and their props are what is asserted.
const Mounted = (name: string) => Object.assign((_props: Record<string, unknown>) => null, { displayName: name });
const SidebarShell = Mounted("SidebarShell");
const MainShell = Mounted("MainShell");
const CustomAgentBuilder = Mounted("CustomAgentBuilder");
const AgentChat = Mounted("AgentChat");
stubFile("app/globals.css", {});
stubFile("components/SidebarShell.tsx", { SidebarShell });
stubFile("components/MainShell.tsx", { MainShell });
stubFile("components/PerfVitals.tsx", { PerfVitals: Mounted("PerfVitals") });
stubFile("components/ClientErrorReporter.tsx", { ClientErrorReporter: Mounted("ClientErrorReporter") });
stubFile("components/brand/OasisLogo.tsx", { OasisLogo: Mounted("OasisLogo") });
stubFile("components/marketplace/CustomAgentBuilder.tsx", { CustomAgentBuilder });
stubFile("components/marketplace/AgentSubscriptionPanel.tsx", { AgentSubscriptionPanel: Mounted("AgentSubscriptionPanel") });
stubFile("components/agents/AgentChat.tsx", { AgentChat });
stubFile("components/manifest/ManifestEditorChat.tsx", { ManifestEditorChat: Mounted("ManifestEditorChat") });

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const OTHER = "7c7c7c7c-0000-4000-8000-00000000007c";
/** A custom teammate OASIS built, and one another workspace built (private). */
const OASIS_TEAMMATE = "renewals-desk";
const OTHER_TEAMMATE = "ops-sniper";
const OTHER_OVERLAY = "OTHER-CO PRIVATE OVERLAY";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // OASIS owner on the operator alias: the verified platform operator
  owner: u(2, "owner@client.test"), // owner of client-co
  member: u(3, "riley@client.test"), // plain member of client-co
  rival: u(4, "owner@other.test"), // owner of other-co, a different workspace
} as const;
type Who = keyof typeof USERS;

async function login(who: Who | null): Promise<void> {
  if (!who) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  const user = USERS[who];
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function outcome(run: () => unknown): Promise<"404" | `redirect:${string}` | "rendered"> {
  try {
    await run();
    return "rendered";
  } catch (err) {
    const msg = (err as Error).message;
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test(msg)) return "404";
    const r = /^NEXT_REDIRECT;(.*)$/.exec(msg);
    if (r) return `redirect:${r[1]}`;
    throw err;
  }
}

type El = { type: unknown; props: Record<string, unknown> };
/** The first element of `type` in an unrendered tree (props walked, components not called). */
function findEl(node: unknown, type: unknown, seen = new Set<unknown>()): El | null {
  if (node === null || node === undefined || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, type, seen);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    if (el.type === type) return { type: el.type, props: el.props };
    for (const v of Object.values(el.props)) {
      const hit = findEl(v, type, seen);
      if (hit) return hit;
    }
  }
  return null;
}

async function main() {
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT, invited_by TEXT, joined_at TEXT,
      manager_user_id TEXT, deactivated_by TEXT, deactivation_reason TEXT, brand TEXT, manifesto TEXT,
      custom_fields TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, logo_url TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (slug TEXT PRIMARY KEY, name TEXT, category TEXT, short_description TEXT, description TEXT,
      base_prompt TEXT, required_tools TEXT, suggested_model TEXT, pricing TEXT, is_public INTEGER,
      is_oasis_managed INTEGER, created_by TEXT, tenant_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, enabled INTEGER, updated_at TEXT);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, last_seen_at TEXT,
      tool_capabilities TEXT, revoked_at TEXT);
  `);

  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const clientManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "client-co", answers: {} }));
  const otherManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "other-co", answers: {} }));
  // other-co's own names and instructions for two teammates: its private one,
  // and a public platform agent it enabled. Both are what the gate protects.
  otherManifest.agents = otherManifest.agents.filter((a) => a.slug !== "sdr");
  otherManifest.agents.push(
    { slug: OTHER_TEAMMATE, display_name: "Ops Lead", enabled: true, prompt_overlay: OTHER_OVERLAY },
    { slug: "sdr", display_name: "Other Co Sales", enabled: true, prompt_overlay: OTHER_OVERLAY },
  );
  // OASIS's own manifest row is saved under a slug that is not its tenant slug:
  // /t/oasis-ops is still the operator's OWN workspace.
  const oasisRow = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "oasis-ops", answers: {} }));

  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, tenant: string, role: string, owner: 0 | 1, name: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, display_name, agents_enabled, updated_at, joined_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '[]', ?, ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, name, name, stamp, stamp],
  });
  const manifestRow = (id: string, tenant: string, slug: string, m: unknown) => ({
    sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
    args: [id, tenant, slug, JSON.stringify(m), stamp, stamp],
  });
  const agentRow = (slug: string, name: string, tenant: string, prompt: string) => ({
    sql: `INSERT INTO agents (slug, name, category, short_description, base_prompt, required_tools, is_public, is_oasis_managed, created_by, tenant_id, created_at, updated_at)
          VALUES (?, ?, 'custom', 'Keeps the work moving.', ?, '[]', 0, 0, 'test', ?, ?, ?)`,
    args: [slug, name, prompt, tenant, stamp, stamp],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'other-co', 'Other Co')", args: [OTHER] },
      manifestRow("m-client", CLIENT, "client-co", clientManifest),
      manifestRow("m-other", OTHER, "other-co", otherManifest),
      manifestRow("m-oasis", OASIS, "oasis-ops", oasisRow),
      profile("cc", OASIS, "owner", 1, "Conaugh McKenna"),
      profile("owner", CLIENT, "owner", 1, "Alex Owner"),
      profile("member", CLIENT, "member", 0, "Riley Member"),
      profile("rival", OTHER, "owner", 1, "Robin Rival"),
      agentRow(OASIS_TEAMMATE, "Renewals Desk", OASIS, "You keep renewals moving for {{tenant.brand.name}}."),
      agentRow(OTHER_TEAMMATE, "Ops Sniper", OTHER, "OTHER-CO PRIVATE PROMPT: you run operations for {{tenant.brand.name}}."),
    ],
    "write",
  );

  console.log("os-shell-scope:");

  // ── 1-3. the root layout picks the shell ────────────────────────────────
  const RootLayout = (await import("../app/layout")).default;
  const PAGE = ReactNS.createElement("section", { id: "page-under-test" });
  async function shellAt(path: string, who: Who | null) {
    await login(who);
    currentPath = path;
    const tree = await RootLayout({ children: PAGE });
    const sidebar = findEl(tree, SidebarShell);
    const main = findEl(tree, MainShell);
    return {
      sidebar: sidebar?.props ?? null,
      main: main?.props ?? null,
      bare: !sidebar && !main && findEl(tree, "section") !== null,
    };
  }
  const osShell = (s: Awaited<ReturnType<typeof shellAt>>) =>
    Array.isArray(s.sidebar?.sections) && (s.sidebar!.sections as unknown[]).length > 0 && s.main?.header != null;

  await check("an owner on /t/<own-slug>/leads gets the OS shell: rail sections, breadcrumb and Ask", async () => {
    const s = await shellAt("/t/client-co/leads", "owner");
    assert.ok(s.sidebar && s.main, "the shell rendered");
    assert.ok(osShell(s), `expected the OS rail and header, got sections=${JSON.stringify(s.sidebar?.sections)} header=${JSON.stringify(s.main?.header)}`);
    assert.equal(s.sidebar!.brand, "Client Co", "the workspace's own name, not a manifest preview brand");
    const header = s.main!.header as { workspace: string; entries: unknown[] };
    assert.equal(header.workspace, "Client Co");
    assert.ok(header.entries.length > 0, "the breadcrumb resolves against the viewer's own rail");
  });

  await check("a plain member on /t/<own-slug> gets the OS shell too, and so does the owner on the workspace root", async () => {
    assert.ok(osShell(await shellAt("/t/client-co/leads", "member")), "member");
    assert.ok(osShell(await shellAt("/t/client-co", "owner")), "/t/<own-slug>");
  });

  await check("a verified operator previewing ANOTHER workspace still gets its manifest shell (unchanged)", async () => {
    const s = await shellAt("/t/client-co/leads", "cc");
    assert.ok(s.sidebar && s.main, "the shell rendered");
    assert.equal(s.sidebar!.sections, null, "the preview draws that workspace's manifest nav, not the operator's rail");
    assert.equal(s.main!.header, null, "no OS breadcrumb over another workspace's manifest");
  });

  await check("the operator on their own slug, and on a slug their manifest row claims, gets the OS shell", async () => {
    assert.ok(osShell(await shellAt("/t/oasis-ai-cc/leads", "cc")), "/t/oasis-ai-cc (the tenant slug)");
    assert.ok(osShell(await shellAt("/t/oasis-ops/leads", "cc")), "/t/oasis-ops (OASIS's manifest row)");
  });

  await check("a member of another workspace on /t/<other-slug> never gets that workspace's chrome", async () => {
    const s = await shellAt("/t/other-co/leads", "owner");
    assert.ok(osShell(s), "their own OS shell; the page itself refuses them");
    assert.equal(s.sidebar!.brand, "Client Co");
  });

  await check("public pages render with no shell for an anonymous visitor: /sign, /unsubscribe, /link-expired", async () => {
    for (const path of ["/sign/abc123", "/unsubscribe", "/link-expired"]) {
      const s = await shellAt(path, null);
      assert.equal(s.bare, true, `${path} rendered inside the OS shell for a visitor with no account`);
    }
  });

  await check("/desktop-link renders with no shell for a signed-in user (it draws its own header)", async () => {
    assert.equal((await shellAt("/desktop-link", "cc")).bare, true);
    assert.equal((await shellAt("/desktop-link", "owner")).bare, true);
    // Control: an ordinary page for the same viewer is inside the shell.
    assert.ok(osShell(await shellAt("/agents", "cc")));
  });

  // ── 4. the marketplace and the editor: the slug's own members, or the operator ─
  const marketplace = (await import("../app/t/[slug]/marketplace/page")).default;
  const marketplaceAgent = (await import("../app/t/[slug]/marketplace/[agent]/page")).default;
  const marketplaceNew = (await import("../app/t/[slug]/marketplace/new/page")).default;
  const editor = (await import("../app/t/[slug]/editor/page")).default;
  const open = (slug: string, agent = "sdr") => ({
    marketplace: () => marketplace({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }),
    "marketplace/<agent>": () => marketplaceAgent({ params: Promise.resolve({ slug, agent }) }),
    "marketplace/new": () => marketplaceNew({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }),
    editor: () => editor({ params: Promise.resolve({ slug }) }),
  });

  await check("a signed-in member of ANOTHER workspace gets a 404 from every /t/<slug> agent page", async () => {
    for (const who of ["owner", "member"] as const) {
      await login(who);
      // "sdr" is a public platform agent, so only the workspace gate stands
      // between this viewer and other-co's name and instructions for it; the
      // private teammate is refused by the agent's own visibility as well.
      for (const agent of ["sdr", OTHER_TEAMMATE]) {
        for (const [name, run] of Object.entries(open("other-co", agent))) {
          assert.equal(await outcome(run), "404", `${who} read other-co's ${name} (${agent})`);
        }
      }
    }
  });

  await check("the workspace's own members still open them, and see what the gate keeps from everyone else", async () => {
    await login("rival");
    for (const agent of ["sdr", OTHER_TEAMMATE]) {
      for (const [name, run] of Object.entries(open("other-co", agent))) {
        assert.equal(await outcome(run), "rendered", `other-co's owner lost ${name} (${agent})`);
      }
    }
    const { AgentSubscriptionPanel } = await import("../components/marketplace/AgentSubscriptionPanel");
    const detail = findEl(await marketplaceAgent({ params: Promise.resolve({ slug: "other-co", agent: "sdr" }) }), AgentSubscriptionPanel);
    const binding = detail?.props.binding as { display_name?: string; prompt_overlay?: string } | null | undefined;
    assert.equal(binding?.display_name, "Other Co Sales");
    assert.equal(binding?.prompt_overlay, OTHER_OVERLAY, "the detail page carries the workspace's own prompt overlay");
    await login("member");
    for (const [name, run] of Object.entries(open("client-co"))) {
      assert.equal(await outcome(run), "rendered", `client-co's member lost ${name}`);
    }
  });

  await check("a verified operator still opens another workspace's marketplace and editor", async () => {
    await login("cc");
    for (const [name, run] of Object.entries(open("other-co"))) {
      assert.equal(await outcome(run), "rendered", `the operator lost other-co's ${name}`);
    }
  });

  await check("an unknown workspace is the same 404, so the answer confirms nothing", async () => {
    await login("owner");
    for (const [name, run] of Object.entries(open("no-such-co"))) {
      assert.equal(await outcome(run), "404", name);
    }
  });

  // ── 5. the AI team's OS pages read only the session's workspace ─────────
  const newTeammate = (await import("../app/agents/new/page")).default;
  const teammateChat = (await import("../app/agents/[slug]/page")).default;
  const { workspaceChatSlug } = await import("../components/os/department/channel");

  await check("/agents/new mounts the builder on the viewer's own workspace slug", async () => {
    await login("cc");
    const tree = await newTeammate({ searchParams: Promise.resolve({}) });
    const builder = findEl(tree, CustomAgentBuilder);
    assert.ok(builder, "the builder is mounted");
    const own = await workspaceChatSlug(OASIS);
    assert.ok(own, "precondition: OASIS has a chat slug");
    assert.equal(builder!.props.tenantSlug, own, "the builder's slug is the session workspace's own");
    assert.equal(builder!.props.editing, null);
  });

  await check("/agents/new?edit= edits only a teammate this workspace built", async () => {
    await login("cc");
    const mine = findEl(await newTeammate({ searchParams: Promise.resolve({ edit: OASIS_TEAMMATE }) }), CustomAgentBuilder);
    assert.equal((mine!.props.editing as { slug: string } | null)?.slug, OASIS_TEAMMATE);
    const theirs = findEl(await newTeammate({ searchParams: Promise.resolve({ edit: OTHER_TEAMMATE }) }), CustomAgentBuilder);
    assert.equal(theirs!.props.editing, null, "another workspace's private agent is never loaded into the builder");
    const platform = findEl(await newTeammate({ searchParams: Promise.resolve({ edit: "sdr" }) }), CustomAgentBuilder);
    assert.equal(platform!.props.editing, null, "a platform agent is not editable here");
  });

  await check("/agents/<slug> chats with this workspace's own teammate, through the session (no slug sent)", async () => {
    await login("cc");
    const tree = await teammateChat({ params: Promise.resolve({ slug: OASIS_TEAMMATE }) });
    const chat = findEl(tree, AgentChat);
    assert.ok(chat, "the chat is mounted");
    assert.equal(chat!.props.agentSlug, OASIS_TEAMMATE);
    assert.equal(chat!.props.tenantSlug, undefined, "the route takes the workspace from the session");
    assert.equal(chat!.props.agentName, "Renewals Desk");
  });

  await check("/agents/<slug> is a 404 for another workspace's teammate, a platform agent and an unknown slug, even for the operator", async () => {
    await login("cc");
    for (const slug of [OTHER_TEAMMATE, "sdr", "bravo", "no-such-teammate"]) {
      assert.equal(await outcome(() => teammateChat({ params: Promise.resolve({ slug }) })), "404", slug);
    }
  });

  await check("a client workspace's owner gets the AI team pages' own answer (the rail's /agents row is OASIS-only today)", async () => {
    await login("owner");
    assert.equal(await outcome(() => newTeammate({ searchParams: Promise.resolve({}) })), "404");
    assert.equal(await outcome(() => teammateChat({ params: Promise.resolve({ slug: OASIS_TEAMMATE }) })), "404");
  });

  await check("the AI team roster links the builder and each teammate's chat to the OS pages, never /t/<slug>", async () => {
    await login("cc");
    const { resolveOsViewer } = await import("../components/os/department/viewer");
    const { loadAiTeam } = await import("../components/os/aiteam/roster");
    const viewer = await resolveOsViewer();
    assert.ok(viewer.ok, "viewer");
    const team = await loadAiTeam(viewer as Extract<typeof viewer, { ok: true }>, []);
    assert.equal(team.builderHref, "/agents/new");
    assert.ok(team.custom.ok, "custom teammates read");
    const mine = team.custom.ok ? team.custom.value.find((c) => c.slug === OASIS_TEAMMATE) : undefined;
    assert.equal(mine?.webHref, `/agents/${OASIS_TEAMMATE}`);
    const hrefs = JSON.stringify(team);
    assert.doesNotMatch(hrefs, /"\/t\//, "no AI team link leaves the OS shell");
  });

  await check("the AI team page's New teammate button and every template tile open /agents/new", async () => {
    await login("cc");
    const { TemplatePicker } = await import("../components/os/aiteam/TemplatePicker");
    const { TEAMMATE_TEMPLATES } = await import("../components/os/aiteam/templates");
    const AiTeamPage = (await import("../app/agents/page")).default;
    const tree = await AiTeamPage();
    const picker = findEl(tree, TemplatePicker);
    assert.equal(picker?.props.builderHref, "/agents/new", "the template tiles get the OS builder");
    const all: string[] = [];
    const collect = (node: unknown, seen = new Set<unknown>()) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach((n) => collect(n, seen));
      const el = node as { $$typeof?: symbol; props?: Record<string, unknown> };
      if (!el.$$typeof || !el.props) return;
      if (typeof el.props.href === "string") all.push(el.props.href);
      for (const v of Object.values(el.props)) collect(v, seen);
    };
    collect(tree);
    collect(TemplatePicker({ builderHref: "/agents/new" }));
    assert.ok(all.includes("/agents/new"), `the New teammate button: ${all.join(", ")}`);
    for (const t of TEAMMATE_TEMPLATES) {
      assert.ok(all.includes(`/agents/new?template=${encodeURIComponent(t.key)}`), `template ${t.key}`);
    }
    assert.deepEqual(all.filter((h) => h.startsWith("/t/")), [], "nothing on the AI team page leaves the OS shell");
  });

  // ── 6. the builder's URL is not a teammate, and /t/ pages have a crumb ──
  await check("'new' cannot be a teammate's slug: /agents/new is the builder", async () => {
    const { createCustomAgent, AgentPersistenceError } = await import("../lib/agents/persistence");
    const base = {
      name: "New hire",
      category: "custom" as const,
      short_description: "Welcomes new hires.",
      base_prompt: "You welcome new hires and answer their first-week questions.",
      created_by: USERS.cc.id,
      tenant_id: OASIS,
    };
    await assert.rejects(
      () => createCustomAgent({ ...base, slug: "new" }),
      (err: unknown) => err instanceof AgentPersistenceError && err.code === "validation" && /reserved/.test(err.message),
    );
    // Only the exact word: a slug that merely starts with it is fine.
    const created = await createCustomAgent({ ...base, slug: "new-hire" });
    assert.equal(created.slug, "new-hire");
  });

  await check("the breadcrumb names a /t/<slug>/<page> by its page, never 'T'", async () => {
    const { breadcrumbTrail } = await import("../lib/os/match");
    assert.deepEqual(breadcrumbTrail("/t/client-co/leads", []), ["Leads"]);
    assert.deepEqual(breadcrumbTrail("/t/client-co/leads/abc-123", []), ["Leads"]);
    assert.deepEqual(breadcrumbTrail("/t/client-co/marketplace", []), ["Marketplace"]);
    assert.deepEqual(breadcrumbTrail("/t/client-co", []), ["Overview"]);
    // Unchanged elsewhere.
    assert.deepEqual(breadcrumbTrail("/agents/new", [{ href: "/agents", label: "AI team" }]), ["AI team"]);
    assert.deepEqual(breadcrumbTrail("/system-health", []), ["System health"]);
    assert.deepEqual(breadcrumbTrail("/t", []), ["T"], "a bare /t is not a workspace page");
  });

  raw.close();
  console.log(`os-shell-scope: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
