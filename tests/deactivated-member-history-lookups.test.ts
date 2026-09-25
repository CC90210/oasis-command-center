/**
 * deactivated-member-history-lookups.test.ts — a deactivated teammate is gone
 * from LIVE lists but still resolvable wherever the question is about history.
 *
 * getTenantMembers() became active-only by default on 2026-09-24 (the OASIS
 * sales team was retired). It is shared by every tenant, SunBiz included, and
 * four call sites were asking a HISTORY question through it:
 *
 *   - lib/renewals/outreach.ts        the ORIGINAL funding agent of a renewal
 *   - lib/forms/next-steps-email.ts   the assigned agent who signs the email
 *   - OperationsTrackerPanel          who performed past actions
 *   - GET /api/team/members           the lead drawer's CURRENT owner
 *
 * Each one is driven for real here against a local libSQL database (the same
 * next/headers stand-in + signed session as find-existing-lead-phone.test.ts).
 * The only other stand-ins: the SunBiz mailbox credential loader (so no SMTP is
 * ever reached — being asked for credentials proves the recipient resolved),
 * next/link, and a fake handoff db for the merchant email.
 *
 * Run: node --conditions=react-server --import tsx tests/deactivated-member-history-lookups.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "deactivated-member-history-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "deactivated-member-history-secret-that-is-long-enough-01";
// Never let a test reach Google, a bridge, SMTP or Telegram, whatever the
// developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|SUNBIZ_TELEGRAM|TELEGRAM_)/.test(key)) delete process.env[key];
}

// tsconfig sets jsx:"preserve", so tsx compiles the panel's JSX with the classic
// runtime, which expects a global React (same as delivery-pages.test.ts).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

function stubModule(path: string, exports: Record<string, unknown>) {
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
stubModule(require.resolve("next/headers"), {
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
stubModule(require.resolve("next/link"), {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
});

// The renewal email asks for the SunBiz mailbox credentials only once it has a
// recipient. Record the ask and stop there: no transport is ever built.
const credentialAsks: string[] = [];
stubModule(require.resolve("../lib/integrations/submissions-gmail"), {
  getSubmissionsCreds: async (tenantId: string) => {
    credentialAsks.push(tenantId);
    throw new Error("test stub: stop before SMTP");
  },
  getSubmissionsFrom: async () => "submissions@sun.test",
});

const TENANT = "7c7c7c7c-0000-4000-8000-00000000007c";
const ADMIN = "0d0d0d0d-0000-4000-8000-000000000001";
const ACTIVE_REP = "0d0d0d0d-0000-4000-8000-000000000002";
const RETIRED_REP = "0d0d0d0d-0000-4000-8000-000000000003";
const IDLE_RETIRED = "0d0d0d0d-0000-4000-8000-000000000004";
const NOBODY = "0d0d0d0d-0000-4000-8000-0000000000ff";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Every string reachable in an element tree (delivery-pages.test.ts). */
function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 60 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function") {
      try {
        const rendered = (node.type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) {
          textOf(rendered, out, depth + 1);
          return out;
        }
      } catch {
        /* client component: use its props below */
      }
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v as ReactNode, out, depth + 1);
      else if (typeof v === "string") out.push(v);
    }
    return out;
  }
  return out;
}

/** Chainable, thenable stand-in for the merchant-email handoff db
 *  (email-idempotency-marker.test.ts); records every insert. */
function makeHandoffDb(assignedTo: string, inserts: Array<{ table: string; row: Record<string, unknown> }>) {
  const resultFor = (table: string, op: string): { data: unknown; error: unknown } => {
    if (table === "lead_interactions" && op === "select") return { data: [], error: null };
    if (table === "tenant_records" && op === "select") {
      return {
        data: { data: { email: "merchant@example.com", contact_name: "Dana Merchant", assigned_to: assignedTo } },
        error: null,
      };
    }
    // A non-SunBiz slug: no direct-SMTP path and no global bridge fallback, so
    // the send fails closed into the failure marker this test reads.
    if (table === "tenants" && op === "select") {
      return { data: { slug: "acme-funding", name: "Acme Funding", custom_fields: null }, error: null };
    }
    return { data: null, error: null };
  };
  const from = (table: string) => {
    let op = "select";
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain, eq: chain, neq: chain, ilike: chain, contains: chain, order: chain,
      limit: chain, in: chain, gte: chain, like: chain,
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        inserts.push({ table, row });
        return builder;
      },
      update: () => { op = "update"; return builder; },
      delete: () => { op = "delete"; return builder; },
      maybeSingle: async () => resultFor(table, op),
      single: async () => resultFor(table, op),
      then: (onFulfilled: (v: { data: unknown; error: unknown }) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resultFor(table, op)).then(onFulfilled, onRejected),
    });
    return builder;
  };
  return { from };
}

