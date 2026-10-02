/**
 * tests/commissions-portal.test.ts - Commissions opens with its numbers on the
 * page (track commissions-instant, 2026-10-02: LOAD-01, LOAD-02, SALES-02,
 * SALES-03, SALES-04, SALES-06).
 *
 * Every visit used to show "Loading the live Turso commission ledger..." while
 * the browser fetched /api/website-sales/commissions after hydration, and that
 * request made up to ten database reads one after another. Pinned here, run
 * for real against a local libSQL file with signed sessions (next/headers,
 * next/navigation and next/link are the only stand-ins):
 *
 *   1. loadCommissionPortal() with data, for a founder, a manager and a closer:
 *      every round trip is delayed by DELAY ms and its start kept, so the
 *      SEQUENTIAL depth (what the person waits for) is measured apart from the
 *      total. Depth is at most 4 and pinned at the measured figure; the total
 *      pins "website_deals is read once". A persona with no commission
 *      surface is refused before any read, and an unexpected failure comes
 *      back as a code for the screen instead of a thrown page.
 *   2. First paint: the page renders the portal with its data (no fetch()
 *      during the render), the portal's server HTML (tests/commissions-portal
 *      .render.ts) shows the clients, packages and totals with no loading
 *      card, and no effect in the portal fetches on mount (parsed with the
 *      TypeScript compiler, since effects do not run in a server render).
 *   3. Every error code the route, the loader and the payout transition can
 *      send reads as a sentence with no underscore, and the portal draws the
 *      sentence, never the code.
 *   4. An empty ledger shows one explainer with the comp engine's own rates
 *      instead of four $0 cards.
 *   5. No "Turso" in any rendered string: the header, the portal in every
 *      state, the loading skeleton.
 *   6. The row never needs more width than a laptop has: every grid track can
 *      shrink, five columns start at 1440px, and the payout controls wrap
 *      under the row below that.
 *   7. The GET route is a thin wrapper: the same body as the loader.
 *
 * And, from the review of 2026-10-02:
 *   8. One read for the rows and the totals: a deal that closes in the middle
 *      of a load is on the list and in the totals, or in neither; a deal that
 *      closes between two ledger pages is never counted twice.
 *   9. A failed read answers at once (its sibling may never answer) and is
 *      logged at once; a read that never answers ends at the deadline.
 *  10. Past 200 deals and 500 entries (450 and 700): the right totals and
 *      list, at most 5 sequential round trips, at most 4 reads in flight.
 *  11. Isolation with real rows in other workspaces, including rows that
 *      point at another workspace's client, receipt, person and deal.
 *  12. The empty page keeps Refresh, and a first commission replaces the
 *      explainer with the list.
 *
 * Run: node --conditions=react-server --import tsx tests/commissions-portal.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { isValidElement, type ReactNode } from "react";
import { createClient } from "@libsql/client";
import ts from "typescript";

// -- Environment: set before any app module loads (they are imported below) --
const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "commissions-portal-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "commissions-portal-test-secret-long-enough-01";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "adon@oasisai.work";

// Every fetch is counted and refused: no part of the first paint may need one.
const fetches: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  fetches.push(String(input).slice(0, 120));
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
  usePathname: () => "/commissions",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNode),
});

// -- Fixture: OASIS's own workspace (as in tests/client-route-gating.test.ts) --
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // owner: every entry, payout controls
  manager: u(2, "manager@oasis-team.test"), // own entries + direct reports
  closer: u(3, "closer@oasis-team.test"), // reports to the manager
  other: u(4, "other@oasis-team.test"), // another team's closer
  newRep: u(5, "new-rep@oasis-team.test"), // has earned nothing yet
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

async function setupDatabase(): Promise<void> {
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
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_at TEXT, updated_at TEXT);
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
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, role: string, owner: 0 | 1, name: string, managerId: string | null = null) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, display_name, agents_enabled, updated_at, joined_at, manager_user_id)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '[]', ?, ?, ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, OASIS, role, owner, stamp, name, name, stamp, stamp, managerId],
  });
  const commission = (
    id: string,
    dealId: string,
    who: Who,
    role: string,
    rateBps: number,
    amountCents: number,
    status: string,
    extra: { approvedBy?: string; paidBy?: string; payoutReference?: string } = {},
  ) => ({
    sql: `INSERT INTO website_sales_commissions (id, tenant_id, deal_id, rep_user_id, payment_reference, entry_type,
            party_role, basis_amount_cents, rate_bps, amount_cents, collected_setup_amount, rate, amount, status,
            approved_by, approved_at, paid_by, paid_at, payout_reference, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'accrual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, OASIS, dealId, USERS[who].id, `ref-${id}`, role, amountCents * 4, rateBps, amountCents,
      (amountCents * 4) / 100, rateBps / 10_000, amountCents / 100, status,
      extra.approvedBy ?? null, extra.approvedBy ? "2026-09-25T15:00:00Z" : null,
      extra.paidBy ?? null, extra.paidBy ? "2026-09-30T15:00:00Z" : null, extra.payoutReference ?? null,
      "2026-09-20T15:00:00Z", "2026-09-20T15:00:00Z",
    ],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      profile("cc", "owner", 1, "Conaugh McKenna"),
      profile("manager", "manager", 0, "Morgan Manager"),
      profile("closer", "closer", 0, "Casey Closer", USERS.manager.id),
      profile("other", "closer", 0, "Olive Other"),
      profile("newRep", "closer", 0, "Nico New"),
      ...[
        ["lead-maple", { business_name: "Maple Dental", stage: "won" }],
        ["lead-harbour", { business_name: "Harbour Plumbing", stage: "won" }],
      ].map(([id, data]) => ({
        sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES (?, ?, 'lead', ?, ?, ?)`,
        args: [id as string, OASIS, JSON.stringify(data), stamp, stamp],
      })),
      {
        sql: `INSERT INTO website_deals (id, tenant_id, lead_id, package_id, currency, setup_amount, monthly_amount,
                payment_provider, verified_payment_id, closed_at)
              VALUES ('deal-maple', ?, 'lead-maple', 'starter', 'CAD', 500, 150, 'stripe', 'rc-maple', '2026-09-20T15:00:00Z'),
                     ('deal-harbour', ?, 'lead-harbour', 'growth', 'USD', 5000, 350, 'manual', 'rc-harbour', '2026-09-20T15:00:00Z')`,
        args: [OASIS, OASIS],
      },
      {
        sql: `INSERT INTO website_sales_payment_receipts (id, tenant_id, provider, provider_reference, status, amount_cents, currency, verified_at)
              VALUES ('rc-maple', ?, 'stripe', 'pi_maple_1', 'verified', 50000, 'CAD', '2026-09-20T14:00:00Z'),
                     ('rc-harbour', ?, 'manual', 'etransfer-harbour-1', 'verified', 500000, 'USD', '2026-09-20T14:00:00Z')`,
        args: [OASIS, OASIS],
      },
      commission("c-closer-maple", "deal-maple", "closer", "closer", 2_500, 12_500, "accrued"),
      commission("c-manager-maple", "deal-maple", "manager", "manager", 600, 3_000, "approved", { approvedBy: USERS.cc.id }),
      commission("c-other-harbour", "deal-harbour", "other", "closer", 2_500, 125_000, "paid", {
        approvedBy: USERS.cc.id,
        paidBy: USERS.cc.id,
        payoutReference: "eTransfer-2026-09-30-0042",
      }),
      commission("c-closer-harbour", "deal-harbour", "closer", "opener", 1_500, 75_000, "accrued"),
    ],
    "write",
  );
  raw.close();
}

// -- Other workspaces (isolation and size; review of 2026-10-02) -------------
// B holds data no other workspace may ever see. C and D are workspaces whose
// own rows point at B's records (a deal naming B's lead and receipt, an entry
// approved by B's person, an entry on B's deal). Ids are unique across
// workspaces, so a reference like that is the only way a query that lost its
// tenant filter could pull B's data onto another workspace's page.
const TENANT_B = "0b0b0b0b-0000-4000-8000-0000000000b0";
const TENANT_C = "0c0c0c0c-0000-4000-8000-0000000000c0";
const TENANT_D = "0d0d0d0d-0000-4000-8000-0000000000d0";
const TENANT_BIG = "0e0e0e0e-0000-4000-8000-0000000000e0";
const B_OWNER = "0b000000-0000-4000-8000-000000000001";
const B_REP = "0b000000-0000-4000-8000-000000000002";
const C_OWNER = "0c0c0000-0000-4000-8000-000000000001";
const D_OWNER = "0d0d0000-0000-4000-8000-000000000001";
const BIG_OWNER = "0e0e0000-0000-4000-8000-000000000001";
const BIG_REPS = ["0e0e0000-0000-4000-8000-000000000011", "0e0e0000-0000-4000-8000-000000000012", "0e0e0000-0000-4000-8000-000000000013"];
const BIG_DEALS = 450;
const BIG_ENTRIES = 700;
/** Text that exists only in workspace B's records. */
const B_MARKERS = [
  "Tenant B Bakery", "pi_tenantB_secret_ref", "Bianca Tenant-B", "bianca@tenant-b.test", "Boris Tenant-B",
  "boris@tenant-b.test", "c-tenantB-1", "c-tenantB-2", "payout-tenantB-ref", "777777",
];

