/**
 * tests/brand-registry.test.ts — the brand registry is the single definition of
 * an outbound sending identity, so these assertions are what stop a rebrand
 * from shipping half-applied.
 *
 * The registry replaced five string literals scattered across five files. The
 * failure it exists to prevent is a message that SAYS one brand while being
 * signed, tracked, or footed by another.
 */

import assert from "node:assert/strict";
import {
  getBrand,
  resolveBrandKey,
  resolveBrandKeyOrNull,
  brandIsSendable,
  ALL_BRAND_KEYS,
} from "../lib/email/brands";

// ---------------------------------------------------------------------------
// ABSENT resolves to SunBiz. UNRECOGNISED does not resolve at all.
//
// REWRITTEN 2026-09-09. This block used to read:
//
//     assert.equal(resolveBrandKey("nonsense"), "sunbiz");
//     assert.equal(resolveBrandKey(42),         "sunbiz");
//
// i.e. it asserted the fail-open as CORRECT. That is the behaviour that put
// SunBiz Funding LLC's name, Florida address and "you submitted a funding
// inquiry" on OASIS prospect mail — "oasis" was not a BrandKey, so it was
// "unrecognised", so it silently became the client. A green suite of 243 files
// reported no problem, because these lines told it not to.
//
// The distinction that survives: an EMPTY column on a drip lead genuinely means
// SunBiz (every such row predates `sending_brand`). A non-empty value nobody
// recognises is a bug, and is now loud.
// ---------------------------------------------------------------------------
assert.equal(resolveBrandKey(undefined), "sunbiz", "absent = the legacy drip default");
assert.equal(resolveBrandKey(null), "sunbiz");
assert.equal(resolveBrandKey(""), "sunbiz");
assert.equal(resolveBrandKey("   "), "sunbiz");
assert.equal(resolveBrandKey("sunbiz"), "sunbiz");
assert.equal(resolveBrandKey("bluerise"), "bluerise");
assert.equal(resolveBrandKey("BLUERISE"), "bluerise");
assert.equal(resolveBrandKey("  Bluerise  "), "bluerise");

// OASIS is a real brand now. This single assertion is the regression test for
// the whole incident: before, it returned "sunbiz".
assert.equal(resolveBrandKey("oasis"), "oasis", "OASIS must not resolve to the client");
assert.equal(resolveBrandKey("  OASIS  "), "oasis");

// An unrecognised non-empty value throws instead of picking a company.
for (const bad of ["nonsense", 42, {}, "sunbizfunding", "oasis-ai-cc"]) {
  assert.throws(
    () => resolveBrandKey(bad),
    /unknown brand/,
    `resolveBrandKey(${JSON.stringify(bad)}) must refuse, not fall back`,
  );
}

// The nullable form, for callers where "nobody said" must not become a company.
assert.equal(resolveBrandKeyOrNull(undefined), null);
assert.equal(resolveBrandKeyOrNull(""), null);
assert.equal(resolveBrandKeyOrNull("nonsense"), null);
assert.equal(resolveBrandKeyOrNull("oasis"), "oasis");


