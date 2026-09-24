/**
 * Stripe webhook signature verification (scheme v1). PURE apart from
 * node:crypto.
 *
 * Reimplemented from Stripe's published scheme, not copied from any SDK:
 *   Stripe-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=<hex>][,v0=...]
 *   expected = HMAC-SHA256(key = endpoint secret, message = "<t>.<raw body>")
 * Any one v1 value may match (Stripe sends several during secret rotation).
 * Compared with timingSafeEqual on equal-length buffers. The timestamp must be
 * within `toleranceSeconds` (default 300) of now in EITHER direction, which is
 * what stops a captured request being replayed later.
 *
 * The RAW body must be verified — re-serialising parsed JSON changes bytes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerdict =
  | { ok: true; timestamp: number }
  | {
      ok: false;
      reason:
        | "missing_secret"
        | "missing_header"
        | "malformed_header"
        | "no_matching_signature"
        | "timestamp_outside_tolerance";
    };

export function parseStripeSignatureHeader(header: string): { timestamp: number | null; v1: string[] } {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) v1.push(value.toLowerCase());
  }
  return { timestamp, v1 };
}

export function computeStripeSignature(payload: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

export function verifyStripeSignature(args: {
  payload: string;
  header: string | null | undefined;
  secret: string | null | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): SignatureVerdict {
  const secret = (args.secret || "").trim();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!args.header) return { ok: false, reason: "missing_header" };
  const { timestamp, v1 } = parseStripeSignatureHeader(args.header);
  if (timestamp === null || v1.length === 0) return { ok: false, reason: "malformed_header" };
  const expected = Buffer.from(computeStripeSignature(args.payload, secret, timestamp), "hex");
  let matched = false;
  for (const sig of v1) {
    const given = Buffer.from(sig, "hex");
    // Evaluate every candidate; do not short-circuit on the first match.
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: "no_matching_signature" };
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "timestamp_outside_tolerance" };
  return { ok: true, timestamp };
}