async function setupOtherTenants(): Promise<void> {
  const raw = createClient({ url: `file:${dbFile}` });
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (tenant: string, userId: string, role: string, owner: 0 | 1, name: string, email: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, display_name, agents_enabled, updated_at, joined_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '[]', ?, ?)`,
    args: [`p-${userId}`, userId, email, tenant, role, owner, stamp, name, name, stamp, stamp],
  });
  const lead = (tenant: string, id: string, businessName: string) => ({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES (?, ?, 'lead', ?, ?, ?)`,
    args: [id, tenant, JSON.stringify({ business_name: businessName, stage: "won" }), stamp, stamp],
  });
  const deal = (tenant: string, id: string, leadId: string, currency: string, setup: number, receiptId: string) => ({
    sql: `INSERT INTO website_deals (id, tenant_id, lead_id, package_id, currency, setup_amount, monthly_amount,
            payment_provider, verified_payment_id, closed_at) VALUES (?, ?, ?, 'growth', ?, ?, 150, 'stripe', ?, ?)`,
    args: [id, tenant, leadId, currency, setup, receiptId, stamp],
  });
  const receipt = (tenant: string, id: string, reference: string, currency: string, cents: number) => ({
    sql: `INSERT INTO website_sales_payment_receipts (id, tenant_id, provider, provider_reference, status, amount_cents, currency, verified_at)
          VALUES (?, ?, 'stripe', ?, 'verified', ?, ?, ?)`,
    args: [id, tenant, reference, cents, currency, stamp],
  });
  const entry = (
    tenant: string, id: string, dealId: string, repId: string, status: string, cents: number, createdAt: string,
    extra: { approvedBy?: string; payoutReference?: string } = {},
  ) => ({
    sql: `INSERT INTO website_sales_commissions (id, tenant_id, deal_id, rep_user_id, payment_reference, entry_type,
            party_role, basis_amount_cents, rate_bps, amount_cents, collected_setup_amount, rate, amount, status,
            approved_by, approved_at, payout_reference, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'accrual', 'closer', ?, 2500, ?, ?, 0.25, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, tenant, dealId, repId, `ref-${id}`, cents * 4, cents, (cents * 4) / 100, cents / 100, status,
      extra.approvedBy ?? null, extra.approvedBy ? stamp : null, extra.payoutReference ?? null, createdAt, createdAt,
    ],
  });
  const statements = [
    // B: its own people, client, deal, receipt and entries.
    profile(TENANT_B, B_OWNER, "owner", 1, "Bianca Tenant-B", "bianca@tenant-b.test"),
    profile(TENANT_B, B_REP, "closer", 0, "Boris Tenant-B", "boris@tenant-b.test"),
    lead(TENANT_B, "lead-tenantB-1", "Tenant B Bakery"),
    deal(TENANT_B, "deal-tenantB-1", "lead-tenantB-1", "CAD", 7777.77, "rc-tenantB-1"),
    receipt(TENANT_B, "rc-tenantB-1", "pi_tenantB_secret_ref", "CAD", 777777),
    entry(TENANT_B, "c-tenantB-1", "deal-tenantB-1", B_REP, "accrued", 4242, "2026-09-21T15:00:00Z"),
    entry(TENANT_B, "c-tenantB-2", "deal-tenantB-1", B_OWNER, "paid", 4343, "2026-09-22T15:00:00Z", {
      approvedBy: B_OWNER,
      payoutReference: "payout-tenantB-ref",
    }),
    // C: its own deal names B's lead and B's receipt, and its entry was
    // "approved" by B's owner.
    profile(TENANT_C, C_OWNER, "owner", 1, "Cora Tenant-C", "cora@tenant-c.test"),
    deal(TENANT_C, "deal-tenantC-1", "lead-tenantB-1", "CAD", 500, "rc-tenantB-1"),
    entry(TENANT_C, "c-tenantC-1", "deal-tenantC-1", C_OWNER, "approved", 12500, "2026-09-23T15:00:00Z", { approvedBy: B_OWNER }),
    // D: an entry on B's deal.
    profile(TENANT_D, D_OWNER, "owner", 1, "Dana Tenant-D", "dana@tenant-d.test"),
    entry(TENANT_D, "c-tenantD-1", "deal-tenantB-1", D_OWNER, "accrued", 1000, "2026-09-24T15:00:00Z"),
    // BIG: more than 200 deals and more than 500 entries. Entry i is on deal
    // i % 450, by rep i % 3; statuses cycle accrued, approved, paid, voided.
    profile(TENANT_BIG, BIG_OWNER, "owner", 1, "Bea Big", "bea@big.test"),
    ...BIG_REPS.map((rep, i) => profile(TENANT_BIG, rep, "closer", 0, `Big Rep ${i + 1}`, `rep${i + 1}@big.test`)),
  ];
  for (let d = 0; d < BIG_DEALS; d += 1) {
    const n = String(d).padStart(3, "0");
    const currency = d % 2 === 0 ? "CAD" : "USD";
    statements.push(lead(TENANT_BIG, `lead-big-${n}`, `Big Client ${n}`));
    statements.push(deal(TENANT_BIG, `deal-big-${n}`, `lead-big-${n}`, currency, 1000 + d, `rc-big-${n}`));
    statements.push(receipt(TENANT_BIG, `rc-big-${n}`, `pi_big_${n}`, currency, (1000 + d) * 100));
  }
  const STATUSES = ["accrued", "approved", "paid", "voided"];
  for (let i = 0; i < BIG_ENTRIES; i += 1) {
    const status = STATUSES[i % 4];
    statements.push(entry(
      TENANT_BIG,
      `c-big-${String(i).padStart(3, "0")}`,
      `deal-big-${String(i % BIG_DEALS).padStart(3, "0")}`,
      BIG_REPS[i % 3],
      status,
      1000 + i,
      new Date(Date.UTC(2026, 6, 1) + i * 60_000).toISOString(),
      status === "approved" || status === "paid" ? { approvedBy: BIG_OWNER } : {},
    ));
  }
  for (let offset = 0; offset < statements.length; offset += 200) {
    await raw.batch(statements.slice(offset, offset + 200), "write");
  }
  raw.close();
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

/** What a person reads: tags dropped (a title attribute kept), entities decoded. */
const readable = (markup: string) =>
  markup
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*\btitle="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ");

/** A route code on screen: lower-case words joined by underscores. */
const CODE_ON_SCREEN = /\b[a-z]+(?:_[a-z]+)+\b/;

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 10).join("\n        ")}`);
  }
}

