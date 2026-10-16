/**
 * tests/public-form-not-found.test.ts - a public form link with nothing to show
 * (form switched off, page not published, retired or mistyped link) gets a
 * public page, not the signed-in app's "doesn't exist in your workspace / Back
 * to Today" (CC, 2026-10-16: /command, /protocol and /community reached it
 * while their forms were off).
 *
 * Proves: app/f/not-found.tsx exists and is noindex; the visitor-facing page
 * never mentions a workspace or points into the app; only OASIS's own links
 * get "Book a call", so a client's visitor is never sent to OASIS; the OASIS
 * slug is the one the forms use.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AI_AUDIT_TENANT_SLUG } from "../lib/forms/oasis-ai-audit-seed";
import { isFullBleedPath } from "../lib/os/full-bleed";
import { matchesPathPrefix } from "../lib/path-prefix";
import { isPublic } from "../middleware";

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

console.log("public form not found");

const route = "app/f/not-found.tsx";
const component = "components/forms/PublicFormNotFound.tsx";

check("every /f link has its own not-found page, kept out of search", () => {
  assert.ok(existsSync(route), `${route} is missing: /f falls through to the signed-in app's page`);
  const src = readFileSync(route, "utf8");
  assert.match(src, /PublicFormNotFound/);
  assert.match(src, /robots:\s*\{\s*index:\s*false/);
});

check("the page never talks about a workspace or points into the app", () => {
  const src = readFileSync(component, "utf8");
  const visible = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(visible, /workspace/i, "a visitor is told about a workspace");
  assert.doesNotMatch(visible, /Back to Today|href="\/today"/, "a visitor is pointed into the app");
});

check("only OASIS's own links offer Book a call", () => {
  const src = readFileSync(component, "utf8");
  const root = `/f/${AI_AUDIT_TENANT_SLUG}`;
  assert.ok(src.includes(`"${root}"`), "the OASIS slug differs from the one the forms use");
  assert.match(src, /isOasis = matchesPathPrefix\(pathname, OASIS_FORMS_ROOT\)/);
  // The workspace root itself counts, a lookalike slug never does (Codex on #656).
  assert.ok(matchesPathPrefix(root, root), `${root} itself does not get the OASIS actions`);
  assert.ok(matchesPathPrefix(`${root}/command`, root));
  assert.ok(!matchesPathPrefix(`${root}-copy/command`, root), "a lookalike workspace gets OASIS's actions");
  // The booking link sits inside the isOasis branch, never outside it.
  assert.match(src, /\{isOasis \? \([\s\S]*href="\/book"[\s\S]*\) : \(/);
  assert.equal((src.match(/href="\/book"/g) || []).length, 1, "a second Book a call link exists outside the OASIS branch");
});

check("every /f link shape the form routes do not match reaches the same public page (Codex on #656)", () => {
  // /f, /f/<workspace>, and a lead link with extra segments. A catch-all cannot
  // sit beside [tenant_slug], so each shape has its own page calling notFound().
  for (const page of [
    "app/f/page.tsx",
    "app/f/[tenant_slug]/page.tsx",
    "app/f/[tenant_slug]/[form_slug]/[lead_token]/[...rest]/page.tsx",
  ]) {
    assert.ok(existsSync(page), `${page} is missing: that link shape falls through to the app's not-found`);
    assert.match(readFileSync(page, "utf8"), /notFound\(\)/, `${page} does not call notFound()`);
  }
  // A page a signed-out visitor cannot reach proves nothing: every shape is
  // public and drawn without the app's shell, /f itself included.
  for (const path of ["/f", "/f/oasis-ai-cc", "/f/x/y/z/extra"]) {
    assert.ok(isPublic(path), `${path} sends a signed-out visitor to /login`);
    assert.ok(isFullBleedPath(path), `${path} renders inside the app's shell`);
  }
  for (const signedIn of ["/forms", "/forms/publish"]) {
    assert.ok(!isPublic(signedIn), `the /f entry made the signed-in page ${signedIn} public`);
  }
});

check("the link to the site root is a full page load, not a soft navigation (Codex on #656)", () => {
  const src = readFileSync(component, "utf8");
  assert.match(src, /<a href="\/" /, "Visit OASIS AI is not a plain anchor");
  assert.doesNotMatch(src, /<Link href="\/"/, "a soft navigation to / draws the dashboard without its shell for a signed-in visitor");
});

console.log("public-form-not-found: all passed");
