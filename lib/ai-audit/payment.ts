/**
 * lib/ai-audit/payment.ts — the client's Pay button, and the only thing that
 * counts as a payment.
 *
 * PRESSING PAY IS NOT PAYING (brief section 8). Pay opens one Stripe Checkout
 * Session for the approved proposal (createOrReuseCheckout): its amount comes
 * from the delivered, hash-frozen proposal version and nowhere else, and a
 * second click reuses the open session instead of making a second payment
 * request (bravo__238 ai_audit_checkouts_one_open_idx).
 *
 * A PAYMENT is a receipt written by verifyCheckout, and only after
 * verifyStripeWebsitePayment re-read the session from Stripe and found it
 * paid, live, bound to this tenant, lead, payment token and proposal, for the
 * exact amount and currency, and neither refunded nor disputed. Three things
 * trigger that check, and none of them is trusted on its own word: the Stripe
 * webhook (a hint), the tick polling open checkouts, and CC's "Re-check
 * payment" button.
 *
 * AFTERWARDS the hourly re-check (reconcileReceipts) keeps watching each
 * receipt for refunds and disputes. Nothing is ever deleted: a refund marks
 * the receipt and the engagement, and alerts CC.
 */
import "server-only";
import type { Client, Row } from "@libsql/client";
import { createStripeLeadCheckout, verifyStripeWebsitePayment } from "@/lib/website-sales-payment";
import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import { isDryRun } from "@/lib/integrations/send-mode";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { newId } from "@/lib/ai-audit/hash";
import { aiAuditBaseUrl } from "@/lib/ai-audit/env";
import { CHECKOUT_TTL_HOURS, type InstallmentKind } from "@/lib/ai-audit/rules";
import { getProposalVersion } from "@/lib/ai-audit/versions";
import { advanceEngagement } from "@/lib/ai-audit/lifecycle";
import { getEngagement, int, patchEngagement, requireTenant, text, type Engagement } from "@/lib/ai-audit/store";
import type { ShareLink } from "@/lib/ai-audit/link";

export const CHECKOUT_MARKER = "ai_audit_v1";
export const DRY_RUN_CHANNEL = "stripe_checkout";

export type PaymentDeps = {
  stripeSecret: (tenantId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  isDryRun: (channel?: string) => boolean;
  alert: (input: Parameters<typeof writeAgentAlert>[0]) => Promise<unknown>;
  baseUrl: () => string;
};

export function defaultPaymentDeps(): PaymentDeps {
  return {
    stripeSecret: async (tenantId) => (await getTenantIntegrationValue(tenantId, "stripe", "secret_key")) || null,
    isDryRun,
    alert: (input) => writeAgentAlert(input),
    baseUrl: aiAuditBaseUrl,
  };
}

export type Checkout = {
  id: string;
  tenant_id: string;
  engagement_id: string;
  proposal_version_id: string;
  payment_token: string;
  installment_kind: InstallmentKind;
  amount_cents: number;
  currency: "CAD" | "USD";
  stripe_session_id: string | null;
  checkout_url: string | null;
  status: "creating" | "open" | "paid" | "expired" | "failed";
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  paid_at: string | null;
  last_checked_at: string | null;
  check_attempts: number;
  last_error: string | null;
};

const CHECKOUT_COLUMNS =
  "id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, stripe_session_id, checkout_url, status, created_at, updated_at, expires_at, paid_at, last_checked_at, check_attempts, last_error";

function mapCheckout(r: Row): Checkout {
  const status = String(r.status);
  const kind = String(r.installment_kind);
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    engagement_id: String(r.engagement_id),
    proposal_version_id: String(r.proposal_version_id),
    payment_token: String(r.payment_token),
    installment_kind: kind === "deposit" || kind === "balance" ? kind : "full",
    amount_cents: int(r.amount_cents),
    currency: String(r.currency) === "USD" ? "USD" : "CAD",
    stripe_session_id: text(r.stripe_session_id),
    checkout_url: text(r.checkout_url),
    status: status === "open" || status === "paid" || status === "expired" || status === "failed" ? status : "creating",
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    expires_at: text(r.expires_at),
    paid_at: text(r.paid_at),
    last_checked_at: text(r.last_checked_at),
    check_attempts: int(r.check_attempts),
    last_error: text(r.last_error),
  };
}

