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
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { REPO_ROOT as ROOT, repoRelative as rel, sourceTree } from "./_tree";

import { ALL_MARKETING_PATHS, SHELL_AMBIGUOUS_PATHS } from "../lib/marketing/routes";
import { FULL_BLEED_PREFIXES, isFullBleedPath } from "../lib/os/full-bleed";
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

console.log(
  `shell-boundary: OK — ${files.length} marketing files scanned, ` +
    `${SHELL_AMBIGUOUS_PATHS.length} ambiguous path(s), 0 soft-nav boundary crossings; ` +
    `${publicPages.length} public pages, every one full-bleed`,
);
