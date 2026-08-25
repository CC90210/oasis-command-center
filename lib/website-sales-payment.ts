export type WebsitePaymentProvider = "stripe" | "manual";

export type VerifiedWebsitePayment = {
  provider: WebsitePaymentProvider;
  reference: string;
  amountCents: number;
  currency: "CAD" | "USD";
  providerStatus: string;
  verificationSource: "stripe_api" | "founder_manual";
  summary: Record<string, string | number | boolean | null>;
};

type StripeFetch = typeof fetch;

type StripeObject = Record<string, unknown>;

export type StripeWebsiteCheckout = {
  reference: string;
  url: string;
  livemode: true;
};

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function normalizeCurrency(value: unknown): "CAD" | "USD" | null {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  return normalized === "CAD" || normalized === "USD" ? normalized : null;
}

function asObject(value: unknown): StripeObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as StripeObject
    : null;
}

function stripeCheckoutFacts(row: StripeObject): {
  paid: boolean;
  status: string;
  amountCents: number | null;
  currency: "CAD" | "USD" | null;
  refunded: boolean | null;
  disputed: boolean | null;
} {
  const status = typeof row.status === "string" ? row.status : "unknown";
  const paymentStatus = typeof row.payment_status === "string" ? row.payment_status : status;
  const paymentIntent = asObject(row.payment_intent);
  const charge = asObject(paymentIntent?.latest_charge);
  const refunded = charge
    ? charge.refunded === true || (asInteger(charge.amount_refunded) ?? 0) > 0
    : null;
  const disputed = charge ? charge.disputed === true : null;
  return {
    paid: paymentStatus === "paid",
    status: paymentStatus,
    amountCents: asInteger(row.amount_total),
    currency: normalizeCurrency(row.currency),
    refunded,
    disputed,
  };
}

function validateAbsoluteUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid_${field}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`invalid_${field}`);
  return url.toString();
}

/**
 * Create the one Stripe object this workflow knows how to verify: a Checkout
 * Session whose amount and identity are frozen to this lead. Reusing the
 * payment token as Stripe's idempotency key makes a network retry return the
 * same session instead of creating a second live link.
 */
export async function createStripeWebsiteCheckout(input: {
  secretKey: string;
  tenantId: string;
  leadId: string;
  paymentToken: string;
  paymentPlanId: string;
  installmentKind: "deposit" | "balance" | "full";
  amountCents: number;
  currency: "CAD" | "USD";
  customerEmail?: string | null;
  description: string;
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: StripeFetch;
}): Promise<StripeWebsiteCheckout> {
  if (!input.secretKey.trim()) throw new Error("stripe_not_connected");
  if (
    !input.tenantId.trim() ||
    !input.leadId.trim() ||
    !input.paymentToken.trim() ||
    !input.paymentPlanId.trim()
  ) {
    throw new Error("invalid_payment_binding");
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("invalid_payment_amount");
  }
  const params = new URLSearchParams({
    mode: "payment",
    client_reference_id: input.leadId,
    success_url: validateAbsoluteUrl(input.successUrl, "success_url"),
    cancel_url: validateAbsoluteUrl(input.cancelUrl, "cancel_url"),
    "line_items[0][price_data][currency]": input.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(input.amountCents),
    "line_items[0][price_data][product_data][name]": input.description.trim().slice(0, 120),
    "line_items[0][quantity]": "1",
    "metadata[oasis_tenant_id]": input.tenantId,
    "metadata[oasis_lead_id]": input.leadId,
    "metadata[oasis_payment_token]": input.paymentToken,
    "metadata[oasis_payment_plan_id]": input.paymentPlanId,
    "metadata[oasis_installment_kind]": input.installmentKind,
    "payment_intent_data[metadata][oasis_tenant_id]": input.tenantId,
    "payment_intent_data[metadata][oasis_lead_id]": input.leadId,
    "payment_intent_data[metadata][oasis_payment_token]": input.paymentToken,
    "payment_intent_data[metadata][oasis_payment_plan_id]": input.paymentPlanId,
    "payment_intent_data[metadata][oasis_installment_kind]": input.installmentKind,
  });
  if (input.customerEmail?.trim()) params.set("customer_email", input.customerEmail.trim());
  const response = await (input.fetchImpl ?? fetch)("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `oasis-website-${input.paymentToken}`,
    },
    body: params.toString(),
    cache: "no-store",
  });
  const body = asObject(await response.json().catch(() => null));
  if (!response.ok || !body) throw new Error("stripe_checkout_creation_failed");
  if (body.livemode !== true) throw new Error("stripe_live_mode_required");
  const reference = typeof body.id === "string" ? body.id : "";
  const url = typeof body.url === "string" ? body.url : "";
  if (!/^cs_live_[A-Za-z0-9_]+$/.test(reference) || !url.startsWith("https://checkout.stripe.com/")) {
    throw new Error("stripe_checkout_creation_failed");
  }
  return { reference, url, livemode: true };
}

