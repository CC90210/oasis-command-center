/**
 * f0-containment.test.ts — OASIS OS plan F0.1: the public surfaces that leaked
 * or dead-ended once CC90210/CEO-Agent went private (2026-09-29).
 *
 * WHAT IS PINNED, each for a signed-out visitor, a client, an alias squatter
 * and the verified platform operator:
 *   1. /api/health answers everyone, but only the operator gets the
 *      per-secret presence map ("which integrations are down" is a probe list).
 *   2. /download shows everyone else a private-beta page with no release link
 *      (every link was a GitHub 404), and the operator the links plus a note.
 *      Its "Ask for access" goes to /contact (a lead) when signed out and to
 *      the support form when signed in. /api/download/desktop sends everyone
 *      else back to /download.
 *   3. /install.ps1 and /install.sh are operator-only routes (404 for anyone
 *      else) serving the same bytes the public/ files did (sha256-pinned), and
 *      nothing under public/ serves them any more. The bridge pairing page
 *      (/settings/devices/install) gives the operator the install wizard and
 *      every other signed-in viewer pair-only mode (for a computer that already
 *      has the bridge), with no install command and nothing of the harness; the
 *      harness repo name reaches no client page and no client bundle, and the
 *      client-deploy runbook says the client install is paused.
 *   3b. Every "Install bridge" call to action (onboarding's last step,
 *      Settings › AI, /sequences) is the operator's only, through
 *      BridgeInstallLink; a client sees a plain line or nothing. /automations,
 *      where viewer checks are not allowed, offers it only in OASIS's own
 *      workspace.
 *   3c. Every /playbook page 404s for anyone outside an OASIS workspace (by
 *      tenant id and slug), renders for OASIS members, and signed-out visitors
 *      are sent to /login by middleware.
 *   4. /start, /configure and /demo/sun: middleware sends a signed-out visitor
 *      to /login (they are off the public list, like any unknown path), and a
 *      signed-in viewer gets the 404. No string literal in app, components, lib,
 *      hooks or middleware names them any more, so nothing links or anchors a
 *      demo shell to them.
 *
 * Everything runs for real against a local libSQL file: the real signed session
 * cookie, the real Turso adapter, the real operator gate, the real route
 * handlers and page components. next/headers, next/navigation, next/link and
 * next/image are the only stand-ins (the same ones
 * tests/admin-surfaces-operator-only.test.ts uses).
 *
 * Run: node --conditions=react-server --import tsx tests/f0-containment.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";
import { createClient } from "@libsql/client";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "f0-containment-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "f0-containment-test-secret-long-enough-000000001";
// conaugh@oasisai.work is the hardcoded default operator alias; the squatter
// holds a configured alias but owns only a workspace of its own.
delete process.env.OPERATOR_EMAIL;
process.env.ADMIN_EMAILS = "squatter@alias.test";
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
// The health map reports presence only. Set one so the operator's map has a
// true in it, proving it reads the environment rather than printing a constant.
process.env.CRON_SECRET = "f0-cron-secret-value-never-printed";

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

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
// The real next/navigation loads the client router context, which does not
// exist under react-server. notFound throws exactly the digest Next's does.
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
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
stub("next/image", {
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) => ReactNS.createElement("img", { src, alt }),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SQUAT_TENANT = "5a5a5a5a-0000-4000-8000-00000000005a";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
// A workspace that claimed the slug "oasis" (on OASIS_SURFACE_TENANT_SLUGS, but
// no OASIS tenant row owns it). Its id is not OASIS's, so /playbook stays shut.
const SLUG_CLAIM_TENANT = "7c7c7c7c-0000-4000-8000-00000000007c";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // hardcoded default alias; OASIS owner
  squatter: u(2, "squatter@alias.test"), // alias email, owns only its own workspace
  client: u(3, "owner@client.test"), // not an alias; owner of a client workspace
  rep: u(4, "rep@oasis-team.test"), // an OASIS opener: a member, not an owner, not an operator
  claimer: u(5, "owner@slug-claim.test"), // owns the workspace that claimed the "oasis" slug
  newbie: u(6, "newbie@client.test"), // a client who has not finished onboarding yet
} as const;
type Viewer = keyof typeof USERS | "anonymous";
const NON_OPERATORS: Viewer[] = ["anonymous", "client", "squatter"];

async function login(viewer: Viewer): Promise<void> {
  if (viewer === "anonymous") {
    sessionCookie = undefined;
    return;
  }
  const user = USERS[viewer];
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
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function is404(run: () => unknown): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message)) return true;
    throw err;
  }
}

/**
 * Client components that use hooks. There is no React dispatcher under
 * react-server, so the walkers below never call one: they record its string
 * props (textOf) or the element itself (elementsOf) instead.
 */
const OPAQUE = new Set<unknown>();

/** Every string reachable in an element tree, href and other props included. */
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
    if (typeof node.type === "function" && !OPAQUE.has(node.type)) {
      const rendered = (node.type as (p: unknown) => unknown)(props);
      textOf(rendered, out, depth + 1);
      return out;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v, out, depth + 1);
      else if (typeof v === "string") out.push(v);
    }
    return out;
  }
  return out;
}

/** Every element of `type` in a tree, rendering the other function components on the way. */
function elementsOf(node: unknown, type: unknown, out: ReactNS.ReactElement[] = [], depth = 0): ReactNS.ReactElement[] {
  if (depth > 60 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n, type, out, depth + 1);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) {
    out.push(node);
    return out;
  }
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof node.type === "function" && !OPAQUE.has(node.type)) {
    return elementsOf((node.type as (p: unknown) => unknown)(props), type, out, depth + 1);
  }
  return elementsOf(props.children, type, out, depth + 1);
}

