/**
 * tests/offer-short-links.test.ts - each OASIS offer has its own short public
 * address, and the address the Offers card copies is one that really resolves
 * (CC, 2026-10-16: "They should have individual links - each one sends to a
 * different landing page").
 *
 * lib/offers/short-links.ts (what the card hands out) and next.config.js
 * redirects() (what makes it resolve) are two lists by necessity: a JS config
 * cannot import TypeScript. This test is what keeps them one.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_MARKETING_PATHS } from "../lib/marketing/routes";
import { OASIS_OFFER_SHORT_PATHS, offerShareablePath } from "../lib/offers/short-links";

type Redirect = { source: string; destination: string; permanent?: boolean };

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

async function main(): Promise<void> {
  console.log("offer short links");
  const config = (await import("../next.config.js")) as { default?: { redirects?: () => Promise<Redirect[]> } };
  const nextConfig = config.default ?? (config as unknown as { redirects?: () => Promise<Redirect[]> });
  assert.equal(typeof nextConfig.redirects, "function", "next.config.js has no redirects()");
  const redirects = await nextConfig.redirects!();
  const bySource = new Map(redirects.map((r) => [r.source, r]));

  check("every short link the card hands out resolves to that offer's own page", () => {
    for (const [slug, short] of Object.entries(OASIS_OFFER_SHORT_PATHS)) {
      if (slug === "vsl") {
        // The router is a route handler (it picks the router or the audit live).
        assert.ok(existsSync(join("app", "vsl", "route.ts")), "/vsl has no route handler");
        continue;
      }
      const rule = bySource.get(short);
      assert.ok(rule, `${short} has no redirect in next.config.js`);
      assert.equal(rule.destination, `/f/oasis-ai-cc/${slug}`, `${short} lands on the wrong page`);
    }
  });

  check("the new offer links are temporary redirects, so a later change is not cached for good", () => {
    for (const short of ["/protocol", "/command", "/community", "/fleet-audit"]) {
      assert.equal(bySource.get(short)?.permanent, false, `${short} must be a temporary redirect`);
    }
  });

  check("no short link takes a marketing page's address or an existing app route", () => {
    const marketing = new Set<string>(ALL_MARKETING_PATHS);
    for (const [slug, short] of Object.entries(OASIS_OFFER_SHORT_PATHS)) {
      if (slug === "vsl" || slug === "ai-audit") continue; // pre-existing, owned elsewhere
      assert.ok(!marketing.has(short), `${short} is a marketing page`);
      const name = short.slice(1);
      assert.ok(!existsSync(join("app", name)), `app/${name} already exists`);
      assert.ok(!existsSync(join("app", "(marketing)", name)), `app/(marketing)/${name} already exists`);
    }
    assert.equal(OASIS_OFFER_SHORT_PATHS.fleet, "/fleet-audit", "/fleet is the marketing fleet page, never FLEET's offer");
  });

  check("OASIS offers get their short link; every other workspace keeps /f/<workspace>/<offer>", () => {
    assert.equal(offerShareablePath("oasis-ai-cc", "protocol"), "/protocol");
    assert.equal(offerShareablePath("oasis-ai-cc", "fleet"), "/fleet-audit");
    assert.equal(offerShareablePath("oasis-ai-cc", "some-new-offer"), "/f/oasis-ai-cc/some-new-offer");
    assert.equal(offerShareablePath("acme", "protocol"), "/f/acme/protocol");
    assert.equal(offerShareablePath(null, "protocol"), null);
  });

  console.log("offer-short-links: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
