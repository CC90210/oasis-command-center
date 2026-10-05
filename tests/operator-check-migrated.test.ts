/**
 * operator-check-migrated.test.ts — nothing grants operator power on an email
 * string alone any more. (doc 02 P0-7 interim, F4 — 2026-09-28)
 *
 * WHY. isOperatorEmail (lib/operator-credentials.ts) matches the session email
 * against OPERATOR_EMAIL / ADMIN_EMAILS, and signup issues a session to any
 * address with no proof of ownership. Twenty-eight call sites used that match
 * as the whole answer, so anyone who registered an unclaimed alias held, on
 * every tenant: the shell/file bridge, the /t/<slug> preview of every
 * workspace, the empire-wide event feed, the platform API keys (OASIS pays),
 * the Empire cron lane and the agent inbox. Every one of them now asks the
 * verified check in lib/platform-operator.ts — the alias AND an active
 * owner/admin OASIS membership read by auth_user_id — which is also what
 * lib/role-surfaces-session.ts resolvePlatformOperator runs for the admin pages.
 *
 * TWO HALVES.
 *   1. STATIC: no source file references isOperatorEmail except the file that
 *      defines it and the verified check that uses it as step 1. Read with the
 *      TypeScript parser, not a regex, so an aliased import or a
 *      `mod["isOperatorEmail"]` lookup is caught and a comment is not.
 *   2. BEHAVIOURAL: the highest-risk sites, run for real against a local libSQL
 *      file with the real signed session cookie and the real Turso adapter.
 *      The central case is the SQUATTER — an alias email whose auth user owns
 *      only its own workspace — plus the variants the old rule also crowned:
 *      an alias matching an UNLINKED OASIS owner row, and a non-alias session
 *      that wrote an alias into its own profile's email column (the bridge
 *      preferred that column over the session's email).
 *
 * WHY lib/role-surfaces-session.ts IS NOT ON THE ALLOWLIST. It used to hold
 * the rule. The rule moved to lib/platform-operator.ts, which role-surfaces-
 * session now delegates to and re-exports, because role-surfaces-session
 * imports next/navigation for its 404 guards and the route handlers and lib
 * modules migrated here must not load the page router (under this runner,
 * next/navigation does not load at all). It no longer references
 * isOperatorEmail, so allowing it would only be room for a regression.
 *
 * Run: node --conditions=react-server --import tsx tests/operator-check-migrated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import ts from "typescript";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");

const dbFile = join(mkdtempSync(join(tmpdir(), "operator-check-migrated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "operator-check-migrated-secret-long-enough-000001";
// conaugh@oasisai.work is the hardcoded default alias; the rest are configured.
delete process.env.OPERATOR_EMAIL;
process.env.ADMIN_EMAILS = ["squatter@alias.test", "unlinked@alias.test"].join(",");
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
// Bridge targets: SunBiz on the global env, OASIS on its per-tenant override.
process.env.BRIDGE_VPS_URL = "https://bridge.sunbiz.test";
process.env.BRIDGE_BEARER_TOKEN = "bearer-sunbiz-test";
process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = "bearer-oasis-test";
// The platform key the chat fallback hands out. OpenRouter is the first
// provider operatorPlatformFallback tries, so this is the key it resolves.
const PLATFORM_KEY = "sk-platform-key-do-not-hand-out";
process.env.PLATFORM_DEFAULT_OPENROUTER_API_KEY = PLATFORM_KEY;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}
stub("next/headers", {
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
// The real next/navigation does not load under react-server. redirect and
// notFound throw exactly the digests Next's do.
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

// ── 1. static ──────────────────────────────────────────────────────────

/**
 * The only files that may reference isOperatorEmail, each with its reason.
 * A DISPLAY-ONLY site (a label, a hint — granting nothing) may be added here
 * with a reason that says so; nothing that decides access, reach, keys, tools
 * or scheduling may. There are none today: every one of the 28 former call
 * sites decided something, so every one was migrated.
 */
