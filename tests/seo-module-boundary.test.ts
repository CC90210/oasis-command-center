import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Adon 2026-10-07: the SEO screen must move to Gritly without a rewrite. Only lib/seo/occ.ts
// may know it lives in OCC; everything else imports the module, React, next/link or Recharts.
const ALLOWED = [/^react$/, /^next\/link$/, /^recharts$/, /^\.\.?\//, /^@\/lib\/seo\//, /^@\/components\/seo\//];
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));

// Adon 2026-10-07, found while proving this test: the brief's original `(?:from|import)\s*\(?\s*["']`
// false-positived on components/seo/FreshnessPanel.tsx's `<Item term="History from" value=.../>` --
// the word "from" inside that JSX string sits directly against its own closing quote with zero
// whitespace, which the lax pattern read as the start of an import specifier and then captured
// everything up to the next unrelated quote in the file. Every real `from "spec"` in this repo has
// exactly one space before the quote, and every dynamic import is `import(` with no space before the
// paren, so requiring that shape keeps the same semantics (every real import specifier is still
// caught) without matching incidental prose.
const IMPORT_SPEC = /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["'])/g;
const importSpecs = (src: string): string[] => [...src.matchAll(IMPORT_SPEC)].map((m) => m[1] ?? m[2]);

test("module files import only the module, React, next/link and Recharts", () => {
  const scanned = [...files("lib/seo"), ...files("components/seo")].filter((f) => /\.tsx?$/.test(f) && !f.replace(/\\/g, "/").endsWith("lib/seo/occ.ts"));
  assert.ok(scanned.length >= 10, `expected the module's files, found ${scanned.length}`);
  for (const f of scanned) {
    const specs = importSpecs(readFileSync(f, "utf8"));
    for (const s of specs) assert.ok(ALLOWED.some((re) => re.test(s)), `${f} imports ${s}`);
    assert.ok(!specs.some((s) => /seo\/occ$/.test(s)), `${f} imports the OCC adapter`);
  }
});

test("the boundary test can fail (planted OCC import is caught)", () => {
  const planted = 'import { getTenant } from "@/lib/queries";';
  const spec = importSpecs(planted);
  assert.deepEqual(spec, ["@/lib/queries"]);
  assert.ok(!ALLOWED.some((re) => re.test(spec[0])));
});
