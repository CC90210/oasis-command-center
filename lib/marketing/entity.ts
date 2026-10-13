/**
 * Entity identity for search and AI assistants, emitted as JSON-LD by
 * app/(marketing)/layout.tsx on every public page.
 *
 * The OG/Twitter metadata tells a crawler how to RENDER a link. This tells it
 * WHO the link is about, which is the part an assistant needs before it will
 * name us in an answer. "OASIS AI" is a generic-sounding string that collides
 * with several unrelated products, so the job here is to pin the entity to a
 * domain, an email, a legal name and a city that nothing else shares.
 *
 * Every value comes from a constant the site already publishes (the legal
 * name and principal place are on /about and /privacy). Never retype them:
 * structured data that disagrees with the visible page is a reason for a
 * search engine to trust neither.
 *
 * WHAT IS DELIBERATELY ABSENT (pinned by tests/marketing-canonical.test.ts):
 *   - `offers` / any price. Engagements are scoped individually and no public
 *     figure exists. Structured data that states a price we do not publish is
 *     how an assistant ends up quoting a number to a prospect that we then have
 *     to walk back.
 *   - `sameAs`. It should list the real GitHub / LinkedIn / X profiles, and
 *     guessing URLs that 404 actively damages entity resolution. Add them here
 *     once the handles are confirmed.
 *   - `logo`. The only raster mark (public/oasis-logo.jpg) is a 683x1024
 *     portrait with a generator watermark; search engines show the logo in a
 *     small square. Add one once a square, unwatermarked mark exists.
 *   - `streetAddress`. Only the city is published.
 */

import { CONTACT_EMAIL, SITE_ORIGIN } from "@/lib/marketing/routes";
import { LEGAL_ENTITY, LEGAL_PRINCIPAL_PLACE } from "@/lib/legal/constants";

const [addressLocality, addressRegion, addressCountry] = LEGAL_PRINCIPAL_PLACE.split(", ");

export const ORGANIZATION_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_ORIGIN}/#organization`,
  name: "OASIS AI",
  legalName: LEGAL_ENTITY,
  alternateName: "Operational Agentic Systems Increasing Scalability",
  url: SITE_ORIGIN,
  email: CONTACT_EMAIL,
  description:
    "OASIS builds AI agents that hold a seat in a business: operations, marketing, finance, legal. Plus the systems they run on.",
  address: {
    "@type": "PostalAddress",
    addressLocality,
    addressRegion,
    addressCountry,
  },
  knowsAbout: [
    "AI agents",
    "business process automation",
    "agentic systems",
    "operations automation",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "sales",
    email: CONTACT_EMAIL,
    url: `${SITE_ORIGIN}/contact`,
  },
};

export const WEBSITE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_ORIGIN}/#website`,
  url: SITE_ORIGIN,
  name: "OASIS AI",
  publisher: { "@id": `${SITE_ORIGIN}/#organization` },
  inLanguage: "en-CA",
};
