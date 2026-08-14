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
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { ALL_MARKETING_PATHS, SHELL_AMBIGUOUS_PATHS } from "../lib/marketing/routes";

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

// Marketing surfaces: the public route group and its components.
const files = [
  ...walk(join(ROOT, "components", "marketing")),
  ...walk(join(ROOT, "app", "(marketing)")),
];

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

console.log(
  `shell-boundary: OK — ${files.length} marketing files scanned, ` +
    `${SHELL_AMBIGUOUS_PATHS.length} ambiguous path(s), 0 soft-nav boundary crossings`,
);
