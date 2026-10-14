/**
 * tests/marketing-canonical.test.ts - every public marketing page names ONE
 * absolute URL for itself, in both the canonical tag and og:url, and the
 * organisation entity carries only facts the site already publishes.
 *
 * WHY (2026-10-12 oasisai.work technical audit)
 * ---------------------------------------------
 * IDX-09: /privacy, /terms and /dmca shipped with no canonical tag.
 * MED-07: og:url was missing on every page, so a shared link carried no
 *         statement of which URL it was about.
 * SCH-03: the Organization JSON-LD had no legal name or address, although
 *         both are on /about and /privacy.
 *
 * The layout derives the path from the x-pathname header middleware stamps,
 * and the home page is served at "/" via a rewrite to /home, so the mapping
 * from request path to canonical path is the part that can silently go wrong:
 * a canonical of "/home" would point Google at a URL nobody links to.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MARKETING_LEGAL_PATHS,
  MARKETING_PATHS,
  MARKETING_HOME_PATH,
  marketingCanonicalPath,
} from "../lib/marketing/routes";
import { ORGANIZATION_JSONLD, WEBSITE_JSONLD } from "../lib/marketing/entity";
import { LEGAL_ENTITY, LEGAL_PRINCIPAL_PLACE, OASIS_SUPPORT_EMAIL } from "../lib/legal/constants";

const root = join(__dirname, "..");

// 1. Request path -> canonical path.
assert.equal(marketingCanonicalPath(MARKETING_HOME_PATH), "/", "the home page is canonical at /, never /home");
assert.equal(marketingCanonicalPath("/"), "/");
for (const path of [...MARKETING_PATHS, ...MARKETING_LEGAL_PATHS]) {
  if (path === MARKETING_HOME_PATH) continue;
  assert.equal(marketingCanonicalPath(path), path, `${path} is its own canonical`);
}
assert.equal(marketingCanonicalPath("/privacy"), "/privacy", "legal pages get a canonical (IDX-09)");
assert.equal(marketingCanonicalPath("/fleet/"), "/fleet", "trailing slash normalises");
assert.equal(marketingCanonicalPath("/fleet?utm_source=x"), "/fleet", "query strings never reach a canonical");
// Not a marketing page: emit nothing rather than a wrong URL.
for (const path of ["", "/login", "/pipeline", "/fleet/anything", "/homepage", "/download", "/checkout/success"]) {
  assert.equal(marketingCanonicalPath(path), null, `${JSON.stringify(path)} gets no canonical`);
}

// 2. The layout wires the helper into BOTH tags. (The layout imports
//    next/font, which does not load under tsx, so this reads its source.)
const layout = readFileSync(join(root, "app/(marketing)/layout.tsx"), "utf8");
assert.match(layout, /export async function generateMetadata/, "layout metadata is per-request");
assert.match(layout, /marketingCanonicalPath\(/, "layout derives the path from the shared helper");
assert.match(layout, /alternates:\s*\{\s*canonical:\s*path\s*\}/, "layout emits the canonical");
assert.match(layout, /url:\s*path/, "layout emits og:url");
assert.doesNotMatch(layout, /export const metadata\b/, "no second, static metadata export");

// 3. No page states a canonical that disagrees with the helper.
const pageFiles: Record<string, string> = {
  "/": "home", "/audit": "[funnel]", "/fleet": "fleet", "/work": "work",
  "/command-center": "[funnel]", "/pricing": "[funnel]", "/onboarding": "[funnel]", "/about": "about",
  "/contact": "contact", "/privacy": "privacy", "/terms": "terms", "/dmca": "dmca",
};
for (const [path, dir] of Object.entries(pageFiles)) {
  const src = readFileSync(join(root, "app/(marketing)", dir, "page.tsx"), "utf8");
  const m = src.match(/canonical:\s*"([^"]+)"/);
  if (m) assert.equal(m[1], path, `${dir}/page.tsx canonical matches the layout's`);
  // A page-level openGraph object REPLACES the layout's and drops the share
  // image and og:url (see home/page.tsx). Pin its absence.
  assert.doesNotMatch(src, /openGraph\s*:/, `${dir}/page.tsx must not override openGraph`);
}

// 4. The entity carries published facts only.
assert.equal(ORGANIZATION_JSONLD.legalName, LEGAL_ENTITY);
assert.equal(ORGANIZATION_JSONLD.email, OASIS_SUPPORT_EMAIL);
const addr = ORGANIZATION_JSONLD.address;
assert.equal(addr["@type"], "PostalAddress");
assert.equal(
  [addr.addressLocality, addr.addressRegion, addr.addressCountry].join(", "),
  LEGAL_PRINCIPAL_PLACE,
  "address is the legal principal place, split, never retyped",
);
// Absent until confirmed: a guessed profile URL or an unsuitable logo damages
// entity resolution, and a price we do not publish gets quoted to prospects.
for (const key of ["sameAs", "logo", "offers", "streetAddress"]) {
  assert.ok(!(key in ORGANIZATION_JSONLD) && !(key in addr), `${key} stays absent until confirmed`);
}
assert.equal(WEBSITE_JSONLD.publisher["@id"], ORGANIZATION_JSONLD["@id"], "one entity id");

console.log("marketing-canonical: all assertions passed");
