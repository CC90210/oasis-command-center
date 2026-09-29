/**
 * os-landings.test.ts — the OASIS OS landings refuse BEFORE they read.
 *
 * WHY. Phase 1 opens six new doors (/money, /clients, /growth/ads, /admin,
 * /admin/agents, /feed) onto company money, the platform's internals and the
 * agent event tape. Each one's promise is "the data is never fetched for the
 * wrong viewer", not "it is never painted": a value fetched and then hidden
 * still ships in the RSC payload. So this runs the REAL pages against a local
 * libSQL file with real signed sessions and records every SQL statement:
 *
 *   /money        non-owners (incl. the marketing hire the founders portal
 *                 admits) get a 404 and ZERO fin_* statements; CC and Adon get
 *                 the page — the control that proves the gate, not a broken
 *                 fixture, is what stops everyone else. Its numbers never print
 *                 CA$0.00 for a source that has not reported.
 *   /team/finance and Money rows: not drawn for any non-owner persona.
 *   /admin, /admin/agents   404 for everyone but a platform operator, gate as
 *                 the first statement.
 *   /feed         scoped to the viewer's own workspace for EVERYONE — the
 *                 operator gets OASIS's rows, not the empire's; a client owner
 *                 gets theirs; a rep never triggers the read.
 * Plus the pure rules behind them (feed-model, clients-model, money-model).
 *
 * next/headers, next/navigation, next/link and next/server's `after` are the
 * only stand-ins (same approach as tests/admin-surfaces-operator-only.test.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/os-landings.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "os-landings-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "os-landings-test-secret-long-enough-000000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
delete process.env.STRIPE_SECRET_KEY;
process.env.ADMIN_EMAILS = ["adon@oasisai.work", "squatter@alias.test"].join(",");

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
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// `after` needs a live request scope; the Money page schedules its overdue
// sweep with it. Recorded, not run.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the real module is spread into the stub
const realServer = require("next/server") as Record<string, unknown>;
const afterCalls: Array<() => unknown> = [];
stub("next/server", { ...realServer, after: (fn: () => unknown) => void afterCalls.push(fn) });

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const SQUAT = "5a5a5a5a-0000-4000-8000-00000000005a";
process.env.FOUNDERS_TENANT_IDS = OASIS;

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // OASIS owner; default operator alias; finance owner
  adon: u(2, "adon@oasisai.work"), // OASIS admin; ADMIN_EMAILS alias; finance owner
  marketer: u(3, "marketer@oasisai.work"), // OASIS marketing: passes the founders portal gate, not Finances
  rep: u(4, "rep@oasisai.work"), // OASIS opener (sales)
  manager: u(5, "manager@oasisai.work"), // OASIS manager
  worker: u(6, "worker@oasisai.work"), // OASIS member: system surfaces, no company money
  client: u(7, "owner@client.test"), // owner of a client workspace
  squatter: u(8, "squatter@alias.test"), // alias email, owns only their own workspace
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
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function is404(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message)) return true;
    throw err;
  }
}

/** Every string and every React element in a returned (unrendered) page tree. */
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
  if (node instanceof Map || node instanceof Set) {
    for (const v of node.values()) walk(v, out, seen);
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
const text = (tree: unknown) => walk(tree).strings.join("\n");

/** First code line of a page's default export, comments skipped. */
function firstStatement(file: string): string | undefined {
  const src = readFileSync(join(ROOT, file), "utf8");
  const body = src.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)$/);
  assert.ok(body, `${file}: default export not found`);
  return body[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
}