/**
 * Verify cash collection directly with Stripe. The client never supplies a
 * trusted amount or status: both come from Stripe and must exactly match the
 * proposal frozen on the lead before any commission can accrue.
 */
export async function verifyStripeWebsitePayment(input: {
  secretKey: string;
  reference: string;
  expectedAmountCents: number;
  expectedCurrency: "CAD" | "USD";
  expectedTenantId: string;
  expectedLeadId: string;
  expectedPaymentToken: string;
  expectedPaymentPlanId: string;
  fetchImpl?: StripeFetch;
}): Promise<VerifiedWebsitePayment> {
  const reference = input.reference.trim();
  if (!/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(reference)) {
    throw new Error("stripe_checkout_session_required");
  }
  if (!input.secretKey.trim()) throw new Error("stripe_not_connected");
  const fetchImpl = input.fetchImpl ?? fetch;
  const resource = new URL(`https://api.stripe.com/v1/checkout/sessions/${reference}`);
  resource.searchParams.append("expand[]", "payment_intent.latest_charge");
  const response = await fetchImpl(resource.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const body = asObject(await response.json().catch(() => null));
  if (!response.ok || !body) {
    throw new Error(response.status === 404 ? "stripe_payment_not_found" : "stripe_verification_failed");
  }
  if (body.livemode !== true) throw new Error("stripe_test_payment_not_accepted");
  const metadata = asObject(body.metadata);
  if (
    metadata?.oasis_tenant_id !== input.expectedTenantId ||
    body.client_reference_id !== input.expectedLeadId ||
    metadata?.oasis_lead_id !== input.expectedLeadId ||
    metadata?.oasis_payment_token !== input.expectedPaymentToken ||
    metadata?.oasis_payment_plan_id !== input.expectedPaymentPlanId
  ) {
    throw new Error("payment_not_bound_to_lead");
  }
  const facts = stripeCheckoutFacts(body);
  if (!facts.paid) throw new Error("payment_not_collected");
  if (facts.refunded === null) throw new Error("stripe_payment_refund_state_unavailable");
  if (facts.disputed === null) throw new Error("stripe_payment_dispute_state_unavailable");
  if (facts.refunded) throw new Error("payment_refunded");
  if (facts.disputed) throw new Error("payment_disputed");
  if (facts.amountCents === null || facts.currency === null) {
    throw new Error("stripe_payment_missing_amount");
  }
  if (facts.amountCents !== input.expectedAmountCents || facts.currency !== input.expectedCurrency) {
    throw new Error("payment_does_not_match_proposal");
  }
  return {
    provider: "stripe",
    reference,
    amountCents: facts.amountCents,
    currency: facts.currency,
    providerStatus: facts.status,
    verificationSource: "stripe_api",
    summary: {
      object: typeof body.object === "string" ? body.object : null,
      livemode: body.livemode === true,
      provider_status: facts.status,
      payment_plan_id: input.expectedPaymentPlanId,
      payment_token: input.expectedPaymentToken,
    },
  };
}

/** Founder-only fallback for Interac, wire, or another non-Stripe receipt. */
export function verifyManualWebsitePayment(input: {
  reference: string;
  amountCents: number;
  currency: "CAD" | "USD";
  expectedAmountCents: number;
  expectedCurrency: "CAD" | "USD";
  confirmed: boolean;
}): VerifiedWebsitePayment {
  const reference = input.reference.trim();
  if (!input.confirmed) throw new Error("manual_payment_confirmation_required");
  if (reference.length < 4 || reference.length > 240) throw new Error("invalid_payment_reference");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("invalid_payment_amount");
  }
  if (input.amountCents !== input.expectedAmountCents || input.currency !== input.expectedCurrency) {
    throw new Error("payment_does_not_match_proposal");
  }
  return {
    provider: "manual",
    reference,
    amountCents: input.amountCents,
    currency: input.currency,
    providerStatus: "founder_confirmed_collected",
    verificationSource: "founder_manual",
    summary: { founder_confirmed: true },
  };
}
