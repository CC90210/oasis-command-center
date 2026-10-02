/**
 * lib/twilio/sender-route.ts - where Twilio's webhooks find a workspace.
 *
 * An incoming text names the workspace only by the number it was sent to (or
 * the messaging service that received it), and a delivery report only by the
 * number or service it was sent from. resolveTwilioInboundTenant
 * (lib/sms/twilio-inbound.ts) answers "whose number is this?" with ONE indexed
 * read of channel_accounts (migration bravo__201). This module keeps that table
 * in step with each workspace's saved Twilio sender: one row per workspace,
 * written when a Twilio value is saved or removed and when Test runs.
 *
 * Before this, nothing wrote channel_accounts, so every webhook fell back to
 * decrypting every workspace's saved number, and above 25 workspaces it refused
 * all of them (W10a review R6). That scan stays only as the fallback for a
 * sender this module has not written yet.
 *
 * WHAT IS STORED: the number (E.164) and the messaging service SID, which are
 * not secrets. Keys stay encrypted in tenant_integration_credentials
 * (credential_ref points there). OASIS's own workspace may use its deployment
 * number, exactly as getTenantIntegrationBundle lets it; nobody else ever does.
 *
 * NEVER A GUESS. A sender that cannot be read (the lookup failed, or a value
 * will not decrypt) leaves the row as it was and reports the failure: a read
 * error must not unroute a working number.
 */
import "server-only";
import type { Client } from "@libsql/client";
import {
  envKeysFor,
  readTenantCredentialStrict,
  tenantMayUseEnvFallback,
} from "@/lib/tenant-integration-store";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { normalTwilioMessagingServiceSid, normalTwilioNumber } from "@/lib/twilio/shared";

/** The workspace's one routing row. Deterministic, so a save is an upsert, never a second row. */
export function twilioSenderRouteId(tenantId: string): string {
  return `twilio-sender:${tenantId}`;
}

type FieldRead = { ok: true; value: string | null } | { ok: false; error: string };

async function senderField(
  tenantId: string,
  field: "from_number" | "messaging_service_sid",
  normal: (v: string) => string | null,
  env: Readonly<Record<string, string | undefined>>,
): Promise<FieldRead> {
  const stored = await readTenantCredentialStrict(tenantId, "twilio", field);
  if (stored.ok) return { ok: true, value: normal(stored.value) };
  if (stored.reason !== "missing") return { ok: false, error: `${field}_${stored.reason}` };
  // The same rule as every Twilio send: only OASIS's own workspace may use the
  // deployment's number; a client with nothing saved has no sender.
  if (!tenantMayUseEnvFallback(tenantId)) return { ok: true, value: null };
  for (const name of envKeysFor("twilio", field)) {
    const v = (env[name] || "").trim();
    if (v) return { ok: true, value: normal(v) };
  }
  return { ok: true, value: null };
}

export type TwilioSenderRouteResult =
  | { ok: true; active: boolean; fromPhone: string | null; messagingServiceSid: string | null }
  | { ok: false; error: string };

/**
 * The sender a workspace holds NOW: its saved number and messaging service, or
 * OASIS's deployment ones. The routing row is written from this, and the inbound
 * resolver checks an indexed row against it before believing the row
 * (lib/sms/twilio-inbound.ts), so the two can never disagree about ownership.
 */
export async function currentTwilioSender(
  tenantId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ ok: true; fromPhone: string | null; messagingServiceSid: string | null } | { ok: false; error: string }> {
  const phone = await senderField(tenantId, "from_number", normalTwilioNumber, env);
  if (!phone.ok) return phone;
  const service = await senderField(tenantId, "messaging_service_sid", normalTwilioMessagingServiceSid, env);
  if (!service.ok) return service;
  return { ok: true, fromPhone: phone.value, messagingServiceSid: service.value };
}

/**
 * Make the workspace's routing row say what its saved sender says: active with
 * the number and/or messaging service, or inactive (and emptied) when neither
 * is saved any more.
 */
export async function syncTwilioSenderRoute(
  db: Client,
  tenantId: string,
  opts: { now?: Date; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<TwilioSenderRouteResult> {
  if (!tenantId) return { ok: false, error: "tenant_missing" };
  const sender = await currentTwilioSender(tenantId, opts.env ?? process.env);
  if (!sender.ok) return sender;
  const phone = { value: sender.fromPhone };
  const service = { value: sender.messagingServiceSid };

  const id = twilioSenderRouteId(tenantId);
  const at = (opts.now ?? new Date()).toISOString();
  if (!phone.value && !service.value) {
    await db.execute({
      sql: `UPDATE channel_accounts
               SET is_active = 0, from_phone = NULL, twilio_messaging_service_sid = NULL, updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
      args: [at, id, tenantId],
    });
    return { ok: true, active: false, fromPhone: null, messagingServiceSid: null };
  }
  const written = await db.execute({
    sql: `INSERT INTO channel_accounts
            (id, tenant_id, provider, display_name, from_phone, twilio_messaging_service_sid,
             credential_ref, capabilities, metadata, is_active, created_at, updated_at)
          VALUES (?, ?, 'twilio', 'Twilio sender', ?, ?,
             'tenant_integration_credentials:twilio', '{"sms":true}', '{"source":"connections"}', 1, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            from_phone = excluded.from_phone,
            twilio_messaging_service_sid = excluded.twilio_messaging_service_sid,
            is_active = 1,
            updated_at = excluded.updated_at
          WHERE channel_accounts.tenant_id = excluded.tenant_id`,
    args: [id, tenantId, phone.value, service.value, at, at],
  });
  if (written.rowsAffected !== 1) return { ok: false, error: "route_row_not_written" };
  return { ok: true, active: true, fromPhone: phone.value, messagingServiceSid: service.value };
}

/**
 * The routes' call: sync, and say loudly when it did not happen. A failure
 * never undoes the save that triggered it (the key IS saved); the webhook then
 * falls back to the bounded credential scan for this workspace until the next
 * save or Test writes the row.
 */
export async function syncTwilioSenderRouteFor(tenantId: string, cause: string): Promise<"synced" | "failed"> {
  if (!tursoConfigured()) {
    console.error("[twilio.sender-route] database not configured; routing row not written", { tenantId, cause });
    return "failed";
  }
  try {
    const result = await syncTwilioSenderRoute(getTursoClient(), tenantId);
    if (result.ok) return "synced";
    console.error("[twilio.sender-route] routing row not written", { tenantId, cause, error: result.error });
  } catch (err) {
    console.error("[twilio.sender-route] routing row write threw", {
      tenantId,
      cause,
      error: err instanceof Error ? err.stack : String(err),
    });
  }
  return "failed";
}
