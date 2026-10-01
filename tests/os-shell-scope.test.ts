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
 *   4. /t/<slug>/marketplace, /marketplace/<agent>, /marketplace/new, /editor
 *      and the teammate chat /agent/<agent> answer 404 to a signed-in member of
 *      ANOTHER workspace. They checked only that a manifest existed, so anyone
 *      signed in could read another workspace's agents, display names, prompt
 *      overlays, private prompts and whole manifest. The workspace's own
 *      members and a verified operator still open them. A read that FAILS while
 *      deciding ownership is an error, never that same 404 (review R3).
 *   5. The AI team's OS pages read only the session's workspace: /agents/new
 *      mounts the builder on the viewer's own slug (a save opens the teammate's
 *      chat, a delete the AI team), and /agents/<slug> serves only a teammate
 *      this workspace built; another workspace's private agent and a platform
 *      agent are 404s, the operator included. The roster links them and never
 *      /t/<slug>.
 *   6. The legacy builder and teammate chat move a viewer to those OS pages
 *      only when the OS page serves them, by a temporary redirect the page
 *      makes (never a middleware 308): a client owner who clicks Build on their
 *      own marketplace reaches a working builder, an operator previewing
 *      another workspace stays on its page, and a platform agent's chat stays
 *      put (review R1, R5).
 *   7. "new" cannot be a teammate's slug (it is the builder's URL), and the
 *      breadcrumb names /t/<slug>/<page> by its page, not "T".
 *
 * Run: node --conditions=react-server --import tsx tests/os-shell-scope.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

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
  // A 308 a browser would cache for every later visitor; nothing here may use it.
  permanentRedirect: (url: string) => {
    throw new Error(`NEXT_PERMANENT_REDIRECT;${url}`);
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
const AgentSubscriptionPanel = Mounted("AgentSubscriptionPanel");
stubFile("app/globals.css", {});
stubFile("components/SidebarShell.tsx", { SidebarShell });
stubFile("components/MainShell.tsx", { MainShell });
stubFile("components/PerfVitals.tsx", { PerfVitals: Mounted("PerfVitals") });
stubFile("components/ClientErrorReporter.tsx", { ClientErrorReporter: Mounted("ClientErrorReporter") });
stubFile("components/brand/OasisLogo.tsx", { OasisLogo: Mounted("OasisLogo") });
stubFile("components/marketplace/CustomAgentBuilder.tsx", { CustomAgentBuilder });
stubFile("components/marketplace/AgentSubscriptionPanel.tsx", { AgentSubscriptionPanel });
stubFile("components/agents/AgentChat.tsx", { AgentChat });
stubFile("components/manifest/ManifestEditorChat.tsx", { ManifestEditorChat: Mounted("ManifestEditorChat") });

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const OTHER = "7c7c7c7c-0000-4000-8000-00000000007c";
/**
 * A workspace on a dedicated client shell: tenants.slug "suga-media", shell
 * slug "suga" from custom_fields (a code seed, so no manifest row: its tenants
 * row is what says it owns /t/suga).
 */
const SUGA_CO = "5d5d5d5d-0000-4000-8000-00000000005d";
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
  suga: u(5, "owner@suga.test"), // owner of the suga-media workspace (shell slug "suga")
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

type Outcome = "404" | `redirect:${string}` | `permanent:${string}` | "rendered";
function classify(err: unknown): Outcome {
  const msg = (err as Error).message;
  if (/NEXT_HTTP_ERROR_FALLBACK;404/.test(msg)) return "404";
  const r = /^NEXT_REDIRECT;(.*)$/.exec(msg);
  if (r) return `redirect:${r[1]}`;
  const p = /^NEXT_PERMANENT_REDIRECT;(.*)$/.exec(msg);
  if (p) return `permanent:${p[1]}`;
  throw err;
}

async function outcome(run: () => unknown): Promise<Outcome> {
  try {
    await run();
    return "rendered";
  } catch (err) {
    return classify(err);
  }
}

/** A page's outcome, and its tree when it rendered. */
async function visit(run: () => unknown): Promise<{ outcome: Outcome; tree: unknown }> {
  try {
    return { outcome: "rendered", tree: await run() };
  } catch (err) {
    return { outcome: classify(err), tree: null };
  }
}

/** Every literal href in an unrendered tree (props walked, components not called). */
function hrefsIn(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) hrefsIn(n, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; props?: Record<string, unknown> };
  if (!el.$$typeof || !el.props) return out;
  if (typeof el.props.href === "string") out.push(el.props.href);
  for (const v of Object.values(el.props)) hrefsIn(v, out, seen);
  return out;
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
      {
        sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'suga-media', 'Suga Media', ?)",
        args: [SUGA_CO, JSON.stringify({ command_center_profile_slug: "suga" })],
      },
      manifestRow("m-client", CLIENT, "client-co", clientManifest),
      manifestRow("m-other", OTHER, "other-co", otherManifest),
      manifestRow("m-oasis", OASIS, "oasis-ops", oasisRow),
      profile("cc", OASIS, "owner", 1, "Conaugh McKenna"),
      profile("owner", CLIENT, "owner", 1, "Alex Owner"),
      profile("member", CLIENT, "member", 0, "Riley Member"),
      profile("rival", OTHER, "owner", 1, "Robin Rival"),
      profile("suga", SUGA_CO, "owner", 1, "Sasha Suga"),
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

  await check("an owner whose /t/<slug> is only their shell slug (custom_fields), not tenants.slug, gets the OS shell; so does tenants.slug", async () => {
    // suga-media's shell slug is "suga" (a code seed with no manifest row), so
    // /t/suga matches only the custom_fields override, and /t/suga-media only
    // the tenants row.
    for (const path of ["/t/suga/leads", "/t/suga-media/leads", "/t/suga"]) {
      const s = await shellAt(path, "suga");
      assert.ok(osShell(s), `${path}: expected the OS rail and header, got sections=${JSON.stringify(s.sidebar?.sections)} header=${JSON.stringify(s.main?.header)}`);
      assert.equal(s.sidebar!.brand, "Suga Media", `${path}: the workspace's own name, not a manifest preview brand`);
    }
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

  // ── 4. the marketplace, the editor and the teammate chat: the slug's own members, or the operator ─
  const marketplace = (await import("../app/t/[slug]/marketplace/page")).default;
  const marketplaceAgent = (await import("../app/t/[slug]/marketplace/[agent]/page")).default;
  const marketplaceNew = (await import("../app/t/[slug]/marketplace/new/page")).default;
  const editor = (await import("../app/t/[slug]/editor/page")).default;
  const agentChatLegacy = (await import("../app/t/[slug]/agent/[agent]/page")).default;
  const newTeammate = (await import("../app/agents/new/page")).default;
  const teammateChat = (await import("../app/agents/[slug]/page")).default;
  const { middleware } = await import("../middleware");
  const open = (slug: string, agent = "sdr") => ({
    marketplace: () => marketplace({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }),
    "marketplace/<agent>": () => marketplaceAgent({ params: Promise.resolve({ slug, agent }) }),
    "marketplace/new": () => marketplaceNew({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }),
    editor: () => editor({ params: Promise.resolve({ slug }) }),
    "agent/<agent>": () => agentChatLegacy({ params: Promise.resolve({ slug, agent }) }),
  });

  /**
   * Where a click on a legacy URL ends: the legacy page itself, or the AI team
   * page it moves this viewer to, followed as the browser would.
   */
  async function landing(run: () => unknown): Promise<{ moved: string | null; outcome: Outcome; tree: unknown }> {
    const first = await visit(run);
    if (!first.outcome.startsWith("redirect:")) return { moved: null, ...first };
    const target = first.outcome.slice("redirect:".length);
    const url = new URL(target, "https://oasisai.work");
    const page = /^\/agents\/([^/]+)$/.exec(url.pathname);
    assert.ok(page, `a move left for ${target}, which is not an AI team page`);
    const next =
      page![1] === "new"
        ? () => newTeammate({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) })
        : () => teammateChat({ params: Promise.resolve({ slug: decodeURIComponent(page![1]) }) });
    return { moved: target, ...(await visit(next)) };
  }

  /** The real middleware, for whoever is signed in. */
  const throughMiddleware = (path: string) =>
    middleware(
      new NextRequest(`https://oasisai.work${path}`, {
        headers: sessionCookie ? { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } : {},
      }),
    );

  await check("a signed-in member of ANOTHER workspace gets a 404 from every /t/<slug> agent page", async () => {
    for (const who of ["owner", "member"] as const) {
      await login(who);
      // "sdr" is a public platform agent, so only the workspace gate stands
      // between this viewer and other-co's name and instructions for it (and,
      // on the teammate chat, whether other-co has it on); the private
      // teammate is refused by the agent's own visibility as well.
      for (const agent of ["sdr", OTHER_TEAMMATE]) {
        for (const [name, run] of Object.entries(open("other-co", agent))) {
          assert.equal(await outcome(run), "404", `${who} read other-co's ${name} (${agent})`);
        }
      }
    }
  });

  await check("the teammate chat refuses another workspace however its URL is spelled (/t/other-co/agent/%73dr is agent 'sdr')", async () => {
    await login("owner");
    // Middleware moves none of it, encoded or not: the page decides.
    for (const path of ["/t/other-co/agent/%73dr", "/t/other-co/agent/sdr"]) {
      const res = await throughMiddleware(path);
      assert.equal(res.headers.get("location"), null, `${path} was redirected by middleware`);
      assert.equal(res.headers.get("x-middleware-next"), "1", path);
    }
    // Next hands the page the decoded segments; any spelling of the slug.
    for (const slug of ["other-co", "Other-Co", "OTHER-CO"]) {
      assert.equal(await outcome(() => agentChatLegacy({ params: Promise.resolve({ slug, agent: "sdr" }) })), "404", slug);
    }
  });

  await check("the workspace's own members still open them, and see what the gate keeps from everyone else", async () => {
    await login("rival");
    for (const agent of ["sdr", OTHER_TEAMMATE]) {
      for (const [name, run] of Object.entries(open("other-co", agent))) {
        // A page that moves this viewer to the AI team's own page must land
        // on a working one.
        const end = await landing(run);
        assert.equal(end.outcome, "rendered", `other-co's owner lost ${name} (${agent})${end.moved ? ` via ${end.moved}` : ""}`);
      }
    }
    // The stand-in itself, not a re-import of its path: the element type the
    // page mounted is this function.
    const detail = findEl(await marketplaceAgent({ params: Promise.resolve({ slug: "other-co", agent: "sdr" }) }), AgentSubscriptionPanel);
    const binding = detail?.props.binding as { display_name?: string; prompt_overlay?: string } | null | undefined;
    assert.equal(binding?.display_name, "Other Co Sales");
    assert.equal(binding?.prompt_overlay, OTHER_OVERLAY, "the detail page carries the workspace's own prompt overlay");
    await login("member");
    for (const [name, run] of Object.entries(open("client-co"))) {
      const end = await landing(run);
      assert.equal(end.outcome, "rendered", `client-co's member lost ${name}${end.moved ? ` via ${end.moved}` : ""}`);
    }
  });

  await check("a verified operator still opens another workspace's marketplace, editor and chat, and is never moved off them", async () => {
    await login("cc");
    // No move: the AI team's pages act on the operator's OWN workspace, so the
    // builder there would save into OASIS, not the workspace being previewed.
    for (const [name, run] of Object.entries(open("other-co"))) {
      assert.equal(await outcome(run), "rendered", `the operator lost other-co's ${name}`);
    }
    const builder = findEl(await marketplaceNew({ params: Promise.resolve({ slug: "other-co" }), searchParams: Promise.resolve({}) }), CustomAgentBuilder);
    assert.equal(builder?.props.tenantSlug, "other-co", "the previewed workspace's builder");
  });

  await check("a failed read while deciding ownership is an error, never the 404 a stranger gets", async () => {
    // suga-media owns /t/suga through its tenants row (no manifest row claims
    // the seed slug), so a failed tenants read is exactly the blip that used to
    // 404 the workspace's own owner (review R3).
    await login("suga");
    const openOwn = () => marketplace({ params: Promise.resolve({ slug: "suga" }), searchParams: Promise.resolve({}) });
    assert.equal(await outcome(openOwn), "rendered", "precondition: the owner opens their own marketplace");
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    await raw.execute("ALTER TABLE tenants RENAME TO tenants_unreadable");
    try {
      await assert.rejects(openOwn(), (err: Error) => {
        assert.doesNotMatch(err.message, /NEXT_HTTP_ERROR_FALLBACK|NEXT_REDIRECT/, "a failed read answered as a refusal");
        return true;
      });
      assert.ok(logged.some((a) => a[0] === "[tenant-access.owned_slug]"), "the failure is logged under its own tag");
    } finally {
      console.error = realError;
      await raw.execute("ALTER TABLE tenants_unreadable RENAME TO tenants");
    }
    assert.equal(await outcome(openOwn), "rendered", "and the page is back once the read works");
  });

  await check("an unknown workspace is the same 404, so the answer confirms nothing", async () => {
    await login("owner");
    for (const [name, run] of Object.entries(open("no-such-co"))) {
      assert.equal(await outcome(run), "404", name);
    }
  });

  // ── 5. the AI team's OS pages read only the session's workspace ─────────
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

  await check("the builder on /agents/new opens a saved teammate's chat and returns a delete to the AI team; the marketplace's keeps its own", async () => {
    await login("cc");
    const team = findEl(await newTeammate({ searchParams: Promise.resolve({}) }), CustomAgentBuilder);
    assert.equal(team?.props.home, "ai-team", "/agents/new tells the builder where it is");
    // The marketplace's own builder (the operator's preview never moves).
    const market = findEl(await marketplaceNew({ params: Promise.resolve({ slug: "other-co" }), searchParams: Promise.resolve({}) }), CustomAgentBuilder);
    assert.ok(market, "the marketplace builder is mounted");
    assert.equal(market!.props.home, undefined, "the marketplace page keeps the marketplace's paths");

    const { builderPaths } = await import("../components/marketplace/builder-paths");
    const ai = builderPaths("oasis-ai-cc", "ai-team");
    assert.equal(ai.saved(OASIS_TEAMMATE), `/agents/${OASIS_TEAMMATE}`, "a save opens the teammate's chat");
    assert.equal(ai.afterDelete, "/agents", "a delete returns to the AI team");
    assert.equal(ai.slugHint("<slug>"), "Chat URL: /agents/<slug>");
    assert.doesNotMatch(
      [ai.saved("x"), ai.afterDelete, ai.slugHint("x"), ai.createdNote].join(" "),
      /marketplace|\/t\//i,
      "nothing on the AI team's builder points back at the marketplace",
    );
    for (const p of ["agents/[slug]/page.tsx", "agents/page.tsx"]) assert.ok(existsSync(join(ROOT, "app", p)), `app/${p}`);
    // Left out, the marketplace's own paths, word for word as before.
    const mk = builderPaths("client-co");
    assert.equal(mk.saved("x"), "/t/client-co/marketplace/x");
    assert.equal(mk.afterDelete, "/t/client-co/marketplace");
    assert.equal(mk.slugHint("<slug>"), "Marketplace URL: /t/client-co/marketplace/<slug>");
    assert.equal(mk.createdNote, "Created. Redirecting to the marketplace...");

    // The builder is a client component (it cannot run under react-server), so
    // its source is read: every place it sends someone comes from builderPaths.
    const src = readFileSync(join(ROOT, "components/marketplace/CustomAgentBuilder.tsx"), "utf8");
    assert.match(src, /const paths = builderPaths\(tenantSlug, home\);/);
    assert.match(src, /router\.push\(paths\.saved\(data\.agent\.slug\)\)/, "a save");
    assert.match(src, /router\.push\(paths\.afterDelete\)/, "a delete");
    assert.match(src, /hint=\{paths\.slugHint\(/, "the slug hint");
    assert.match(src, /setFlash\(isEdit \? "Saved\." : paths\.createdNote\)/, "the note while it opens");
    assert.doesNotMatch(src, /`\/t\/|\/marketplace\//, "a path built in the builder instead of builder-paths.ts");
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

  // ── 6. the legacy builder and chat hand off to the OS pages, viewer by viewer ─
  await check("a client owner who clicks Build on their own marketplace reaches a working builder", async () => {
    await login("owner");
    const hrefs = hrefsIn(await marketplace({ params: Promise.resolve({ slug: "client-co" }), searchParams: Promise.resolve({}) }));
    assert.ok(hrefs.includes("/t/client-co/marketplace/new"), `the Build custom link: ${hrefs.join(", ")}`);
    // Middleware lets the click through: a move it made could not know whether
    // the OS builder serves this viewer (it did not, and 404'd every client).
    const res = await throughMiddleware("/t/client-co/marketplace/new");
    assert.equal(res.headers.get("location"), null, `middleware moved the click (status ${res.status})`);
    assert.equal(res.headers.get("x-middleware-next"), "1");
    // The page: a working builder on the workspace's own slug, here, or on the
    // AI team's page once the rail opens it to client owners (decision 22).
    const end = await landing(() => marketplaceNew({ params: Promise.resolve({ slug: "client-co" }), searchParams: Promise.resolve({}) }));
    assert.equal(end.outcome, "rendered", `the click ended on ${end.outcome}${end.moved ? ` via ${end.moved}` : ""}`);
    const builder = findEl(end.tree, CustomAgentBuilder);
    assert.ok(builder, "the builder is mounted");
    assert.equal(builder!.props.tenantSlug, "client-co", "the client's own workspace");
  });

  await check("a viewer the AI team serves moves from the legacy builder to /agents/new, query kept, by a temporary redirect", async () => {
    await login("cc");
    const legacyNew = (slug: string, sp: Record<string, string>) =>
      outcome(() => marketplaceNew({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }));
    // `redirect:` is Next's redirect() (307). permanentRedirect() would read
    // `permanent:`: a 308 the browser caches for every later visitor.
    assert.equal(await legacyNew("oasis-ai-cc", {}), "redirect:/agents/new");
    assert.equal(await legacyNew("oasis-ops", {}), "redirect:/agents/new", "a slug OASIS's manifest row claims is its own too");
    assert.equal(await legacyNew("oasis-ai-cc", { edit: OASIS_TEAMMATE }), `redirect:/agents/new?edit=${OASIS_TEAMMATE}`);
    assert.equal(await legacyNew("oasis-ai-cc", { template: "setter" }), "redirect:/agents/new?template=setter");
    const end = await landing(() =>
      marketplaceNew({ params: Promise.resolve({ slug: "oasis-ai-cc" }), searchParams: Promise.resolve({ edit: OASIS_TEAMMATE }) }),
    );
    assert.equal(end.outcome, "rendered");
    const editing = findEl(end.tree, CustomAgentBuilder)?.props.editing as { slug?: string } | null | undefined;
    assert.equal(editing?.slug, OASIS_TEAMMATE, "the teammate the Edit link named is in the OS builder");
  });

  await check("a workspace's own custom teammate moves to /agents/<agent>; a platform agent's chat stays on the workspace's page", async () => {
    await login("cc");
    const legacyChat = (agent: string) => visit(() => agentChatLegacy({ params: Promise.resolve({ slug: "oasis-ai-cc", agent }) }));
    assert.equal((await legacyChat(OASIS_TEAMMATE)).outcome, `redirect:/agents/${OASIS_TEAMMATE}`);
    // /agents/<agent> serves only the workspace's own teammates, so a platform
    // agent's chat moved there would end on a 404 (review R5).
    assert.equal(await outcome(() => teammateChat({ params: Promise.resolve({ slug: "sdr" }) })), "404", "precondition");
    const platform = await legacyChat("sdr");
    assert.equal(platform.outcome, "rendered", "the platform agent's chat moved to a 404");
    assert.equal(findEl(platform.tree, AgentChat)?.props.agentSlug, "sdr");
  });

  await check("the legacy builder and chat move a viewer exactly when the OS page serves them, so a move never ends on a 404", async () => {
    const cases: Array<[Who, string, string | null]> = [
      ["cc", "oasis-ai-cc", OASIS_TEAMMATE],
      ["owner", "client-co", null],
      ["member", "client-co", null],
      ["rival", "other-co", OTHER_TEAMMATE],
      ["suga", "suga", null],
    ];
    for (const [who, slug, teammate] of cases) {
      await login(who);
      const served = (await outcome(() => newTeammate({ searchParams: Promise.resolve({}) }))) === "rendered";
      const legacy = await outcome(() => marketplaceNew({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }));
      assert.equal(legacy, served ? "redirect:/agents/new" : "rendered", `${who} on /t/${slug}/marketplace/new`);
      if (!teammate) continue;
      const chatServed = (await outcome(() => teammateChat({ params: Promise.resolve({ slug: teammate }) }))) === "rendered";
      const chat = await outcome(() => agentChatLegacy({ params: Promise.resolve({ slug, agent: teammate }) }));
      assert.equal(chat, chatServed ? `redirect:/agents/${teammate}` : "rendered", `${who} on /t/${slug}/agent/${teammate}`);
    }
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

  // ── 7. the builder's URL is not a teammate, and /t/ pages have a crumb ──
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
