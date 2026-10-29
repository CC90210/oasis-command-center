/**
 * POST /api/webhooks/quo - Quo's inbound webhook for OASIS's own number
 * (+1 365 360 3976). Its job is the one thing automated texts cannot go
 * without: a STOP texted back reaches the workspace's STOP list.
 *
 *   1. The signature is checked first (lib/integrations/quo-webhook.ts,
 *      QUO_WEBHOOK_SIGNING_KEY): 401 on a bad or stale one, 503 when no key is
 *      set. Nothing is parsed or written before it passes.
 *   2. Every verified delivery is recorded in quo_inbound_health. A verified
 *      message.received whose sender and text read is the proof
 *      quoStopIntakeConnected() waits for before automated texts go out.
 *   3. An opt-out (the same rule the Twilio intake honours,
 *      shouldHonorTwilioOptOut) puts the number on the STOP list and cancels
 *      every pending meeting text to it; START / UNSTOP lifts an SMS opt-out.
 *      Both run the SQL of applyInboundSmsStop / releasePhoneSuppression, in
 *      one transaction with the order claim below.
 *   4. ORDER. Quo retries and does not promise order, so each STOP/START first
 *      claims its number in quo_inbound_consent by the event's own time: an
 *      older event than the newest seen is ignored (an old START never lifts a
 *      newer STOP), and only the same delivery may replay (Codex review of #776).
 *   5. 200 once handled. A failed STOP write answers 503 so Quo retries: a STOP
 *      honoured late is the violation. Quo is OASIS's own line (client
 *      workspaces cannot connect it), so the tenant is OASIS's.
 *
 * Middleware lets /api/webhooks/* through; this route authenticates itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { readBodyCapped } from "@/lib/ledger/ingest";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import {
  parseQuoEvent,
  QUO_WEBHOOK_KEY_ENV,
  QUO_WEBHOOK_MAX_BODY_BYTES,
  verifyQuoWebhook,
} from "@/lib/integrations/quo-webhook";
import { randomUUID } from "node:crypto";
import { isInvalidSuppressionPhoneError, normalizeInboundSmsPhone } from "@/lib/sms-opt-out";
import { shouldHonorTwilioOptOut, twilioCarrierKeyword } from "@/lib/sms/twilio-inbound";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function recordHealth(input: {
  tenantId: string;
  nowIso: string;
  eventType: string;
  eventId: string | null;
  inbound: boolean;
  inboundTo: string | null;
  stop: boolean;
}): Promise<void> {
  const proven = input.inbound && !!input.inboundTo;
  await getTursoClient().execute({
    sql: `INSERT INTO quo_inbound_health
            (tenant_id, last_verified_at, last_event_type, last_event_id, last_inbound_at, last_inbound_to, last_stop_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id) DO UPDATE SET
            last_verified_at = excluded.last_verified_at,
            last_event_type = excluded.last_event_type,
            last_event_id = excluded.last_event_id,
            last_inbound_at = COALESCE(excluded.last_inbound_at, quo_inbound_health.last_inbound_at),
            last_inbound_to = COALESCE(excluded.last_inbound_to, quo_inbound_health.last_inbound_to),
            last_stop_at = COALESCE(excluded.last_stop_at, quo_inbound_health.last_stop_at),
            updated_at = excluded.updated_at`,
    args: [
      input.tenantId,
      input.nowIso,
      input.eventType.slice(0, 100),
      input.eventId,
      proven ? input.nowIso : null,
      proven ? input.inboundTo : null,
      input.stop ? input.nowIso : null,
      input.nowIso,
    ],
  });
}

/**
 * Claim this number's consent order AND apply the STOP or START, in ONE write
 * transaction (Codex review of #776): an older START can never land after a
 * newer STOP has been claimed and applied, however the two deliveries
 * interleave. "stale" when a newer STOP/START for the number has already won;
 * a replay of the same delivery (same webhook id and time) applies again,
 * idempotently, to finish a write that failed. The SQL mirrors
 * applyInboundSmsStop / releasePhoneSuppression (lib/sms-opt-out.ts).
 */