async function main() {
  const seed = createClient({ url: `file:${dbFile}` });
  const now = new Date().toISOString();
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, invited_by TEXT,
      joined_at TEXT, manager_user_id TEXT, updated_at TEXT, custom_fields TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_audit_log (id TEXT PRIMARY KEY, tenant_id TEXT, actor_email TEXT,
      actor_user_id TEXT, action_type TEXT, target_table TEXT, target_id TEXT, after TEXT, created_at TEXT);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT,
      channel TEXT, direction TEXT, agent_source TEXT, actor_user_id TEXT, metadata TEXT,
      to_email TEXT, created_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT,
      payload TEXT, correlation_id TEXT, created_at TEXT, published_at TEXT);
  `);
  const profile = (
    id: string, authId: string, email: string, name: string, role: string,
    opts: { owner?: number; deactivatedAt?: string | null } = {},
  ) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name,
            onboarding_completed_at, joined_at, updated_at, deactivated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, email, TENANT, role, opts.owner ?? 0, name, opts.deactivatedAt ?? null],
  });
  await seed.batch(
    [
      ...[
        [ADMIN, "admin@t.test"],
        [ACTIVE_REP, "riley@t.test"],
        [RETIRED_REP, "ethan@t.test"],
        [IDLE_RETIRED, "idle@t.test"],
      ].map(([id, email]) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [id, email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'Sun Biz Funding')", args: [TENANT] },
      profile("p-admin", ADMIN, "admin@t.test", "Ada Admin", "owner", { owner: 1 }),
      profile("p-riley", ACTIVE_REP, "riley@t.test", "Riley Active", "agent"),
      profile("p-ethan", RETIRED_REP, "ethan@t.test", "Ethan Retired", "agent", { deactivatedAt: "2026-09-24T12:00:00Z" }),
      profile("p-idle", IDLE_RETIRED, "idle@t.test", "Idle Retired", "agent", { deactivatedAt: "2026-09-24T12:00:00Z" }),
      // Ethan acted inside the 7-day window before he was deactivated.
      {
        sql: `INSERT INTO tenant_audit_log (id, tenant_id, actor_email, actor_user_id, action_type, target_table, created_at)
              VALUES ('audit-1', ?, 'ethan@t.test', ?, 'lead.stage_change', 'tenant_records', ?)`,
        args: [TENANT, RETIRED_REP, now],
      },
      {
        sql: `INSERT INTO lead_interactions (id, tenant_id, lead_id, type, channel, direction, agent_source, actor_user_id, created_at)
              VALUES ('li-1', ?, 'lead-1', 'email_sent', 'email', 'outbound', 'manual', ?, ?)`,
        args: [TENANT, RETIRED_REP, now],
      },
    ],
    "write",
  );

  const { signSession } = await import("../lib/turso-auth");
  const { NextRequest } = await import("next/server");
  sessionCookie = signSession({ sub: ADMIN, email: "admin@t.test", exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  // ── FINDING 9: the lead drawer's owner list ────────────────────────────────
  const membersRoute = await import("../app/api/team/members/route");
  type RouteMember = { auth_user_id: string; full_name: string; active: boolean; calendar_connected: boolean };
  const getMembers = async (query: string) => {
    const res = await membersRoute.GET(new NextRequest(`http://localhost/api/team/members${query}`));
    assert.equal(res.status, 200, `GET ${query || "(default)"} status`);
    return ((await res.json()) as { members: RouteMember[] }).members;
  };

  await check("default roster is unchanged: active teammates only, each flagged active", async () => {
    const members = await getMembers("");
    const ids = members.map((m) => m.auth_user_id).sort();
    assert.deepEqual(ids, [ADMIN, ACTIVE_REP].sort());
    assert.ok(members.every((m) => m.active === true));
  });

  await check("?include_inactive=1 adds deactivated teammates, flagged active:false and never calendar-ready", async () => {
    const members = await getMembers("?include_inactive=1");
    const ethan = members.find((m) => m.auth_user_id === RETIRED_REP);
    assert.ok(ethan, "the deactivated current owner must be in the opted-in response");
    assert.equal(ethan.active, false);
    assert.equal(ethan.full_name, "Ethan Retired");
    assert.equal(ethan.calendar_connected, false);
    assert.equal(members.find((m) => m.auth_user_id === ACTIVE_REP)?.active, true);
    assert.equal(members.length, 4);
  });

  await check("any other value of include_inactive keeps the live roster", async () => {
    const members = await getMembers("?include_inactive=true");
    assert.ok(!members.some((m) => m.auth_user_id === RETIRED_REP));
  });

  // ── FINDING 8: the renewal-threshold email to the original funding agent ──
  const { notifyRenewalAgent } = await import("../lib/renewals/outreach");
  const telegramDb = {
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  };
  const renewal = (agentId: string) =>
    notifyRenewalAgent({
      db: telegramDb as never,
      tenantId: TENANT,
      leadId: "lead-1",
      agentId,
      merchant: "Digits Co",
      lender: "Lender One",
      amount: 50000,
      fundedAt: "2026-06-01",
      termLabel: "6 months",
      thresholdDate: "2026-09-01",
      dealId: "deal-1",
      status: "queued",
    });
  const captureWarn = async (fn: () => Promise<unknown>) => {
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args);
    };
    try {
      await fn();
    } finally {
      console.warn = original;
    }
    return warned;
  };
  const quietError = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try {
      return await fn();
    } finally {
      console.error = original;
    }
  };

  await check("a DEACTIVATED funding agent still resolves, so their renewal email is sent (to the submissions inbox)", async () => {
    credentialAsks.length = 0;
    const warned = await quietError(() => captureWarn(() => renewal(RETIRED_REP)));
    assert.equal(credentialAsks.length, 1, "the email path must reach the mailbox (recipient resolved), not skip");
    const tagged = warned.find((args) => args[0] === "[renewal-outreach] deactivated-agent");
    assert.ok(tagged, "rerouting a deactivated agent's renewal must be visible in the logs");
    assert.equal((tagged[1] as { agentId?: string }).agentId, RETIRED_REP);
    assert.equal((tagged[1] as { dealId?: string }).dealId, "deal-1");
  });

  await check("an active funding agent resolves with no deactivation warning", async () => {
    credentialAsks.length = 0;
    const warned = await quietError(() => captureWarn(() => renewal(ACTIVE_REP)));
    assert.equal(credentialAsks.length, 1);
    assert.ok(!warned.some((args) => args[0] === "[renewal-outreach] deactivated-agent"));
  });

  await check("an agent id that matches no member still sends nothing", async () => {
    credentialAsks.length = 0;
    await quietError(() => renewal(NOBODY));
    assert.equal(credentialAsks.length, 0);
  });

  // ── FINDING 11: the SunBiz merchant email's signature + internal CC ───────
  const { maybeSendApplicationReceivedEmail } = await import("../lib/forms/next-steps-email");
  const sendReceipt = async (assignedTo: string) => {
    const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    await quietError(() =>
      maybeSendApplicationReceivedEmail({
        db: makeHandoffDb(assignedTo, inserts) as never,
        form: { id: "form-1", tenant_id: TENANT, slug: "full-application" },
        link: { tenant: "acme-funding", lead_id: "lead-1" },
        payload: {},
        origin: "https://oasisai.work",
      } as never),
    );
    const marker = inserts.find(
      (i) => i.table === "lead_interactions" && (i.row.metadata as { status?: string } | undefined)?.status === "failed",
    );
    assert.ok(marker, "the unsent receipt must leave its failure marker (bridge is not configured in tests)");
    return { body: String(marker.row.content), cc: (marker.row.metadata as { cc_email?: string | null }).cc_email };
  };

  await check("a deactivated but still-assigned agent never signs a new email and is never CC'd", async () => {
    const { body, cc } = await sendReceipt(RETIRED_REP);
    // A NEW outbound message is live work, so the retired agent is not its
    // signer (2026-09-24 rule): the team signature signs, and their name
    // appears nowhere. This tenant is not SunBiz, so there is no submissions
    // inbox to CC in their place.
    assert.match(body, /^- the SunBiz team$/m);
    assert.ok(!body.includes("Ethan Retired"), "the retired agent's name must not appear in a new email");
    assert.equal(cc, null);
  });

  await check("only an id matching no member falls back to the generic signature and no CC", async () => {
    const { body, cc } = await sendReceipt(NOBODY);
    assert.match(body, /^- the SunBiz team$/m);
    assert.equal(cc, null);
  });

  // ── FINDING 10: Settings > Operations tracker ──────────────────────────────
  const { OperationsTrackerPanel } = await import("../components/settings/OperationsTrackerPanel");
  await check("past actions by a deactivated teammate keep their name in the feed and the 7-day totals", async () => {
    const tree = await quietError(() => OperationsTrackerPanel({ tenantId: TENANT, tenantName: "Sun Biz Funding" }));
    const text = textOf(tree);
    assert.ok(text.includes("Ethan Retired"), "the activity feed must name the deactivated actor, not 'System'");
    assert.ok(text.includes("Ethan Retired (inactive)"), "the 7-day rollup must still count and label his actions");
    assert.ok(text.includes("Riley Active"), "an active teammate with no actions keeps their zero row");
    assert.ok(
      !text.some((value) => value.includes("Idle Retired")),
      "a deactivated teammate with no actions in the window is not listed as team activity",
    );
  });

  if (failures) {
    console.error(`deactivated-member history lookups: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("deactivated-member history lookups: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
