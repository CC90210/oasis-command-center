import { NextRequest, NextResponse } from "next/server";
import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import { getTursoClient } from "@/lib/turso";
import { verifyStripeWebsitePayment } from "@/lib/website-sales-payment";
import {
  ingestStripeCheckoutCompleted,
  parseStripeCheckoutCompletedEvent,
  verifyStripeWebhookSignature,
} from "@/lib/website-sales-stripe-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MALFORMED_EVENT_ERRORS = new Set([
  "stripe_webhook_invalid_json",
  "stripe_webhook_invalid_event",
  "stripe_webhook_event_unsupported",
  "stripe_webhook_live_mode_required",
  "stripe_webhook_event_id_missing",
  "stripe_webhook_event_id_invalid",
  "stripe_webhook_created_invalid",
  "stripe_webhook_data_missing",
  "stripe_webhook_checkout_missing",
  "stripe_webhook_checkout_invalid",
  "stripe_webhook_checkout_id_missing",
  "stripe_webhook_checkout_id_invalid",
  "stripe_webhook_metadata_missing",
  "stripe_webhook_lead_missing",
  "stripe_event_lead_binding_mismatch",
  "stripe_webhook_tenant_missing",
  "stripe_webhook_payment_token_missing",
  "stripe_webhook_payment_plan_missing",
  "stripe_webhook_installment_missing",
  "stripe_webhook_installment_invalid",
  "stripe_webhook_tolerance_invalid",
  "stripe_checkout_session_required",
  "stripe_test_payment_not_accepted",
]);

function responseFor(error: string): { status: number; publicError: string } {
  if (error === "stripe_webhook_payload_too_large") {
    return { status: 413, publicError: error };
  }
  if (
    error === "stripe_webhook_secret_missing" ||
    error.includes("signature") ||
    error.includes("timestamp_outside_tolerance")
  ) return { status: 401, publicError: "stripe_webhook_auth_failed" };
  if (
    error === "stripe_not_connected" ||
    error === "stripe_verification_failed" ||
    error === "stripe_payment_not_found" ||
    error === "stripe_payment_missing_amount" ||
    error.includes("refund_state_unavailable") ||
    error.includes("dispute_state_unavailable") ||
    error.toLowerCase().includes("fetch failed")
  ) return { status: 503, publicError: "stripe_verification_unavailable" };
  if (error === "stripe_webhook_lead_not_found") {
    return { status: 404, publicError: error };
  }
  if (
    error.includes("binding_mismatch") ||
    error.includes("already_used") ||
    error.includes("ledger_mismatch") ||
    error.includes("overpaid") ||
    error.includes("not_awaiting_payment") ||
    error.includes("changed_during_verification") ||
    error.includes("compare_and_swap") ||
    error.includes("payment_plan_invalid") ||
    error.includes("payment_schedule_invalid") ||
    error.startsWith("payment_")
  ) return { status: 409, publicError: error };
  if (MALFORMED_EVENT_ERRORS.has(error)) return { status: 400, publicError: error };
  return { status: 500, publicError: "stripe_webhook_failed" };
}

export async function POST(req: NextRequest) {
  let rawBody = "";
  try {
    rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
      throw new Error("stripe_webhook_payload_too_large");
    }

    // Tenant metadata is untrusted until the next signature check. It is used
    // only to select that tenant's signing secret; no data read/write occurs
    // before Stripe proves possession of the matching secret.
    const event = parseStripeCheckoutCompletedEvent(rawBody);
    const tenantId = event.tenantId;
    const webhookSecret = await getTenantIntegrationValue(tenantId, "stripe", "webhook_secret");
    if (!webhookSecret) throw new Error("stripe_webhook_secret_missing");
    verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: req.headers.get("stripe-signature"),
      secret: webhookSecret,
    });

    const secretKey = await getTenantIntegrationValue(tenantId, "stripe", "secret_key");
    if (!secretKey) throw new Error("stripe_not_connected");
    const result = await ingestStripeCheckoutCompleted(getTursoClient(), {
      event,
      secretKey,
      verifyPayment: verifyStripeWebsitePayment,
    });
    return NextResponse.json({ received: true, ...result });
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "stripe_webhook_failed";
    console.error("[stripe-webhook] rejected", { error });
    const response = responseFor(error);
    return NextResponse.json(
      { received: false, error: response.publicError },
      { status: response.status },
    );
  }
}
