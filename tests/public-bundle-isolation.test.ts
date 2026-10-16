/**
 * The public site must not download the signed-in app.
 * Run: node --conditions=react-server --import tsx tests/public-bundle-isolation.test.ts
 *
 * Next bundles every client module a layout or page IMPORTS into that route's
 * JavaScript, whichever branch actually renders. app/layout.tsx is the root
 * layout of every public page and imports MainShell for the signed-in shell.
 * MainShell imported ChatWidget statically, and ChatWidget imports the browser
 * Supabase client, so every anonymous visitor to oasisai.work downloaded the
 * Command Center chat and the whole Supabase auth library (chunk 8297, 178 KB
 * raw / 50 KB gzipped) and never ran either. PageSpeed counts that script time
 * against the largest paint (2026-10-16: simulated LCP 3.4 s on every page).
 *
 * WHY A STATIC TEST. What lands in a route's bundle is decided by the static
 * import graph, so the graph is what this checks: from the root layout and every
 * public page, follow static imports, mark a module as browser code once the
 * walk passes through a "use client" file, and refuse any browser module that
 * reaches @supabase/* or the chat widget. A dynamic import() is exactly how code
 * leaves the graph, so it is not followed. `import type` is erased and skipped.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

import { REPO_ROOT as ROOT, repoRelative as rel, sourceTree } from "./_tree";

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  for (const ext of EXTENSIONS) if (existsSync(join(base, "index" + ext))) return join(base, "index" + ext);
  return null;
}

function isClientDirective(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) return false;
    if (stmt.expression.text === "use client") return true;
  }
  return false;
}

/** Static, value-carrying module specifiers of one file. */
function staticImports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      const onlyTypes =
        clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly);
      if (onlyTypes) continue;
      out.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      out.push(stmt.moduleSpecifier.text);
    }
  }
  return out;
}

type BrowserReach = { modules: Map<string, string[]>; packages: Map<string, string[]> };

/**
 * Every module and package that ends up in the browser bundle for these roots,
 * each with the import chain that brought it in (for a readable failure).
 */
function browserReach(roots: string[]): BrowserReach {
  const modules = new Map<string, string[]>();
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue: Array<{ file: string; client: boolean; chain: string[] }> = roots.map((file) => ({
    file,
    client: false,
    chain: [rel(file)],
  }));
  while (queue.length) {
    const { file, client: parentClient, chain } = queue.shift()!;
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const client = parentClient || isClientDirective(sf);
    const key = `${file}|${client}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (client && !modules.has(rel(file))) modules.set(rel(file), chain);
    for (const spec of staticImports(sf)) {
      const target = resolveLocal(spec, file);
      if (target) {
        queue.push({ file: target, client, chain: [...chain, rel(target)] });
      } else if (client && !spec.startsWith(".") && !spec.startsWith("@/")) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!packages.has(pkg)) packages.set(pkg, [...chain, spec]);
      }
    }
  }
  return { modules, packages };
}

// The app/(marketing) route group is the public site: its layout and pages.
const marketingDir = join(ROOT, "app", "(marketing)");
const publicRoots = [
  join(ROOT, "app", "layout.tsx"),
  ...sourceTree("app/(marketing)").filter((f) => /[\\/](layout|page)\.tsx$/.test(f)),
];
assert.ok(existsSync(marketingDir), "app/(marketing) is the public route group this test is measured against");
assert.ok(publicRoots.length > 10, `expected the root layout plus the public pages, found ${publicRoots.length}`);

// The walker must see a real browser-side Supabase import, or a broken walker
// would pass this test by finding nothing. The login form genuinely needs it.
{
  const login = browserReach([join(ROOT, "app", "login", "LoginForm.tsx")]);
  assert.ok(
    login.packages.has("@supabase/ssr"),
    "self-test: the walker must find @supabase/ssr behind app/login/LoginForm.tsx (it imports lib/supabase-browser)",
  );
  const shellToChat = browserReach([join(ROOT, "components", "ChatWidget.tsx")]);
  assert.ok(shellToChat.modules.has("lib/supabase-browser.ts"), "self-test: ChatWidget reaches lib/supabase-browser.ts");
}

const reach = browserReach(publicRoots);
assert.ok(reach.modules.has("components/MainShell.tsx"), "the root layout ships MainShell to the browser; if it stops, revisit this test");

const FORBIDDEN_MODULES = ["components/ChatWidget.tsx", "lib/supabase-browser.ts"];
const offences: string[] = [];
for (const m of FORBIDDEN_MODULES) {
  const chain = reach.modules.get(m);
  if (chain) offences.push(`${m}\n    via ${chain.join(" -> ")}`);
}
for (const [pkg, chain] of reach.packages) {
  if (pkg.startsWith("@supabase/")) offences.push(`${pkg}\n    via ${chain.join(" -> ")}`);
}
assert.deepEqual(
  offences,
  [],
  "Public pages statically import signed-in app code, so every visitor downloads it. " +
    "Load it with next/dynamic (or import() in an effect) from the signed-in component instead:\n  " +
    offences.join("\n  "),
);

console.log(
  `public-bundle-isolation: ${publicRoots.length} public entry files, ${reach.modules.size} browser modules, ` +
    `no chat widget and no @supabase/* among them`,
);
