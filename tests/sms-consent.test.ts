/**
 * tests/sms-consent.test.ts — the gate that decides whether a text is legal.
 *
 * TCPA puts the burden of proving consent on the DEFENDANT. A boolean flag
 * proves nothing; the record of what the person was shown does. Damages are
 * $500/message, $1,500 willful, no cap, private right of action.
 *
 * So these tests are mostly about REFUSING to send. That is the point.
 */

import assert from "node:assert/strict";
import { readConsentArtifact, readCurrentHttpsConsentArtifact, smsGate } from "../lib/sms/consent";

const NOW = Date.parse("2026-08-06T12:00:00Z");

const goodArtifact = {
  disclosure_text: "By checking this box you agree to receive text messages from SunBiz Funding about your funding application. Msg & data rates may apply. Reply STOP to opt out.",
  seller_named: "SunBiz Funding",
  captured_at: "2026-07-01T10:00:00Z",
  source_url: "https://sunbizfunding.com/apply",
  ip: "203.0.113.7",
  method: "web_form",
  disclosure_version: "v2",
};

// ── Artifact parsing ───────────────────────────────────────────────────────
{
  const v = readConsentArtifact(goodArtifact, NOW);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.artifact.sellerNamed, "SunBiz Funding");
    assert.equal(v.artifact.method, "web_form");
    assert.equal(v.stale, false);
    assert.ok(v.ageDays > 30 && v.ageDays < 40, "age computed from the capture timestamp");
    // The disclosure is stored VERBATIM, not summarised — it is the evidence.
    assert.ok(v.artifact.disclosureText.includes("Reply STOP"));
  }
}

// A partial record is NO record. Each required field, missing in turn.
assert.equal(readConsentArtifact(null, NOW).ok, false);
assert.equal(readConsentArtifact(undefined, NOW).ok, false);
assert.equal(readConsentArtifact({}, NOW).ok, false);
assert.equal(readConsentArtifact("yes", NOW).ok, false);
assert.equal(readConsentArtifact(true, NOW).ok, false, "a boolean is not an artifact");
for (const field of ["disclosure_text", "seller_named", "captured_at"]) {
  const partial: Record<string, unknown> = { ...goodArtifact };
  delete partial[field];
  const v = readConsentArtifact(partial, NOW);
  assert.equal(v.ok, false, `missing ${field} must invalidate the artifact`);
}
// Empty strings count as missing.
assert.equal(readConsentArtifact({ ...goodArtifact, seller_named: "   " }, NOW).ok, false);

// A future timestamp is corrupt or fabricated, not fresh.
assert.equal(
  readConsentArtifact({ ...goodArtifact, captured_at: "2027-01-01T00:00:00Z" }, NOW).ok,
  false,
);
assert.equal(readConsentArtifact({ ...goodArtifact, captured_at: "not a date" }, NOW).ok, false);

// Staleness is flagged, not fatal — the caller decides.
{
  const old = readConsentArtifact({ ...goodArtifact, captured_at: "2024-01-01T00:00:00Z" }, NOW);
  assert.equal(old.ok, true);
  if (old.ok) assert.equal(old.stale, true, "consent over a year old is flagged for re-confirmation");
}

// Founder meeting consent is a fresh, browser-captured artifact. Unlike the
// generic parser, this stricter verdict rejects stale proof and non-HTTPS
// capture points before it can be persisted as current consent.
assert.equal(readCurrentHttpsConsentArtifact(goodArtifact, NOW).ok, true);
for (const source_url of [
  "http://sunbizfunding.com/apply",
  "javascript:alert(1)",
  "not-a-url",
  "",
]) {
  const verdict = readCurrentHttpsConsentArtifact({ ...goodArtifact, source_url }, NOW);
  assert.deepEqual(verdict, { ok: false, reason: "https_source_url_required" });
}
assert.deepEqual(
  readCurrentHttpsConsentArtifact({ ...goodArtifact, captured_at: "2024-01-01T00:00:00Z" }, NOW),
  { ok: false, reason: "stale_consent_artifact" },
);
assert.equal(
  readCurrentHttpsConsentArtifact({ ...goodArtifact, captured_at: new Date(NOW + 1).toISOString() }, NOW).ok,
  false,
  "even a slightly future timestamp is invalid",
);

// ── The gate ───────────────────────────────────────────────────────────────
const base = {
  consent: goodArtifact,
  suppressed: false,
  optedOut: false,
  lineType: "mobile" as const,
  sentLast24h: 0,
  nowMs: NOW,
};

assert.equal(smsGate(base).allow, true, "a fully documented mobile with consent may be texted");

// OPT-OUT IS ABSOLUTE. No artifact, however good, overrides someone asking to
// stop. This is the guard that matters most and it is checked first.
assert.deepEqual(smsGate({ ...base, optedOut: true }), { allow: false, reason: "opted_out" });
assert.deepEqual(smsGate({ ...base, suppressed: true }), { allow: false, reason: "suppressed" });
assert.equal(
  smsGate({ ...base, optedOut: true, sentLast24h: 0, lineType: "mobile" }).allow,
  false,
  "opt-out wins over every other condition being ideal",
);

// No artifact, no send. This is the failure mode that ends up in court.
assert.deepEqual(smsGate({ ...base, consent: null }), { allow: false, reason: "no_consent_artifact" });
assert.deepEqual(smsGate({ ...base, consent: true }), { allow: false, reason: "no_consent_artifact" });
assert.equal(smsGate({ ...base, consent: { sms_ok: true } }).allow, false, "a flag is not consent");

// Line type. Landlines are a permanent failure; VOIP and unknown are refused
// because we cannot prove deliverability.
assert.deepEqual(smsGate({ ...base, lineType: "landline" }), { allow: false, reason: "line_type_landline" });
assert.deepEqual(smsGate({ ...base, lineType: "unknown" }), { allow: false, reason: "line_type_unknown" });
assert.deepEqual(smsGate({ ...base, lineType: "voip" }), { allow: false, reason: "line_type_voip" });

// Frequency: 3 per rolling 24h is law in FL, MD and OK; applied nationally.
assert.equal(smsGate({ ...base, sentLast24h: 2 }).allow, true);
assert.deepEqual(smsGate({ ...base, sentLast24h: 3 }), { allow: false, reason: "frequency_cap_24h" });
assert.deepEqual(smsGate({ ...base, sentLast24h: 9 }), { allow: false, reason: "frequency_cap_24h" });

console.log("sms-consent.test.ts — all assertions passed ✓");
