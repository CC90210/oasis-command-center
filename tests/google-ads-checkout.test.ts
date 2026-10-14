import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKOUT_OFFERS, resolveCheckoutOffer } from "../lib/checkout/catalog";
import { createOfferCheckout, verifyOfferCheckout } from "../lib/checkout/stripe";
import { GOOGLE_ADS_TAG_ID, purchaseConversionPayload } from "../lib/marketing/google-ads";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

async function main() {

// 1-3: tag id, loader, and init are one corrected value in the root <head>.
const layout = read("app/layout.tsx");
assert.equal(GOOGLE_ADS_TAG_ID, "AW-18509362419");
assert.match(layout, /googletagmanager\.com\/gtag\/js\?id=AW-18509362419/);
assert.match(layout, /gtag\('config', 'AW-18509362419'\)/);
assert.match(layout, /shouldLoadGoogleAdsTag = ALL_MARKETING_PATHS\.includes/);
assert.match(layout, /\{shouldLoadGoogleAdsTag \? \(/);
assert.doesNotMatch(layout, /AW-(?!18509362419)\d{8,}/, "no stale Google Ads id remains in the root layout");

// 4: three server-owned tiers cover every advertised CAD band.
assert.equal(CHECKOUT_OFFERS.length, 3);
assert.deepEqual(CHECKOUT_OFFERS.map((offer) => offer.options.map((option) => option.amountCents)), [
  [150_000, 200_000, 250_000],
  [350_000, 425_000, 500_000],
  [750_000, 1_000_000, 1_500_000],
]);
assert.equal(resolveCheckoutOffer("audit-sprint", "focused")?.option.amountCents, 150_000);
assert.equal(resolveCheckoutOffer("audit-sprint", "not-real"), null);

// 5: the Stripe request uses the catalogue amount and binds the receipt.
const picked = resolveCheckoutOffer("sales-setter", "scale")!;
let createBody = new URLSearchParams();
let createHeaders = new Headers();
const created = await createOfferCheckout({
  secretKey: "sk_test_fixture_only",
  offer: picked.offer,
  option: picked.option,
  orderId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  successUrl: "https://oasisai.work/checkout/success?session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://oasisai.work/pricing?checkout=cancelled",
  fetchImpl: (async (_url, init) => {
    createBody = new URLSearchParams(String(init?.body));
    createHeaders = new Headers(init?.headers);
    return Response.json({ id: "cs_test_fixture_123", url: "https://checkout.stripe.com/c/pay/cs_test_fixture_123", livemode: false });
  }) as typeof fetch,
});
assert.equal(created.sessionId, "cs_test_fixture_123");
assert.equal(createBody.get("line_items[0][price_data][unit_amount]"), "425000");
assert.equal(createBody.get("line_items[0][price_data][currency]"), "cad");
assert.equal(createBody.get("metadata[oasis_offer_id]"), "sales-setter");
assert.equal(createBody.get("metadata[oasis_option_id]"), "scale");
assert.equal(createHeaders.get("idempotency-key"), "oasis-public-checkout-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

// 6-7: only a Stripe-confirmed paid session with matching metadata and amount
// becomes a conversion receipt. This is the permanent $1 CAD synthetic canary:
// it proves the exact payload shape without exposing a $1 production product.
const fixtureOffer = { ...picked.offer, id: "canary", name: "Checkout canary" };
const fixtureOption = { ...picked.option, id: "one-dollar", label: "$1 canary", amountCents: 100 };
const fixtureResolver = () => ({ offer: fixtureOffer, option: fixtureOption });
const paid = {
  id: "cs_test_paid_canary_123",
  status: "complete",
  payment_status: "paid",
  amount_total: 100,
  currency: "cad",
  livemode: false,
  client_reference_id: "11111111-2222-4333-8444-555555555555",
  metadata: {
    oasis_checkout: "public_funnel_v1",
    oasis_offer_id: "canary",
    oasis_option_id: "one-dollar",
    oasis_order_id: "11111111-2222-4333-8444-555555555555",
  },
  customer_details: { email: "canary@oasisai.work" },
};
const receipt = await verifyOfferCheckout({
  secretKey: "sk_test_fixture_only",
  checkoutSessionId: paid.id,
  resolveOffer: fixtureResolver,
  fetchImpl: (async () => Response.json(paid)) as typeof fetch,
});
assert.equal(receipt.valueCad, 1);
const conversionDestination = "AW-18509362419/test_purchase_label";
assert.deepEqual(purchaseConversionPayload({
  valueCad: receipt.valueCad,
  transactionId: receipt.transactionId,
  sendTo: conversionDestination,
}), {
  send_to: conversionDestination,
  value: 1,
  currency: "CAD",
  transaction_id: "cs_test_paid_canary_123",
});
assert.equal(purchaseConversionPayload({
  valueCad: receipt.valueCad,
  transactionId: receipt.transactionId,
  sendTo: "AW-18509362419",
}), null, "a bare tag id must not masquerade as a purchase conversion action");

await assert.rejects(
  verifyOfferCheckout({
    secretKey: "sk_test_fixture_only",
    checkoutSessionId: paid.id,
    resolveOffer: fixtureResolver,
    fetchImpl: (async () => Response.json({ ...paid, payment_status: "unpaid" })) as typeof fetch,
  }),
  /checkout_not_paid/,
);
await assert.rejects(
  verifyOfferCheckout({
    secretKey: "sk_test_fixture_only",
    checkoutSessionId: paid.id,
    resolveOffer: fixtureResolver,
    fetchImpl: (async () => Response.json({ ...paid, amount_total: 101 })) as typeof fetch,
  }),
  /checkout_receipt_mismatch/,
);

// 8: the browser guard is scoped to the Stripe transaction and marks only
// after gtag receives the conversion call.
const conversion = read("components/marketing/PurchaseConversion.tsx");
assert.match(conversion, /sessionStorage\.getItem\(storageKey\)/);
assert.match(conversion, /window\.gtag\("event", "conversion"/);
assert.ok(conversion.indexOf("window.gtag") < conversion.indexOf("sessionStorage.setItem"));

// 9-10: all six ad sitelinks resolve to real App Router pages. Four share one
// allow-listed dynamic entry to avoid duplicating route manifests in the
// size-constrained Cloudflare Worker; fleet and work keep their static pages.
const funnelPage = read("app/(marketing)/funnel/[funnel]/page.tsx");
for (const route of ["audit", "command-center", "pricing", "onboarding"]) {
  const key = route === "audit" ? "audit:" : `"${route}":`;
  assert.ok(funnelPage.includes(key), `/${route} is allow-listed by the funnel route`);
}
for (const route of ["fleet", "work"]) {
  assert.ok(read(`app/(marketing)/${route}/page.tsx`).length > 200, `/${route} is a real page`);
}
assert.ok(funnelPage.includes('case "checkout-success"'), "/checkout/success shares the size-safe public route");
const nextConfig = read("next.config.js");
for (const route of ["audit", "command-center", "pricing", "onboarding"]) {
  assert.match(nextConfig, new RegExp(`source:\\s*"/${route}"[\\s\\S]*destination:\\s*"/funnel/${route}"`));
}
assert.match(nextConfig, /source:\s*"\/checkout\/success"[\s\S]*destination:\s*"\/funnel\/checkout-success"/);
assert.doesNotMatch(nextConfig, /redirects\(\)[\s\S]*source:\s*"\/pricing"/, "/pricing must render instead of redirecting");
const middleware = read("middleware.ts");
assert.match(middleware, /"\/api\/checkout\/session"/);
assert.match(middleware, /pathname\.startsWith\("\/onboarding\/"\)/);

console.log("google-ads-checkout: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
