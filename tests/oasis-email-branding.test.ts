/**
 * oasis-email-branding.test.ts — an OASIS email must look like OASIS, end to end.
 *
 * CC sent a real lead email on 2026-09-08 and screenshotted the result. The
 * footer was right (OASIS AI Solutions, Montreal) and the SIGNATURE directly
 * above it said "SunBiz Submissions". Two different companies in one message,
 * to a cold prospect.
 *
 * The cause was a hardcoded fallback in resolveSignerForOperator: any operator
 * not on the SunBiz agent roster signed as that shared identity, and
 * conaugh@oasisai.work is not on it. So EVERY OASIS rep email was signed by
 * another business.
 *
 * These tests pin both halves of the message — who signs it and what the footer
 * says — and pin that the other portal's behaviour is untouched, because that
 * identity is correct where it belongs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSignerForOperator } from "../lib/config/agents";
import { appendSignatureAndFooter } from "../lib/config/email-signature";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("oasis-email-branding:");

run("an OASIS operator signs with their own name, never another company", () => {
  const signer = resolveSignerForOperator("conaugh@oasisai.work", { brand: "oasis" });
  assert.equal(signer.name, "Conaugh");
  assert.ok(!signer.name.toLowerCase().includes("sunbiz"), "signed as the wrong company");
  assert.ok(!signer.email.includes("sunbizfunding"), "the wrong reply identity");

  // A rep, not just the owner.
  assert.equal(resolveSignerForOperator("ariel@oasisai.work", { brand: "oasis" }).name, "Ariel");
  // Address shapes that are not a bare first name.
  assert.equal(resolveSignerForOperator("conaugh.mckenna@oasisai.work", { brand: "oasis" }).name, "Conaugh");
  assert.equal(resolveSignerForOperator("jo_tran@oasisai.work", { brand: "oasis" }).name, "Jo");
});

run("a whole OASIS message names OASIS and nobody else", () => {
  const signer = resolveSignerForOperator("ariel@oasisai.work", { brand: "oasis" });
  const body = appendSignatureAndFooter("Hi simon,\n\nThanks for taking my call.", {
    signer,
    brand: "oasis",
  });

  // The exact strings from the screenshot that must never appear again.
  for (const wrong of [
    "SunBiz Submissions",
    "SunBiz Funding LLC",
    "Hallandale",
    "submitted a funding inquiry",
  ]) {
    assert.ok(!body.includes(wrong), `an OASIS email still says "${wrong}"`);
  }

  assert.match(body, /\n\nAriel/, "the rep does not sign it");
  assert.match(body, /OASIS AI Solutions, Montreal, QC, Canada/, "no OASIS identification");
  assert.match(body, /UNSUBSCRIBE/, "no opt-out instruction");
  assert.ok(!body.includes("—"), "an em dash reached the prospect");
});

run("the other portal's shared identity is untouched", () => {
  // That identity is CORRECT where it belongs, and the same operator runs those
  // flows. A domain-based heuristic would have silently re-signed them, which
  // is the cross-portal bleed this change exists to stop — so the fallback is
  // driven by an explicit brand, never by the sender's address.
  const noBrand = resolveSignerForOperator("conaugh@oasisai.work");
  assert.equal(noBrand.name, "SunBiz Submissions", "an unbranded caller's behaviour changed");

  const other = resolveSignerForOperator("someone@example.com", { brand: "sunbiz" });
  assert.equal(other.name, "SunBiz Submissions");
});

run("the lead-email route passes the brand, or the fallback returns", () => {
  // resolveSignerForOperator defaults to the other portal's identity. A caller
  // that forgets the brand gets it back silently, which is exactly how this
  // shipped. Assert the wiring, since no unit test on the helper can see it.
  const route = readFileSync("app/api/leads/[id]/email/route.ts", "utf8");
  assert.match(
    route,
    /resolveSignerForOperator\(sess\.email, \{ brand \}\)/,
    "the lead-email route does not tell the signer which brand it is sending",
  );
});
