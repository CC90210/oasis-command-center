/**
 * lib/delivery/support-ingest-auth.ts - who may call the support inbox's
 * internal routes (/api/internal/support/{ingest,heartbeat,pending-drafts,draft}),
 * and the answer shapes they share.
 *
 * AUTH. Exactly the Business Ledger's scheme (lib/ledger/ingest.ts), with the
 * support inbox's own header names and secret:
 *   x-support-producer   bea
 *   x-support-timestamp  unix seconds; more than 300 s either side of now = 401
 *                        {"error":"stale_timestamp"}
 *   x-support-signature  lowercase hex HMAC-SHA256 over "<timestamp>.<raw body>",
 *                        keyed with SUPPORT_INGEST_SECRET_<PRODUCER> AS TEXT
 *                        (trimmed, at least 32 characters)
 * The check is lib/founders-finances/stripe-signature.ts verifyStripeSignature
 * (timing-safe compare), over the RAW body, BEFORE anything parses it as JSON.
 * The body is read through a 512 KB cap first (readBodyCapped): an
 * unauthenticated caller cannot make the Worker buffer more than that.
 *
 * It does not use lib/internal-hmac.ts: that one has no timestamp, so no replay
 * window, and its secret is shared with send_gateway and the VPS daemons.
 *
 * STATUS DISCIPLINE (the reader acts on the status alone, BEA occ_client.py):
 *   401  unknown producer, missing or bad signature, stale timestamp
 *   413  body over 512 KB
 *   422  the body is not valid JSON, or fails validation
 *   503  {"error":"not_installed"}: the producer's secret is unset, or the
 *        support tables are missing (migration bravo__200). The reader retries.
 * 404 and 405 are never answered from here: they mean "this route is not
 * deployed", and the reader stops on them instead of discarding mail.
 * Every 2xx is a JSON object with ok: true.
 */
import type { Client } from "@libsql/client";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import { readBodyCapped } from "@/lib/ledger/ingest";

export const SUPPORT_INGEST_PRODUCERS = ["bea"] as const;
export type SupportIngestProducer = (typeof SUPPORT_INGEST_PRODUCERS)[number];

export const SUPPORT_MAX_BODY_BYTES = 512 * 1024;
export const SUPPORT_SIGNATURE_WINDOW_SECONDS = 300;
export const SUPPORT_SECRET_MIN_LENGTH = 32;

export const HEADER_PRODUCER = "x-support-producer";
export const HEADER_TIMESTAMP = "x-support-timestamp";
export const HEADER_SIGNATURE = "x-support-signature";

/** The Worker secret a producer signs with: SUPPORT_INGEST_SECRET_BEA. */
export function supportSecretEnvName(producer: SupportIngestProducer): string {
  return `SUPPORT_INGEST_SECRET_${producer.toUpperCase()}`;
}

/** A JSON answer. Every refusal is a non-2xx with a short lowercase error code. */
export function supportJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refuse(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return supportJson(status, { ok: false, error, ...extra });
}

export type SupportAuth =
  /** signedAt: the request's x-support-timestamp (unix seconds), as the signature verified it. */
  | { ok: true; producer: SupportIngestProducer; body: unknown; signedAt: number }
  | { ok: false; response: Response };

/**
 * Authenticate one request and parse its body, in that order. A request that
 * does not authenticate is never parsed; nothing is written for it.
 */
export async function authenticateSupportRequest(
  req: Request,
  env: Record<string, string | undefined>,
  now: Date,
): Promise<SupportAuth> {
  const producerHeader = (req.headers.get(HEADER_PRODUCER) || "").trim().toLowerCase();
  if (!(SUPPORT_INGEST_PRODUCERS as readonly string[]).includes(producerHeader)) {
    return { ok: false, response: refuse(401, "unauthorized") };
  }
  const producer = producerHeader as SupportIngestProducer;
  const secret = (env[supportSecretEnvName(producer)] || "").trim();
  if (secret.length < SUPPORT_SECRET_MIN_LENGTH) {
    // Fail closed: an unset secret never means "open". 503 so the reader keeps
    // the mail and retries once the secret is pushed.
    return {
      ok: false,
      response: refuse(503, "not_installed", {
        detail: `${supportSecretEnvName(producer)} is not set (min ${SUPPORT_SECRET_MIN_LENGTH} characters).`,
      }),
    };
  }

  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > SUPPORT_MAX_BODY_BYTES) return { ok: false, response: refuse(413, "body_too_large") };
  const raw = await readBodyCapped(req, SUPPORT_MAX_BODY_BYTES);
  if (raw === null) return { ok: false, response: refuse(413, "body_too_large") };

  const ts = (req.headers.get(HEADER_TIMESTAMP) || "").trim();
  const sig = (req.headers.get(HEADER_SIGNATURE) || "").trim().toLowerCase();
  const verdict = verifyStripeSignature({
    payload: raw,
    header: ts && sig ? `t=${ts},v1=${sig}` : null,
    secret,
    nowSeconds: Math.floor(now.getTime() / 1000),
    toleranceSeconds: SUPPORT_SIGNATURE_WINDOW_SECONDS,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      response: refuse(401, verdict.reason === "timestamp_outside_tolerance" ? "stale_timestamp" : "unauthorized"),
    };
  }

  // Authenticated from here.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, response: refuse(422, "invalid_json") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: refuse(422, "invalid_payload", { field: "body" }) };
  }
  return { ok: true, producer, body, signedAt: verdict.timestamp };
}

/**
 * The support inbox's tables, all present? One statement: SQLite prepares the
 * whole of it, so a missing table, the missing comment channel column or the
 * missing heartbeat signed_at column fails it before anything runs. False =
 * migration bravo__200 is not applied, and the route answers 503 not_installed.
 */
export async function supportInboxInstalled(db: Client): Promise<boolean> {
  try {
    await db.execute(
      `SELECT (SELECT COUNT(*) FROM support_email_messages WHERE 0) AS m,
              (SELECT signed_at FROM support_mailbox_status WHERE 0) AS s,
              (SELECT channel FROM ticket_comments WHERE 0) AS c`,
    );
    return true;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (/no such table|no such column/.test(msg)) return false;
    throw err;
  }
}
