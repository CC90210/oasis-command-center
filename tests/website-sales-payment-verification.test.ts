import assert from "node:assert/strict";
import {
  createStripeWebsiteCheckout,
  verifyManualWebsitePayment,
  verifyStripeWebsitePayment,
} from "../lib/website-sales-payment";

function stripeFetch(body: Record<string, unknown>, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

async function main() {
const LEAD_ID = "db662cb9-8203-49cc-a1c4-96a51205c680";
const PAYMENT_TOKEN = "cf41c34c-e3f9-4a4f-89a9-e43487242302";
const PAYMENT_PLAN_ID = "af41c34c-e3f9-4a4f-89a9-e43487242303";
const TENANT_ID = "tenant-oasis";

const session = await verifyStripeWebsitePayment({
  secretKey: "sk_live_not_a_real_secret",
  reference: "cs_test_verified_123",
  expectedAmountCents: 250_000,
  expectedCurrency: "USD",
  expectedTenantId: TENANT_ID,
  expectedLeadId: LEAD_ID,
  expectedPaymentToken: PAYMENT_TOKEN,
  expectedPaymentPlanId: PAYMENT_PLAN_ID,
  fetchImpl: stripeFetch({
    object: "checkout.session",
    payment_status: "paid",
    amount_total: 250_000,
    currency: "usd",
    livemode: true,
    client_reference_id: LEAD_ID,
    metadata: {
      oasis_tenant_id: TENANT_ID,
      oasis_lead_id: LEAD_ID,
      oasis_payment_token: PAYMENT_TOKEN,
      oasis_payment_plan_id: PAYMENT_PLAN_ID,
    },
    payment_intent: {
      latest_charge: { refunded: false, amount_refunded: 0, disputed: false },
    },
  }),
});
assert.equal(session.providerStatus, "paid");
assert.equal(session.verificationSource, "stripe_api");

await assert.rejects(
  verifyStripeWebsitePayment({
    secretKey: "sk_live_not_a_real_secret",
    reference: "pi_unbound_123",
    expectedAmountCents: 100_000,
    expectedCurrency: "CAD",
    expectedTenantId: TENANT_ID,
    expectedLeadId: LEAD_ID,
    expectedPaymentToken: PAYMENT_TOKEN,
    expectedPaymentPlanId: PAYMENT_PLAN_ID,
    fetchImpl: stripeFetch({}),
  }),
  /stripe_checkout_session_required/,
);

await assert.rejects(
  verifyStripeWebsitePayment({
    secretKey: "sk_live_not_a_real_secret",
    reference: "cs_live_unpaid_123",
    expectedAmountCents: 100_000,
    expectedCurrency: "CAD",
    expectedTenantId: TENANT_ID,
    expectedLeadId: LEAD_ID,
    expectedPaymentToken: PAYMENT_TOKEN,
    expectedPaymentPlanId: PAYMENT_PLAN_ID,
    fetchImpl: stripeFetch({
      payment_status: "unpaid",
      amount_total: 100_000,
      currency: "cad",
      livemode: true,
      client_reference_id: LEAD_ID,
      metadata: { oasis_tenant_id: TENANT_ID, oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: false } },
    }),
  }),
  /payment_not_collected/,
);

await assert.rejects(
  verifyStripeWebsitePayment({
    secretKey: "sk_live_not_a_real_secret",
    reference: "cs_live_wrong_amount_123",
    expectedAmountCents: 100_000,
    expectedCurrency: "CAD",
    expectedTenantId: TENANT_ID,
    expectedLeadId: LEAD_ID,
    expectedPaymentToken: PAYMENT_TOKEN,
    expectedPaymentPlanId: PAYMENT_PLAN_ID,
    fetchImpl: stripeFetch({
      payment_status: "paid",
      amount_total: 99_999,
      currency: "cad",
      livemode: true,
      client_reference_id: LEAD_ID,
      metadata: { oasis_tenant_id: TENANT_ID, oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: false } },
    }),
  }),
  /payment_does_not_match_proposal/,
);

