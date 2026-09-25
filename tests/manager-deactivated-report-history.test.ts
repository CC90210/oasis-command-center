/**
 * tests/manager-deactivated-report-history.test.ts — a manager keeps the
 * history of a report who was deactivated (2026-09-24).
 *
 * Run: node --conditions=react-server --import tsx tests/manager-deactivated-report-history.test.ts
 *
 * Deactivating a rep keeps assigned_to on their closed / won / in-delivery
 * leads forever (lib/team-activation-rules.ts "keep") and keeps their
 * commission ledger rows. getOasisSalesRepRoster defaults to ACTIVE members,
 * which is right for anything that picks a LIVE target and wrong for a READ
 * boundary. Three READ boundaries used the default and silently dropped a
 * former report's history from their manager:
 *
 *   /pipeline/[id]           opened the rep's won deal as "Lead not found"
 *   lib/lead-access.ts       the same denial on every lead-adjacent GET route
 *   /pipeline                the manager's board lost the rep's leads and name
 *   commissions API          the rep's rows left the manager's list and totals
 *
 * Every check below EXECUTES the real page / route / policy against a local
 * libSQL file, with a signed session, so it proves behaviour rather than
 * source shape. The live controls stay active-only and are asserted too: the
 * board's rep chips and the lead page's operate mode. The lead page's battle
 * card is a read, so it follows the history roster (read-only) like its API.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";
import { createClient } from "@libsql/client";

// ── Environment: set before any app module loads (they are imported below) ──
const dbFile = join(mkdtempSync(join(tmpdir(), "mgr-history-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "manager-history-session-secret-that-is-long-enough-01";

// tsconfig.json sets jsx:"preserve" for Next, so tsx compiles page JSX with the
// classic runtime, which expects a global React (tests/delivery-pages.test.ts).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

function stubModule(specifier: string, exports: Record<string, unknown>): void {
  const path = require.resolve(specifier);
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
stubModule("next/headers", {
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
// The real modules pull the client router context, which does not exist under
// the react-server condition. The pages only need the server helpers / anchor.
stubModule("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});
stubModule("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
});

// The pages import "use client" components (BattleCard, LeadPipelineView, ...)
// that call createContext at module scope, which the react-server build lacks.
// Next never runs those modules on the server either: it swaps each export for
// a client reference. Do the same, so the element tree keeps each component's
// props (what would be serialized to the browser) without executing it.
const CLIENT_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const clientReferenceCache = new Map<string, Record<string, unknown> | null>();
function clientReferences(source: string): Record<string, unknown> {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(source)) names.add("default");
  const exports: Record<string, unknown> = { __esModule: true };
  for (const name of names) {
    const reference = () => null;
    Object.defineProperty(reference, "name", { value: `ClientReference(${name})` });
    exports[name] = reference;
  }
  return exports;
}
type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as {
  _load: ModuleLoad;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = function loadWithClientReferences(this: unknown, request, parent, isMain) {
  let filename: string | null = null;
  try {
    filename = moduleInternals._resolveFilename(request, parent, isMain);
  } catch {
    // Let the real loader raise its own resolution error.
  }
  if (filename && !filename.includes("node_modules") && /\.[jt]sx?$/.test(filename)) {
    if (!clientReferenceCache.has(filename)) {
      const source = readFileSync(filename, "utf8");
      clientReferenceCache.set(filename, CLIENT_DIRECTIVE.test(source) ? clientReferences(source) : null);
    }
    const references = clientReferenceCache.get(filename);
    if (references) return references;
  }
  return originalLoad.call(this, request, parent, isMain);
} as ModuleLoad;

// ── Fixture ────────────────────────────────────────────────────────────────
const TENANT = "5a1e5000-0000-4000-8000-000000000001";
const USERS = {
  cc: { id: "5a1e5000-0000-4000-8000-0000000000c1", email: "conaugh@oasisai.work" },
  manager: { id: "5a1e5000-0000-4000-8000-0000000000a1", email: "manager@oasisai.work" },
  active: { id: "5a1e5000-0000-4000-8000-0000000000a2", email: "active-rep@oasisai.work" },
  gone: { id: "5a1e5000-0000-4000-8000-0000000000a3", email: "former-rep@oasisai.work" },
  other: { id: "5a1e5000-0000-4000-8000-0000000000a4", email: "other-team@oasisai.work" },
} as const;
const LEADS = {
  goneWon: "5a1e5000-0000-4000-8000-00000000d001",
  active: "5a1e5000-0000-4000-8000-00000000d002",
  founder: "5a1e5000-0000-4000-8000-00000000d003",
} as const;
const CYCLE = "revenue-2026-09-23";

async function setupDatabase() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, invited_by TEXT,
      joined_at TEXT, manager_user_id TEXT, updated_at TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, logo_url TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, correlation_id TEXT, event_type TEXT,
      payload TEXT, published_at TEXT, created_at TEXT);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT,
      metadata TEXT, created_at TEXT);
    CREATE TABLE call_appointments (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, sms_consent INTEGER);
    CREATE TABLE website_sales_commissions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      deal_id TEXT NOT NULL, rep_user_id TEXT NOT NULL, payment_reference TEXT NOT NULL,
      entry_type TEXT NOT NULL, party_role TEXT, basis_amount_cents INTEGER, rate_bps INTEGER,
      amount_cents INTEGER, collected_setup_amount REAL NOT NULL, rate REAL NOT NULL, amount REAL NOT NULL,
      status TEXT NOT NULL, approved_by TEXT, approved_at TEXT, paid_by TEXT, paid_at TEXT,
      payout_reference TEXT, voided_by TEXT, voided_at TEXT, void_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE website_deals (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      package_id TEXT, currency TEXT NOT NULL, setup_amount REAL, monthly_amount REAL,
      payment_provider TEXT, verified_payment_id TEXT, closed_at TEXT);
    CREATE TABLE website_sales_payment_receipts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      provider TEXT, provider_reference TEXT, status TEXT, amount_cents INTEGER, currency TEXT,
      verified_at TEXT);
  `);

  const at = "2026-09-01T00:00:00Z";
  const profile = (
    u: { id: string; email: string },
    role: string,
    name: string,
    extra: { owner?: number; managerId?: string | null; deactivatedAt?: string | null } = {},
  ) => [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [u.id, u.email] },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner,
              onboarding_completed_at, full_name, joined_at, updated_at, manager_user_id, deactivated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `p-${u.id}`, u.id, u.email, TENANT, role, extra.owner ?? 0,
        at, name, at, at, extra.managerId ?? null, extra.deactivatedAt ?? null,
      ],
    },
  ];
  const lead = (id: string, data: Record<string, unknown>) => ({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at)
          VALUES (?, ?, 'lead', ?, ?, ?)`,
    args: [id, TENANT, JSON.stringify(data), "2026-09-23T12:00:00Z", "2026-09-24T12:00:00Z"],
  });
  const onBoard = { sales_motion: "cold_outbound", pipeline_cycle: CYCLE };
  const commission = (id: string, repUserId: string, dealId: string, amountCents: number) => ({
    sql: `INSERT INTO website_sales_commissions (id, tenant_id, deal_id, rep_user_id, payment_reference,
            entry_type, party_role, basis_amount_cents, rate_bps, amount_cents, collected_setup_amount,
            rate, amount, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'accrual', 'closer', ?, 1000, ?, ?, 0.1, ?, 'accrued', ?, ?)`,
    args: [
      id, TENANT, dealId, repUserId, `ref-${id}`, amountCents * 10, amountCents,
      (amountCents * 10) / 100, amountCents / 100, "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z",
    ],
  });

  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis', 'OASIS AI')", args: [TENANT] },
      { sql: "INSERT INTO tenant_manifests (id, tenant_id, slug) VALUES ('m1', ?, 'oasis')", args: [TENANT] },
      ...profile(USERS.cc, "owner", "Conaugh McKenna", { owner: 1 }),
      ...profile(USERS.manager, "manager", "Morgan Manager"),
      ...profile(USERS.active, "opener", "Active Rep", { managerId: USERS.manager.id }),
      ...profile(USERS.gone, "closer", "Former Rep", {
        managerId: USERS.manager.id,
        deactivatedAt: "2026-09-24T00:00:00Z",
      }),
      ...profile(USERS.other, "closer", "Other Team Rep"),
      lead(LEADS.goneWon, { ...onBoard, name: "Gone Rep Won Deal Co", stage: "won",
        assigned_to: USERS.gone.id, webdev_source_business_id: "biz-gone" }),
      lead(LEADS.active, { ...onBoard, name: "Active Rep Deal Co", stage: "qualified",
        assigned_to: USERS.active.id, webdev_source_business_id: "biz-active" }),
      lead(LEADS.founder, { ...onBoard, name: "Founder Deal Co", stage: "qualified",
        assigned_to: USERS.cc.id }),
      {
        sql: `INSERT INTO website_deals (id, tenant_id, lead_id, package_id, currency, setup_amount, monthly_amount)
              VALUES ('deal-gone', ?, ?, 'starter', 'CAD', 4000, 0), ('deal-active', ?, ?, 'starter', 'CAD', 3000, 0),
                     ('deal-other', ?, ?, 'starter', 'CAD', 2000, 0)`,
        args: [TENANT, LEADS.goneWon, TENANT, LEADS.active, TENANT, LEADS.founder],
      },
      commission("c-gone", USERS.gone.id, "deal-gone", 40000),
      commission("c-active", USERS.active.id, "deal-active", 30000),
      commission("c-other", USERS.other.id, "deal-other", 20000),
    ],
    "write",
  );
}

async function login(user: { id: string; email: string }): Promise<void> {
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

/** Every element in a returned tree, WITHOUT rendering any component. */
function elementsOf(node: unknown, out: { type: unknown; props: Record<string, unknown> }[] = [], depth = 0) {
  if (depth > 80 || node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    out.push({ type: node.type, props });
    for (const value of Object.values(props)) elementsOf(value, out, depth + 1);
  }
  return out;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function main() {
  await setupDatabase();
  const { getOasisSalesRepRoster } = await import("../lib/team");
  const leadAccess = await import("../lib/lead-access");
  const leadPage = (await import("../app/pipeline/[id]/page")).default;
  const boardPage = (await import("../app/pipeline/page")).default;
  const commissions = await import("../app/api/website-sales/commissions/route");

  console.log("manager-deactivated-report-history:");

  await check("fixture: the default roster really drops the deactivated rep (so the checks below exercise it)", async () => {
    const ids = (await getOasisSalesRepRoster(TENANT)).map((m) => m.auth_user_id);
    assert.equal(ids.includes(USERS.gone.id), false);
    assert.equal(ids.includes(USERS.active.id), true);
  });

  // ── FINDING 5a: lib/lead-access.ts read policy ─────────────────────────────
  const managerSession = { tenantId: TENANT, teamRole: "manager", isAdmin: false, userId: USERS.manager.id };
  await check("lead-access: a manager's read policy covers a deactivated report", async () => {
    const policy = await leadAccess.resolveLeadReadPolicy(managerSession);
    assert.equal(policy.mode, "oasis");
    const ids = policy.mode === "oasis" ? policy.readableRepUserIds : [];
    assert.ok(ids.includes(USERS.gone.id), "the deactivated report must stay on the read boundary");
    assert.ok(ids.includes(USERS.active.id));
    assert.equal(ids.includes(USERS.cc.id), false, "a founder never joins a manager's roster");
  });
  await check("lead-access: the manager can open the deactivated report's won lead, not a founder's", async () => {
    const won = await leadAccess.getReadableLeadRecordForSession(managerSession, { tenantId: TENANT, id: LEADS.goneWon });
    assert.equal(won?.record.id, LEADS.goneWon);
    const founder = await leadAccess.getReadableLeadRecordForSession(managerSession, { tenantId: TENANT, id: LEADS.founder });
    assert.equal(founder, null);
  });

  // ── FINDING 5b: /pipeline/[id] ─────────────────────────────────────────────
  await login(USERS.manager);
  const openLead = async (id: string) => elementsOf(await leadPage({ params: Promise.resolve({ id }) }));
  const titleOf = (els: ReturnType<typeof elementsOf>) =>
    els.find((el) => typeof el.props.subtitle === "string" && typeof el.props.title === "string")?.props.title;
  await check("/pipeline/[id]: the manager opens a deactivated report's won deal (history), read-only", async () => {
    const els = await openLead(LEADS.goneWon);
    assert.equal(titleOf(els), "Gone Rep Won Deal Co", "must not render 'Lead not found'");
    const lifecycle = els.find((el) => "viewerMode" in el.props);
    assert.equal(lifecycle?.props.viewerMode, "coaching", "a retired rep's deal is coached, never operated");
    assert.equal(
      els.some((el) => el.props.title === "Website battle card"),
      true,
      "the battle card API resolves the history roster (lib/web-leads/viewer.ts), so the page must render the card",
    );
    const card = els.find((el) => "embedded" in el.props && el.props.leadId === LEADS.goneWon);
    assert.equal(card?.props.canMutate, false, "the former report's card renders read-only for the manager");
  });
  await check("/pipeline/[id]: an active report's lead still opens in operate mode with its battle card", async () => {
    const els = await openLead(LEADS.active);
    assert.equal(titleOf(els), "Active Rep Deal Co");
    assert.equal(els.find((el) => "viewerMode" in el.props)?.props.viewerMode, "operate");
    assert.equal(els.some((el) => el.props.title === "Website battle card"), true);
  });
  await check("/pipeline/[id]: a founder's lead stays closed to the manager", async () => {
    assert.equal(titleOf(await openLead(LEADS.founder)), "Lead not found");
  });

  // ── FINDING 6: the manager's board ─────────────────────────────────────────
  type BoardRow = { id: string; data: Record<string, unknown> };
  const board = async (rep?: string) => {
    const els = elementsOf(await boardPage({ searchParams: Promise.resolve(rep ? { rep } : {}) }));
    const view = els.find((el) => Array.isArray(el.props.rows) && el.props.variant === "oasis");
    assert.ok(view, "the board must render LeadPipelineView");
    const chips = els
      .map((el) => el.props.href)
      .filter((href): href is string => typeof href === "string" && href.includes("rep="));
    return { rows: view.props.rows as BoardRow[], chips };
  };
  await check("/pipeline (manager): the deactivated report's won lead stays on the board, named", async () => {
    const { rows } = await board();
    const ids = rows.map((row) => row.id);
    assert.ok(ids.includes(LEADS.goneWon), "the board scope must include the deactivated report");
    assert.ok(ids.includes(LEADS.active));
    assert.equal(ids.includes(LEADS.founder), false, "the scope is still the rep roster, not the tenant");
    const gone = rows.find((row) => row.id === LEADS.goneWon);
    assert.equal(gone?.data.assigned_to_name, "Former Rep", "old rows keep a deactivated rep's name");
  });
  await check("/pipeline (manager): rep chips offer only active people", async () => {
    const { chips } = await board();
    assert.ok(chips.some((href) => href.includes(`rep=${USERS.active.id}`)), "the active report gets a chip");
    assert.equal(chips.some((href) => href.includes(`rep=${USERS.gone.id}`)), false, "no chip for a deactivated rep");
  });
  await check("/pipeline (manager): ?rep=<deactivated report> still narrows to their history", async () => {
    const { rows } = await board(USERS.gone.id);
    assert.deepEqual(rows.map((row) => row.id), [LEADS.goneWon]);
  });

  await login(USERS.cc);
  await check("/pipeline (admin): unchanged — the row is named, the chip is withheld", async () => {
    const { rows, chips } = await board();
    assert.equal(rows.find((row) => row.id === LEADS.goneWon)?.data.assigned_to_name, "Former Rep");
    assert.equal(chips.some((href) => href.includes(`rep=${USERS.gone.id}`)), false);
    assert.ok(chips.some((href) => href.includes(`rep=${USERS.active.id}`)));
  });

  // ── FINDING 7: the manager's commission ledger ─────────────────────────────
  await login(USERS.manager);
  await check("commissions (manager): a deactivated report's rows stay in the list and the totals", async () => {
    const res = await commissions.GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      viewer: { ledgerScope: string };
      data: { repUserId: string }[];
      summary: { entryCount: number; byRep: Record<string, unknown> };
    };
    assert.equal(body.viewer.ledgerScope, "manager_team");
    const reps = new Set(body.data.map((row) => row.repUserId));
    assert.ok(reps.has(USERS.gone.id), "the deactivated report's commission row must stay listed");
    assert.ok(reps.has(USERS.active.id));
    assert.equal(reps.has(USERS.other.id), false, "another team's rep is outside the direct-report scope");
    assert.ok(USERS.gone.id in body.summary.byRep, "the deactivated report must stay in the totals");
    assert.equal(body.summary.entryCount, 2);
  });

  if (failures) {
    console.log(`manager-deactivated-report-history: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("manager-deactivated-report-history: all passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
