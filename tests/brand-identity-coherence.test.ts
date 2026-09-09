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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_BRAND_KEYS, getBrand, type BrandKey } from "../lib/email/brands";
import { appendSignatureAndFooter } from "../lib/config/email-signature";
import { TENANT_SLUG_BRAND, TENANT_ID_BRAND, brandForTenant, brandTenantConflict, mailboxBrandConflict } from "../lib/email/brand-for-tenant";

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

// A SUPPLIED but unmapped tenant id must NOT fall through to the slug.
//
// The first version of brandForTenant did exactly that, so
// { tenantId: <a stranger's workspace>, tenantSlug: "submissions" } resolved to
// SunBiz — reopening the hole one layer down, and contradicting the comment
// saying the id wins. (Codex, adversarial review, 2026-09-09.)
assert.equal(
  brandForTenant({
    tenantId: "481c4d9b-c3b1-47e1-adef-c16dcd0e111f", // Yoga Tantric LLC
    tenantSlug: "submissions",
  }),
  null,
  "an unmapped tenant id must refuse, not borrow the slug's brand",
);

// And a supplied id that DISAGREES with a supplied slug refuses rather than
// silently preferring one of them.
assert.equal(
  brandForTenant({
    tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452", // OASIS
    tenantSlug: "submissions", // SunBiz
  }),
  null,
  "id and slug naming different companies must refuse",
);

// Inherited properties are not brands. A plain object answers "constructor"
// and "toString" with functions — truthy values that would sail past a bare
// lookup. Tenant slugs are named by anyone with workspace access.
// (CodeRabbit, PR #423.)
for (const hostile of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
  assert.equal(
    brandForTenant({ tenantSlug: hostile }),
    null,
    `slug "${hostile}" resolved to something — inherited property leaked through`,
  );
  assert.equal(
    brandForTenant({ tenantId: hostile }),
    null,
    `tenant id "${hostile}" resolved to something`,
  );
}

// ---------------------------------------------------------------------------
// A MAILBOX MAY NOT ASSERT A BRAND IT IS NOT ENTITLED TO.
//
// This is the incident reduced to one assertion, on the TypeScript side. The
// Python chokepoint got this guard first and this stack went without it, which
// left it reachable here: sendOasisSharedGmail authenticates as OASIS_MAIL_FROM
// and stamps brand "oasis" into the footer as a literal.
// ---------------------------------------------------------------------------
assert.ok(
  mailboxBrandConflict("oasis", "submissions@sunbizfunding.com"),
  "OASIS must not send from the client's mailbox",
);
assert.ok(
  mailboxBrandConflict("sunbiz", "conaugh@oasisai.work"),
  "SunBiz must not send from the OASIS mailbox",
);
// Correct pairings, and a real sender from the ledger.
assert.equal(mailboxBrandConflict("oasis", "conaugh@oasisai.work"), null);
assert.equal(mailboxBrandConflict("sunbiz", "submissions@sunbizfunding.com"), null);
assert.equal(mailboxBrandConflict("sunbiz", "Alex@sunbizfunding.com"), null);
assert.equal(
  mailboxBrandConflict("bluerise", "submissions@bluerisebusinesscapital.com"),
  null,
);
// Display-name wrapping and case must not launder a mismatch.
assert.equal(mailboxBrandConflict("oasis", "OASIS AI <Conaugh@OasisAI.Work>"), null);
assert.ok(
  mailboxBrandConflict("oasis", "OASIS AI <submissions@SunBizFunding.com>"),
  "a display name must not launder a mismatch",
);
// A subdomain is legitimate; a suffix lookalike is not.
assert.equal(mailboxBrandConflict("oasis", "bot@mail.oasisai.work"), null);
assert.ok(
  mailboxBrandConflict("oasis", "attacker@notoasisai.work"),
  "a lookalike domain must be refused",
);
// Nothing to check is not a conflict — the caller handles a missing mailbox.
assert.equal(mailboxBrandConflict("oasis", ""), null);
assert.equal(mailboxBrandConflict("oasis", null), null);

