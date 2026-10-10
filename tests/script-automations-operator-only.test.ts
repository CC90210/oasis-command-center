/**
 * tests/script-automations-operator-only.test.ts — only a verified platform
 * operator may CREATE a script automation, and nobody else is offered a
 * control for it (Automations guided setup, PR1).
 *
 * WHY. A script automation is code that runs on a paired machine. Any client
 * workspace owner could draft one with AI (POST /api/automations/draft), save
 * it (POST /api/automations/save-draft) or post one (POST /api/cron-jobs).
 * Clients get department tasks instead; the three script doors now ask the
 * verified operator question (lib/platform-operator.ts, through
 * lib/automations/script-access.ts). And because every button must lead
 * somewhere real, the page stops offering the AI box and the "New automation"
 * button to anyone the routes would refuse: they read "New automations are
 * coming to this page." instead.
 *
 * WHAT IS PINNED, through the real route handlers, real signed sessions and a
 * local libSQL file (next/headers, next/navigation, next/link and the AI
 * drafter are the only stand-ins; the drafter so a regression can never reach
 * a model):
 *   - each of the three create routes answers a client workspace OWNER 403
 *     script_automations_operator_only with a sentence, creates nothing, and
 *     never calls the drafter;
 *   - a verified operator still drafts, saves (switched off) and creates;
 *   - a plain member keeps the old 403 forbidden;
 *   - an operator check that cannot be read answers 503, never a create and
 *     never "you are not an operator";
 *   - save-draft uses the shared grammar: a MON-FRI schedule (which the
 *     bridge cannot run) is refused;
 *   - AutomationsContent shows DescribeAutomationFlow and hands CronJobsManager
 *     canCreateScripts only for "allowed", and the placeholder sentence (or an
 *     honest "couldn't confirm") otherwise; both mounts resolve the verdict
 *     from the verified check, and the default is closed;
 *   - CronJobsManager renders its New automation button and create editor only
 *     behind canCreateScripts.
 *
 * Run: node --conditions=react-server --import tsx tests/script-automations-operator-only.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "script-automations-operator-only-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "script-automations-operator-only-secret-00001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";

// tsx compiles the components' JSX with the classic runtime.
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
  usePathname: () => "/automations",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// The drafter calls a model. Stand it in so a refused caller provably never
// reaches it and a regression in the gate can never spend a token.
let draftCalls = 0;
stub("../lib/ai-automation-drafter", {
  __esModule: true,
  draftAutomation: async () => {
    draftCalls += 1;
    return {
      suggested_name: "Morning lead summary",
      suggested_description: "Summarises new leads.",
      script_filename: "morning_lead_summary.py",
      script_content: "print('summary')",
      schedule: "0 8 * * *",
      schedule_human: "Daily at 08:00",
      agent_key: "bravo",
    };
  },
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS_OPERATOR_TENANT_ID
const CLIENT = "6c6c6c6c-0000-4000-8000-00000000006c";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // verified operator: alias + OASIS owner seat
  owner: u(2, "owner@clientco.test"), // a client workspace's owner
  member: u(3, "member@clientco.test"), // a plain member there
} as const;

async function login(user: U | null) {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 12).join("\n        ")}`);
  }
}

type Body = { ok?: boolean; error?: string; message?: string; missing_or_invalid?: string[]; cron_id?: string; job?: { id: string } };

/** Every element of `type` in a returned (not rendered) element tree. */
function findAll(node: unknown, type: unknown, out: Array<{ props: Record<string, unknown> }> = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, type, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type && el.props) out.push(el as { props: Record<string, unknown> });
  if (el.props) findAll(el.props.children, type, out);
  return out;
}
/** The literal text in a returned element tree. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: unknown } };
  return el.props ? textOf(el.props.children) : "";
}

const COMING = "New automations are coming to this page.";

async function main() {
  console.log("script-automations-operator-only:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      updated_at TEXT, deactivated_at TEXT, joined_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, label TEXT, last_seen_at TEXT, revoked_at TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT UNIQUE,
      slug TEXT UNIQUE, manifest TEXT, version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      agent_key TEXT NOT NULL DEFAULT 'bravo', name TEXT NOT NULL, description TEXT,
      schedule TEXT NOT NULL, action_type TEXT NOT NULL, action_payload TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, last_run_status TEXT, last_run_output TEXT,
      last_run_error TEXT, run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
    );
  `);
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: keyof typeof USERS, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
            full_name, agents_enabled, updated_at, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Person', '[]', ?, ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'clientco', 'Client Co')", args: [CLIENT] },
      profile("cc", OASIS, "owner", 1),
      profile("owner", CLIENT, "owner", 1),
      profile("member", CLIENT, "member", 0),
    ],
    "write",
  );

  const cronRoute = await import("../app/api/cron-jobs/route");
  const draftRoute = await import("../app/api/automations/draft/route");
  const saveRoute = await import("../app/api/automations/save-draft/route");
  const { AutomationsContent } = await import("../components/automations/AutomationsContent");
  const { TenantAutomations } = await import("../components/automations/TenantAutomations");
  const { CronJobsManager } = await import("../components/automations/CronJobsManager");
  const { DescribeAutomationFlow } = await import("../components/automations/DescribeAutomationFlow");
  const AutomationsPage = (await import("../app/automations/page")).default;
  const { NextRequest } = await import("next/server");

  const post = async (route: { POST: (req: InstanceType<typeof NextRequest>) => Promise<Response> }, path: string, body: unknown) => {
    const res = await route.POST(
      new NextRequest(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Body };
  };
  const rowCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n);
  const cronBody = (name: string) => ({
    name,
    schedule: "0 9 * * *",
    action_type: "snapshot_run",
    action_payload: { snapshot: "daily" },
    agent_key: "bravo",
  });
  const draftBody = { description: "Send me a summary of new leads every morning at eight." };
  const saveBody = (schedule: string) => ({
    confirmed: true,
    draft: {
      suggested_name: "Morning lead summary",
      suggested_description: "Summarises new leads.",
      script_filename: "morning_lead_summary.py",
      script_content: "print('summary')",
      schedule,
      agent_key: "bravo",
    },
  });
  const operatorOnly = (res: { status: number; body: Body }, label: string) => {
    assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "script_automations_operator_only", label);
    assert.match(String(res.body.message), /\s/, `${label}: the refusal is a sentence`);
  };
  // Breaks only the operator membership read (it selects deactivated_at by
  // name); the session's own profile read is select("*") and still works.
  const breakOperatorRead = () => db.execute("ALTER TABLE user_profiles RENAME COLUMN deactivated_at TO deactivated_at_offline");
  const restoreOperatorRead = () => db.execute("ALTER TABLE user_profiles RENAME COLUMN deactivated_at_offline TO deactivated_at");
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try {
      return await fn();
    } finally {
      console.error = original;
    }
  };

  // ── the three create routes ────────────────────────────────────────────
  await check("a client workspace owner is refused by all three create routes, and nothing is created or drafted", async () => {
    await login(USERS.owner);
    const before = await rowCount();
    const callsBefore = draftCalls;
    operatorOnly(await post(cronRoute, "/api/cron-jobs", cronBody("Client job")), "POST /api/cron-jobs");
    operatorOnly(await post(draftRoute, "/api/automations/draft", draftBody), "POST /api/automations/draft");
    operatorOnly(await post(saveRoute, "/api/automations/save-draft", saveBody("0 8 * * *")), "POST /api/automations/save-draft");
    assert.equal(await rowCount(), before, "a refused create wrote a row");
    assert.equal(draftCalls, callsBefore, "a refused draft reached the model");
  });

  await check("a plain member keeps the old 403 forbidden", async () => {
    await login(USERS.member);
    for (const [route, path, body] of [
      [cronRoute, "/api/cron-jobs", cronBody("Member job")],
      [draftRoute, "/api/automations/draft", draftBody],
      [saveRoute, "/api/automations/save-draft", saveBody("0 8 * * *")],
    ] as const) {
      const res = await post(route, path, body);
      assert.equal(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "forbidden", path);
    }
  });

  await check("a signed-out caller is 401 on all three", async () => {
    await login(null);
    for (const [route, path, body] of [
      [cronRoute, "/api/cron-jobs", cronBody("Nobody")],
      [draftRoute, "/api/automations/draft", draftBody],
      [saveRoute, "/api/automations/save-draft", saveBody("0 8 * * *")],
    ] as const) {
      assert.equal((await post(route, path, body)).status, 401, path);
    }
  });

  await check("a verified operator still drafts, saves switched off, and creates", async () => {
    await login(USERS.cc);
    const callsBefore = draftCalls;
    const drafted = await post(draftRoute, "/api/automations/draft", draftBody);
    assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
    assert.equal(draftCalls, callsBefore + 1);
    const saved = await post(saveRoute, "/api/automations/save-draft", saveBody("0 8 * * *"));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const savedRow = (await db.execute({ sql: "SELECT tenant_id, action_type, enabled FROM tenant_cron_jobs WHERE id = ?", args: [saved.body.cron_id!] })).rows[0];
    assert.equal(savedRow.tenant_id, OASIS);
    assert.equal(savedRow.action_type, "script_run");
    assert.equal(Number(savedRow.enabled), 0, "an AI-drafted script lands switched off");
    const created = await post(cronRoute, "/api/cron-jobs", cronBody("Operator job"));
    assert.equal(created.status, 200, JSON.stringify(created.body));
  });

  await check("save-draft uses the shared grammar: a MON-FRI schedule the bridge cannot run is refused", async () => {
    await login(USERS.cc);
    const before = await rowCount();
    const res = await post(saveRoute, "/api/automations/save-draft", saveBody("0 8 * * MON-FRI"));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "draft_invalid");
    assert.deepEqual(res.body.missing_or_invalid, ["schedule"]);
    assert.equal(await rowCount(), before);
  });

  await check("an operator check that cannot be read answers 503 on all three: no create, and no false 'not an operator'", async () => {
    await login(USERS.cc);
    const before = await rowCount();
    const callsBefore = draftCalls;
    await breakOperatorRead();
    try {
      for (const [route, path, body] of [
        [cronRoute, "/api/cron-jobs", cronBody("During outage")],
        [draftRoute, "/api/automations/draft", draftBody],
        [saveRoute, "/api/automations/save-draft", saveBody("0 8 * * *")],
      ] as const) {
        const res = await quietly(() => post(route, path, body));
        assert.equal(res.status, 503, `${path}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, "operator_check_unavailable", path);
        assert.match(String(res.body.message), /\s/);
      }
    } finally {
      await restoreOperatorRead();
    }
    assert.equal(await rowCount(), before);
    assert.equal(draftCalls, callsBefore);
  });

  // ── what the page offers ───────────────────────────────────────────────
  await check("an operator's page: the AI box and the New automation button, no placeholder", async () => {
    await login(USERS.cc);
    const tree = await AutomationsContent({ scriptAccess: "allowed" });
    assert.equal(findAll(tree, DescribeAutomationFlow).length, 1, "the AI box is offered");
    const managers = findAll(tree, CronJobsManager);
    assert.equal(managers.length, 1);
    assert.equal(managers[0].props.canCreateScripts, true);
    const text = textOf(tree);
    assert.ok(!text.includes(COMING), "an operator is not told it is coming");
    assert.match(text, /Describe what you want in the box below/);
  });

  await check("a client owner's page (the default): no box, no create button, the placeholder sentence instead", async () => {
    await login(USERS.owner);
    const tree = await AutomationsContent({});
    assert.equal(findAll(tree, DescribeAutomationFlow).length, 0, "the AI box is offered to a non-operator");
    const managers = findAll(tree, CronJobsManager);
    assert.equal(managers.length, 1, "the job list itself still renders");
    assert.equal(managers[0].props.canCreateScripts, false);
    const text = textOf(tree);
    assert.ok(text.includes(COMING), `missing the placeholder: ${text.slice(0, 200)}`);
    assert.doesNotMatch(text, /box below/, "the help text must not point at a box that is not there");
  });

  await check("an unreadable verdict says so plainly and offers nothing", async () => {
    await login(USERS.owner);
    const tree = await AutomationsContent({ scriptAccess: "unknown" });
    assert.equal(findAll(tree, DescribeAutomationFlow).length, 0);
    assert.equal(findAll(tree, CronJobsManager)[0].props.canCreateScripts, false);
    assert.match(textOf(tree), /couldn't confirm your access/i);
  });

  await check("the /t/<slug>/automations mount resolves the verdict from the verified check", async () => {
    await login(USERS.owner);
    assert.equal(((await TenantAutomations({ tenantSlug: "clientco", tenantId: CLIENT })) as { props: { scriptAccess: string } }).props.scriptAccess, "not_allowed");
    await login(USERS.cc);
    assert.equal(((await TenantAutomations({ tenantSlug: "oasis-ai-cc", tenantId: OASIS })) as { props: { scriptAccess: string } }).props.scriptAccess, "allowed");
    await breakOperatorRead();
    try {
      const verdict = await quietly(async () =>
        ((await TenantAutomations({ tenantSlug: "oasis-ai-cc", tenantId: OASIS })) as { props: { scriptAccess: string } }).props.scriptAccess,
      );
      assert.equal(verdict, "unknown", "a failed lookup is not a 'no'");
    } finally {
      await restoreOperatorRead();
    }
    assert.equal(((await TenantAutomations({ tenantSlug: "clientco", tenantId: null })) as { props: { scriptAccess: string } }).props.scriptAccess, "not_allowed");
  });

  await check("the operator-only /automations page offers the controls; anyone else gets its 404", async () => {
    await login(USERS.cc);
    assert.equal(((await AutomationsPage()) as { props: { scriptAccess: string } }).props.scriptAccess, "allowed");
    await login(USERS.owner);
    await assert.rejects(() => AutomationsPage(), /404/);
  });

  await check("CronJobsManager renders its create button and create editor only behind canCreateScripts", () => {
    const src = readFileSync(join(ROOT, "components", "automations", "CronJobsManager.tsx"), "utf8");
    assert.match(src, /canCreateScripts = false/, "the prop defaults closed");
    assert.match(
      src,
      /\{canCreateScripts && \(\s*<button[\s\S]{0,600}?New automation\s*<\/button>\s*\)\}/,
      "the New automation button must sit inside the canCreateScripts gate",
    );
    assert.equal((src.match(/>\s*New automation\s*</g) || []).length, 1, "no second New automation button");
    assert.match(src, /\{creating && canCreateScripts && \(/, "the create editor must not open without the gate");
  });

  if (failures > 0) {
    console.log(`script-automations-operator-only: ${failures} failing`);
    process.exit(1);
  }
  console.log("script-automations-operator-only: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
