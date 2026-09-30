/**
 * client-route-gating.test.ts - OASIS OS track T1: what a client can open, and
 * what every page says to a person who cannot read a log.
 *
 * WHAT IS PINNED, run for real against a local libSQL file with real signed
 * sessions (next/headers, next/navigation and next/link are the only stand-ins,
 * as in tests/os-landings.test.ts):
 *
 *   1. The legacy SunBiz and placeholder pages are retired: /contacts, /embed,
 *      /offers, /lenders, /funded-deals, /applications, /sms, /email-blast,
 *      /metrics, /templates and /renewals answer 404 to a client owner and to
 *      CC alike.
 *   2. /commissions asks the rail: a client owner gets a 404 (it is OASIS's
 *      commission ledger), an OASIS closer and CC still open it.
 *   3. /forms, /sequences and /import ask the rail too: a client owner opens
 *      them, an unprovisioned workspace and a signed-out visitor get a 404. A
 *      failed Forms or Drips read says so in one plain sentence and logs the
 *      detail; no driver text, no migration command, no vendor name.
 *   4. /training and /objections send a session whose profile is not linked to
 *      a workspace to /login?next=... (it was /auth/login, which never existed).
 *   5. /team renders a member's name with no stray 0 after it: libSQL hands the
 *      is_owner / admin_access flags back as 0/1, and `{m.is_owner && ...}`
 *      printed the 0.
 *   6. Settings > AI brain for a client owner, and Profile's agent picker, name
 *      no OASIS persona (Bravo, Atlas, Maven, Aura, Hermes, Solara, Helios) and
 *      say neither "empire" nor "C-suite"; teammates are named by department.
 *      OASIS's own owner is not offered add-ons by persona name either.
 *   7. Today's "we could not confirm your workspace" screen sends the person to
 *      the support form and the verified inbox, not to "CC".
 *   8. The error boundaries say what to do (try again, then send the code
 *      through the support form or by email) and never mention the hosting
 *      provider's logs. The AI-not-set-up notice gives an owner the Settings
 *      link and nobody a setting name.
 *   9. Goal pace's "Set one in Settings" lands on Settings > Team, whose
 *      Revenue goal section carries the id the link's fragment opens.
 *
 * Client components render in a child process (tests/client-route-gating.render.ts)
 * because react-dom/server does not load under react-server.
 *
 * Run: node --conditions=react-server --import tsx tests/client-route-gating.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "client-route-gating-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "client-route-gating-test-secret-long-enough-01";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
delete process.env.STRIPE_SECRET_KEY;
process.env.ADMIN_EMAILS = "adon@oasisai.work";

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
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// Client modules that call createContext at import time cannot load under
// react-server. The pages only mount them; nothing here renders them.
function stubFile(rel: string, exports: Record<string, unknown>) {
  const p = join(__dirname, "..", rel);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
const Mounted = (name: string) => Object.assign(() => null, { displayName: name });
stubFile("components/sequences/SequencesTabs.tsx", { SequencesTabs: Mounted("SequencesTabs") });
// A class component (React.Component is not exported under react-server). A
// pass-through keeps its children in the tree the walkers read.
stubFile("components/SafeBoundary.tsx", {
  SafeBoundary: ({ children }: { children?: unknown }) => children,
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const NEWCO = "7d7d7d7d-0000-4000-8000-00000000007d";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // OASIS owner; default operator alias
  closer: u(2, "closer@oasis-team.test"), // OASIS closer (sales)
  client: u(3, "owner@client.test"), // owner of a provisioned client workspace
  member: u(4, "riley@client.test"), // plain member of that client workspace
  newbie: u(5, "owner@new-co.test"), // owner of a workspace OASIS has not set up
  unlinked: u(6, "lost@nowhere.test"), // signed in, profile has no workspace
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
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
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

/** Every string/number and every element in a returned (unrendered) tree. */
type Found = { strings: string[]; elements: Array<{ type: unknown; props: Record<string, unknown> }> };
function walk(node: unknown, out: Found = { strings: [], elements: [] }, seen = new Set<unknown>()): Found {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.strings.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    out.elements.push({ type: el.type, props: el.props });
    walk(el.props, out, seen);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) walk(v, out, seen);
  return out;
}

