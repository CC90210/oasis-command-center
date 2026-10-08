/**
 * agent-names.test.ts - a client owner and a sales rep never read OASIS's
 * internal agent names; OASIS's founders still do. The guard for the crawl's
 * root cause 2 (signed-in crawl 2026-10-02: 62 names in front of a client owner
 * or a rep; re-crawl of main 5806acd6 on 2026-10-08: 50).
 *
 * THE RULE (lib/os/agent-names.ts, with its viewer half
 * lib/os/agent-names-session.ts): one place decides what a viewer calls an
 * agent. A founder persona in an OASIS workspace (slug AND tenant id) reads the
 * internal names; everyone else reads each house agent as the department that
 * answers for it, the agent library offers house agents to the founders only,
 * and copy that drives OASIS's own agents by name (the prompts library, the
 * client-deploy runbook) is a founders' page.
 *
 * EACH SURFACE THE CRAWL FLAGGED is rendered here for real, as a client owner,
 * as an OASIS sales rep (closer) and, as the control that the names are still
 * there to leak, as CC:
 *   /t/<own>/marketplace           cards Atlas, Aura, Bravo, Maven
 *   /t/<own>/marketplace/<house>   (one click from those cards) and the
 *   /t/<own>/agent/<house>         legacy chat: the persona's page and prompt
 *   /t/<own>/editor                "Rename the Bravo agent to 'Ops Lead'."
 *   /t/oasis-ai-cc/reasoning       groups headed Bravo, Atlas, Maven
 *   /playbook/prompts              five descriptions naming Atlas, Bravo ...
 *   /playbook/client-deploy        "Atlas runs the math, Maven audits ..."
 *   /playbook/10-oasis-loop        "Last updated ... by Maven via ..."
 *   /settings/privacy              "Conaugh McKenna": NOT a leak. Quebec's Law
 *                                  25 requires the person in charge of personal
 *                                  information to be published, and CC holds the
 *                                  role (lib/legal/constants.ts PRIVACY_OFFICER).
 *                                  It is the one sanctioned name, checked as such.
 * plus /t/<slug> with no root page (a stored manifest that binds the house
 * agents under their persona names, as two live self-signup workspaces do).
 *
 * THE NAMES are the crawl's seven (scripts/qa/crawl-lib.mjs on the crawl
 * branch: Bravo, Maven, Atlas, Aura, Hermes, Lex, Conaugh), matched as whole
 * words in ANY case (a slug printed under CSS `uppercase` reads BRAVO), plus
 * every persona the runtime guard knows (lib/os/channel/identity.ts:
 * Solara, Helios, Lumen ...).
 *
 * Real pages, a real local libSQL file and real signed sessions; next/headers,
 * next/navigation, next/link and the client components that cannot load under
 * react-server are the only stand-ins (as in tests/client-route-gating.test.ts).
 * The manifest editor is a client component: tests/agent-names.render.ts draws
 * it in a child process from the props the real page built.
 *
 * Run: node --conditions=react-server --import tsx tests/agent-names.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "agent-names-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "agent-names-test-secret-long-enough-000000000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
delete process.env.STRIPE_SECRET_KEY;
process.env.ADMIN_EMAILS = "";

// No page here may reach the network; a stray fetch fails the page loudly.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

// tsconfig sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
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
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// Client components that cannot run under react-server. The pages only mount
// them; what they are handed is asserted, and the editor is drawn for real in
// tests/agent-names.render.ts.
const Mounted = (name: string) => Object.assign((_props: Record<string, unknown>) => null, { displayName: name });
const ManifestEditorChat = Mounted("ManifestEditorChat");
const AgentChat = Mounted("AgentChat");
const AgentSubscriptionPanel = Mounted("AgentSubscriptionPanel");
const PromptsLibraryFilter = Mounted("PromptsLibraryFilter");
stubFile("components/manifest/ManifestEditorChat.tsx", { ManifestEditorChat });
stubFile("components/agents/AgentChat.tsx", { AgentChat });
stubFile("components/marketplace/AgentSubscriptionPanel.tsx", { AgentSubscriptionPanel });
stubFile("components/playbook/PromptsLibraryFilter.tsx", { PromptsLibraryFilter });

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
// A self-signup whose manifest binds OASIS's house agents under their persona
// names, as the old setup wizard wrote them. Two live workspaces still carry
// exactly this (read-only check 2026-10-08: nodeops-control-center, fun).
const SIGNUP = "5e5e5e5e-0000-4000-8000-00000000005e";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // OASIS owner: reads the internal names
  closer: u(2, "closer@oasis-team.test"), // OASIS sales rep (closer)
  client: u(3, "owner@client.test"), // owner of a client workspace
  signup: u(4, "owner@selfsignup.test"), // owner of the self-signup above
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

/**
 * A server tree drawn the way a browser shows it: hook-free function
 * components are called, text children and the props a component prints
 * (title, subtitle, label ...) are text, and every href is collected. An async
 * component inside the tree fails loudly instead of being skipped.
 */
