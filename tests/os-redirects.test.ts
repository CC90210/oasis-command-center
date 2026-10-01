/**
 * Every redirect in middleware.ts lands on a page that exists.
 *
 * WHY. A redirect to a missing route converts a working bookmark into a 404,
 * which is worse than leaving the old page up — and it fails silently, because
 * the redirect itself answers a healthy 307. The OASIS OS moves routes around
 * (plan W3), and OASIS's reps open /pipeline, /web-leads and /training from
 * bookmarks every day. So every target is resolved against app/ here, the same
 * way Next's router would: route groups `(x)` are transparent and `[param]`
 * segments match anything.
 *
 * It also pins the two Phase-1 decisions: /feed is a real Team page again (its
 * old redirect to /operations must not come back), and /money is a real page,
 * never a redirect.
 *
 * Run: node --conditions=react-server --import tsx tests/os-redirects.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { OS_PATTERN_REDIRECTS, OS_REDIRECTS, osPatternRedirect } from "../lib/os/redirects";
import { MARKETING_HOME_PATH } from "../lib/marketing/routes";

const APP = join(process.cwd(), "app");
const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js", "page.mdx"];

function hasPage(dir: string): boolean {
  return PAGE_FILES.some((f) => existsSync(join(dir, f)));
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  } catch {
    return [];
  }
}

/** Does `urlPath` resolve to a page under app/, the way the App Router would? */
function routeExists(urlPath: string): boolean {
  const pathOnly = urlPath.split(/[?#]/)[0];
  const segments = pathOnly.split("/").filter(Boolean);
  const walk = (dir: string, i: number): boolean => {
    if (i === segments.length && hasPage(dir)) return true;
    for (const child of childDirs(dir)) {
      const next = join(dir, child);
      if (/^\(.+\)$/.test(child)) {
        if (walk(next, i)) return true; // route group: consumes no segment
      } else if (i < segments.length && (child === segments[i] || /^\[[^.\]]+\]$/.test(child))) {
        if (walk(next, i + 1)) return true;
      } else if (/^\[\[?\.\.\..+\]?\]$/.test(child)) {
        if (hasPage(next)) return true; // catch-all
      }
    }
    return false;
  };
  return walk(APP, 0);
}

// ── the resolver itself, against routes that certainly exist / do not ─────
assert.equal(routeExists("/"), true, "app/page.tsx");
assert.equal(routeExists("/pipeline"), true);
assert.equal(routeExists("/settings/audit-log"), true);
assert.equal(routeExists("/projects/abc-123"), true, "[id] segment");
assert.equal(routeExists("/privacy"), true, "(marketing) route group is transparent");
assert.equal(routeExists("/definitely-not-a-route"), false);
assert.equal(routeExists("/settings/definitely-not-a-section"), false);

// ── the OS moves ──────────────────────────────────────────────────────────
for (const [from, to] of Object.entries(OS_REDIRECTS)) {
  assert.ok(to.startsWith("/") && !to.startsWith("//"), `${from} must redirect same-origin (got ${to})`);
  assert.notEqual(from, to, `${from} redirects to itself`);
  assert.ok(!(to in OS_REDIRECTS), `${from} → ${to} is a redirect chain`);
  assert.ok(routeExists(to), `${from} → ${to}, but ${to} is not a page under app/`);
}
assert.equal(OS_REDIRECTS["/integrations"], "/settings/connections", "Connections moved into Settings");
assert.ok(!("/feed" in OS_REDIRECTS), "/feed is a real Team page — it no longer redirects to /operations");
assert.ok(!("/money" in OS_REDIRECTS), "/money is a real page, never a redirect");

// ── the pattern moves: the AI team left /t/<slug> (W1a, U1-04) ────────────
// "New teammate", the template tiles and a custom teammate's chat opened
// /t/<slug>/marketplace/new and /t/<slug>/agent/<agent>, which switched the OS
// rail off for the legacy manifest sidebar. Both moved to OS pages that read the
// session's workspace; the old URLs are 308s (middleware.ts, pinned by
// execution in tests/middleware-prefix.test.ts).
{
  assert.deepEqual(
    OS_PATTERN_REDIRECTS.map((r) => r.route),
    ["/t/[slug]/marketplace/new", "/t/[slug]/agent/[agent]"],
    "the two AI team moves, and only those",
  );
  for (const r of OS_PATTERN_REDIRECTS) {
    // The old route is a real page folder (it keeps its own owner-or-operator
    // gate in case the redirect is ever removed), and a URL of its shape moves.
    assert.ok(routeExists(r.route), `${r.route} is not a page under app/`);
    const sample = r.route.replace(/\[[^\]]+\]/g, (seg) => (seg === "[slug]" ? "acme-roofing" : "outreach-sniper"));
    const to = osPatternRedirect(sample);
    assert.ok(to, `${sample} does not match its own move`);
    assert.ok(to!.startsWith("/") && !to!.startsWith("//"), `${sample} must move same-origin`);
    assert.ok(routeExists(to!), `${sample} -> ${to}, but ${to} is not a page under app/`);
    assert.ok(!(to! in OS_REDIRECTS) && osPatternRedirect(to!) === null, `${sample} -> ${to} is a redirect chain`);
  }
  assert.equal(osPatternRedirect("/t/acme-roofing/marketplace/new"), "/agents/new");
  assert.equal(osPatternRedirect("/t/acme-roofing/agent/outreach-sniper"), "/agents/outreach-sniper");
  // The targets are the OS pages themselves, not the catch-all.
  assert.ok(existsSync(join(APP, "agents", "new", "page.tsx")), "app/agents/new/page.tsx");
  assert.ok(existsSync(join(APP, "agents", "[slug]", "page.tsx")), "app/agents/[slug]/page.tsx");
  // Nothing else under /t/ moves: the marketplace list and an agent's detail
  // page stay (inside the OS shell on the viewer's own slug), as does every
  // manifest page.
  for (const stays of [
    "/t/acme-roofing",
    "/t/acme-roofing/leads",
    "/t/acme-roofing/marketplace",
    "/t/acme-roofing/marketplace/outreach-sniper",
    "/t/acme-roofing/marketplace/new/extra",
    "/t/acme-roofing/agent",
    "/t/acme-roofing/agent/outreach-sniper/history",
    "/agents/new",
  ]) {
    assert.equal(osPatternRedirect(stays), null, `${stays} must not move`);
  }
}