export async function listCheckouts(db: Client, tenantId: string, engagementId: string): Promise<Checkout[]> {
  const rs = await db.execute({
    sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts WHERE tenant_id = ? AND engagement_id = ? ORDER BY created_at DESC`,
    args: [requireTenant(tenantId), engagementId],
  });
  return rs.rows.map(mapCheckout);
}

async function getCheckout(db: Client, tenantId: string, id: string): Promise<Checkout | null> {
  const row = (await db.execute({ sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [tenantId, id] })).rows[0];
  return row ? mapCheckout(row) : null;
}

export type PayResult =
  | { ok: true; url: string; reused: boolean }
  | { ok: false; error: "not_payable" | "already_paid" | "dry_run" | "stripe_not_connected" | "busy" | "stripe_failed"; detail?: string };

const PAYABLE_STAGES = new Set(["delivered", "proposal_review", "payment_pending"]);

/**
 * The Pay button. Reuses the open session, or opens one for exactly what the
 * delivered proposal says is due now. Never marks anything paid.
 */
export async function createOrReuseCheckout(
  db: Client,
  input: { link: ShareLink; now: Date; deps?: PaymentDeps },
): Promise<PayResult> {
  const deps = input.deps ?? defaultPaymentDeps();
  const t = input.link.tenant_id;
  const engagement = await getEngagement(db, t, input.link.engagement_id);
  if (!engagement || !PAYABLE_STAGES.has(engagement.stage)) return { ok: false, error: "not_payable" };
  if (engagement.payment_status === "paid" || engagement.payment_status === "overpaid_review") return { ok: false, error: "already_paid" };
  const proposal = await getProposalVersion(db, t, input.link.proposal_version_id);
  if (!proposal || proposal.status !== "delivered" || !proposal.content || proposal.due_now_cents <= 0) return { ok: false, error: "not_payable" };
  const kind: InstallmentKind = proposal.content.payment_terms.kind === "deposit" ? "deposit" : "full";

  const open = (
    await db.execute({
      sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts
            WHERE tenant_id = ? AND proposal_version_id = ? AND installment_kind = ? AND status IN ('creating', 'open')
            ORDER BY created_at DESC LIMIT 1`,
      args: [t, proposal.id, kind],
    })
  ).rows[0];
  if (open) {
    const c = mapCheckout(open);
    const fresh = c.expires_at ? Date.parse(c.expires_at) - input.now.getTime() > 30 * 60_000 : false;
    if (c.status === "open" && c.checkout_url && fresh) return { ok: true, url: c.checkout_url, reused: true };
    if (c.status === "creating" && input.now.getTime() - Date.parse(c.created_at) < 60_000) return { ok: false, error: "busy" };
    // An expired or stuck session: retire it so a new one may open. The tick
    // checks it with Stripe before anything assumes it was never paid.
    await db.execute({
      sql: "UPDATE ai_audit_checkouts SET status = 'expired', updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('creating', 'open')",
      args: [input.now.toISOString(), t, c.id],
    });
  }

  if (deps.isDryRun(DRY_RUN_CHANNEL)) return { ok: false, error: "dry_run" };
  const secret = await deps.stripeSecret(t);
  if (!secret) return { ok: false, error: "stripe_not_connected" };

  const id = newId();
  const token = newId();
  const at = input.now.toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
      args: [id, t, engagement.id, proposal.id, token, kind, proposal.due_now_cents, proposal.currency, at, at],
    });
  } catch {
    return { ok: false, error: "busy" };
  }
  const base = deps.baseUrl();
  let session: { reference: string; url: string };
  try {
    session = await createStripeLeadCheckout({
      secretKey: secret,
      tenantId: t,
      leadId: engagement.lead_id,
      paymentToken: token,
      paymentPlanId: proposal.id,
      installmentKind: kind,
      amountCents: proposal.due_now_cents,
      currency: proposal.currency,
      customerEmail: engagement.contact_email,
      description: `${engagement.business_name || "OASIS AI"}: implementation ${kind === "deposit" ? "deposit" : "payment"}`,
      successUrl: `${base}/your-audit/thanks`,
      cancelUrl: `${base}/your-audit/thanks?status=cancelled`,
      idempotencyPrefix: "oasis-ai-audit-",
      extraMetadata: { oasis_checkout: CHECKOUT_MARKER, oasis_engagement_id: engagement.id, oasis_proposal_version_id: proposal.id },
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "stripe_checkout_creation_failed";
    await db.execute({
      sql: "UPDATE ai_audit_checkouts SET status = 'failed', last_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      args: [code.slice(0, 200), input.now.toISOString(), t, id],
    });
    return { ok: false, error: "stripe_failed", detail: code };
  }
  const expires = new Date(input.now.getTime() + CHECKOUT_TTL_HOURS * 3_600_000).toISOString();
  await db.execute({
    sql: `UPDATE ai_audit_checkouts SET status = 'open', stripe_session_id = ?, checkout_url = ?, expires_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'creating'`,
    args: [session.reference, session.url, expires, input.now.toISOString(), t, id],
  });
  if (engagement.stage !== "payment_pending") {
    await advanceEngagement(db, {
      tenantId: t,
      engagementId: engagement.id,
      to: "payment_pending",
      actor: { type: "client", id: null },
      now: input.now,
      patch: { payment_status: "pending" },
      event: "checkout_opened",
      meta: { checkout_id: id, amount_cents: proposal.due_now_cents, currency: proposal.currency, installment_kind: kind },
    });
  } else {
    await patchEngagement(db, {
      tenantId: t,
      id: engagement.id,
      expectedRowVersion: engagement.row_version,
      patch: { payment_status: "pending" },
      event: "checkout_opened",
      actor: { type: "client", id: null },
      now: input.now,
      meta: { checkout_id: id, amount_cents: proposal.due_now_cents },
    });
  }
  return { ok: true, url: session.url, reused: false };
}

// ---------------------------------------------------------------------------
// Verification: Stripe's word, re-read, is the only proof
// ---------------------------------------------------------------------------

export type VerifyOutcome =
  | { status: "paid"; receiptId: string; duplicate: boolean }
  | { status: "unpaid" }
  | { status: "expired" }
  | { status: "problem"; code: string };

/** Errors that mean the session simply has not been paid (yet). */
const NOT_PAID = new Set(["payment_not_collected", "stripe_payment_not_found"]);

/**
 * Check one checkout with Stripe and record what Stripe says. Safe to call any
 * number of times from any trigger: the receipt is unique per Stripe session.
 */
export async function verifyCheckout(
  db: Client,
  input: { tenantId: string; checkoutId: string; now: Date; trigger: "webhook" | "tick" | "owner"; deps?: PaymentDeps },
): Promise<VerifyOutcome> {
  const deps = input.deps ?? defaultPaymentDeps();
  const t = requireTenant(input.tenantId);
  const checkout = await getCheckout(db, t, input.checkoutId);
  if (!checkout || !checkout.stripe_session_id) return { status: "problem", code: "checkout_not_found" };
  const engagement = await getEngagement(db, t, checkout.engagement_id);
  if (!engagement) return { status: "problem", code: "engagement_not_found" };
  const secret = await deps.stripeSecret(t);
  if (!secret) return { status: "problem", code: "stripe_not_connected" };
  const at = input.now.toISOString();
  await db.execute({
    sql: "UPDATE ai_audit_checkouts SET last_checked_at = ?, check_attempts = check_attempts + 1, updated_at = ? WHERE tenant_id = ? AND id = ?",
    args: [at, at, t, checkout.id],
  });

  let verified: Awaited<ReturnType<typeof verifyStripeWebsitePayment>>;
  try {
    verified = await verifyStripeWebsitePayment({
      secretKey: secret,
      reference: checkout.stripe_session_id,
      expectedAmountCents: checkout.amount_cents,
      expectedCurrency: checkout.currency,
      expectedTenantId: t,
      expectedLeadId: engagement.lead_id,
      expectedPaymentToken: checkout.payment_token,
      expectedPaymentPlanId: checkout.proposal_version_id,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "stripe_verification_failed";
    if (NOT_PAID.has(code)) {
      const expired = checkout.expires_at ? Date.parse(checkout.expires_at) <= input.now.getTime() : false;
      if (expired && checkout.status === "open") {
        await db.execute({ sql: "UPDATE ai_audit_checkouts SET status = 'expired', updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'open'", args: [at, t, checkout.id] });
        return { status: "expired" };
      }
      return { status: "unpaid" };
    }
    await db.execute({ sql: "UPDATE ai_audit_checkouts SET last_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", args: [code.slice(0, 200), at, t, checkout.id] });
    await flagPaymentProblem(db, engagement, code, input.now, deps);
    return { status: "problem", code };
  }

  const receiptId = newId();
  const insert = await db.execute({
    sql: `INSERT INTO ai_audit_payment_receipts (id, tenant_id, engagement_id, lead_id, proposal_version_id, checkout_id, provider, provider_reference, status,
            amount_cents, currency, installment_kind, provider_status, verification_source, verified_at, summary, last_reconciled_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, 'verified', ?, ?, ?, ?, 'stripe_api', ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, provider, provider_reference) DO NOTHING`,
    args: [
      receiptId, t, engagement.id, engagement.lead_id, checkout.proposal_version_id, checkout.id, verified.reference,
      verified.amountCents, verified.currency, checkout.installment_kind, verified.providerStatus, at,
      JSON.stringify({ ...verified.summary, trigger: input.trigger }), at, at, at,
    ],
  });
  await db.execute({
    sql: "UPDATE ai_audit_checkouts SET status = 'paid', paid_at = COALESCE(paid_at, ?), last_error = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?",
    args: [at, at, t, checkout.id],
  });
  if (insert.rowsAffected !== 1) {
    const existing = (await db.execute({ sql: "SELECT id FROM ai_audit_payment_receipts WHERE tenant_id = ? AND provider = 'stripe' AND provider_reference = ? LIMIT 1", args: [t, verified.reference] })).rows[0];
    return { status: "paid", receiptId: existing ? String(existing.id) : receiptId, duplicate: true };
  }

  // A second paid session for the same proposal is kept and flagged, never onboarded twice.
  const paidForProposal = int(
    (await db.execute({
      sql: "SELECT COUNT(*) AS n FROM ai_audit_payment_receipts WHERE tenant_id = ? AND proposal_version_id = ? AND status = 'verified' AND installment_kind = ?",
      args: [t, checkout.proposal_version_id, checkout.installment_kind],
    })).rows[0]?.n,
  );
  const fresh = await getEngagement(db, t, engagement.id);
  if (!fresh) return { status: "paid", receiptId, duplicate: false };
  if (paidForProposal > 1) {
    await patchEngagement(db, {
      tenantId: t,
      id: fresh.id,
      expectedRowVersion: fresh.row_version,
      patch: { payment_status: "overpaid_review", health: "attention", health_reason: "A second payment arrived for the same proposal. Refund one in Stripe." },
      event: "payment_overpaid",
      actor: { type: "stripe", id: verified.reference },
      now: input.now,
      meta: { receipt_id: receiptId },
    });
    await deps.alert({
      tenantId: t,
      alertType: "ai_audit_overpaid",
      severity: "urgent",
      title: `Second payment for ${fresh.business_name || "an AI audit proposal"}`,
      body: "Stripe confirmed two payments for the same proposal. Nothing was onboarded twice. Refund one in Stripe.",
      subjectType: "ai_audit_engagement",
      subjectId: fresh.id,
      telegramOncePerOpen: true,
    });
    return { status: "paid", receiptId, duplicate: false };
  }
  await advanceEngagement(db, {
    tenantId: t,
    engagementId: fresh.id,
    to: "payment_confirmed",
    actor: { type: "stripe", id: verified.reference },
    now: input.now,
    patch: { payment_status: "paid", health: "ok", health_reason: null },
    event: "payment_verified",
    meta: { receipt_id: receiptId, amount_cents: verified.amountCents, currency: verified.currency, trigger: input.trigger },
  });
  return { status: "paid", receiptId, duplicate: false };
}

async function flagPaymentProblem(db: Client, engagement: Engagement, code: string, now: Date, deps: PaymentDeps): Promise<void> {
  const reason =
    code === "payment_does_not_match_proposal"
      ? "Stripe's amount or currency does not match the approved proposal."
      : code === "payment_not_bound_to_lead"
        ? "The Stripe session does not belong to this proposal."
        : code === "stripe_test_payment_not_accepted"
          ? "A test-mode Stripe payment was used; only live payments count."
          : `Payment check failed (${code}).`;
  await patchEngagement(db, {
    tenantId: engagement.tenant_id,
    id: engagement.id,
    expectedRowVersion: engagement.row_version,
    patch: { health: "attention", health_reason: reason },
    event: "payment_problem",
    actor: { type: "system", id: null },
    now,
    meta: { code },
  });
  await deps.alert({
    tenantId: engagement.tenant_id,
    alertType: "ai_audit_payment_problem",
    severity: "warn",
    title: `Payment check needs you: ${engagement.business_name || "AI audit"}`,
    body: reason,
    subjectType: "ai_audit_engagement",
    subjectId: engagement.id,
    telegramOncePerOpen: true,
  });
}

/** Every checkout of this tenant that is still open and due a check. */
export async function dueOpenCheckouts(db: Client, tenantId: string, now: Date, limit = 20): Promise<Checkout[]> {
  const cutoff = new Date(now.getTime() - 4 * 60_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts
          WHERE tenant_id = ? AND status = 'open' AND stripe_session_id IS NOT NULL
            AND (last_checked_at IS NULL OR last_checked_at <= ?)
          ORDER BY COALESCE(last_checked_at, created_at) ASC LIMIT ?`,
    args: [requireTenant(tenantId), cutoff, limit],
  });
  return rs.rows.map(mapCheckout);
}

/** The checkout a Stripe session id belongs to (the webhook's hint). */
export async function checkoutForSession(db: Client, tenantId: string, sessionId: string): Promise<Checkout | null> {
  const row = (await db.execute({ sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts WHERE tenant_id = ? AND stripe_session_id = ? LIMIT 1`, args: [requireTenant(tenantId), sessionId] })).rows[0];
  return row ? mapCheckout(row) : null;
}

// ---------------------------------------------------------------------------
// After payment: refunds and disputes (hourly)
// ---------------------------------------------------------------------------

export type Receipt = {
  id: string;
  engagement_id: string;
  provider_reference: string;
  status: string;
  amount_cents: number;
  currency: "CAD" | "USD";
  installment_kind: string;
  verified_at: string;
  last_reconciled_at: string | null;
};

export async function listReceipts(db: Client, tenantId: string, engagementId: string): Promise<Receipt[]> {
  const rs = await db.execute({
    sql: `SELECT id, engagement_id, provider_reference, status, amount_cents, currency, installment_kind, verified_at, last_reconciled_at
          FROM ai_audit_payment_receipts WHERE tenant_id = ? AND engagement_id = ? ORDER BY verified_at DESC`,
    args: [requireTenant(tenantId), engagementId],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    engagement_id: String(r.engagement_id),
    provider_reference: String(r.provider_reference),
    status: String(r.status),
    amount_cents: int(r.amount_cents),
    currency: String(r.currency) === "USD" ? "USD" : "CAD",
    installment_kind: String(r.installment_kind),
    verified_at: String(r.verified_at),
    last_reconciled_at: text(r.last_reconciled_at),
  }));
}

