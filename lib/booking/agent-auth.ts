/**
 * lib/booking/agent-auth.ts - who may call the booking agent routes (/api/internal/booking/{slots,offers,book}).
 *
 * The Instagram DM setter on OASIS's PC (BEA scripts/lib/occ_booking_client.py) books calls through the same engine
 * as /book, so an Instagram booking gets the Oasis Meet room, the Schedule copy, the pipeline move and the sales-desk
 * alert a website booking gets (CC, 2026-10-18). It holds no session. It signs every request the way the tool runner
 * does (lib/tools/runner-auth.ts), with its OWN secret, so a leaked runner secret cannot book a meeting and this one
 * cannot claim a runner job:
 *   x-booking-producer   bea (the only producer; it books for the OASIS workspace only)
 *   x-booking-timestamp  unix seconds; more than 300 s either side of now = 401 {"error":"stale_timestamp"}
 *   x-booking-signature  lowercase hex HMAC-SHA256 over "<timestamp>.<raw body>", keyed with
 *                        BOOKING_AGENT_SECRET_<PRODUCER> AS TEXT (trimmed, at least 32 characters)
 * In this order: producer -> secret -> size -> signature -> JSON. Nothing is parsed, and nothing is read from the
 * database, before the signature passes (verifyStripeSignature, timing-safe, over the raw body).
 *
 * STATUS DISCIPLINE (the setter acts on the status alone):
 *   401  unknown producer, bad signature, stale timestamp
 *   413  body over 8 KiB
 *   422  not JSON, or a field refused (`field` names it)
 *   503  {"error":"not_installed","detail":"secret_not_set"}: the setter offers no times and books nothing
 * 404 and 405 are never answered from these handlers: they mean "this route is not deployed".
 */
import "server-only";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import { readBodyCapped } from "@/lib/ledger/ingest";
import { SIGNATURE_WINDOW_SECONDS } from "@/lib/tools/limits";

/** Each producer and the one workspace it may book for. */
export const BOOKING_AGENT_PRODUCERS = { bea: AI_AUDIT_TENANT_ID } as const;
export type BookingAgentProducer = keyof typeof BOOKING_AGENT_PRODUCERS;

export const BOOKING_AGENT_SECRET_MIN_LENGTH = 32;
export const BOOKING_AGENT_BODY_MAX_BYTES = 8 * 1024;
export const HEADER_PRODUCER = "x-booking-producer";
export const HEADER_TIMESTAMP = "x-booking-timestamp";
export const HEADER_SIGNATURE = "x-booking-signature";

/** The Worker secret a producer signs with: BOOKING_AGENT_SECRET_BEA. */
export function bookingAgentSecretEnvName(producer: BookingAgentProducer): string {
  return `BOOKING_AGENT_SECRET_${producer.toUpperCase()}`;
}

export function bookingAgentJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** A refusal: a non-2xx with a short lowercase code. */
export function bookingAgentRefuse(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return bookingAgentJson(status, { ok: false, error, ...extra });
}

export type BookingAgentAuth =
  | { ok: true; producer: BookingAgentProducer; tenantId: string; body: Record<string, unknown> }
  | { ok: false; response: Response };

/** Authenticate one request and parse its body, in that order. A request that does not authenticate is never parsed. */
export async function authenticateBookingAgentRequest(
  req: Request,
  env: Record<string, string | undefined>,
  now: Date,
): Promise<BookingAgentAuth> {
  const producerHeader = (req.headers.get(HEADER_PRODUCER) || "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(BOOKING_AGENT_PRODUCERS, producerHeader)) {
    return { ok: false, response: bookingAgentRefuse(401, "unauthorized") };
  }
  const producer = producerHeader as BookingAgentProducer;
  const secret = (env[bookingAgentSecretEnvName(producer)] || "").trim();
  if (secret.length < BOOKING_AGENT_SECRET_MIN_LENGTH) {
    // Fail closed: an unset secret never means "open".
    return { ok: false, response: bookingAgentRefuse(503, "not_installed", { detail: "secret_not_set" }) };
  }

  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > BOOKING_AGENT_BODY_MAX_BYTES) return { ok: false, response: bookingAgentRefuse(413, "body_too_large") };
  const raw = await readBodyCapped(req, BOOKING_AGENT_BODY_MAX_BYTES);
  if (raw === null) return { ok: false, response: bookingAgentRefuse(413, "body_too_large") };

  const ts = (req.headers.get(HEADER_TIMESTAMP) || "").trim();
  const sig = (req.headers.get(HEADER_SIGNATURE) || "").trim().toLowerCase();
  // Digits and hex only: the two values are joined into one "t=..,v1=.." header for the verifier, and a comma in
  // either must not add a second signature.
  const shaped = /^\d{1,12}$/.test(ts) && /^[0-9a-f]{64}$/.test(sig);
  const verdict = verifyStripeSignature({
    payload: raw,
    header: shaped ? `t=${ts},v1=${sig}` : null,
    secret,
    nowSeconds: Math.floor(now.getTime() / 1000),
    toleranceSeconds: SIGNATURE_WINDOW_SECONDS,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      response: bookingAgentRefuse(401, verdict.reason === "timestamp_outside_tolerance" ? "stale_timestamp" : "unauthorized"),
    };
  }

  // Authenticated from here.
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, response: bookingAgentRefuse(422, "invalid_json") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: bookingAgentRefuse(422, "invalid_payload", { field: "body" }) };
  }
  return { ok: true, producer, tenantId: BOOKING_AGENT_PRODUCERS[producer], body: body as Record<string, unknown> };
}
