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
// paren, so requiring that shape keeps the same semantics without matching incidental prose.
//
// Fix round 1 (review finding): that first fix dropped bare side-effect imports (`import "mod";`,
// e.g. lib/seo/occ.ts:6 `import "server-only";`) -- with only the from/dynamic-import branches,
// `import "@/lib/supabase-server";` in a lib/seo or components/seo file would extract nothing and
// sail past the only test enforcing the movable-module rule. Added a third, explicit branch for
// `import` + required whitespace + quote, and anchored `from`/`import` on `\b` (defensive; the real
// guard against the FreshnessPanel false positive is still the required `\s+` before the quote --
// `\bfrom` alone would still match "History from"" since a space already precedes "from").
const IMPORT_SPEC = /(?:\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["'])/g;
const importSpecs = (src: string): string[] => [...src.matchAll(IMPORT_SPEC)].map((m) => m[1] ?? m[2] ?? m[3]);

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

test("the extractor captures every real import form and nothing from incidental prose", () => {
  assert.deepEqual(importSpecs('import Foo from "pkg-default";'), ["pkg-default"]);
  assert.deepEqual(importSpecs('import { Foo } from "pkg-named";'), ["pkg-named"]);
  assert.deepEqual(importSpecs('import type { T } from "pkg-type";'), ["pkg-type"]);
  assert.deepEqual(
    importSpecs('import {\n  Foo,\n  Bar,\n} from "pkg-multiline";'),
    ["pkg-multiline"],
  );
  assert.deepEqual(importSpecs('export { a } from "pkg-export-named";'), ["pkg-export-named"]);
  assert.deepEqual(importSpecs('export * from "pkg-export-star";'), ["pkg-export-star"]);
  assert.deepEqual(importSpecs('import "pkg-side-effect";'), ["pkg-side-effect"]);
  assert.deepEqual(importSpecs('const m = await import("pkg-dynamic");'), ["pkg-dynamic"]);
  // The FreshnessPanel shape that broke the original regex: "from" directly against its own
  // closing quote, zero whitespace, inside ordinary JSX text -- must capture nothing.
  assert.deepEqual(importSpecs('<Item term="History from" value={x} />'), []);
});
