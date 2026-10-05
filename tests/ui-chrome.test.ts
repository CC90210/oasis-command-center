/**
 * ui-chrome.test.ts - every page under the OS shell draws the OS frame, and
 * the pre-OS PageHeader only ever loses importers (W1a, U1-01).
 *
 * WHY. app/layout.tsx puts the OS rail and breadcrumb around ANY page, while
 * each page picked its own header: 76 drew the pre-OS PageHeader against 30 on
 * PageFrame, so a rail click landed on a May-era title bar beside the OS rail,
 * and nothing tied a page's chrome to the shell. PageHeader IS PageFrame now
 * (components/Card.tsx), which moves every one of those pages onto the OS type
 * scale in one change. Three checks keep it that way:
 *
 *   1. PageHeader renders PageFrame with title / subtitle / action mapped, and
 *      adds no wrapper of its own (executed, not read).
 *   2. Every app page outside the full-bleed list (lib/os/full-bleed.ts)
 *      renders PageFrame or PageHeader: itself, through a component it renders,
 *      or through a layout above it. A page that renders neither is a page with
 *      no title under the OS rail. A page that renders no JSX at all only
 *      redirects or 404s, and is counted, not judged. The exceptions are listed
 *      below, each with its reason.
 *   3. A RATCHET on PageHeader's importers. tests/ui-chrome-baseline.json lists
 *      the files under app/ and components/ that import it today. A file not on
 *      the list that imports it fails (new pages use PageFrame), and a listed
 *      file that no longer imports it fails until its entry is deleted, so the
 *      list only shrinks, like .github/ui/ui-slop-baseline.json. The W1b sweep
 *      works it down to nothing.
 *
 * Static on purpose, like tests/portal-boundaries.test.ts: the property is about
 * the whole tree, and a page no test renders is exactly the page this has to
 * catch. Components are followed by the JSX tag each one renders, through its
 * imports, so <Card> (which also lives in components/Card.tsx) is not a frame.
 *
 * Run: node --conditions=react-server --import tsx tests/ui-chrome.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import * as React from "react";
import ts from "typescript";

import { REPO_ROOT as ROOT, repoRelative as rel, sourceTree } from "./_tree";
import { PageHeader } from "../components/Card";
import { PageFrame } from "../components/os/PageFrame";
import { isFullBleedPath } from "../lib/os/full-bleed";

// tsconfig sets jsx:"preserve", so tsx compiles JSX with the classic runtime,
// which expects a global React.
(globalThis as unknown as { React: typeof React }).React = React;

const BASELINE_FILE = join(ROOT, "tests", "ui-chrome-baseline.json");
const CARD = join(ROOT, "components", "Card.tsx");
const PAGE_FRAME = join(ROOT, "components", "os", "PageFrame.tsx");
const FRAME_TAGS = new Set(["PageFrame", "PageHeader"]);

/**
 * Pages outside the full-bleed list that may render neither frame. Each one is
 * a screen that owns the whole canvas by design; a new entry needs a reason a
 * reviewer can check, and an entry whose page gains a frame must be deleted.
 */
