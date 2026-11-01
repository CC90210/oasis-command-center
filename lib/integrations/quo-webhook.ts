import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { getTenantIntegrationBundle, readTenantCredentialStrict } from "@/lib/tenant-integration-store";
import { encryptField } from "@/lib/field-encryption";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { applyInboundSmsStopInTransaction, isStopCommand } from "@/lib/sms-opt-out";

// Official contract: /docs/2026-03-30/webhooks-{signature-validation,event-payloads,overview}.
export const QUO_WEBHOOK_VERSION = "2026-03-30";
const EVENT = "quo_sms_inbound";
const STATE_SERVICE = "quo_webhook_state"; // Internal proof, never a manually editable integration.
const MAX_BYTES = 64 * 1024;
const E164 = /^\+[1-9]\d{9,14}$/;
const opaque = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f]/.test(v);
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export type QuoWebhookConfig = {
  tenantId: string; apiKey: string; signingKey: string; orgId: string;
  phoneNumberId: string; fromNumber: string; webhookId: string;
};
export function quoWebhookUrl(origin: string, tenantId: string): string {
  return `${origin.replace(/\/$/, "")}/api/webhooks/quo/${encodeURIComponent(tenantId)}`;
}
export function quoWebhookBinding(config: QuoWebhookConfig): string {
  return hash(JSON.stringify([config.tenantId, config.apiKey, config.signingKey, config.orgId, config.phoneNumberId, config.fromNumber, config.webhookId]));
}
function signingBytes(key: string): Buffer | null {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(key)) return null;
  const encoded = key.slice(6);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length >= 16 && bytes.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "") ? bytes : null;
}
export async function loadQuoWebhookConfig(tenantId: string): Promise<QuoWebhookConfig | null> {
  if (!tenantId || isRetiredTenant(tenantId)) return null;
  const keys = ["webhook_key", "webhook_org_id", "webhook_phone_number_id", "webhook_id"] as const;
  const reads = await Promise.all(keys.map(key => readTenantCredentialStrict(tenantId, "quo", key)));
  if (reads.some(r => !r.ok && r.reason !== "missing")) throw new Error("quo_webhook_credentials_unavailable");
  if (reads.some(r => !r.ok)) return null;
  const [signingKey, orgId, phoneNumberId, webhookId] = reads.map(r => r.ok ? r.value : "");
  const bundle = await getTenantIntegrationBundle(tenantId, "quo");
  const apiKey = bundle.api_key?.trim();
  const fromNumber = bundle.from_number?.trim();
  if (!apiKey || !fromNumber || !E164.test(fromNumber) || !signingBytes(signingKey) ||
      !opaque(orgId) || !opaque(phoneNumberId) || !/^\d{1,100}$/.test(webhookId)) return null;
  return { tenantId, apiKey, fromNumber, signingKey, orgId, phoneNumberId, webhookId };
}

