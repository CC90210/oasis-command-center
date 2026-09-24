/**
 * POST /api/webhooks/stripe-finance — OASIS's Stripe account -> the books.
 *
 * Public path (middleware lets /api/webhooks/* through); the route
 * authenticates every request itself:
 *   1. STRIPE_FINANCE_WEBHOOK_SECRET must be set, or every call is 503 —
 *      no secret never means "accept unsigned".
 *   2. Stripe's v1 signature over the RAW body, timingSafeEqual, 5-minute
 *      tolerance (lib/founders-finances/stripe-signature.ts).
 *   3. Idempotent on the Stripe event id (fin_stripe_events): a redelivery
 *      answers 200 "duplicate" and changes nothing.
 *
 * Handled: payment_intent.succeeded, charge.succeeded, charge.refunded,
 * invoice.paid, customer.subscription.created|updated|deleted. Anything else
 * is acknowledged and recorded as ignored. A processing failure answers 500 so
 * Stripe retries; the event row is marked failed and a retry reclaims it.
 */

import { NextResponse } from "next/server";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import { handleStripeEvent } from "@/lib/founders-finances/stripe-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(req: Request) {
  const secret = (process.env.STRIPE_FINANCE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "webhook_not_configured" }, { status: 503 });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  const verdict = verifyStripeSignature({ payload: raw, header: req.headers.get("stripe-signature"), secret });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: "invalid_signature", reason: verdict.reason }, { status: 400 });
  }
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  try {
    const outcome = await handleStripeEvent(event);
    if (outcome.status === "in_flight") {
      // Another delivery of this event is mid-processing. Non-2xx makes Stripe
      // retry later, when this one will either be done (duplicate) or failed
      // (reclaimed).
      return NextResponse.json({ ok: false, status: outcome.status, detail: outcome.detail }, { status: 409 });
    }
    return NextResponse.json({ ok: true, status: outcome.status, detail: outcome.detail });
  } catch (e) {
    console.error("[finances:stripe-webhook] processing failed", e);
    return NextResponse.json({ ok: false, error: "processing_failed" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
