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
 * WHEN IT GOES OUT (review of #718). After the books have the payment AND the
 * event is marked processed, kept alive past the answer to Stripe
 * (handleStripeEvent). Sent inline it held the webhook for 16 seconds when
 * Telegram did not answer (two 8-second attempts). So an event whose booking
 * or mark failed tells no one, and Stripe's retry of it tells the desk once; a
 * retry of a marked event is a duplicate (claimEvent) and tells no one. A Worker
 * that dies between the mark and the send tells no one and leaves no trace.
 * Test-mode events never get this far (handleStripeEvent ignores them before
 * dispatch).
 *
 * WHEN THE SEND FAILS (review of #718). Telegram refusing the sales group and
 * the DM behind it (the bot removed from the group, say) used to leave two log
 * lines and nothing else, for a sale of up to CAD 15,000. It now leaves an
 * urgent card in the OASIS workspace's Needs you list that names the order, the
 * buyer and the amount, and pages the operator chat too, which can work when
 * the sales group does not. The funnel's lead alerts leave their trace on the
 * lead's timeline (lib/forms/alert-failure.ts); a purchase has no lead, so the
 * card is its trace.
 *
 * WHEN THE WEBHOOK NEVER REPORTS IT (review of #718). The daily reconcile
 * (stripe-ingest.ts reconcileStripe) books any payment Stripe lists that the
 * books lack. When it books a public-checkout purchase itself, no webhook did,
 * so it tells the desk LATE (`late` below) if the payment intent is more than 30
 * minutes old (a webhook still in flight would have booked it first) and less
 * than 48 hours old (the first run after a deploy must not announce history).
 * Known duplicate, accepted: if a webhook failed, the reconcile booked and
 * alerted, and Stripe then retries that webhook, the intent's event alerts a
 * second time. A second ping costs less than a missed sale. Not covered: a
 * payment that charge.succeeded booked while payment_intent.succeeded never
 * arrived, and the Worker death above. Both leave the payment already booked,
 * and nothing records which payments the desk was told of.
 *
 * Best-effort: a failed alert is logged and carded, never thrown, so it can
 * never make Stripe retry the booking of the payment. The buyer's own kickoff
 * email is a separate piece of work: it needs its words.
 */
import "server-only";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
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

/**
 * The reconcile's late-alert window (see the header): a purchase it booked is
 * announced only when its payment intent is older than 30 minutes, so it never
 * races a webhook still in flight, and younger than 48 hours, so the first run
 * after a deploy does not announce history. `createdSec` is the intent's
 * `created` (epoch seconds). Assumes a Checkout intent is created when the buyer
 * confirms (Stripe API 2022-08-01 and later), so its age is the payment's.
 */
const LATE_ALERT_AFTER_MS = 30 * 60_000;
const LATE_ALERT_UNTIL_MS = 48 * 3_600_000;

export function inLateAlertWindow(createdSec: number, nowMs: number): boolean {
  const age = nowMs - createdSec * 1000;
  return age > LATE_ALERT_AFTER_MS && age < LATE_ALERT_UNTIL_MS;
}

export type PaidAlertInput = {
  sale: PublicCheckoutSale;
  /** The Stripe payment intent (pi_...): how the payment is found when the order id or the buyer is missing. */
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  customerName: string;
  customerEmail: string;
  /** The reconcile found this purchase, not the webhook: the alert says so. */
  late?: boolean;
};

/**
 * The most a message keeps of the buyer's name and email, and of an id from
 * the payment's metadata. A message is cut at 4,096 characters (telegram.ts),
 * and a buyer's name of 1,000 "&" escapes to 5,000: the cut landed inside
 * "&amp;", which Telegram's HTML mode refuses, so the alert was lost (review of
 * #718). Cutting BEFORE escaping keeps the whole message far under the limit.
 */
const NAME_MAX = 120;
const EMAIL_MAX = 254; // the longest an email address can be
const ID_MAX = 64; // an order id is 36 characters

/**
 * `s` cut to `max` whole characters, with "..." when it was cut. The cut-then-
 * escape the sibling sales alerts make (lib/forms/public-booking-alert.ts), by
 * characters rather than UTF-16 units: slice() and lib/fmt.ts truncate can
 * leave half an emoji, which is not valid text.
 */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : s;
}

/** The purchase in plain words, each part short enough that the message stays whole once escaped. */
function purchaseFacts(input: PaidAlertInput): { what: string; amount: string; buyer: string; order: string } {
  const { sale } = input;
  const resolved = resolveCheckoutOffer(sale.offerId, sale.optionId);
  const what = resolved
    ? `${resolved.offer.name}: ${resolved.option.label}`
    : `${clip(sale.offerId, ID_MAX) || "an unknown offer"} / ${clip(sale.optionId, ID_MAX) || "an unknown option"} (not in the catalog)`;
  const currency = input.currency.toUpperCase();
  const amount = currency === "CAD" ? cad(input.amountCents) : `${(input.amountCents / 100).toFixed(2)} ${currency}`;
  const name = clip(input.customerName.trim(), NAME_MAX);
  const email = clip(input.customerEmail.trim(), EMAIL_MAX);
  const buyer = [name, email ? `<${email}>` : ""].filter(Boolean).join(" ");
  return {
    what,
    amount,
    buyer: buyer || "no name or email on the payment; see Stripe",
    order: clip(sale.orderId, ID_MAX) || "(no order id)",
  };
}

/**
 * The alert's words, as Telegram HTML: what was bought, for how much, by whom,
 * and what to do next. The reconcile's late alert says so in its first line.
 * Everything that came from the buyer or Stripe is cut short, then escaped.
 */
export function paidAlertText(input: PaidAlertInput): string {
  const f = purchaseFacts(input);
  return [
    input.late ? "Late: a purchase on oasisai.work/pricing the webhook never reported" : "New purchase on oasisai.work/pricing",
    f.what,
    `${f.amount} paid`,
    `Buyer: ${f.buyer}`,
    `Order ${f.order}`,
    "Next: reach out to book the kickoff.",
  ]
    .map(escapeTelegramHtml)
    .join("\n");
}

/**
 * Leave a card in Needs you for a purchase whose alert could not be sent
 * (review of #718). One card per order: dedup is per (workspace, type,
 * subject), and a null subject would fold every failing purchase into one
 * card. Urgent, so it also pages the operator chat. Never throws; if the card
 * cannot be written either, a log line carries the order, the payment and the
 * amount.
 */
async function leaveFailureCard(input: PaidAlertInput, why: string): Promise<void> {
  try {
    const f = purchaseFacts(input);
    const reason = clip(why, 200);
    const card = await writeAgentAlert({
      tenantId: OASIS_OPERATOR_TENANT_ID,
      alertType: "checkout_purchase_alert_failed",
      severity: "urgent",
      subjectType: "checkout_order",
      subjectId: input.sale.orderId || input.paymentIntentId,
      title: "Purchase on /pricing: the sales desk was not told",
      body:
        `${f.amount} paid for ${f.what}. Buyer: ${f.buyer}. ` +
        `Order ${f.order}, Stripe ${clip(input.paymentIntentId, ID_MAX)}. ` +
        `Telegram would not take the alert (${reason}). ` +
        "The payment is in the books. Reach out to book the kickoff, then resolve this card.",
      payload: {
        order_id: input.sale.orderId,
        payment_intent: input.paymentIntentId,
        offer_id: input.sale.offerId,
        option_id: input.sale.optionId,
        amount_cents: input.amountCents,
        currency: input.currency,
        reason,
      },
    });
    if (!card.stored) {
      console.error("[checkout.paid-alert] no card could be written for a purchase the sales desk was not told of", {
        order: input.sale.orderId,
        paymentIntent: input.paymentIntentId,
        amountCents: input.amountCents,
        currency: input.currency,
      });
    }
  } catch (err) {
    console.error("[checkout.paid-alert] could not leave a card for a purchase the sales desk was not told of", {
      order: input.sale.orderId,
      paymentIntent: input.paymentIntentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Tell the sales desk. Never throws. A send that fails is logged with the order
 * id and leaves a card (leaveFailureCard).
 */
export async function alertPublicCheckoutPaid(
  input: PaidAlertInput,
  push: (tenantId: string, text: string, opts: { desk: "sales" }) => Promise<AlertPush> = pushWorkspaceAlert,
): Promise<boolean> {
  let why: string;
  try {
    const r = await push(OASIS_OPERATOR_TENANT_ID, paidAlertText(input), { desk: "sales" });
    if (r.delivered) return true;
    why = r.outcome;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  console.error("[checkout.paid-alert] the sales desk was not told of a purchase", { order: input.sale.orderId, outcome: why });
  await leaveFailureCard(input, why);
  return false;
}
