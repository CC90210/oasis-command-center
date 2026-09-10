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
  assert.match(body, /OASIS AI Solutions/, "no OASIS identification");
  assert.match(body, /6993 Decarie Blvd/, "OASIS identification has no street address");
  assert.match(body, /UNSUBSCRIBE/, "no opt-out instruction");
  assert.ok(!body.includes("—"), "an em dash reached the prospect");
});

run("the other portal's shared identity is untouched", () => {
  // That identity is CORRECT where it belongs, and the same operator runs those
  // flows. A domain-based heuristic would have silently re-signed them, which
  // is the cross-portal bleed this change exists to stop — so the fallback is
  // driven by an explicit brand, never by the sender's address.
  // REWRITTEN 2026-09-09. This asserted that an unbranded caller still got
  // "SunBiz Submissions" -- i.e. it pinned the fail-open as correct. That
  // default is exactly what signed OASIS cold email as the client. An
  // unbranded caller now REFUSES rather than picking a company.
  assert.throws(
    () => resolveSignerForOperator("conaugh@oasisai.work", undefined as never),
    /brand is required/,
    "an unbranded caller must refuse, not fall back to the other company",
  );

  const other = resolveSignerForOperator("someone@example.com", { brand: "sunbiz" });
  assert.equal(other.name, "SunBiz Submissions");
});

run("the brand reaches the signer through EVERY door, not just the reported one", () => {
  // 1. appendSignatureAndFooter resolves a signer itself when the caller passes
  //    none. Without the brand it returned the other portal's name and put it
  //    above an OASIS footer - the same defect through the back door.
  const noSigner = appendSignatureAndFooter("Body.", {
    fromAddress: "ariel@oasisai.work",
    brand: "oasis",
  });
  assert.ok(
    !noSigner.includes("SunBiz Submissions"),
    "an OASIS email with no explicit signer is still signed by the other company",
  );
  assert.match(noSigner, /\n\nAriel/, "the fallback signer did not resolve to the sender");

  // ...and with no brand it must REFUSE. This previously asserted the footer
  // helper still returned SunBiz's identity for an unbranded caller, which is
  // the same fail-open one layer down.
  assert.throws(
    () => appendSignatureAndFooter("Body.", { fromAddress: "someone@example.com" } as never),
    /brand is required|no footer for brand/,
    "an unbranded footer must refuse, not default to another company",
  );

  // 2. The template-send route resolves a brand and then has to USE it. It
  //    computed one on the line above the signer call and passed it to the
  //    gateway while signing without it.
  const templates = readFileSync("app/api/templates/send/route.ts", "utf8");
  assert.match(
    templates,
    /resolveSignerForOperator\(sess\.email, \{ brand \}\)/,
    "the template-send route signs without the brand it already resolved",
  );

  // 3. The signature module itself.
  const sig = readFileSync("lib/config/email-signature.ts", "utf8");
  assert.match(
    sig,
    /resolveSignerForOperator\(opts\.fromAddress, \{ brand: opts\.brand \}\)/,
    "the signature fallback drops the brand",
  );
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

run("the sign-off names the person whose address is printed under it", () => {
  // CC, 2026-09-09, with a screenshot: an email signed "Conaugh" with
  // "ariel@oasisai.work" printed directly beneath it. Two different people.
  //
  // The route took signerName from whoever pressed the button and signerEmail
  // from the lead's owner. CC dispatched a lead of Ariel's, so the prospect was
  // told to reply to Ariel by a message signed by CC. Whoever is NAMED must be
  // whoever is REACHABLE, or the signature is a promise the message cannot keep.
  const route = readFileSync("app/api/leads/[id]/email/route.ts", "utf8");

  assert.match(
    route,
    /const replyToAddress = pickReplyTo\(copyList\)/,
    "the reply-to address must be resolved once and reused, not recomputed per use",
  );
  assert.match(
    route,
    /const messageSigner = replyToAddress\s*\n?\s*\? resolveSignerForOperator\(replyToAddress, \{ brand \}\)/,
    "the signer must be derived from the reply-to address, not from the acting operator",
  );
  assert.match(
    route,
    /signerName: messageSigner\?\.name \?\? null/,
    "the HTML sign-off name must come from messageSigner",
  );
  assert.match(
    route,
    /signerEmail: replyToAddress/,
    "the HTML sign-off address must be the reply-to",
  );
  assert.match(
    route,
    /signer: messageSigner,/,
    "the plain-text alternative must sign as the SAME person as the HTML",
  );

  // And the old shape must be gone, in both halves.
  assert.ok(
    !/signerName: signer\?\.name/.test(route),
    "the sign-off name is still taken from the acting operator",
  );

  // The rule itself, exercised: a rep's address yields that rep's own name.
  assert.equal(
    resolveSignerForOperator("ariel@oasisai.work", { brand: "oasis" }).name,
    "Ariel",
    "a lead owned by Ariel must sign as Ariel",
  );
  assert.equal(
    resolveSignerForOperator("schneur@oasisai.work", { brand: "oasis" }).name,
    "Schneur",
  );
});
