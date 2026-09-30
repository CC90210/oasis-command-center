/**
 * playbook-docs.test.ts - the Playbook documents hub and the Worker-safe
 * Playbook (OASIS OS S2 T2, 2026-09-30).
 *
 * WHAT IS PINNED
 *   1. Content modules: lib/playbooks.generated.ts and lib/prompts/generated.ts
 *      equal what scripts/gen-content-modules.mjs makes from the sources, are
 *      ASCII-only, and lib/playbooks.ts / lib/prompts/index.ts / the
 *      onboarding page import no fs (the Worker has none). The fs guard's
 *      BASELINE no longer lists them.
 *   2. No "/agents?agent=" or "/agents?prompt=" link remains anywhere; asks go
 *      to /team/<dept>?ask= (lib/os/chat-href.ts), and the department composer
 *      reads it once, prefills, never sends, and cleans the URL.
 *   3. Every app/playbook page, and every business document the founder can
 *      open, renders for an OASIS founder with the filesystem made to throw.
 *   4. Visibility: a sales rep never lists a founders document, and gets 404 on
 *      its page, its API read and its download; another workspace gets 404 on
 *      everything.
 *   5. Draft it -> Mark current: refused with one sentence while a
 *      "[[CC to confirm" placeholder remains, succeeds without them, writes
 *      approved_by/at and a version row; versions and the incident register
 *      are append-only in the database itself.
 *   6. The import refuses planted secrets, forces the OASIS tenant, is a no-op
 *      on the same hash, never overwrites an in-app text, and fails closed
 *      without its bearer.
 *   7. Live documents render the live copy (the privacy policy's own text),
 *      statuses are derived, and every stored document has a template whose
 *      unknowns are placeholders.
 *
 * Everything runs against a real local libSQL file with bravo__194 applied
 * through the same BEGIN/END-aware split scripts/apply_turso_migration.py uses,
 * the real signed session cookie, the real pages and the real route handlers.
 * next/headers, next/navigation, next/link and next/image are the only
 * stand-ins (the same ones tests/f0-containment.test.ts uses).
 *
 * Run: node --conditions=react-server --import tsx tests/playbook-docs.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as ReactNS from "react";
import { isValidElement } from "react";
import { createClient, type Client } from "@libsql/client";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "playbook-docs-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "playbook-docs-test-secret-long-enough-0000000001";
delete process.env.OPERATOR_EMAIL;
const IMPORT_TOKEN = "playbook-import-test-bearer-0123456789abcdef";
delete process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC;

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
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) => ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
stub("next/image", {
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) => ReactNS.createElement("img", { src, alt }),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const u = (n: number, email: string) => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"),
  rep: u(4, "rep@oasis-team.test"),
  client: u(3, "owner@client.test"),
} as const;
type Viewer = keyof typeof USERS | "anonymous";

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
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
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

/** scripts/apply_turso_migration.py split_statements, line for line: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function stringLiterals(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

/** Make every public fs read throw, run `fn`, restore. The Worker has no filesystem. */
async function withoutFilesystem<T>(fn: () => Promise<T>): Promise<T> {
  const target = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  const names = ["readFileSync", "readFile", "readdirSync", "readdir", "statSync", "existsSync", "openSync"];
  const pnames = ["readFile", "readdir", "stat", "open"];
  const saved = names.map((n) => [n, target[n]] as const);
  const psaved = pnames.map((n) => [n, promises[n]] as const);
  const boom = (name: string) => () => {
    throw new Error(`fs.${name} is not available on the Worker`);
  };
  try {
    for (const n of names) target[n] = boom(n);
    for (const n of pnames) promises[n] = boom(`promises.${n}`);
    return await fn();
  } finally {
    for (const [n, v] of saved) target[n] = v;
    for (const [n, v] of psaved) promises[n] = v;
  }
}