const SHOWN_PROPS = new Set(["title", "subtitle", "message", "label", "description", "placeholder", "alt", "aria-label", "action", "value"]);
function draw(node: unknown, out = { text: [] as string[], hrefs: [] as string[] }, depth = 0): { text: string[]; hrefs: string[] } {
  if (depth > 300 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) draw(n, out, depth + 1);
    return out;
  }
  if (!ReactNS.isValidElement(node)) return out;
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof node.type === "function") {
    const rendered = (node.type as (p: unknown) => unknown)(props);
    if (rendered instanceof Promise) throw new Error(`an async component inside the tree: ${(node.type as { name?: string }).name}`);
    return draw(rendered, out, depth + 1);
  }
  if (typeof props.href === "string") out.hrefs.push(props.href);
  for (const [k, v] of Object.entries(props)) {
    if (k === "children" || (typeof v === "object" && v !== null)) draw(v, out, depth + 1);
    else if (typeof v === "string" && SHOWN_PROPS.has(k)) out.text.push(v);
  }
  return out;
}

/** Every element in a tree of `type`, without calling components. */
function elementsOf(node: unknown, type: unknown, out: ReactNS.ReactElement[] = []): ReactNS.ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n, type, out);
    return out;
  }
  if (!ReactNS.isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  for (const v of Object.values((node.props ?? {}) as Record<string, unknown>)) elementsOf(v, type, out);
  return out;
}

const readable = (markup: string) =>
  markup
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*\btitle="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

/** The crawl's seven names, whole words, any case. */
const SEVEN = /\b(Bravo|Maven|Atlas|Aura|Hermes|Lex|Conaugh)\b/i;

// Characters the pages print, spelled by code point so this file stays ASCII.
const LSQUO = String.fromCharCode(0x2018);
const RSQUO = String.fromCharCode(0x2019);
/** What OASIS's seed calls the lead of Chief of Staff and Operations. */
const OASIS_LEAD = `Chief of Staff ${String.fromCharCode(0xb7)} Operations`;

