/**
 * lib/checkout/paid-alert.ts: the sales desk hears about a purchase made on
 * the public checkout (/pricing) as soon as Stripe confirms the payment.
 *
 * WHY (2026-10-19 audit). A buyer could pay CAD 1,500 to 15,000 on
 * oasisai.work/pricing and nobody on the team was told: the payment went into
 * the books (lib/founders-finances/stripe-ingest.ts) and Stripe sent its
 * receipt, and that was all. Now the payment_intent.succeeded branch tells the
 * sales desk (CC and Adon) through the one alert resolver, as the funnel's
 * lead alerts do, so someone books the kickoff.
 *
 * At least once, not exactly once. The webhook claims each event once, so a
 * redelivery tells no one; but if marking the event processed fails after the
 * alert went out, Stripe's retry sends it again. That is deliberate: a second
 * ping costs less than a missed sale. Test-mode events never get this far
 * (handleStripeEvent ignores them before dispatch).
 *
 * Best-effort: a failed alert is logged, never thrown, so it can never make
 * Stripe retry the booking of the payment. The buyer's own kickoff email is a
 * separate piece of work: it needs its words.
 */
import "server-only";
import { pushWorkspaceAlert, type AlertPush } from "@/lib/notify/alert-route";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
import { cad, resolveCheckoutOffer } from "./catalog";

/** What the public checkout stamped on its payment intent (lib/checkout/stripe.ts createOfferCheckout). */
export type PublicCheckoutSale = { orderId: string; offerId: string; optionId: string };

/** The checkout's facts from a raw payment intent, or null for a payment the public checkout did not start. */
export function publicCheckoutSale(rawPaymentIntent: unknown): PublicCheckoutSale | null {
  const md = (rawPaymentIntent as { metadata?: Record<string, unknown> } | null)?.metadata;
  if (!md || md.oasis_checkout !== "public_funnel_v1") return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { orderId: text(md.oasis_order_id), offerId: text(md.oasis_offer_id), optionId: text(md.oasis_option_id) };
}

export type PaidAlertInput = {
  sale: PublicCheckoutSale;
  amountCents: number;
  currency: string;
  customerName: string;
  customerEmail: string;
};

/**
 * The alert's words, as Telegram HTML: what was bought, for how much, by whom,
 * and what to do next. Everything that came from the buyer or Stripe is
 * escaped.
 */
export function paidAlertText(input: PaidAlertInput): string {
  const resolved = resolveCheckoutOffer(input.sale.offerId, input.sale.optionId);
  const what = resolved
    ? `${resolved.offer.name}: ${resolved.option.label}`
    : `${input.sale.offerId || "an unknown offer"} / ${input.sale.optionId || "an unknown option"} (not in the catalog)`;
  const currency = input.currency.toUpperCase();
  const amount = currency === "CAD" ? cad(input.amountCents) : `${(input.amountCents / 100).toFixed(2)} ${currency}`;
  const buyer = [input.customerName.trim(), input.customerEmail.trim() ? `<${input.customerEmail.trim()}>` : ""]
    .filter(Boolean)
    .join(" ");
  return [
    "New purchase on oasisai.work/pricing",
    what,
    `${amount} paid`,
    `Buyer: ${buyer || "no name or email on the payment; see Stripe"}`,
    `Order ${input.sale.orderId || "(no order id)"}`,
    "Next: reach out to book the kickoff.",
  ]
    .map(escapeTelegramHtml)
    .join("\n");
}

/** Tell the sales desk. Never throws; a failure is logged with the order id. */
export async function alertPublicCheckoutPaid(
  input: PaidAlertInput,
  push: (tenantId: string, text: string, opts: { desk: "sales" }) => Promise<AlertPush> = pushWorkspaceAlert,
): Promise<boolean> {
  try {
    const r = await push(OASIS_OPERATOR_TENANT_ID, paidAlertText(input), { desk: "sales" });
    if (r.delivered) return true;
    console.error("[checkout.paid-alert] the sales desk was not told of a purchase", { order: input.sale.orderId, outcome: r.outcome });
  } catch (err) {
    console.error("[checkout.paid-alert] the sales desk was not told of a purchase", {
      order: input.sale.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}