// ---------------------------------------------------------------------------
// Every brand is completely specified. A brand missing a postal address is a
// CAN-SPAM violation waiting to ship; a brand whose From address does not live
// on its own sending domain fails DKIM alignment and therefore DMARC.
// ---------------------------------------------------------------------------
for (const key of ALL_BRAND_KEYS) {
  const b = getBrand(key);
  assert.equal(b.key, key, `${key}: key round-trips`);
  assert.ok(b.displayName.trim().length > 0, `${key}: displayName`);
  assert.ok(b.legalName.trim().length > 0, `${key}: legalName`);
  assert.match(b.fromAddress, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, `${key}: fromAddress well formed`);
  assert.equal(
    b.fromAddress.split("@")[1].toLowerCase(),
    b.sendingDomain,
    `${key}: From must live on the sending domain or DKIM cannot align`,
  );
  assert.ok(b.credentialService.trim().length > 0, `${key}: credentialService`);
  assert.match(b.trackingOrigin, /^https:\/\//, `${key}: trackingOrigin is https`);
}

// ---------------------------------------------------------------------------
// NO TWO BRANDS may collide on any identity axis — checked over every PAIR, not
// just the original two.
//
// Sharing a credentialService is the sharpest one: it means two companies
// authenticate as the same mailbox, so one company's mail physically leaves
// from the other's Google Workspace account. That is the mechanism behind the
// 2026-09-09 incident — OASIS had no brand entry, resolved to "sunbiz", and
// therefore inherited credentialService "gws", the client's credential.
//
// Generalised so adding a fourth brand cannot reintroduce it unnoticed.
// ---------------------------------------------------------------------------
for (const a of ALL_BRAND_KEYS) {
  for (const b of ALL_BRAND_KEYS) {
    if (a >= b) continue;
    const x = getBrand(a);
    const y = getBrand(b);
    assert.notEqual(x.sendingDomain, y.sendingDomain, `${a}/${b} share a sending domain`);
    assert.notEqual(x.fromAddress, y.fromAddress, `${a}/${b} share a From address`);
    assert.notEqual(
      x.credentialService,
      y.credentialService,
      `${a}/${b} share a credential — one company would send from the other's mailbox`,
    );
    assert.notEqual(x.legalName, y.legalName, `${a}/${b} share a legal name`);
  }
}

const sb = getBrand("sunbiz");
const br = getBrand("bluerise");

// OASIS's identity, pinned. Each of these was wrong-by-absence before today:
// with no entry, every one of them resolved to SunBiz's value.
const oa = getBrand("oasis");
assert.equal(oa.legalName, "OASIS AI Solutions");
assert.equal(oa.sendingDomain, "oasisai.work");
assert.equal(oa.credentialService, "oasis_gmail", "must NOT be 'gws' — that is SunBiz's");
assert.match(oa.postalAddress, /Montreal/, "Montreal, not Collingwood (CC, 2026-09-09)");

// SunBiz values are the previously-hardcoded ones. An unconfigured environment
// must send byte-identically to what it sent before this registry existed.
assert.equal(sb.fromAddress, "submissions@sunbizfunding.com");
assert.equal(sb.sendingDomain, "sunbizfunding.com");
assert.equal(sb.credentialService, "gws");
assert.ok(
  sb.postalAddress.includes("221 W Hallandale Beach Blvd"),
  "SunBiz keeps the CC-confirmed legal address",
);

// Bluerise sends from the ONE mailbox that has sign-in history and carried the
// warm-up. See Task 4 in the plan for why splitting across alex@/jordan@/matt@
// would discard that warm-up for no volume gain.
assert.equal(br.fromAddress, "submissions@bluerisebusinesscapital.com");
assert.equal(br.sendingDomain, "bluerisebusinesscapital.com");
assert.equal(br.credentialService, "gws_bluerise");

// ---------------------------------------------------------------------------
// The sendability gate. This is the guard that refuses to put commercial mail
// in front of a merchant without a valid physical postal address.
// ---------------------------------------------------------------------------
for (const key of ALL_BRAND_KEYS) {
  const verdict = brandIsSendable(key);
  assert.equal(verdict.ok, true, `${key} must be sendable: ${(verdict as { reason?: string }).reason ?? ""}`);
}

// And it must actually fail when the address is absent, or it is decoration.
// Proving the guard fires rather than trusting the comment above it.
{
  const saved = process.env.BLUERISE_POSTAL_ADDRESS;
  process.env.BLUERISE_POSTAL_ADDRESS = "BLUERISE_POSTAL_ADDRESS_NOT_SET";
  const verdict = brandIsSendable("bluerise");
  assert.equal(verdict.ok, false, "an unset postal address MUST block sending");
  assert.match((verdict as { reason: string }).reason, /postal address/i);
  if (saved === undefined) delete process.env.BLUERISE_POSTAL_ADDRESS;
  else process.env.BLUERISE_POSTAL_ADDRESS = saved;
}

// Recovered after the probe: the guard must not have latched.
assert.equal(brandIsSendable("bluerise").ok, true, "guard must not latch after firing");

console.log("brand-registry.test.ts — all assertions passed ✓");
