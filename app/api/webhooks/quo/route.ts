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
 *      shouldHonorTwilioOptOut) goes through applyInboundSmsStop: the number
 *      goes on the STOP list and every pending meeting text to it is
 *      cancelled. START / UNSTOP lifts an SMS opt-out (releasePhoneSuppression).
 *   4. 200 once handled. A failed STOP write answers 503 so Quo retries: a STOP
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
import { applyInboundSmsStop, isInvalidSuppressionPhoneError, releasePhoneSuppression } from "@/lib/sms-opt-out";
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
  stop: boolean;
}): Promise<void> {
  await getTursoClient().execute({
    sql: `INSERT INTO quo_inbound_health
            (tenant_id, last_verified_at, last_event_type, last_event_id, last_inbound_at, last_stop_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id) DO UPDATE SET
            last_verified_at = excluded.last_verified_at,
            last_event_type = excluded.last_event_type,
            last_event_id = excluded.last_event_id,
            last_inbound_at = COALESCE(excluded.last_inbound_at, quo_inbound_health.last_inbound_at),
            last_stop_at = COALESCE(excluded.last_stop_at, quo_inbound_health.last_stop_at),
            updated_at = excluded.updated_at`,
    args: [
      input.tenantId,
      input.nowIso,
      input.eventType.slice(0, 100),
      input.eventId,
      input.inbound ? input.nowIso : null,
      input.stop ? input.nowIso : null,
      input.nowIso,
    ],
  });
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
  const stop = inbound && shouldHonorTwilioOptOut(text);
  const start = inbound && !stop && twilioCarrierKeyword(text) === "start";

  try {
    if (stop) {
      await applyInboundSmsStop(getServiceSupabase(), {
        tenantId: AI_AUDIT_TENANT_ID,
        phone: event.from!,
        receivedAt: nowIso,
        source: "quo_inbound",
      });
    } else if (start) {
      await releasePhoneSuppression(getServiceSupabase(), {
        tenantId: AI_AUDIT_TENANT_ID,
        phone: event.from!,
        source: "quo_inbound",
      });
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
      stop,
    });
  } catch (error) {
    console.error("[quo-webhook] health row write failed", error instanceof Error ? error.message.slice(0, 200) : error);
  }
  return NextResponse.json({ ok: true, stop, start });
}