for (const [name, body, expected] of [
  [
    "test-mode money",
    {
      payment_status: "paid", amount_total: 100_000, currency: "cad", livemode: false,
      client_reference_id: LEAD_ID,
      metadata: { oasis_tenant_id: TENANT_ID, oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: false } },
    },
    /stripe_test_payment_not_accepted/,
  ],
  [
    "refunded money",
    {
      payment_status: "paid", amount_total: 100_000, currency: "cad", livemode: true,
      client_reference_id: LEAD_ID,
      metadata: { oasis_tenant_id: TENANT_ID, oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: true, amount_refunded: 100_000, disputed: false } },
    },
    /payment_refunded/,
  ],
  [
    "disputed money",
    {
      payment_status: "paid", amount_total: 100_000, currency: "cad", livemode: true,
      client_reference_id: LEAD_ID,
      metadata: { oasis_tenant_id: TENANT_ID, oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: true } },
    },
    /payment_disputed/,
  ],
  [
    "another lead's money",
    {
      payment_status: "paid", amount_total: 100_000, currency: "cad", livemode: true,
      client_reference_id: "another-lead",
      metadata: { oasis_tenant_id: TENANT_ID, oasis_lead_id: "another-lead", oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: false } },
    },
    /payment_not_bound_to_lead/,
  ],
  [
    "another tenant's money",
    {
      payment_status: "paid", amount_total: 100_000, currency: "cad", livemode: true,
      client_reference_id: LEAD_ID,
      metadata: { oasis_tenant_id: "tenant-other", oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: false } },
    },
    /payment_not_bound_to_lead/,
  ],
  [
    "missing tenant binding",
    {
      payment_status: "paid", amount_total: 100_000, currency: "cad", livemode: true,
      client_reference_id: LEAD_ID,
      metadata: { oasis_lead_id: LEAD_ID, oasis_payment_token: PAYMENT_TOKEN, oasis_payment_plan_id: PAYMENT_PLAN_ID },
      payment_intent: { latest_charge: { refunded: false, amount_refunded: 0, disputed: false } },
    },
    /payment_not_bound_to_lead/,
  ],
] as const) {
  await assert.rejects(
    verifyStripeWebsitePayment({
      secretKey: "sk_live_not_a_real_secret",
      reference: `cs_live_${name.replace(/[^A-Za-z0-9_]/g, "_")}`,
      expectedAmountCents: 100_000,
      expectedCurrency: "CAD",
      expectedTenantId: TENANT_ID,
      expectedLeadId: LEAD_ID,
      expectedPaymentToken: PAYMENT_TOKEN,
      expectedPaymentPlanId: PAYMENT_PLAN_ID,
      fetchImpl: stripeFetch(body),
    }),
    expected,
    name,
  );
}

let createRequest: { url: string; init?: RequestInit } | null = null;
const checkout = await createStripeWebsiteCheckout({
  secretKey: "sk_live_not_a_real_secret",
  tenantId: TENANT_ID,
  leadId: LEAD_ID,
  paymentToken: PAYMENT_TOKEN,
  paymentPlanId: PAYMENT_PLAN_ID,
  installmentKind: "deposit",
  amountCents: 100_000,
  currency: "CAD",
  customerEmail: "lead@example.com",
  description: "OASIS website setup payment",
  successUrl: `https://oasisai.work/pipeline/${LEAD_ID}?payment=success`,
  cancelUrl: `https://oasisai.work/pipeline/${LEAD_ID}?payment=cancelled`,
  fetchImpl: (async (url, init) => {
    createRequest = { url: String(url), init };
    return new Response(JSON.stringify({
      id: "cs_live_created_123",
      url: "https://checkout.stripe.com/c/pay/cs_live_created_123",
      livemode: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch,
});
assert.equal(checkout.reference, "cs_live_created_123");
assert.equal(checkout.url, "https://checkout.stripe.com/c/pay/cs_live_created_123");
assert.equal(createRequest?.url, "https://api.stripe.com/v1/checkout/sessions");
const checkoutBody = new URLSearchParams(String(createRequest?.init?.body));
assert.equal(checkoutBody.get("client_reference_id"), LEAD_ID);
assert.equal(checkoutBody.get("metadata[oasis_tenant_id]"), TENANT_ID);
assert.equal(checkoutBody.get("metadata[oasis_lead_id]"), LEAD_ID);
assert.equal(checkoutBody.get("metadata[oasis_payment_token]"), PAYMENT_TOKEN);
assert.equal(checkoutBody.get("metadata[oasis_payment_plan_id]"), PAYMENT_PLAN_ID);
assert.equal(checkoutBody.get("metadata[oasis_installment_kind]"), "deposit");
assert.equal(checkoutBody.get("line_items[0][price_data][unit_amount]"), "100000");

assert.throws(
  () =>
    verifyManualWebsitePayment({
      reference: "etransfer-123",
      amountCents: 200_000,
      currency: "CAD",
      expectedAmountCents: 200_000,
      expectedCurrency: "CAD",
      confirmed: false,
    }),
  /manual_payment_confirmation_required/,
);

const manual = verifyManualWebsitePayment({
  reference: "etransfer-123",
  amountCents: 200_000,
  currency: "CAD",
  expectedAmountCents: 200_000,
  expectedCurrency: "CAD",
  confirmed: true,
});
assert.equal(manual.provider, "manual");

console.log("website-sales-payment-verification: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