/**
 * What a server tree shows a reader: text children, plus the props a
 * component prints (title, subtitle, message...). Data props such as agent
 * slugs handed to a client card are not text; the client components in `skip`
 * are checked through their own rendered markup instead.
 */
const SHOWN_PROPS = new Set(["title", "subtitle", "message", "label", "description", "placeholder", "alt", "aria-label", "action"]);
function visibleText(node: unknown, skip: Set<unknown>, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) visibleText(n, skip, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (!el.$$typeof || !el.props || skip.has(el.type)) return out;
  for (const [k, v] of Object.entries(el.props)) {
    if (k === "children" || SHOWN_PROPS.has(k) || (typeof v === "object" && v !== null && "$$typeof" in v)) {
      visibleText(v, skip, out, seen);
    }
  }
  return out;
}

/** Strings of a tree with its hook-free function components rendered too. */
function deepText(node: unknown, opaque: Set<unknown>, out: string[] = [], depth = 0): string[] {
  if (depth > 80 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) deepText(n, opaque, out, depth + 1);
    return out;
  }
  if (ReactNS.isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function" && !opaque.has(node.type)) {
      deepText((node.type as (p: unknown) => unknown)(props), opaque, out, depth + 1);
      return out;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") deepText(v, opaque, out, depth + 1);
      else if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

/** The raw primitive children of every element: where a stray `0` shows up. */
function primitiveChildren(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (node === null || node === undefined || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) primitiveChildren(n, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; props?: { children?: unknown } };
  if (el.$$typeof && el.props) {
    const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
    for (const k of kids) {
      if (typeof k === "number" || typeof k === "string") out.push(k);
      else primitiveChildren(k, out, seen);
    }
    for (const [key, v] of Object.entries(el.props)) if (key !== "children") primitiveChildren(v, out, seen);
  }
  return out;
}

const PERSONA_NAMES = /\b(bravo|atlas|maven|aura|hermes|solara|helios)\b|empire|c-suite/i;
const readable = (markup: string) =>
  markup
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*\btitle="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

async function main() {
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
    -- Settings > AI brain reads these; empty is "no key, no bridge", not a failure.
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, last_seen_at TEXT,
      tool_capabilities TEXT, revoked_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, agent_name TEXT, provider TEXT,
      encrypted_api_key TEXT, enabled INTEGER, user_id TEXT);
  `);

  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const clientManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "client-co", answers: {} }));

  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, tenant: string | null, role: string, owner: 0 | 1, name: string, linked = true) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, display_name, agents_enabled, updated_at, joined_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '["bravo"]', ?, ?)`,
    args: [`p-${who}`, linked ? USERS[who].id : null, USERS[who].email, tenant, role, owner, stamp, name, name, stamp, stamp],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'new-co', 'New Co')", args: [NEWCO] },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client', ?, 'client-co', ?, 1, 1, '2026-01-01', '2026-01-01')",
        args: [CLIENT, JSON.stringify(clientManifest)],
      },
      profile("cc", OASIS, "owner", 1, "Conaugh McKenna"),
      profile("closer", OASIS, "closer", 0, "Casey Closer"),
      profile("client", CLIENT, "owner", 1, "Alex Owner"),
      profile("member", CLIENT, "member", 0, "Riley"),
      profile("newbie", NEWCO, "owner", 1, "Nia New"),
      profile("unlinked", null, "member", 0, "Lost User"),
    ],
    "write",
  );

  const { SUPPORT_FORM_PATH } = await import("../lib/delivery/support-form");
  const { CONTACT_EMAIL } = await import("../lib/marketing/routes");

  console.log("client-route-gating:");

  // ── 1. retired pages ───────────────────────────────────────────────────
  const RETIRED = [
    "contacts", "embed", "offers", "lenders", "funded-deals", "applications",
    "sms", "email-blast", "metrics", "templates", "renewals",
  ];
  for (const route of RETIRED) {
    const page = (await import(`../app/${route}/page`)).default as () => unknown;
    await check(`/${route} is retired: 404 for a client owner and for CC`, async () => {
      for (const who of ["client", "cc"] as const) {
        await login(who);
        assert.equal(await outcome(() => page()), "404", `${who} opened /${route}`);
      }
      const src = readFileSync(join(ROOT, `app/${route}/page.tsx`), "utf8");
      assert.doesNotMatch(src, /^import (?!\{ notFound \} from "next\/navigation")/m, "a retired page imports nothing else");
    });
  }

  // ── 2. /commissions ───────────────────────────────────────────────────
  const commissions = (await import("../app/commissions/page")).default;
  await check("/commissions: a client owner gets a 404; an OASIS closer and CC open it", async () => {
    await login("client");
    assert.equal(await outcome(() => commissions()), "404", "a client owner reached OASIS's commission portal");
    for (const who of ["closer", "cc"] as const) {
      await login(who);
      assert.equal(await outcome(() => commissions()), "rendered", `${who} lost /commissions`);
    }
  });

  // ── 3. /forms, /sequences, /import ask the rail ──────────────────────
  const forms = (await import("../app/forms/page")).default;
  const sequences = (await import("../app/sequences/page")).default;
  const importPage = (await import("../app/import/page")).default;
  for (const [route, page] of [["/forms", forms], ["/sequences", sequences], ["/import", importPage]] as const) {
    await check(`${route}: an unprovisioned workspace and a signed-out visitor get a 404`, async () => {
      for (const who of ["newbie", null] as const) {
        await login(who);
        assert.equal(await outcome(() => page()), "404", `${who ?? "anonymous"} opened ${route}`);
      }
    });
  }
  await check("/import: a client owner opens it (it is the workspace's own lead import)", async () => {
    await login("client");
    assert.equal(await outcome(() => importPage()), "rendered");
  });
  for (const [route, page, sentence] of [
    ["/forms", forms, "Forms couldn't load. The error has been logged."],
    ["/sequences", sequences, "Drips couldn't load. The error has been logged."],
  ] as const) {
    await check(`${route}: a failed read says so plainly and logs the detail`, async () => {
      await login("client");
      const logged: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
      };
      let tree: unknown;
      try {
        tree = await page();
      } finally {
        console.error = originalError;
      }
      const text = walk(tree).strings.join("\n");
      assert.ok(text.includes(sentence), `${route} does not say "${sentence}"`);
      assert.doesNotMatch(text, /migration|apply_migration|supabase|no such table|SQLITE|operator machine/i, `${route} shows operator text`);
      // The table is absent in this fixture, so the read failed: the log has it.
      assert.ok(
        logged.some((l) => /no such table/i.test(l) && l.includes(CLIENT)),
        `${route} did not log the failed read with its tenant:\n${logged.join("\n")}`,
      );
    });
  }

  // ── 4. /training and /objections send an unlinked session to /login ─────
  const loginTargets: Array<[string, () => unknown]> = [
    ["/training", (await import("../app/training/page")).default],
    ["/training/roleplay", (await import("../app/training/roleplay/page")).default],
    ["/objections", (await import("../app/objections/page")).default],
    ["/objections/practice", (await import("../app/objections/practice/page")).default],
    ["/training/opening", () => import("../app/training/[section]/page").then((m) => m.default({ params: Promise.resolve({ section: "opening" }) }))],
    ["/training/opening/drill", () => import("../app/training/[section]/drill/page").then((m) => m.default({ params: Promise.resolve({ section: "opening" }) }))],
    ["/training/roleplay/gatekeeper", () => import("../app/training/roleplay/[scenario]/page").then((m) => m.default({ params: Promise.resolve({ scenario: "gatekeeper" }) }))],
  ];
  for (const [route, page] of loginTargets) {
    await check(`${route}: a session with no linked workspace goes to /login?next=${route}`, async () => {
      for (const who of ["unlinked", null] as const) {
        await login(who);
        assert.equal(await outcome(page), `redirect:/login?next=${encodeURIComponent(route)}`, who ?? "anonymous");
      }
    });
  }

  // ── 5. /team: no stray 0 ────────────────────────────────────────────────
  const teamPage = (await import("../app/team/page")).default;
  await check("/team: a member's name renders with no stray 0 from the is_owner / admin_access flags", async () => {
    await login("member");
    const tree = await teamPage();
    const text = walk(tree).strings.join("\n");
    assert.ok(text.includes("Riley") && text.includes("Alex Owner"), "both members listed");
    const stray = primitiveChildren(tree).filter((c) => c === 0 || c === "0");
    assert.deepEqual(stray, [], "an INTEGER flag rendered as text next to a name");
    assert.ok(text.includes("owner"), "the owner still carries the owner tag");
  });

  // ── 6. Settings: teammates by department, never by persona ─────────────
  const { AgentMarketplaceCard } = await import("../components/settings/AgentMarketplaceCard");
  const { AgentConfigEditor } = await import("../components/settings/AgentConfigEditor");
  const { ProfileEditor } = await import("../components/settings/ProfileEditor");
  const settingsAi = (await import("../app/settings/ai/page")).default;
  const settingsProfile = (await import("../app/settings/page")).default;
  const { SettingsContent } = await import("../components/settings/SettingsContent");
  /** A Settings page with its SettingsContent (an async server component) rendered in place. */
  const withContent = async (page: unknown) => {
    const el = walk(page).elements.find((e) => e.type === SettingsContent);
    assert.ok(el, "the page mounts SettingsContent");
    return [page, await SettingsContent(el.props as Parameters<typeof SettingsContent>[0])];
  };
  const propsOf = (tree: unknown, type: unknown) => {
    const el = walk(tree).elements.find((e) => e.type === type);
    return el ? (JSON.parse(JSON.stringify(el.props)) as Record<string, unknown>) : null;
  };
  const captured: Record<string, { marketplace: Record<string, unknown> | null; agentConfig: Record<string, unknown> | null; profileEditor: Record<string, unknown> | null; serverText: string }> = {};
  for (const who of ["client", "cc"] as const) {
    await check(`Settings > AI brain and Profile render for ${who} (props captured for the client render)`, async () => {
      await login(who);
      const ai = await withContent(await settingsAi());
      const prof = await withContent(await settingsProfile());
      captured[who] = {
        marketplace: propsOf(ai, AgentMarketplaceCard),
        agentConfig: propsOf(ai, AgentConfigEditor),
        profileEditor: propsOf(prof, ProfileEditor),
        serverText: visibleText(ai, new Set([AgentMarketplaceCard, AgentConfigEditor, ProfileEditor])).join("\n"),
      };
      assert.ok(captured[who].marketplace, "the workspace agents card is on the page");
      assert.ok(captured[who].agentConfig, "the provider override editor is on the page");
      assert.ok(captured[who].profileEditor, "the profile editor is on the page");
    });
  }

  // ── client components, rendered where React is whole ─────────────────────
  const html: Record<string, Record<string, string>> = {};
  for (const who of ["client", "cc"] as const) {
    await check(`client components render for ${who} (tests/client-route-gating.render.ts)`, () => {
      const nodeOptions = (process.env.NODE_OPTIONS || "")
        .split(/\s+/)
        .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
        .join(" ");
      const env = { ...process.env, NODE_OPTIONS: nodeOptions };
      if (!nodeOptions) delete env.NODE_OPTIONS;
      const c = captured[who];
      assert.ok(c, "no props were captured");
      const r = spawnSync(process.execPath, ["--import", "tsx", "tests/client-route-gating.render.ts"], {
        encoding: "utf8",
        env,
        input: JSON.stringify({ marketplace: c.marketplace, agentConfig: c.agentConfig, profileEditor: c.profileEditor }),
      });
      assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
      html[who] = JSON.parse(r.stdout) as Record<string, string>;
    });
  }

  await check("Settings > AI brain, client owner: no persona name, no 'empire', no 'C-suite'; teammates by department", () => {
    const c = captured.client;
    const pageText = [c.serverText, readable(html.client.marketplace), readable(html.client.agentConfig)].join("\n");
    assert.doesNotMatch(pageText, PERSONA_NAMES, `persona or OASIS-internal wording on a client's Settings > AI brain:\n${pageText.match(PERSONA_NAMES)?.[0]}`);
    assert.match(readable(html.client.marketplace), /Chief of Staff/, "the Chief of Staff teammate is named for its department");
    assert.match(readable(html.client.agentConfig), /Chief of Staff/, "the override rows use the department name too");
    assert.equal(c.marketplace?.offerAddOns, false, "a client is not offered OASIS's house agents");
    assert.doesNotMatch(readable(html.client.marketplace), /Available add-ons/);
  });
  await check("Profile's primary-agent picker, client owner: department names, no persona", () => {
    const text = readable(html.client.profileEditor);
    assert.doesNotMatch(text, PERSONA_NAMES, text.match(PERSONA_NAMES)?.[0]);
    assert.match(text, /Chief of Staff/);
  });
  await check("Settings > AI brain, OASIS owner: add-ons offered, still by department or job, never by persona", () => {
    const text = readable(html.cc.marketplace);
    assert.equal(captured.cc.marketplace?.offerAddOns, true);
    assert.doesNotMatch([captured.cc.serverText, text, readable(html.cc.agentConfig)].join("\n"), PERSONA_NAMES);
    assert.match(text, /Chief of Staff/);
  });

  await check("/forms and /sequences, client workspace: no SunBiz agent in the copy, no link to the retired Metrics", () => {
    const forms = html.client.formsList;
    assert.ok(forms.includes("Intake"), "the forms list rendered the row");
    const formsText = readable(forms);
    assert.doesNotMatch(formsText, /Solara|Helios|SunBiz|Sun Biz/i, "SunBiz agent copy on a client's /forms");
    assert.match(formsText, /Personalized links/);
    // The Manage tab's help text (a client component with a live fetch): read as source.
    const manage = readFileSync(join(ROOT, "components/sequences/SequencesListClient.tsx"), "utf8");
    assert.doesNotMatch(manage, /Bravo|Metrics tab/, "Drips > Manage names Bravo or sends people to the retired Metrics page");
  });

  // ── 7. Today, unlinked account ─────────────────────────────────────────
  const today = (await import("../app/page")).default;
  const { PageFrame } = await import("../components/os/PageFrame");
  await check("Today, account not linked: the support form and the verified inbox, not 'send CC'", async () => {
    await login("unlinked");
    const tree = await today();
    const text = deepText(tree, new Set([PageFrame].filter(Boolean) as unknown[])).join(" ") + " " + walk(tree).strings.join(" ");
    assert.match(text, /could not confirm your workspace/);
    assert.ok(text.includes(SUPPORT_FORM_PATH), "the support form link is missing");
    assert.ok(text.includes(CONTACT_EMAIL), "the verified inbox is missing");
    assert.doesNotMatch(text, /\bCC\b|\bhe can\b/, "the page names CC to someone who may be a client");
  });

  // ── 8. error boundaries and the AI notice ───────────────────────────────
  await check("the error boundaries: try again, then the code via the support form or the inbox; no hosting logs", () => {
    for (const id of ["error", "globalError"]) {
      const markup = html.client[id];
      const text = readable(markup);
      assert.match(text, /Something went wrong/);
      assert.match(text, /Try again/);
      assert.ok(markup.includes(`href="${SUPPORT_FORM_PATH}"`), `${id}: no support form link`);
      assert.ok(markup.includes(`href="mailto:${CONTACT_EMAIL}"`) && text.includes(CONTACT_EMAIL), `${id}: no inbox`);
      assert.match(text, /digest-4471/, `${id}: the error code is how we find the failure; it must stay`);
      assert.doesNotMatch(text, /vercel|function logs/i, `${id} still points at the hosting provider's logs`);
    }
    assert.doesNotMatch(readable(html.client.errorNoDigest), /Error code/, "no code is invented when there is none");
    for (const f of ["app/error.tsx", "app/global-error.tsx"]) {
      assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /vercel/i, `${f} mentions Vercel`);
    }
  });
  const { AiNotSetUpNotice, AI_SETTINGS_HREF } = await import("../app/pipeline/[id]/AiNotSetUpNotice");
  await check("AI not set up: an owner gets the Settings link, nobody gets a setting name", () => {
    const owner = ReactNS.createElement(AiNotSetUpNotice, { feature: "AI scoring", canConfigureAi: true });
    const member = ReactNS.createElement(AiNotSetUpNotice, { feature: "AI scoring", canConfigureAi: false });
    const ownerText = deepText(owner, new Set()).join(" ").replace(/\s+/g, " ");
    const memberText = deepText(member, new Set()).join(" ").replace(/\s+/g, " ");
    assert.equal(AI_SETTINGS_HREF, "/settings/ai");
    assert.match(ownerText, /AI scoring isn't set up for this workspace/);
    assert.ok(ownerText.includes(AI_SETTINGS_HREF), "an owner is linked to Settings > AI brain");
    assert.ok(!memberText.includes(AI_SETTINGS_HREF), "a non-owner is not sent to a page they cannot open");
    assert.match(memberText, /Ask your workspace owner/);
    for (const t of [ownerText, memberText]) assert.doesNotMatch(t, /API_KEY|BRAVO|vercel|env/i);
    for (const f of ["app/pipeline/[id]/ScoreLeadButton.tsx", "app/pipeline/[id]/NextActionButton.tsx"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.match(src, /<AiNotSetUpNotice /, `${f} does not use the shared notice`);
      assert.doesNotMatch(src, /BRAVO_ANTHROPIC_API_KEY|Vercel|Bravo/, `${f} still names a setting, the host or a persona`);
    }
  });

  // ── 9. Goal pace -> Settings > Team > Revenue goal ────────────────────────
  const { GoalPaceGlance, REVENUE_GOAL_SETTINGS_HREF } = await import("../components/os/today/GoalPaceGlance");
  const settingsTeam = (await import("../app/settings/team/page")).default;
  await check("Goal pace 'Set one in Settings' opens Settings > Team at the Revenue goal section", async () => {
    assert.equal(REVENUE_GOAL_SETTINGS_HREF, "/settings/team#revenue-goal");
    const glance = GoalPaceGlance({ view: { kind: "no_goal" } as never, detailHref: "#x" });
    const links = walk(glance).elements.filter((e) => typeof e.props.href === "string").map((e) => e.props.href);
    assert.ok(links.includes(REVENUE_GOAL_SETTINGS_HREF), `the link goes to ${links.join(", ")}`);
    await login("cc");
    const team = await withContent(await settingsTeam());
    const section = walk(team).elements.find((e) => e.props.id === "revenue-goal");
    assert.ok(section, "Settings > Team has no element with id revenue-goal for the fragment to open");
    assert.equal(section.props.title, "Revenue goal");
  });

  // ── the tenant summary card names no default vendor ─────────────────────
  await check("/t/<slug> summary: no 'Backed by supabase' default", () => {
    const src = readFileSync(join(ROOT, "app/t/[slug]/page.tsx"), "utf8");
    assert.doesNotMatch(src, /Backed by|"supabase"/);
  });

  if (failures > 0) {
    console.error(`client-route-gating: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("client-route-gating: ok");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