async function applyConsentChange(input: {
  tenantId: string;
  phone: string;
  phoneLast10: string;
  occurredAt: string;
  action: "stop" | "start";
  webhookId: string;
  nowIso: string;
}): Promise<"applied" | "stale"> {
  const tx = await getTursoClient().transaction("write");
  try {
    const claim = await tx.execute({
      sql: `INSERT INTO quo_inbound_consent (tenant_id, phone_last10, last_event_at, last_action, last_webhook_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, phone_last10) DO UPDATE SET
              last_event_at = excluded.last_event_at,
              last_action = excluded.last_action,
              last_webhook_id = excluded.last_webhook_id,
              updated_at = excluded.updated_at
            WHERE excluded.last_event_at > quo_inbound_consent.last_event_at
               OR (excluded.last_event_at = quo_inbound_consent.last_event_at
                   AND excluded.last_webhook_id = quo_inbound_consent.last_webhook_id)`,
      args: [input.tenantId, input.phoneLast10, input.occurredAt, input.action, input.webhookId, input.nowIso],
    });
    if (claim.rowsAffected === 0) {
      await tx.rollback();
      return "stale";
    }
    if (input.action === "stop") {
      await tx.execute({
        sql: `INSERT INTO sunbiz_phone_suppressions (tenant_id, phone_last10, reason, source, created_at, updated_at)
              VALUES (?, ?, 'OPT_OUT', 'quo_inbound', ?, ?)
              ON CONFLICT(tenant_id, phone_last10) DO UPDATE SET
                reason = excluded.reason, source = excluded.source, updated_at = excluded.updated_at`,
        args: [input.tenantId, input.phoneLast10, input.nowIso, input.nowIso],
      });
      await tx.execute({
        sql: `UPDATE website_sales_meeting_notifications
                 SET status = 'cancelled', claimed_at = NULL, last_error = 'recipient_opted_out', updated_at = ?
               WHERE tenant_id = ? AND channel = 'sms' AND recipient = ? AND status IN ('pending', 'sending')`,
        args: [input.nowIso, input.tenantId, input.phone],
      });
    } else {
      await tx.execute({
        sql: "DELETE FROM sunbiz_phone_suppressions WHERE tenant_id = ? AND phone_last10 = ? AND reason = 'OPT_OUT'",
        args: [input.tenantId, input.phoneLast10],
      });
      await tx.execute({
        sql: `INSERT INTO lead_interactions (id, tenant_id, lead_id, type, channel, direction, agent_source, from_phone, metadata, created_at)
              VALUES (?, ?, NULL, 'sms_opt_in_restored', 'sms', 'inbound', 'quo_inbound', ?, ?, ?)`,
        args: [randomUUID(), input.tenantId, input.phone, JSON.stringify({ opt_in_restored: true, phone_last10: input.phoneLast10 }), input.nowIso],
      });
    }
    await tx.commit();
    return "applied";
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > QUO_WEBHOOK_MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: "body_too_large" }, { status: 413 });
  const raw = await readBodyCapped(req, QUO_WEBHOOK_MAX_BODY_BYTES);
  if (raw === null) return NextResponse.json({ ok: false, error: "body_too_large" }, { status: 413 });

  const verdict = verifyQuoWebhook({
    id: req.headers.get("webhook-id"),
    timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"),
    rawBody: raw,
    secret: process.env[QUO_WEBHOOK_KEY_ENV],
    nowMs: Date.now(),
  });
  if (!verdict.ok) {
    if (verdict.reason === "not_configured") {
      return NextResponse.json({ ok: false, error: "not_installed" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const event = parseQuoEvent(payload);
  const nowIso = new Date().toISOString();
  const inbound =
    event.type === "message.received" &&
    (event.direction === null || event.direction.toLowerCase() !== "outgoing") &&
    !!event.from &&
    !!event.text;
  const text = event.text || "";
  let stop = inbound && shouldHonorTwilioOptOut(text);
  let start = inbound && !stop && twilioCarrierKeyword(text) === "start";
  let stale = false;

  try {
    if (stop || start) {
      const phone = normalizeInboundSmsPhone(event.from!);
      const outcome = await applyConsentChange({
        tenantId: AI_AUDIT_TENANT_ID,
        phone,
        phoneLast10: phone.replace(/\D/g, "").slice(-10),
        occurredAt: event.occurredAt || new Date(Number(req.headers.get("webhook-timestamp")) * 1000).toISOString(),
        action: stop ? "stop" : "start",
        webhookId: (req.headers.get("webhook-id") || "").slice(0, 200),
        nowIso,
      });
      if (outcome === "stale") {
        // A newer STOP/START for this number already won: this one is history.
        stale = true;
        stop = false;
        start = false;
      }
    }
  } catch (error) {
    if (isInvalidSuppressionPhoneError(error)) {
      // A sender no number rule can read: nothing a retry can fix. Logged
      // loudly so a person can act on it by hand.
      console.error("[quo-webhook] a STOP/START came from a number OASIS cannot read", { eventId: event.eventId });
    } else {
      console.error("[quo-webhook] STOP/START could not be recorded; Quo will retry", {
        eventId: event.eventId,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return NextResponse.json({ ok: false, error: "suppression_failed" }, { status: 503 });
    }
  }

  try {
    await recordHealth({
      tenantId: AI_AUDIT_TENANT_ID,
      nowIso,
      eventType: event.type || "unknown",
      eventId: event.eventId,
      inbound,
      inboundTo: event.to,
      stop,
    });
  } catch (error) {
    console.error("[quo-webhook] health row write failed", error instanceof Error ? error.message.slice(0, 200) : error);
  }
  return NextResponse.json({ ok: true, stop, start, stale });
}
