/**
 * tests/unsubscribe-brand-per-tenant.test.ts — an opt-out is filed under the
 * company that sent the mail.
 *
 * Every drip and cold unsubscribe link carried brand=SunBiz, and
 * /api/unsubscribe files the opt-out under whichever tenant the brand names. So
 * an OASIS recipient who unsubscribed would have been written into SunBiz's
 * suppression list, and because suppression is enforced per tenant, OASIS
 * would never have honored it. These assertions pin both halves: SunBiz's links
 * are byte-for-byte what they were, and every other tenant's link resolves
 * back to that tenant and no other.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  TENANT_ID_BRAND,
  TENANT_SLUG_BRAND,
  TENANT_ID_IDENTITY,
  unsubscribeBrandForTenant,
  tenantIdForUnsubscribeBrand,
  tenantSlugForId,
} from "../lib/email/brand-for-tenant";
import { suppressionBrand } from "../lib/email/sending-identity";
import {
  SUNBIZ_BRAND,
  unsubscribeUrl,
  unsubscribeApiUrl,
  listUnsubscribeHeader,
  buildTrackedHtml,
} from "../lib/email/tracked-html";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const STRANGER = "5f63d7e6-0000-4000-8000-000000000000";
const BASE = "https://go.sunbizfunding.com";

const ENV_KEYS = ["OASIS_UNSUBSCRIBE_HMAC_SECRET", "DRIP_SUPPRESSION_BRAND", "DRIP_FROM_ADDRESS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function withEnv(env: Record<string, string>, fn: () => void) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) delete process.env[k];
  }
}

// ── 1. The identity map covers exactly the mapped tenants, consistently ────
assert.deepEqual(Object.keys(TENANT_ID_IDENTITY).sort(), Object.keys(TENANT_ID_BRAND).sort(),
  "TENANT_ID_IDENTITY and TENANT_ID_BRAND must name the same tenants");
for (const [id, who] of Object.entries(TENANT_ID_IDENTITY)) {
  assert.equal(TENANT_SLUG_BRAND[who.slug], TENANT_ID_BRAND[id], `${who.slug} must be the same company as ${id}`);
  assert.equal(tenantSlugForId(id), who.slug);
}
const names = Object.values(TENANT_ID_IDENTITY).map((w) => w.name.toLowerCase());
assert.equal(new Set(names).size, names.length, "two tenants sharing an unsubscribe name would share an opt-out list");

// ── 2. Each tenant's links carry its own name ──────────────────────────────
assert.equal(unsubscribeBrandForTenant(SUNBIZ), "SunBiz");
assert.equal(unsubscribeBrandForTenant(SUNBIZ), SUNBIZ_BRAND, "SunBiz's value is the constant every link has carried");
assert.equal(unsubscribeBrandForTenant(SUNBIZ.toUpperCase()), "SunBiz");
assert.equal(unsubscribeBrandForTenant(OASIS), "OASIS AI");
assert.equal(unsubscribeBrandForTenant(WEBDEV), "Oasis Web Studio");
for (const unknown of [STRANGER, "", null, undefined, "constructor", "toString"]) {
  assert.equal(unsubscribeBrandForTenant(unknown), null, `${String(unknown)} is not a tenant we can file opt-outs for`);
}

// ── 3. And each name resolves back to that tenant, never another company's ──
for (const id of Object.keys(TENANT_ID_IDENTITY)) {
  assert.equal(tenantIdForUnsubscribeBrand(unsubscribeBrandForTenant(id)), id, `round trip for ${id}`);
}
assert.equal(tenantIdForUnsubscribeBrand("OASIS AI"), OASIS, "an OASIS opt-out lands on OASIS");
assert.notEqual(tenantIdForUnsubscribeBrand("OASIS AI"), SUNBIZ, "and never on SunBiz");
assert.equal(tenantIdForUnsubscribeBrand("SunBiz"), SUNBIZ, "the links already in SunBiz's recipients' inboxes still resolve");
assert.equal(tenantIdForUnsubscribeBrand("sunbiz"), SUNBIZ, "matched case-insensitively, as the ILIKE did");
assert.equal(tenantIdForUnsubscribeBrand(" SunBiz "), SUNBIZ);
for (const other of ["Bluerise", "OASIS", "SunBiz Funding", "", null]) {
  assert.equal(tenantIdForUnsubscribeBrand(other), null, `${String(other)} falls through to the route's general lookup`);
}

// ── 4. suppressionBrand takes a tenant; SunBiz's answer is unchanged ────────
withEnv({}, () => {
  assert.equal(suppressionBrand(), "SunBiz", "no tenant: exactly as before");
  assert.equal(suppressionBrand(SUNBIZ), "SunBiz");
  assert.equal(suppressionBrand(OASIS), "OASIS AI");
  assert.equal(suppressionBrand(WEBDEV), "Oasis Web Studio");
  assert.equal(suppressionBrand(STRANGER), null, "an unknown tenant gets no brand, not SunBiz's");
});
withEnv({ DRIP_SUPPRESSION_BRAND: "Bluerise" }, () => {
  assert.equal(suppressionBrand(), "Bluerise", "the knob still works for SunBiz");
  assert.equal(suppressionBrand(SUNBIZ), "Bluerise");
  assert.equal(suppressionBrand(OASIS), "OASIS AI", "SunBiz's knob never moves OASIS's opt-outs");
});

// ── 5. SunBiz's links are byte-identical to before ─────────────────────────
withEnv({}, () => {
  const b = unsubscribeBrandForTenant(SUNBIZ)!;
  assert.equal(unsubscribeUrl("A@B.com", b, BASE), `${BASE}/unsubscribe?email=a%40b.com&brand=SunBiz`);
  assert.equal(unsubscribeApiUrl("A@B.com", b, BASE), `${BASE}/api/unsubscribe?email=a%40b.com&brand=SunBiz`);
  assert.equal(
    listUnsubscribeHeader("A@B.com", b, BASE),
    `<${BASE}/api/unsubscribe?email=a%40b.com&brand=SunBiz>, <mailto:submissions@sunbizfunding.com?subject=unsubscribe>`,
  );
  const html = buildTrackedHtml("Hello", { sendId: "s1", email: "a@b.com", brand: b, sendingBrand: "sunbiz", trackingBase: BASE });
  assert.ok(html.includes(`${BASE}/unsubscribe?email=a%40b.com&amp;brand=SunBiz`) || html.includes(`${BASE}/unsubscribe?email=a%40b.com&brand=SunBiz`),
    "the drip footer link is unchanged");
});
withEnv({ OASIS_UNSUBSCRIBE_HMAC_SECRET: "s3cret" }, () => {
  const token = createHmac("sha256", "s3cret").update("a@b.com|SunBiz").digest("hex").slice(0, 16);
  assert.equal(
    unsubscribeUrl("A@B.com", unsubscribeBrandForTenant(SUNBIZ)!, BASE),
    `${BASE}/unsubscribe?email=a%40b.com&brand=SunBiz&token=${token}`,
    "and so is the signed form the route verifies",
  );
});

// ── 6. An OASIS link names OASIS, and the route's own parsing agrees ────────
withEnv({ OASIS_UNSUBSCRIBE_HMAC_SECRET: "s3cret" }, () => {
  const url = new URL(unsubscribeApiUrl("x@y.com", unsubscribeBrandForTenant(OASIS)!, "https://oasisai.work"));
  const brand = url.searchParams.get("brand");
  assert.equal(brand, "OASIS AI");
  assert.equal(tenantIdForUnsubscribeBrand(brand), OASIS);
  const token = createHmac("sha256", "s3cret").update(`x@y.com|${brand}`).digest("hex").slice(0, 16);
  assert.equal(url.searchParams.get("token"), token, "the token verifies against the brand the route reads");
  const html = buildTrackedHtml("Hi", { sendId: "s2", email: "x@y.com", brand: brand!, trackingBase: "https://oasisai.work" });
  assert.ok(!html.includes("brand=SunBiz"), "an OASIS message carries no SunBiz opt-out link");
});

// ── 7. Every sender derives the brand from the row's tenant ────────────────
const EXECUTOR = readFileSync("lib/drips/executor.ts", "utf8");
assert.ok(!/SUNBIZ_BRAND/.test(EXECUTOR), "the drip executor no longer hardcodes SunBiz's opt-out list");
assert.ok(/const unsubBrand = unsubscribeBrandForTenant\(row\.tenant_id\);/.test(EXECUTOR));
assert.ok(/unsubscribe_brand_unknown/.test(EXECUTOR), "an unmapped tenant is held, not filed under SunBiz");
assert.ok(/unsubscribeUrl\(email, unsubBrand, trackingBase\)/.test(EXECUTOR), "custom-HTML footer");
assert.ok(/buildDripHtml\(cleanBody, \{ sendId, email, brand: unsubBrand,/.test(EXECUTOR), "plain footer");
assert.ok(/listUnsubscribeHeader\(email, unsubBrand, trackingBase\)/.test(EXECUTOR), "List-Unsubscribe header");

const COLD = readFileSync("lib/integrations/cold-sending.ts", "utf8");
assert.ok(/const unsubBrand = unsubscribeBrandForTenant\(args\.tenantId\);/.test(COLD));
assert.ok(!/brand: "SunBiz"/.test(COLD) && !/unsubscribeApiUrl\(args\.to, "SunBiz"\)/.test(COLD),
  "cold sends no longer hardcode SunBiz's opt-out list");
assert.ok(/brand: unsubBrand/.test(COLD) && /unsubscribeApiUrl\(args\.to, unsubBrand\)/.test(COLD));

const RECONCILE = readFileSync("lib/drips/reconcile-email-telemetry.ts", "utf8");
assert.ok(/brand: unsubscribeBrandForTenant\(row\.tenant_id\) \?\? SUNBIZ_BRAND/.test(RECONCILE),
  "the telemetry rebuild uses the brand the send used");

const TRACKED = readFileSync("lib/email/tracked-html.ts", "utf8");
assert.ok(!/= SUNBIZ_BRAND/.test(TRACKED) && !/\|\| SUNBIZ_BRAND/.test(TRACKED), "no helper defaults to SunBiz");

const ROUTE = readFileSync("app/api/unsubscribe/route.ts", "utf8");
{
  const fn = ROUTE.slice(ROUTE.indexOf("async function resolveTenantId"));
  const known = fn.indexOf("tenantIdForUnsubscribeBrand(brand)");
  const fuzzy = fn.indexOf('.from("tenants")');
  assert.ok(known > 0 && fuzzy > known, "our own tenants resolve by exact name BEFORE the ILIKE lookup");
}

const SUITE = readFileSync("tests/_suite.mjs", "utf8");
assert.ok(SUITE.includes('"tests/unsubscribe-brand-per-tenant.test.ts"'), "this file must be in the suite");

for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
console.log("unsubscribe-brand-per-tenant.test.ts — all assertions passed ✓");