// ── middleware.ts uses them, and carries no stale literal of its own ──────
const middleware = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
const block = middleware.match(/const REDIRECT_MAP[^=]*=\s*\{([\s\S]*?)\n\s*\};/);
assert.ok(block, "middleware.ts must declare REDIRECT_MAP");
assert.match(block![1], /\.\.\.OS_REDIRECTS/, "REDIRECT_MAP must spread lib/os/redirects.ts OS_REDIRECTS");
const literals = [...block![1].matchAll(/^\s*"([^"]+)"\s*:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]] as const);
for (const [from, to] of literals) {
  assert.ok(routeExists(to), `middleware REDIRECT_MAP ${from} → ${to}, but ${to} is not a page`);
}
assert.ok(!literals.some(([from]) => from === "/feed"), "the /feed → /operations redirect must not come back");
assert.ok(!literals.some(([from]) => from === "/money"), "/money must not redirect");
// The one computed entry: the marketing home collapses onto "/".
assert.match(block![1], /\[MARKETING_HOME_PATH\]:\s*"\/"/);
assert.ok(routeExists(MARKETING_HOME_PATH), `${MARKETING_HOME_PATH} must exist for the "/" rewrite to land`);
// The pattern moves run in middleware too, as permanent redirects that keep
// the query (?template= from a tile, ?edit= from a teammate's configure panel).
assert.match(middleware, /const movedTo = osPatternRedirect\(pathname\);/, "middleware must apply OS_PATTERN_REDIRECTS");
assert.match(middleware, /target\.search = req\.nextUrl\.search;\s*return NextResponse\.redirect\(target, 308\);/);