const ALLOWED: Record<string, string> = {
  "lib/operator-credentials.ts": "defines isOperatorEmail",
  "lib/platform-operator.ts": "the verified check — isOperatorEmail is its step 1, never the whole answer",
};

const SCAN_DIRS = ["app", "lib", "components", "workers"];
const SCAN_FILES = ["middleware.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__pycache__", ".open-next"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

/** Every place `name` appears as code: an identifier (call, import, alias,
 *  destructure, property access) or an exact string key. Comments are trivia
 *  to the parser, so a comment that mentions the name is not a reference. */
function codeReferences(fileName: string, src: string, name: string): number {
  if (!src.includes(name)) return 0;
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, kind);
  let hits = 0;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) hits += 1;
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === name) hits += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const sourceFiles = [
  ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...SCAN_FILES.map((f) => join(ROOT, f)),
];
const sources = new Map(sourceFiles.map((f) => [rel(f), readFileSync(f, "utf8")] as const));

/** Each migrated call site, pinned to the verified form it now uses, so a
 *  "fix" that drops the check entirely (isOperator = true) fails too. */
const MIGRATED: Array<[string, RegExp]> = [
  ["lib/bridge-proxy.ts", /const isOperator = await isPlatformOperatorForAuthUser\(user\.id, user\.email\);/],
  ["lib/tenant-access.ts", /profile\.isPlatformOperator === true/],
  ["lib/tenant-access.ts", /await isPlatformOperatorForAuthUser\(user\.id, user\.email\)/],
  ["lib/chat-auth.ts", /const isOperator = await isPlatformOperatorForAuthUser\(user\.id, user\.email\);/],
  // The persistent chat is the Coding harness (2026-09-30): the verified
  // verdict gates it entirely, then drives isAdmin.
  ["lib/chat-shell-props.ts", /if \(!isPlatformOperator\) return null;[\s\S]*isAdmin: isPlatformOperator,/],
  // /api/usage's platform key (the chat's Ready check) follows the same rule.
  ["app/api/usage/route.ts", /const isOperator = await isPlatformOperatorForAuthUser\(user\.id, user\.email\);[\s\S]*const fallback = isOperator \? operatorPlatformFallback\(\) : null;/],
  ["lib/auth-routing.ts", /const isEmpireOperator = await isPlatformOperatorForAuthUser\(authUserId, email\);/],
  ["app/layout.tsx", /isPlatformOperator: await platformOperatorP,/],
  ["app/layout.tsx", /isPlatformOperator: platformOperator,/],
  ["app/api/chat/route.ts", /const isOperator = ctxResult\.isOperator;/],
  ["app/api/inbox/post/route.ts", /if \(!\(await isPlatformOperatorForAuthUser\(user\.id, user\.email\)\)\)/],
  ["app/api/inbox/mark-read/route.ts", /if \(!\(await isPlatformOperatorForAuthUser\(user\.id, user\.email\)\)\)/],
  ["app/api/event-feed/route.ts", /const isOperator = await isPlatformOperatorForAuthUser\(user\.id, user\.email\);/],
  ["app/api/cron-jobs/route.ts", /const isOperator = await isPlatformOperatorForAuthUser\(user\.id, user\.email\);/],
  ["app/api/cron-jobs/[id]/route.ts", /source === "empire" && !\(await isPlatformOperatorForAuthUser\(user\?\.id, user\?\.email\)\)/],
  // Read once: the same verdict gates the platform key and the model id in the
  // stream (clients never see which model answered).
  ["app/api/agents/chat/route.ts", /const isOperator = await isPlatformOperatorForAuthUser\(user\.id, user\.email\);[\s\S]*const fallback = isOperator \? operatorPlatformFallback\(\) : null;/],
  // A Slack mention gets the platform key only when the person who wrote it is
  // the verified operator (their Slack email linked to that teammate).
  ["lib/slack/jobs.ts", /return isPlatformOperatorForAuthUser\(String\(r\.auth_user_id\), [\s\S]*platformFallback: operator \? operatorPlatformFallback\(\) : null,/],
  ["app/api/agents/generate/route.ts", /\(await isPlatformOperatorForAuthUser\(user\.id, user\.email\)\) \? operatorPlatformFallback\(\)/],
  ["app/api/manifest/chat/route.ts", /\(await isPlatformOperatorForAuthUser\(user\.id, user\.email\)\) \? operatorPlatformFallback\(\)/],
  ["app/api/gmail-templates/[id]/solara/route.ts", /\(await isPlatformOperatorForAuthUser\(sess\.userId, sess\.email\)\) \? operatorPlatformFallback\(\)/],
  ["app/api/applications/[id]/shop-out/run/route.ts", /tenantSlug !== "submissions" && !\(await isPlatformOperatorForAuthUser\(sess\.userId, sess\.email\)\)/],
  ["app/api/applications/[id]/shop-out/health/route.ts", /tenantSlug !== "submissions" && !\(await isPlatformOperatorForAuthUser\(sess\.userId, sess\.email\)\)/],
  ["app/api/applications/[id]/lender-threads/[threadId]/reply/route.ts", /tenantSlug !== "submissions" && !\(await isPlatformOperatorForAuthUser\(sess\.userId, sess\.email\)\)/],
  // app/applications/[id]/shop-out/page.tsx was deleted 2026-10-01 (OS plan W0,
  // audit U1-19): the retired SunBiz panel; /applications answers 404.
  // OASIS OS shell: the agent fleet moved from /agents (now the AI Team) to
  // /admin/agents, gated by requireOperator() as its first statement. The Feed
  // no longer has an operator branch at all — every viewer, operators included,
  // is scoped to their own workspace (tests/os-landings.test.ts pins that), so
  // there is no operator decision left on that page to pin.
  ["app/admin/agents/page.tsx", /\n\s*await requireOperator\(\);/],
  // A department channel reads "ready" through the same verified platform-key
  // rule as app/api/agents/chat, never the email alone, and only when a
  // platform key exists to fall back to.
  ["components/os/department/channel.ts", /operatorPlatformFallback\(\) !== null && \(await isPlatformOperatorForAuthUser\(authUserId, email\)\)/],
  ["app/integrations/page.tsx", /const isOperator = await isPlatformOperatorForAuthUser\(user\?\.id, user\?\.email\);/],
  // Settings was split into sections by the OASIS OS shell: every section reads
  // one cached verified verdict (settings-viewer.ts -> isPlatformOperator()).
  ["components/settings/SettingsContent.tsx", /\n\s*isVerifiedOperator\(\),/],
  ["components/settings/settings-viewer.ts", /isVerifiedOperator = cache\(async \(\): Promise<boolean> => isPlatformOperator\(\)\)/],
];

async function staticChecks() {
  console.log("operator-check-migrated (static):");

  // Anti-vacuity: a walk or a detector that silently finds nothing would pass
  // and prove nothing.
  await check("the scan walked the whole tree", () => {
    assert.ok(sources.size > 1000, `only ${sources.size} files walked — the scan is broken`);
    for (const must of ["lib/bridge-proxy.ts", "lib/tenant-access.ts", "app/layout.tsx", "middleware.ts"]) {
      assert.ok(sources.has(must), `the walk never reached ${must}`);
    }
  });
  await check("the detector catches aliases and string keys, and ignores comments", () => {
    const n = (src: string) => codeReferences("x.ts", src, "isOperatorEmail");
    assert.equal(n(`import { isOperatorEmail as ok } from "@/lib/operator-credentials"; ok(e);`), 1);
    assert.equal(n(`const m = await import("@/lib/operator-credentials"); m["isOperatorEmail"](e);`), 1);
    assert.equal(n(`const { isOperatorEmail } = await import("./operator-credentials");`), 1);
    assert.equal(n(`// isOperatorEmail(e) used to live here\n/* isOperatorEmail */ const a = 1;`), 0);
    assert.equal(codeReferences("x.tsx", `export const X = () => <div>{isOperatorEmail(e) ? 1 : 0}</div>;`, "isOperatorEmail"), 1);
  });

  await check("no file outside the allowlist references isOperatorEmail", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      const hits = codeReferences(file, src, "isOperatorEmail");
      if (hits > 0 && !(file in ALLOWED)) offenders.push(`${file} (${hits})`);
    }
    assert.deepEqual(
      offenders,
      [],
      "these files decide on an email string alone again. Use isPlatformOperatorForAuthUser " +
        "(lib/platform-operator.ts) or isPlatformOperator (lib/role-surfaces-session.ts). A " +
        "purely display-only use may be added to ALLOWED with the reason it grants nothing",
    );
  });
  await check("every allowlisted file still references it (a stale entry is room for a regression)", () => {
    for (const [file, why] of Object.entries(ALLOWED)) {
      const src = sources.get(file);
      assert.ok(src, `${file} is allowlisted (${why}) but does not exist`);
      assert.ok(codeReferences(file, src, "isOperatorEmail") > 0, `${file} no longer references isOperatorEmail — delete its allowlist entry`);
    }
  });
  await check("lib/role-surfaces-session.ts delegates to the verified check rather than re-implementing it", () => {
    const src = sources.get("lib/role-surfaces-session.ts")!;
    assert.match(src, /return resolvePlatformOperatorForAuthUser\(user\.id, user\.email\);/);
    assert.equal(codeReferences("lib/role-surfaces-session.ts", src, "isOperatorEmail"), 0);
  });
  await check("each migrated call site uses the verified form", () => {
    const missing = MIGRATED.filter(([file, re]) => !re.test(sources.get(file) || "")).map(([file, re]) => `${file}: ${re}`);
    assert.deepEqual(missing, []);
  });
  await check("the platform key is reachable only behind the verified check", () => {
    const unguarded: string[] = [];
    for (const [file, src] of sources) {
      if (file === "lib/operator-credentials.ts") continue;
      if (codeReferences(file, src, "operatorPlatformFallback") === 0) continue;
      if (codeReferences(file, src, "isPlatformOperatorForAuthUser") === 0) unguarded.push(file);
    }
    assert.deepEqual(unguarded, [], "operatorPlatformFallback() must sit behind isPlatformOperatorForAuthUser");
  });
}

