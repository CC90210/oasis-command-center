/**
 * tests/brand-shell.test.ts — every commercial drip email carries its sending
 * brand's own valid physical postal address.
 *
 * WHY THIS EXISTS: the 2026-08-05 audit checked all 29 live drip email steps,
 * including every copy variant, and found ZERO carrying a postal address.
 * CAN-SPAM 15 U.S.C. 7704(a)(5) requires one in every commercial email. The
 * unsubscribe half was already covered (a visible footer link plus both RFC 8058
 * headers); the address half was covered nowhere. SUNBIZ_LEGAL_FOOTER exists but
 * is imported only by the per-rep direct senders, never by the drip path.
 *
 * Putting it in the shell rather than in the copy means it applies to every drip
 * at once and cannot be forgotten by whoever writes the next template.
 *
 * lib/email/tracked-html.ts is `server-only` and cannot be imported here, so the
 * footer builder lives in the pure lib/email/brand-shell.ts (the same split
 * drip-rules-core.ts has from governor.ts) and is tested directly. The final
 * assertions pin that the server module actually calls it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brandFooter } from "../lib/email/brand-shell";
import { getBrand } from "../lib/email/brands";

const UNSUB = "https://oasisai.work/unsubscribe?email=a%40b.com&brand=SunBiz";
// The href is HTML-escaped in the attribute, so `&` becomes `&amp;`. Assert on
// the escaped form: seeing the raw string would mean escaping had been dropped.
const UNSUB_ESCAPED = UNSUB.replace(/&/g, "&amp;");

// ---------------------------------------------------------------------------
// Every brand: the exact configured address and legal entity appear.
// ---------------------------------------------------------------------------
for (const key of ["sunbiz", "bluerise"] as const) {
  const brand = getBrand(key);
  const html = brandFooter(key, UNSUB);
  assert.ok(html.includes(brand.postalAddress), `${key}: postal address present`);
  assert.ok(html.includes(brand.legalName), `${key}: legal entity named`);
  assert.ok(html.includes(UNSUB_ESCAPED), `${key}: unsubscribe link present and escaped`);
  assert.ok(!html.includes(UNSUB), `${key}: the raw unescaped URL must not appear`);
}

// ---------------------------------------------------------------------------
// The brands must not print each other's identity.
// ---------------------------------------------------------------------------
const sb = brandFooter("sunbiz", UNSUB);
assert.ok(sb.includes("SunBiz Funding LLC"));
assert.ok(!/Bluerise/i.test(sb), "SunBiz mail must not name Bluerise");

const br = brandFooter("bluerise", UNSUB);
assert.ok(/Bluerise/i.test(br));
assert.ok(!br.includes("SunBiz Funding LLC"), "Bluerise mail must not name the SunBiz entity");

// ---------------------------------------------------------------------------
// Omitting the unsubscribe link (transactional mail) still yields the address.
// The address costs nothing, and misclassifying commercial mail as transactional
// is a far more likely mistake than the reverse.
// ---------------------------------------------------------------------------
{
  const html = brandFooter("sunbiz", null);
  assert.ok(!/unsubscribe/i.test(html), "no unsubscribe link when none is supplied");
  assert.ok(html.includes(getBrand("sunbiz").postalAddress), "address still present");
}

// ---------------------------------------------------------------------------
// Escaping. The address is operator-set, but the shell must not become an
// injection point, and the unsubscribe URL carries an email address with
// characters that need escaping in an attribute.
// ---------------------------------------------------------------------------
{
  const saved = process.env.BLUERISE_POSTAL_ADDRESS;
  process.env.BLUERISE_POSTAL_ADDRESS = 'Evil<script>alert(1)</script>, FL 33009';
  const html = brandFooter("bluerise", UNSUB);
  assert.ok(!html.includes("<script>"), "a postal address must never inject markup");
  assert.ok(html.includes("&lt;script&gt;"), "it is escaped rather than silently stripped");
  if (saved === undefined) delete process.env.BLUERISE_POSTAL_ADDRESS;
  else process.env.BLUERISE_POSTAL_ADDRESS = saved;
}
{
  const html = brandFooter("sunbiz", 'https://x.test/u?e=a"><script>alert(1)</script>');
  assert.ok(!html.includes("<script>"), "the unsubscribe href must be escaped too");
}

// ---------------------------------------------------------------------------
// The server module must ACTUALLY use it. A footer builder nothing calls would
// leave the live gap exactly where the audit found it.
// ---------------------------------------------------------------------------
const tracked = readFileSync("lib/email/tracked-html.ts", "utf8");
assert.ok(
  tracked.includes("brandFooter"),
  "buildTrackedHtml must render brandFooter, or drip mail still ships with no postal address",
);
assert.ok(
  /sendingBrand/.test(tracked),
  "the shell must take a SENDING brand distinct from the suppression brand",
);
// The two axes must stay distinct: `brand` resolves the tenant on the opt-out
// write path, `sendingBrand` picks the footer identity. Conflating them would
// file opt-outs against a tenant that may not exist.
assert.ok(
  /opts\.brand \|\| SUNBIZ_BRAND/.test(tracked),
  "the suppression brand must keep its own independent default",
);

console.log("brand-shell.test.ts — all assertions passed ✓");
