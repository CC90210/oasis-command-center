import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIpFromHeaders } from "@/lib/api-helpers";
import { resolveCheckoutOffer } from "@/lib/checkout/catalog";
import { createOfferCheckout } from "@/lib/checkout/stripe";
import { SITE_ORIGIN } from "@/lib/marketing/routes";
import { readCappedJson, sameOrigin } from "@/lib/offer-pages/public-http";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;

function checkoutOrigin(req: Request): string {
  const origin = new URL(req.url).origin;
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? origin : SITE_ORIGIN;
}

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOrigin(req)) return json({ ok: false, error: "forbidden" }, 403);

  const ip = clientIpFromHeaders(req.headers);
  const limit = rateLimit({ key: `public-checkout:${ip}`, capacity: 8, refillPerSec: 1 / 30 });
  if (!limit.allowed) {
    return json({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }, 429);
  }

  const body = await readCappedJson(req, MAX_BODY_BYTES);
  const resolved = resolveCheckoutOffer(body?.offer_id, body?.option_id);
  if (!resolved) return json({ ok: false, error: "invalid_offer" }, 400);

  const secretKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey) {
    console.error("[public-checkout.create] STRIPE_SECRET_KEY is not configured");
    return json({ ok: false, error: "checkout_unavailable" }, 503);
  }

  const origin = checkoutOrigin(req);
  try {
    const checkout = await createOfferCheckout({
      secretKey,
      offer: resolved.offer,
      option: resolved.option,
      orderId: randomUUID(),
      successUrl: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/pricing?checkout=cancelled`,
    });
    return json({ ok: true, url: checkout.checkoutUrl }, 200);
  } catch (error) {
    console.error("[public-checkout.create]", error);
    return json({ ok: false, error: "checkout_unavailable" }, 502);
  }
}