const MINUTE = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function main() {
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT, source_agent TEXT,
      target_agent TEXT, severity TEXT, correlation_id TEXT, payload TEXT, published_at TEXT, created_at TEXT,
      status TEXT);
    CREATE TABLE agent_state_snapshot (agent_name TEXT PRIMARY KEY, tick_count INTEGER, last_tick_at TEXT,
      working_memory TEXT, health_status TEXT);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY, tenant_id TEXT, service TEXT, status TEXT,
      last_ping_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_at TEXT, updated_at TEXT);
  `);
  // The finances book and the delivery tables in their real, migrated shape.
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/180_founders_finances.turso.sql"), "utf8"));
  const delivery = readFileSync(join(ROOT, "database/turso/183_delivery_and_support.turso.sql"), "utf8");
  const deliveryTables = delivery.match(
    /CREATE TABLE IF NOT EXISTS (?:delivery_projects|delivery_tasks|delivery_updates|support_tickets|ticket_comments) \([\s\S]*?\n\);/g,
  );
  assert.equal(deliveryTables?.length, 5, "the five delivery tables are in migration 183");
  await raw.executeMultiple(deliveryTables!.join("\n"));

  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const clientManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "client-co", answers: {} }));

  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
            agents_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '["bravo"]', ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, stamp],
  });
  const event = (id: string, tenant: string | null, publisher: string, type: string, payload: object, ageMs = 5 * MINUTE) => ({
    sql: `INSERT INTO agent_events (id, event_type, publisher_agent, severity, correlation_id, payload, published_at, created_at, status)
          VALUES (?, ?, ?, 'info', ?, ?, ?, ?, 'delivered')`,
    args: [id, type, publisher, tenant, JSON.stringify(payload), iso(ageMs), iso(ageMs)],
  });
  const lead = (id: string, data: object) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES (?, ?, 'lead', ?, ?, ?)",
    args: [id, OASIS, JSON.stringify(data), stamp, iso(MINUTE)],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'squatter-co', 'Squatter Co')", args: [SQUAT] },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client', ?, 'client-co', ?, 1, 1, '2026-01-01', '2026-01-01')",
        args: [CLIENT, JSON.stringify(clientManifest)],
      },
      profile("cc", OASIS, "owner", 1),
      profile("adon", OASIS, "admin"),
      profile("marketer", OASIS, "marketing"),
      profile("rep", OASIS, "opener"),
      profile("manager", OASIS, "manager"),
      profile("worker", OASIS, "member"),
      profile("client", CLIENT, "owner", 1),
      profile("squatter", SQUAT, "owner", 1),
      // The tape. Markers let the test see exactly which rows reached a page.
      event("e-oasis-plain", OASIS, "manifest-data", "BRAVO_RECORD_CREATED", { note: "OASIS-MARKER-PLAIN" }),
      event("e-oasis-sent", OASIS, "bravo", "BRAVO_OUTBOUND_SENT", { channel: "email", to: "a@b.test", subject: "OASIS-MARKER-SHIPPED" }),
      event("e-oasis-money", OASIS, "atlas", "ATLAS_MRR_SNAPSHOT", { note: "OASIS-MARKER-FINANCE", net_mrr_usd: 72 }),
      event("e-oasis-old", OASIS, "bravo", "BRAVO_RECORD_CREATED", { note: "OASIS-MARKER-OLD" }, 30 * 24 * 60 * MINUTE),
      event("e-client", CLIENT, "bravo", "BRAVO_RECORD_CREATED", { note: "CLIENT-MARKER" }),
      event("e-unstamped", null, "bravo", "BRAVO_RECORD_CREATED", { note: "UNSTAMPED-MARKER" }),
      { sql: "INSERT INTO agent_state_snapshot (agent_name, tick_count, last_tick_at) VALUES ('bravo', 41, ?)", args: [iso(2 * MINUTE)] },
      // Pipeline: one paid client with a project and an open ticket, one lost deal.
      lead("lead-won", { stage: "in_build", company: "Harbour Dental", name: "Dr. Lee", email: "lee@harbour.test", last_contacted_at: iso(3 * 24 * 60 * MINUTE) }),
      lead("lead-lost", { stage: "lost", company: "Gone Co", email: "x@gone.test" }),
      {
        sql: `INSERT INTO delivery_projects (id, tenant_id, title, client_name, client_email, lead_id, stage)
              VALUES ('proj-1', ?, 'Harbour site', 'Harbour Dental', 'lee@harbour.test', 'lead-won', 'building')`,
        args: [OASIS],
      },
      {
        sql: `INSERT INTO support_tickets (id, tenant_id, ticket_seq, ticket_number, title, status, project_id, sla_target, client_match)
              VALUES ('t-1', ?, 1, 'T-0001', 'Form broken', 'open', 'proj-1', ?, 'manual')`,
        args: [OASIS, iso(-60 * MINUTE)],
      },
      {
        sql: `INSERT INTO support_tickets (id, tenant_id, ticket_seq, ticket_number, title, status, client_email, sla_target)
              VALUES ('t-2', ?, 2, 'T-0002', 'Who are you', 'open', 'stranger@nowhere.test', ?)`,
        args: [OASIS, iso(-60 * MINUTE)],
      },
    ],
    "write",
  );

  // ── SQL recorder: every statement the app sends to Turso ─────────────────
  const { getTursoClient } = await import("../lib/turso");
  const client = getTursoClient() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  let sqlLog: string[] = [];
  const sqlOf = (stmt: unknown): string => (typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? ""));
  for (const name of ["execute", "batch"] as const) {
    const original = (Object.getPrototypeOf(client) as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
    assert.equal(typeof original, "function", `libSQL client has a prototype ${name}`);
    client[name] = async function (this: unknown, ...a: unknown[]) {
      if (name === "batch" && Array.isArray(a[0])) for (const s of a[0]) sqlLog.push(sqlOf(s));
      else sqlLog.push(sqlOf(a[0]));
      return original.apply(this, a);
    };
  }
  async function recording<T>(fn: () => Promise<T>): Promise<{ result: T | Error; sql: string[] }> {
    sqlLog = [];
    let result: T | Error;
    try {
      result = await fn();
    } catch (e) {
      result = e as Error;
    }
    return { result, sql: sqlLog };
  }
  const touchesFin = (sql: string[]) => sql.filter((s) => /\bfin_[a-z_]+/i.test(s));
  const touchesEvents = (sql: string[]) => sql.filter((s) => /\bagent_events\b/i.test(s));

  const MoneyPage = (await import("../app/money/page")).default;
  const AdminPage = (await import("../app/admin/page")).default;
  const FleetPage = (await import("../app/admin/agents/page")).default;
  const FeedPage = (await import("../app/feed/page")).default;
  const ClientsPage = (await import("../app/clients/page")).default;
  const AdsPage = (await import("../app/growth/ads/page")).default;
  const { KpiTile } = await import("../components/os/KpiTile");
  const kpis = (tree: unknown) =>
    walk(tree).elements.filter((e) => e.type === KpiTile).map((e) => e.props as { label: string; value: unknown; status: string });

  console.log("os-landings:");

  // ── /money ─────────────────────────────────────────────────────────────
  for (const who of ["marketer", "rep", "manager", "worker", "client", "squatter", null] as const) {
    await check(`/money: ${who ?? "signed out"} gets a 404 and not one fin_* statement`, async () => {
      await login(who);
      const run = await recording(() => MoneyPage());
      assert.ok(run.result instanceof Error && /404/.test(run.result.message), `expected 404, got ${String(run.result)}`);
      assert.deepEqual(touchesFin(run.sql), [], "a fin_* read ran before the gate refused");
    });
  }
  await check("/money: CC gets the page, and the gate is what opened the books (control)", async () => {
    await login("cc");
    const run = await recording(() => MoneyPage());
    assert.ok(!(run.result instanceof Error), `CC must get the page: ${String(run.result)}`);
    assert.ok(touchesFin(run.sql).length > 0, "the owner's render reads fin_*, so the non-owners' zero is the gate's doing");
    // Fresh books, no Stripe: unknown, never CA$0.00.
    const tiles = kpis(run.result);
    const byLabel = new Map(tiles.map((t) => [t.label, t]));
    for (const label of ["Cash on hand", "Collected this month", "MRR", "In this month", "Out this month", "Net this month"]) {
      assert.equal(byLabel.get(label)?.status, "not_connected", `${label} must say Not connected on empty books`);
    }
    assert.equal(byLabel.get("Owed to you")?.status, "live", "invoices are native: no invoice is a real zero");
    assert.ok(afterCalls.length > 0, "the deferred overdue sweep is scheduled after the response");
  });
  await check("/money: Adon (the other owner) gets the page", async () => {
    await login("adon");
    assert.equal(await is404(() => MoneyPage()), false);
  });
  await check("/money: a recorded payment turns Collected live with its real figure", async () => {
    const { BUSINESS_ENTITY_ID } = await import("../lib/founders-finances/chart");
    const { torontoToday } = await import("../lib/founders-finances/fx");
    const today = torontoToday();
    await raw.execute({
      sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, livemode, customer_name, created_by)
            VALUES ('pay-1', ?, 'payment', 'manual', ?, ?, 150000, 'CAD', 1, 'Harbour Dental', 'test')`,
      args: [BUSINESS_ENTITY_ID, `${today}T15:00:00Z`, today],
    });
    await login("cc");
    const tiles = kpis(await MoneyPage());
    const collected = tiles.find((t) => t.label === "Collected this month");
    assert.equal(collected?.status, "live");
    assert.equal(collected?.value, "CA$1,500.00");
    assert.equal(tiles.find((t) => t.label === "MRR")?.status, "not_connected", "no subscription sync yet");
  });
  await check("/money: the finance gate is the page's first statement", () => {
    assert.equal(firstStatement("app/money/page.tsx"), "const viewer = await resolveFinanceViewer();");
  });
  await check("Money and Finance rows are drawn for owners only (the rail's answer the pages share)", async () => {
    const { mayOpenOsHref } = await import("../lib/os/nav");
    const { capabilitiesFor } = await import("../lib/role-surfaces");
    const { resolveOsModules } = await import("../lib/os/modules");
    const input = (persona: "founder" | "manager" | "sales" | "marketing" | "builder" | "worker" | "readonly" | "legacy", finances: boolean) => ({
      persona,
      capabilities: capabilitiesFor(persona, "oasis-ai-cc"),
      isOperator: false,
      tenantSlug: "oasis-ai-cc",
      isOasisTenant: true,
      modules: resolveOsModules({ tenantSlug: "oasis-ai-cc", provisioned: true }),
      provisioned: true,
      // Every flag set as wrongly as a caller could: the persona must still decide.
      founders: { content: true, finances },
    });
    for (const persona of ["manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"] as const) {
      assert.equal(mayOpenOsHref(input(persona, true), "/money"), false, `${persona}: /money`);
      assert.equal(mayOpenOsHref(input(persona, true), "/team/finance"), false, `${persona}: /team/finance`);
    }
    assert.equal(mayOpenOsHref(input("founder", true), "/money"), true, "an owner with the finance gate open");
    assert.equal(mayOpenOsHref(input("founder", false), "/money"), false, "an owner who is not a finance owner");
  });

  // ── /admin and /admin/agents ───────────────────────────────────────────
  for (const who of ["squatter", "rep", "marketer", "manager", "worker", "client", null] as const) {
    await check(`/admin + /admin/agents: ${who ?? "signed out"} gets a 404 and no fleet read`, async () => {
      await login(who);
      for (const [path, page] of [["/admin", AdminPage], ["/admin/agents", FleetPage]] as const) {
        const run = await recording(() => page());
        assert.ok(run.result instanceof Error && /404/.test(run.result.message), `${path}: expected 404, got ${String(run.result)}`);
        assert.deepEqual(run.sql.filter((s) => /agent_state_snapshot|integrations_health/i.test(s)), [], `${path} read the fleet`);
      }
    });
  }
  await check("/admin + /admin/agents: the operator gets both, with the live fleet", async () => {
    await login("cc");
    const hub = await AdminPage();
    const hubText = text(hub);
    for (const door of ["/operations", "/automations", "/health", "/agent", "/admin/agents", "/runs", "/inbox", "/system-health"]) {
      assert.ok(hubText.includes(door), `the hub links ${door}`);
    }
    const fleetTree = await FleetPage();
    const fleetProp = walk(fleetTree).elements.find((e) => e.props && "fleet" in e.props)?.props.fleet as
      | { agents: string[]; signalsKnown: boolean; signals: Map<string, { live: boolean; tickCount: number | null }> }
      | undefined;
    assert.ok(fleetProp, "the fleet reached the page");
    assert.equal(fleetProp.signalsKnown, true);
    assert.equal(fleetProp.signals.get("bravo")?.live, true, "bravo ticked 2 minutes ago");
    assert.equal(fleetProp.signals.get("bravo")?.tickCount, 41);
  });
  await check("/admin + /admin/agents: requireOperator() is the first statement", () => {
    assert.equal(firstStatement("app/admin/page.tsx"), "await requireOperator();");
    assert.equal(firstStatement("app/admin/agents/page.tsx"), "await requireOperator();");
  });

  // ── /feed ──────────────────────────────────────────────────────────────
  const feedFor = async (who: Who, tab?: string) => {
    await login(who);
    return recording(() => FeedPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
  };
  await check("/feed: the operator sees OASIS's rows only — never another workspace's or unstamped ones", async () => {
    const run = await feedFor("cc");
    assert.ok(!(run.result instanceof Error), String(run.result));
    const t = text(run.result);
    for (const m of ["OASIS-MARKER-PLAIN", "OASIS-MARKER-SHIPPED", "OASIS-MARKER-FINANCE"]) assert.ok(t.includes(m), `missing ${m}`);
    for (const m of ["CLIENT-MARKER", "UNSTAMPED-MARKER", "OASIS-MARKER-OLD"]) assert.ok(!t.includes(m), `leaked ${m}`);
    const reads = touchesEvents(run.sql);
    assert.equal(reads.length, 1, "one feed read");
    assert.match(reads[0], /correlation_id/i, "the operator's read is scoped by correlation_id too");
  });
  await check("/feed: a client workspace owner sees their own rows and none of OASIS's", async () => {
    const run = await feedFor("client");
    assert.ok(!(run.result instanceof Error), String(run.result));
    const t = text(run.result);
    assert.ok(t.includes("CLIENT-MARKER"));
    for (const m of ["OASIS-MARKER-PLAIN", "OASIS-MARKER-SHIPPED", "OASIS-MARKER-FINANCE", "UNSTAMPED-MARKER"]) assert.ok(!t.includes(m), `leaked ${m}`);
  });
  await check("/feed: an OASIS worker gets the tape minus Finance and money rows", async () => {
    const t = text((await feedFor("worker")).result);
    assert.ok(t.includes("OASIS-MARKER-PLAIN") && t.includes("OASIS-MARKER-SHIPPED"));
    assert.ok(!t.includes("OASIS-MARKER-FINANCE"), "company money reached a non-owner");
    assert.ok(!t.includes("CLIENT-MARKER"));
  });
  await check("/feed: a rep (Feed is not on their rail) gets a 404 and never triggers the event read", async () => {
    for (const tab of [undefined, "all", "shipped"]) {
      const run = await feedFor("rep", tab);
      assert.ok(run.result instanceof Error && /404/.test(run.result.message), `tab=${tab}: ${String(run.result)}`);
      assert.deepEqual(touchesEvents(run.sql), [], `tab=${tab}: agent_events was read for a rep`);
    }
  });
  await check("/feed: Shipped holds the send, not the record change", async () => {
    const run = await feedFor("cc", "shipped");
    const rows = walk(run.result).elements.find((e) => e.props && "rows" in e.props && "departmentLabels" in e.props)?.props.rows as
      | Array<{ id: string }>
      | undefined;
    assert.deepEqual(rows?.map((r) => r.id), ["e-oasis-sent"]);
  });
  await check("/feed: loadTenantFeed pins correlation_id and refuses an empty workspace", async () => {
    const { loadTenantFeed } = await import("../components/os/landings/feed-data");
    const calls: Array<[string, ...unknown[]]> = [];
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit"]) {
      chain[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return chain;
      };
    }
    (chain as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    const db = { from: (t: string) => (calls.push(["from", t]), chain) } as never;
    const empty = await loadTenantFeed({ tenantId: "  ", db });
    assert.equal(empty.ok, false);
    assert.equal(calls.length, 0, "no query for an empty workspace id");
    await loadTenantFeed({ tenantId: OASIS, db });
    assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "correlation_id" && c[2] === OASIS), JSON.stringify(calls));
  });
  await check("/feed: the page source has no operator branch and gates first", () => {
    const page = readFileSync(join(ROOT, "app/feed/page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const data = readFileSync(join(ROOT, "components/os/landings/feed-data.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of ["isOperatorEmail", "isPlatformOperator", "recentEvents", "/api/event-feed", "getServiceSupabase"]) {
      assert.ok(!page.includes(banned), `app/feed/page.tsx references ${banned}`);
    }
    assert.ok(!/isOperator/.test(data), "feed-data.ts must not branch on operator status");
    assert.equal(firstStatement("app/feed/page.tsx"), 'const viewer = await requireOsRoute("/feed");');
  });

  // ── /clients ───────────────────────────────────────────────────────────
  await check("/clients: CC sees the paid deal with its project and ticket; the lost deal is not a client", async () => {
    await login("cc");
    const tree = await ClientsPage();
    const rows = walk(tree).elements.find((e) => e.props && "rows" in e.props && "deliveryHidden" in e.props)?.props.rows as
      | Array<{ name: string; status: string; openTickets: number | null; activeProjects: number | null }>
      | undefined;
    assert.ok(rows, "the client table rendered");
    assert.deepEqual(
      rows.map((r) => [r.name, r.status, r.openTickets, r.activeProjects]),
      [["Harbour Dental", "In build", 1, 1]],
    );
    assert.ok(
      walk(tree).strings.join("").includes("1 open ticket is not linked to a client yet"),
      "the stranger's ticket is reported, not invented into a client",
    );
  });
  for (const who of ["rep", "manager"] as const) {
    await check(`/clients: a ${who} (not on their rail) gets a 404 before any read`, async () => {
      await login(who);
      const run = await recording(() => ClientsPage());
      assert.ok(run.result instanceof Error && /404/.test(run.result.message), String(run.result));
      assert.deepEqual(run.sql.filter((s) => /tenant_records|delivery_projects|support_tickets/i.test(s)), []);
    });
  }
  await check("/clients: an OASIS worker sees the client, with delivery counts as unknown (not 0) and unread", async () => {
    await login("worker");
    const run = await recording(() => ClientsPage());
    assert.ok(!(run.result instanceof Error), String(run.result));
    const rows = walk(run.result).elements.find((e) => e.props && "rows" in e.props && "deliveryHidden" in e.props)?.props.rows as
      | Array<{ name: string; openTickets: number | null; activeProjects: number | null }>
      | undefined;
    assert.deepEqual(rows?.map((r) => [r.name, r.openTickets, r.activeProjects]), [["Harbour Dental", null, null]]);
    assert.deepEqual(run.sql.filter((s) => /delivery_projects|support_tickets/i.test(s)), [], "delivery is founder-only inside OASIS");
  });
  await check("/clients: a client workspace never sees OASIS's delivery rows as its customers", async () => {
    await login("client");
    const run = await recording(() => ClientsPage());
    assert.ok(!(run.result instanceof Error), String(run.result));
    assert.ok(!text(run.result).includes("Harbour"));
    assert.deepEqual(run.sql.filter((s) => /tenant_records|delivery_projects|support_tickets/i.test(s)), []);
  });

  // ── /growth/ads ────────────────────────────────────────────────────────
  await check("/growth/ads: no number on the page; every tile says Not connected", async () => {
    await login("cc");
    const tree = await AdsPage();
    const tiles = kpis(tree);
    assert.equal(tiles.length, 4);
    for (const t of tiles) assert.ok(t.status === "not_connected" && t.value === null, `${t.label}: ${t.status}`);
    assert.ok(text(tree).includes("/founders/marketing/performance"), "founders get their organic performance link");
  });
  await check("/growth/ads: the marketer gets it without the founders link; a rep and a client do not get it", async () => {
    await login("marketer");
    assert.ok(!text(await AdsPage()).includes("Connect Meta Ads Manager"), "Connect is for owners/admins");
    await login("rep");
    assert.equal(await is404(() => AdsPage()), true, "not on a rep's rail");
    await login("client");
    assert.equal(await is404(() => AdsPage()), true, "no ads module outside OASIS yet");
  });

  // ── pure rules ─────────────────────────────────────────────────────────
  const fm = await import("../components/os/landings/feed-model");
  await check("feed-model: attribution, shipped, visibility", () => {
    assert.equal(fm.departmentForEvent({ publisher_agent: "dept:sales" }), "sales");
    assert.equal(fm.departmentForEvent({ publisher_agent: "dept:nope" }), null);
    assert.equal(fm.departmentForEvent({ publisher_agent: "Atlas" }), "finance");
    assert.equal(fm.departmentForEvent({ publisher_agent: "manifest-data" }), null);
    assert.equal(fm.isShipped({ event_type: "BRAVO_OUTBOUND_SENT", severity: "info" }), true);
    assert.equal(fm.isShipped({ event_type: "BRAVO_OUTBOUND_SENT", severity: "error" }), false, "a failed send did not ship");
    assert.equal(fm.isShipped({ event_type: "BRAVO_RECORD_CREATED", severity: null }), false);
    const row = (id: string, publisher: string, payload: object) => ({
      id, event_type: "X", publisher_agent: publisher, target_agent: null, severity: null, payload, published_at: null, created_at: null, status: null,
    });
    const rows = [row("a", "bravo", {}), row("b", "atlas", {}), row("c", "kixie", { amount_cad: 5 }), row("d", "x", '{"note":"n"}' as unknown as object)];
    const all = new Set(["chief_of_staff", "sales", "marketing", "client_success", "finance", "operations"] as const);
    assert.deepEqual(fm.visibleFeedRows(rows, { canSeeTape: false, canSeeCompanyFinancials: true, departments: all }), []);
    assert.deepEqual(fm.visibleFeedRows(rows, { canSeeTape: true, canSeeCompanyFinancials: true, departments: all }).map((r) => r.id), ["a", "b", "c", "d"]);
    assert.deepEqual(
      fm.visibleFeedRows(rows, { canSeeTape: true, canSeeCompanyFinancials: false, departments: new Set(["chief_of_staff", "sales"] as const) }).map((r) => r.id),
      ["a", "d"],
    );
    assert.equal(fm.parseFeedTab("shipped", false), "needs", "no tape, no other tabs");
    assert.equal(fm.parseFeedTab(undefined, true), "all");
    assert.equal(fm.parseFeedDepartment("finance", [{ key: "sales", slug: "sales" }]), null, "a department the viewer cannot open is not a filter");
  });

  const cm = await import("../components/os/landings/clients-model");
  await check("clients-model: unreadable counts are null (an em dash), never 0", () => {
    const leads = [{ id: "l1", data: { stage: "won", company: "Acme", email: "a@acme.test" } }];
    const hidden = cm.buildClientRows({ leads, projects: null, tickets: null });
    assert.deepEqual(hidden.rows.map((r) => [r.name, r.openTickets, r.activeProjects]), [["Acme", null, null]]);
    assert.equal(hidden.unlinkedTickets, null);
    const known = cm.buildClientRows({ leads, projects: [], tickets: [] });
    assert.deepEqual(known.rows.map((r) => [r.openTickets, r.activeProjects]), [[0, 0]], "readable and none is a real zero");
  });
  await check("clients-model: a project with no won deal is still a client; tickets attach by email", () => {
    const built = cm.buildClientRows({
      leads: [{ id: "l1", data: { stage: "qualified", company: "NotYet" } }],
      projects: [
        { id: "p1", title: "Site", lead_id: null, client_tenant_id: "t-9", client_tenant_name: "Nine Co", client_name: "Nina", client_email: "nina@nine.test", stage: "live", last_client_update_at: null },
      ],
      tickets: [{ id: "k1", project_id: null, client_tenant_id: null, client_email: "NINA@nine.test", created_at: "2026-09-20T00:00:00Z", last_public_reply_at: null }],
    });
    assert.deepEqual(built.rows.map((r) => [r.name, r.contact, r.status, r.openTickets, r.activeProjects]), [["Nine Co", "Nina", "Live", 1, 0]]);
    assert.equal(built.unlinkedTickets, 0);
  });

  const mm = await import("../components/os/landings/money-model");
  const { formatCents } = await import("../lib/founders-finances/money");
  await check("money-model: a failed read is 'Couldn't load' on every tile; a live zero stays a zero", () => {
    const failed = mm.moneyTiles(null, formatCents);
    for (const t of [...failed.headline, ...failed.month]) assert.equal(t.status, "error", t.label);
    const live = mm.moneyTiles(
      {
        ov: { cashTotal: 0, cashAccounts: [{ balanceCents: 0 }], month: { inCents: 0, outCents: 0, netCents: 0 }, openAr: {}, overdueAr: {}, overdueCount: 0, unreviewed: 0 },
        collected: { cad_cents: 0, usd_cents: 0, payments: 0, fx_missing_days: [] },
        mrr: { mrr_cents: 0, currency: "CAD", active_subscriptions: 0, as_of: "2026-09-27T00:00:00Z" },
        recent: [{}],
        stripePinned: true,
      },
      formatCents,
    );
    const mrr = live.headline.find((t) => t.id === "mrr");
    assert.deepEqual([mrr?.status, mrr?.value], ["live", "CA$0.00"], "a synced Stripe with no subscriptions is a real zero");
    assert.equal(live.headline.find((t) => t.id === "cash")?.status, "live", "books with a transaction are live");
  });

  if (failures > 0) {
    console.log(`os-landings: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("os-landings: OK — money, admin, feed, clients and ads gate before they read; unknown is never zero");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
