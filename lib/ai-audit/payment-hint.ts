/**
 * lib/ai-audit/payment-hint.ts — the Stripe webhook's nudge for a Free AI
 * Audit payment (lib/founders-finances/stripe-ingest.ts, payment_intent.succeeded).
 *
 * The webhook is signature-checked, but its event is still only a HINT here:
 * the payment counts when verifyCheckout re-reads the Checkout Session from
 * Stripe and every binding matches. The hint only makes that check happen now
 * instead of at the next tick. It never throws.
 */
import "server-only";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { CHECKOUT_MARKER, verifyCheckout } from "@/lib/ai-audit/payment";

export type AiAuditHint = { tenantId: string; paymentToken: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The audit checkout a payment intent names in its metadata, or null. */
export function aiAuditHintFromPaymentIntent(object: unknown): AiAuditHint | null {
  if (!object || typeof object !== "object") return null;
  const md = (object as { metadata?: unknown }).metadata;
  if (!md || typeof md !== "object") return null;
  const m = md as Record<string, unknown>;
  if (m.oasis_checkout !== CHECKOUT_MARKER) return null;
  const tenantId = typeof m.oasis_tenant_id === "string" ? m.oasis_tenant_id : "";
  const paymentToken = typeof m.oasis_payment_token === "string" ? m.oasis_payment_token : "";
  if (!isOasisInternalTenant(tenantId) || !UUID_RE.test(paymentToken)) return null;
  return { tenantId, paymentToken };
}

export async function verifyAiAuditFromHint(hint: AiAuditHint): Promise<void> {
  try {
    if (!tursoConfigured()) return;
    const db = getTursoClient();
    const row = (
      await db.execute({
        sql: "SELECT id FROM ai_audit_checkouts WHERE tenant_id = ? AND payment_token = ? AND stripe_session_id IS NOT NULL LIMIT 1",
        args: [hint.tenantId, hint.paymentToken],
      })
    ).rows[0];
    if (!row) return;
    await verifyCheckout(db, { tenantId: hint.tenantId, checkoutId: String(row.id), now: new Date(), trigger: "webhook" });
  } catch (err) {
    // The tick checks the same checkout within minutes; this only logs.
    console.error("[ai-audit.payment-hint] check failed; the tick will retry", err instanceof Error ? err.message : err);
  }
}
