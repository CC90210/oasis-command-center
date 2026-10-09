/**
 * A soft navigation must never change the page SHELL.
 * Run: node --conditions=react-server --import tsx tests/shell-boundary.test.ts
 *
 * app/layout.tsx picks the whole chrome — operator sidebar + tenant manifest, or
 * bare full-bleed marketing — from `isFullBleed`, computed from headers() in a
 * SERVER component. Next does not re-render a root layout on a client-side
 * navigation, so that choice freezes at whatever page was hard-loaded. A <Link>
 * across the boundary renders the new page inside the old page's shell.
 *
 * CC, 2026-08-14: "when I search for OasisAI.Work/contact and then click the
 * OASIS AI logo, it takes me to a page that's super zoomed in and looks warped.
 * I have to refresh the page again, and then it zooms out and I can see the
 * navigation bar on the left."
 *
 * WHY A STATIC TEST. Same reasoning as tests/portal-boundaries.test.ts: the
 * property is about the WHOLE TREE — "no marketing surface soft-navigates to an
 * ambiguous path" — and cannot be established by rendering any one component. A
 * comment in the file cannot fail a build. This can.
 *
 * It also pins the root shell's hydration (React error #418, 2026-10-08):
 * nothing app/layout.tsx draws inside <head> comes from a "use client" module,
 * and the shell's first browser render equals the server's whether the sidebar
 * is stored as collapsed or not.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

import { REPO_ROOT as ROOT, repoRelative as rel, sourceTree } from "./_tree";

import { ALL_MARKETING_PATHS, SHELL_AMBIGUOUS_PATHS } from "../lib/marketing/routes";
import { FULL_BLEED_PREFIXES, isFullBleedPath } from "../lib/os/full-bleed";
import { SIDEBAR_BOOT_SCRIPT, SIDEBAR_COLLAPSED_KEY } from "../lib/sidebar-boot";
import { isPublic, PUBLIC_PATH_PREFIXES } from "../middleware";


// Marketing surfaces: the public route group and its components.
const files = sourceTree("components/marketing", "app/(marketing)");

// ── anti-vacuity ─────────────────────────────────────────────────────
// A scan that finds nothing would pass and prove nothing.
assert.ok(
  files.length > 5,
  `only ${files.length} marketing files walked — the scan is broken, so a clean result is meaningless`,
);
assert.ok(
  files.some((f) => rel(f).endsWith("components/marketing/MarketingNav.tsx")),
  "the walk never reached MarketingNav — it cannot be proving anything",
);
assert.ok(SHELL_AMBIGUOUS_PATHS.includes("/"), '"/" is the ambiguous path this defends');

// ── the rule ─────────────────────────────────────────────────────────
// `<Link ... href="/">` in any form: same line, or href on a later line.
const LINK_BLOCK = /<Link\b[^>]*?href=\{?["'`](?<href>[^"'`]+)["'`]/gs;

const violations: string[] = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(LINK_BLOCK)) {
    const href = m.groups?.href ?? "";
    if (!SHELL_AMBIGUOUS_PATHS.includes(href)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    violations.push(
      `  ${rel(file)}:${line}\n    <Link href="${href}"> crosses the shell boundary — use a plain <a> so the browser does a FULL load`,
    );
  }
}

assert.equal(
  violations.length,
  0,
  `Shell-boundary violations (${violations.length}):\n${violations.join("\n")}\n\n` +
    `"/" is marketing for a visitor and the dashboard for a signed-in operator. A <Link>\n` +
    `soft-navigates, the Server-Component root layout does NOT re-render, and the target\n` +
    `renders inside the previous shell — no sidebar, wrong width, "zoomed in and warped".\n` +
    `See SHELL_BOUNDARY_NOTE in lib/marketing/routes.ts.`,
);

// ── the rule would actually catch something ──────────────────────────
// A clean scan means nothing unless the matcher works. Prove it on a fixture.
{
  const fixture = '<Link href="/" className="logo">x</Link>';
  const hits = [...fixture.matchAll(LINK_BLOCK)].filter((m) =>
    SHELL_AMBIGUOUS_PATHS.includes(m.groups?.href ?? ""),
  );
  assert.equal(hits.length, 1, "the matcher must catch a same-line <Link href=\"/\">");

  const safe = '<Link href="/contact">x</Link>';
  const safeHits = [...safe.matchAll(LINK_BLOCK)].filter((m) =>
    SHELL_AMBIGUOUS_PATHS.includes(m.groups?.href ?? ""),
  );
  assert.equal(safeHits.length, 0, "a marketing-to-marketing link is not a violation");
}

// ── the logos are the ones that were wrong; keep them hard ───────────
for (const f of ["components/marketing/MarketingNav.tsx", "components/marketing/MarketingFooter.tsx"]) {
  const src = readFileSync(join(ROOT, f), "utf8");
  assert.match(
    src,
    /<a href="\/"/,
    `${f} must link home with a plain <a> — this is the exact link CC reported`,
  );
}

// ── the app -> marketing direction stays hard too ────────────────────
// Already correct before this test existed, which is why only one direction
// broke. Pinned so a "tidy these up into <Link>" pass cannot undo it.
{
  const shell = readFileSync(join(ROOT, "components", "MainShell.tsx"), "utf8");
  for (const href of ["/privacy", "/terms"]) {
    assert.ok(
      shell.includes(`<a href="${href}"`),
      `MainShell must reach ${href} with a plain <a> — a <Link> would render the ` +
        `marketing page inside the operator sidebar, the same bug mirrored`,
    );
  }
}

// Every marketing path stays full-bleed, which is what makes the other links safe.
assert.ok(ALL_MARKETING_PATHS.length >= 4, "the marketing registry should not be empty");
assert.ok(
  !ALL_MARKETING_PATHS.includes("/"),
  '"/" must never be listed as a marketing path — app/layout.tsx says a "/" prefix ' +
    "would swallow every route in the app and strip the operator chrome site-wide",
);

// ── full-bleed = public (W1a: U1-16, U1-17, U1-18) ────────────────────
//
// middleware.ts PUBLIC_PATH_PREFIXES decides which pages an anonymous visitor
// may open; lib/os/full-bleed.ts decides which pages render without the OS
// shell. A public page that is not full-bleed draws the rail ("Your
// workspace", Sign out, Settings) around a visitor with no account: a signer on
// /sign/<token>, a recipient on /unsubscribe. Two hand-kept lists drifted
// exactly that way, so they are compared here against the real pages, not
// against each other's spelling ("/invite" vs "/invite/").

/** A URL for a page file: route groups vanish, a [param] becomes "x". */
function routeOf(pageFile: string): string {
  const segs = relative(join(ROOT, "app"), dirname(pageFile)).split(sep).filter(Boolean);
  return (
    "/" +
    segs
      .filter((s) => !/^\(.+\)$/.test(s))
      .map((s) => (/^\[\[?\.\.\./.test(s) ? "x/y" : /^\[.+\]$/.test(s) ? "x" : s))
      .join("/")
  );
}
const pageRoutes = sourceTree("app")
  .filter((f) => f.endsWith(`${sep}page.tsx`))
  .map((f) => ({ file: rel(f), route: routeOf(f) }));
const publicPages = pageRoutes.filter((p) => isPublic(p.route));

// anti-vacuity: the walk found the public pages this rule exists for.
for (const must of ["/sign/x", "/unsubscribe", "/link-expired", "/f/x/x", "/invite/x", "/login", "/home", "/privacy"]) {
  assert.ok(
    publicPages.some((p) => p.route === must),
    `${must} is not a public page any more (or the walk missed it), so this check proves nothing about it`,
  );
}

{
  const inShell = publicPages.filter((p) => !isFullBleedPath(p.route));
  assert.deepEqual(
    inShell.map((p) => `${p.file} (${p.route})`),
    [],
    "public in middleware.ts PUBLIC_PATH_PREFIXES but NOT full-bleed: an anonymous visitor gets the OS rail " +
      "around this page. Add its prefix to lib/os/full-bleed.ts FULL_BLEED_PREFIXES.",
  );
}

// Every page-rendering entry of the public list is covered. (The page walk
// above already implies it; this names the middleware entry when it fails.)
for (const prefix of PUBLIC_PATH_PREFIXES) {
  const pages = pageRoutes.filter((p) => isPublic(p.route) && (p.route === prefix || p.route.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)));
  for (const p of pages) {
    assert.ok(isFullBleedPath(p.route), `middleware lists ${prefix} as public, and ${p.file} under it renders inside the OS shell`);
  }
}

// The other direction: a full-bleed page that is NOT public is a signed-in
// screen that draws its own header. There are exactly two, by decision; a
// third is a deliberate edit here, never drift.
{
  const SIGNED_IN_FULL_BLEED = ["/onboarding", "/desktop-link"];
  const sample = (prefix: string) => (prefix.endsWith("/") ? `${prefix}x` : prefix);
  assert.deepEqual(
    FULL_BLEED_PREFIXES.filter((p) => !isPublic(sample(p))),
    SIGNED_IN_FULL_BLEED,
    "a full-bleed prefix that middleware does not make public renders a signed-in page with no rail",
  );
}

// /link-expired is the neutral landing for an unattributable tracking click
// (app/api/track/click): public AND full-bleed, owned by no company (U1-18).
assert.ok(isPublic("/link-expired") && isFullBleedPath("/link-expired"), "/link-expired must be public and full-bleed");
// /desktop-link draws its own "Desktop Connect" header; inside the shell it
// showed two headers and two logos (U1-16).
assert.ok(isFullBleedPath("/desktop-link"), "/desktop-link must be full-bleed");
assert.ok(!isPublic("/desktop-link"), "/desktop-link mints a pair code for a signed-in user; it stays session-gated");

// The layout reads the one list; it never keeps a copy of its own.
{
  const layout = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
  assert.match(layout, /const isFullBleed = isFullBleedPath\(pathname\);/, "app/layout.tsx decides full-bleed through lib/os/full-bleed.ts");
  assert.doesNotMatch(layout, /FULL_BLEED_PREFIXES\s*=/, "app/layout.tsx must not keep its own full-bleed list again");
}

// A full-bleed page is a shell boundary too: a <Link> from it into a shell page
// soft-navigates, the root layout does not re-render, and the dashboard renders
// with no rail. The signed-in and public full-bleed pages outside the marketing
// group leave with a plain <a>.
{
  const boundaryFiles = sourceTree("app/desktop-link", "app/sign", "app/unsubscribe", "app/link-expired", "components/esign");
  assert.ok(boundaryFiles.some((f) => rel(f) === "app/desktop-link/page.tsx"), "the walk never reached /desktop-link");
  const crossings: string[] = [];
  for (const file of boundaryFiles) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(LINK_BLOCK)) {
      const href = m.groups?.href ?? "";
      if (!href.startsWith("/") || isFullBleedPath(href.split(/[?#]/)[0])) continue;
      crossings.push(`${rel(file)}:${src.slice(0, m.index).split("\n").length}  <Link href="${href}">`);
    }
  }
  assert.deepEqual(crossings, [], "a <Link> from a full-bleed page into the OS shell renders it without the rail; use a plain <a>");
}

// -- the root layout's <head> arrives complete (React error #418, 2026-10-08) --
//
// app/layout.tsx is a Server Component. A value it imports from a "use client"
// module reaches the browser as a reference to a JS chunk, not as the value, and
// React cannot draw the element that uses it until that chunk has loaded. The
// <head> boot script was such a value (exported by the "use client" hook
// lib/useSidebarCollapsed.ts). When the chunk was still loading as hydration
// began, React paused inside <head>; React 19.2 then resumes <head> with its
// saved place in <body> overwritten by <head>'s own first child, so it looked
// for <body>'s first element among <head>'s children, found none, and threw
// #418, redrawing the whole page in the browser. A probe build that recorded
// React's state at the throw showed it on every failure the crawl caught: the
// failing element was <body>'s first child and React's cursor sat on
// <meta charset> in <head>. Nothing drawn inside <head> may come from a
// "use client" module.

/** True when a module's directive prologue says "use client". */
function isClientModule(file: string): boolean {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use client") return true;
  }
  return false;
}

/** A module specifier as app/layout.tsx writes it, to a file in the repo (or null). */
function resolveModule(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every identifier used inside the <head> element of `source`, with the module
 * it is imported from and whether that module is "use client".
 */
function headImports(source: string, fileName: string): { names: string[]; fromClient: string[]; heads: number } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const importedFrom = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const spec = stmt.moduleSpecifier.text;
    if (clause.name) importedFrom.set(clause.name.text, spec);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) if (!el.isTypeOnly) importedFrom.set(el.name.text, spec);
    }
  }
  const names = new Set<string>();
  let heads = 0;
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && importedFrom.has(node.text)) names.add(node.text);
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "head") {
      heads += 1;
      collect(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const fromClient: string[] = [];
  for (const name of names) {
    const spec = importedFrom.get(name) as string;
    const file = resolveModule(spec, fileName);
    assert.ok(file, `${rel(fileName)}: <head> uses ${name} from "${spec}", which does not resolve to a file in the repo`);
    if (isClientModule(file)) fromClient.push(`${name} from "${spec}"`);
  }
  return { names: [...names].sort(), fromClient, heads };
}

{
  const layoutFile = join(ROOT, "app", "layout.tsx");
  const head = headImports(readFileSync(layoutFile, "utf8"), layoutFile);
  // anti-vacuity: the scan found the one <head> and the boot script inside it.
  assert.equal(head.heads, 1, "app/layout.tsx should draw exactly one <head>; the scan found " + head.heads);
  assert.ok(head.names.includes("SIDEBAR_BOOT_SCRIPT"), `the scan did not see SIDEBAR_BOOT_SCRIPT inside <head> (saw: ${head.names.join(", ") || "nothing"})`);
  assert.deepEqual(
    head.fromClient,
    [],
    "app/layout.tsx draws a value from a \"use client\" module inside <head>. The browser gets a chunk " +
      "reference instead of the value, React pauses inside <head> while the chunk loads, loses its place in " +
      "<body> and throws React error #418, redrawing every page. Import it from a plain module (lib/sidebar-boot.ts).",
  );

  // The rule would catch the bug it exists for: the same <head> fed the boot
  // script from the "use client" hook module, as it was before the fix.
  const regressed = headImports(
    'import { SIDEBAR_BOOT_SCRIPT } from "@/lib/useSidebarCollapsed";\n' +
      "export default function L() { return <html><head><script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} /></head><body /></html>; }\n",
    layoutFile,
  );
  assert.deepEqual(regressed.fromClient, ['SIDEBAR_BOOT_SCRIPT from "@/lib/useSidebarCollapsed"'], "the <head> rule must flag a value from a \"use client\" module");
  assert.ok(isClientModule(join(ROOT, "lib", "useSidebarCollapsed.ts")), "lib/useSidebarCollapsed.ts is the \"use client\" hook this rule is measured against");
  assert.ok(!isClientModule(join(ROOT, "lib", "sidebar-boot.ts")), "lib/sidebar-boot.ts must stay a plain module: the root layout's <head> reads it");
}

// The boot script and the hook keep ONE storage key, so the value the script
// applies before paint is the one the hook writes when the operator toggles.
{
  assert.equal(typeof SIDEBAR_BOOT_SCRIPT, "string", "the boot script is a plain string on the server");
  assert.ok(SIDEBAR_BOOT_SCRIPT.includes(JSON.stringify(SIDEBAR_COLLAPSED_KEY)), "the boot script reads SIDEBAR_COLLAPSED_KEY");
  const hook = readFileSync(join(ROOT, "lib", "useSidebarCollapsed.ts"), "utf8");
  assert.match(hook, /import \{ SIDEBAR_COLLAPSED_KEY \} from "@\/lib\/sidebar-boot";/, "the hook reads the key from lib/sidebar-boot.ts");
  assert.ok(!hook.includes(SIDEBAR_COLLAPSED_KEY), "the hook must not spell the storage key itself (two copies drift)");
}

// -- the shell's first browser render is the server's (React error #418) ------
//
// The second cause, found by the same probe once <head> was fixed: for anyone
// who had collapsed the sidebar, EVERY page failed to hydrate. The hook read
// the stored choice during its first render, so the browser drew the floating
// reopen button the server never drew, and React found <aside> where it
// expected that <button>. The shell is drawn here as the server draws it and as
// a browser's first render draws it with the sidebar stored collapsed and
// expanded (tests/shell-hydration.render.ts); all three must be the same
// markup, byte for byte.
//
// The third: React replays the PARENT of an element that was still waiting on
// a JS chunk when hydration reached it, and replaying a host element (<div>)
// claims it again from a cursor that already points inside it. The page element
// Next sends carries app/error.tsx as a module reference, and MainShell put it
// straight inside a <div>; the probe caught #418 there once the first two were
// fixed. The page's direct parent must be a component (PageSlot), on a normal
// page and on the chat shell.
{
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" };
  const tokens = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t.length > 0);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--conditions" || tokens[i] === "-C") {
      i += 1;
      continue;
    }
    if (/^(--conditions=|-C=)/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  if (kept.length) childEnv.NODE_OPTIONS = kept.join(" ");
  else delete childEnv.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/shell-hydration.render.ts"], { cwd: ROOT, encoding: "utf8", env: childEnv });
  assert.equal(r.status, 0, `tests/shell-hydration.render.ts failed:\n${r.stderr}`);
  const html = JSON.parse(r.stdout) as {
    server: string;
    collapsedFirstRender: string;
    expandedFirstRender: string;
    storedCollapsed: { states: boolean[]; writes: string[]; attribute: string[]; final: string };
    pageParent: Record<string, string>;
  };

  assert.deepEqual(
    html.pageParent,
    { "/settings": "PageSlot", "/agent": "PageSlot" },
    "the page element sits straight inside a host element in components/MainShell.tsx. When it is still waiting on a " +
      "JS chunk as hydration reaches it, React replays that element, claims it from the wrong place and throws #418. " +
      "Wrap {children} in <PageSlot>.",
  );

  // anti-vacuity: it drew the real shell, rail and reopen button included.
  assert.match(html.server, /id="sidebar-drawer"/, "the render did not reach the rail");
  assert.match(html.server, /aria-label="Open navigation"/, "the render did not reach the reopen button");

  assert.equal(
    html.collapsedFirstRender,
    html.server,
    "with the sidebar stored as collapsed, the browser's first render of the shell differs from the server's: " +
      "React error #418 on every page for that person. Read the stored choice after mount (lib/useSidebarCollapsed.ts) " +
      "and let html[data-sidebar] drive what shows before then.",
  );
  assert.equal(html.expandedFirstRender, html.server, "with the sidebar stored as expanded, the first browser render must equal the server's");

  // After hydration the stored choice is applied, and the default the first
  // render used is never written over it: a collapsed sidebar stays collapsed,
  // in storage and on <html>, with no flicker to expanded.
  const after = html.storedCollapsed;
  assert.equal(after.states[0], false, "the hook's first render must be the server's (not collapsed)");
  assert.equal(after.states[after.states.length - 1], true, "after mount the hook must apply the stored collapsed choice");
  assert.deepEqual(after.writes.filter((w) => !w.endsWith("=true")), [], "the hook wrote over the stored collapsed choice before reading it");
  assert.deepEqual(after.attribute.filter((v) => v !== "collapsed"), [], "html[data-sidebar] flipped to expanded during startup for a collapsed viewer");
  assert.equal(after.final, "collapsed", "html[data-sidebar] ends as the stored choice");

  // The reopen button is always drawn and shown by CSS, never by React state.
  const reopen = html.server.match(/<button[^>]*aria-label="Open navigation"[^>]*>/)?.[0] ?? "";
  assert.match(reopen, /class="os-rail-reopen /, "the reopen button carries os-rail-reopen, the class app/globals.css shows it by");
  assert.doesNotMatch(reopen, /(^|\s|")(hidden|md:inline-flex)(\s|")/, "a display utility on the reopen button would override the CSS that shows it");

  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
  assert.match(css, /\.os-rail-reopen\s*\{\s*display:\s*none;\s*\}/, "app/globals.css hides the reopen button by default");
  assert.match(
    css,
    /@media \(min-width: 768px\) \{\s*html\[data-sidebar="collapsed"\] #sidebar-drawer \{\s*transform: translateX\(-100%\);\s*\}\s*html\[data-sidebar="collapsed"\] \.os-rail-reopen \{\s*display: inline-flex;\s*\}\s*\}/,
    "app/globals.css must take the collapsed rail off-screen and show the reopen button from html[data-sidebar] at md+",
  );
}

console.log(
  `shell-boundary: OK — ${files.length} marketing files scanned, ` +
    `${SHELL_AMBIGUOUS_PATHS.length} ambiguous path(s), 0 soft-nav boundary crossings; ` +
    `${publicPages.length} public pages, every one full-bleed; <head> holds no "use client" value; ` +
    `the shell's first browser render equals the server's, sidebar collapsed or not; the page sits in a PageSlot`,
);
