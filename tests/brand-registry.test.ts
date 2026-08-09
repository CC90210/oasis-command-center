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
  brandIsSendable,
  ALL_BRAND_KEYS,
} from "../lib/email/brands";

// ---------------------------------------------------------------------------
// Resolution defaults to SunBiz, which is the pre-existing behaviour and the
// brand every lead currently in the CRM already knows. An unknown value must
// never resolve onto the newer domain.
// ---------------------------------------------------------------------------
assert.equal(resolveBrandKey(undefined), "sunbiz");
assert.equal(resolveBrandKey(null), "sunbiz");
assert.equal(resolveBrandKey(""), "sunbiz");
assert.equal(resolveBrandKey("   "), "sunbiz");
assert.equal(resolveBrandKey("nonsense"), "sunbiz");
assert.equal(resolveBrandKey(42), "sunbiz");
assert.equal(resolveBrandKey({}), "sunbiz");
assert.equal(resolveBrandKey("sunbiz"), "sunbiz");
assert.equal(resolveBrandKey("bluerise"), "bluerise");
assert.equal(resolveBrandKey("BLUERISE"), "bluerise");
assert.equal(resolveBrandKey("  Bluerise  "), "bluerise");

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
// The two brands must not collide on any identity axis. Sharing a credential
// service would mean both brands authenticate as the same mailbox, which is
// exactly the From/DKIM mismatch this whole design exists to prevent.
// ---------------------------------------------------------------------------
const sb = getBrand("sunbiz");
const br = getBrand("bluerise");
assert.notEqual(sb.sendingDomain, br.sendingDomain);
assert.notEqual(sb.fromAddress, br.fromAddress);
assert.notEqual(sb.credentialService, br.credentialService);
assert.notEqual(sb.legalName, br.legalName);

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
