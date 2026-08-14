/**
 * The build must not depend on a network fetch.
 * Run: node --conditions=react-server --import tsx tests/font-selfhost.test.ts
 *
 * `next/font/google` downloads the font binaries from fonts.gstatic.com AT BUILD
 * TIME, so a hiccup at Google fails a deploy that is otherwise deterministic:
 *
 *   2026-08-13  Vercel 104cd22   Failed to fetch `Space Grotesk` from Google Fonts
 *                                (reported as errorCode "lint_or_type_error",
 *                                 which sent the first diagnosis the wrong way)
 *   2026-08-14  GitHub Actions   same failure, same font, unrelated change
 *
 * CC, 2026-08-14: "make sure that all functionality throughout the software is
 * built and then correctly maintained so that, down the line, when things get
 * changed, it doesn't affect it in any way that causes it to break for some
 * random reason."
 *
 * The fonts are vendored in app/fonts/ and loaded with next/font/local. This test
 * exists because the tempting "fix" for a font problem is to reach for
 * next/font/google again, and that reintroduces the outage.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", ".next", ".git", "__pycache__"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");
const files = [
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "components")),
  ...walk(join(ROOT, "lib")),
];

// ── anti-vacuity ─────────────────────────────────────────────────────
assert.ok(files.length > 200, `only ${files.length} files walked — the scan is broken`);
assert.ok(
  files.some((f) => rel(f) === "app/(marketing)/layout.tsx"),
  "the walk never reached the marketing layout — it cannot be proving anything",
);

// ── nothing may fetch a font at build time ───────────────────────────
const offenders = files.filter((f) => /from\s+["']next\/font\/google["']/.test(readFileSync(f, "utf8")));
assert.deepEqual(
  offenders.map(rel),
  [],
  `next/font/google downloads from fonts.gstatic.com during \`next build\`, so an outage ` +
    `there fails this deploy for a reason unrelated to the change. Vendor the .woff2 into ` +
    `app/fonts/ and use next/font/local instead — see app/fonts/OFL.md.`,
);

// ── the marketing layout actually loads the vendored files ───────────
const layout = readFileSync(join(ROOT, "app", "(marketing)", "layout.tsx"), "utf8");
assert.match(layout, /from "next\/font\/local"/, "the marketing layout must load fonts locally");

const referenced = [...layout.matchAll(/path:\s*"\.\.\/fonts\/([\w.-]+\.woff2)"/g)].map((m) => m[1]);
assert.ok(referenced.length >= 8, `expected the 8 vendored faces, found ${referenced.length}`);
for (const file of referenced) {
  const p = join(ROOT, "app", "fonts", file);
  assert.ok(existsSync(p), `app/(marketing)/layout.tsx references app/fonts/${file}, which is missing`);
  assert.ok(statSync(p).size > 4096, `app/fonts/${file} is suspiciously small — a truncated download?`);
}

// The CSS variables the stylesheets consume must not drift.
for (const v of ["--font-display", "--font-body", "--font-data"]) {
  assert.ok(layout.includes(v), `${v} must still be declared, or the marketing type silently falls back`);
}

// ── licence note travels with the binaries ───────────────────────────
assert.ok(
  existsSync(join(ROOT, "app", "fonts", "OFL.md")),
  "vendored OFL fonts must ship their licence note",
);

// ── the rule would actually catch something ──────────────────────────
{
  const fixture = 'import { Space_Grotesk } from "next/font/google";';
  assert.match(fixture, /from\s+["']next\/font\/google["']/, "the matcher must catch a real import");
  const safe = 'import localFont from "next/font/local";';
  assert.ok(
    !/from\s+["']next\/font\/google["']/.test(safe),
    "next/font/local is not a violation",
  );
}

console.log(
  `font-selfhost: OK — ${files.length} files scanned, 0 build-time font fetches, ` +
    `${referenced.length} vendored faces present`,
);
