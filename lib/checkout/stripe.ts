import "server-only";

import type { CheckoutOffer, CheckoutOption } from "@/lib/checkout/catalog";

type StripeObject = Record<string, unknown>;
type StripeFetch = typeof fetch;

export type CreatedCheckout = {
  sessionId: string;
  checkoutUrl: string;
  livemode: boolean;
};

export type CheckoutReceipt = {
  transactionId: string;
  orderId: string;
  amountCents: number;
  valueCad: number;
  currency: "CAD";
  offerName: string;
  optionLabel: string;
  customerEmail: string | null;
  livemode: boolean;
};

function object(value: unknown): StripeObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as StripeObject
    : null;
}

function absoluteHttpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid_${field}`);
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(`invalid_${field}`);
  }
  // Keep Stripe's literal {CHECKOUT_SESSION_ID} token intact. URL#toString()
  // percent-encodes the braces, which prevents Stripe from replacing it.
  return value.trim();
}

function sessionId(value: unknown): string | null {
  return typeof value === "string" && /^cs_(?:live|test)_[A-Za-z0-9_]+$/.test(value)
    ? value
    : null;
}

function stripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function requireSecret(secretKey: string): string {
  const key = secretKey.trim();
  if (!/^(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+$/.test(key)) throw new Error("stripe_not_connected");
  return key;
}

export async function createOfferCheckout(input: {
  secretKey: string;
  offer: CheckoutOffer;
  option: CheckoutOption;
  orderId: string;
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: StripeFetch;
}): Promise<CreatedCheckout> {
  const key = requireSecret(input.secretKey);
  if (!/^[a-f0-9-]{36}$/i.test(input.orderId)) throw new Error("invalid_order_id");
  if (!Number.isSafeInteger(input.option.amountCents) || input.option.amountCents < 100) {
    throw new Error("invalid_checkout_amount");
  }

  const params = new URLSearchParams({
    mode: "payment",
    client_reference_id: input.orderId,
    success_url: absoluteHttpUrl(input.successUrl, "success_url"),
    cancel_url: absoluteHttpUrl(input.cancelUrl, "cancel_url"),
    customer_creation: "always",
    billing_address_collection: "required",
    "line_items[0][price_data][currency]": "cad",
    "line_items[0][price_data][unit_amount]": String(input.option.amountCents),
    "line_items[0][price_data][product_data][name]": input.offer.name,
    "line_items[0][price_data][product_data][description]": input.option.description,
    "line_items[0][quantity]": "1",
    "metadata[oasis_checkout]": "public_funnel_v1",
    "metadata[oasis_offer_id]": input.offer.id,
    "metadata[oasis_option_id]": input.option.id,
    "metadata[oasis_order_id]": input.orderId,
    "payment_intent_data[metadata][oasis_checkout]": "public_funnel_v1",
    "payment_intent_data[metadata][oasis_offer_id]": input.offer.id,
    "payment_intent_data[metadata][oasis_option_id]": input.option.id,
    "payment_intent_data[metadata][oasis_order_id]": input.orderId,
  });

  const response = await (input.fetchImpl ?? fetch)("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `oasis-public-checkout-${input.orderId}`,
    },
    body: params.toString(),
    cache: "no-store",
  });
  const body = object(await response.json().catch(() => null));
  const id = sessionId(body?.id);
  const url = stripeCheckoutUrl(body?.url);
  if (!response.ok || !body || !id || !url || typeof body.livemode !== "boolean") {
    throw new Error("stripe_checkout_creation_failed");
  }
  return { sessionId: id, checkoutUrl: url, livemode: body.livemode };
}

export async function verifyOfferCheckout(input: {
  secretKey: string;
  checkoutSessionId: string;
  resolveOffer: (offerId: unknown, optionId: unknown) => { offer: CheckoutOffer; option: CheckoutOption } | null;
  fetchImpl?: StripeFetch;
}): Promise<CheckoutReceipt> {
  const key = requireSecret(input.secretKey);
  const id = sessionId(input.checkoutSessionId);
  if (!id) throw new Error("invalid_checkout_session");

  const response = await (input.fetchImpl ?? fetch)(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
    },
  );
  const body = object(await response.json().catch(() => null));
  if (!response.ok || !body) throw new Error("stripe_checkout_verification_failed");
  if (body.id !== id || body.status !== "complete" || body.payment_status !== "paid") {
    throw new Error("checkout_not_paid");
  }

  const metadata = object(body.metadata);
  const resolved = input.resolveOffer(metadata?.oasis_offer_id, metadata?.oasis_option_id);
  const amountCents = typeof body.amount_total === "number" && Number.isSafeInteger(body.amount_total)
    ? body.amount_total
    : null;
  const orderId = typeof metadata?.oasis_order_id === "string" ? metadata.oasis_order_id : "";
  if (
    metadata?.oasis_checkout !== "public_funnel_v1" ||
    !resolved ||
    !/^[a-f0-9-]{36}$/i.test(orderId) ||
    body.client_reference_id !== orderId ||
    amountCents !== resolved.option.amountCents ||
    String(body.currency ?? "").toLowerCase() !== "cad" ||
    typeof body.livemode !== "boolean"
  ) {
    throw new Error("checkout_receipt_mismatch");
  }

  const customerDetails = object(body.customer_details);
  return {
    transactionId: id,
    orderId,
    amountCents,
    valueCad: amountCents / 100,
    currency: "CAD",
    offerName: resolved.offer.name,
    optionLabel: resolved.option.label,
    customerEmail: typeof customerDetails?.email === "string" ? customerDetails.email : null,
    livemode: body.livemode,
  };
}