// ── 2. behavioural ─────────────────────────────────────────────────────

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ = "7c7c7c7c-0000-4000-8000-00000000007c";
const SQUAT_TENANT = "5a5a5a5a-0000-4000-8000-00000000005a";
const UNLINKED_TENANT = "5b5b5b5b-0000-4000-8000-00000000005b";
const SPOOF_TENANT = "5c5c5c5c-0000-4000-8000-00000000005c";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // hardcoded default alias; OASIS owner
  squatter: u(2, "squatter@alias.test"), // ADMIN_EMAILS; owns only its own new workspace
  unlinked: u(3, "unlinked@alias.test"), // ADMIN_EMAILS; an OASIS owner row carries this EMAIL, unlinked
  spoof: u(4, "spoof@client.test"), // NOT an alias — but wrote CC's alias into its own profile's email
  rep: u(5, "rep@sunbiz.test"), // SunBiz member, not an alias
} as const;

async function login(user: U | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const m = /^NEXT_REDIRECT;(.*)$/.exec((err as Error).message);
    if (m) return m[1];
    throw err;
  }
}

async function captureErrors<T>(run: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), logged };
  } finally {
    console.error = original;
  }
}

async function behaviouralChecks() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      brand TEXT, primary_agent TEXT, created_at TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_invites (id TEXT PRIMARY KEY, email TEXT, token_hash TEXT, created_at TEXT,
      redeemed_at TEXT, revoked_at TEXT, expires_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT,
      target_agent TEXT, severity TEXT, payload TEXT, published_at TEXT, created_at TEXT,
      status TEXT, correlation_id TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, system_prompt_override TEXT,
      display_name_override TEXT, enabled INTEGER DEFAULT 1);
  `);
  const stamp = "2026-09-01T00:00:00Z";
  const now = new Date().toISOString();
  const profile = (id: string, user: { id: string | null; email: string }, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, agents_enabled, brand, primary_agent, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, '["bravo"]', ?, 'bravo', ?, ?)`,
    args: [id, user.id, user.email, tenant, role, owner, stamp, tenant === OASIS ? "OASIS AI" : "Client", stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      {
        sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', ?)",
        args: [OASIS, JSON.stringify({ bridge_url: "https://bridge.oasis.test" })],
      },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'submissions', 'Sun Biz Funding', '{}')", args: [SUNBIZ] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'squatter-co', 'Squatter Co', '{}')", args: [SQUAT_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'unlinked-co', 'Unlinked Co', '{}')", args: [UNLINKED_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'spoof-co', 'Spoof Co', '{}')", args: [SPOOF_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'client-co', 'Client Co', '{}')", args: [CLIENT] },
      profile("p-cc", USERS.cc, OASIS, "owner", 1),
      // What signup + provision hands anyone who registers an alias: the owner
      // seat of a brand-new workspace of their own. Never a row in OASIS.
      profile("p-squatter", USERS.squatter, SQUAT_TENANT, "owner", 1),
      profile("p-unlinked", USERS.unlinked, UNLINKED_TENANT, "owner", 1),
      // A legacy OASIS owner row carrying the alias as its EMAIL, linked to no
      // auth user. An email-keyed check crowns whoever registers the alias.
      profile("p-legacy-unlinked", { id: null, email: USERS.unlinked.email }, OASIS, "owner", 1),
      // The profile email column is the owner's to edit. The old bridge check
      // read it in preference to the session email.
      profile("p-spoof", { id: USERS.spoof.id, email: USERS.cc.email }, SPOOF_TENANT, "owner", 1),
      profile("p-rep", USERS.rep, SUNBIZ, "member", 0),
      {
        sql: `INSERT INTO agent_events (id, event_type, publisher_agent, severity, payload, published_at, created_at, status, correlation_id)
              VALUES ('ev-oasis', 'lead_update', 'bravo', 'info', '{"note":"OASIS-ONLY-EVENT"}', ?, ?, 'delivered', ?)`,
        args: [now, now, OASIS],
      },
      {
        sql: `INSERT INTO agent_events (id, event_type, publisher_agent, severity, payload, published_at, created_at, status, correlation_id)
              VALUES ('ev-squat', 'lead_update', 'bravo', 'info', '{"note":"squatter-own-event"}', ?, ?, 'delivered', ?)`,
        args: [now, now, SQUAT_TENANT],
      },
    ],
    "write",
  );

  const { isOperatorEmail } = await import("../lib/operator-credentials");
  const operator = await import("../lib/platform-operator");
  const bridge = await import("../lib/bridge-proxy");
  const access = await import("../lib/tenant-access");
  const chatAuth = await import("../lib/chat-auth");
  const routing = await import("../lib/auth-routing");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const eventFeed = await import("../app/api/event-feed/route");
  const inboxPost = await import("../app/api/inbox/post/route");
  const cronRow = await import("../app/api/cron-jobs/[id]/route");
  const { NextRequest } = await import("next/server");

  console.log("operator-check-migrated (behavioural):");

  // Pin the premise: every refused session below PASSED the old rule. Without
  // this, "refused" could just mean the fixture never looked like an operator.
  await check("premise: each refused session was an operator under the email-only rule", () => {
    assert.equal(isOperatorEmail(USERS.squatter.email), true, "squatter");
    assert.equal(isOperatorEmail(USERS.unlinked.email), true, "unlinked");
    assert.equal(isOperatorEmail(USERS.cc.email), true, "spoof's PROFILE email (what the bridge read)");
    assert.equal(isOperatorEmail(USERS.spoof.email), false, "spoof's session email");
    assert.equal(isOperatorEmail(USERS.rep.email), false, "rep");
  });

  await check("the verified check: only CC is an operator", async () => {
    for (const [key, want] of [["cc", true], ["squatter", false], ["unlinked", false], ["spoof", false], ["rep", false]] as const) {
      assert.equal(await operator.isPlatformOperatorForAuthUser(USERS[key].id, USERS[key].email), want, key);
    }
    assert.equal(await operator.isPlatformOperatorForAuthUser(null, USERS.cc.email), false, "no auth id");
    // CC's alias with a stranger's auth id is not CC.
    assert.equal(await operator.isPlatformOperatorForAuthUser(USERS.squatter.id, USERS.cc.email), false, "borrowed alias");
  });

  // ── lib/bridge-proxy.ts authorizeBridgeRequest (shell / file tools) ──────
  for (const key of ["squatter", "unlinked", "spoof"] as const) {
    await check(`bridge: ${key} is refused at the tenant gate — no shell, no file tools`, async () => {
      await login(USERS[key]);
      assert.deepEqual(await bridge.authorizeBridgeRequest(), {
        ok: false,
        status: 403,
        error: "bridge_not_enabled_for_tenant",
      });
    });
  }
  await check("bridge: the operator still reaches his own bridge, flagged as operator", async () => {
    await login(USERS.cc);
    const auth = await bridge.authorizeBridgeRequest();
    assert.equal(auth.ok, true, JSON.stringify(auth));
    if (!auth.ok) return;
    assert.equal(auth.isOperator, true);
    assert.equal(auth.tenantSlug, "oasis-ai-cc");
    assert.equal(auth.target.baseUrl, "https://bridge.oasis.test");
  });
  await check("bridge: a SunBiz member still passes on the tenant, and is NOT the operator", async () => {
    await login(USERS.rep);
    const auth = await bridge.authorizeBridgeRequest();
    assert.equal(auth.ok, true, JSON.stringify(auth));
    if (!auth.ok) return;
    assert.equal(auth.isOperator, false);
    assert.equal(auth.tenantSlug, "submissions");
  });
  await check("bridge: signed out is a 401", async () => {
    await login(null);
    assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 401, error: "unauthenticated" });
  });

  // ── lib/tenant-access.ts (the /t/<slug> cross-tenant preview gate) ───────
  await check("preview: an email alone no longer opens another tenant (pure rule)", () => {
    const legacyShape = { email: USERS.cc.email, tenant_slug: "squatter-co" } as unknown as Parameters<typeof access.canPreviewTenantSlug>[0];
    assert.equal(access.canPreviewTenantSlug(legacyShape, "client-co"), false, "an email field grants nothing");
    assert.equal(access.canPreviewTenantSlug({ tenant_slug: "squatter-co" }, "client-co"), false, "missing verdict fails closed");
    assert.equal(access.canPreviewTenantSlug({ isPlatformOperator: false, tenant_slug: "squatter-co" }, "client-co"), false);
    assert.equal(access.canPreviewTenantSlug({ isPlatformOperator: false, tenant_slug: "squatter-co" }, "squatter-co"), true, "own slug");
    assert.equal(access.canPreviewTenantSlug({ isPlatformOperator: true }, "client-co"), true, "verified operator");
  });
  for (const key of ["squatter", "unlinked", "spoof"] as const) {
    await check(`preview: ${key} is bounced from another tenant's /t/<slug>`, async () => {
      await login(USERS[key]);
      const resolved = await access.resolveCallerTenantAccess();
      assert.equal(resolved?.isPlatformOperator, false);
      for (const slug of ["client-co", "submissions", "oasis-ai-cc"]) {
        assert.equal(await redirectOf(() => access.requireTenantPreviewAccess(slug)), "/", `${key} -> /t/${slug}`);
      }
    });
  }
  await check("preview: the squatter keeps its OWN workspace (no over-tightening)", async () => {
    await login(USERS.squatter);
    assert.equal(await redirectOf(() => access.requireTenantPreviewAccess("squatter-co")), null);
  });
  await check("preview: the operator still previews any tenant", async () => {
    await login(USERS.cc);
    assert.equal((await access.resolveCallerTenantAccess())?.isPlatformOperator, true);
    for (const slug of ["client-co", "submissions", "squatter-co"]) {
      assert.equal(await redirectOf(() => access.requireTenantPreviewAccess(slug)), null, slug);
    }
  });
  await check("preview: signed out goes to login", async () => {
    await login(null);
    assert.equal(await redirectOf(() => access.requireTenantPreviewAccess("client-co")), "/login?next=%2Ft%2Fclient-co");
  });

  // ── lib/chat-auth.ts (the platform API key — OASIS pays for it) ─────────
  await check("platform key: the squatter gets a 412, never the key", async () => {
    const r = await chatAuth.resolveChatContext(USERS.squatter, "bravo");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 412);
    assert.equal(r.code, "agent_not_configured", "not admin_no_platform_key: the squatter is not the admin");
    assert.ok(!JSON.stringify(r).includes(PLATFORM_KEY));
  });
  await check("platform key: the operator still falls back to it", async () => {
    const r = await chatAuth.resolveChatContext(USERS.cc, "bravo");
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.isOperator, true);
    assert.equal(r.apiKey, PLATFORM_KEY);
  });

  // ── app/api/event-feed (the empire-wide event tape) ──────────────────────
  const feed = async () => {
    const res = await eventFeed.GET(new NextRequest("http://localhost/api/event-feed?since_minutes=60"));
    assert.equal(res.status, 200);
    return ((await res.json()) as { rows: Array<{ id: string }> }).rows.map((r) => r.id).sort();
  };
  await check("event feed: the squatter reads only its own tenant", async () => {
    await login(USERS.squatter);
    assert.deepEqual(await feed(), ["ev-squat"]);
  });
  await check("event feed: the operator still reads every tenant", async () => {
    await login(USERS.cc);
    assert.deepEqual(await feed(), ["ev-oasis", "ev-squat"]);
  });

  // ── app/api/inbox/post (writes into the agents' inbox) ───────────────────
  await check("agent inbox: the squatter cannot post", async () => {
    await login(USERS.squatter);
    const res = await inboxPost.POST(
      new NextRequest("http://localhost/api/inbox/post", {
        method: "POST",
        body: JSON.stringify({ to: "bravo", subject: "x", body: "x" }),
      }),
    );
    assert.equal(res.status, 403);
  });

  // ── app/api/cron-jobs/[id] (the Empire scheduler lane) ───────────────────
  await check("empire cron: the squatter (an owner of its own tenant) cannot toggle an Empire job", async () => {
    await login(USERS.squatter);
    const res = await cronRow.PATCH(
      new NextRequest("http://localhost/api/cron-jobs/job-1", {
        method: "PATCH",
        body: JSON.stringify({ source: "empire", enabled: false }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "not_found_or_forbidden");
  });

  // ── lib/auth-routing.ts (post-login deep links into any tenant) ──────────
  const land = (user: U, next: string) =>
    routing.resolvePostLoginRedirect({ db: getServiceSupabase(), authUserId: user.id, email: user.email, requestedNext: next });
  await check("login routing: the squatter's deep link into another tenant is not honoured", async () => {
    assert.equal(await land(USERS.squatter, "/t/client-co/leads"), "/");
  });
  await check("login routing: the operator's deep link into another tenant still is", async () => {
    assert.equal(await land(USERS.cc, "/t/client-co/leads"), "/t/client-co/leads");
  });

  // ── fail closed ──────────────────────────────────────────────────────────
  await check("a failed membership lookup is NOT an operator, and closes the preview gate (loudly)", async () => {
    await login(USERS.cc);
    await db.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      const { value, logged } = await captureErrors(async () => ({
        verdict: await operator.resolvePlatformOperatorForAuthUser(USERS.cc.id, USERS.cc.email),
        preview: await redirectOf(() => access.requireTenantPreviewAccess("client-co")),
      }));
      assert.deepEqual(value.verdict, { operator: false, reason: "lookup_failed" });
      assert.equal(value.preview, "/", "an outage must not open another tenant");
      assert.ok(logged.some((l) => l.includes("[role-surfaces.platform_operator.membership]")), "the failure must be logged");
    } finally {
      await db.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
  });
}

async function main() {
  await staticChecks();
  await behaviouralChecks();
  if (failures > 0) {
    console.log(`operator-check-migrated: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("operator-check-migrated: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
