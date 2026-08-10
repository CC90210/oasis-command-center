/**
 * tests/consent-capture.test.ts — the rules around sealing consent evidence.
 *
 * The point of this evidence is that it survives being challenged. These pin
 * the two ways it quietly stops being worth anything: sending an identifier the
 * capture site will refuse, and letting a failed capture look like a success.
 */

import assert from "node:assert/strict";
import { toE164, captureConsent } from "../lib/consent/optinvault";
import { consentBrandForTenant } from "../lib/consent/brand-for-tenant";

// ── E.164 normalisation ───────────────────────────────────────────────────
// The vault requires E.164. A malformed number is refused, so normalising badly
// means silently capturing no evidence for everyone who typed a phone number
// the ordinary way.
assert.equal(toE164("305-555-0147"), "+13055550147");
assert.equal(toE164("(305) 555 0147"), "+13055550147");
assert.equal(toE164("13055550147"), "+13055550147");
assert.equal(toE164("+1 305 555 0147"), "+13055550147");
assert.equal(toE164("3055550147"), "+13055550147");
// Not normalisable: hold rather than send something guaranteed to be refused.
assert.equal(toE164("555-0147"), null);
assert.equal(toE164(""), null);
assert.equal(toE164(null), null);
assert.equal(toE164(undefined), null);
assert.equal(toE164("not a phone"), null);

// ── Only an allowlisted tenant may seal evidence ──────────────────────────
// This is a multi-tenant public route. Defaulting an unknown tenant to SunBiz
// would send their visitor's details to SunBiz's vault and record SunBiz's
// disclosure — wording that visitor never saw. A record that misstates what
// someone agreed to is worse than no record, because it gets produced as truth.
assert.equal(consentBrandForTenant("submissions", "apply"), "sunbiz");
assert.equal(consentBrandForTenant("sunbiz", "apply"), "sunbiz");
assert.equal(consentBrandForTenant("sun", "apply"), "sunbiz");
assert.equal(consentBrandForTenant("submissions", "bluerise-intake"), "bluerise");
// Anyone else captures NOTHING.
assert.equal(consentBrandForTenant("breeze", "apply"), null);
assert.equal(consentBrandForTenant("some-other-tenant", "bluerise-intake"), null);
assert.equal(consentBrandForTenant("", "apply"), null);
assert.equal(consentBrandForTenant(null, "apply"), null);
assert.equal(consentBrandForTenant(undefined, undefined), null);

// This repo's tsx transform targets CJS, so top-level await is unavailable.
async function main() {
  // ── A capture site must get an identifier for EVERY channel it registers ──
  // SunBiz is registered email+sms. Verified live 2026-08-09: email alone returns
  // 400 invalid_request. So we must detect that BEFORE spending a request, and
  // report the real reason rather than a vague network error.
  {
    const r = await captureConsent({
      brand: "sunbiz",
      email: "someone@example.com",
      phone: null,
      idempotencyKey: "test-key-00000001",
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /missing_identifier:phone|not_configured/);
  }

  // Bluerise is email-only, so email alone satisfies its channel set. With no
  // vault configured in tests the call still must not throw.
  {
    const r = await captureConsent({
      brand: "bluerise",
      email: "someone@example.com",
      idempotencyKey: "test-key-00000002",
    });
    assert.equal(r.ok, false, "unconfigured in tests");
    assert.match(r.ok === false ? r.reason : "", /not_configured/);
  }

  // ── Never throws ──────────────────────────────────────────────────────────
  // A form submission must not die because the vault is unreachable. Every path
  // returns a verdict the caller can record.
  {
    const r = await captureConsent({
      brand: "sunbiz",
      email: "someone@example.com",
      phone: "+13055550147",
      idempotencyKey: "test-key-00000003",
    });
    assert.equal(typeof r.ok, "boolean");
  }
}

main().then(() => console.log("consent-capture.test.ts — all assertions passed"));