export function verifyQuoSignature(raw: Buffer, headers: Headers, key: string, now: Date): boolean {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp") ?? "";
  const signatures = headers.get("webhook-signature") ?? "";
  const secret = signingBytes(key);
  if (!secret || !opaque(id) || !/^\d{1,12}$/.test(timestamp) || signatures.length > 2048 ||
      Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(raw).digest("base64");
  return signatures.split(" ").some(entry => {
    const [version, supplied] = entry.split(",");
    return version === "v1" && !!supplied && /^[A-Za-z0-9+/]+={0,2}$/.test(supplied) && supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  });
}
async function readRaw(req: Request): Promise<Buffer | null> {
  if (Number(req.headers.get("content-length")) > MAX_BYTES) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}

/** No provider call, outbound reply, or START un-suppression occurs in ingress. */
export async function handleQuoInbound(req: Request, tenantId: string, deps: {
  db: Client; loadConfig?: typeof loadQuoWebhookConfig; now?: Date;
}): Promise<Response> {
  try {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(tenantId) || isRetiredTenant(tenantId)) return json(404, { ok: false, error: "not_configured" });
    const raw = await readRaw(req);
    if (raw === null) return json(413, { ok: false, error: "body_too_large" });
    const config = await (deps.loadConfig ?? loadQuoWebhookConfig)(tenantId);
    if (!config || config.tenantId !== tenantId) return json(503, { ok: false, error: "not_configured" });
    const now = deps.now ?? new Date();
    if (!verifyQuoSignature(raw, req.headers, config.signingKey, now)) return json(401, { ok: false, error: "invalid_signature" });
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
    catch { return json(400, { ok: false, error: "invalid_payload" }); }
    const data = object(event.data); const context = object(data.context); const resource = object(data.resource);
    if (event.apiVersion !== QUO_WEBHOOK_VERSION || event.type !== "message.received" || !opaque(event.id) ||
        !opaque(resource.id) || resource.direction !== "incoming" || typeof resource.text !== "string" ||
        context.orgId !== config.orgId || context.phoneNumberId !== config.phoneNumberId ||
        !Array.isArray(context.recipientIdentifiers) || context.recipientIdentifiers.length !== 1 ||
        context.recipientIdentifiers[0] !== config.fromNumber || typeof context.senderIdentifier !== "string" ||
        !E164.test(context.senderIdentifier)) return json(422, { ok: false, error: "event_binding_mismatch" });
    const stop = isStopCommand(resource.text);
    const binding = quoWebhookBinding(config);
    const bodyHash = hash(raw);
    const key = `quo:${hash(JSON.stringify([tenantId, config.webhookId, req.headers.get("webhook-id")]))}`;
    const at = now.toISOString();
    const proof = encryptField(JSON.stringify({ binding, receivedAt: at, signedAt: Number(req.headers.get("webhook-timestamp")) }));
    const tx = await deps.db.transaction("write");
    try {
      const existing = await tx.execute({ sql: "SELECT payload FROM agent_events WHERE correlation_id=? AND event_type=? AND idempotency_key=?", args: [tenantId, EVENT, key] });
      if (existing.rows[0]) {
        const previous = object(JSON.parse(String(existing.rows[0].payload)));
        await tx.rollback();
        return previous.bodyHash === bodyHash ? json(200, { ok: true, duplicate: true }) : json(409, { ok: false, error: "delivery_id_reused" });
      }
      if (stop) await applyInboundSmsStopInTransaction(tx, { tenantId, phone: context.senderIdentifier, receivedAt: at, source: "quo_webhook" });
      await tx.execute({
        sql: `INSERT INTO agent_events (id,event_type,publisher_agent,target_agent,severity,payload,correlation_id,published_at,created_at,source_agent,idempotency_key,status,retry_count)
              VALUES (?,?, 'quo','oasis-command-center.quo','info',?,?,?,?, 'quo',?,'done',0)`,
        args: [randomUUID(), EVENT, JSON.stringify({ bodyHash, binding, stop, eventId: event.id, resourceId: resource.id }), tenantId, at, at, key],
      });
      // Durable connection proof survives event-log retention, but is invalidated by any key/account/number change.
      await tx.execute({
        sql: `INSERT INTO tenant_integration_credentials (id,tenant_id,service,field_key,encrypted_value,updated_at)
              VALUES (?,?,?,'binding',?,?) ON CONFLICT(tenant_id,service,field_key)
              DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at`,
        args: [randomUUID(), tenantId, STATE_SERVICE, proof, at],
      });
      await tx.commit();
      return json(200, { ok: true });
    } catch (error) { await tx.rollback().catch(() => undefined); throw error; }
    finally { tx.close(); }
  } catch {
    // No untrusted payload, headers, provider response, phone or secret in logs/results.
    return json(503, { ok: false, error: "quo_intake_unavailable" });
  }
}