function req(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { host: "oasisai.work", origin: "https://oasisai.work", ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://oasisai.work${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function main() {
  const db: Client = createClient({ url: `file:${dbFile}` });
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
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
              VALUES (?, ?, ?, ?, 'owner', 1, ?, '["bravo"]', ?)`,
        args: [`p-${USERS.cc.id}`, USERS.cc.id, USERS.cc.email, OASIS, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
              VALUES (?, ?, ?, ?, 'opener', 0, ?, '["bravo"]', ?)`,
        args: [`p-${USERS.rep.id}`, USERS.rep.id, USERS.rep.email, OASIS, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
              VALUES (?, ?, ?, ?, 'owner', 1, ?, '["bravo"]', ?)`,
        args: [`p-${USERS.client.id}`, USERS.client.id, USERS.client.email, CLIENT, stamp, stamp],
      },
    ],
    "write",
  );

  console.log("playbook-docs:");

  // ── 1. content modules and the fs guard ─────────────────────────────────
  await check("the committed content modules equal what the generator makes from content/playbooks and lib/prompts", async () => {
    const gen = (await import(pathToFileURL(join(ROOT, "scripts", "gen-content-modules.mjs")).href)) as { renderAll: (root: string) => Record<string, string> };
    const want = gen.renderAll(ROOT);
    for (const [path, content] of Object.entries(want)) {
      const onDisk = readFileSync(join(ROOT, path), "utf8").replace(/\r\n?/g, "\n");
      assert.equal(onDisk, content, `${path} is stale: run node scripts/gen-content-modules.mjs`);
      assert.ok(!/[^\x00-\x7f]/.test(onDisk), `${path} must be ASCII only (\\uXXXX escapes)`);
    }
  });
  await check("package.json regenerates the content modules before every build", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.prebuild, "node scripts/gen-content-modules.mjs");
  });
  await check("the Playbook markdown, the prompts and the onboarding page no longer read the filesystem, and left the fs BASELINE", () => {
    const FS = /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']|(?:require|import)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/;
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["lib/playbooks.ts", "lib/prompts/index.ts", "app/playbook/onboarding/page.tsx"]) {
      assert.ok(!FS.test(noComments(readFileSync(join(ROOT, f), "utf8"))), `${f} imports fs`);
    }
    const guard = readFileSync(join(ROOT, "tests", "workers-no-runtime-fs.test.ts"), "utf8");
    const baseline = guard.match(/const BASELINE = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
    const entries = [...baseline.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const gone of ["lib/playbooks.ts", "lib/prompts/index.ts", "app/playbook/onboarding/page.tsx"]) {
      assert.ok(!entries.includes(gone), `${gone} is still in the fs BASELINE`);
    }
    assert.ok(entries.length <= 4, `BASELINE grew: ${entries.join(", ")}`);
  });
  await check("the bundled Playbook loads without a filesystem, and a missing slug throws instead of answering null", async () => {
    const pb = await import("../lib/playbooks");
    await withoutFilesystem(async () => {
      const slugs = pb.listPlaybooks().map((f) => f.slug);
      assert.ok(slugs.includes("10-oasis-loop") && slugs.includes("07-new-client-onboarding"), slugs.join(", "));
      assert.match(pb.loadPlaybook("10-oasis-loop").title, /The OASIS Loop/);
      assert.throws(() => pb.loadPlaybook("no-such-playbook"), pb.PlaybookNotFoundError);
      assert.throws(() => pb.loadPlaybook("../etc/passwd"), pb.PlaybookNotFoundError);
    });
    const prompts = await import("../lib/prompts");
    assert.ok(prompts.OASIS_LEAD_SCORING_PROMPT.length > 100 && prompts.OASIS_CHECKIN_COMPOSE_PROMPT.length > 100);
  });
  await check("the SunBiz playbooks are retired from the bundle", async () => {
    const pb = await import("../lib/playbooks");
    for (const f of pb.listPlaybooks()) {
      assert.ok(!/sunbiz|solara|helios/i.test(`${f.slug} ${f.body.slice(0, 800)}`), `${f.slug} is SunBiz material`);
    }
  });

  // ── 2. asks go to departments ────────────────────────────────────────────
  await check("no '/agents?agent=' or '/agents?prompt=' link remains in app, components or lib", () => {
    const hits: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const f of walk(join(ROOT, dir)).filter((p) => /\.(tsx?|jsx?)$/.test(p))) {
        for (const lit of stringLiterals(readFileSync(f, "utf8"), f)) {
          if (/\/agents\?(agent|prompt)=/.test(lit)) hits.push(`${rel(f)}: ${lit.slice(0, 60)}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });
  await check("askDepartment builds /team/<dept>?ask=, maps owners and agents to departments, and refuses a prompt it would cut", async () => {
    const c = await import("../lib/os/chat-href");
    assert.equal(c.askDepartment("finance", "What's owing on tax?"), "/team/finance?ask=What's%20owing%20on%20tax%3F");
    assert.equal(c.askDepartment("sales", "   "), "/team/sales");
    assert.equal(c.departmentForDocOwner("ceo"), "chief-of-staff");
    assert.equal(c.departmentForDocOwner("legal"), "chief-of-staff");
    assert.equal(c.departmentForDocOwner("cfo"), "finance");
    assert.equal(c.departmentForDocOwner("cmo"), "marketing");
    assert.equal(c.departmentForDocOwner("ops"), "operations");
    assert.equal(c.departmentForAgent("maven"), "marketing");
    assert.equal(c.departmentForAgent("atlas"), "finance");
    assert.equal(c.departmentForAgent("unknown-agent"), "chief-of-staff");
    const long = "x".repeat(c.ASK_MAX_CHARS + 1);
    assert.equal(c.fitsAskLink(long), false);
    assert.throws(() => c.askDepartment("sales", long), RangeError);
    assert.throws(() => c.askDepartment("nope" as never, "hi"));
  });
  await check("?ask= is read once: prefill text, and the URL without it", async () => {
    const c = await import("../lib/os/chat-href");
    assert.deepEqual(c.consumeAskParam("?ask=Draft%20the%20tax%20calendar&tab=x"), { present: true, text: "Draft the tax calendar", rest: "tab=x" });
    assert.deepEqual(c.consumeAskParam("?q=hello"), { present: false, text: null, rest: "q=hello" });
    assert.deepEqual(c.consumeAskParam("?ask="), { present: true, text: null, rest: "" });
  });
  await check("the department composer reads ?ask= through consumeAskParam, prefills only when the channel is ready, replaces the URL, and never sends", () => {
    const src = readFileSync(join(ROOT, "components", "os", "department", "ComposerContext.tsx"), "utf8");
    assert.match(src, /consumeAskParam\(window\.location\.search\)/);
    assert.match(src, /if \(text && channelReady\) ask\(text\);/);
    assert.match(src, /window\.history\.replaceState\(/);
    assert.match(src, /askRead\.current = true;/, "read once");
    assert.ok(!/fetch\(|\.submit\(|send\(/.test(src), "the composer context must never send");
  });
  await check("after a write the document page reloads from the server (a folded router.refresh showed stale Draft over a Current row)", () => {
    for (const f of ["app/playbook/business/[slug]/DocActions.tsx", "app/playbook/business/[slug]/IncidentRegister.tsx"]) {
      const src = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.match(src, /window\.location\.reload\(\)/, f);
      assert.ok(!/router\.refresh\(/.test(src), `${f} must not rely on router.refresh after a write`);
    }
  });
  await check("every former /agents builder now asks a department", () => {
    for (const f of [
      "app/playbook/business/[slug]/page.tsx",
      "components/playbook/PromptsLibraryFilter.tsx",
      "app/playbook/drills/page.tsx",
      "app/playbook/client-deploy/page.tsx",
      "components/reasoning/QuickActionsGrid.tsx",
    ]) {
      assert.match(readFileSync(join(ROOT, f), "utf8"), /askDepartment\(/, f);
    }
  });

  // Migration and fixtures for the stored half.
  for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", "bravo__194_playbook_docs.sql"), "utf8"))) await db.execute(stmt);
  await db.executeMultiple(`
    CREATE TABLE fin_entities (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL, owner_key TEXT);
    CREATE TABLE fin_settings (entity_id TEXT PRIMARY KEY, legal_name TEXT NOT NULL DEFAULT '', gst_qst_registered INTEGER NOT NULL DEFAULT 0,
      gst_number TEXT NOT NULL DEFAULT '', qst_number TEXT NOT NULL DEFAULT '', registration_effective_date TEXT, updated_at TEXT NOT NULL);
    INSERT INTO fin_entities (id, slug, name, kind) VALUES ('fin_ent_oasis', 'oasis', 'OASIS AI Solutions', 'business');
    INSERT INTO fin_settings (entity_id, legal_name, gst_qst_registered, updated_at) VALUES ('fin_ent_oasis', 'OASIS AI Solutions', 0, '2026-09-24T00:00:00.000Z');
    -- A stray second "business" row must not be read: the document reads the
    -- entity Finances uses (BUSINESS_ENTITY_ID), never "any business row".
    INSERT INTO fin_entities (id, slug, name, kind) VALUES ('stray-biz', 'stray', 'Stray', 'business');
    INSERT INTO fin_settings (entity_id, legal_name, gst_qst_registered, gst_number, qst_number, updated_at) VALUES ('stray-biz', 'Stray', 1, 'X', 'Y', '2026-01-01T00:00:00.000Z');
  `);
  for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", "182_revenue_goals.turso.sql"), "utf8"))) await db.execute(stmt);

  const catalogMod = await import("../lib/playbook/catalog");
  const { CATALOG } = catalogMod;
  const founderOnly = CATALOG.filter((d) => d.visibility === "founders");
  const teamDocs = CATALOG.filter((d) => d.visibility !== "founders");

  // ── 3. every page renders with no filesystem ────────────────────────────
  const playbookPages = walk(join(ROOT, "app", "playbook")).filter((f) => /[\\/]page\.tsx$/.test(f));
  // Load every page module (and so its imports) BEFORE the filesystem goes away.
  const pages = new Map<string, (p: unknown) => unknown>();
  for (const f of playbookPages) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS test harness, absolute path
    pages.set(f, (require(f) as { default: (p: unknown) => unknown }).default);
  }
  const docPage = pages.get(playbookPages.find((f) => /[\\/]business[\\/]\[slug\][\\/]page\.tsx$/.test(f))!)!;
  const listPage = pages.get(playbookPages.find((f) => /[\\/]business[\\/]page\.tsx$/.test(f))!)!;

  await check("every /playbook page renders for an OASIS founder with the filesystem made to throw", async () => {
    await login("cc");
    await withoutFilesystem(async () => {
      for (const f of playbookPages) {
        const page = pages.get(f)!;
        const name = rel(f);
        if (/[\\/]onboarding[\\/]/.test(f)) {
          await assert.rejects(() => Promise.resolve(page({})), /NEXT_REDIRECT;\/playbook#operating-manual/, name);
          continue;
        }
        const slug = /business[\\/]\[slug\]/.test(f) ? "privacy-policy" : "10-oasis-loop";
        const out = await page(f.includes("[slug]") ? params(slug) : {});
        assert.ok(isValidElement(out), `${name} did not render`);
      }
    });
  });
  await check("every business document the founder can open renders its own page (no 404, no 'Page not found')", async () => {
    await login("cc");
    await withoutFilesystem(async () => {
      for (const d of CATALOG) {
        const out = await docPage(params(d.slug));
        assert.ok(isValidElement(out), `${d.slug} did not render`);
      }
    });
  });

  const { resolveDocsViewer } = await import("../lib/playbook/viewer");
  const docs = await import("../lib/playbook/documents");

  await check("the privacy policy document is the live /privacy text, with Copy and Download", async () => {
    await login("cc");
    const v = await resolveDocsViewer();
    assert.ok(v.ok);
    const r = await docs.resolveDoc(v, "privacy-policy", db, new Date("2026-09-30T12:00:00Z"));
    assert.ok(r && r.body, "no body");
    const legal = await import("../lib/legal/constants");
    assert.match(r.body!, /^# Privacy Policy/m);
    assert.ok(r.body!.includes(`Last updated ${legal.PRIVACY_LAST_UPDATED}`), "last updated line");
    assert.ok(r.body!.includes(legal.PRIVACY_OFFICER.name), "privacy officer");
    for (const s of legal.SUBPROCESSORS) assert.ok(r.body!.includes(s.name), `processor ${s.name}`);
    assert.ok(r.body!.includes("## 1. Who we are") || r.body!.includes("1. Who we are"), "section 1");
    assert.ok(!r.body!.includes("[object Object]"));
    assert.equal(r.status, "current");
    const dl = await import("../app/api/playbook/docs/[slug]/download/route");
    const res = await dl.GET(req("/api/playbook/docs/privacy-policy/download"), params("privacy-policy"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/markdown/);
    assert.match(res.headers.get("content-disposition") || "", /^attachment; filename="oasis-privacy-policy\.md"$/);
    assert.equal(await res.text(), r.body);
  });

  // ── 4. visibility ─────────────────────────────────────────────────────────
  await check("a sales rep's list holds no founders-only document, from the page's reader and from the API", async () => {
    await login("rep");
    const v = await resolveDocsViewer();
    assert.ok(v.ok && v.persona === "sales" && !v.founder);
    const { rows } = await docs.listDocs(v, db, new Date());
    assert.ok(rows.length === teamDocs.length && rows.length > 0, `${rows.length} vs ${teamDocs.length}`);
    assert.ok(rows.every((r) => r.doc.visibility !== "founders"));
    const api = await import("../app/api/playbook/docs/route");
    const res = await api.GET();
    const body = (await res.json()) as { docs: Array<{ slug: string; visibility: string }> };
    assert.ok(body.docs.length === teamDocs.length && body.docs.every((d) => d.visibility !== "founders"));
    const out = await listPage({});
    assert.ok(isValidElement(out));
  });
  await check("a sales rep gets 404 on a founders document's page, API read and download, and 200 on a team one", async () => {
    await login("rep");
    const one = await import("../app/api/playbook/docs/[slug]/route");
    const dl = await import("../app/api/playbook/docs/[slug]/download/route");
    for (const d of founderOnly) {
      assert.equal(await is404(() => docPage(params(d.slug))), true, `page ${d.slug}`);
      assert.equal((await one.GET(req(`/api/playbook/docs/${d.slug}`), params(d.slug))).status, 404, `api ${d.slug}`);
      assert.equal((await dl.GET(req(`/api/playbook/docs/${d.slug}/download`), params(d.slug))).status, 404, `download ${d.slug}`);
    }
    assert.equal((await dl.GET(req("/api/playbook/docs/security-model/download"), params("security-model"))).status, 200);
    assert.equal(await is404(() => docPage(params("no-such-document"))), true, "an unknown slug is the same 404");
  });
  await check("another workspace gets 404 on the list, every document and every write", async () => {
    await login("client");
    const api = await import("../app/api/playbook/docs/route");
    assert.equal((await api.GET()).status, 404);
    const one = await import("../app/api/playbook/docs/[slug]/route");
    const draft = await import("../app/api/playbook/docs/[slug]/draft/route");
    const inc = await import("../app/api/playbook/incidents/route");
    assert.equal((await one.GET(req("/api/playbook/docs/privacy-policy"), params("privacy-policy"))).status, 404);
    assert.equal((await draft.POST(req("/api/playbook/docs/okrs/draft", { method: "POST", body: {} }), params("okrs"))).status, 404);
    assert.equal((await inc.GET()).status, 404);
    assert.equal(await is404(() => docPage(params("privacy-policy"))), true);
  });
  await check("the stored-document query itself carries the visibility filter (a founders row is never fetched for a rep)", async () => {
    const store = await import("../lib/playbook/store");
    await db.execute({
      sql: `INSERT INTO playbook_docs (id, tenant_id, slug, kind, category, title, summary, body_md, status, visibility, required, owner_department, source, version, created_at, updated_at)
            VALUES ('vis-probe', ?, 'vis-probe', 'record', 'corporate', 'probe', '', 'secret founders text', 'draft', 'founders', 0, 'chief-of-staff', 'in_app', 1, ?, ?)`,
      args: [OASIS, stamp, stamp],
    });
    const asRep = await store.getStoredDoc(db, OASIS, "vis-probe", "sales");
    assert.ok(asRep.ok && asRep.value === null, "the rep's query returned the founders row");
    const asFounder = await store.getStoredDoc(db, OASIS, "vis-probe", "founder");
    assert.ok(asFounder.ok && asFounder.value?.body_md === "secret founders text");
    const list = await store.listStoredDocs(db, OASIS, "manager");
    assert.ok(list.ok && !list.value.some((r) => r.slug === "vis-probe"));
    await db.execute("DELETE FROM playbook_docs WHERE id = 'vis-probe'");
  });

  // ── 5. Draft it -> Mark current ──────────────────────────────────────────
  const draftRoute = await import("../app/api/playbook/docs/[slug]/draft/route");
  const markRoute = await import("../app/api/playbook/docs/[slug]/mark-current/route");
  const oneRoute = await import("../app/api/playbook/docs/[slug]/route");
  const status = await import("../lib/playbook/status");

  await check("the Law 25 incident register shows Missing, then Draft it gives a draft in under 5 seconds", async () => {
    await login("cc");
    const v = await resolveDocsViewer();
    assert.ok(v.ok);
    const before = await docs.resolveDoc(v, "law25-incident-register", db, new Date());
    assert.equal(before?.status, "missing");
    assert.equal(before?.canDraft, true);
    const t0 = Date.now();
    const res = await draftRoute.POST(req("/api/playbook/docs/law25-incident-register/draft", { method: "POST", body: {} }), params("law25-incident-register"));
    const ms = Date.now() - t0;
    const body = (await res.json()) as { ok: boolean; status: string; version: number; placeholders: string[] };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "draft");
    assert.equal(body.version, 1);
    assert.ok(body.placeholders.length > 0, "the draft has questions for CC");
    assert.ok(ms < 5000, `drafting took ${ms} ms`);
    const after = await docs.resolveDoc(v, "law25-incident-register", db, new Date());
    assert.equal(after?.status, "draft");
    assert.ok(after?.body?.includes("section 3.8"));
    const again = await draftRoute.POST(req("/api/playbook/docs/law25-incident-register/draft", { method: "POST", body: {} }), params("law25-incident-register"));
    assert.equal(again.status, 409, "a second draft never overwrites");
  });
  await check("Mark current is refused with one sentence while a placeholder remains", async () => {
    await login("cc");
    const res = await markRoute.POST(req("/api/playbook/docs/law25-incident-register/mark-current", { method: "POST", body: { expected_version: 1 } }), params("law25-incident-register"));
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(res.status, 409);
    assert.equal(body.error, "placeholders");
    assert.equal(body.message, status.PLACEHOLDER_REFUSAL);
    assert.equal(body.message.split(/(?<=[.!?])\s+/).length, 1, "one sentence");
    const row = await db.execute({ sql: "SELECT status, version FROM playbook_docs WHERE tenant_id = ? AND slug = ?", args: [OASIS, "law25-incident-register"] });
    assert.equal(row.rows[0].status, "draft");
  });
  await check("after the placeholders are answered, Mark current succeeds, writes approved_by/at and a version row", async () => {
    await login("cc");
    const got = (await (await oneRoute.GET(req("/api/playbook/docs/law25-incident-register"), params("law25-incident-register"))).json()) as { doc: { body_md: string; version: number } };
    const answered = got.doc.body_md.replace(/\[\[CC to confirm:[^\]]*\]\]/g, "Answered by CC in the test.");
    assert.ok(!status.hasPlaceholders(answered));
    const stale = await oneRoute.PUT(req("/api/playbook/docs/law25-incident-register", { method: "PUT", body: { body_md: answered, expected_version: 99 } }), params("law25-incident-register"));
    assert.equal(stale.status, 409, "a stale version is refused");
    const put = await oneRoute.PUT(req("/api/playbook/docs/law25-incident-register", { method: "PUT", body: { body_md: answered, expected_version: got.doc.version } }), params("law25-incident-register"));
    const putBody = (await put.json()) as { ok: boolean; version: number };
    assert.equal(put.status, 200, JSON.stringify(putBody));
    assert.equal(putBody.version, 2);
    const mark = await markRoute.POST(req("/api/playbook/docs/law25-incident-register/mark-current", { method: "POST", body: { expected_version: 2 } }), params("law25-incident-register"));
    assert.equal(mark.status, 200, await mark.clone().text());
    const row = (await db.execute({ sql: "SELECT status, version, approved_by, approved_at FROM playbook_docs WHERE tenant_id = ? AND slug = ?", args: [OASIS, "law25-incident-register"] })).rows[0];
    assert.equal(row.status, "current");
    assert.equal(Number(row.version), 3);
    assert.equal(row.approved_by, USERS.cc.email);
    assert.ok(typeof row.approved_at === "string" && row.approved_at.length > 10);
    const versions = await db.execute({ sql: "SELECT version, note, status, changed_by FROM playbook_doc_versions WHERE tenant_id = ? AND slug = ? ORDER BY version", args: [OASIS, "law25-incident-register"] });
    assert.deepEqual(versions.rows.map((r) => [Number(r.version), r.note, r.status]), [[1, "draft", "draft"], [2, "edit", "draft"], [3, "mark_current", "current"]]);
    const v = await resolveDocsViewer();
    assert.ok(v.ok);
    const resolved = await docs.resolveDoc(v, "law25-incident-register", db, new Date());
    assert.equal(resolved?.status, "current");
    assert.equal(resolved?.versions?.length, 3);
  });
  await check("versions are append-only in the database: UPDATE and DELETE are refused", async () => {
    await assert.rejects(() => db.execute({ sql: "UPDATE playbook_doc_versions SET note = 'x' WHERE tenant_id = ?", args: [OASIS] }), /append-only/);
    await assert.rejects(() => db.execute({ sql: "DELETE FROM playbook_doc_versions WHERE tenant_id = ?", args: [OASIS] }), /append-only/);
  });
  await check("a teammate cannot draft, edit or mark current (403 on a team document, 404 on a founders one)", async () => {
    await login("rep");
    assert.equal((await draftRoute.POST(req("/api/playbook/docs/sales-enablement-guide/draft", { method: "POST", body: {} }), params("sales-enablement-guide"))).status, 403);
    assert.equal((await draftRoute.POST(req("/api/playbook/docs/okrs/draft", { method: "POST", body: {} }), params("okrs"))).status, 404);
    assert.equal((await markRoute.POST(req("/api/playbook/docs/sales-enablement-guide/mark-current", { method: "POST", body: { expected_version: 1 } }), params("sales-enablement-guide"))).status, 403);
  });
  await check("writes are refused cross-origin (CSRF)", async () => {
    await login("cc");
    const r = await draftRoute.POST(req("/api/playbook/docs/okrs/draft", { method: "POST", body: {}, headers: { origin: "https://evil.example" } }), params("okrs"));
    assert.equal(r.status, 403);
  });
  await check("a live document cannot be drafted or marked current; it is always its live copy", async () => {
    await login("cc");
    assert.equal((await draftRoute.POST(req("/api/playbook/docs/privacy-policy/draft", { method: "POST", body: {} }), params("privacy-policy"))).status, 409);
    assert.equal((await markRoute.POST(req("/api/playbook/docs/terms-of-service/mark-current", { method: "POST", body: { expected_version: 1 } }), params("terms-of-service"))).status, 409);
  });

  // ── incidents register ────────────────────────────────────────────────────
  await check("the incident register appends, validates, is founders-only, and refuses UPDATE and DELETE", async () => {
    const inc = await import("../app/api/playbook/incidents/route");
    await login("cc");
    const entry = {
      personal_info: "Name and email of one lead",
      circumstances: "A test entry",
      occurred_period: "2026-09-29",
      aware_at: "2026-09-30",
      risk_assessment: "Low sensitivity, one person",
      serious_risk: "no",
      measures: "Access revoked",
    };
    const ok = await inc.POST(req("/api/playbook/incidents", { method: "POST", body: entry }));
    assert.equal(ok.status, 201, await ok.clone().text());
    const bad = await inc.POST(req("/api/playbook/incidents", { method: "POST", body: { ...entry, aware_at: "yesterday" } }));
    assert.equal(bad.status, 400);
    const list = (await (await inc.GET()).json()) as { incidents: Array<{ persons_count: number | null; serious_risk: number | null }> };
    assert.equal(list.incidents.length, 1);
    assert.equal(list.incidents[0].persons_count, null, "an unknown count stays unknown, never 0");
    assert.equal(list.incidents[0].serious_risk, 0);
    await assert.rejects(() => db.execute("UPDATE privacy_incidents SET measures = 'x'"), /append-only/);
    await assert.rejects(() => db.execute("DELETE FROM privacy_incidents"), /append-only/);
    await login("rep");
    assert.equal((await inc.GET()).status, 404);
    assert.equal((await inc.POST(req("/api/playbook/incidents", { method: "POST", body: entry }))).status, 404);
  });

  // ── 6. import ───────────────────────────────────────────────────────────
  await check("the import fails closed without its bearer, and refuses a wrong one", async () => {
    const imp = await import("../app/api/internal/playbook/import/route");
    delete process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC;
    const r1 = await imp.POST(req("/api/internal/playbook/import", { method: "POST", body: { docs: [] }, headers: { authorization: `Bearer ${IMPORT_TOKEN}` } }));
    assert.equal(r1.status, 503);
    process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = IMPORT_TOKEN;
    const r2 = await imp.POST(req("/api/internal/playbook/import", { method: "POST", body: { docs: [] }, headers: { authorization: "Bearer wrong-token" } }));
    assert.equal(r2.status, 401);
  });
  await check("the import refuses planted secrets, live and unknown slugs; imports a clean one into OASIS; the same hash is a no-op", async () => {
    const imp = await import("../app/api/internal/playbook/import/route");
    process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = IMPORT_TOKEN;
    const auth = { authorization: `Bearer ${IMPORT_TOKEN}` };
    const planted = [
      "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----",
      "key: sk_live_51Habcdefghijklmnop",
      "restricted rk_live_51Habcdefghijklmnop",
      "openai sk-proj-abcdefghijklmnopqrstuv",
      "slack xoxb-1234567890-abcdefghij",
    ];
    const res = await imp.POST(
      req("/api/internal/playbook/import", {
        method: "POST",
        headers: auth,
        body: {
          tenant_id: CLIENT,
          docs: [
            ...planted.map((body_md) => ({ slug: "decisions-log", body_md, source_ref: "BEA memory/DECISIONS.md" })),
            { slug: "privacy-policy", body_md: "x", source_ref: "x" },
            { slug: "not-a-doc", body_md: "x", source_ref: "x" },
            { slug: "decisions-log", body_md: "# Decisions log\n\nA clean decision.", source_ref: "BEA memory/DECISIONS.md", source_updated_at: "2026-09-29" },
          ],
        },
      }),
    );
    const body = (await res.json()) as { results: Array<{ status: string; error?: string; slug: string | null }>; created: number; rejected: number };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.rejected, planted.length + 2);
    for (let i = 0; i < planted.length; i += 1) assert.match(body.results[i].error || "", /^refused_secret:/, planted[i]);
    assert.equal(body.results[planted.length].error, "live_document");
    assert.equal(body.results[planted.length + 1].error, "unknown_slug");
    assert.equal(body.created, 1);
    const rows = await db.execute({ sql: "SELECT tenant_id, source, status, body_md FROM playbook_docs WHERE slug = 'decisions-log'", args: [] });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].tenant_id, OASIS, "the tenant is forced to OASIS; the body's tenant_id is ignored");
    assert.equal(rows.rows[0].source, "import");
    assert.equal(rows.rows[0].status, "draft", "an import never marks a document current");
    for (const p of planted) assert.ok(!String(rows.rows[0].body_md).includes(p.slice(0, 12)));
    const again = await imp.POST(req("/api/internal/playbook/import", { method: "POST", headers: auth, body: { docs: [{ slug: "decisions-log", body_md: "# Decisions log\n\nA clean decision.", source_ref: "BEA memory/DECISIONS.md" }] } }));
    const againBody = (await again.json()) as { unchanged: number };
    assert.equal(againBody.unchanged, 1);
    const vcount = await db.execute({ sql: "SELECT COUNT(*) AS n FROM playbook_doc_versions WHERE slug = 'decisions-log'", args: [] });
    assert.equal(Number(vcount.rows[0].n), 1, "the no-op wrote no version");
  });
  await check("the import never overwrites a document a founder drafted in the app", async () => {
    const imp = await import("../app/api/internal/playbook/import/route");
    process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = IMPORT_TOKEN;
    const res = await imp.POST(req("/api/internal/playbook/import", { method: "POST", headers: { authorization: `Bearer ${IMPORT_TOKEN}` }, body: { docs: [{ slug: "law25-incident-register", body_md: "# Overwrite attempt", source_ref: "x" }] } }));
    const body = (await res.json()) as { skipped: number };
    assert.equal(body.skipped, 1);
    const row = await db.execute({ sql: "SELECT body_md FROM playbook_docs WHERE slug = 'law25-incident-register'", args: [] });
    assert.ok(!String(row.rows[0].body_md).includes("Overwrite attempt"));
  });
  await check("the secret scanner fires on each planted shape and not on ordinary prose", async () => {
    const { findSecret } = await import("../lib/playbook/import");
    assert.equal(findSecret("-----BEGIN RSA PRIVATE KEY-----"), "private_key_block");
    assert.equal(findSecret("sk_test_abcdefghijk"), "stripe_secret_key");
    assert.equal(findSecret("AKIAABCDEFGHIJKLMNOP"), "aws_access_key_id");
    assert.equal(findSecret("ghp_abcdefghijklmnopqrstuvwxyz0123"), "github_token");
    assert.equal(findSecret("A task-list and a desk-lamp; the sk- prefix alone is not a key."), null);
  });

  // ── 7. statuses, catalog, templates ──────────────────────────────────────
  await check("status is derived: missing, draft, current, review due, superseded, unknown", async () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const d = { reviewEveryDays: 90 };
    const row = (o: Partial<{ status: string; body_md: string | null; source_url: string | null; source_updated_at: string | null; approved_at: string | null; review_every_days: number | null }>) => ({
      status: "draft", body_md: "x", source_url: null, source_updated_at: null, approved_at: null, review_every_days: null, ...o,
    });
    assert.equal(status.deriveStatus(d, { kind: "stored", row: null }, now), "missing");
    assert.equal(status.deriveStatus(d, { kind: "stored", row: row({ status: "current", body_md: null }) }, now), "missing", "no body and no source is missing, whatever the typed status says");
    assert.equal(status.deriveStatus(d, { kind: "stored", row: row({}) }, now), "draft");
    assert.equal(status.deriveStatus(d, { kind: "stored", row: row({ status: "current", source_updated_at: "2026-09-01" }) }, now), "current");
    assert.equal(status.deriveStatus(d, { kind: "stored", row: row({ status: "current", source_updated_at: "2026-05-01" }) }, now), "review_due");
    assert.equal(status.deriveStatus(d, { kind: "stored", row: row({ status: "superseded" }) }, now), "superseded");
    assert.equal(status.deriveStatus(d, { kind: "unreadable" }, now), "unknown");
    assert.equal(status.deriveStatus(d, { kind: "live", sourceDate: "2026-01-01" }, now), "review_due");
    assert.equal(status.deriveStatus(d, { kind: "live", sourceDate: null }, now), "current", "no recorded date is not overdue");
    assert.equal(status.isoFromLongDate("September 28, 2026"), "2026-09-28");
    assert.equal(status.isoFromLongDate("soon"), null);
  });
  await check("the catalog carries no typed status, has unique slugs, and every source resolves", async () => {
    const { LIVE_META } = await import("../lib/playbook/live-sources");
    const pb = await import("../lib/playbooks");
    const seen = new Set<string>();
    for (const d of CATALOG) {
      assert.ok(!("status" in d), `${d.slug} carries a status literal`);
      assert.ok(!seen.has(d.slug), `duplicate ${d.slug}`);
      seen.add(d.slug);
      if (d.source.kind === "app_live") assert.ok(LIVE_META[d.source.live], `${d.slug}: no live renderer`);
      if (d.source.kind === "bundled") pb.loadPlaybook(d.source.playbookSlug);
    }
    assert.ok(CATALOG.length >= 40, `${CATALOG.length} documents`);
    for (const required of [
      "quebec-tax-calendar", "gst-qst-registration", "msa-template", "client-dpa", "mutual-nda",
      "contractor-agreement-opener", "contractor-agreement-closer", "contractor-agreement-manager", "contractor-agreement-builder",
      "sub-processor-list", "privacy-policy", "terms-of-service", "dmca-policy", "law25-incident-register", "privacy-impact-assessments",
      "privacy-governance-policy", "incident-response-runbook", "security-model", "insurance", "ip-assignment", "founders-agreement",
      "enterprise-registration", "accountant-engagement", "capital-allocation-policy", "contractor-classification-memo", "okrs",
      "decisions-log", "risk-register", "brand-system", "sales-enablement-guide", "client-onboarding-sop", "oasis-loop",
    ]) {
      assert.ok(seen.has(required), `the catalog is missing ${required}`);
    }
  });
  await check("every stored document has a template, and every template names a stored catalog document", async () => {
    const tpl = await import("../lib/playbook/templates");
    for (const d of CATALOG.filter((x) => x.source.kind === "stored")) assert.ok(tpl.hasTemplate(d.slug), `${d.slug} has no template: Draft it would dead-end`);
    for (const slug of Object.keys(tpl.TEMPLATES)) {
      const d = catalogMod.catalogDoc(slug);
      assert.ok(d && d.source.kind === "stored", `template ${slug} has no stored catalog document`);
    }
  });
  await check("templates use only the facts they are given; unknowns are placeholders; a failed read is never a default", async () => {
    const tpl = await import("../lib/playbook/templates");
    const ctxOk = {
      today: "2026-09-30",
      legal: tpl.legalFacts(),
      finance: { ok: true as const, value: { registered: false, gstNumber: "", qstNumber: "", effectiveDate: null, legalName: "OASIS AI Solutions" } },
      goal: { ok: true as const, value: { label: "October sprint", targetCents: 600000, currency: "USD", periodStart: "2026-09-24", periodEnd: "2026-10-24" } },
    };
    const ctxFailed = { ...ctxOk, finance: { ok: false as const, why: "the Finances settings could not be read" }, goal: { ok: false as const, why: "the revenue goal could not be read" } };
    for (const slug of Object.keys(tpl.TEMPLATES)) {
      for (const ctx of [ctxOk, ctxFailed]) {
        const text = tpl.renderTemplate({ slug }, ctx);
        assert.match(text, /^# /, `${slug} has no title`);
        assert.ok(!/GST\s*\/\s*HST|\bQ2 2026\b|\$5K|undefined|null|NaN|\[object Object\]/.test(text), `${slug} carries a stale fact or a hole`);
        assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(text.replace(new RegExp(Object.values(ctx.legal.contacts).map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "")), `${slug} names an email that is not a legal contact`);
      }
    }
    const okrsOk = tpl.renderTemplate({ slug: "okrs" }, ctxOk);
    assert.ok(okrsOk.includes("US$6,000") && okrsOk.includes("2026-10-24"), "the active goal appears as recorded");
    const okrsFailed = tpl.renderTemplate({ slug: "okrs" }, ctxFailed);
    assert.ok(okrsFailed.includes("[[CC to confirm: the revenue key result (the revenue goal could not be read)"), "a failed goal read is a placeholder");
    const taxFailed = tpl.renderTemplate({ slug: "quebec-tax-calendar" }, ctxFailed);
    assert.ok(taxFailed.includes("[[CC to confirm: GST/QST registration status"), "a failed finance read is a placeholder, not 'not registered'");
    const taxOk = tpl.renderTemplate({ slug: "quebec-tax-calendar" }, ctxOk);
    assert.ok(taxOk.includes("TP-1") && taxOk.includes("TP-80") && taxOk.includes("T2125") && taxOk.includes("Not registered for GST or QST"));
    const fa = tpl.renderTemplate({ slug: "founders-agreement" }, ctxOk);
    assert.ok(fa.includes("[[CC to confirm: the ownership split") && fa.includes("[[CC to confirm: Adon's full legal name"), "no invented split or name");
  });
  await check("live renderers: sub-processors table, price book, contracts with blanks, GST/QST from Finances", async () => {
    const live = await import("../lib/playbook/live-sources");
    const legal = await import("../lib/legal/constants");
    const sub = await live.renderLiveSource("subprocessors", db);
    for (const s of legal.SUBPROCESSORS) assert.ok(sub.markdown.includes(`| ${s.name} |`), s.name);
    const pricebook = await live.renderLiveSource("price_book", db);
    assert.match(pricebook.markdown, /\| Starter \| \$500 \| \$150 \|/);
    const opener = await live.renderLiveSource("contract_opener", db);
    assert.ok(opener.markdown.includes("[Contractor legal name]") && opener.markdown.includes("Governing law"));
    const gst = await live.renderLiveSource("gst_qst_status", db);
    assert.ok(gst.markdown.includes("Not registered for GST or QST"));
    assert.equal(gst.sourceDate, "2026-09-24T00:00:00.000Z");
    await db.execute("ALTER TABLE fin_settings RENAME TO fin_settings_offline");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await assert.rejects(() => live.renderLiveSource("gst_qst_status", db), live.LiveSourceError, "a failed read throws, never 'not registered'");
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE fin_settings_offline RENAME TO fin_settings");
    }
  });
  await check("visibility rule: founders see all four levels, every other persona three, and the SQL clause matches", async () => {
    const vis = await import("../lib/playbook/visibility");
    assert.deepEqual([...vis.visibilitiesFor("founder")], ["founders", "team", "client_safe", "public"]);
    for (const p of ["manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"] as const) {
      assert.deepEqual([...vis.visibilitiesFor(p)], ["team", "client_safe", "public"], p);
      assert.equal(vis.mayViewVisibility(p, "founders"), false, p);
    }
    assert.deepEqual(vis.visibilityClause("sales"), { sql: "visibility IN (?, ?, ?)", args: ["team", "client_safe", "public"] });
  });

  if (failures > 0) {
    console.error(`playbook-docs: ${failures} failure(s), ${passed} passed`);
    process.exit(1);
  }
  console.log(`playbook-docs: all passed (${passed})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
