/**
 * No regular-expression literal in shipped source may contain a character
 * above U+00FF. Write it as a \uXXXX escape instead.
 *
 * Why this matters (measured 2026-09-29): the Worker bundle is ~54M
 * characters. V8 keeps a script's source in one-byte form only while every
 * character fits in Latin-1. A single character above U+00FF stores the WHOLE
 * source as UTF-16, about 108 MiB instead of about 54 MiB. The isolate then
 * starts at ~113 of its 128 MiB before serving anything. A few requests tip it
 * over, and Cloudflare replaces it while still reporting the request `ok`. The
 * next request pays a 1.5–2.5 s cold start: page TTFB p50 was ~2.1 s. In
 * local workerd, escaping the 89 such characters cut the startup heap from
 * 112.7 to 58.4 MiB, with identical responses.
 *
 * esbuild's ASCII output escapes strings, template literals and JSX text, but
 * it leaves two things byte for byte: regex literals, and TAGGED templates
 * such as String.raw`...` (their raw text is part of their value, so it cannot
 * be rewritten). Those are the only ways our own code puts such a character
 * into the bundle, and this guard checks exactly those, with the TypeScript
 * parser rather than a pattern. In a tagged template, write the character as a
 * substitution, ${"\u2014"}; the value is unchanged.
 * `\u2014` in a regex matches the same text as a raw em dash, so escaping
 * never changes what a regex matches.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
// Everything OpenNext bundles into the server Worker. tests/, scripts/,
// workers/ (the separate cron Worker) and docs never reach it.
const SCAN_DIRS = ["app", "components", "hooks", "lib", "config", "content"];
const SCAN_FILES = ["middleware.ts"];
const SKIP_DIR = /(^|[\\/])(__tests__|node_modules|\.next|\.open-next)([\\/]|$)/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIP_DIR.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const WIDE = /[^\u0000-\u00ff]/;

/**
 * Every regex literal and tagged template in `code` that holds a character
 * above U+00FF, as `line: text` (a tagged template is cut to its first 80
 * characters).
 */
export function wideRawLiterals(code: string, fileName: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = node.getText(sf);
      if (WIDE.test(text)) found.push(`${at(node)}: ${text}`);
    } else if (ts.isTaggedTemplateExpression(node)) {
      // Only the template's own text: substitutions are ordinary expressions
      // that esbuild escapes, and are visited below like any other code.
      const tpl = node.template;
      const parts = ts.isNoSubstitutionTemplateLiteral(tpl)
        ? [tpl]
        : [tpl.head, ...tpl.templateSpans.map((s) => s.literal)];
      if (parts.some((p) => WIDE.test(p.getText(sf)))) found.push(`${at(node)}: ${node.getText(sf).slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))), ...SCAN_FILES.map((f) => join(ROOT, f))];
const offenders: string[] = [];
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  for (const hit of wideRawLiterals(readFileSync(file, "utf8"), rel)) offenders.push(`${rel}:${hit}`);
}

assert.deepEqual(
  offenders,
  [],
  `A regex literal or tagged template (String.raw) holds a character above U+00FF. ` +
    `That doubles the whole Worker source in memory (see this file's header). In a ` +
    `regex write it as a \\uXXXX escape, e.g. /[—–]/ -> /[\\u2014\\u2013]/; in a ` +
    `tagged template write it as a substitution, e.g. \${"\\u2014"}:\n  ${offenders.join("\n  ")}`,
);

// PROVE THE GUARD FIRES, and that it looks only at regex literals: strings,
// templates and comments are escaped by esbuild and must not trip it.
assert.equal(wideRawLiterals("const r = /[—–]/g;", "a.ts").length, 1, "a raw em dash in a regex is caught");
assert.equal(wideRawLiterals("const r = /a|b/u.test(`x`) ? /•/ : /c/;", "a.ts").length, 1, "only the wide literal counts");
assert.equal(wideRawLiterals("const x = <p>{/‣/.test(s)}</p>;", "a.tsx").length, 1, "TSX is parsed as TSX");
assert.deepEqual(
  wideRawLiterals('const s = "—"; const t = `“${a}”`; // • note\nconst r = /[\\u2014\\u2013]/;', "a.ts"),
  [],
  "strings, templates, comments and escaped regexes pass",
);
assert.equal(wideRawLiterals("const q = a / b / c; const r = /x/;", "a.ts").length, 0, "division is not a regex");
// Tagged templates: esbuild keeps their raw text, so a wide character there is caught in the
// head, a middle span or the tail; one inside a substitution is ordinary code and is not.
assert.equal(wideRawLiterals("const s = String.raw`a — b`;", "a.ts").length, 1, "a raw em dash in String.raw is caught");
assert.equal(wideRawLiterals("const s = String.raw`a ${x} b ${y} → c`;", "a.ts").length, 1, "in a later span too");
assert.equal(wideRawLiterals('const s = String.raw`a ${"—"} b`;', "a.ts").length, 0, "a substitution is escaped by esbuild");
assert.equal(wideRawLiterals("const s = `a — b`;", "a.ts").length, 0, "an untagged template is escaped by esbuild");

console.log(`worker-source-one-byte: OK — ${files.length} files, no wide character in any regex literal or tagged template`);
