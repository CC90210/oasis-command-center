/**
 * lib/integrations/quo-webhook.ts - authenticate and read Quo's inbound
 * webhook deliveries, so a STOP texted back to OASIS's Quo number reaches the
 * workspace's STOP list (app/api/webhooks/quo/route.ts).
 *
 * SIGNING (the 2026-03-30 versioned API, "Standard Webhooks" style). Each
 * delivery carries three headers:
 *   webhook-id         a stable delivery id
 *   webhook-timestamp  Unix seconds when Quo signed it
 *   webhook-signature  space-separated "v1,<base64>" entries
 * The signed content is "<webhook-id>.<webhook-timestamp>.<raw body>", the MAC
 * is HMAC-SHA256 keyed with the base64 that follows "whsec_" in the webhook's
 * signing key (QUO_WEBHOOK_SIGNING_KEY), encoded as standard base64. Any one
 * matching v1 entry passes; a timestamp more than 5 minutes off is refused.
 * Nothing is parsed or read before the signature passes.
 *
 * PAYLOAD (https://www.quo.com/docs/2026-03-30/webhooks-event-payloads):
 *   versioned  { id, apiVersion, createdAt, type,
 *                data: { resource: { id, text, direction, createdAt },
 *                        context: { senderIdentifier, recipientIdentifiers } } }
 *   legacy     { id, type, createdAt, data: { object: { id, from, to, body, direction, createdAt } } }
 * A field that is not where either shape puts it is null, never guessed.
 * `occurredAt` (the envelope's createdAt, else the message's) orders consent
 * changes: Quo retries and does not promise order, so an older START must
 * never lift a newer STOP (app/api/webhooks/quo).
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const QUO_WEBHOOK_KEY_ENV = "QUO_WEBHOOK_SIGNING_KEY";
export const QUO_WEBHOOK_TOLERANCE_S = 300;
export const QUO_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export type QuoWebhookVerdict =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_headers" | "stale_timestamp" | "bad_signature" };

function keyBytes(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (!trimmed) return null;
  const encoded = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length >= 16 ? bytes : null;
}

/** The signing key is set and well-formed ("whsec_" + base64 of at least 16 bytes). */
export function quoWebhookKeyConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return keyBytes(env[QUO_WEBHOOK_KEY_ENV] || "") !== null;
}

export function verifyQuoWebhook(input: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secret: string | undefined;
  nowMs: number;
}): QuoWebhookVerdict {
  const key = keyBytes(input.secret || "");
  if (!key) return { ok: false, reason: "not_configured" };
  const id = (input.id || "").trim();
  const timestamp = (input.timestamp || "").trim();
  const header = (input.signature || "").trim();
  if (!id || !/^\d{1,12}$/.test(timestamp) || !header) return { ok: false, reason: "missing_headers" };
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > QUO_WEBHOOK_TOLERANCE_S) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = Buffer.from(
    createHmac("sha256", key).update(`${id}.${timestamp}.${input.rawBody}`, "utf8").digest("base64"),
  );
  for (const entry of header.split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma <= 0 || entry.slice(0, comma) !== "v1") continue;
    const given = Buffer.from(entry.slice(comma + 1));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

export type QuoInboundEvent = {
  eventId: string | null;
  type: string;
  direction: string | null;
  from: string | null;
  text: string | null;
  messageId: string | null;
  /** When it happened (ISO), from the event itself, never from the delivery attempt. */
  occurredAt: string | null;
};

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, max = 2_000): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** A sender as Quo names it: a phone string, or an identifier object carrying one. */
function phoneOf(value: unknown): string | null {
  const direct = str(value, 40);
  if (direct) return direct;
  const o = obj(value);
  if (!o) return null;
  return str(o.phoneNumber, 40) || str(o.phone_number, 40) || str(o.value, 40) || str(o.identifier, 40);
}

function isoOf(value: unknown): string | null {
  const text = str(value, 64);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseQuoEvent(payload: unknown): QuoInboundEvent {
  const root = obj(payload) || {};
  const data = obj(root.data);
  const resource = obj(data?.resource) || obj(root.resource);
  const context = obj(data?.context) || obj(root.context);
  const legacy = obj(data?.object);
  return {
    eventId: str(root.id, 200),
    type: str(root.type, 100) || "",
    direction: str(resource?.direction, 40) || str(legacy?.direction, 40),
    from: phoneOf(context?.senderIdentifier) || phoneOf(legacy?.from),
    text: str(resource?.text) || str(legacy?.body),
    messageId: str(resource?.id, 200) || str(legacy?.id, 200),
    occurredAt: isoOf(root.createdAt) || isoOf(resource?.createdAt) || isoOf(legacy?.createdAt),
  };
}
