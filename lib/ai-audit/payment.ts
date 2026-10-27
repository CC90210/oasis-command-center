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
import { CHECKOUT_TTL_HOURS, WAITING_ON_CLIENT_STAGES, shortName, type InstallmentKind } from "@/lib/ai-audit/rules";
import { getProposalVersion } from "@/lib/ai-audit/versions";
import { advanceEngagement } from "@/lib/ai-audit/lifecycle";
import { casWrite, engagementUpdateStatement, eventStatement, getEngagement, int, patchEngagement, requireTenant, text, type Engagement } from "@/lib/ai-audit/store";
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

/**
 * A client pressed Pay and no checkout opened for a reason only CC can fix. One
 * open card per engagement (writeAgentAlert refreshes it), paged once. A failed
 * alert is logged and never stops the client being sent back to their page.
 */
async function alertPayBlocked(deps: PaymentDeps, e: Engagement, why: string): Promise<void> {
  try {
    await deps.alert({
      tenantId: e.tenant_id,
      alertType: "ai_audit_pay_blocked",
      severity: "urgent",
      title: `A client could not pay: ${shortName(e.business_name, "an AI audit")}`,
      body: `${why} They pressed Pay on their audit and were told online payment is not open yet. Fix it, then reply to them.`,
      subjectType: "ai_audit_engagement",
      subjectId: e.id,
      telegramOncePerOpen: true,
    });
  } catch (err) {
    console.error("[ai-audit.payment] the blocked-payment alert could not be written", { engagementId: e.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
}

export type PayResult =
  | { ok: true; url: string; reused: boolean }
  | { ok: false; error: "not_payable" | "already_paid" | "dry_run" | "stripe_not_connected" | "busy" | "stripe_failed"; detail?: string };

const PAYABLE_STAGES: ReadonlySet<string> = new Set(WAITING_ON_CLIENT_STAGES);

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
  // The payment switch is checked before an open session is reused too: turning
  // LIVE_SEND_STRIPE_CHECKOUT off (or BRAVO_FORCE_DRY_RUN on) must stop the
  // Pay button handing out a live session (Codex review of PR #732).
  if (deps.isDryRun(DRY_RUN_CHANNEL)) {
    await alertPayBlocked(deps, engagement, "Client payments are in test mode (LIVE_SEND_STRIPE_CHECKOUT is not on), so no checkout opened.");
    return { ok: false, error: "dry_run" };
  }
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

  const secret = await deps.stripeSecret(t);
  if (!secret) {
    await alertPayBlocked(deps, engagement, "Stripe is not connected for this workspace, so no checkout opened.");
    return { ok: false, error: "stripe_not_connected" };
  }

  const id = newId();
  const token = newId();
  const at = input.now.toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO ai_audit_checkouts (id, tenant_id, engagement_id, proposal_version_id, payment_token, installment_kind, amount_cents, currency, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
      args: [id, t, engagement.id, proposal.id, token, kind, proposal.due_now_cents, proposal.currency, at, at],
    });
  } catch (err) {
    // The one-open-session index refusing means another click is opening it right now.
    if (/UNIQUE|constraint/i.test(err instanceof Error ? err.message : String(err))) return { ok: false, error: "busy" };
    throw err;
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
    await alertPayBlocked(deps, engagement, `Stripe refused to open the checkout (${code.slice(0, 160)}). The client was asked to try again in a minute.`);
    return { ok: false, error: "stripe_failed", detail: code };
  }
  const expires = new Date(input.now.getTime() + CHECKOUT_TTL_HOURS * 3_600_000).toISOString();
  await db.execute({
    sql: `UPDATE ai_audit_checkouts SET status = 'open', stripe_session_id = ?, checkout_url = ?, expires_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'creating'`,
    args: [session.reference, session.url, expires, input.now.toISOString(), t, id],
  });
  // A revision (or a decline) that landed while Stripe was opening this session: it is closed again at once, so
  // nothing is paid for a version being replaced (review of phase 5, finding 1).
  const still = await getEngagement(db, t, engagement.id);
  if (!still || !PAYABLE_STAGES.has(still.stage) || still.current_proposal_version_id !== proposal.id) {
    await expireOpenCheckouts(db, t, engagement.id, input.now, deps);
    return { ok: false, error: "not_payable" };
  }
  let marked: { ok: boolean; error?: string };
  if (engagement.stage !== "payment_pending") {
    marked = await advanceEngagement(db, {
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
    marked = await patchEngagement(db, {
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
  // Only the board's "checkout started" flag depends on this; the session and its polling do not.
  if (!marked.ok) console.warn("[ai-audit.payment] checkout opened, but the engagement was not marked pending", { engagementId: engagement.id, error: marked.error });
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
  // The receipt and the checkout's "paid" are one write: never one without the other.
  const [insert] = await db.batch(
    [
      {
        sql: `INSERT INTO ai_audit_payment_receipts (id, tenant_id, engagement_id, lead_id, proposal_version_id, checkout_id, provider, provider_reference, status,
                amount_cents, currency, installment_kind, provider_status, verification_source, verified_at, summary, last_reconciled_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, 'verified', ?, ?, ?, ?, 'stripe_api', ?, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, provider, provider_reference) DO NOTHING`,
        args: [
          receiptId, t, engagement.id, engagement.lead_id, checkout.proposal_version_id, checkout.id, verified.reference,
          verified.amountCents, verified.currency, checkout.installment_kind, verified.providerStatus, at,
          JSON.stringify({ ...verified.summary, trigger: input.trigger }), at, at, at,
        ],
      },
      {
        sql: "UPDATE ai_audit_checkouts SET status = 'paid', paid_at = COALESCE(paid_at, ?), last_error = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?",
        args: [at, at, t, checkout.id],
      },
    ],
    "write",
  );
  let id = receiptId;
  const duplicate = insert.rowsAffected !== 1;
  if (duplicate) {
    const existing = (await db.execute({ sql: "SELECT id FROM ai_audit_payment_receipts WHERE tenant_id = ? AND provider = 'stripe' AND provider_reference = ? LIMIT 1", args: [t, verified.reference] })).rows[0];
    if (existing) id = String(existing.id);
  }
  // A duplicate still settles: a run that wrote the receipt and then failed
  // before moving the engagement is finished here (and by the tick).
  await settlePayment(db, {
    tenantId: t,
    engagementId: engagement.id,
    checkout,
    receiptId: id,
    reference: verified.reference,
    amountCents: verified.amountCents,
    currency: verified.currency,
    trigger: input.trigger,
    now: input.now,
    deps,
  });
  return { status: "paid", receiptId: id, duplicate };
}

/** Stages from which a verified payment moves the engagement to Payment Confirmed: the ones waiting on the client. */
const SETTLE_FROM = PAYABLE_STAGES;
/** Stages a settled payment has already moved past. */
const SETTLED = new Set(["payment_confirmed", "onboarding", "active_client"]);

/**
 * Put a verified payment where it belongs. Idempotent: called after every
 * verification, duplicate or not, and by the tick for any verified receipt
 * whose engagement has not caught up.
 *
 *   - a second paid session for the same proposal: kept, flagged, never onboarded twice;
 *   - a payable engagement: moves to Payment Confirmed (retried on a concurrent write);
 *   - anything else (declined, cancelled, reopened): the money is real but has
 *     nowhere to go, so the engagement is flagged FAILED and CC gets an urgent
 *     alert. Nothing is refunded automatically.
 */
export async function settlePayment(
  db: Client,
  input: {
    tenantId: string;
    engagementId: string;
    checkout: Pick<Checkout, "id" | "proposal_version_id" | "installment_kind">;
    receiptId: string;
    reference: string;
    amountCents: number;
    currency: string;
    trigger: string;
    now: Date;
    deps: PaymentDeps;
  },
): Promise<"settled" | "already" | "overpaid" | "unplaced"> {
  const t = requireTenant(input.tenantId);
  const paidForProposal = int(
    (await db.execute({
      sql: "SELECT COUNT(*) AS n FROM ai_audit_payment_receipts WHERE tenant_id = ? AND proposal_version_id = ? AND status = 'verified' AND installment_kind = ?",
      args: [t, input.checkout.proposal_version_id, input.checkout.installment_kind],
    })).rows[0]?.n,
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    const e = await getEngagement(db, t, input.engagementId);
    if (!e) return "unplaced";
    if (paidForProposal > 1) {
      if (e.payment_status === "overpaid_review") return "overpaid";
      const r = await patchEngagement(db, {
        tenantId: t,
        id: e.id,
        expectedRowVersion: e.row_version,
        patch: { payment_status: "overpaid_review", health: "attention", health_reason: "A second payment arrived for the same proposal. Refund one in Stripe." },
        event: "payment_overpaid",
        actor: { type: "stripe", id: input.reference },
        now: input.now,
        meta: { receipt_id: input.receiptId },
      });
      if (!r.ok && r.error === "conflict") continue;
      await input.deps.alert({
        tenantId: t,
        alertType: "ai_audit_overpaid",
        severity: "urgent",
        title: `Second payment for ${shortName(e.business_name, "an AI audit proposal")}`,
        body: "Stripe confirmed two payments for the same proposal. Nothing was onboarded twice. Refund one in Stripe.",
        subjectType: "ai_audit_engagement",
        subjectId: e.id,
        telegramOncePerOpen: true,
      });
      return "overpaid";
    }
    // A payment for a version the client no longer has (the audit was revised since) never settles onto the newer
    // one: the money is real, so it is kept and CC decides (review of phase 5, finding 1).
    const replaced = e.current_proposal_version_id !== input.checkout.proposal_version_id;
    if (!replaced && SETTLED.has(e.stage)) return "already";
    if (!replaced && SETTLE_FROM.has(e.stage)) {
      const moved = await advanceEngagement(db, {
        tenantId: t,
        engagementId: e.id,
        to: "payment_confirmed",
        actor: { type: "stripe", id: input.reference },
        now: input.now,
        expectedRowVersion: e.row_version,
        patch: { payment_status: "paid", health: "ok", health_reason: null },
        event: "payment_verified",
        meta: { receipt_id: input.receiptId, amount_cents: input.amountCents, currency: input.currency, trigger: input.trigger },
      });
      if (moved.ok) return "settled";
      if (moved.error === "conflict") continue;
    }
    // Paid, but the engagement cannot take it (declined, cancelled, reopened, or paid for a replaced proposal).
    const reason = replaced
      ? "Stripe confirmed a payment for an earlier version of the proposal, which has since been revised. Refund it in Stripe, or settle it with the client by hand."
      : `Stripe confirmed a payment, but the engagement is ${e.stage.replace(/_/g, " ")}. Decide whether to refund it in Stripe or reopen the engagement.`;
    if (e.health === "failed" && e.health_reason === reason && e.payment_status === "paid") return "unplaced";
    const flagged = await patchEngagement(db, {
      tenantId: t,
      id: e.id,
      expectedRowVersion: e.row_version,
      patch: { payment_status: "paid", health: "failed", health_reason: reason },
      event: "payment_unplaced",
      actor: { type: "stripe", id: input.reference },
      now: input.now,
      meta: { receipt_id: input.receiptId, stage: e.stage },
    });
    if (!flagged.ok && flagged.error === "conflict") continue;
    console.error("[ai-audit.payment] a verified payment has no engagement to settle into", { engagementId: e.id, stage: e.stage, receiptId: input.receiptId });
    await input.deps.alert({
      tenantId: t,
      alertType: "ai_audit_payment_unplaced",
      severity: "urgent",
      title: replaced ? `Payment for an earlier proposal: ${shortName(e.business_name, "a client")}` : `Payment received for a ${e.stage.replace(/_/g, " ")} audit: ${shortName(e.business_name, "a client")}`,
      body: reason,
      subjectType: "ai_audit_engagement",
      subjectId: e.id,
      telegramOncePerOpen: true,
    });
    return "unplaced";
  }
  console.error("[ai-audit.payment] could not settle a verified payment after retries (concurrent writes)", { engagementId: input.engagementId, receiptId: input.receiptId });
  return "unplaced";
}

/**
 * The tick's repair: every verified receipt whose engagement has not caught
 * up (still payable, or closed without the payment being flagged) is settled.
 */
export async function settleVerifiedReceipts(db: Client, tenantId: string, now: Date, deps: PaymentDeps = defaultPaymentDeps(), limit = 10): Promise<number> {
  const t = requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT r.id, r.engagement_id, r.provider_reference, r.amount_cents, r.currency, r.checkout_id, r.proposal_version_id, r.installment_kind
          FROM ai_audit_payment_receipts r
          JOIN ai_audit_engagements e ON e.tenant_id = r.tenant_id AND e.id = r.engagement_id
          WHERE r.tenant_id = ? AND r.status = 'verified'
            AND ((e.stage IN (${WAITING_ON_CLIENT_STAGES.map(() => "?").join(", ")}) AND NOT (e.health = 'failed' AND e.payment_status = 'paid'))
                 OR (e.stage IN ('declined', 'cancelled', 'final_review', 'generating') AND e.health <> 'failed'))
          ORDER BY r.verified_at ASC LIMIT ?`,
    args: [t, ...WAITING_ON_CLIENT_STAGES, limit],
  });
  let n = 0;
  for (const r of rs.rows) {
    await settlePayment(db, {
      tenantId: t,
      engagementId: String(r.engagement_id),
      checkout: { id: String(r.checkout_id), proposal_version_id: String(r.proposal_version_id), installment_kind: String(r.installment_kind) === "deposit" ? "deposit" : String(r.installment_kind) === "balance" ? "balance" : "full" },
      receiptId: String(r.id),
      reference: String(r.provider_reference),
      amountCents: int(r.amount_cents),
      currency: String(r.currency),
      trigger: "tick_repair",
      now,
      deps,
    });
    n += 1;
  }
  return n;
}

/**
 * Stop a declined or cancelled engagement's open Checkout Sessions being paid:
 * each is expired at Stripe (POST /v1/checkout/sessions/:id/expire), then
 * marked expired here. A session Stripe says is already complete is verified
 * instead, so a payment that beat the decline is caught and flagged; those are
 * counted as complete (paid, or a bank payment still clearing), since money is
 * on its way for them.
 */
export async function expireOpenCheckouts(
  db: Client,
  tenantId: string,
  engagementId: string,
  now: Date,
  deps: PaymentDeps = defaultPaymentDeps(),
): Promise<{ expired: number; failed: number; complete: number }> {
  const t = requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts WHERE tenant_id = ? AND engagement_id = ? AND status IN ('creating', 'open') AND stripe_session_id IS NOT NULL`,
    args: [t, engagementId],
  });
  if (!rs.rows.length) return { expired: 0, failed: 0, complete: 0 };
  const secret = await deps.stripeSecret(t);
  let expired = 0;
  let failed = 0;
  let complete = 0;
  const f = deps.fetchImpl ?? fetch;
  for (const row of rs.rows) {
    const c = mapCheckout(row);
    const sessionId = c.stripe_session_id as string;
    const at = now.toISOString();
    let state: string | null = null;
    if (secret) {
      try {
        const res = await f(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
        state = res.ok && typeof body?.status === "string" ? body.status : null;
        // Refused (already complete or already expired): ask Stripe what the session is now.
        if (state !== "expired") state = await stripeSessionState(f, secret, sessionId);
      } catch (err) {
        console.error("[ai-audit.payment] could not expire a checkout session", { checkoutId: c.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (state === "expired") {
      await db.execute({ sql: "UPDATE ai_audit_checkouts SET status = 'expired', updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('creating', 'open')", args: [at, t, c.id] });
      expired += 1;
    } else if (state === "complete") {
      complete += 1;
      // Paid before the decline landed: record it, and settlePayment flags it for CC.
      const v = await verifyCheckout(db, { tenantId: t, checkoutId: c.id, now, trigger: "tick", deps });
      // Complete but not a payment we can count (a mismatch was flagged once): stop retrying it.
      if (v.status === "problem") {
        await db.execute({ sql: "UPDATE ai_audit_checkouts SET status = 'failed', last_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('creating', 'open')", args: [`complete_unverified:${v.code}`.slice(0, 200), at, t, c.id] });
      }
      // Finished but not paid yet (a bank payment still clearing): Stripe will not expire it, so the sweep leaves it to
      // the regular payment check instead of asking again on every tick (CodeRabbit on #746).
      if (v.status === "unpaid") {
        await db.execute({ sql: "UPDATE ai_audit_checkouts SET last_error = 'complete_unpaid', updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'open'", args: [at, t, c.id] });
      }
    } else {
      failed += 1;
      await db.execute({ sql: "UPDATE ai_audit_checkouts SET last_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", args: [secret ? "expire_failed" : "stripe_not_connected", at, t, c.id] });
    }
  }
  return { expired, failed, complete };
}

async function stripeSessionState(f: typeof fetch, secret: string, sessionId: string): Promise<string | null> {
  const res = await f(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
  return res.ok && typeof body?.status === "string" ? body.status : null;
}

/**
 * Engagements with a session still open that the client must not pay: closed
 * (declined, cancelled), being revised, or past payment; and any session for a
 * proposal the engagement no longer holds. A failed expire, a decline before
 * this existed, or a session Stripe opened while a revision landed (review of
 * phase 5, finding 1).
 */
export async function unpayableEngagementsWithOpenCheckouts(db: Client, tenantId: string, limit = 10): Promise<string[]> {
  // A session the client finished but has not paid yet is left to the regular payment check (dueOpenCheckouts):
  // Stripe will not expire it. Every other open one is asked again on each tick until it closes.
  const rs = await db.execute({
    sql: `SELECT DISTINCT c.engagement_id FROM ai_audit_checkouts c
          JOIN ai_audit_engagements e ON e.tenant_id = c.tenant_id AND e.id = c.engagement_id
          WHERE c.tenant_id = ? AND c.status IN ('creating', 'open') AND c.stripe_session_id IS NOT NULL
            AND (e.stage NOT IN (${WAITING_ON_CLIENT_STAGES.map(() => "?").join(", ")}) OR c.proposal_version_id IS NOT e.current_proposal_version_id)
            AND (c.last_error IS NULL OR c.last_error <> 'complete_unpaid')
          LIMIT ?`,
    args: [requireTenant(tenantId), ...WAITING_ON_CLIENT_STAGES, limit],
  });
  return rs.rows.map((r) => String(r.engagement_id));
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
  // Each problem is said once, and a payment that already failed is never
  // downgraded to "needs attention" by a later, lesser problem: the tick
  // re-checks every few minutes, and a flag that flips back and forth alerts
  // CC again each time.
  if (engagement.health === "failed" || (engagement.health === "attention" && engagement.health_reason === reason)) return;
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
    title: `Payment check needs you: ${shortName(engagement.business_name, "AI audit")}`,
    body: reason,
    subjectType: "ai_audit_engagement",
    subjectId: engagement.id,
    telegramOncePerOpen: true,
  });
}

/**
 * Every checkout of this tenant due a check: the open ones, and the ones this
 * side marked expired before Stripe's own expiry (Pay replaces a session in
 * its last half hour) until two hours after it, because the client may still
 * be finishing the old one.
 */
export async function dueOpenCheckouts(db: Client, tenantId: string, now: Date, limit = 20): Promise<Checkout[]> {
  const cutoff = new Date(now.getTime() - 4 * 60_000).toISOString();
  const lateWindow = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT ${CHECKOUT_COLUMNS} FROM ai_audit_checkouts
          WHERE tenant_id = ? AND stripe_session_id IS NOT NULL
            AND (status = 'open' OR (status = 'expired' AND expires_at IS NOT NULL AND expires_at > ?))
            AND (last_checked_at IS NULL OR last_checked_at <= ?)
          ORDER BY COALESCE(last_checked_at, created_at) ASC LIMIT ?`,
    args: [requireTenant(tenantId), lateWindow, cutoff, limit],
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

type ReceiptStatus = "verified" | "refunded" | "partially_refunded" | "disputed";

/**
 * The engagement's payment status, from all its receipts for one installment:
 * one verified receipt is paid (two or more, a duplicate to refund); with none
 * left, the worst of what happened to them (disputed, then refunded, then
 * partly refunded). Refunding the duplicate of two payments therefore leaves
 * the engagement paid, and onboarding goes on (Codex review of PR #732).
 */
export function aggregatePaymentStatus(statuses: readonly string[]): "paid" | "overpaid_review" | "disputed" | "refunded" | "partially_refunded" | "none" {
  const verified = statuses.filter((x) => x === "verified").length;
  if (verified >= 2) return "overpaid_review";
  if (verified === 1) return "paid";
  if (statuses.includes("disputed")) return "disputed";
  if (statuses.includes("refunded")) return "refunded";
  if (statuses.includes("partially_refunded")) return "partially_refunded";
  return "none";
}

/**
 * Re-read each recent verified receipt from Stripe, at most hourly. A refund or
 * a dispute updates the receipt AND the engagement in one write (the receipt
 * stays "verified", and is re-checked next time, unless both land), and alerts
 * CC. Nothing is deleted: CC decides what happens to the project.
 */
export async function reconcileReceipts(db: Client, tenantId: string, now: Date, deps: PaymentDeps = defaultPaymentDeps(), limit = 20): Promise<{ checked: number; changed: number }> {
  const t = requireTenant(tenantId);
  const due = new Date(now.getTime() - 60 * 60_000).toISOString();
  const since = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT r.id, r.engagement_id, r.provider_reference, r.amount_cents, r.currency, r.proposal_version_id, r.installment_kind, c.payment_token, e.lead_id
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
    const receiptId = String(r.id);
    let next: ReceiptStatus = "verified";
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
    if (next === "verified") {
      await db.execute({
        sql: `UPDATE ai_audit_payment_receipts SET last_reconciled_at = ?, reconciliation_attempts = reconciliation_attempts + 1,
                last_reconciliation_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
        args: [at, error, at, t, receiptId],
      });
      continue;
    }
    const words = next === "refunded" ? "was refunded" : next === "partially_refunded" ? "was partly refunded" : "is disputed";
    let landed = false;
    let engagement: Engagement | null = null;
    for (let attempt = 0; attempt < 4 && !landed; attempt++) {
      engagement = await getEngagement(db, t, String(r.engagement_id));
      if (!engagement) break;
      const others = (
        await db.execute({
          sql: "SELECT status FROM ai_audit_payment_receipts WHERE tenant_id = ? AND engagement_id = ? AND installment_kind = ? AND id <> ?",
          args: [t, engagement.id, String(r.installment_kind), receiptId],
        })
      ).rows.map((x) => String(x.status));
      const status = aggregatePaymentStatus([...others, next]);
      const stillPaid = status === "paid" || status === "overpaid_review";
      landed = await casWrite(
        db,
        engagementUpdateStatement(t, engagement.id, engagement.row_version, {
          payment_status: status,
          health: "attention",
          health_reason: stillPaid ? `A duplicate payment ${words} in Stripe; the proposal is still paid.` : `The payment ${words} in Stripe.`,
        }, at),
        [
          {
            sql: `UPDATE ai_audit_payment_receipts SET status = ?, last_reconciled_at = ?, reconciliation_attempts = reconciliation_attempts + 1,
                    last_reconciliation_error = NULL, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'verified'`,
            args: [next, at, at, t, receiptId],
          },
          eventStatement({ tenantId: t, engagementId: engagement.id, event: `payment_${next}`, actor: { type: "stripe", id: String(r.provider_reference) }, at, meta: { receipt_id: receiptId, engagement_payment_status: status } }),
        ],
      );
    }
    if (!landed || !engagement) {
      // Left verified: the next run checks it again rather than losing the refund.
      console.error("[ai-audit.payment] a refund or dispute could not be recorded; it is re-checked next run", { receiptId, engagementId: String(r.engagement_id), next });
      continue;
    }
    changed += 1;
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