// The guard must agree with the Python one, brand for brand. Two stacks with
// different opinions about which domain a company sends from is the same class
// of defect as two stacks with different brand defaults.
for (const key of ALL_BRAND_KEYS) {
  const dom = getBrand(key).sendingDomain;
  assert.ok(dom && dom.includes("."), `${key}: sendingDomain is not a domain`);
  assert.equal(
    mailboxBrandConflict(key, `anyone@${dom}`),
    null,
    `${key} cannot send from its own sending domain`,
  );
}

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
  // PORTABLE, AND LOUD WHEN IT CANNOT RUN.
  //
  // The first version hardcoded an absolute Windows path, which passes on this
  // machine and reds (or worse, is quietly deleted) anywhere else. The agent
  // repo is a sibling checkout that CI for THIS repo may not have, so a missing
  // sibling is announced as a skip rather than failed — a parity check that
  // cannot see the other side must say so, not report success.
  // (Codex, adversarial review, 2026-09-09.)
  const candidates = [
    process.env.BRAVO_AGENT_REPO && `${process.env.BRAVO_AGENT_REPO}/scripts/lib/tenant_brand.py`,
    resolve(process.cwd(), "../../Business-Empire-Agent/scripts/lib/tenant_brand.py"),
    resolve(process.cwd(), "../Business-Empire-Agent/scripts/lib/tenant_brand.py"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.warn(
      "brand-identity-coherence: SKIPPED the TypeScript<->Python parity check — " +
        "scripts/lib/tenant_brand.py not found. Looked in:\n  " +
        candidates.join("\n  ") +
        "\nSet BRAVO_AGENT_REPO to the Business-Empire-Agent checkout to enable it. " +
        "The two stacks can drift silently while this is skipped.",
    );
  } else {
    const py = readFileSync(found, "utf8");

    /** Pull one `NAME: dict[str, str] = { "k": "v", ... }` body out of the
     *  Python source and return it as a map. Parsed rather than substring-
     *  matched so the comparison can run in BOTH directions: checking only
     *  that every TS entry appears somewhere in the Python text would miss an
     *  EXTRA Python mapping, which is drift just as much as a missing one. */
    function pyDict(name: string): Record<string, string> {
      // Anchored to the start of a line so a MENTION of the name in a comment
      // ("see SLUG_BRAND below") cannot be mistaken for the declaration — which
      // is exactly what happened on the first run of this parser, and it
      // reported the maps as disagreeing when they did not. A parity check that
      // cries wolf gets disabled, so the parse has to be exact.
      const block = new RegExp(
        `^${name}\\s*:[^=\\n]*=\\s*\\{([\\s\\S]*?)^\\}`,
        "m",
      ).exec(py);
      assert.ok(block, `could not find the ${name} declaration in tenant_brand.py — parity unverifiable`);
      const out: Record<string, string> = {};
      for (const m of block![1].matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)) {
        assert.equal(out[m[1]], undefined, `${name} defines "${m[1]}" twice in Python`);
        out[m[1]] = m[2];
      }
      return out;
    }

    const pySlug = pyDict("SLUG_BRAND");
    const pyId = pyDict("TENANT_BRAND");

    const compare = (
      label: string,
      ts: Readonly<Record<string, string>>,
      pyMap: Record<string, string>,
    ) => {
      for (const [k, v] of Object.entries(ts)) {
        assert.equal(
          pyMap[k],
          v,
          `${label}: "${k}" -> "${v}" in TypeScript but ${JSON.stringify(pyMap[k])} in Python. ` +
            "The two stacks must not disagree about which company a tenant is.",
        );
      }
      // The reverse direction. An entry Python has and TypeScript does not means
      // the Python send path will brand a tenant that the TypeScript path
      // refuses — the stacks disagreeing again, just quietly.
      for (const [k, v] of Object.entries(pyMap)) {
        assert.equal(
          ts[k],
          v,
          `${label}: "${k}" -> "${v}" exists in Python but not (or differently) in TypeScript.`,
        );
      }
    };

    compare("slug map", TENANT_SLUG_BRAND, pySlug);
    compare("tenant id map", TENANT_ID_BRAND, pyId);

    // THE ADDRESS MUST MATCH ACROSS STACKS TOO.
    //
    // brands.ts previously CLAIMED this check existed ("compared byte-for-byte
    // against the Python registry by the parity test") when the parity test
    // compared brand keys only. Asserting a guard that was never built is the
    // defect this whole change is about, so here is the guard.
    //
    // Containment, not equality: the two registries deliberately store
    // different shapes — this stack keeps street-only because the legal name
    // renders separately, while send_gateway.BRAND_IDENTITY stores the whole
    // identification line. What must not drift is the STREET.
    const pySendGateway = (() => {
      const gw = found.replace(/tenant_brand\.py$/, "../integrations/send_gateway.py");
      return existsSync(gw) ? readFileSync(gw, "utf8") : null;
    })();
    if (!pySendGateway) {
      console.warn(
        "brand-identity-coherence: SKIPPED the cross-stack ADDRESS check — " +
          "send_gateway.py not found next to tenant_brand.py. The street can drift while this is skipped.",
      );
    } else {
      const street = getBrand("oasis").postalAddress.split(",")[0].trim();
      assert.ok(street.length > 0, "OASIS postalAddress has no street segment");
      assert.ok(
        pySendGateway.includes(street),
        `OASIS street "${street}" is in the TypeScript registry but not in ` +
          "send_gateway.BRAND_IDENTITY. The two stacks would identify the same " +
          "company at different addresses on the same email.",
      );
      // And the client's address must NOT have followed it there.
      const sunbizStreet = getBrand("sunbiz").postalAddress.split(",")[0].trim();
      assert.ok(
        !getBrand("oasis").postalAddress.includes(sunbizStreet),
        "OASIS's address contains SunBiz's street",
      );
    }
  }
}

console.log(
  `brand-identity-coherence.test.ts — ${ALL_BRAND_KEYS.length} brands verified single-identity ✓`,
);