// ── every internal link in the app lands somewhere (2026-09-30) ───────────
//
// The audit found links that answered 404 to whoever clicked them: seven
// redirects to /auth/login (a route that never existed; sign-in is /login) on
// the Training and Objections pages, the Drips activity table linking each lead
// to /leads/<id> (never a route; leads open at /pipeline/<id>), and SunBiz pages
// linking /leads. Nothing checked, because each link is a string. So every
// LITERAL internal href and redirect target in app/, components/ and lib/ is
// read here with the TypeScript parser (comments are never mistaken for code)
// and must resolve to a page, a route handler, a public file or a redirect.
// A `${...}` segment matches any [param] folder. A page whose first statement
// is notFound() (a retired route: /start, /configure...) and a route handler
// that only answers the retired 404 (/contacts, /metrics, /templates...:
// lib/os/retired-routes.ts) do NOT count as existing, so nothing may link to
// one. Paths under /t/ are the tenant
// catch-all's (app/t/[slug]/[...path]) and are exempt, as are the template
// navs in lib/manifest/templates.ts: finalizeManifestFromWizard rewrites every
// one of them under /t/<slug>. The exemption stops at the retired SunBiz slug:
// /t/sun has no manifest since 2026-10-01 (OS plan W0, audit U1-22), so a
// link under it is a dead link like any other.

const ROOT = process.cwd();
const ROUTE_FILES = ["route.ts", "route.tsx", "route.js"];
const META_ROUTES: Record<string, string> = { "sitemap.ts": "/sitemap.xml", "robots.ts": "/robots.txt" };

/** A page file whose default export does nothing but call notFound(). */
function isRetiredPage(file: string): boolean {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const st of sf.statements) {
    const isDefault =
      ts.isFunctionDeclaration(st) &&
      (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.ExportDefault) === ts.ModifierFlags.ExportDefault;
    if (!isDefault || !st.body) continue;
    const first = st.body.statements[0];
    return (
      !!first &&
      ts.isExpressionStatement(first) &&
      ts.isCallExpression(first.expression) &&
      ts.isIdentifier(first.expression.expression) &&
      first.expression.expression.text === "notFound"
    );
  }
  return false;
}

