/**
 * queries-fail-loud-callers.test.ts — the pages that render the lib/queries
 * reads say "Couldn't check" when a read fails, never an empty list, a zero or
 * "offline" (OASIS OS plan F1.5, 2026-09-29).
 *
 * tests/queries-fail-loud.test.ts proves each read THROWS. That alone would be
 * worthless if a page swallowed the throw back into [] / false / an empty Set
 * with safe(label, read, []) — which is exactly what /operations, /reasoning,
 * /runs, /analytics, /health, Settings › AI, Automations and Drips did. This
 * runs the REAL pages as CC (the verified OASIS operator) against a local
 * libSQL file twice: once with the read's table missing (the unknown state
 * must appear and the "nothing here" copy must not), once with the table
 * present (the page's normal state, so the check is not passing on a page
 * that always says "Couldn't check"). /operations' own inline reads (the four
 * health counts, the paired machines) are held to the same rule: an "All
 * clear" or "0 bridges online" under a "Couldn't check" card contradicts it.
 *
 * Client components cannot run under react-server; the walker records the
 * props a page hands them instead (IntegrationDot, ProviderAccountsCard,
 * AgentConfigEditor, LocalCliProvidersCard), and tests/queries-fail-loud.render.ts
 * draws those components with that null in a separate, full-React process.
 *
 * next/headers, next/navigation and next/link are the only stand-ins (the same
 * ones tests/admin-surfaces-operator-only.test.ts uses).
 *
 * Run: node --conditions=react-server --import tsx tests/queries-fail-loud-callers.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";
import { createClient, type Client } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "queries-fail-loud-callers-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "queries-fail-loud-callers-secret-long-enough-0001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FOUNDERS_TENANT_IDS;
process.env.ADMIN_EMAILS = "adon@oasisai.work";

// No page here may reach the network; a stray fetch fails loudly.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

// tsconfig sets jsx:"preserve": tsx compiles page JSX with the classic runtime.
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
  useRouter: () => {
    throw new Error("client hook called under react-server");
  },
  usePathname: () => {
    throw new Error("client hook called under react-server");
  },
  useSearchParams: () => {
    throw new Error("client hook called under react-server");
  },
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});

// Some client modules on /sequences create a React context at IMPORT time,
// which react-server's React does not export. An inert context lets the page
// module load; its Provider just renders its children for the walker.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS export object is the one tsx-compiled modules read
const reactCjs = require("react") as Record<string, unknown>;
if (typeof reactCjs.createContext !== "function") {
  reactCjs.createContext = (value: unknown) => ({
    _currentValue: value,
    Provider: ({ children }: { children?: unknown }) => children,
    Consumer: () => null,
  });
}
// Settings wraps each card in SafeBoundary, an error-boundary CLASS; the
// walker renders a class component's children (see walk()).
if (typeof reactCjs.Component !== "function") {
  class InertComponent {
    props: unknown;
    constructor(props: unknown) {
      this.props = props;
    }
  }
  (InertComponent.prototype as unknown as { isReactComponent: object }).isReactComponent = {};
  reactCjs.Component = InertComponent;
  reactCjs.PureComponent = InertComponent;
}

// The /analytics charts are recharts client components (class components,
// which react-server does not ship). A named stand-in keeps the page's own
// decisions — which of them it draws — visible to the walker.
for (const chart of ["GoalPaceChart", "PipelineFunnel"]) {
  stub(join(ROOT, "components", "charts", `${chart}.tsx`), {
    [chart]: (props: Record<string, unknown>) => ReactNS.createElement("figure", { "data-chart": chart, "aria-label": `${chart} ${JSON.stringify(props.stages ?? "")}` }),
  });
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CC = { id: "0f000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };

// ── A server-tree walker that awaits async components ─────────────────────
// A client component (hooks) throws under react-server; it is recorded with
// the props the page handed it, which is what these checks read.
type Recorded = { name: string; props: Record<string, unknown> };
const NOT_TEXT = new Set(["className", "id", "role", "style", "key", "href", "src"]);
const CLIENT_ONLY = /is not a function|client hook called|Invalid hook call|reading 'use/;
async function walk(node: unknown, out: string[], client: Recorded[], depth = 0): Promise<void> {
  if (depth > 120 || node === null || node === undefined || typeof node === "boolean") return;
  if (node instanceof Promise) return walk(await node, out, client, depth + 1);
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) await walk(n, out, client, depth + 1);
    return;
  }
  if (!isValidElement(node)) return;
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof node.type === "function" && (node.type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    // A class boundary (SafeBoundary): what it guards is its children.
    return walk(props.children, out, client, depth + 1);
  }
  if (typeof node.type === "function") {
    const fn = node.type as (p: unknown) => unknown;
    let rendered: unknown;
    try {
      rendered = await fn(props);
    } catch (err) {
      if (CLIENT_ONLY.test((err as Error).message)) {
        client.push({ name: fn.name, props });
        return;
      }
      throw err;
    }
    return walk(rendered, out, client, depth + 1);
  }
  // Fragments, host elements, forwardRef icons: read the children and the
  // text-bearing string props (title, placeholder, message ...).
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") await walk(v, out, client, depth + 1);
    else if (typeof v === "string" && !NOT_TEXT.has(k)) out.push(v);
    else if (isValidElement(v)) await walk(v, out, client, depth + 1);
  }
}
async function render(el: unknown): Promise<{ text: string; client: Recorded[] }> {
  const out: string[] = [];
  const client: Recorded[] = [];
  await walk(el, out, client);
  return { text: out.join(" ").replace(/\s+/g, " "), client };
}
const one = (client: Recorded[], name: string): Record<string, unknown> => {
  const hit = client.filter((c) => c.name === name);
  assert.equal(hit.length > 0, true, `${name} was not rendered (saw: ${[...new Set(client.map((c) => c.name))].join(", ")})`);
  return hit[0].props;
};

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

async function seedIdentity(db: Client) {
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, lifecycle TEXT);
  `);
  const stamp = "2026-09-01T00:00:00Z";
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner,
                onboarding_completed_at, agents_enabled, primary_agent, updated_at)
              VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, '["bravo"]', 'bravo', ?)`,
        args: [CC.id, CC.email, OASIS, stamp, stamp],
      },
    ],
    "write",
  );
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: CC.id, email: CC.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await seedIdentity(db);

  const RunsPage = (await import("../app/runs/page")).default;
  const ReasoningPage = (await import("../app/reasoning/page")).default;
  const OperationsPage = (await import("../app/operations/page")).default;
  const AnalyticsPage = (await import("../app/analytics/page")).default;
  const HealthPage = (await import("../app/health/page")).default;
  const SequencesPage = (await import("../app/sequences/page")).default;
  const { AutomationsContent } = await import("../components/automations/AutomationsContent");
  const { SettingsContent } = await import("../components/settings/SettingsContent");
  const IntegrationsPage = (await import("../app/integrations/page")).default;
  const shellStatus = await import("../app/api/shell/status/route");

  console.log("queries-fail-loud-callers:");

  // ── Phase 1: every read's table is missing ──────────────────────────────
  await check("/runs: a failed audit-log read says Couldn't check, not 'No agent mutations recorded yet'", async () => {
    const { text } = await render(await RunsPage());
    assert.match(text, /Couldn't check the agent actions/);
    assert.doesNotMatch(text, /No agent mutations recorded yet/);
  });
  await check("/reasoning: a failed decisions read says Couldn't check, not 'No decisions yet'", async () => {
    const { text } = await render(await ReasoningPage());
    assert.match(text, /Couldn't check the agents' decisions/);
    assert.doesNotMatch(text, /No decisions yet/);
  });
  await check("/operations: workers, activity tape and decisions each say Couldn't check", async () => {
    const { text } = await render(await OperationsPage({ searchParams: Promise.resolve({}) }));
    assert.match(text, /Couldn't check the agent heartbeats/);
    assert.match(text, /Couldn't check the activity tape/);
    assert.match(text, /Couldn't check the agents' decisions/);
    assert.doesNotMatch(text, /worker not running on any paired machine/);
    assert.doesNotMatch(text, /No events recorded yet/);
    assert.doesNotMatch(text, /No decisions yet/);
  });
  await check("/operations: failed health counts and pairings say Couldn't check, never All clear or 0 bridges online", async () => {
    const { text, client } = await render(await OperationsPage({ searchParams: Promise.resolve({}) }));
    assert.equal(one(client, "BridgeCliPanel").serverBridgeOnline, null, "the CLI panel is told the heartbeat is unknown, not stale");
    for (const tile of ["Errors today", "Failed automations", "Stalled outbound", "Cold leads"]) {
      assert.match(text, new RegExp(`${tile} Couldn't check`), `${tile}: an unread count is not a number`);
    }
    assert.doesNotMatch(text, /All clear/, "all clear needs every count read");
    assert.match(text, /Bridges: couldn't check/);
    assert.doesNotMatch(text, /\d+ bridge ?s? online/); // the walker spaces JSX text pieces
    assert.match(text, /Couldn't check the paired machines/);
    assert.doesNotMatch(text, /No machines paired yet/);
  });
  await check("/analytics: a failed pipeline read says Couldn't check, never 0 won / 0 lost", async () => {
    const { text } = await render(await AnalyticsPage());
    assert.match(text, /Won Couldn't check/);
    assert.match(text, /Lost Couldn't check/);
    assert.match(text, /Couldn't check the pipeline/);
    assert.doesNotMatch(text, /Won 0|Lost 0|0 won \/ 0 total|No source data yet/);
  });
  await check("/integrations: a failed heartbeat read is Couldn't check, not a wall of 'Not connected' cards", async () => {
    const { text, client } = await render(await IntegrationsPage());
    assert.match(text, /The integration heartbeats could not be read/);
    assert.equal(client.filter((c) => c.name === "IntegrationDot").length, 0, "no card may claim a state");
  });
  // The key read answers only for the AI provider slugs, so its failure makes
  // only those cards unknown. Stripe, Gmail and the rest never depended on it
  // and keep the `false` they had before the read could fail.
  const AI_SLUGS = new Set(["anthropic", "openai_codex", "google_ai", "openrouter"]);
  await check("/health and /integrations: a failed key read hands the AI provider cards hasCredentials: null, the rest false", async () => {
    await db.execute(
      `CREATE TABLE integrations_health (id TEXT PRIMARY KEY, profile_id TEXT, tenant_id TEXT, service TEXT, status TEXT,
         last_ping_at TEXT, last_error TEXT, metadata TEXT, updated_at TEXT)`,
    );
    for (const page of [HealthPage, IntegrationsPage]) {
      const { client } = await render(await page());
      const dots = client.filter((c) => c.name === "IntegrationDot");
      const service = (d: Recorded) => (d.props.health as { service: string }).service;
      const ai = dots.filter((d) => AI_SLUGS.has(service(d)));
      const other = dots.filter((d) => !AI_SLUGS.has(service(d)));
      assert.ok(ai.length > 0 && other.length > 0, `need AI and non-AI cards, saw: ${dots.map(service).join(", ")}`);
      for (const d of ai) assert.deepEqual(d.props.connection, { hasCredentials: null }, `${service(d)}: ${JSON.stringify(d.props.connection)}`);
      for (const d of other) assert.deepEqual(d.props.connection, { hasCredentials: false }, `${service(d)}: ${JSON.stringify(d.props.connection)}`);
    }
  });
  await check("/api/shell/status: an unreadable bridge answers bridgeOnline null, not false", async () => {
    const res = await shellStatus.GET();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).bridgeOnline, null);
  });
  // Two callers the walker cannot reach: the chat route only GATES tools on the
  // heartbeat (offline is the safe gate, but the failure must be logged), and
  // the CLI card only reaches its bridge branches after a browser probe.
  await check("/api/chat: a failed pairings read is logged, then gated as offline", () => {
    const src = readFileSync(join(ROOT, "app", "api", "chat", "route.ts"), "utf8");
    const at = src.indexOf("getBridgeToolCapabilities(tenantId).catch(");
    assert.ok(at > 0, "the chat route no longer reads the bridge through getBridgeToolCapabilities");
    const handler = src.slice(at, src.indexOf("});", at));
    assert.match(handler, /console\.error\(/, "the catch swallows the read failure silently");
    assert.match(handler, /online: false/, "the tool gate must still fail closed");
  });
  await check("LocalCliProvidersCard: an unread heartbeat is never 'Bridge offline'", () => {
    const src = readFileSync(join(ROOT, "components", "settings", "LocalCliProvidersCard.tsx"), "utf8");
    assert.match(src, /serverBridgeOnline: boolean \| null;/);
    assert.match(src, /state\.kind === "bridge_unreachable" && serverBridgeOnline === null && \(/);
    assert.match(src, /Couldn&apos;t check the bridge/);
    const offline = src.slice(src.indexOf('<div className="font-bold">Bridge offline</div>') - 700, src.indexOf('<div className="font-bold">Bridge offline</div>'));
    assert.match(offline, /serverBridgeOnline !== null && deriveDropdownState\(false, serverBridgeOnline\) === "offline"/);
  });
  await check("Sidebar keeps the rail's null: no `?? false` fallback, every parse tri-state", () => {
    const src = readFileSync(join(ROOT, "components", "Sidebar.tsx"), "utf8");
    assert.doesNotMatch(src, /bridgeOnline \?\? bridgeOnlineProp/, "`??` turns a fetched null back into the passed-in false");
    assert.doesNotMatch(src, /bridgeOnline: (d|cached)\.bridgeOnline === true/, "a boolean parse turns null into false");
    assert.equal(src.match(/bridgeOnline: knownOrNull\(/g)?.length, 3, "the fetch, the cache read and the cache write");
  });
  await check("Automations: an unreadable bridge says Couldn't check your computer, not 'Computer not connected yet'", async () => {
    const { text } = await render(await AutomationsContent({}));
    assert.match(text, /Couldn't check your computer/);
    assert.doesNotMatch(text, /Computer not connected yet/);
    assert.doesNotMatch(text, /Install bridge/, "no install offer on a heartbeat nobody could read");
  });
  await check("Drips: an unreadable bridge says Couldn't check your computer, not 'Computer not connected yet'", async () => {
    const { text } = await render(await SequencesPage());
    assert.match(text, /Couldn't check your computer/);
    assert.doesNotMatch(text, /Computer not connected yet/);
    assert.doesNotMatch(text, /Install bridge/, "no install offer on a heartbeat nobody could read");
  });
  await check("Settings › AI: the cards get null (unknown) keys and bridge, and the tag says couldn't check", async () => {
    const { text, client } = await render(await SettingsContent({ section: "ai" }));
    const accounts = one(client, "ProviderAccountsCard");
    assert.equal(accounts.connectedServices, null);
    assert.equal(accounts.bridgeOnline, null);
    assert.equal(one(client, "AgentConfigEditor").globallyConnectedServices, null);
    assert.equal(one(client, "AgentConfigEditor").bridgeOnline, null);
    assert.equal(one(client, "LocalCliProvidersCard").serverBridgeOnline, null);
    assert.match(text, /Tool access: couldn't check the bridge/);
    assert.doesNotMatch(text, /Tool access: cloud only/);
  });
  // Last in phase 1: it leaves both cron tables in place for phase 2.
  await check("/operations: Failed automations sums two counts, so either one unread keeps it Couldn't check", async () => {
    const tile = async () => (await render(await OperationsPage({ searchParams: Promise.resolve({}) }))).text;
    await db.execute("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, name TEXT, schedule TEXT, last_run_at TEXT, last_result TEXT)");
    assert.match(await tile(), /Failed automations Couldn't check/, "tenant_cron_jobs unread, cron_jobs readable");
    await db.execute("ALTER TABLE cron_jobs RENAME TO cron_jobs_parked");
    await db.execute(
      `CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, schedule TEXT, last_run_at TEXT,
         last_run_status TEXT, last_run_error TEXT)`,
    );
    assert.match(await tile(), /Failed automations Couldn't check/, "cron_jobs unread, tenant_cron_jobs readable");
    await db.execute("ALTER TABLE cron_jobs_parked RENAME TO cron_jobs");
  });

  // ── Phase 2: the tables exist; the normal states come back ───────────────
  const now = new Date().toISOString();
  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, label TEXT, user_id TEXT,
      machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT, tool_capabilities TEXT, created_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_decisions (id TEXT PRIMARY KEY, tenant_id TEXT, agent_name TEXT, tick_id TEXT,
      decision_type TEXT, target_description TEXT, reasoning TEXT, outcome_status TEXT, chosen_action TEXT,
      confidence REAL, created_at TEXT);
    CREATE TABLE agent_state_snapshot (agent_name TEXT PRIMARY KEY, tick_count INTEGER, last_tick_at TEXT,
      last_tick_id TEXT, health_status TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT, source_agent TEXT,
      correlation_id TEXT, severity TEXT, payload TEXT, published_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, provider TEXT,
      encrypted_api_key TEXT, enabled INTEGER, user_id TEXT);
    CREATE TABLE application_lender_threads (id TEXT PRIMARY KEY, tenant_id TEXT, application_id TEXT, lender_id TEXT,
      recipient_email TEXT, status TEXT, sent_at TEXT);
  `);
  await db.batch(
    [
      { sql: "INSERT INTO tenant_records VALUES ('l1', ?, 'lead', '{\"stage\":\"won\",\"source\":\"referral\"}', ?, ?)", args: [OASIS, now, now] },
      { sql: "INSERT INTO agent_model_config VALUES ('m1', ?, 'anthropic', 'enc', 1, NULL)", args: [OASIS] },
    ],
    "write",
  );

  await check("control: readable tables bring back the real empty and offline states", async () => {
    assert.match((await render(await RunsPage())).text, /No agent mutations recorded yet/);
    assert.match((await render(await ReasoningPage())).text, /No decisions yet/);
    const opsRender = await render(await OperationsPage({ searchParams: Promise.resolve({}) }));
    const ops = opsRender.text;
    assert.equal(one(opsRender.client, "BridgeCliPanel").serverBridgeOnline, false);
    assert.match(ops, /No events recorded yet/);
    assert.doesNotMatch(ops, /Couldn't check the (agent heartbeats|activity tape|agents' decisions|paired machines)/);
    for (const tile of ["Errors today", "Failed automations", "Stalled outbound", "Cold leads"]) {
      assert.match(ops, new RegExp(`${tile} 0 `), `${tile}: a readable empty count is a real 0`);
    }
    assert.match(ops, /All clear/);
    assert.match(ops, /0 bridge ?s online/); // the walker spaces JSX text pieces
    assert.match(ops, /No machines paired yet/);
    const analytics = (await render(await AnalyticsPage())).text;
    assert.match(analytics, /Won 1/);
    assert.doesNotMatch(analytics, /Couldn't check the pipeline/);
    assert.match((await render(await AutomationsContent({}))).text, /Computer not connected yet/);
    assert.match((await render(await SequencesPage())).text, /Computer not connected yet/);
    const health = await render(await HealthPage());
    const dots = health.client.filter((c) => c.name === "IntegrationDot");
    assert.ok(dots.every((d) => typeof (d.props.connection as { hasCredentials: unknown }).hasCredentials === "boolean"));
    const anthropicDot = dots.find((d) => (d.props.health as { service: string }).service === "anthropic");
    assert.deepEqual(anthropicDot?.props.connection, { hasCredentials: true }, "the key on file reads as on file");
    const settings = await render(await SettingsContent({ section: "ai" }));
    assert.equal(one(settings.client, "ProviderAccountsCard").bridgeOnline, false);
    assert.ok(one(settings.client, "ProviderAccountsCard").connectedServices instanceof Set);
    assert.match(settings.text, /Tool access: cloud only/);
    assert.equal((await (await shellStatus.GET()).json()).bridgeOnline, false);
  });

  // ── The client components draw the unknown they are handed ──────────────
  await check("client cards draw null as Couldn't check (tests/queries-fail-loud.render.ts)", () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/queries-fail-loud.render.ts"], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(r.status, 0, `render process failed:\n${r.stderr}\n${r.stdout}`);
    const html = JSON.parse(r.stdout) as Record<string, string>;
    const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

    const dot = plain(html.dotUnknown);
    assert.match(dot, /Couldn't check/);
    assert.doesNotMatch(dot, /Not connected/);
    assert.match(plain(html.dotKnownMissing), /Not connected/, "a KNOWN missing key still says Not connected");

    const accounts = plain(html.accountsUnknown);
    assert.match(accounts, /Couldn't check/);
    assert.match(accounts, /Cloud: couldn't check/);
    assert.match(accounts, /Local bridge: couldn't check/);
    assert.doesNotMatch(accounts, /Not connected|no provider connected|No provider wired yet|Local bridge: offline/);
    const accountsKnown = plain(html.accountsKnownEmpty);
    assert.match(accountsKnown, /Not connected/);
    assert.match(accountsKnown, /No provider wired yet/);
    // One read failed, the other answered: the warning needs BOTH known, so
    // neither half alone may bring it back.
    const keysUnknown = plain(html.accountsKeysUnknownBridgeOffline);
    assert.match(keysUnknown, /Cloud: couldn't check/);
    assert.match(keysUnknown, /Local bridge: offline/);
    assert.doesNotMatch(keysUnknown, /No provider wired yet/, "keys nobody could check are not 'no provider'");
    const bridgeUnknown = plain(html.accountsKeysEmptyBridgeUnknown);
    assert.match(bridgeUnknown, /Cloud: no provider connected/);
    assert.match(bridgeUnknown, /Local bridge: couldn't check/);
    assert.doesNotMatch(bridgeUnknown, /No provider wired yet/, "a bridge nobody could check is not 'no bridge'");

    // The same card across a refresh: the new prop wins, with this page's own
    // connect and disconnect laid over it.
    const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    const afterConnect = plain(html.accountsAfterConnect);
    assert.match(afterConnect, /Cloud: 1 provider connected/, "the connect shows before the refresh lands");
    // The only count a failed read leaves is this page's own connects: a floor,
    // so the header may not read as the workspace's total.
    assert.match(afterConnect, /Cloud: 1 provider connected, couldn't check the rest/, "an unread key store has no total");
    assert.equal(count(afterConnect, /Replace key/g), 1, "Anthropic reads Connected");
    assert.equal(count(afterConnect, /Couldn't check/g), 3, "the other three are still unknown, not 'Not connected'");
    assert.doesNotMatch(afterConnect, /Not connected/);
    const afterRefresh = plain(html.accountsAfterRefresh);
    assert.match(afterRefresh, /Cloud: 2 providers connected/, "the refreshed read's OpenRouter key counts");
    assert.doesNotMatch(afterRefresh, /couldn't check the rest/, "a read that answered is the total");
    assert.equal(count(afterRefresh, /Replace key/g), 2, "Anthropic and OpenRouter both read Connected");
    assert.equal(count(afterRefresh, /Not connected/g), 2, "OpenAI and Google are now KNOWN not connected");
    assert.doesNotMatch(afterRefresh, /Couldn't check/);
    for (const key of ["accountsAfterDisconnect", "accountsAfterDisconnectRefresh"]) {
      const after = plain(html[key]);
      assert.match(after, /Cloud: 1 provider connected/, `${key}: the disconnect shows at once and stays`);
      assert.equal(count(after, /Replace key/g), 1, `${key}: only OpenRouter reads Connected`);
    }

    const editor = plain(html.editorUnknown);
    assert.match(editor, /Couldn't check which AI accounts are connected/);
    assert.doesNotMatch(editor, /No global AI account connected yet/);
    assert.match(plain(html.editorKnownEmpty), /No global AI account connected yet/);

    const toolAccess = plain(html.toolAccessUnknown);
    assert.match(toolAccess, /Couldn't check\./);
    assert.doesNotMatch(toolAccess, /Offline\.|Install the bridge/);
    assert.match(plain(html.toolAccessOffline), /Offline\./);

    const railUnknown = plain(html.railUnknown);
    assert.match(railUnknown, /bridge couldn't check/);
    assert.doesNotMatch(railUnknown, /bridge offline/);
    assert.match(plain(html.railOffline), /bridge offline/);

    // /operations hands BridgeCliPanel null when bridge_pairings could not be
    // read. After its localhost probe fails, that is "Couldn't check", never
    // the red "no recent heartbeat is on file" a known-false heartbeat earns.
    const cliUnknown = plain(html.cliUnknown);
    assert.match(cliUnknown, /Couldn't check the local bridge/);
    assert.doesNotMatch(cliUnknown, /isn't reachable|no recent heartbeat/);
    assert.match(plain(html.cliOffline), /Local bridge isn't reachable/, "a KNOWN stale heartbeat is still the red state");
    assert.match(plain(html.cliOnline), /Bridge is online/);
  });

  if (failures > 0) {
    console.error(`queries-fail-loud-callers: ${failures} failed`);
    process.exit(1);
  }
  console.log("queries-fail-loud-callers: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
