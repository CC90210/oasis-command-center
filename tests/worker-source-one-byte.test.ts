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
 * it leaves regex literals byte for byte. So regex literals are the only way
 * our own code puts such a character into the bundle, and this guard checks
 * exactly those, with the TypeScript parser rather than a pattern.
 * `—` matches the same text as a raw em dash, so escaping never changes
 * what a regex matches.
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

const WIDE = /[^\u0000-ÿ]/;

/** Every regex literal in `code` that holds a character above U+00FF, as `line: literal`. */
export function wideRegexLiterals(code: string, fileName: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = node.getText(sf);
      if (WIDE.test(text)) found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${text}`);
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
  for (const hit of wideRegexLiterals(readFileSync(file, "utf8"), rel)) offenders.push(`${rel}:${hit}`);
}

assert.deepEqual(
  offenders,
  [],
  `A regex literal holds a character above U+00FF. That doubles the whole Worker ` +
    `source in memory (see this file's header). Write each such character as a ` +
    `\\uXXXX escape, e.g. /[—–]/ -> /[\\u2014\\u2013]/:\n  ${offenders.join("\n  ")}`,
);

// PROVE THE GUARD FIRES, and that it looks only at regex literals: strings,
// templates and comments are escaped by esbuild and must not trip it.
assert.equal(wideRegexLiterals("const r = /[—–]/g;", "a.ts").length, 1, "a raw em dash in a regex is caught");
assert.equal(wideRegexLiterals("const r = /a|b/u.test(`x`) ? /•/ : /c/;", "a.ts").length, 1, "only the wide literal counts");
assert.equal(wideRegexLiterals("const x = <p>{/‣/.test(s)}</p>;", "a.tsx").length, 1, "TSX is parsed as TSX");
assert.deepEqual(
  wideRegexLiterals('const s = "—"; const t = `“${a}”`; // • note\nconst r = /[\\u2014\\u2013]/;', "a.ts"),
  [],
  "strings, templates, comments and escaped regexes pass",
);
assert.equal(wideRegexLiterals("const q = a / b / c; const r = /x/;", "a.ts").length, 0, "division is not a regex");

console.log(`worker-source-one-byte: OK — ${files.length} files, no wide character in any regex literal`);