async function main() {
  const identity = await import("../lib/os/channel/identity");
  /** The first internal name in `text`, or null. */
  const nameIn = (text: string): string | null => text.match(SEVEN)?.[0] ?? text.match(identity.PERSONA_NAME_PATTERN)?.[0] ?? null;
  const noName = (text: string, where: string) => {
    const hit = nameIn(text);
    if (hit === null) return;
    const at = text.toLowerCase().indexOf(hit.toLowerCase());
    assert.fail(`${where} shows "${hit}": ...${text.slice(Math.max(0, at - 60), at + 60)}...`);
  };

  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT, invited_by TEXT, joined_at TEXT,
      manager_user_id TEXT, deactivated_by TEXT, deactivation_reason TEXT, brand TEXT, manifesto TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, logo_url TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (slug TEXT PRIMARY KEY, name TEXT, category TEXT, short_description TEXT, description TEXT,
      base_prompt TEXT, required_tools TEXT, suggested_model TEXT, pricing TEXT, is_public INTEGER,
      is_oasis_managed INTEGER, created_by TEXT, tenant_id TEXT, created_at TEXT, updated_at TEXT);
  `);

  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const clientManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "client-co", answers: {} }));
  // The self-signup binds the house agents under their persona names and has
  // no root page, so /t/selfsignup draws the generic summary.
  const signupManifest = {
    ...clientManifest,
    tenant_slug: "selfsignup",
    pages: [],
    agents: [
      { slug: "bravo", display_name: "Bravo", enabled: true, primary: true },
      { slug: "atlas", display_name: "Atlas", enabled: true },
      { slug: "maven", display_name: "Maven", enabled: true },
    ],
  };

  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, tenant: string, role: string, owner: 0 | 1, name: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, display_name, agents_enabled, updated_at, joined_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '["bravo"]', ?, ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, name, name, stamp, stamp],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'selfsignup', 'Self Signup')", args: [SIGNUP] },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client', ?, 'client-co', ?, 1, 1, '2026-01-01', '2026-01-01')",
        args: [CLIENT, JSON.stringify(clientManifest)],
      },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-signup', ?, 'selfsignup', ?, 1, 1, '2026-01-01', '2026-01-01')",
        args: [SIGNUP, JSON.stringify(signupManifest)],
      },
      profile("cc", OASIS, "owner", 1, "Conaugh McKenna"),
      profile("closer", OASIS, "closer", 0, "Casey Closer"),
      profile("client", CLIENT, "owner", 1, "Alex Owner"),
      profile("signup", SIGNUP, "owner", 1, "Sam Signup"),
      // The client's own teammate, and a row of the client's squatting a
      // persona's slug: the library must not offer that one either.
      ...[
        ["intake-helper", "Intake Helper"],
        ["maven", "Maven"],
      ].map(([slug, name]) => ({
        sql: `INSERT INTO agents (slug, name, category, short_description, base_prompt, required_tools, pricing, is_public, is_oasis_managed, tenant_id, created_at, updated_at)
              VALUES (?, ?, 'support', 'Built by this workspace.', 'You help {{tenant.brand.name}} with intake questions.', '[]', '{"tier":"free"}', 0, 0, ?, ?, ?)`,
        args: [slug, name, CLIENT, stamp, stamp],
      })),
    ],
    "write",
  );

  const names = await import("../lib/os/agent-names");
  const { readsInternalAgentNames } = await import("../lib/os/agent-names-session");
  const { AGENT_REGISTRY } = await import("../lib/agents");
  const { PRIVACY_OFFICER } = await import("../lib/legal/constants");

  console.log("agent-names:");

  // -- the rule --
  await check("only an OASIS founder reads the internal names: by persona, OASIS's tenant id AND an OASIS slug", () => {
    const at = (persona: string, tenantId: string, tenantSlug: string | null) =>
      readsInternalAgentNames({ persona: persona as never, tenantId, tenantSlug });
    assert.equal(at("founder", OASIS, "oasis-ai-cc"), true, "CC");
    assert.equal(at("founder", CLIENT, "client-co"), false, "a client workspace's owner");
    assert.equal(at("founder", CLIENT, "oasis-ai-cc"), false, "a workspace that claims an OASIS slug");
    assert.equal(at("founder", OASIS, null), false, "an unreadable slug fails closed");
    for (const persona of ["sales", "manager", "marketing", "builder", "worker", "readonly", "legacy"]) {
      assert.equal(at(persona, OASIS, "oasis-ai-cc"), false, `an OASIS ${persona}`);
    }
    assert.equal(readsInternalAgentNames(null), false);
  });
  await check("every persona in the registry has a department, and is written as it in a label and in copy", () => {
    const personas = Object.values(AGENT_REGISTRY).filter((a) => a.key !== "codex");
    assert.ok(personas.length >= 9, `only ${personas.length} personas: the registry was not read`);
    for (const a of personas) {
      const dept = names.houseAgentDepartment(a.key);
      assert.ok(dept && !identity.namesPersona(dept), `${a.key}: ${dept}`);
      assert.equal(names.houseAgentDepartment(a.label), dept, `${a.label} by its name`);
      assert.equal(names.agentNameFor({ slug: a.key, name: a.label }, false), dept, `${a.key}'s label`);
      assert.equal(names.agentNameFor({ slug: a.key, name: a.label }, true), a.label, `a founder reads ${a.label}`);
      noName(names.agentTextFor(`Ask ${a.label} about it`, false), `copy naming ${a.label}`);
    }
    assert.equal(names.houseAgentDepartment("atlas"), "Finance");
    assert.equal(names.houseAgentDepartment("Maven"), "Marketing");
    assert.equal(names.houseAgentDepartment("bravo"), "Chief of Staff");
    assert.equal(names.houseAgentDepartment("hermes"), "Operations");
    assert.equal(names.houseAgentDepartment("sunbiz"), "Sales", "a legacy alias is its agent");
    assert.equal(names.houseAgentDepartment("sdr"), null, "a library template is not a house agent");
    assert.equal(names.houseAgentDepartment("codex"), null, "the executor behind custom agents is not a persona");
  });
  await check("a workspace's name for its teammate stands unless it is a persona's", () => {
    assert.equal(names.agentNameFor({ slug: "bravo", name: OASIS_LEAD }, false), OASIS_LEAD);
    assert.equal(names.agentNameFor({ slug: "bravo", name: "Bravo" }, false), "Chief of Staff");
    assert.equal(names.agentNameFor({ slug: "atlas", name: "" }, false), "Finance");
    assert.equal(names.agentNameFor({ slug: "sdr", name: "Sales lead" }, false), "Sales lead");
    assert.equal(names.agentNameFor({ slug: "intake-helper", name: "Intake Helper" }, false), "Intake Helper");
  });
  await check("copy: a name becomes its department; a lower-case slug, a longer word and a founder's copy are left alone", () => {
    assert.equal(names.agentTextFor("Pulled live - no revenue figures (that's Atlas).", false), "Pulled live - no revenue figures (that's Finance).");
    assert.equal(names.agentTextFor("handoff to Atlas / Maven / Aura / Hermes", false), "handoff to Finance / Marketing / Chief of Staff / Operations");
    assert.equal(names.agentTextFor("No revenue figures, that's Atlas's domain.", false), "No revenue figures, that's Finance's domain.");
    assert.equal(names.agentTextFor("Last updated: 2026-07-11 by Maven via Antigravity IDE.", false), "Last updated: 2026-07-11 by Marketing via Antigravity IDE.");
    assert.equal(names.agentTextFor("ASK MAVEN", false), "ASK Marketing");
    assert.equal(names.agentTextFor("agent_inbox.py list --to bravo", false), "agent_inbox.py list --to bravo", "a command keeps its slug");
    assert.equal(names.agentTextFor("Atlassian, Auralia Spa, a lexicon", false), "Atlassian, Auralia Spa, a lexicon", "only whole words");
    assert.equal(names.agentTextFor("that's Atlas", true), "that's Atlas", "a founder reads it as written");
  });
  await check("the library offers a house agent (or a row squatting its slug) to a founder only", () => {
    for (const slug of ["bravo", "atlas", "maven", "aura", "hermes", "lex", "solara", "helios", "life-preservation", "sunbiz", "MAVEN"]) {
      assert.equal(names.libraryOffersAgent(slug, false), false, slug);
      assert.equal(names.libraryOffersAgent(slug, true), true, slug);
    }
    for (const slug of ["sdr", "customer-support", "qa-reviewer", "intake-helper"]) assert.equal(names.libraryOffersAgent(slug, false), true, slug);
  });

  // -- the marketplace and its agent pages --
  const marketplace = (await import("../app/t/[slug]/marketplace/page")).default;
  const marketplaceAgent = (await import("../app/t/[slug]/marketplace/[agent]/page")).default;
  const agentChat = (await import("../app/t/[slug]/agent/[agent]/page")).default;
  const own: Record<Who, string> = { cc: "oasis-ai-cc", closer: "oasis-ai-cc", client: "client-co", signup: "selfsignup" };
  const HOUSE = ["bravo", "atlas", "maven", "aura", "hermes", "solara", "helios"];

  for (const who of ["client", "closer", "signup"] as const) {
    await check(`/t/${own[who]}/marketplace, ${who}: no persona on any card, and no card opens one`, async () => {
      await login(who);
      const page = draw(await marketplace({ params: Promise.resolve({ slug: own[who] }), searchParams: Promise.resolve({}) }));
      const text = page.text.join(" ");
      noName(text, `${who}'s marketplace`);
      assert.match(text, /SDR/, "the library rendered no cards; the check would be vacuous");
      const opened = page.hrefs.filter((h) => /\/marketplace\/[^/?]+$/.test(h)).map((h) => h.split("/").pop()!.toLowerCase());
      assert.ok(opened.length > 0, "no card links");
      assert.deepEqual(opened.filter((slug) => HOUSE.includes(slug)), [], "a card still opens a house agent");
    });
  }
  await check("/t/oasis-ai-cc/marketplace, CC: the founders still see their agents by name (the leak's source is still there)", async () => {
    await login("cc");
    const text = draw(await marketplace({ params: Promise.resolve({ slug: "oasis-ai-cc" }), searchParams: Promise.resolve({}) })).text.join(" ");
    for (const name of ["Bravo", "Atlas", "Maven", "Aura"]) assert.ok(new RegExp(`\\b${name}\\b`).test(text), `${name} is gone for CC`);
  });
  for (const who of ["client", "closer", "signup"] as const) {
    await check(`${who}: a house agent's marketplace page and its legacy chat are the 404; a template's still open`, async () => {
      await login(who);
      for (const agent of [...HOUSE, ...(who === "client" ? ["maven"] : [])]) {
        assert.equal(await outcome(() => marketplaceAgent({ params: Promise.resolve({ slug: own[who], agent }) })), "404", `/t/${own[who]}/marketplace/${agent}`);
        assert.equal(await outcome(() => agentChat({ params: Promise.resolve({ slug: own[who], agent }) })), "404", `/t/${own[who]}/agent/${agent}`);
      }
      const sdr = draw(await marketplaceAgent({ params: Promise.resolve({ slug: own[who], agent: "sdr" }) })).text.join(" ");
      assert.match(sdr, /SDR/, "a library template's page stays open");
      noName(sdr, `${who}'s SDR page`);
      assert.equal(await outcome(() => agentChat({ params: Promise.resolve({ slug: own[who], agent: "sdr" }) })), "rendered", "a template's chat stays open");
    });
  }
  await check("CC still opens Bravo's marketplace page and its chat", async () => {
    await login("cc");
    const text = draw(await marketplaceAgent({ params: Promise.resolve({ slug: "oasis-ai-cc", agent: "bravo" }) })).text.join(" ");
    assert.match(text, /\bBravo\b/);
    assert.equal(await outcome(() => agentChat({ params: Promise.resolve({ slug: "oasis-ai-cc", agent: "bravo" }) })), "rendered");
  });

  // -- the manifest editor --
  const editor = (await import("../app/t/[slug]/editor/page")).default;
  const editorProps: Record<string, Record<string, unknown>> = {};
  for (const who of ["client", "closer", "signup", "cc"] as const) {
    await check(`/t/${own[who]}/editor, ${who}: the editor is told whether ${who} reads internal names`, async () => {
      await login(who);
      const tree = await editor({ params: Promise.resolve({ slug: own[who] }) });
      const [el] = elementsOf(tree, ManifestEditorChat);
      assert.ok(el, "the editor is mounted");
      const props = JSON.parse(JSON.stringify(el.props)) as Record<string, unknown>;
      assert.equal(props.internalNames, who === "cc", "internalNames");
      editorProps[who] = props;
      noName(draw(tree).text.join(" "), `${who}'s editor header`);
    });
  }
  const renderEditors = (scenarios: Array<{ id: string; props: Record<string, unknown> }>) => {
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/agent-names.render.ts"], { encoding: "utf8", env, input: JSON.stringify(scenarios), cwd: ROOT });
    assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
    return JSON.parse(r.stdout) as Record<string, string>;
  };
  await check("the editor, drawn for real: the rename example names a teammate this workspace runs, and no persona anywhere", () => {
    for (const who of ["client", "closer", "signup", "cc"]) assert.ok(editorProps[who], `${who}'s editor props were not captured`);
    const html = renderEditors([
      ...(["client", "closer", "signup"] as const).map((who) => ({ id: who, props: editorProps[who] })),
      // The control: the self-signup's own bindings, drawn for a founder.
      { id: "signupForFounder", props: { ...editorProps.signup, internalNames: true } },
    ]);
    for (const who of ["client", "closer", "signup"]) noName(readable(html[who]), `${who}'s editor`);
    // The example is set in curly quotes (&lsquo; / &rsquo; in the JSX).
    const example = (agent: string) => `Rename the ${agent} agent to ${LSQUO}Ops Lead${RSQUO}`;
    assert.ok(readable(html.client).includes(example("Sales lead")), "the client's example names its own lead");
    assert.ok(readable(html.closer).includes(example(OASIS_LEAD)), "OASIS's example names its own lead");
    assert.ok(readable(html.signup).includes(example("Chief of Staff")), "the self-signup's example names its lead by department");
    assert.match(readable(html.signup), /Chief of Staff \(primary\), Finance, Marketing/, "the snapshot names the self-signup's bindings by department");
    assert.match(readable(html.signupForFounder), /Bravo \(primary\), Atlas, Maven/, "control: the bindings carry the persona names the rule removes");
  });

  // -- the Reasoning quick actions --
  const { ManifestReasoning } = await import("../components/manifest/ManifestReasoning");
  const { QuickActionsGrid } = await import("../components/reasoning/QuickActionsGrid");
  const { getManifest } = await import("../lib/manifest/loader");
  const oasisManifest = await getManifest("oasis-ai-cc");
  const reasoningAs = async (who: Who, manifest: Awaited<ReturnType<typeof getManifest>>) => {
    await login(who);
    const tree = await ManifestReasoning({ manifest, tenantSlug: manifest.tenant_slug });
    const [grid] = elementsOf(tree, QuickActionsGrid);
    return { tree, grid, page: draw(tree) };
  };
  await check("/t/oasis-ai-cc/reasoning, the rep: each group is a department, in department words, and only one the rep may open", async () => {
    const { grid, page } = await reasoningAs("closer", oasisManifest);
    assert.ok(grid, "no quick actions for the rep; the check would be vacuous");
    const text = page.text.join(" ");
    noName(text, "the rep's Reasoning");
    assert.match(text, /Chief of Staff/);
    assert.match(text, /Run the daily briefing/, "the rep keeps the actions they may use");
    const teams = page.hrefs.map((h) => /^\/team\/([a-z-]+)/.exec(h)?.[1]).filter(Boolean);
    assert.ok(teams.length > 0, "no ask links");
    assert.deepEqual([...new Set(teams)], ["chief-of-staff"], "the rep is handed an ask into a department they cannot open");
    for (const href of page.hrefs) noName(decodeURIComponent(href), "a prompt the rep is handed");
  });
  await check("/t/selfsignup/reasoning, its owner: the bound house agents are departments there too", async () => {
    const signup = await getManifest("selfsignup");
    const { grid, page } = await reasoningAs("signup", signup);
    assert.ok(grid, "no quick actions; the check would be vacuous");
    noName(page.text.join(" "), "the self-signup's Reasoning");
    for (const href of page.hrefs) noName(decodeURIComponent(href), "a prompt the owner is handed");
  });
  await check("/t/oasis-ai-cc/reasoning, CC: the founders' own names and every department", async () => {
    const { page } = await reasoningAs("cc", oasisManifest);
    const text = page.text.join(" ");
    for (const name of ["Bravo", "Atlas", "Maven"]) assert.ok(new RegExp(`\\b${name}\\b`).test(text), `${name} is gone for CC`);
    assert.ok(page.hrefs.some((h) => h.startsWith("/team/finance")), "CC lost Finance's asks");
  });

  // -- the Playbook --
  const playbookIndex = (await import("../app/playbook/page")).default;
  const playbookDoc = (await import("../app/playbook/[slug]/page")).default;
  const prompts = (await import("../app/playbook/prompts/page")).default;
  const clientDeploy = (await import("../app/playbook/client-deploy/page")).default;
  const drills = (await import("../app/playbook/drills/page")).default;
  const docParams = { params: Promise.resolve({ slug: "10-oasis-loop" }) };
  await check("the Playbook, the rep: the founders' pages are the 404 and are linked nowhere; the manual names departments", async () => {
    await login("closer");
    assert.equal(await outcome(() => prompts()), "404", "the prompts library");
    assert.equal(await outcome(() => clientDeploy()), "404", "the client-deploy runbook");
    const index = draw(await playbookIndex());
    noName(index.text.join(" "), "the rep's Playbook index");
    assert.ok(!index.hrefs.includes("/playbook/prompts"), "the index links the rep to the prompts library");
    assert.ok(index.hrefs.includes("/playbook/script"), "the rep keeps the call script");
    const drillPage = draw(await drills());
    noName(drillPage.text.join(" "), "the rep's drills");
    assert.ok(drillPage.hrefs.length > 0 && !drillPage.hrefs.includes("/playbook/client-deploy"), "the drills link the rep to the runbook");
    const doc = draw(await playbookDoc(docParams)).text.join(" ");
    noName(doc, "the rep's OASIS Loop");
    assert.match(doc, /Last updated: 2026-07-11 by Marketing via Antigravity IDE\./, "the manual itself still renders");
  });
  await check("the Playbook, CC: the prompts library, the runbook and the manual as written", async () => {
    await login("cc");
    assert.equal(await outcome(() => prompts()), "rendered");
    assert.equal(await outcome(() => clientDeploy()), "rendered");
    assert.ok(draw(await playbookIndex()).hrefs.includes("/playbook/prompts"), "CC lost the prompts card");
    assert.ok(draw(await drills()).hrefs.includes("/playbook/client-deploy"), "CC lost the drills' runbook link");
    assert.match(draw(await playbookDoc(docParams)).text.join(" "), /by Maven via Antigravity IDE/);
  });
  await check("the Playbook, a client owner: every page is the 404 (another workspace)", async () => {
    await login("client");
    for (const run of [() => playbookIndex(), () => playbookDoc(docParams), () => prompts(), () => clientDeploy(), () => drills()]) {
      assert.equal(await outcome(run), "404");
    }
  });

  // -- Settings > Data & privacy: the one sanctioned name --
  const privacy = (await import("../app/settings/privacy/page")).default;
  for (const who of ["client", "closer"] as const) {
    await check(`/settings/privacy, ${who}: the only name is the privacy officer Law 25 requires, by the legal constant`, async () => {
      await login(who);
      const text = draw(await privacy()).text.join(" ");
      assert.ok(text.includes(PRIVACY_OFFICER.name), "the designation is published");
      noName(text.split(PRIVACY_OFFICER.name).join(" "), `${who}'s Data & privacy`);
    });
  }

  // -- /t/<slug> with no root page --
  const tenantRoot = (await import("../app/t/[slug]/page")).default;
  await check("/t/selfsignup, its owner: the summary names the bound house agents by department", async () => {
    await login("signup");
    const text = draw(await tenantRoot({ params: Promise.resolve({ slug: "selfsignup" }) })).text.join(" ");
    noName(text, "the self-signup's summary");
    for (const dept of ["Chief of Staff", "Finance", "Marketing"]) assert.ok(text.includes(dept), `${dept} is not on the summary`);
  });

  console.log(`agent-names: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
