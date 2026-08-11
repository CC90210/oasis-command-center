/**
 * tests/sms-lawful-basis.test.ts — may we lawfully text this person?
 *
 * The channel fallback converts a message that needed no permission (email,
 * CAN-SPAM) into one that does (text, TCPA — $500 a message, $1,500 if wilful,
 * no cap, private right of action, and Florida on top). These assertions are
 * the line between a routing convenience and a statutory claim.
 */

import assert from "node:assert/strict";
import { smsLawfulBasis, mayTextFor } from "../lib/sms/lawful-basis";

// ── A sealed vault record is the only provable tier ───────────────────────
{
  const v = smsLawfulBasis({
    source: "MCA WEBFORMS MAY 25-29",
    consent_receipt: { claimed_captured: true, consent_id: "consent_abc123def456" },
  });
  assert.equal(v.basis, "consent_artifact");
  assert.equal(v.mayText, true, "a sealed record beats even a purchased source");
}

// A client-asserted capture with no id is NOT evidence. /api/forms/submit is a
// public endpoint, so `claimed_captured` alone can be forged.
{
  const v = smsLawfulBasis({ source: "cold_call_tracker", consent_receipt: { claimed_captured: true } });
  assert.equal(v.basis, "none", "claimed_captured without a consent_id proves nothing");
  assert.equal(v.mayText, false);
}
// A recorded FAILURE must never read as consent.
{
  const v = smsLawfulBasis({
    source: "cold_call_tracker",
    consent_receipt: { claimed_captured: false, reason: "missing_identifier:phone" },
  });
  assert.equal(v.basis, "none");
}

// ── They came to us: defensible ───────────────────────────────────────────
// 555 of 562 public_form leads. They asked SunBiz for funding, so a text about
// that funding is responsive rather than a solicitation.
for (const source of ["public_form", "dropped_application", "referral", "website", "inbound_form"]) {
  const v = smsLawfulBasis({ source });
  assert.equal(v.basis, "inquiry", `${source} should be an inbound enquiry`);
  assert.equal(v.mayText, true);
}
// Case and padding must not change the answer.
assert.equal(smsLawfulBasis({ source: "  Public_Form  " }).basis, "inquiry");

// ── Purchased and cold-dialled: we cannot prove anything ──────────────────
// 240 purchased phone-only leads and 119 cold-called, measured 2026-08-10.
// Every one is phone-only, which is exactly why the fallback would otherwise
// route all of them into SMS.
for (const source of ["MCA WEBFORMS MAY 25-29", "cold_call_tracker", "purchased", "scraped", "vendor"]) {
  const v = smsLawfulBasis({ source });
  assert.equal(v.basis, "none", `${source} must not qualify`);
  assert.equal(v.mayText, false);
}

// ── Fails closed on anything unrecognised ─────────────────────────────────
// A wrong "yes" is a statutory claim; a wrong "no" is an email instead of a
// text. The default has to be the cheap mistake.
assert.equal(smsLawfulBasis({}).mayText, false);
assert.equal(smsLawfulBasis({ source: "" }).mayText, false);
assert.equal(smsLawfulBasis({ source: "some_new_partner_feed" }).mayText, false);
assert.equal(smsLawfulBasis({ source: null }).mayText, false);

// ── Transactional is a different question from marketing ──────────────────
// Chasing a signature or a document on a deal already in motion is not a
// solicitation, and treating it as one would stall live deals.
{
  const cold = { source: "MCA WEBFORMS MAY 25-29" };
  assert.equal(mayTextFor(cold, "marketing").mayText, false);
  assert.equal(mayTextFor(cold, "transactional").mayText, true);
  assert.match(mayTextFor(cold, "transactional").reason, /not a solicitation/);
}
// The basis itself is still reported honestly even when the send is allowed,
// so telemetry cannot later claim we had consent we never had.
assert.equal(mayTextFor({ source: "cold_call_tracker" }, "transactional").basis, "none");

console.log("sms-lawful-basis.test.ts — all assertions passed");