const NO_FRAME_EXCEPTIONS: Readonly<Record<string, string>> = {
  "app/agent/page.tsx":
    "Admin > Coding harness. MainShell draws the persistent ChatWidget full-screen over this route (isChatShellPath); the page body is only the fallback shown if that chat cannot mount.",
  "app/schedule/page.tsx":
    "The calendar (CalendarApp) owns the viewport (MainShell isFullBleedPath) and draws its own week header in place of a title row.",
  "app/web-leads/[id]/page.tsx":
    "A rep's full-screen battle card; BattleCard draws its own hero header. U1-23 moves it inside PageFrame in the W1b sweep (an APEX-shared surface: lease and ack first).",
};

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).message || String(e)).split("\n").join("\n        ")}`);
  }
}

// ── source model ───────────────────────────────────────────────────────────

type Binding = { file: string; name: string };
type Rendered = { tags: Set<string>; hasJsx: boolean };
type ModuleInfo = {
  /** local name -> where it was imported from (repo files only). */
  imports: Map<string, Binding>;
  /** top-level declaration ("default" for the default export) -> what it renders. */
  decls: Map<string, Rendered>;
  /** "default" -> the local name it exports, when the default export is an identifier. */
  aliases: Map<string, string>;
  /** Does this file import PageHeader from components/Card.tsx? */
  importsPageHeader: boolean;
  /** Any JSX anywhere in the file. */
  anyJsx: boolean;
};

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Component tags (capitalised, not namespaced) and whether any JSX at all is rendered. */
function rendered(node: ts.Node): Rendered {
  const out: Rendered = { tags: new Set(), hasJsx: false };
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) out.hasJsx = true;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const name = n.tagName.getText();
      if (/^[A-Z]/.test(name) && !name.includes(".")) out.tags.add(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const modules = new Map<string, ModuleInfo>();
function moduleInfo(file: string): ModuleInfo {
  const cached = modules.get(file);
  if (cached) return cached;
  const src = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const info: ModuleInfo = { imports: new Map(), decls: new Map(), aliases: new Map(), importsPageHeader: false, anyJsx: rendered(sf).hasJsx };
  modules.set(file, info);

  const isDefaultExport = (n: ts.Declaration) =>
    (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.ExportDefault) === ts.ModifierFlags.ExportDefault;
  const bind = (local: string, target: string, imported: string) => {
    info.imports.set(local, { file: target, name: imported });
    if (target === CARD && imported === "PageHeader") info.importsPageHeader = true;
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = resolveSpecifier(file, st.moduleSpecifier.text);
      const clause = st.importClause;
      if (!target || !clause || clause.isTypeOnly) continue;
      if (clause.name) bind(clause.name.text, target, "default");
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (!el.isTypeOnly) bind(el.name.text, target, (el.propertyName ?? el.name).text);
        }
      }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      // `export { X } from "./y"` re-exports X: follow it, and it counts as an import.
      const target = resolveSpecifier(file, st.moduleSpecifier.text);
      if (target && !st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) bind(el.name.text, target, (el.propertyName ?? el.name).text);
      }
    } else if (ts.isFunctionDeclaration(st) && st.body) {
      const r = rendered(st.body);
      if (st.name) info.decls.set(st.name.text, r);
      if (isDefaultExport(st)) info.decls.set("default", r);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) info.decls.set(d.name.text, rendered(d.initializer));
      }
    } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
      if (ts.isIdentifier(st.expression)) info.aliases.set("default", st.expression.text);
      else info.decls.set("default", rendered(st.expression));
    }
  }
  return info;
}

/** Does the component `name`, declared in or imported into `file`, render the OS frame? */
function drawsFrame(file: string, name: string, seen = new Set<string>()): boolean {
  const key = `${file}#${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (file === PAGE_FRAME && name === "PageFrame") return true;
  if (file === CARD && name === "PageHeader") return true;
  const info = moduleInfo(file);
  const alias = info.aliases.get(name);
  if (alias) return drawsFrame(file, alias, seen);
  const decl = info.decls.get(name);
  if (!decl) {
    const imported = info.imports.get(name);
    return imported ? drawsFrame(imported.file, imported.name, seen) : false;
  }
  for (const tag of decl.tags) {
    if (FRAME_TAGS.has(tag)) return true;
    if (info.decls.has(tag) && drawsFrame(file, tag, seen)) return true;
    const imported = info.imports.get(tag);
    if (imported && drawsFrame(imported.file, imported.name, seen)) return true;
  }
  return false;
}

/** Does a page's default export render anything? A page that does not only redirects or 404s. */
function rendersJsx(pageFile: string): boolean {
  const info = moduleInfo(pageFile);
  return info.decls.get(info.aliases.get("default") ?? "default")?.hasJsx === true;
}

