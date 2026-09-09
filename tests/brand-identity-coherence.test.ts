/**
 * tests/brand-identity-coherence.test.ts — one message may name exactly ONE
 * company.
 *
 * THE INCIDENT THIS EXISTS FOR (2026-09-09). A SunBiz contact reported OASIS AI
 * branding on mail from their operation. The cause was not a template: it was
 * that "OASIS" did not exist in the brand registry, so `resolveBrandKey("oasis")`
 * returned "sunbiz" and an OASIS send inherited the client's from-address,
 * credential row, postal address and legal name. The ledger holds the inverse
 * too — tenant oasis-ai-cc sending as sunbiz (2026-07-10) and tenant
 * submissions sending as oasis (2026-08-01).
 *
 * WHY THE EXISTING SUITE MISSED IT. 243 test files were green. Two of them
 * (brand-registry, email-sending-identity) explicitly asserted that an
 * unrecognised brand becomes SunBiz, and a third (shopout-brand-lock) pinned
 * the source text of that fallback. The suite was not silent about the defect;
 * it was defending it.
 *
 * So this file asserts the property those could not: whatever a brand is called
 * and however it is resolved, every identity-bearing part of the message it
 * produces must belong to THAT brand and to no other. It is table-driven over
 * ALL_BRAND_KEYS, so adding a fourth brand without wiring it fails the build
 * rather than quietly borrowing a third party's legal identity.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_BRAND_KEYS, getBrand, type BrandKey } from "../lib/email/brands";
import { appendSignatureAndFooter } from "../lib/config/email-signature";
import { TENANT_SLUG_BRAND, TENANT_ID_BRAND, brandForTenant, brandTenantConflict } from "../lib/email/brand-for-tenant";

// ---------------------------------------------------------------------------
// 1. A brand's footer names ITS OWN legal entity, and no other brand's.
//
// This is the assertion that fails on the actual incident. With OASIS absent
// from the registry, an OASIS send produced a footer reading "SunBiz Funding
// LLC ... 221 W Hallandale Beach Blvd ... you submitted a funding inquiry".
// ---------------------------------------------------------------------------
for (const key of ALL_BRAND_KEYS) {
  const brand = getBrand(key);
  const body = appendSignatureAndFooter("Hello there.", {
    signer: { name: "Test Rep" },
    brand: key,
  });

  assert.ok(
    body.includes(brand.legalName),
    `${key}: the footer must name its own legal entity (${brand.legalName})`,
  );

  for (const other of ALL_BRAND_KEYS) {
    if (other === key) continue;
    const o = getBrand(other);
    assert.ok(
      !body.includes(o.legalName),
      `${key}: footer names ANOTHER company (${o.legalName}). ` +
        "A recipient cannot tell which of two businesses actually wrote to them, " +
        "and the one named is legally on the hook for a message it did not send.",
    );
    // Postal addresses are the other half of the identification. SunBiz and
    // Bluerise share premises by agreement, so only compare when they differ.
    if (o.postalAddress !== brand.postalAddress) {
      assert.ok(
        !body.includes(o.postalAddress),
        `${key}: footer carries ${other}'s postal address`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Every identity axis of a brand agrees with every other.
//
// A message that SAYS one brand while being DKIM-signed by another reads to a
// receiver as forgery — brands.ts's own header warns about this shape.
// ---------------------------------------------------------------------------
for (const key of ALL_BRAND_KEYS) {
  const b = getBrand(key);
  const fromDomain = b.fromAddress.split("@")[1]?.toLowerCase();
  assert.equal(
    fromDomain,
    b.sendingDomain,
    `${key}: From address must live on the sending domain or DKIM cannot align`,
  );
  assert.ok(b.credentialService.trim().length > 0, `${key}: needs its own credential`);
  assert.ok(b.postalAddress.trim().length > 0, `${key}: needs a postal address (CASL/CAN-SPAM)`);
}

// No two brands may share the credential that authenticates the SMTP session.
// Sharing it means one company's mail physically leaves the other's mailbox,
// which is precisely what "OASIS resolves to sunbiz -> credentialService gws"
// did.
{
  const seen = new Map<string, BrandKey>();
  for (const key of ALL_BRAND_KEYS) {
    const svc = getBrand(key).credentialService;
    const prior = seen.get(svc);
    assert.equal(
      prior,
      undefined,
      `${key} and ${prior} share credential "${svc}" — one would send from the other's mailbox`,
    );
    seen.set(svc, key);
  }
}

// ---------------------------------------------------------------------------
// 3. Tenant -> brand is fail-closed.
//
// The route this replaced read:
//   tenantSlug === "submissions" ? "sunbiz" : tenantSlug ? "oasis" : undefined
// which branded every non-SunBiz tenant OASIS. The live table holds 49 tenants;
// 47 are self-signup accounts, including real third parties.
// ---------------------------------------------------------------------------
assert.equal(brandForTenant({ tenantSlug: "submissions" }), "sunbiz");
assert.equal(brandForTenant({ tenantSlug: "sun" }), "sunbiz", "profile slug differs from tenant slug");
assert.equal(brandForTenant({ tenantSlug: "oasis-ai-cc" }), "oasis");
assert.equal(brandForTenant({ tenantId: "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110" }), "sunbiz");

// A stranger's workspace resolves to NOTHING, and callers refuse.
assert.equal(brandForTenant({ tenantSlug: "aarjan-malla" }), null, "Yoga Tantric LLC is not OASIS");
assert.equal(brandForTenant({ tenantSlug: "" }), null);
assert.equal(brandForTenant({}), null);

// "submissions-5f63d7e6" is a self-signup tenant that merely shares a prefix
// with the client's slug. A prefix match would hand it SunBiz's identity.
assert.equal(
  brandForTenant({ tenantSlug: "submissions-5f63d7e6" }),
  null,
  "prefix collision must not resolve — that is a different company",
);

// Disagreement between a supplied brand and the tenant's real one is reported.
assert.ok(
  brandTenantConflict({ brand: "oasis", tenantSlug: "submissions" }),
  "OASIS brand on the SunBiz tenant must be flagged (ledger row, 2026-08-01)",
);
assert.ok(
  brandTenantConflict({ brand: "sunbiz", tenantSlug: "oasis-ai-cc" }),
  "SunBiz brand on the OASIS tenant must be flagged (ledger row, 2026-07-10)",
);
assert.equal(brandTenantConflict({ brand: "sunbiz", tenantSlug: "submissions" }), null);
assert.equal(
  brandTenantConflict({ brand: undefined, tenantSlug: "submissions" }),
  null,
  "an absent brand is not a conflict — the caller derives it",
);

// ---------------------------------------------------------------------------
// 4. The TypeScript and Python maps must agree.
//
// They previously disagreed in OPPOSITE directions: Python defaulted an unknown
// brand to "oasis", TypeScript to "sunbiz". A brand that went missing therefore
// landed on a different company depending on which side of the stack handled
// it — and mail crosses that boundary in both directions every day.
// ---------------------------------------------------------------------------
{
  const py = readFileSync(
    "C:/Users/User/Business-Empire-Agent/scripts/lib/tenant_brand.py",
    "utf8",
  );

  for (const [slug, brand] of Object.entries(TENANT_SLUG_BRAND)) {
    const re = new RegExp(`["']${slug}["']\\s*:\\s*["']${brand}["']`);
    assert.match(
      py,
      re,
      `slug "${slug}" -> "${brand}" is missing or different in scripts/lib/tenant_brand.py. ` +
        "The two stacks must not disagree about which company a tenant is.",
    );
  }

  for (const [id, brand] of Object.entries(TENANT_ID_BRAND)) {
    const re = new RegExp(`["']${id}["']\\s*:\\s*["']${brand}["']`);
    assert.match(py, re, `tenant ${id} -> "${brand}" differs between TypeScript and Python`);
  }
}

console.log(
  `brand-identity-coherence.test.ts — ${ALL_BRAND_KEYS.length} brands verified single-identity ✓`,
);