/**
 * Re-read each recent verified receipt from Stripe, at most hourly. A refund or
 * a dispute updates the receipt and the engagement and alerts CC; nothing else
 * changes and nothing is deleted (CC decides what happens to the project).
 */
export async function reconcileReceipts(db: Client, tenantId: string, now: Date, deps: PaymentDeps = defaultPaymentDeps(), limit = 20): Promise<{ checked: number; changed: number }> {
  const t = requireTenant(tenantId);
  const due = new Date(now.getTime() - 60 * 60_000).toISOString();
  const since = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT r.id, r.engagement_id, r.provider_reference, r.amount_cents, r.currency, r.proposal_version_id, c.payment_token, e.lead_id
          FROM ai_audit_payment_receipts r
          JOIN ai_audit_checkouts c ON c.tenant_id = r.tenant_id AND c.id = r.checkout_id
          JOIN ai_audit_engagements e ON e.tenant_id = r.tenant_id AND e.id = r.engagement_id
          WHERE r.tenant_id = ? AND r.status = 'verified' AND r.verified_at >= ? AND (r.last_reconciled_at IS NULL OR r.last_reconciled_at <= ?)
          ORDER BY COALESCE(r.last_reconciled_at, r.verified_at) ASC LIMIT ?`,
    args: [t, since, due, limit],
  });
  if (!rs.rows.length) return { checked: 0, changed: 0 };
  const secret = await deps.stripeSecret(t);
  if (!secret) return { checked: 0, changed: 0 };
  let changed = 0;
  for (const r of rs.rows) {
    const at = now.toISOString();
    let next: "verified" | "refunded" | "partially_refunded" | "disputed" = "verified";
    let error: string | null = null;
    try {
      await verifyStripeWebsitePayment({
        secretKey: secret,
        reference: String(r.provider_reference),
        expectedAmountCents: int(r.amount_cents),
        expectedCurrency: String(r.currency) === "USD" ? "USD" : "CAD",
        expectedTenantId: t,
        expectedLeadId: String(r.lead_id),
        expectedPaymentToken: String(r.payment_token),
        expectedPaymentPlanId: String(r.proposal_version_id),
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : "stripe_verification_failed";
      if (code === "payment_refunded") next = "refunded";
      else if (code.startsWith("payment_partially_refunded")) next = "partially_refunded";
      else if (code === "payment_disputed") next = "disputed";
      else error = code;
    }
    await db.execute({
      sql: `UPDATE ai_audit_payment_receipts SET status = ?, last_reconciled_at = ?, reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciliation_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      args: [next, at, error, at, t, String(r.id)],
    });
    if (next === "verified") continue;
    changed += 1;
    const engagement = await getEngagement(db, t, String(r.engagement_id));
    if (!engagement) continue;
    const words = next === "refunded" ? "was refunded" : next === "partially_refunded" ? "was partly refunded" : "is disputed";
    await patchEngagement(db, {
      tenantId: t,
      id: engagement.id,
      expectedRowVersion: engagement.row_version,
      patch: { payment_status: next, health: "attention", health_reason: `The payment ${words} in Stripe.` },
      event: `payment_${next}`,
      actor: { type: "stripe", id: String(r.provider_reference) },
      now,
      meta: { receipt_id: String(r.id) },
    });
    await deps.alert({
      tenantId: t,
      alertType: `ai_audit_payment_${next}`,
      severity: "urgent",
      title: `AI audit payment ${words}: ${engagement.business_name || "a client"}`,
      body: "Nothing was deleted. Decide in the engagement whether to pause the project.",
      subjectType: "ai_audit_engagement",
      subjectId: engagement.id,
      telegramOncePerOpen: true,
    });
  }
  return { checked: rs.rows.length, changed };
}
