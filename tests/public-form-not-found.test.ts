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
  assert.ok(src.includes(`"/f/${AI_AUDIT_TENANT_SLUG}/"`), "the OASIS slug differs from the one the forms use");
  // The booking link sits inside the isOasis branch, never outside it.
  assert.match(src, /\{isOasis \? \([\s\S]*href="\/book"[\s\S]*\) : \(/);
  assert.equal((src.match(/href="\/book"/g) || []).length, 1, "a second Book a call link exists outside the OASIS branch");
});

console.log("public-form-not-found: all passed");
