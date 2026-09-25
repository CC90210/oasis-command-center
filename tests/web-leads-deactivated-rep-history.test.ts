/**
 * web-leads-deactivated-rep-history.test.ts -- the Web Leads surface keeps a
 * deactivated rep's HISTORY while never handing them LIVE work (2026-09-24).
 *
 * Run: node --conditions=react-server --import tsx tests/web-leads-deactivated-rep-history.test.ts
 *
 * Deactivating a rep keeps assigned_to on their closed / won / in-delivery
 * leads (lib/team-activation-rules.ts "keep"). getOasisSalesRepRoster defaults
 * to ACTIVE members, which is right for a live target and wrong for history.
 * Two Web Leads reads used the default and dropped a former rep's history:
 *
 *   lib/web-leads/data.ts    repNameMap -- the owner badge on a lead the
 *                            former rep still holds lost their name
 *   lib/web-leads/viewer.ts  resolveWebLeadViewer -- a manager's read boundary
 *                            lost the former report, so their won deal 404'd
 *                            on every by-id route, the battle card included
 *
 * The live side is asserted against the same fixture: the claim route still
 * refuses the deactivated rep as a self-claim and as an assignTo target, even
 * from a manager whose read boundary now names them.
 *
 * Everything below EXECUTES the real code against a local libSQL file, through
 * the real session check and roster reads. The only stand-in is the request
 * cookie jar (next/headers), as in tests/web-leads-claim-active-roster.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

// Env before any module under test is imported: lib/turso.ts and
// lib/supabase-server.ts memoise their clients on first use.
const dbFile = join(mkdtempSync(join(tmpdir(), "web-leads-rep-history-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "web-leads-deactivated-rep-history-secret-long-enough-01";

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
const headersPath = require.resolve("next/headers");
require.cache[headersPath] = {
  id: headersPath,
  filename: headersPath,
  path: dirname(headersPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    cookies: async () => ({
      get: (name: string) =>
        name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
      getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
      has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
      set: () => undefined,
    }),
    headers: async () => new Headers(),
    draftMode: async () => ({ isEnabled: false }),
  },
} as unknown as NodeModule;

const CC = "2c2c2c2c-0000-4000-8000-000000000001";
const ADON = "2c2c2c2c-0000-4000-8000-000000000002";
const MANAGER = "2c2c2c2c-0000-4000-8000-000000000003";
const ACTIVE = "2c2c2c2c-0000-4000-8000-000000000004"; // active opener, reports to MANAGER
const GONE = "2c2c2c2c-0000-4000-8000-000000000005"; // deactivated closer, reported to MANAGER
const GONE_WON = "2d2d2d2d-0000-4000-8000-000000000001";
const ACTIVE_HELD = "2d2d2d2d-0000-4000-8000-000000000002";
const FOUNDER_HELD = "2d2d2d2d-0000-4000-8000-000000000003";
const POOL = "2d2d2d2d-0000-4000-8000-000000000004";

const people: { id: string; email: string; role: string; owner: number; name: string; managerId?: string }[] = [
  { id: CC, email: "conaugh@oasisai.work", role: "owner", owner: 1, name: "Conaugh McKenna" },
  { id: ADON, email: "adon@oasisai.work", role: "closer", owner: 0, name: "Adon" },
  { id: MANAGER, email: "manager@oasis.test", role: "manager", owner: 0, name: "Morgan Manager" },
  { id: ACTIVE, email: "active@oasis.test", role: "opener", owner: 0, name: "Active Rep", managerId: MANAGER },
  { id: GONE, email: "former@oasis.test", role: "closer", owner: 0, name: "Former Rep", managerId: MANAGER },
];

type ClaimBody = { ok?: boolean; error?: string; assignedTo?: string; claimed?: string[] };

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
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT,
      invited_by TEXT, manager_user_id TEXT, joined_at TEXT, updated_at TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE leadgen_recheck_requests (
      id TEXT PRIMARY KEY, tenant_id TEXT, business_id TEXT, lead_id TEXT,
      supplied_url TEXT, requested_by TEXT, status TEXT, requested_at TEXT,
      completed_at TEXT, error TEXT
    );
  `);
  const lead = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, WEBDEV_TENANT_ID, JSON.stringify({ state: "ON", ...data })],
  });
  const heldAt = "2026-09-20T00:00:00Z";
  await seed.batch(
    [
      ...people.map((p) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [p.id, p.email],
      })),
      ...people.map((p) => ({
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner,
                onboarding_completed_at, full_name, manager_user_id, joined_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [`p-${p.id}`, p.id, p.email, WEBDEV_TENANT_ID, p.role, p.owner, p.name, p.managerId ?? null],
      })),
      // Retired the way migration 179 records it, with no ban on the auth row, so
      // the deactivated rep's session still resolves and every refusal below is
      // the roster's -- the defense-in-depth case the claim route's header lists.
      {
        sql: `UPDATE user_profiles SET deactivated_at = '2026-09-24T00:00:00Z', deactivated_by = ?,
              deactivation_reason = 'sales team retired' WHERE auth_user_id = ?`,
        args: [CC, GONE],
      },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [WEBDEV_TENANT_ID] },
      // Kept on the former rep for history: a won deal is never pool inventory.
      lead(GONE_WON, { business_name: "Former Rep Won Co", stage: "won", assigned_to: GONE, claimed_at: heldAt, last_call_at: heldAt }),
      lead(ACTIVE_HELD, { business_name: "Active Rep Held Co", stage: "assigned", assigned_to: ACTIVE, claimed_at: heldAt, last_call_at: heldAt }),
      lead(FOUNDER_HELD, { business_name: "Founder Held Co", stage: "assigned", assigned_to: CC, claimed_at: heldAt, last_call_at: heldAt }),
      lead(POOL, { business_name: "Pool Bakery", stage: "researched" }),
    ],
    "write",
  );

  const { signSession } = await import("../lib/turso-auth");
  const { resolveSessionContext } = await import("../lib/api-auth");
  const { getOasisSalesRepRoster } = await import("../lib/team");
  const { resolveWebLeadViewer } = await import("../lib/web-leads/viewer");
  const { fetchLeads } = await import("../lib/web-leads/data");
  const { parseFilters } = await import("../lib/web-leads/filters");
  const { EMPTY_SCORE_INDEX } = await import("../lib/web-leads/scores");
  const battlecardRoute = await import("../app/api/web-leads/[id]/battlecard/route");
  const claimRoute = await import("../app/api/web-leads/claim/route");
  const { NextRequest } = await import("next/server");

  const login = (userId: string) => {
    const email = people.find((p) => p.id === userId)!.email;
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const session = async () => {
    const ctx = await resolveSessionContext();
    assert.ok(ctx.ok, `session did not resolve: ${JSON.stringify(ctx)}`);
    return ctx;
  };
  const teamBook = async () => {
    const viewer = await resolveWebLeadViewer(await session());
    const { leads } = await fetchLeads(parseFilters(new URLSearchParams()), [], viewer, EMPTY_SCORE_INDEX, {
      scope: "team",
      now: Date.now(),
    });
    return new Map(leads.map((l) => [l.id, l]));
  };
  const battlecard = async (id: string) => {
    const res = await battlecardRoute.GET(new Request(`http://localhost/api/web-leads/${id}/battlecard`), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as { lead?: { id: string }; error?: string } };
  };
  const postClaim = async (body: Record<string, unknown>) => {
    const req = new NextRequest("http://localhost/api/web-leads/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await claimRoute.POST(req);
    return { status: res.status, body: (await res.json()) as ClaimBody };
  };
  const storedPool = async () => {
    const r = await seed.execute({ sql: "SELECT data, updated_at FROM tenant_records WHERE id = ?", args: [POOL] });
    return { data: JSON.parse(String(r.rows[0].data)) as Record<string, unknown>, updatedAt: String(r.rows[0].updated_at) };
  };

  console.log("web-leads-deactivated-rep-history:");

  await check("fixture: the default sales roster really drops the deactivated rep (so the checks below exercise it)", async () => {
    const ids = (await getOasisSalesRepRoster(WEBDEV_TENANT_ID)).map((m) => m.auth_user_id);
    assert.equal(ids.includes(GONE), false);
    assert.equal(ids.includes(ACTIVE), true);
  });

  // ── HISTORY: the owner badge (lib/web-leads/data.ts repNameMap) ───────────
  await check("name map: an admin's Team leads still names the deactivated rep on the deal they kept", async () => {
    login(CC);
    const book = await teamBook();
    assert.equal(book.get(GONE_WON)?.assignedToName, "Former Rep", "a former rep's name must survive on history rows");
    assert.equal(book.get(ACTIVE_HELD)?.assignedToName, "Active Rep");
  });

  // ── HISTORY: the manager's read boundary (lib/web-leads/viewer.ts) ────────
  await check("viewer: a manager's read boundary covers the deactivated report and never an owner", async () => {
    login(MANAGER);
    const viewer = await resolveWebLeadViewer(await session());
    const ids = viewer.readableAssigneeIds ?? [];
    assert.ok(ids.includes(GONE.toLowerCase()), "the deactivated report must stay on the read boundary");
    assert.ok(ids.includes(ACTIVE.toLowerCase()));
    // CC only: the roster excludes owners by is_owner, and ADON is seeded as a
    // non-owner closer (as in tests/web-leads-claim-active-roster.test.ts), so
    // whether he is on it is a property of that seed, not of this change.
    assert.equal(ids.includes(CC.toLowerCase()), false, "an owner never joins a manager's roster");
  });
  await check("manager Team leads: the former report's won deal is listed and named; a founder's is not", async () => {
    login(MANAGER);
    const book = await teamBook();
    assert.equal(book.get(GONE_WON)?.assignedToName, "Former Rep");
    assert.equal(book.get(ACTIVE_HELD)?.assignedToName, "Active Rep");
    assert.equal(book.has(FOUNDER_HELD), false, "the widening is the rep roster, not the tenant");
  });
  await check("battle card: the manager may read the former report's won deal (200), not a founder's (404)", async () => {
    login(MANAGER);
    const won = await battlecard(GONE_WON);
    assert.equal(won.status, 200, JSON.stringify(won.body));
    assert.equal(won.body.lead?.id, GONE_WON);
    const founder = await battlecard(FOUNDER_HELD);
    assert.equal(founder.status, 404, JSON.stringify(founder.body));
  });
  await check("battle card: the widening is the manager's only -- an opener still gets 404 on the former rep's deal", async () => {
    login(ACTIVE);
    const won = await battlecard(GONE_WON);
    assert.equal(won.status, 404, JSON.stringify(won.body));
  });

  // ── LIVE: the deactivated rep still cannot receive work ───────────────────
  const before = await storedPool();
  await check("claim: the deactivated rep's own self-claim is refused and nothing is written", async () => {
    login(GONE);
    const res = await postClaim({ leadIds: [POOL] });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "target_not_on_sales_roster");
    assert.deepEqual(await storedPool(), before);
  });
  await check("assign: the manager whose read boundary names the former rep still cannot assign to them", async () => {
    login(MANAGER);
    const res = await postClaim({ leadIds: [POOL], assignTo: GONE });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "target_not_on_sales_roster");
    assert.deepEqual(await storedPool(), before);
  });
  await check("assign: a founder cannot assign to the former rep either", async () => {
    login(CC);
    const res = await postClaim({ leadIds: [POOL], assignTo: GONE });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "target_not_on_sales_roster");
    assert.deepEqual(await storedPool(), before);
  });
  await check("control: the manager CAN assign the same pool lead to the active report", async () => {
    login(MANAGER);
    const res = await postClaim({ leadIds: [POOL], assignTo: ACTIVE });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.assignedTo, ACTIVE);
    assert.equal((await storedPool()).data.assigned_to, ACTIVE);
  });

  seed.close();
  if (failures) {
    console.log(`web-leads-deactivated-rep-history: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("web-leads-deactivated-rep-history: OK");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
