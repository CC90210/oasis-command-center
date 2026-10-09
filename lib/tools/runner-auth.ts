/**
 * lib/tools/runner-auth.ts - who may call the tool runner's routes
 * (/api/internal/tools/{claim,heartbeat,upload-url,complete,fail}), and the
 * answer shapes they share.
 *
 * AUTH. The support desk's scheme (lib/delivery/support-ingest-auth.ts, itself
 * the Business Ledger's), with the tools' own header names and secret:
 *   x-tools-producer   bea (the only producer)
 *   x-tools-timestamp  unix seconds; more than 300 s either side of now = 401
 *                      {"error":"stale_timestamp"}
 *   x-tools-signature  lowercase hex HMAC-SHA256 over "<timestamp>.<raw body>",
 *                      keyed with TOOLS_RUNNER_SECRET_<PRODUCER> AS TEXT
 *                      (trimmed, at least 32 characters)
 * In this order: producer -> secret -> size -> signature -> JSON. The check is
 * lib/founders-finances/stripe-signature.ts verifyStripeSignature (timing-safe)
 * over the RAW body; nothing is parsed, and nothing is read from the database,
 * before the signature passes.
 *
 * STATUS DISCIPLINE (the runner acts on the status alone):
 *   401  unknown producer, bad signature, stale timestamp
 *   413  body over 64 KiB
 *   422  not JSON, or a field refused (`field` names it)
 *   503  {"error":"not_installed","detail":...}: secret_not_set, tables_missing,
 *        storage_not_configured, database_not_configured. The runner retries.
 * 404 and 405 are never answered from these handlers: they mean "this route is
 * not deployed". Every 2xx is a JSON object with ok: true.
 */
import "server-only";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import { readBodyCapped } from "@/lib/ledger/ingest";
import { RUNNER_BODY_MAX_BYTES, SIGNATURE_WINDOW_SECONDS } from "@/lib/tools/limits";

export const TOOLS_PRODUCERS = ["bea"] as const;
export type ToolsProducer = (typeof TOOLS_PRODUCERS)[number];

export const TOOLS_SECRET_MIN_LENGTH = 32;
export const HEADER_PRODUCER = "x-tools-producer";
export const HEADER_TIMESTAMP = "x-tools-timestamp";
export const HEADER_SIGNATURE = "x-tools-signature";

/** The Worker secret a producer signs with: TOOLS_RUNNER_SECRET_BEA. */
export function toolsSecretEnvName(producer: ToolsProducer): string {
  return `TOOLS_RUNNER_SECRET_${producer.toUpperCase()}`;
}

export function toolsJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** A refusal: a non-2xx with a short lowercase code. */
export function toolsRefuse(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return toolsJson(status, { ok: false, error, ...extra });
}

export type ToolsAuth =
  | { ok: true; producer: ToolsProducer; body: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Authenticate one request and parse its body, in that order. A request that
 * does not authenticate is never parsed; nothing is read or written for it.
 */
export async function authenticateToolsRequest(
  req: Request,
  env: Record<string, string | undefined>,
  now: Date,
): Promise<ToolsAuth> {
  const producerHeader = (req.headers.get(HEADER_PRODUCER) || "").trim().toLowerCase();
  if (!(TOOLS_PRODUCERS as readonly string[]).includes(producerHeader)) {
    return { ok: false, response: toolsRefuse(401, "unauthorized") };
  }
  const producer = producerHeader as ToolsProducer;
  const secret = (env[toolsSecretEnvName(producer)] || "").trim();
  if (secret.length < TOOLS_SECRET_MIN_LENGTH) {
    // Fail closed: an unset secret never means "open". 503 so the runner waits
    // for the secret to be pushed instead of giving up on its jobs.
    return { ok: false, response: toolsRefuse(503, "not_installed", { detail: "secret_not_set" }) };
  }

  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > RUNNER_BODY_MAX_BYTES) return { ok: false, response: toolsRefuse(413, "body_too_large") };
  const raw = await readBodyCapped(req, RUNNER_BODY_MAX_BYTES);
  if (raw === null) return { ok: false, response: toolsRefuse(413, "body_too_large") };

  const ts = (req.headers.get(HEADER_TIMESTAMP) || "").trim();
  const sig = (req.headers.get(HEADER_SIGNATURE) || "").trim().toLowerCase();
  // Digits and hex only: the two values are joined into one "t=..,v1=.." header
  // for the verifier, and a comma in either must not add a second signature.
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
      response: toolsRefuse(401, verdict.reason === "timestamp_outside_tolerance" ? "stale_timestamp" : "unauthorized"),
    };
  }

  // Authenticated from here.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, response: toolsRefuse(422, "invalid_json") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: toolsRefuse(422, "invalid_payload", { field: "body" }) };
  }
  return { ok: true, producer, body: body as Record<string, unknown> };
}