/** Injected per-trip latency. Local SQLite answers in a few ms, so trips that start within DELAY/2 of each other ran in parallel. */
const DELAY = 30;

async function main() {
  await setupDatabase();
  await setupOtherTenants();
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  const portal = await import("../lib/website-sales-commission-portal");
  const { SURFACE_CAPABILITIES, maySeeCommissionSurface } = await import("../lib/role-surfaces");
  const { errorSentence, GENERIC_ERROR_SENTENCE } = await import("../lib/ui/error-copy");
  const { formatCommissionAmounts } = await import("../lib/website-sales-commission-summary");
  const comp = await import("../lib/website-sales-comp");
  const { getTursoClient } = await import("../lib/turso");
  const CommissionsPage = (await import("../app/commissions/page")).default;
  const { CommissionPortal } = await import("../app/commissions/CommissionPortal");
  const { PageHeader } = await import("../components/Card");
  const route = await import("../app/api/website-sales/commissions/route");

  console.log("commissions-portal:");

  // -- the database seam --------------------------------------------------
  // As in tests/finances-roundtrips.test.ts: getTursoClient() is lib/perf's
  // instrumenting Proxy over the libSQL client every read here goes through
  // (getServiceSupabase's Turso adapter and the roster read share it). Each
  // statement can be slowed (DELAY, start kept), counted while in flight,
  // failed or stalled by its SQL, followed by a commit once (`after`), or
  // held with the ledger reads issued alongside it and replayed in an order
  // that puts a commit between them (`reorder`).
  const client = getTursoClient() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  let starts: number[] = [];
  let slow = false;
  let inFlight = 0;
  let maxInFlight = 0;
  /** Every statement the loader started, in order (its SQL), however it then fared. */
  const begun: string[] = [];
  let faults: { fail?: RegExp; stall?: RegExp; hold?: { match: RegExp; until: Promise<void> } } = {};
  let after: { match: RegExp; then: () => Promise<void> } | null = null;
  let reorder: { commit: () => Promise<void> } | null = null;
  const held: Array<{ sql: string; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const sqlOf = (statement: unknown) =>
    typeof statement === "string" ? statement : String((statement as { sql?: unknown } | null)?.sql ?? "");
  /** The ledger reads issued together: the one without row details (the totals') first, then the commit, then the rest. */
  async function releaseHeld() {
    const batch = held.splice(0);
    const commit = reorder?.commit;
    reorder = null;
    const ordered = [...batch].sort((x, y) => Number(/payment_reference/.test(x.sql)) - Number(/payment_reference/.test(y.sql)));
    for (const [index, entry] of ordered.entries()) {
      try {
        entry.resolve(await entry.run());
      } catch (error) {
        entry.reject(error);
      }
      if (index === 0 && commit) await commit();
    }
  }
  for (const name of ["execute", "batch"] as const) {
    const original = (Object.getPrototypeOf(client) as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
    assert.equal(typeof original, "function", `libSQL client has a prototype ${name}`);
    client[name] = async function (this: unknown, ...a: unknown[]) {
      const sql = name === "execute" ? sqlOf(a[0]) : "";
      begun.push(sql);
      const hold = faults.hold;
      if (hold && hold.match.test(sql)) await hold.until;
      if (reorder && /FROM "website_sales_commissions"/.test(sql)) {
        return new Promise((resolve, reject) => {
          held.push({ sql, run: () => original.apply(this, a), resolve, reject });
          if (held.length === 1) setImmediate(() => void releaseHeld());
        });
      }
      if (faults.stall?.test(sql)) return new Promise(() => undefined);
      if (faults.fail?.test(sql)) throw new Error("injected read failure");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (slow) {
          starts.push(Date.now());
          await new Promise((r) => setTimeout(r, DELAY));
        }
        const result = await original.apply(this, a);
        if (after && after.match.test(sql)) {
          const hook = after;
          after = null;
          await hook.then();
        }
        return result;
      } finally {
        inFlight -= 1;
      }
    };
  }
  /** `p`, or "timed out" once `ms` pass: a load that never answers must fail its check, not hang the run. */
  const within = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms))]);
  /** console.error lines written while `fn` runs (kept off the test output). */
  async function errorsDuring<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(" "));
    };
    try {
      return { value: await fn(), lines };
    } finally {
      console.error = original;
    }
  }
  const waves = (ts: number[]) => {
    let n = 0;
    let waveStart = -Infinity;
    for (const t of [...ts].sort((a, b) => a - b)) {
      if (t - waveStart > DELAY / 2) {
        n += 1;
        waveStart = t;
      }
    }
    return n;
  };
  async function measure<T>(fn: () => Promise<T>) {
    starts = [];
    slow = true;
    try {
      const value = await fn();
      return { value, trips: starts.length, depth: waves(starts) };
    } finally {
      slow = false;
    }
  }

  // -- 1. the loader: sequential depth with data ---------------------------
  const session = (who: Who, isAdmin: boolean) => ({
    userId: USERS[who].id,
    tenantId: OASIS,
    isAdmin,
    isTrueAdmin: isAdmin,
  });
  // Bounds are the measured AFTER figures: the ledger once, then deals beside
  // profiles, then leads beside receipts (a manager reads the roster first).
  // BEFORE (the route on main at 9dee58a7, measured once on this fixture, not
  // re-run): recent, outstanding, summary rows, summary deals, deals, leads,
  // receipts, profiles one after another = 8 sequential (9 for a manager),
  // with website_deals read twice. The page no longer makes that request at
  // all. Past 200 deals and 500 entries, see the BIG check below.
  const SCOPES = [
    { name: "founder (every entry)", session: session("cc", true), persona: "founder" as const, rows: 4, depth: 3, trips: 5 },
    { name: "manager (own + direct reports)", session: session("manager", false), persona: "manager" as const, rows: 3, depth: 4, trips: 6 },
    { name: "closer (own entries)", session: session("closer", false), persona: "sales" as const, rows: 2, depth: 3, trips: 5 },
  ];
  const table: Record<string, { trips: number; sequential: number }> = {};
  for (const s of SCOPES) {
    await check(`loader, ${s.name}: at most ${s.depth} sequential round trips (never more than 4), ${s.trips} in all, with data`, async () => {
      const m = await measure(() => portal.loadCommissionPortal(s.session, s.persona));
      table[s.name] = { trips: m.trips, sequential: m.depth };
      assert.equal(m.value.status, 200);
      assert.ok(m.value.body.ok, JSON.stringify(m.value.body));
      assert.equal(m.value.body.data.length, s.rows, "the scope's rows are all there");
      assert.ok(m.depth <= 4, `${s.name}: ${m.depth} sequential round trips > 4`);
      assert.ok(m.depth <= s.depth, `${s.name}: ${m.depth} sequential round trips > bound ${s.depth}`);
      assert.ok(m.trips <= s.trips, `${s.name}: ${m.trips} round trips > bound ${s.trips} (website_deals read twice?)`);
    });
  }
  console.table(table);

  await check("loader: the scopes still hold (manager = own + direct reports; closer = own)", async () => {
    const manager = await portal.loadCommissionPortal(session("manager", false), "manager");
    assert.ok(manager.body.ok);
    assert.equal(manager.body.viewer.ledgerScope, "manager_team");
    assert.deepEqual(
      new Set(manager.body.data.map((row) => row.repUserId)),
      new Set([USERS.manager.id, USERS.closer.id]),
      "another team's closer is outside the manager's scope",
    );
    const closer = await portal.loadCommissionPortal(session("closer", false), "sales");
    assert.ok(closer.body.ok);
    assert.equal(closer.body.viewer.ledgerScope, "self");
    assert.ok(closer.body.data.every((row) => row.repUserId === USERS.closer.id));
    assert.equal(closer.body.viewer.canManagePayouts, false);
    assert.equal(closer.body.summary.entryCount, 2, "the totals use the same boundary as the rows");
  });

  await check("loader: a persona with no commission surface is refused before any read", async () => {
    const refused = (Object.keys(SURFACE_CAPABILITIES) as Array<keyof typeof SURFACE_CAPABILITIES>)
      .filter((p) => !maySeeCommissionSurface(SURFACE_CAPABILITIES[p]));
    assert.ok(refused.length > 0, "at least one persona has no commission surface");
    for (const persona of refused) {
      const m = await measure(() => portal.loadCommissionPortal(session("newRep", false), persona));
      assert.deepEqual(m.value, { status: 403, body: { ok: false, error: "forbidden_commission_role" } }, persona);
      assert.equal(m.trips, 0, `${persona}: no database read before the gate`);
    }
  });

  await check("loader: an unexpected failure comes back as a plain code for the screen, never a thrown page", async () => {
    // A persona missing from the capability map throws inside the gate: the
    // kind of failure no single read's error handling expects.
    const outcome = await portal.loadCommissionPortal(session("cc", true), "no-such-persona" as never);
    assert.deepEqual(outcome, { status: 500, body: { ok: false, error: "commission_portal_unavailable" } });
    assert.equal(errorSentence("commission_portal_unavailable"), "We couldn't load commissions just now. Try again in a moment.");
  });

  // -- one read for the rows and the totals ----------------------------------
  type Totals = { currency: string; accruedCents: number; approvedCents: number; paidCents: number; offsetCents: number; netCents: number };
  /** The summary's totals rebuilt from rows, the way lib/website-sales-commission-summary.ts builds them. */
  const totalsOf = (rows: Array<{ status: string; amountCents: number; currency: string }>): Totals[] => {
    const buckets = new Map<string, Totals>();
    for (const row of rows) {
      const t = buckets.get(row.currency) ?? { currency: row.currency, accruedCents: 0, approvedCents: 0, paidCents: 0, offsetCents: 0, netCents: 0 };
      if (row.status !== "voided") {
        t[`${row.status}Cents` as "accruedCents"] += row.amountCents;
        t.netCents += row.amountCents;
      }
      buckets.set(row.currency, t);
    }
    return ["CAD", "USD"].flatMap((c) => (buckets.has(c) ? [buckets.get(c)!] : []));
  };
  await check("snapshot: a deal that closes while the ledger is read is on the list AND in the totals, or in neither", async () => {
    // The ledger reads issued together are held; the one without row details
    // (a totals-only read) runs first, then a deal closes, then the rest. Two
    // reads for the rows and the totals would show the new entry on the list
    // and leave it out of every total.
    reorder = {
      commit: () =>
        client.execute({
          sql: `INSERT INTO website_sales_commissions (id, tenant_id, deal_id, rep_user_id, payment_reference, entry_type, party_role,
                  basis_amount_cents, rate_bps, amount_cents, collected_setup_amount, rate, amount, status, created_at, updated_at)
                VALUES ('c-closed-mid-read', ?, 'deal-maple', ?, 'ref-mid-read', 'accrual', 'closer', 39600, 2500, 9900, 396, 0.25, 99, 'accrued', ?, ?)`,
          args: [OASIS, USERS.closer.id, "2026-09-26T15:00:00Z", "2026-09-26T15:00:00Z"],
        }).then(() => undefined),
    };
    try {
      const outcome = await portal.loadCommissionPortal(session("cc", true), "founder");
      assert.equal(reorder, null, "a ledger read was held and the deal closed in the middle");
      assert.ok(outcome.body.ok, JSON.stringify(outcome.body));
      const { data, summary, page } = outcome.body;
      assert.equal(page.hasMore, false, "every entry fits on the list, so the list must add up to the totals");
      assert.equal(summary.entryCount, data.length, `${data.length} rows on screen, ${summary.entryCount} counted`);
      assert.deepEqual(summary.totals, totalsOf(data), "the totals are the rows on screen, status for status and amount for amount");
      for (const rep of new Set(data.map((row) => row.repUserId))) {
        assert.deepEqual(summary.byRep[rep], totalsOf(data.filter((row) => row.repUserId === rep)), `rep ${rep}`);
      }
    } finally {
      reorder = null;
      await client.execute({ sql: "DELETE FROM website_sales_commissions WHERE id = 'c-closed-mid-read'", args: [] });
    }
  });

  // -- failures answer at once; nothing waits forever -------------------------
  await check("fail fast: a failed read answers at once and is logged at once, even while a sibling read never answers", async () => {
    faults = { fail: /FROM "tenant_records"/, stall: /FROM "website_sales_payment_receipts"/ };
    try {
      const t0 = Date.now();
      const { value, lines } = await errorsDuring(() =>
        within(portal.loadCommissionPortal(session("cc", true), "founder", { deadlineMs: 5_000 }), 3_000));
      const ms = Date.now() - t0;
      assert.deepEqual(value, { status: 500, body: { ok: false, error: "commission_leads_unavailable" } });
      assert.ok(ms < 1_500, `answered after ${ms} ms`);
      assert.ok(
        lines.some((line) => line.startsWith("[website-sales.commissions.leads]") && line.includes("injected read failure")),
        `the failure was logged with its tag: ${lines.join(" | ")}`,
      );
    } finally {
      faults = {};
    }
  });

  await check("deadline: a read that never answers ends as the plain sentence, not an endless loading screen", async () => {
    faults = { stall: /FROM "website_deals"/ };
    try {
      const t0 = Date.now();
      const { value, lines } = await errorsDuring(() =>
        within(portal.loadCommissionPortal(session("cc", true), "founder", { deadlineMs: 300 }), 3_000));
      const ms = Date.now() - t0;
      assert.deepEqual(value, { status: 500, body: { ok: false, error: "commission_portal_unavailable" } });
      assert.ok(ms < 2_000, `answered after ${ms} ms`);
      assert.ok(
        lines.some((line) => line.startsWith("[website-sales.commissions.portal]") && line.includes("Read did not answer in time")),
        `the timeout was logged: ${lines.join(" | ")}`,
      );
      assert.ok(portal.COMMISSION_PORTAL_DEADLINE_MS > 0 && portal.COMMISSION_PORTAL_DEADLINE_MS <= 12_000, "the default budget is Today's or less");
    } finally {
      faults = {};
    }
  });

  // -- past 200 deals and 500 entries -----------------------------------------
  // What the answer must be, from the database's own SQL (not the loader's code).
  const bigExpected = await (async () => {
    const sums = await client.execute({
      sql: `SELECT d.currency AS currency, c.status AS status, SUM(c.amount_cents) AS cents
            FROM website_sales_commissions c JOIN website_deals d ON d.id = c.deal_id AND d.tenant_id = c.tenant_id
            WHERE c.tenant_id = ? GROUP BY d.currency, c.status`,
      args: [TENANT_BIG],
    }) as { rows: Array<Record<string, unknown>> };
    const totals = ["CAD", "USD"].map((currency) => {
      const cents = (status: string) => Number(sums.rows.find((r) => r.currency === currency && r.status === status)?.cents ?? 0);
      return {
        currency,
        accruedCents: cents("accrued"),
        approvedCents: cents("approved"),
        paidCents: cents("paid"),
        offsetCents: cents("offset"),
        netCents: cents("accrued") + cents("approved") + cents("paid") + cents("offset"),
      };
    });
    const ids = async (sql: string) =>
      ((await client.execute({ sql, args: [TENANT_BIG] })) as { rows: Array<Record<string, unknown>> }).rows.map((r) => String(r.id));
    const recent = await ids("SELECT id FROM website_sales_commissions WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 500");
    const outstanding = await ids(
      "SELECT id FROM website_sales_commissions WHERE tenant_id = ? AND entry_type = 'accrual' AND status IN ('accrued', 'approved') ORDER BY id",
    );
    const seen = new Set(recent);
    return { totals, listedIds: [...recent, ...outstanding.filter((id) => !seen.has(id))] };
  })();
  const bigSession = { userId: BIG_OWNER, tenantId: TENANT_BIG, isAdmin: true, isTrueAdmin: true };
  await check(
    `past 200 deals and 500 entries (${BIG_DEALS} deals, ${BIG_ENTRIES} entries): right totals and list, at most 5 steps in a row, at most 4 reads at once`,
    async () => {
      maxInFlight = 0;
      const m = await measure(() => portal.loadCommissionPortal(bigSession, "founder"));
      const peak = maxInFlight;
      console.log(`        measured: ${m.trips} round trips, ${m.depth} sequential, ${peak} at most in flight`);
      assert.ok(m.value.body.ok, JSON.stringify(m.value.body).slice(0, 300));
      const { data, summary } = m.value.body;
      assert.equal(summary.entryCount, BIG_ENTRIES);
      assert.deepEqual(summary.totals, bigExpected.totals, "totals match the database's own sums");
      assert.deepEqual(data.map((row) => row.id), bigExpected.listedIds, "the newest 500 plus every older outstanding entry, in order");
      assert.ok(data.every((row) => row.clientName.startsWith("Big Client ") && row.paymentVerified), "every listed row has its client and receipt");
      assert.ok(m.depth <= 5, `${m.depth} sequential round trips > 5 (two ledger pages, deals beside profiles, then leads and receipts)`);
      assert.ok(m.trips <= 12, `${m.trips} round trips > 12`);
      assert.ok(peak <= 4, `${peak} reads in flight at once > 4`);
    },
  );

  await check("pages: a deal that closes between two pages of the ledger is counted once, never twice", async () => {
    // An id that sorts before every other moves each later row down one place,
    // so the last row of page one comes back as the first row of page two.
    after = {
      match: /FROM "website_sales_commissions"[\s\S]*OFFSET 0\b/,
      then: () =>
        client.execute({
          sql: `INSERT INTO website_sales_commissions (id, tenant_id, deal_id, rep_user_id, payment_reference, entry_type, party_role,
                  basis_amount_cents, rate_bps, amount_cents, collected_setup_amount, rate, amount, status, created_at, updated_at)
                VALUES ('c-big--first', ?, 'deal-big-000', ?, 'ref-big-first', 'accrual', 'closer', 4000, 2500, 1000, 40, 0.25, 10, 'accrued', ?, ?)`,
          args: [TENANT_BIG, BIG_REPS[0], "2026-06-30T00:00:00Z", "2026-06-30T00:00:00Z"],
        }).then(() => undefined),
    };
    try {
      const outcome = await portal.loadCommissionPortal(bigSession, "founder");
      assert.equal(after, null, "the deal closed between the pages");
      assert.ok(outcome.body.ok, JSON.stringify(outcome.body).slice(0, 300));
      assert.equal(outcome.body.summary.entryCount, BIG_ENTRIES, "each entry counted once");
      assert.deepEqual(outcome.body.summary.totals, bigExpected.totals, "no entry counted twice in a total");
      const ids = outcome.body.data.map((row) => row.id);
      assert.equal(new Set(ids).size, ids.length, "no entry listed twice");
    } finally {
      after = null;
      await client.execute({ sql: "DELETE FROM website_sales_commissions WHERE id = 'c-big--first'", args: [] });
    }
  });

  // -- a load that has answered starts nothing more ---------------------------
  // The deadline answers while a read is held; the held read is then let go.
  // Every statement the loader starts is recorded (`begun`), so anything it
  // still started after its answer is counted.
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const gate = () => {
    let open = () => undefined as void;
    const until = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { until, open };
  };
  /**
   * Load, then let the held reads go and wait: what the load answered, the
   * statements it still started after answering, and every log line from
   * start to end (a read dropped by the cancel must never be logged as a
   * failure).
   */
  const loadThenRelease = (deadlineMs: number, held: { open: () => void }) =>
    errorsDuring(async () => {
      const before = begun.length;
      const answer = await within(portal.loadCommissionPortal(bigSession, "founder", { deadlineMs }), deadlineMs + 5_000);
      const byAnswer = begun.length;
      faults = {};
      held.open();
      await settle(400);
      return { answer, beforeAnswer: begun.slice(before, byAnswer), afterAnswer: begun.slice(byAnswer) };
    });
  const DEADLINE_LINE = /^\[website-sales\.commissions\.portal\] ReadDeadlineError: Read did not answer in time/;

  await check("cancel: once the deadline has answered, a ledger page that answers late starts no next page and no later wave", async () => {
    // 700 entries are two ledger pages. Hold the first; the deadline answers;
    // then let it go.
    const held = gate();
    faults = { hold: { match: /FROM "website_sales_commissions"[\s\S]*OFFSET 0\b/, until: held.until } };
    try {
      const { value, lines } = await loadThenRelease(150, held);
      assert.deepEqual(value.answer, { status: 500, body: { ok: false, error: "commission_portal_unavailable" } });
      assert.deepEqual(value.afterAnswer, [], "a read started after the page already had its answer");
      assert.equal(lines.length, 1, `only the deadline is logged: ${lines.join(" | ")}`);
      assert.match(lines[0], DEADLINE_LINE);
    } finally {
      faults = {};
      held.open();
    }
  });

  await check("cancel: once the deadline has answered, chunk reads still waiting for a slot never start", async () => {
    // 450 deals: the last wave has 6 chunk reads (3 of clients, 3 of payments)
    // and 4 slots. Hold those reads: 4 start, 2 wait; then the deadline.
    const held = gate();
    const lastWave = /FROM "(tenant_records|website_sales_payment_receipts)"/;
    faults = { hold: { match: lastWave, until: held.until } };
    try {
      // Generous: the first two waves must be in before the deadline, even on a busy machine.
      const { value, lines } = await loadThenRelease(3_000, held);
      assert.deepEqual(value.answer, { status: 500, body: { ok: false, error: "commission_portal_unavailable" } });
      assert.equal(value.beforeAnswer.filter((sql) => lastWave.test(sql)).length, 4, "4 of the 6 last-wave reads had started");
      assert.deepEqual(value.afterAnswer, [], "a queued read started after the page already had its answer");
      assert.equal(lines.length, 1, `only the deadline is logged: ${lines.join(" | ")}`);
      assert.match(lines[0], DEADLINE_LINE);
    } finally {
      faults = {};
      held.open();
    }
  });

  await check("cancel: when a read fails, the reads still waiting for a slot never start", async () => {
    // The last wave again: the 3 client reads take 3 slots and fail at once;
    // 1 payments read takes the 4th slot and is held; 2 wait. The failure
    // fails the load, so those 2 must never start.
    const held = gate();
    faults = {
      fail: /FROM "tenant_records"/,
      hold: { match: /FROM "website_sales_payment_receipts"/, until: held.until },
    };
    try {
      const { value, lines } = await loadThenRelease(5_000, held);
      assert.deepEqual(value.answer, { status: 500, body: { ok: false, error: "commission_leads_unavailable" } });
      const payments = [...value.beforeAnswer, ...value.afterAnswer].filter((sql) => /FROM "website_sales_payment_receipts"/.test(sql));
      assert.equal(payments.length, 1, `only the payments read that had a slot started (${payments.length} did)`);
      assert.equal(lines.length, 1, `only the failed read is logged: ${lines.join(" | ")}`);
      assert.match(lines[0], /^\[website-sales\.commissions\.leads\] Error: commission_leads_failed:injected read failure/);
    } finally {
      faults = {};
      held.open();
    }
  });

  // -- isolation: another workspace's data never reaches this one --------------
  const leaks = (body: unknown, markers: string[]) => markers.filter((marker) => JSON.stringify(body).includes(marker));
  const A_TOTALS: Totals[] = [
    { currency: "CAD", accruedCents: 12_500, approvedCents: 3_000, paidCents: 0, offsetCents: 0, netCents: 15_500 },
    { currency: "USD", accruedCents: 75_000, approvedCents: 0, paidCents: 125_000, offsetCents: 0, netCents: 200_000 },
  ];
  await check("isolation: another workspace's ids, names, references and totals never reach a founder, manager or closer here", async () => {
    for (const [who, isAdmin, persona] of [["cc", true, "founder"], ["manager", false, "manager"], ["closer", false, "sales"]] as const) {
      const body = (await portal.loadCommissionPortal(session(who, isAdmin), persona)).body;
      assert.ok(body.ok, `${who}: ${JSON.stringify(body)}`);
      assert.deepEqual(leaks(body, B_MARKERS), [], `${who} sees workspace B's data`);
    }
    const founder = (await portal.loadCommissionPortal(session("cc", true), "founder")).body;
    assert.ok(founder.ok);
    assert.equal(founder.summary.entryCount, 4, "only this workspace's four entries are counted");
    assert.deepEqual(founder.summary.totals, A_TOTALS, "only this workspace's money is in the totals");
  });

  await check("isolation: rows that point at another workspace's client, receipt and person show none of them", async () => {
    const body = (await portal.loadCommissionPortal({ userId: C_OWNER, tenantId: TENANT_C, isAdmin: true, isTrueAdmin: true }, "founder")).body;
    assert.ok(body.ok, JSON.stringify(body));
    assert.deepEqual(body.data.map((row) => row.id), ["c-tenantC-1"]);
    assert.deepEqual(leaks(body, B_MARKERS), [], "workspace C sees workspace B's data");
  });

  await check("isolation: an entry on another workspace's deal fails closed, with none of that deal on the page", async () => {
    const { value: body } = await errorsDuring(async () =>
      (await portal.loadCommissionPortal({ userId: D_OWNER, tenantId: TENANT_D, isAdmin: true, isTrueAdmin: true }, "founder")).body);
    assert.deepEqual(body, { ok: false, error: "commission_summary_unavailable" });
    assert.deepEqual(leaks(body, [...B_MARKERS, "lead-tenantB-1"]), []);
  });

  await check("isolation: a closer sees only their own entries; a manager their own and their reports', never another team's", async () => {
    const closer = (await portal.loadCommissionPortal(session("closer", false), "sales")).body;
    assert.ok(closer.ok);
    assert.deepEqual(closer.data.map((row) => row.id).sort(), ["c-closer-harbour", "c-closer-maple"]);
    assert.equal(closer.summary.entryCount, 2);
    const manager = (await portal.loadCommissionPortal(session("manager", false), "manager")).body;
    assert.ok(manager.ok);
    assert.deepEqual(manager.data.map((row) => row.id).sort(), ["c-closer-harbour", "c-closer-maple", "c-manager-maple"]);
    assert.equal(manager.summary.entryCount, 3);
    assert.equal(JSON.stringify(manager).includes("c-other-harbour"), false, "another team's entry");
  });

  // -- 2. first paint -------------------------------------------------------
  type Payload = Awaited<ReturnType<typeof portal.loadCommissionPortal>>["body"];
  const firstPaint = async (who: Who) => {
    await login(who);
    const before = fetches.length;
    const els = elementsOf(await CommissionsPage());
    const portalEl = els.find((el) => el.type === CommissionPortal);
    const header = els.find((el) => el.type === PageHeader);
    return {
      initial: portalEl?.props.initial as Payload | undefined,
      header: header?.props as { title?: string; subtitle?: string } | undefined,
      fetches: fetches.slice(before),
    };
  };
  const founderPaint = await firstPaint("cc");
  const newRepPaint = await firstPaint("newRep");

  await check("first paint: the page hands the portal its data, with no fetch() while it renders", async () => {
    assert.deepEqual(founderPaint.fetches, [], "the page reached the network");
    const initial = founderPaint.initial;
    assert.ok(initial && initial.ok, `the portal's initial props: ${JSON.stringify(initial)}`);
    assert.equal(initial.data.length, 4);
    assert.equal(initial.summary.entryCount, 4);
    assert.equal(initial.viewer.canManagePayouts, true);
    assert.equal(founderPaint.header?.title, "Commissions");
  });

  // The client half runs in child processes, where React is whole.
  const plainEnv = () => {
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    return env;
  };
  const renderPortal = (cases: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/commissions-portal.render.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: plainEnv(),
      input: JSON.stringify({ cases }),
    });
    assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
    return JSON.parse(r.stdout) as { html: Record<string, string>; fetches: number };
  };
  const ERROR_CASES: Record<string, string> = {
    listingDown: "commission_listing_unavailable",
    roleRefused: "forbidden_commission_role",
    sessionEnded: "unauthorized",
  };
  let rendered: { html: Record<string, string>; fetches: number } = { html: {}, fetches: 0 };
  await check("the portal and the loading skeleton render (tests/commissions-portal.render.ts)", () => {
    rendered = renderPortal({
      founder: founderPaint.initial,
      empty: newRepPaint.initial,
      ...Object.fromEntries(Object.entries(ERROR_CASES).map(([id, error]) => [id, { ok: false, error }])),
    });
    for (const id of ["founder", "empty", "loading", ...Object.keys(ERROR_CASES)]) {
      assert.ok(rendered.html[id], `${id} rendered`);
    }
  });

  await check("first paint: the portal's HTML has the clients, packages and totals, and no loading card", async () => {
    const initial = founderPaint.initial;
    assert.ok(initial && initial.ok);
    const text = readable(rendered.html.founder);
    for (const expected of ["Maple Dental", "Harbour Plumbing", "Starter package", "Growth package", "Net total", "4 entries"]) {
      assert.ok(text.includes(expected), `first paint shows "${expected}"`);
    }
    assert.ok(
      text.includes(formatCommissionAmounts(initial.summary.totals, ["accrued", "approved", "paid", "offset"])),
      "the net total is on the first paint",
    );
    assert.ok(rendered.html.founder.includes('title="Maple Dental"'), "a truncated client name carries its full name as a title");
    assert.doesNotMatch(text, /loading|Deal deal-|ledger entr|Net ledger/i, "no loading card, no deal id, no ledger jargon");
    assert.equal(rendered.fetches, 0, "rendering the portal made no request");
  });

  await check("first paint: no effect in the portal fetches on mount; requests start only from Refresh or a payout change", async () => {
    const src = read("app/commissions/CommissionPortal.tsx");
    const sf = ts.createSourceFile("CommissionPortal.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const effects: string[] = [];
    const fetchCalls: ts.CallExpression[] = [];
    const loadCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (/^(React\.)?use(Layout|Insertion)?Effect$/.test(callee)) effects.push(node.arguments[0]?.getText(sf) ?? "");
        if (callee === "fetch") fetchCalls.push(node);
        if (callee === "load") loadCalls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const body of effects) {
      assert.doesNotMatch(body, /\b(load|mutate|fetch)\s*\(/, `an effect requests data on mount: ${body.slice(0, 120)}`);
    }
    /** The `const x = useCallback(...)` a node sits inside, or the JSX attribute it is the handler of. */
    const owner = (node: ts.Node): string => {
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        if (ts.isJsxAttribute(p)) return `jsx:${p.name.getText(sf)}`;
        if (
          ts.isVariableDeclaration(p) &&
          ts.isIdentifier(p.name) &&
          p.initializer &&
          ts.isCallExpression(p.initializer) &&
          p.initializer.expression.getText(sf) === "useCallback"
        ) {
          return `const:${p.name.text}`;
        }
      }
      return "render";
    };
    assert.ok(fetchCalls.length >= 2, "the GET and the PATCH were found");
    for (const call of fetchCalls) {
      assert.ok(["const:load", "const:mutate"].includes(owner(call)), `fetch() outside load/mutate: ${owner(call)}`);
    }
    assert.ok(loadCalls.length > 0);
    for (const call of loadCalls) {
      assert.ok(
        ["jsx:onClick", "jsx:onRefresh", "const:mutate"].includes(owner(call)),
        `load() runs from ${owner(call)}, not a click (Refresh, on the list or the explainer) or a payout change`,
      );
    }
    assert.match(src, /<NoCommissionYet onRefresh=\{\(\) => void load\(\)\}/, "the explainer's Refresh asks the route again");
  });

  await check("last read wins: a Refresh from before a payout that answers last cannot undo it; payout buttons wait while a read is in flight", async () => {
    const base = founderPaint.initial;
    assert.ok(base && base.ok);
    const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
    const paidRowId = "c-manager-maple";
    // A second approved entry, so "Mark as paid" is on screen during the race.
    const initial = copy(base);
    for (const row of initial.data) if (row.id === "c-closer-harbour") row.status = "approved";
    assert.equal(initial.data.find((row) => row.id === paidRowId)?.status, "approved", "the entry starts approved");
    const afterPayout = copy(initial);
    const paid = afterPayout.data.find((row) => row.id === paidRowId)!;
    paid.status = "paid";
    paid.paidAt = "2026-10-02T16:00:00Z";
    paid.payoutReference = "eTransfer-2026-10-02-0001";
    const cad = afterPayout.summary.totals.find((totals) => totals.currency === "CAD")!;
    cad.approvedCents -= paid.amountCents;
    cad.paidCents += paid.amountCents;

    type Step = { label: string; paidRowStatus: string | null; refreshDisabled: boolean; payoutControls: Array<{ text: string; disabled: boolean }>; screen: string };
    const race = (order: "newer-first" | "older-first" | "form-open") => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "tests/commissions-portal.client.ts"], {
        cwd: ROOT,
        encoding: "utf8",
        env: plainEnv(),
        input: JSON.stringify({ initial, afterPayout, paidRowId, order, voidRowId: "c-closer-maple", otherApprovedRowId: "c-closer-harbour" }),
      });
      assert.equal(r.status, 0, `the interaction helper exited ${r.status}:\n${r.stderr}`);
      const out = JSON.parse(r.stdout) as { methods: string[]; steps: Step[] };
      assert.deepEqual(
        out.methods,
        order === "form-open" ? ["GET", "GET"] : ["PATCH", "GET", "GET"],
        order === "form-open" ? "two Refreshes" : "the save, the Refresh, then the save's own re-read",
      );
      return (label: string): Step => {
        const found = out.steps.find((s) => s.label === label);
        assert.ok(found, `${order}: no step "${label}"`);
        return found;
      };
    };
    const busy = (s: Step, label: string) => {
      assert.ok(s.payoutControls.length >= 3, `${label}: payout buttons on screen`);
      assert.deepEqual(s.payoutControls.filter((control) => !control.disabled), [], `${label}: a payout button is usable while a read is in flight`);
    };

    // The review's race: the Refresh from before the payout answers LAST.
    const newer = race("newer-first");
    assert.equal(newer("opened").paidRowStatus, "approved");
    assert.ok(newer("opened").payoutControls.some((control) => !control.disabled), "with no read in flight the payout buttons work");
    busy(newer("refresh in flight"), "refresh in flight");
    busy(newer("payout saved, its re-read in flight"), "payout saved, its re-read in flight");
    const saved = newer("re-read after the payout answered");
    assert.equal(saved.paidRowStatus, "paid");
    const last = newer("older refresh answered last");
    assert.equal(last.paidRowStatus, "paid", "the older Refresh put the paid entry back");
    assert.equal(last.screen, saved.screen, "the older Refresh changed what is on screen");
    assert.equal(last.refreshDisabled, false, "the screen is not left waiting");

    // The other order: the older Refresh answers first. It is not drawn, and
    // it cannot end the busy state while the newer read is still out.
    const older = race("older-first");
    const first = older("older refresh answered first");
    busy(first, "older refresh answered first, newer still out");
    assert.equal(first.refreshDisabled, true, "still reading");
    const done = older("re-read after the payout answered");
    assert.equal(done.paidRowStatus, "paid");
    assert.ok(done.payoutControls.some((control) => !control.disabled), "the buttons work again once the latest read is in");

    // A form already open when a Refresh starts: its Confirm waits for the read.
    const forms = race("form-open");
    const confirm = (s: Step, name: string) => {
      const found = s.payoutControls.find((control) => control.text === name);
      assert.ok(found, `${s.label}: "${name}" on screen`);
      return found;
    };
    assert.equal(confirm(forms("refresh in flight with a void form open"), "Confirm void").disabled, true, "Confirm void during a read");
    assert.equal(confirm(forms("refresh answered with a void form open"), "Confirm void").disabled, false, "Confirm void after the read");
    assert.equal(confirm(forms("refresh in flight with a paid form open"), "Confirm paid").disabled, true, "Confirm paid during a read");
    assert.equal(confirm(forms("refresh answered with a paid form open"), "Confirm paid").disabled, false, "Confirm paid after the read");
  });

  // -- 3. error sentences --------------------------------------------------
  await check("every error code the route, the loader and the payout transition send reads as a sentence with no underscore", async () => {
    const routeSrc = read("app/api/website-sales/commissions/route.ts");
    const loaderSrc = read("lib/website-sales-commission-portal.ts");
    const portalSrc = read("app/commissions/CommissionPortal.tsx");
    const shim = read("lib/turso-rpc-shim.ts");
    const start = shim.indexOf("export async function transition_commission_entry(");
    assert.ok(start > 0, "found the payout transition");
    const transition = shim.slice(start, shim.indexOf("\nexport ", start + 10));
    const union = loaderSrc.slice(loaderSrc.indexOf("export type CommissionPortalErrorCode ="), loaderSrc.indexOf(";", loaderSrc.indexOf("export type CommissionPortalErrorCode =")));
    const codes = new Set<string>();
    for (const src of [routeSrc, loaderSrc, transition]) for (const m of src.matchAll(/\berror: "([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of union.matchAll(/"([a-z_]+)"/g)) codes.add(m[1]);
    for (const src of [routeSrc, portalSrc]) for (const m of src.matchAll(/\|\| "([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of portalSrc.matchAll(/setError\("([a-z_]+)"\)/g)) codes.add(m[1]);
    for (const m of portalSrc.matchAll(/portalStateAfter\([^)]*?"([a-z_]+)"\)/g)) codes.add(m[1]);
    for (const m of transition.matchAll(/transition_commission_entry: ([a-z_]+)/g)) codes.add(m[1]);
    for (const known of [
      "unauthorized", "forbidden_commission_role", "commission_scope_unavailable", "commission_listing_unavailable",
      "commission_profiles_unavailable", "founder_only", "status_conflict", "self_approval_forbidden",
      "payout_reference_required", "commission_refresh_unavailable", "commission_update_failed",
    ]) {
      assert.ok(codes.has(known), `the code sweep found ${known} (sweep: ${[...codes].join(", ")})`);
    }
    for (const code of codes) {
      for (const sent of [code, `transition_commission_entry: ${code}`]) {
        const sentence = errorSentence(sent);
        assert.ok(!sentence.includes("_"), `${sent} -> "${sentence}" shows a code`);
        assert.match(sentence, /^[A-Z].*\.$/, `${sent} -> "${sentence}" is not a sentence`);
      }
    }
    assert.equal(errorSentence("unauthorized"), "Your session ended. Sign in again.");
    assert.equal(errorSentence("forbidden_commission_role"), "Commissions aren't part of your role.");
    for (const code of [...codes].filter((c) => c.endsWith("_unavailable"))) {
      assert.equal(errorSentence(code), "We couldn't load commissions just now. Try again in a moment.", code);
    }
    for (const unknown of [undefined, null, "", "SQLITE_CONSTRAINT: CHECK constraint failed: website_sales_commissions", "constructor", "no_such_code"]) {
      assert.equal(errorSentence(unknown), GENERIC_ERROR_SENTENCE, String(unknown));
    }
  });

  await check("the portal draws the sentence for a failed read, never the code", async () => {
    for (const [id, code] of Object.entries(ERROR_CASES)) {
      const text = readable(rendered.html[id]);
      assert.ok(text.includes(errorSentence(code)), `${id}: "${errorSentence(code)}" is on screen`);
      assert.doesNotMatch(text, CODE_ON_SCREEN, `${id}: a code is on screen: ${text.match(CODE_ON_SCREEN)?.[0]}`);
      assert.ok(text.includes("Totals unavailable"), `${id}: the totals say they are unavailable, not $0`);
      assert.ok(text.includes("Entries couldn't be loaded"), `${id}: the list does not claim there are no entries`);
      assert.doesNotMatch(text, /No commission entries/, `${id}: an unread list is not an empty one`);
    }
  });

  // -- 4. an empty ledger --------------------------------------------------
  await check("an empty ledger shows one explainer with the comp engine's rates, not four $0 cards", async () => {
    const initial = newRepPaint.initial;
    assert.ok(initial && initial.ok, JSON.stringify(initial));
    assert.equal(initial.summary.entryCount, 0, "the fixture's new closer has earned nothing");
    const text = readable(rendered.html.empty);
    assert.ok(text.includes("Commission appears here once a client's setup payment is confirmed"), text);
    const pct = (bps: number) => `${Math.round(bps / 100)}%`;
    for (const rate of [comp.COMPANY_TRACK_BPS.opener, comp.COMPANY_TRACK_BPS.closer, comp.SELF_TRACK_BPS.open_close, comp.SELF_TRACK_BPS.full_stack, comp.MANAGER_OVERRIDE_BPS]) {
      assert.ok(text.includes(pct(rate)), `the explainer states the engine's ${pct(rate)}`);
    }
    assert.doesNotMatch(text, /\$0\.00|Net total|Accrued|Awaiting founder approval/, "no zero totals");
  });

  // -- 5. no database name on screen ---------------------------------------
  await check('no "Turso" in any rendered string: header, every portal state, the loading skeleton', async () => {
    const strings = [
      founderPaint.header?.title ?? "",
      founderPaint.header?.subtitle ?? "",
      ...Object.values(rendered.html).map(readable),
      ...[...Object.values(ERROR_CASES)].map(errorSentence),
    ];
    assert.ok(strings.length >= 9);
    for (const s of strings) assert.doesNotMatch(s, /turso/i, s.slice(0, 160));
    assert.ok(founderPaint.header?.subtitle, "the page has a plain subtitle");
  });

  await check("the loading skeleton is the page's shape from the shared primitives, with no words", async () => {
    const src = read("app/commissions/loading.tsx");
    assert.match(src, /from "@\/components\/founders\/finances\/Skeleton"/, "built from the shared skeleton primitives");
    assert.match(src, /<SkeletonFigures count=\{4\} \/>/, "four figures, like the four totals");
    assert.match(src, /<SkeletonTable rows=\{\d+\} \/>/, "then the entries list");
    assert.ok(rendered.html.loading.includes('aria-busy="true"'));
    assert.equal(readable(rendered.html.loading).trim(), "", "shapes only: no words, no numbers");
    assert.ok(existsSync(join(ROOT, "app/commissions/loading.tsx")));
  });

  // -- 6. fits a laptop ----------------------------------------------------
  await check("the entry row fits a laptop: every track can shrink, five columns from 1440px, controls wrap below", async () => {
    const src = read("app/commissions/CommissionPortal.tsx");
    assert.doesNotMatch(src, /minmax\(\d+px/, "a fixed track minimum makes the row wider than a 1280px laptop's page");
    const row = /<div className="(grid gap-5 [^"]*)">/.exec(src)?.[1] ?? "";
    assert.ok(row, "found the entry row's grid");
    const templates = [...row.matchAll(/(\S*)grid-cols-\[([^\]]+)\]/g)].map((m) => ({ at: m[1], tracks: m[2].split("_") }));
    const five = templates.filter((t) => t.tracks.length === 5);
    assert.deepEqual(five.map((t) => t.at), ["min-[1440px]:"], "five columns only from 1440px");
    for (const t of templates) {
      for (const track of t.tracks) assert.match(track, /^minmax\(0,/, `${t.at}${track} cannot shrink`);
    }
    assert.match(src, /className="md:col-span-2 xl:col-span-4 min-\[1440px\]:col-span-1"/, "the payout controls take their own line below 1440px");
  });

  // -- 7. the route is the same data ---------------------------------------
  await check("GET /api/website-sales/commissions is a thin wrapper: the loader's body, and plain codes for the screen to word", async () => {
    await login("cc");
    const res = await route.GET();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), JSON.parse(JSON.stringify((await portal.loadCommissionPortal(session("cc", true), "founder")).body)));
    await login(null);
    const out = await route.GET();
    assert.equal(out.status, 401);
    assert.deepEqual(await out.json(), { ok: false, error: "unauthorized" });
  });

  // Last: it gives the new closer a first commission.
  await check("empty to first entry: the explainer keeps Refresh, and a first commission replaces it with the list", async () => {
    assert.match(
      rendered.html.empty,
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*Refresh<\/button>/,
      "the explainer has its own Refresh button",
    );
    const { portalStateAfter, showsNoCommissionYet } = await import("../app/commissions/CommissionPortal");
    const empty = portalStateAfter(null, newRepPaint.initial ?? null, "commission_portal_unavailable");
    assert.equal(showsNoCommissionYet(empty), true, "the page opens on the explainer");
    // A verified payment gives the closer a first commission; Refresh asks the
    // route, which now answers with it.
    await client.execute({
      sql: `INSERT INTO website_sales_commissions (id, tenant_id, deal_id, rep_user_id, payment_reference, entry_type, party_role,
              basis_amount_cents, rate_bps, amount_cents, collected_setup_amount, rate, amount, status, created_at, updated_at)
            VALUES ('c-newrep-first', ?, 'deal-maple', ?, 'ref-newrep-first', 'accrual', 'closer', 20000, 2500, 5000, 200, 0.25, 50, 'accrued', ?, ?)`,
      args: [OASIS, USERS.newRep.id, "2026-10-02T15:00:00Z", "2026-10-02T15:00:00Z"],
    });
    await login("newRep");
    const res = await route.GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as Payload;
    assert.ok(body.ok && body.data.length === 1, JSON.stringify(body).slice(0, 200));
    const refreshed = portalStateAfter(empty, body, "commission_refresh_unavailable");
    assert.equal(showsNoCommissionYet(refreshed), false, "the explainer gives way to the list");
    assert.deepEqual(refreshed.rows.map((row) => row.id), ["c-newrep-first"]);
    assert.equal(refreshed.summary?.entryCount, 1);
    // A Refresh that fails while the page is empty says so, instead of still
    // claiming there is no commission.
    const failed = portalStateAfter(empty, null, "commission_refresh_unavailable");
    assert.equal(showsNoCommissionYet(failed), false);
    assert.equal(failed.error, "commission_refresh_unavailable");
    // And the list draws the first entry, where React is whole.
    const text = readable(renderPortal({ first: body }).html.first);
    assert.ok(text.includes("Maple Dental"), text.slice(0, 200));
    assert.doesNotMatch(text, /No commission yet/);
  });

  if (failures) {
    console.log(`commissions-portal: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("commissions-portal: all passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
