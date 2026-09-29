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
 *      /api/download/desktop sends everyone else back to /download.
 *   3. /install.ps1 and /install.sh are operator-only routes (404 for anyone
 *      else) serving the same text the public/ files did, and nothing under
 *      public/ serves them any more.
 *   4. /start, /configure and /demo/sun are 404s, off middleware's public list,
 *      and nothing public links to them.
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
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";
import { createClient } from "@libsql/client";

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

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // hardcoded default alias; OASIS owner
  squatter: u(2, "squatter@alias.test"), // alias email, owns only its own workspace
  client: u(3, "owner@client.test"), // not an alias; owner of a client workspace
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
    if (typeof node.type === "function") {
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
      profile(USERS.cc, OASIS, "owner"),
      profile(USERS.squatter, SQUAT_TENANT, "owner"),
      profile(USERS.client, CLIENT, "owner"),
    ],
    "write",
  );

  const gate = await import("../lib/role-surfaces-session");
  const { isPublic } = await import("../middleware");
  const { NextRequest } = await import("next/server");
  const health = await import("../app/api/health/route");
  const downloadPage = (await import("../app/download/page")).default;
  const downloadApi = await import("../app/api/download/desktop/route");
  const installPs1 = await import("../app/install.ps1/route");
  const installSh = await import("../app/install.sh/route");
  const { INSTALL_PS1, INSTALL_SH } = await import("../lib/install-scripts");
  const { SUPPORT_FORM_PATH } = await import("../lib/delivery/support-form");

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
      assert.ok(page.includes(SUPPORT_FORM_PATH), "the ask-for-access route is the support form");
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
  await check("the embedded scripts are the former public/ files, byte for byte in shape", () => {
    assert.ok(INSTALL_PS1.startsWith("# OASIS AI install - stable URL, repo-visibility-proof.\n"));
    assert.ok(INSTALL_PS1.endsWith("Invoke-Expression $script\n"));
    assert.ok(INSTALL_SH.startsWith("#!/usr/bin/env bash\n# OASIS AI install"));
    assert.ok(INSTALL_SH.endsWith('bash -c "$SCRIPT"\n'));
    // String.raw keeps this a backslash-n; a plain template would turn it into
    // a real newline and break the base64 decode in the served script.
    assert.ok(INSTALL_SH.includes("tr -d '\\n'"), "install.sh lost its literal \\n");
    assert.ok(!INSTALL_PS1.includes("\r") && !INSTALL_SH.includes("\r"), "LF line endings, as the committed files had");
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
  for (const viewer of ["anonymous", "client", "cc"] as const) {
    await check(`${viewer}: /start, /configure and /demo/sun are 404s`, async () => {
      await login(viewer);
      for (const [path, page] of Object.entries(retired)) assert.equal(await is404(page), true, path);
    });
  }
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
  await check("no page or component links to a retired route", () => {
    // JSX (href="/x", href={"/x"}) and data (cta: { href: "/x" }) forms both.
    const LINK = /href(?:=\{?|:\s*)["'`](\/start|\/configure|\/demo\/sun|\/api\/demo\/sun)(?=["'`?#])/;
    const hits: string[] = [];
    for (const dir of ["app", "components", "lib", "hooks"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        const m = src.match(LINK);
        if (m) hits.push(`${relative(ROOT, file).split(sep).join("/")} -> ${m[1]}`);
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