/** Fixed provider host, GET only, no redirect can carry the API key elsewhere. */
export async function verifyQuoWebhookProvider(config: QuoWebhookConfig, origin: string, signedAt: number, fetcher: typeof fetch = fetch): Promise<string> {
  const get = async (path: string) => {
    const response = await fetcher(`https://api.quo.com${path}`, { method: "GET", redirect: "error", cache: "no-store",
      headers: { Authorization: config.apiKey, "Quo-Api-Version": QUO_WEBHOOK_VERSION }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("quo_webhook_provider_unavailable"); }
    return object(await response.json()).data;
  };
  const path = `/webhooks/${encodeURIComponent(config.webhookId)}`;
  // The provider's revision is not documented as a signing-key version. Also inspect
  // unresolved deliveries: an unnoticed rotation must not leave rejected STOPs hidden.
  // All reads are bounded; no event body, recipient, or signing key is requested.
  const [webhookData, phoneData, ...unresolved] = await Promise.all([
    get(path), get(`/phone-numbers/${encodeURIComponent(config.phoneNumberId)}`),
    ...["pending", "sending", "failed"].map(status => get(`${path}/events?eventType=message.received&status=${status}&limit=1`)),
  ]);
  const webhook = object(webhookData); const phone = object(phoneData);
  if (!(webhook.id === config.webhookId && webhook.orgId === config.orgId && webhook.status === "enabled" &&
    webhook.apiVersion === QUO_WEBHOOK_VERSION && webhook.url === quoWebhookUrl(origin, config.tenantId) &&
    Array.isArray(webhook.events) && webhook.events.includes("message.received") &&
    Array.isArray(webhook.resourceIds) && webhook.resourceIds.length === 1 && webhook.resourceIds[0] === config.phoneNumberId &&
    phone.id === config.phoneNumberId && phone.phoneNumber === config.fromNumber)) return "provider_configuration_mismatch";
  const revisedAt = typeof webhook.updatedAt === "string" ? Date.parse(webhook.updatedAt) : NaN;
  // Compare provider clocks, with the same seconds precision as its signed header.
  if (!Number.isFinite(revisedAt) || Math.floor(revisedAt / 1000) > signedAt) return "provider_revision_changed";
  if (unresolved.some(items => !Array.isArray(items))) throw new Error("quo_webhook_provider_unavailable");
  if ((unresolved[2] as unknown[]).length > 0) return "provider_deliveries_failed";
  if (unresolved.slice(0, 2).some(items => (items as unknown[]).length > 0)) return "provider_delivery_backlog";
  // GET cannot prove a key rotation which has produced neither a revision nor a
  // delivery yet. After rotating a key, save it here and validate a signed delivery.
  return "ready";
}
export async function quoWebhookReadiness(tenantId: string, origin: string, verifyProvider = false,
  sender?: { apiKey: string; fromNumber: string | null },
): Promise<{ ready: boolean; reason: string; configured: boolean; receivedAt: string | null }> {
  const config = await loadQuoWebhookConfig(tenantId);
  if (!config) return { ready: false, reason: "configuration_missing", configured: false, receivedAt: null };
  if (sender && (sender.apiKey !== config.apiKey || sender.fromNumber !== config.fromNumber)) {
    return { ready: false, reason: "sender_configuration_changed", configured: true, receivedAt: null };
  }
  const saved = await readTenantCredentialStrict(tenantId, STATE_SERVICE, "binding");
  if (!saved.ok && saved.reason !== "missing") throw new Error("quo_webhook_proof_unavailable");
  let proof: Record<string, unknown> = {};
  if (saved.ok) { try { proof = object(JSON.parse(saved.value)); } catch { /* Unreadable proof never enables sending. */ } }
  const receivedAt = typeof proof.receivedAt === "string" && Number.isFinite(Date.parse(proof.receivedAt)) ? proof.receivedAt : null;
  if (proof.binding !== quoWebhookBinding(config) || !receivedAt || !Number.isSafeInteger(proof.signedAt) || Number(proof.signedAt) <= 0) return { ready: false, reason: "awaiting_signed_delivery", configured: true, receivedAt: null };
  if (!verifyProvider) return { ready: false, reason: "needs_provider_check", configured: true, receivedAt };
  const reason = await verifyQuoWebhookProvider(config, origin, Number(proof.signedAt));
  return { ready: reason === "ready", reason, configured: true, receivedAt };
}