/** The app/ folder a URL lands in for `files`, or null. Same walk as routeExists. */
function resolveDir(urlPath: string, files: string[]): string | null {
  const segments = urlPath.split(/[?#]/)[0].split("/").filter(Boolean);
  const has = (dir: string) => files.some((f) => existsSync(join(dir, f)));
  const walk = (dir: string, i: number): string | null => {
    if (i === segments.length && has(dir)) return dir;
    for (const child of childDirs(dir)) {
      const next = join(dir, child);
      if (/^\(.+\)$/.test(child)) {
        const r = walk(next, i);
        if (r) return r;
      } else if (/^\[\[\.\.\..+\]\]$/.test(child)) {
        if (has(next)) return next;
      } else if (/^\[\.\.\..+\]$/.test(child)) {
        if (i < segments.length && has(next)) return next;
      } else if (i < segments.length && (child === segments[i] || /^\[[^.\]]+\]$/.test(child))) {
        const r = walk(next, i + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(APP, 0);
}

function livePage(urlPath: string): boolean {
  const dir = resolveDir(urlPath, PAGE_FILES);
  if (!dir) return false;
  const file = PAGE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))!;
  return !isRetiredPage(file);
}

/**
 * A route handler that only answers the retired 404 (lib/os/retired-routes.ts:
 * /contacts, /metrics, /templates...). It exists so the status is a real 404,
 * not so anything can link to it.
 */
function isRetiredRoute(file: string): boolean {
  return /from\s+["']@\/lib\/os\/retired-routes["']/.test(readFileSync(file, "utf8"));
}

function liveRoute(urlPath: string): boolean {
  const dir = resolveDir(urlPath, ROUTE_FILES);
  if (!dir) return false;
  const file = ROUTE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))!;
  return !isRetiredRoute(file);
}

const NEXT_CONFIG_REDIRECTS = [...readFileSync(join(ROOT, "next.config.js"), "utf8").matchAll(/source:\s*"(\/[^"]*)"/g)]
  .map((m) => m[1])
  .filter((s) => !s.includes(":"));
const REDIRECT_SOURCES = new Set<string>([...Object.keys(OS_REDIRECTS), ...literals.map(([from]) => from), MARKETING_HOME_PATH, ...NEXT_CONFIG_REDIRECTS]);

function resolves(urlPath: string): boolean {
  const pathOnly = urlPath.split(/[?#]/)[0] || "/";
  if (REDIRECT_SOURCES.has(pathOnly)) return true;
  if (livePage(pathOnly)) return true;
  if (liveRoute(pathOnly)) return true;
  const metaFile = Object.entries(META_ROUTES).find(([, url]) => url === pathOnly);
  if (metaFile && existsSync(join(APP, metaFile[0]))) return true;
  const pub = join(ROOT, "public", pathOnly);
  return existsSync(pub) && statSync(pub).isFile();
}

/**
 * A literal as a URL path: `${...}` becomes a [param] segment. A placeholder
 * glued to other text inside a segment ends the literal there (`/x${q}` is
 * /x); one at the very start means the URL is computed, not literal.
 */
const PARAM = "\u0000";
function literalPath(node: ts.Node): string | null {
  let text: string;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
  else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((s) => PARAM + s.literal.text).join("");
  else return null;
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const pathPart = text.split(/[?#]/)[0];
  const out: string[] = [];
  for (const seg of pathPart.split("/").slice(1)) {
    if (seg === PARAM) out.push("__param__");
    else if (seg.includes(PARAM)) {
      const before = seg.slice(0, seg.indexOf(PARAM));
      if (before) out.push(before);
      break;
    } else out.push(seg);
  }
  return "/" + out.join("/");
}

const NAVIGATION_CALLS = new Set(["redirect", "permanentRedirect", "push", "replace"]);
type Found = { file: string; line: number; path: string; source: string };

/** Every literal internal href / navigation target in one source text. */
function linksIn(src: string, file: string): Found[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Found[] = [];
  const add = (node: ts.Node | undefined) => {
    if (!node) return;
    const inner = ts.isJsxExpression(node) ? node.expression : ts.isParenthesizedExpression(node) ? node.expression : node;
    if (!inner) return;
    const path = literalPath(inner);
    if (path) found.push({ file, line: sf.getLineAndCharacterOfPosition(inner.getStart()).line + 1, path, source: inner.getText() });
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === "href") add(n.initializer);
    else if (ts.isPropertyAssignment(n) && n.name.getText().replace(/["']/g, "") === "href") add(n.initializer);
    else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      // push/replace only on a router, never Array.prototype.push.
      const onRouter = !ts.isPropertyAccessExpression(callee) || /router/i.test(callee.expression.getText());
      if (NAVIGATION_CALLS.has(name) && onRouter) add(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// The extractor itself, against the exact shapes this check exists to catch.
{
  const sample = [
    'redirect("/auth/login?next=/training");',
    "const a = <a href={`/leads/${r.leadId}`}>x</a>;",
    'const nav = [{ href: "/pipeline", label: "P" }];',
    "router.push(`/sequences/${id}/edit`);",
    "items.push('/not-a-link');",
    "// <a href=\"/in-a-comment\">",
    "const b = <a href={`${base}/computed`}>x</a>;",
    "const c = <a href={`/pipeline${qs ? `?${qs}` : \"\"}`}>x</a>;",
  ].join("\n");
  const got = linksIn(sample, "sample.tsx").map((f) => f.path);
  assert.deepEqual(got, ["/auth/login", "/leads/__param__", "/pipeline", "/sequences/__param__/edit", "/pipeline"]);
  assert.equal(resolves("/auth/login"), false, "/auth/login never existed");
  assert.equal(resolves("/leads/abc"), false, "/leads/<id> never existed");
  assert.equal(resolves("/login?next=%2Ftraining"), true);
  assert.equal(resolves("/pipeline/abc"), true);
  assert.equal(resolves("/api/health"), true, "a route handler resolves");
  assert.equal(resolves("/welcome"), true, "a next.config redirect source resolves");
  assert.equal(resolves("/start"), false, "a page that only calls notFound() is retired, not a destination");
  assert.equal(resolves("/contacts"), false, "a route that only answers the retired 404 is not a destination");
}

/**
 * Dead links in files this change may not edit, each named with its owner.
 * An entry here is a TODO with a test behind it: the check below fails when
 * the link is fixed and the entry is left behind, so the list can only shrink.
 */
const KNOWN_DEAD: ReadonlyArray<{ file: string; path: string; why: string }> = [
  {
    file: "app/page.tsx",
    path: "/t/sun",
    why: "the Today dispatcher's SunBiz branch still redirects a session on the retired profile to its shell; app/page.tsx belongs to the OS shell track (W1a), not W0.",
  },
];
const EXEMPT_FILES = new Set(["lib/manifest/templates.ts"]);

/**
 * Tenant slugs whose /t/<slug> shell is retired. app/t/[slug] matches any slug
 * on disk, so the resolver alone would call /t/sun a page; the loader answers
 * notFound() for it (no seed, no row), which makes every link under it dead.
 */
const RETIRED_TENANT_SLUGS = new Set(["sun"]);

/** Dead: a retired tenant shell, or anything outside the live tenant catch-all that resolves nowhere. */
function isDeadLink(path: string): boolean {
  // literalPath() already drops ?query and #hash; strip here too so the slug
  // check holds for any caller, not only the extractor.
  const p = path.split(/[?#]/)[0];
  if (p.startsWith("/t/") && RETIRED_TENANT_SLUGS.has(p.split("/")[2])) return true;
  if (p === "/t" || p.startsWith("/t/")) return false;
  return !resolves(p);
}
assert.equal(isDeadLink("/t/acme/leads"), false, "a live tenant's catch-all is exempt");
assert.equal(isDeadLink("/t/__param__"), false, "a computed slug is some live tenant's");
assert.equal(isDeadLink("/t/sun"), true, "the retired SunBiz shell");
assert.equal(isDeadLink("/t/sun/lenders"), true);
assert.equal(isDeadLink("/t/sun?tab=lenders"), true, "a query string does not hide the retired shell");
assert.equal(isDeadLink("/t/sun#deals"), true, "nor does a hash");
assert.equal(isDeadLink("/t/sunrise/leads"), false, "a slug that merely starts with sun");
assert.equal(isDeadLink("/pipeline"), false);
assert.equal(isDeadLink("/leads/abc"), true);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const all: Found[] = [];
for (const base of ["app", "components", "lib"]) {
  for (const file of sourceFiles(join(ROOT, base))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (EXEMPT_FILES.has(rel)) continue;
    all.push(...linksIn(readFileSync(file, "utf8"), rel));
  }
}
assert.ok(all.length > 300, `the link scan found only ${all.length} literals; the extractor is broken`);

const dead = all.filter((f) => isDeadLink(f.path));
const unexpected = dead.filter((d) => !KNOWN_DEAD.some((k) => k.file === d.file && k.path === d.path));
assert.deepEqual(
  unexpected.map((d) => `${d.file}:${d.line}  ${d.source}  ->  ${d.path}`),
  [],
  "these links land on no page, route handler, public file or redirect (or on a retired page)",
);
for (const k of KNOWN_DEAD) {
  assert.ok(
    dead.some((d) => d.file === k.file && d.path === k.path),
    `KNOWN_DEAD lists ${k.file} -> ${k.path}, which no longer dead-ends. Delete the entry.`,
  );
}

console.log(
  `os-redirects: OK — ${Object.keys(OS_REDIRECTS).length} OS redirect(s) + ${literals.length} literal(s), every target is a page; ` +
    `${all.length} literal internal links checked (${KNOWN_DEAD.length} known dead, owned elsewhere)`,
);