/** URL for a page file: route groups vanish, [param] becomes a sample segment. */
function routeOf(pageFile: string): string {
  const segs = relative(join(ROOT, "app"), dirname(pageFile)).split(sep).filter(Boolean);
  const out = segs
    .filter((s) => !/^\(.+\)$/.test(s))
    .map((s) => (/^\[\[?\.\.\./.test(s) ? "x/y" : /^\[.+\]$/.test(s) ? "x" : s));
  return "/" + out.join("/");
}

/** Every nested layout above a page. The root app/layout.tsx is the shell itself, not a frame. */
function layoutsAbove(pageFile: string): string[] {
  const out: string[] = [];
  const app = join(ROOT, "app");
  for (let dir = dirname(pageFile); dir.startsWith(app) && dir !== app; dir = dirname(dir)) {
    const layout = join(dir, "layout.tsx");
    if (existsSync(layout)) out.push(layout);
  }
  return out;
}

const textOf = (node: unknown): string =>
  JSON.stringify(node, (key, value) => (key.startsWith("_") ? undefined : value)) ?? "";

// ── 1. PageHeader IS PageFrame ─────────────────────────────────────────────
console.log("ui-chrome:");

check("PageHeader renders PageFrame with title, subtitle and action mapped, and no body", () => {
  const action = React.createElement("a", { href: "/pipeline/new" }, "New lead");
  const el = PageHeader({ title: "Pipeline", subtitle: "Every open deal", action }) as React.ReactElement<Record<string, unknown>>;
  assert.ok(React.isValidElement(el), "PageHeader returns an element");
  assert.equal(el.type, PageFrame, "the element is the OS PageFrame, not a header of its own");
  assert.equal(el.props.title, "Pipeline");
  assert.equal(el.props.subtitle, "Every open deal");
  assert.equal(el.props.actions, action, "action -> actions");
  assert.equal(el.props.children, null, "a PageHeader sits above the body; it does not wrap one");
  assert.equal(el.props.className, undefined, "no wrapper class: padding and width belong to MainShell's canvas");
});

check("the frame PageHeader draws is the OS type scale, with no padding or motion of its own", () => {
  const el = PageHeader({ title: "Forms", subtitle: "Every form" }) as React.ReactElement<Parameters<typeof PageFrame>[0]>;
  const frame = PageFrame(el.props);
  const html = textOf(frame);
  assert.match(html, /text-xl font-semibold leading-7 tracking-\[-0\.01em\] text-fg/, "title 20/28 semibold");
  assert.match(html, /mt-1 text-\[13px\] leading-5 text-fg-muted/, "subtitle 13/20 muted");
  assert.doesNotMatch(html, /animate-|\bp-\d|\bpx-\d|\bpy-\d|sm:p-|lg:p-/, "no padding or animation in the frame");
});

check("components/Card.tsx PageHeader delegates; it draws no header markup of its own", () => {
  const card = readFileSync(CARD, "utf8");
  const body = card.slice(card.indexOf("export function PageHeader"), card.indexOf("export function Tag"));
  assert.match(body, /<PageFrame title=\{title\} subtitle=\{subtitle\} actions=\{action\}>/);
  assert.doesNotMatch(body, /<header|<h1|className=/, "PageHeader must delegate, not re-implement");
});

// ── 2. every shell page draws the frame ────────────────────────────────────
const pages = sourceTree("app").filter((f) => f.endsWith(`${sep}page.tsx`));

check("anti-vacuity: the walk reached every page", () => {
  // 130 on 2026-10-01; W1b deletes some legacy pages, so the floor sits well below.
  assert.ok(pages.length >= 80, `only ${pages.length} pages walked`);
  for (const must of ["app/page.tsx", "app/agents/page.tsx", "app/pipeline/page.tsx", "app/t/[slug]/marketplace/page.tsx"]) {
    assert.ok(pages.some((p) => rel(p) === must), `the walk never reached ${must}`);
  }
});

const noFrame: string[] = [];
const rendersNothing: string[] = [];
let judged = 0;
let fullBleed = 0;
for (const page of pages) {
  if (isFullBleedPath(routeOf(page))) {
    fullBleed += 1;
    continue;
  }
  if (!rendersJsx(page)) {
    rendersNothing.push(rel(page));
    continue;
  }
  judged += 1;
  const framed = drawsFrame(page, "default") || layoutsAbove(page).some((l) => drawsFrame(l, "default"));
  if (!framed) noFrame.push(rel(page));
}

check("the detector follows components, and <Card> is not a frame", () => {
  assert.equal(drawsFrame(join(ROOT, "app", "team", "[dept]", "page.tsx"), "default"), true, "DepartmentTab renders PageFrame");
  assert.equal(drawsFrame(CARD, "Card"), false, "Card shares a file with PageHeader but is not a frame");
  assert.equal(drawsFrame(CARD, "PageHeader"), true);
  assert.equal(rendersJsx(join(ROOT, "app", "agents", "page.tsx")), true);
});

check("a page counted as rendering nothing really only redirects or 404s", () => {
  // A page wrongly counted here would escape the frame check, so each one must
  // call redirect / permanentRedirect / notFound and contain no JSX at all.
  assert.ok(rendersNothing.length < pages.length / 5, `${rendersNothing.length} pages render nothing; the JSX detector is suspect`);
  for (const p of rendersNothing) {
    const src = readFileSync(join(ROOT, p), "utf8");
    assert.match(src, /\b(redirect|permanentRedirect|notFound)\(/, `${p} renders no JSX but neither redirects nor 404s`);
    assert.equal(moduleInfo(join(ROOT, p)).anyJsx, false, `${p} contains JSX outside its default export; judge it by hand`);
  }
});

check("every page under the OS shell renders PageFrame or PageHeader (or is a listed exception)", () => {
  const unexpected = noFrame.filter((p) => !(p in NO_FRAME_EXCEPTIONS));
  assert.deepEqual(
    unexpected,
    [],
    "these pages render inside the OS rail with no OS title row. Wrap the page in <PageFrame> " +
      "(components/os/PageFrame.tsx); add an exception here only for a screen that owns the whole canvas.",
  );
});

check("every listed exception still renders no frame (the list cannot outlive its reasons)", () => {
  for (const [page, reason] of Object.entries(NO_FRAME_EXCEPTIONS)) {
    assert.ok(reason.length > 40, `${page} needs a real reason`);
    assert.ok(existsSync(join(ROOT, page)), `${page} no longer exists; delete the exception`);
    assert.ok(noFrame.includes(page), `${page} renders a frame now; delete the exception`);
  }
});

// ── 3. the PageHeader ratchet ──────────────────────────────────────────────
const importers = sourceTree("app", "components")
  .filter((f) => f !== CARD && moduleInfo(f).importsPageHeader)
  .map(rel)
  .sort();
const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { known: string[] };

check("the baseline is a sorted, unique list of real files", () => {
  // It may reach zero: that is the point of the W1b sweep.
  assert.ok(Array.isArray(baseline.known));
  assert.deepEqual([...baseline.known].sort(), baseline.known, "keep the baseline sorted");
  assert.equal(new Set(baseline.known).size, baseline.known.length, "no duplicates");
  for (const f of baseline.known) assert.ok(existsSync(join(ROOT, f)), `${f} is gone; delete it from the baseline`);
});

check("no file outside the baseline imports PageHeader (new pages use PageFrame)", () => {
  const added = importers.filter((f) => !baseline.known.includes(f));
  assert.deepEqual(
    added,
    [],
    'import { PageFrame } from "@/components/os/PageFrame" instead; title, subtitle and actions are the same props.',
  );
});

check("every baseline entry still imports PageHeader (the baseline only shrinks)", () => {
  const stale = baseline.known.filter((f) => !importers.includes(f));
  assert.deepEqual(stale, [], `these no longer import PageHeader; delete them from ${rel(BASELINE_FILE)}`);
});

check("the ratchet detector agrees with a plain-text scan, and ignores a Card-only import", () => {
  // An independent reading of the same question, so a parser regression cannot
  // empty the list and pass every check above. It stays valid as the list
  // shrinks to nothing.
  const IMPORT = /import\s*\{[^}]*\bPageHeader\b[^}]*\}\s*from\s*["'](?:@\/components\/Card|(?:\.\.?\/)+(?:components\/)?Card)["']/;
  const byText = sourceTree("app", "components")
    .filter((f) => f !== CARD && IMPORT.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort();
  assert.deepEqual(importers, byText);
  assert.equal(moduleInfo(join(ROOT, "app", "agents", "page.tsx")).importsPageHeader, false, "AI team imports Card and EmptyState only");
});

console.log(
  `ui-chrome: ${pages.length} pages (${judged} judged, ${fullBleed} full-bleed, ${rendersNothing.length} only redirect or 404, ` +
    `${Object.keys(NO_FRAME_EXCEPTIONS).length} listed exceptions); ${importers.length} PageHeader importers, ` +
    `${baseline.known.length} in the baseline; ${failures} failed\n  redirect/404 only: ${rendersNothing.join(", ")}`,
);
if (failures > 0) process.exit(1);
