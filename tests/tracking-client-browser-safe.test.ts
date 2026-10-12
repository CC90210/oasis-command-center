/**
 * tracking-client-browser-safe.test.ts - Codex review, PR #598, 2026-10-12
 * [P1]: lib/offers/tracking-client.ts (imported by FormPublicClient.tsx and
 * VideoFacade.tsx, both "use client") must never pull a server-only module
 * into its import graph. It used to import the event vocabulary from
 * lib/offers/tracking-store.ts, which imports `node:crypto` and the Turso
 * client (@libsql/client) -- an in-memory esbuild check reproduced the
 * bundling failure on `node:crypto`.
 *
 * This is a STATIC source scan, not a bundler run: it reads tracking-client.ts,
 * follows every local import (relative or `@/...`) it can resolve to a real
 * file, and fails if ANY file in that reachable graph imports `node:*`,
 * `server-only`, `@libsql/client` or `@supabase/supabase-js`. Bare package
 * specifiers (react, next/server, etc.) are not local files and are not
 * followed -- a server-only *package* two hops away through, say, "react"
 * would not be this bug; the bug is always a LOCAL file importing one of
 * these directly.
 *
 * Run: node --conditions=react-server --import tsx tests/tracking-client-browser-safe.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = join(__dirname, "..");

const DISALLOWED_PREFIXES = ["node:"];
const DISALLOWED_EXACT = new Set(["server-only", "@libsql/client", "@supabase/supabase-js"]);

function isDisallowed(spec: string): boolean {
  if (DISALLOWED_PREFIXES.some((p) => spec.startsWith(p))) return true;
  return DISALLOWED_EXACT.has(spec);
}

/** Every string literal following `import ... from` or `require(...)` in one file. */
function importSpecifiersOf(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const specs: string[] = [];
  const importRe = /\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src))) specs.push(m[1]);
  while ((m = requireRe.exec(src))) specs.push(m[1]);
  return specs;
}

/** Resolve a LOCAL specifier (relative or `@/...`) to a real file, or null for a bare package. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = resolve(dirname(fromFile), spec);
  } else if (spec.startsWith("@/")) {
    base = join(ROOT, spec.slice(2));
  } else {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function walkImportGraph(entry: string): { visited: string[]; violations: Array<{ file: string; spec: string }> } {
  const visited = new Set<string>();
  const violations: Array<{ file: string; spec: string }> = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    for (const spec of importSpecifiersOf(file)) {
      if (isDisallowed(spec)) {
        violations.push({ file, spec });
        continue;
      }
      const resolved = resolveLocal(spec, file);
      if (resolved) stack.push(resolved);
    }
  }
  return { visited: [...visited], violations };
}

console.log("tracking-client-browser-safe:");

const entry = join(ROOT, "lib", "offers", "tracking-client.ts");
const { visited, violations } = walkImportGraph(entry);

if (violations.length > 0) {
  console.log("  FAIL  tracking-client.ts's import graph reaches a server-only module");
  for (const v of violations) console.log(`        ${v.file} -> "${v.spec}"`);
  process.exit(1);
}
console.log(`  ok    tracking-client.ts's import graph (${visited.length} file(s)) carries no node:*, server-only, @libsql/client or @supabase/supabase-js import`);
assert.ok(visited.length >= 1, "the walk must at least visit the entry file itself");

// A second, cheap, independent signal: the two "use client" components that
// actually trigger browser bundling must never have an IMPORT STATEMENT
// naming tracking-store.ts (even if some future refactor broke the graph
// walk above). A doc comment mentioning tracking-store.ts by name is fine
// and expected (both files document the server-side link it performs); only
// a real `from "...tracking-store"` import specifier counts here.
for (const rel of [join("components", "forms", "FormPublicClient.tsx"), join("components", "offer-pages", "VideoFacade.tsx")]) {
  const file = join(ROOT, rel);
  const hasImport = importSpecifiersOf(file).some((spec) => spec.includes("tracking-store"));
  console.log(`  ok    ${rel} has no import specifier naming tracking-store.ts: ${!hasImport}`);
  assert.ok(!hasImport, `${rel} must import lib/offers/tracking-client.ts, never tracking-store.ts, directly`);
}

console.log("tracking-client-browser-safe: all passed");