/**
 * Every string literal in a source file (template-literal chunks included),
 * read with the TypeScript scanner so comments are never mistaken for code.
 */
function stringLiterals(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, agents_enabled TEXT, updated_at TEXT,
      deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
  `);
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner,
            onboarding_completed_at, agents_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, '["bravo"]', ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'squatter-co', 'Squatter Co')", args: [SQUAT_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis', 'Slug Claimer')", args: [SLUG_CLAIM_TENANT] },
      profile(USERS.cc, OASIS, "owner"),
      profile(USERS.squatter, SQUAT_TENANT, "owner"),
      profile(USERS.client, CLIENT, "owner"),
      profile(USERS.claimer, SLUG_CLAIM_TENANT, "owner"),
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner,
                onboarding_completed_at, agents_enabled, updated_at)
              VALUES (?, ?, ?, ?, 'opener', 0, ?, '["bravo"]', ?)`,
        args: [`p-${USERS.rep.id}`, USERS.rep.id, USERS.rep.email, OASIS, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner,
                onboarding_completed_at, agents_enabled, updated_at)
              VALUES (?, ?, ?, ?, 'owner', 1, NULL, '["bravo"]', ?)`,
        args: [`p-${USERS.newbie.id}`, USERS.newbie.id, USERS.newbie.email, CLIENT, stamp],
      },
    ],
    "write",
  );

  const gate = await import("../lib/role-surfaces-session");
  const { isPublic, middleware } = await import("../middleware");
  const { NextRequest } = await import("next/server");
  const health = await import("../app/api/health/route");
  const downloadPage = (await import("../app/download/page")).default;
  const downloadApi = await import("../app/api/download/desktop/route");
  const installPs1 = await import("../app/install.ps1/route");
  const installSh = await import("../app/install.sh/route");
  const { INSTALL_PS1, INSTALL_SH, HARNESS_REPO } = await import("../lib/install-scripts");
  const { SUPPORT_FORM_PATH } = await import("../lib/delivery/support-form");
  const bridgeInstallPage = (await import("../app/settings/devices/install/page")).default;
  const { InstallBridgeWizard } = await import("../app/settings/devices/install/InstallBridgeWizard");
  const { PairBridgeOnly, PairOnlyView, clientPairCommand } = await import("../app/settings/devices/install/PairBridgeOnly");
  const { installOneLiner, operatorBridgeCommand } = await import("../lib/bridge-install-command");
  const { bridgePairCommand } = await import("../lib/bridge-install-guidance");
  const { BridgeInstallLink, BridgeStatusBanner, BRIDGE_INSTALL_PATH } = await import("../components/settings/BridgeInstallLink");
  const { OnboardingDoneChoices, OnboardingWizardClient } = await import("../components/onboarding/OnboardingWizardClient");
  const onboardingWizardPage = (await import("../app/onboarding/wizard/page")).default;
  const { NoProviderNotice } = await import("../components/settings/ProviderAccountsCard");
  const { BridgeToolAccess } = await import("../components/settings/AgentConfigEditor");
  const playbookAccess = await import("../lib/playbook-access");
  const clientDeployPage = (await import("../app/playbook/client-deploy/page")).default;
  const { demoHref } = await import("../lib/demo-href");
  OPAQUE.add(InstallBridgeWizard);
  OPAQUE.add(PairBridgeOnly);

  console.log("f0-containment:");

  // The premise every section below rests on: exactly one of these viewers is
  // a platform operator, and the squatter's alias email does not make it one.
  await check("premise: CC is the only operator among the viewers", async () => {
    for (const viewer of ["anonymous", "client", "squatter", "cc"] as const) {
      await login(viewer);
      assert.equal(await gate.isPlatformOperator(), viewer === "cc", viewer);
    }
  });

  // ── 1. /api/health ───────────────────────────────────────────────────
  const INTEGRATION_KEYS = [
    "BRAVO_ANTHROPIC_API_KEY",
    "BRAVO_OPENAI_API_KEY",
    "BRAVO_SUPABASE_URL",
    "BRAVO_SUPABASE_SERVICE_ROLE_KEY",
    "BRAVO_SUPABASE_ANON_KEY",
    "BRAVO_FIELD_ENCRYPTION_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OASIS_OUTBOUND_HMAC_SECRET",
    "CHAT_ATTACHMENT_HMAC_KEY",
    "CHAT_RESUME_HMAC_KEY",
    "CRON_SECRET",
  ];
  await check("middleware keeps /api/health public (monitors and the desktop wizard hold no session)", () => {
    assert.equal(isPublic("/api/health"), true);
  });
  for (const viewer of NON_OPERATORS) {
    await check(`${viewer}: /api/health is 200 with build info and no secret-presence map`, async () => {
      await login(viewer);
      const res = await health.GET();
      assert.equal(res.status, 200);
      assert.match(res.headers.get("cache-control") || "", /no-store/);
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.status, "ok");
      assert.equal(typeof body.version, "string", "the desktop wizard reads `version`");
      assert.equal("integrations" in body, false, "integrations must be omitted, not emptied");
      for (const key of INTEGRATION_KEYS) assert.ok(!text.includes(key), `${key} named to a ${viewer}`);
    });
  }
  await check("operator: /api/health carries the presence map, booleans only", async () => {
    await login("cc");
    const res = await health.GET();
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text) as { integrations?: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.integrations || {}).sort(), [...INTEGRATION_KEYS].sort());
    assert.ok(Object.values(body.integrations || {}).every((v) => typeof v === "boolean"));
    assert.equal(body.integrations?.CRON_SECRET, true);
    assert.ok(!text.includes(process.env.CRON_SECRET as string), "a secret VALUE must never appear");
  });
  await check("a failed operator lookup still answers 200, without the map, and is logged", async () => {
    await login("cc");
    await db.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const res = await health.GET();
      assert.equal(res.status, 200);
      assert.equal("integrations" in ((await res.json()) as object), false);
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
    assert.ok(logged.some((l) => l.includes("[role-surfaces.platform_operator")), "the lookup failure must be logged");
  });
  await check("HEAD /api/health stays a cheap 200", async () => {
    await login("anonymous");
    assert.equal((await health.HEAD()).status, 200);
  });

  // ── 2. /download and /api/download/desktop ───────────────────────────
  const renderDownload = async () => textOf(await downloadPage()).join("\n");
  for (const viewer of NON_OPERATORS) {
    await check(`${viewer}: /download is the private-beta page with no dead link`, async () => {
      await login(viewer);
      const page = await renderDownload();
      assert.match(page, /In private beta\./);
      // A prospect asking for the app belongs in the lead pipeline (/contact's
      // form creates a lead); the support form never creates one and starts a
      // client first-response clock, so it is for signed-in viewers only.
      if (viewer === "anonymous") {
        assert.ok(page.includes("/contact"), "a signed-out visitor asks through /contact");
        assert.ok(!page.includes(SUPPORT_FORM_PATH), "a signed-out visitor is not sent to the client support desk");
      } else {
        assert.ok(page.includes(SUPPORT_FORM_PATH), "a signed-in viewer asks through the support form");
        assert.ok(!page.includes("/contact"), "a signed-in viewer is not sent to the prospect form");
      }
      assert.ok(!/github\.com/i.test(page), "no GitHub URL for a non-operator");
      assert.ok(!page.includes("/api/download"), "no download redirect for a non-operator");
      assert.ok(!/CEO-Agent/.test(page), "the private repo is not named to a non-operator");
      assert.equal(page.includes("/login?next=%2Fdownload"), viewer === "anonymous", "Sign in is offered only when signed out");
    });
  }
  await check("operator: /download keeps every release link, plus the GitHub-access note", async () => {
    await login("cc");
    const page = await renderDownload();
    assert.ok(!page.includes("In private beta."));
    for (const href of [
      "/api/download/desktop",
      "/api/download/desktop?platform=mac",
      "/api/download/desktop?platform=windows-installer",
      "/api/download/desktop?platform=linux",
      "https://github.com/CC90210/CEO-Agent/releases/tag/oasis-desktop-v0.1.0-alpha.6",
    ]) {
      assert.ok(page.includes(href), `missing ${href}`);
    }
    assert.match(page, /Operator only: alpha\.4 to alpha\.6 download from the private CC90210\/CEO-Agent\s+repository, so your browser needs a GitHub session with access to it\./);
    assert.match(page, /operator only/);
  });
  const downloadGet = (platform: string) =>
    downloadApi.GET(new NextRequest(`https://oasisai.work/api/download/desktop?platform=${platform}`));
  for (const viewer of NON_OPERATORS) {
    await check(`${viewer}: /api/download/desktop sends them back to /download, never to GitHub`, async () => {
      await login(viewer);
      const res = await downloadGet("mac");
      assert.equal(res.status, 307);
      assert.equal(res.headers.get("location"), "https://oasisai.work/download");
    });
  }
  await check("operator: /api/download/desktop still redirects to the release asset", async () => {
    await login("cc");
    const res = await downloadGet("mac");
    assert.equal(res.status, 307);
    assert.match(res.headers.get("location") || "", /^https:\/\/github\.com\/CC90210\/CEO-Agent\/releases\/download\/.+\.dmg$/);
  });

  // ── 3. install scripts ───────────────────────────────────────────────
  const scripts = [
    { path: "/install.ps1", route: installPs1, text: INSTALL_PS1 },
    { path: "/install.sh", route: installSh, text: INSTALL_SH },
  ];
  await check("nothing under public/ serves an install script any more", () => {
    for (const f of ["public/install.ps1", "public/install.sh"]) assert.equal(existsSync(join(ROOT, f)), false, f);
  });
  await check("middleware lets the two script paths reach their own gate, and no other *.sh / *.ps1", () => {
    assert.equal(isPublic("/install.ps1"), true);
    assert.equal(isPublic("/install.sh"), true);
    for (const p of ["/deploy.sh", "/scripts/setup.ps1", "/install.sh.bak", "/pipeline/run.sh"]) {
      assert.equal(isPublic(p), false, `${p} must not be public by extension`);
    }
  });
  for (const viewer of NON_OPERATORS) {
    await check(`${viewer}: both install scripts are a plain 404 that names nothing`, async () => {
      await login(viewer);
      for (const s of scripts) {
        const res = await s.route.GET();
        assert.equal(res.status, 404, s.path);
        assert.match(res.headers.get("cache-control") || "", /no-store/);
        const text = await res.text();
        assert.ok(!text.includes("CEO-Agent") && !text.includes("OASIS"), `${s.path} leaked script text`);
      }
    });
  }
  await check("operator: both scripts are served verbatim as text/plain, no-store", async () => {
    await login("cc");
    for (const s of scripts) {
      const res = await s.route.GET();
      assert.equal(res.status, 200, s.path);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.match(res.headers.get("cache-control") || "", /no-store/);
      assert.equal(await res.text(), s.text);
    }
  });
  await check("the embedded scripts are the former public/ files, byte for byte", () => {
    // sha256 of origin/main:public/install.ps1 and public/install.sh as they
    // stood when they were deleted (2026-09-29). Any edit to either script has
    // to change this line too, so it cannot happen by accident.
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    assert.equal(sha(INSTALL_PS1), "aff59e7d0ddc7a39b2910ce3eb14d4dc0d0ac6b276dc9ed5d42dced4a0574b83", "install.ps1 drifted");
    assert.equal(sha(INSTALL_SH), "451d0f14356d77eb34dea999e16933a827d79607e0207750405b43971a4b7aba", "install.sh drifted");
    // The usual way it drifts, named so the failure says which: String.raw keeps
    // this a backslash-n, and a plain template would make it a real newline and
    // break the base64 decode. Line endings need no check of their own: a
    // template literal turns every CRLF in the source into LF, String.raw
    // included, so a CRLF checkout of lib/install-scripts.ts still serves LF.
    // The sha256 pins above are the guard.
    assert.ok(INSTALL_SH.includes("tr -d '\\n'"), "install.sh lost its literal \\n");
  });
  await check("HARNESS_REPO is the repo both scripts clone", () => {
    assert.ok(INSTALL_PS1.includes(`$Repo = '${HARNESS_REPO}'`));
    assert.ok(INSTALL_SH.includes(`REPO="${HARNESS_REPO}"`));
  });

  // The bridge pairing wizard. Its full-install command pulls the same repo,
  // so it follows the same rule as the scripts: operator only.
  const renderBridgeInstall = async () => textOf(await bridgeInstallPage()).join("\n");
  await check("anonymous: /settings/devices/install sends them to sign in", async () => {
    await login("anonymous");
    await assert.rejects(bridgeInstallPage(), /NEXT_REDIRECT;\/login\?next=\/settings\/devices\/install/);
  });
  // Everyone else who is signed in gets pair-only mode: a code and the
  // self-contained command that links a computer which already has the bridge.
  // It clones nothing, so nothing of the harness may reach their screen.
  const HARNESS_LEAKS = [
    "CEO-Agent", "CC90210", "raw.githubusercontent", "gh api", "gh auth", "install.ps1", "install.sh",
    "git clone", "BRAVO", "Bravo", "/download", "/settings#devices",
  ];
  const PAIR_CODE = "ABC-DEF-GHJ";
  const OSES = ["windows", "macos", "linux"] as const;
  for (const viewer of ["client", "squatter"] as const) {
    await check(`${viewer}: /settings/devices/install is pair-only mode plus the private-beta notice, with no install command and no repo`, async () => {
      await login(viewer);
      const tree = await bridgeInstallPage();
      assert.deepEqual(elementsOf(tree, InstallBridgeWizard), [], "the install wizard must not mount for a non-operator");
      const pairOnly = elementsOf(tree, PairBridgeOnly);
      assert.equal(pairOnly.length, 1, "pair-only mode mounts for a signed-in non-operator");
      assert.deepEqual(Object.keys((pairOnly[0].props ?? {}) as object), [], "pair-only mode is handed no repository");
      const page = textOf(tree).join("\n");
      assert.match(page, /Pair the local bridge/);
      assert.match(page, /The local bridge is in private beta/);
      assert.ok(page.includes(SUPPORT_FORM_PATH), "Ask for access (a new install) goes to the support form");
      for (const leak of HARNESS_LEAKS) assert.ok(!page.includes(leak), `${leak} shown to a ${viewer}`);
    });
  }
  await check("pair-only mode, in every phase and on every OS, shows the redeem command and nothing of the harness", () => {
    for (const os of OSES) {
      const command = clientPairCommand(os, PAIR_CODE);
      assert.ok(command.includes(PAIR_CODE) && command.includes("/api/auth/pair-code/redeem"), `${os}: ${command}`);
      assert.ok(command.includes("OASIS_PAIR_CODE"), `${os}: the client's variable name is neutral`);
      for (const phase of ["mint", "command", "watching", "connected"] as const) {
        for (const error of [null, "mint_failed"]) {
          const view = PairOnlyView({
            os, onOs: () => undefined, code: PAIR_CODE, command, secondsLeft: 600, phase, error,
            onRetry: () => undefined, copied: false, onCopy: () => undefined,
          });
          const text = textOf(view).join("\n");
          if (phase === "command" || phase === "watching") assert.ok(text.includes(command), `${os}/${phase}: the command is shown`);
          for (const leak of HARNESS_LEAKS) assert.ok(!text.includes(leak), `${os}/${phase}: ${leak} in pair-only mode`);
        }
      }
    }
  });
  await check("pair-only mode loads no module that carries the install command or the operator's names", () => {
    // PairBridgeOnly, the hook and the command helpers it imports are what a
    // client's browser loads for this page. The full install lives in
    // lib/bridge-install-command.ts, imported by the two operator surfaces only.
    const clientModules = [
      "app/settings/devices/install/PairBridgeOnly.tsx",
      "hooks/useBridgePairing.ts",
      "lib/bridge-install-guidance.ts",
    ];
    for (const rel of clientModules) {
      for (const lit of stringLiterals(readFileSync(join(ROOT, rel), "utf8"), rel)) {
        assert.ok(!/bridge-install-command|InstallBridgeWizard|install-scripts/.test(lit), `${rel} imports ${lit}`);
        for (const leak of ["CEO-Agent", "CC90210", "raw.githubusercontent", "gh api", "install.ps1", "install.sh", "git clone", "BRAVO"]) {
          assert.ok(!lit.includes(leak), `${rel} carries "${leak}" in ${lit.slice(0, 60)}`);
        }
      }
    }
  });
  await check("operator: /settings/devices/install mounts the full install wizard with the repo passed in", async () => {
    await login("cc");
    const tree = await bridgeInstallPage();
    const wizards = elementsOf(tree, InstallBridgeWizard);
    assert.equal(wizards.length, 1);
    assert.equal((wizards[0].props as { installRepo?: unknown }).installRepo, HARNESS_REPO);
    assert.deepEqual(elementsOf(tree, PairBridgeOnly), [], "the operator gets the full wizard, which has its own pair-only mode");
    assert.ok(!(await renderBridgeInstall()).includes("in private beta"));
  });
  await check("the operator's full-install command reads the private repo through gh, not an anonymous raw URL", () => {
    for (const os of OSES) {
      const cmd = operatorBridgeCommand(os, PAIR_CODE, "install", HARNESS_REPO);
      assert.equal(cmd, installOneLiner(os, PAIR_CODE, HARNESS_REPO));
      const file = os === "windows" ? "install.ps1" : "install.sh";
      assert.ok(cmd.includes(`gh api`) && cmd.includes(`repos/${HARNESS_REPO}/contents/${file}`), `${os}: ${cmd}`);
      assert.ok(cmd.includes("BRAVO_PAIR_CODE") && cmd.includes(PAIR_CODE), `${os} lost the pair code`);
      assert.ok(!cmd.includes("raw.githubusercontent"), `${os}: an anonymous raw URL is a 404 on a private repo`);
      // The operator's own pair-only mode keeps the variable names its machines read.
      const pair = operatorBridgeCommand(os, PAIR_CODE, "pair", HARNESS_REPO);
      assert.equal(pair, bridgePairCommand(os, PAIR_CODE, "BRAVO"));
      assert.ok(pair.includes("BRAVO_PAIR_CODE") && !pair.includes("gh api") && !pair.includes(HARNESS_REPO));
    }
  });
  await check("the operator wizard says what the clone needs: gh signed in with git credentials", () => {
    for (const rel of ["app/settings/devices/install/InstallBridgeWizard.tsx", "components/settings/InstallBridgeModal.tsx"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      assert.ok(src.includes("`gh auth login` choosing HTTPS") && src.includes("`gh auth setup-git`"), `${rel}: the git-credential step is missing`);
      assert.ok(!src.includes("(gh) signed in with access to it"), `${rel}: still says a gh session is enough`);
    }
  });
  await check("no client-bundled module carries the harness repo name", () => {
    // A "use client" module ships to every browser that loads it, whatever the
    // page renders, so the repo name may only live server-side (HARNESS_REPO)
    // and travel as a prop to a verified operator.
    const hits: string[] = [];
    for (const dir of ["app", "components", "lib", "hooks"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        if (!/^\s*["']use client["']/.test(src)) continue;
        for (const lit of stringLiterals(src, file)) {
          if (/CEO-Agent|raw\.githubusercontent\.com\/CC90210/.test(lit)) hits.push(`${relative(ROOT, file).split(sep).join("/")}: ${lit.slice(0, 80)}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });
  await check("the client-deploy runbook pauses the client install instead of routing around it", async () => {
    await login("cc");
    const page = textOf(await clientDeployPage()).join("\n");
    assert.match(page, /Paused: installing on a client's machine/);
    assert.match(page, /do not grant a client's machine access to the harness repository/);
    assert.ok(!/send them the file|needs GitHub access/i.test(page), "the runbook still tells the operator to ship the script");
  });

  // ── 3b. install calls to action are the operator's only ────────────────
  // /settings/devices/install installs for the operator alone; for anyone else
  // an "Install bridge" button is a dead end. Every such button goes through
  // BridgeInstallLink, which renders nothing unless handed the verified verdict.
  const hasInstallLink = (node: unknown) => textOf(node).includes(BRIDGE_INSTALL_PATH);
  await check("BridgeInstallLink renders the install link for the operator and nothing for anyone else", () => {
    assert.ok(hasInstallLink(BridgeInstallLink({ canInstallBridge: true, children: "Install bridge" })));
    assert.equal(BridgeInstallLink({ canInstallBridge: false, children: "Install bridge" }), null);
    // Only a real `true` opens it: a truthy non-boolean is not a verdict.
    assert.equal(BridgeInstallLink({ canInstallBridge: "yes" as unknown as boolean, children: "x" }), null);
  });
  await check("onboarding's last step: the operator gets the recommended pair card, a client the dashboard card alone", () => {
    const client = OnboardingDoneChoices({ canInstallBridge: false, dashboardHref: "/t/client-co" });
    const clientText = textOf(client).join("\n");
    assert.ok(!hasInstallLink(client), "a client is not sent to the install route");
    for (const gone of ["Pair a machine", "Recommended", "Settings → Devices", "Two ways"]) {
      assert.ok(!clientText.includes(gone), `a client still sees "${gone}"`);
    }
    assert.ok(clientText.includes("/t/client-co") && clientText.includes("Open dashboard now"));
    const grids = elementsOf(client, "div").filter((d) => /\bgrid\b/.test(String((d.props as { className?: string }).className)));
    assert.equal(grids.length, 1);
    assert.ok(!String((grids[0].props as { className?: string }).className).includes("grid-cols-2"), "no empty second column for a client");
    const operator = OnboardingDoneChoices({ canInstallBridge: true, dashboardHref: "/" });
    const operatorText = textOf(operator).join("\n");
    assert.ok(hasInstallLink(operator) && operatorText.includes("Recommended") && operatorText.includes("Pair a machine"));
  });
  await check("the onboarding wizard page hands the client's wizard canInstallBridge=false and the operator's true", async () => {
    await login("newbie");
    const clientEl = (await onboardingWizardPage()) as ReactNS.ReactElement;
    assert.ok(isValidElement(clientEl) && clientEl.type === OnboardingWizardClient, "the wizard renders for a client mid-onboarding");
    assert.equal((clientEl.props as { canInstallBridge?: unknown }).canInstallBridge, false);
    // The operator is onboarded, so the page would redirect; clear it for the
    // one call and put it back.
    await db.execute({ sql: "UPDATE user_profiles SET onboarding_completed_at = NULL WHERE auth_user_id = ?", args: [USERS.cc.id] });
    try {
      await login("cc");
      const opEl = (await onboardingWizardPage()) as ReactNS.ReactElement;
      assert.equal((opEl.props as { canInstallBridge?: unknown }).canInstallBridge, true);
    } finally {
      await db.execute({ sql: "UPDATE user_profiles SET onboarding_completed_at = ? WHERE auth_user_id = ?", args: [stamp, USERS.cc.id] });
    }
  });
  await check("Settings › AI: the no-provider notice and an agent's offline strip offer the bridge to the operator only", () => {
    const clientNotice = NoProviderNotice({ canInstallBridge: false });
    assert.ok(!hasInstallLink(clientNotice) && textOf(clientNotice).join(" ").includes("connect a cloud provider above"));
    assert.ok(!/local bridge/i.test(textOf(clientNotice).join(" ")), "a client is not told to install the bridge");
    assert.ok(hasInstallLink(NoProviderNotice({ canInstallBridge: true })));
    const clientStrip = BridgeToolAccess({ bridgeOnline: false, canInstallBridge: false });
    const clientStripText = textOf(clientStrip).join(" ");
    assert.ok(!hasInstallLink(clientStrip) && !/Install\s+the\s+bridge/i.test(clientStripText) && clientStripText.includes("cloud mode"));
    assert.ok(hasInstallLink(BridgeToolAccess({ bridgeOnline: false, canInstallBridge: true })));
    assert.ok(!hasInstallLink(BridgeToolAccess({ bridgeOnline: true, canInstallBridge: true })), "no install link once the bridge is online");
    // Both cards get the verdict from SettingsContent's verified operator check.
    const settings = readFileSync(join(ROOT, "components", "settings", "SettingsContent.tsx"), "utf8");
    assert.equal(settings.match(/canInstallBridge=\{isOperator\}/g)?.length, 2, "ProviderAccountsCard and AgentConfigEditor both get isOperator");
    assert.match(settings, /show\("ai"\) && isOperator && \(\s*<SafeBoundary label="Local CLI providers">\s*<LocalCliProvidersCard/, "the CLI card (which links the install) stays operator-only");
  });
  await check("/sequences: the offline banner offers Install bridge to the operator only", () => {
    const props = {
      bridgeOnline: false, online: "on", offline: "Jobs are paused.",
      operatorHint: "Click Install bridge to restore them.", clientHint: "OASIS pairs it with each workspace directly.",
    };
    const client = BridgeStatusBanner({ ...props, canInstallBridge: false });
    const clientText = textOf(client).join(" ");
    assert.ok(!hasInstallLink(client) && !clientText.includes("Install bridge"), "a client gets no install button or hint");
    assert.ok(clientText.includes("Jobs are paused.") && clientText.includes("OASIS pairs it"), "a client gets the plain line");
    const operator = BridgeStatusBanner({ ...props, canInstallBridge: true });
    assert.ok(hasInstallLink(operator) && textOf(operator).join(" ").includes("Click Install bridge"));
    assert.ok(!hasInstallLink(BridgeStatusBanner({ ...props, bridgeOnline: true, canInstallBridge: true })), "no button once online");
    // The page hands the banner the verified operator verdict. It mounts client
    // components that cannot load in this process, so the wiring is read from
    // source.
    const src = readFileSync(join(ROOT, "app", "sequences", "page.tsx"), "utf8");
    assert.match(src, /const isOperator = await isPlatformOperator\(\);/, "/sequences: the verdict");
    assert.match(src, /<BridgeStatusBanner\s+bridgeOnline=\{bridgeOnline\}\s+canInstallBridge=\{isOperator\}/, "/sequences: the banner gets it");
  });
  await check("no client-reachable file links the install route except through BridgeInstallLink", () => {
    const INSTALL_ROUTE = /^\/settings\/devices\/install(?:[?#]|$)/;
    // Files that may name the route. Each says why.
    const ALLOWED = new Map([
      ["components/settings/BridgeInstallLink.tsx", "the gate itself"],
      ["components/settings/SettingsContent.tsx", "inside the Settings › Devices section, which is show(\"devices\") && isOperator (os-connectors test)"],
      ["components/settings/LocalCliProvidersCard.tsx", "mounted only under show(\"ai\") && isOperator (asserted above)"],
      ["lib/setup-readiness.ts", "readiness data with no caller in app/ or components/"],
      // A client founder reaches /automations (requireSystemSurface admits any
      // founder). tests/client-surface-isolation.test.ts keeps viewer checks out
      // of this component, so the link is gated on the WORKSPACE: OASIS's own
      // (isOasisSurfaceTenant) only. Asserted in the next check.
      ["components/automations/AutomationsContent.tsx", "shown only in OASIS's own workspace (next check)"],
    ]);
    const hits: string[] = [];
    for (const dir of ["app", "components", "lib", "hooks"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (ALLOWED.has(rel)) continue;
        for (const lit of stringLiterals(readFileSync(file, "utf8"), file)) if (INSTALL_ROUTE.test(lit)) hits.push(`${rel}: ${lit}`);
      }
    }
    assert.deepEqual(hits, []);
  });
  await check("/automations offers Install bridge only in OASIS's own workspace; a client workspace gets a plain line", () => {
    // The component mounts client panels that cannot load in this process, so
    // the gate is read from source: the verdict, the button and the hint all use it.
    const src = readFileSync(join(ROOT, "components", "automations", "AutomationsContent.tsx"), "utf8");
    assert.match(src, /const canInstallBridge = isOasisSurfaceTenant\(tenantSlug\);/, "the verdict is the workspace, not the viewer");
    // `=== false`, not `!`: a heartbeat that could not be read (null, F1.5) is
    // "Couldn't check", never an offer to install.
    assert.match(src, /\{bridgeOnline === false && canInstallBridge && \(\s*<Link\s+href="\/settings\/devices\/install"/, "the button needs the verdict");
    assert.match(src, /\{canInstallBridge \? \([\s\S]*?Install bridge[\s\S]*?\) : \(\s*"OASIS pairs a machine with your workspace directly\."/, "the hint needs it too");
    assert.equal((src.match(/Install bridge/g) || []).length, 2, "no other Install bridge text in the component");
  });

  // ── 3c. /playbook is OASIS's own material ──────────────────────────────
  // The nav hides Playbook outside OASIS; every page now enforces it. The page
  // list is read from disk, so a new page without the guard fails here.
  const playbookPages = sourceFiles(join(ROOT, "app", "playbook")).filter((f) => /[\\/]page\.tsx$/.test(f));
  const playbookSlug = readdirSync(join(ROOT, "content", "playbooks")).find((n) => n.endsWith(".md") && n !== "INDEX.md")!.replace(/\.md$/, "");
  const renderPlaybookPage = async (file: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS test harness, absolute Windows path
    const page = (require(file) as { default: (props: unknown) => unknown }).default;
    return page(file.includes("[slug]") ? { params: Promise.resolve({ slug: playbookSlug }) } : {});
  };
  const playbookName = (file: string) => relative(join(ROOT, "app"), file).split(sep).join("/");
  await check("every /playbook route is covered (index, [slug], prompts, client-deploy, onboarding, script and the rest)", () => {
    const names = playbookPages.map(playbookName).sort();
    for (const want of ["playbook/page.tsx", "playbook/[slug]/page.tsx", "playbook/prompts/page.tsx", "playbook/client-deploy/page.tsx", "playbook/onboarding/page.tsx", "playbook/script/page.tsx"]) {
      assert.ok(names.includes(want), `${want} not found`);
    }
    assert.ok(names.length >= 11, names.join(", "));
  });
  for (const viewer of ["client", "squatter", "claimer"] as const) {
    await check(`${viewer} (another workspace): every /playbook page is a 404`, async () => {
      await login(viewer);
      for (const file of playbookPages) assert.equal(await is404(() => renderPlaybookPage(file)), true, playbookName(file));
    });
  }
  for (const viewer of ["cc", "rep"] as const) {
    await check(`${viewer} (OASIS member): every /playbook page renders`, async () => {
      await login(viewer);
      for (const file of playbookPages) {
        const out = await renderPlaybookPage(file);
        assert.ok(isValidElement(out), `${playbookName(file)} did not render for ${viewer}`);
      }
    });
  }
  await check("anonymous: middleware sends /playbook routes to /login, as before", async () => {
    await login("anonymous");
    for (const path of ["/playbook", "/playbook/client-deploy", "/playbook/prompts", "/playbook/script", `/playbook/${playbookSlug}`]) {
      const res = await middleware(new NextRequest(`https://oasisai.work${path}`));
      assert.equal(res.status, 307, path);
      assert.equal(new URL(res.headers.get("location") || "").pathname, "/login", path);
    }
  });
  await check("the /playbook rule needs OASIS's tenant id AND an OASIS slug, and a failed lookup is a no", async () => {
    assert.equal(playbookAccess.isOasisPlaybookWorkspace({ tenantId: OASIS, tenantSlug: "oasis-ai-cc" }), true);
    assert.equal(playbookAccess.isOasisPlaybookWorkspace({ tenantId: SLUG_CLAIM_TENANT, tenantSlug: "oasis" }), false);
    assert.equal(playbookAccess.isOasisPlaybookWorkspace({ tenantId: OASIS, tenantSlug: "client-co" }), false);
    assert.equal(playbookAccess.isOasisPlaybookWorkspace({ tenantId: null, tenantSlug: null }), false);
    await login("cc");
    await db.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await playbookAccess.mayReadPlaybook(), false);
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
    assert.equal(await playbookAccess.mayReadPlaybook(), true, "restored");
  });
  await check("no /api route serves playbook or prompt-library content", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(join(ROOT, "app", "api"))) {
      for (const lit of stringLiterals(readFileSync(file, "utf8"), file)) {
        if (/lib\/playbooks|lib\/prompts-library|content\/playbooks|docs\/playbooks|^playbooks$/.test(lit)) hits.push(`${relative(ROOT, file)}: ${lit}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  // ── 4. retired routes ────────────────────────────────────────────────
  const retired = {
    "/start": (await import("../app/start/page")).default,
    "/configure": (await import("../app/configure/page")).default,
    "/demo/sun": (await import("../app/demo/sun/page")).default,
  } as Record<string, () => unknown>;
  await check("middleware no longer lists /start, /configure, /demo/sun or /api/demo/sun as public", () => {
    for (const p of ["/start", "/configure", "/demo/sun", "/api/demo/sun"]) assert.equal(isPublic(p), false, p);
  });
  // Through the real middleware, then the page. Off the public list, a retired
  // path behaves like any unknown one: a signed-out visitor is sent to sign in
  // (never shown a page), and a signed-in viewer gets the 404.
  const throughMiddleware = (path: string) => {
    const req = new NextRequest(`https://oasisai.work${path}`);
    if (sessionCookie) req.cookies.set(SESSION_COOKIE_NAME, sessionCookie);
    return middleware(req);
  };
  await check("anonymous: middleware sends /start, /configure and /demo/sun to /login", async () => {
    await login("anonymous");
    for (const path of Object.keys(retired)) {
      const res = await throughMiddleware(path);
      assert.equal(res.status, 307, path);
      const location = new URL(res.headers.get("location") || "");
      assert.equal(location.pathname, "/login", path);
      assert.equal(location.searchParams.get("next"), path);
    }
  });
  for (const viewer of ["client", "squatter", "cc"] as const) {
    await check(`${viewer} (signed in): middleware lets /start, /configure and /demo/sun through, and each is a 404`, async () => {
      await login(viewer);
      for (const [path, page] of Object.entries(retired)) {
        const res = await throughMiddleware(path);
        assert.equal(res.headers.get("x-middleware-next"), "1", `${path} did not reach the page`);
        assert.equal(await is404(page), true, path);
      }
    });
  }
  await check("a demo shell anchors its links to \"/\", not to the retired /demo/sun", () => {
    assert.equal(demoHref("/leads", { demoMode: true }), "/");
    assert.equal(demoHref("/leads", { demoMode: false }), "/leads");
  });
  await check("/api/demo/sun is deleted", () => {
    assert.equal(existsSync(join(ROOT, "app", "api", "demo", "sun", "route.ts")), false);
  });
  await check("the marketing registry, sitemap and legacy redirects no longer point at /start", async () => {
    const { MARKETING_PATHS, ALL_MARKETING_PATHS } = await import("../lib/marketing/routes");
    assert.ok(!(MARKETING_PATHS as readonly string[]).includes("/start"));
    assert.ok(!ALL_MARKETING_PATHS.includes("/start"));
    const sitemap = (await import("../app/sitemap")).default();
    for (const entry of sitemap) assert.ok(!/\/(start|configure|demo\/sun)$/.test(entry.url), entry.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- next.config.js is CommonJS by convention (see its header)
    const nextConfig = require("../next.config.js") as { redirects: () => Promise<Array<{ source: string; destination: string }>> };
    for (const r of await nextConfig.redirects()) {
      assert.ok(!["/start", "/configure", "/demo/sun"].includes(r.destination), `${r.source} redirects to a 404`);
    }
  });
  await check("no string literal in app, components, lib, hooks or middleware names a retired route", () => {
    // Every literal, not just href forms: a default prop (Sidebar's demo
    // landing), a fallback (demoHref) or a path test (the root layout forcing
    // the SunBiz demo shell in on /demo/sun) is how a retired route stays
    // reachable. Comments are not literals, so history can still be told.
    const RETIRED = /^(\/start|\/configure|\/demo\/sun|\/api\/demo\/sun)(?:[/?#]|$)/;
    // Literals that are not routes. Each one says why.
    const NOT_A_ROUTE = new Set([
      "components/settings/TelegramConnectCard.tsx: /start", // Telegram's bot command, sent in the chat app
    ]);
    const files = ["app", "components", "lib", "hooks"].flatMap((dir) => sourceFiles(join(ROOT, dir)));
    files.push(join(ROOT, "middleware.ts"));
    const hits: string[] = [];
    for (const file of files) {
      for (const lit of stringLiterals(readFileSync(file, "utf8"), file)) {
        const m = lit.match(RETIRED);
        if (!m) continue;
        const hit = `${relative(ROOT, file).split(sep).join("/")}: ${m[1]}`;
        if (!NOT_A_ROUTE.has(hit)) hits.push(hit);
      }
    }
    assert.deepEqual(hits, []);
    const footer = readFileSync(join(ROOT, "components", "marketing", "MarketingFooter.tsx"), "utf8");
    assert.ok(!/["']\/start["']/.test(footer), "the footer still lists /start");
  });

  if (failures > 0) {
    console.log(`f0-containment: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("f0-containment: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
