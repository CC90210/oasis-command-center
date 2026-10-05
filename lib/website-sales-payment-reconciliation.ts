import type { Client } from "@libsql/client";
import { dbError, type DriverError } from "@/lib/db-error";
import { verifyStripeWebsitePayment } from "@/lib/website-sales-payment";

function driverError(error: unknown): DriverError {
  return error && typeof error === "object"
    ? (error as DriverError)
    : { message: String(error) };
}

export type StripeReceiptTerminalState = "refunded" | "disputed";

type Candidate = {
  receiptId: string;
  tenantId: string;
  leadId: string;
  reference: string;
  amountCents: number;
  currency: "CAD" | "USD";
  paymentToken: string;
  paymentPlanId: string;
  dealId: string;
  validationError?: string;
};

export type ReconciliationError = {
  tenantId: string;
  receiptId: string;
  leadId: string;
  error: string;
};

export type WebsiteSalesReconciliationResult = {
  scanned: number;
  healthy: number;
  refunded: number;
  disputed: number;
  errors: ReconciliationError[];
};

type VerifyPayment = typeof verifyStripeWebsitePayment;

type ReconcileOptions = {
  resolveStripeSecret: (tenantId: string) => Promise<string | null>;
  verifyPayment?: VerifyPayment;
  now?: Date;
  lookbackDays?: number;
  reconcileIntervalMinutes?: number;
  limit?: number;
};

type TerminalApplyResult = {
  idempotent: boolean;
  reversedCount: number;
  skippedCount: number;
};

function objectFromJson(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value !== "string") throw new Error(`${label}_invalid_json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}_invalid_json`);
  }
  return parsed as Record<string, unknown>;
}

function canonicalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || "reconciliation_failed";
  return firstLine.slice(0, 160);
}

function latestIso(existing: unknown, occurredAt: string): string {
  if (typeof existing !== "string") return occurredAt;
  const existingMs = Date.parse(existing);
  const occurredMs = Date.parse(occurredAt);
  if (!Number.isFinite(existingMs) || !Number.isFinite(occurredMs)) return occurredAt;
  return existingMs > occurredMs ? existing : occurredAt;
}

function terminalStateFromError(error: unknown): StripeReceiptTerminalState | null {
  const code = canonicalError(error);
  if (code === "payment_refunded") return "refunded";
  if (code === "payment_disputed") return "disputed";
  return null;
}

async function loadCandidates(
  client: Client,
  input: { now: Date; lookbackDays: number; reconcileIntervalMinutes: number; limit: number },
): Promise<Candidate[]> {
  const lookback = new Date(input.now.getTime() - input.lookbackDays * 86_400_000).toISOString();
  const dueBefore = new Date(input.now.getTime() - input.reconcileIntervalMinutes * 60_000).toISOString();
  const rs = await client.execute({
    sql: `SELECT r.id AS receipt_id, r.tenant_id, r.lead_id, r.provider_reference,
                 r.amount_cents, r.currency, r.payment_plan_id, r.payment_token,
                 tr.data AS lead_data, d.id AS deal_id
          FROM website_sales_payment_receipts r
          LEFT JOIN tenant_records tr
            ON tr.tenant_id = r.tenant_id AND tr.id = r.lead_id AND tr.entity_type = 'lead'
          LEFT JOIN website_deals d
            ON d.tenant_id = r.tenant_id AND d.lead_id = r.lead_id
           AND d.payment_plan_id = r.payment_plan_id
          WHERE r.provider = 'stripe'
            AND r.status = 'verified'
            AND r.verified_at >= ?
            AND (r.last_reconciled_at IS NULL OR r.last_reconciled_at <= ?)
          ORDER BY COALESCE(r.last_reconciliation_attempt_at, r.verified_at) ASC, r.id
          LIMIT ?`,
    args: [lookback, dueBefore, input.limit],
  });

  return rs.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const receiptId = String(row.receipt_id ?? "");
    const tenantId = String(row.tenant_id ?? "");
    const leadId = String(row.lead_id ?? "");
    const reference = String(row.provider_reference ?? "");
    const dealId = String(row.deal_id ?? "");
    const paymentPlanId = String(row.payment_plan_id ?? "");
    const amountCents = Number(row.amount_cents);
    const rawCurrency = String(row.currency ?? "").toUpperCase();
    let paymentToken = "";
    let validationError: string | undefined;
    try {
      if (!receiptId || !tenantId || !leadId || !reference) {
        throw new Error("stripe_receipt_identity_incomplete");
      }
      // A verified Stripe receipt legitimately exists before website_deals for
      // deposits, and can also exist briefly while a full-payment close waits
      // for its builder assignment. Those receipts still need unattended
      // refund/dispute detection; applyStripeReceiptTerminalState has a
      // transaction-safe pre-close branch for exactly that state.
      if (row.lead_data === null || row.lead_data === undefined) {
        throw new Error("missing_lead_record");
      }
      const lead = objectFromJson(row.lead_data, "lead_data");
      paymentToken = typeof row.payment_token === "string" && row.payment_token.trim()
        ? row.payment_token.trim()
        : typeof lead.proposal_payment_token === "string"
          ? lead.proposal_payment_token.trim()
          : "";
      if (!paymentPlanId) throw new Error(`stripe_receipt_missing_payment_plan:${receiptId}`);
      if (!dealId && lead.payment_plan_id !== paymentPlanId) {
        throw new Error(`lead_payment_plan_binding_mismatch:${receiptId}`);
      }
      if (!paymentToken) throw new Error(`stripe_receipt_missing_payment_binding:${receiptId}`);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new Error(`stripe_receipt_invalid_amount:${receiptId}`);
      }
      if (rawCurrency !== "CAD" && rawCurrency !== "USD") {
        throw new Error(`stripe_receipt_invalid_currency:${receiptId}`);
      }
    } catch (error) {
      validationError = canonicalError(error);
    }
    return {
      receiptId,
      tenantId,
      leadId,
      reference,
      amountCents,
      currency: (rawCurrency === "USD" ? "USD" : "CAD") as "CAD" | "USD",
      paymentToken,
      paymentPlanId,
      dealId,
      ...(validationError ? { validationError } : {}),
    };
  });
}

async function recordAttempt(
  client: Client,
  candidate: Candidate,
  input: { occurredAt: string; error: string | null; reconciled: boolean },
): Promise<void> {
  const rs = await client.execute({
    sql: `UPDATE website_sales_payment_receipts
          SET last_reconciliation_attempt_at = ?,
              last_reconciled_at = CASE WHEN ? = 1 THEN ? ELSE last_reconciled_at END,
              reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciliation_error = ?,
              updated_at = ?
          WHERE tenant_id = ? AND id = ? AND lead_id = ?
            AND provider = 'stripe' AND status = 'verified'`,
    args: [
      input.occurredAt,
      input.reconciled ? 1 : 0,
      input.occurredAt,
      input.error,
      input.occurredAt,
      candidate.tenantId,
      candidate.receiptId,
      candidate.leadId,
    ],
  });
  if (rs.rowsAffected !== 1) throw new Error("stripe_receipt_attempt_cas_failed");
}

/**
 * Apply a provider terminal fact as one Turso transaction. Money offsets,
 * fulfillment blocking, the lead's Last Touch, and the timeline can therefore
 * never disagree after a crash or concurrent cron tick.
 */
export async function applyStripeReceiptTerminalState(
  client: Client,
  input: Candidate & {
    terminalState: StripeReceiptTerminalState;
    occurredAt: string;
  },
): Promise<TerminalApplyResult> {
  const tx = await client.transaction("write");
  try {
    const receiptRs = await tx.execute({
      sql: `SELECT provider, provider_reference, status, amount_cents, currency, summary,
                   payment_plan_id
            FROM website_sales_payment_receipts
            WHERE tenant_id = ? AND id = ? AND lead_id = ? LIMIT 1`,
      args: [input.tenantId, input.receiptId, input.leadId],
    });
    const receipt = receiptRs.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!receipt) throw new Error("stripe_receipt_not_found");
    if (receipt.provider !== "stripe") throw new Error("manual_receipt_not_reconcilable");
    if (receipt.provider_reference !== input.reference) throw new Error("stripe_receipt_reference_mismatch");
    if (receipt.payment_plan_id !== input.paymentPlanId) throw new Error("stripe_receipt_payment_plan_mismatch");
    if (receipt.status === input.terminalState) {
      await tx.commit();
      return { idempotent: true, reversedCount: 0, skippedCount: 0 };
    }
    if (receipt.status !== "verified") throw new Error("stripe_receipt_not_reconcilable");
    if (Number(receipt.amount_cents) !== input.amountCents || receipt.currency !== input.currency) {
      throw new Error("stripe_receipt_financial_mismatch");
    }

    const dealRs = await tx.execute({
      sql: `SELECT id, status, verified_payment_id, payment_provider, payment_reference,
                   payment_plan_id
            FROM website_deals
            WHERE tenant_id = ? AND lead_id = ? AND payment_plan_id = ? LIMIT 1`,
      args: [input.tenantId, input.leadId, input.paymentPlanId],
    });
    const deal = dealRs.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!deal) {
      const leadRs = await tx.execute({
        sql: `SELECT data FROM tenant_records
              WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1`,
        args: [input.tenantId, input.leadId],
      });
      const leadRow = leadRs.rows[0] as unknown as Record<string, unknown> | undefined;
      if (!leadRow) throw new Error("lead_not_found_or_wrong_tenant");
      const lead = objectFromJson(leadRow.data, "lead_data");
      if (lead.payment_plan_id !== input.paymentPlanId) {
        throw new Error("lead_payment_plan_binding_mismatch");
      }
      const remainingRs = await tx.execute({
        sql: `SELECT COALESCE(SUM(amount_cents), 0) AS collected_cents
              FROM website_sales_payment_receipts
              WHERE tenant_id = ? AND lead_id = ? AND payment_plan_id = ?
                AND status = 'verified' AND id <> ?`,
        args: [input.tenantId, input.leadId, input.paymentPlanId, input.receiptId],
      });
      const remainingCents = Number(remainingRs.rows[0]?.collected_cents ?? 0);
      const quotedSetupCents = Math.round(Number(lead.quoted_setup_amount || 0) * 100);
      const reason = `stripe_${input.terminalState}`;
      const lastTouch = latestIso(lead.last_contacted_at, input.occurredAt);
      const updatedLead = {
        ...lead,
        payment_verified:false,
        payment_status:input.terminalState,
        payment_plan_status:"payment_issue",
        payment_provider_status:reason,
        payment_terminal_at:input.occurredAt,
        payment_reconciliation_receipt_id:input.receiptId,
        collected_setup_amount:remainingCents / 100,
        setup_balance_due:Math.max(0, quotedSetupCents - remainingCents) / 100,
        payment_due_amount:Math.max(0, quotedSetupCents - remainingCents) / 100,
        last_contacted_at:lastTouch,
      };
      const leadUpdate = await tx.execute({
        sql: `UPDATE tenant_records SET data = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND entity_type = 'lead'`,
        args: [JSON.stringify(updatedLead), input.occurredAt, input.tenantId, input.leadId],
      });
      if (leadUpdate.rowsAffected !== 1) throw new Error("lead_deposit_terminal_cas_failed");

      const subject = input.terminalState === "disputed"
        ? "Stripe deposit disputed"
        : "Stripe deposit refunded";
      await tx.execute({
        sql: `INSERT INTO lead_interactions
                (id, tenant_id, lead_id, type, channel, direction, agent_source,
                 actor_user_id, subject, content, content_preview, metadata, created_at)
              VALUES (?, ?, ?, 'payment_status_change', 'internal', 'internal',
                      'website_sales_payment_reconciler', NULL, ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          input.tenantId,
          input.leadId,
          subject,
          `${subject}. No deal, commission, or fulfillment record had been opened.`,
          subject,
          JSON.stringify({
            actor:"system",
            terminal_state:input.terminalState,
            receipt_id:input.receiptId,
            provider_reference:input.reference,
            payment_plan_id:input.paymentPlanId,
            remaining_collected_cents:remainingCents,
          }),
          input.occurredAt,
        ],
      });
      const receiptSummary = objectFromJson(receipt.summary, "payment_receipt_summary");
      const receiptUpdate = await tx.execute({
        sql: `UPDATE website_sales_payment_receipts
              SET status = ?, provider_status = ?,
                  last_reconciliation_attempt_at = ?, last_reconciled_at = ?,
                  reconciliation_attempts = reconciliation_attempts + 1,
                  last_reconciliation_error = NULL,
                  terminal_at = ?, terminal_reason = ?, summary = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND lead_id = ?
                AND provider = 'stripe' AND status = 'verified'`,
        args: [
          input.terminalState,
          reason,
          input.occurredAt,
          input.occurredAt,
          input.occurredAt,
          reason,
          JSON.stringify({
            ...receiptSummary,
            reconciliation_terminal_state:input.terminalState,
            reconciliation_detected_at:input.occurredAt,
            commission_offsets_created:0,
          }),
          input.occurredAt,
          input.tenantId,
          input.receiptId,
          input.leadId,
        ],
      });
      if (receiptUpdate.rowsAffected !== 1) throw new Error("stripe_receipt_terminal_cas_failed");
      await tx.commit();
      return { idempotent:false, reversedCount:0, skippedCount:0 };
    }
    if (
      deal.payment_plan_id !== input.paymentPlanId
    ) {
      throw new Error("website_deal_payment_binding_mismatch");
    }

    const onboardingRs = await tx.execute({
      sql: `SELECT id, status, intake FROM website_onboarding
            WHERE tenant_id = ? AND deal_id = ? AND lead_id = ? LIMIT 1`,
      args: [input.tenantId, input.dealId, input.leadId],
    });
    const onboarding = onboardingRs.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!onboarding) throw new Error("website_onboarding_not_found");

    const leadRs = await tx.execute({
      sql: `SELECT data FROM tenant_records
            WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1`,
      args: [input.tenantId, input.leadId],
    });
    const leadRow = leadRs.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!leadRow) throw new Error("lead_not_found_or_wrong_tenant");
    const lead = objectFromJson(leadRow.data, "lead_data");
    const intake = objectFromJson(onboarding.intake, "website_onboarding_intake");
    const receiptSummary = objectFromJson(receipt.summary, "payment_receipt_summary");

    const accrualRs = await tx.execute({
      sql: `SELECT id, rep_user_id, party_role, payment_reference, comp_version,
                   payment_plan_id,
                   basis_amount_cents, rate_bps, amount_cents, collected_setup_amount,
                   amount, status, clawback_deadline_at
            FROM website_sales_commissions
            WHERE tenant_id = ? AND deal_id = ? AND entry_type = 'accrual'
            ORDER BY id`,
      args: [input.tenantId, input.dealId],
    });
    let reversedCount = 0;
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const raw of accrualRs.rows) {
      const row = raw as unknown as Record<string, unknown>;
      const id = String(row.id);
      const status = String(row.status ?? "");
      const deadline = typeof row.clawback_deadline_at === "string" ? row.clawback_deadline_at : null;
      if (status === "paid") {
        skipped.push({ id, reason: "already_paid_out" });
        continue;
      }
      if (status !== "accrued" && status !== "approved") {
        skipped.push({ id, reason: `commission_${status || "unknown"}` });
        continue;
      }
      if (!deadline) {
        skipped.push({ id, reason: "no_clawback_deadline_recorded" });
        continue;
      }
      if (input.occurredAt > deadline) {
        skipped.push({ id, reason: "clawback_window_expired" });
        continue;
      }
      const amountCents = Number(row.amount_cents ?? 0);
      const partyRole = String(row.party_role);
      const offsetRs = await tx.execute({
        sql: `INSERT INTO website_sales_commissions
                (id, tenant_id, deal_id, rep_user_id, party_role, payment_reference,
                 payment_plan_id, entry_type, comp_version, basis_amount_cents, rate_bps, amount_cents,
                 notes, collected_setup_amount, rate, amount, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'refund_offset', ?, ?, ?, ?, ?, ?, 0, ?, 'offset', ?, ?)
              ON CONFLICT (tenant_id, payment_reference, entry_type, party_role) DO NOTHING`,
        args: [
          crypto.randomUUID(),
          input.tenantId,
          input.dealId,
          String(row.rep_user_id),
          partyRole,
          String(row.payment_reference),
          String(row.payment_plan_id ?? "") || null,
          Number(row.comp_version ?? 3),
          Number(row.basis_amount_cents ?? 0),
          Number(row.rate_bps ?? 0),
          -amountCents,
          JSON.stringify([
            `${input.terminalState}_offset of ${amountCents}c`,
            `receipt: ${input.receiptId}`,
          ]),
          Number(row.collected_setup_amount ?? 0),
          -Number(row.amount ?? 0),
          input.occurredAt,
          input.occurredAt,
        ],
      });
      if (offsetRs.rowsAffected !== 1) throw new Error("commission_refund_offset_conflict");
      const originalRs = await tx.execute({
        sql: `UPDATE website_sales_commissions
              SET status = 'offset', updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status IN ('accrued','approved')`,
        args: [input.occurredAt, input.tenantId, id],
      });
      if (originalRs.rowsAffected !== 1) throw new Error("commission_accrual_offset_cas_failed");
      reversedCount += 1;
    }

    const reason = `stripe_${input.terminalState}`;
    const dealUpdate = await tx.execute({
      sql: `UPDATE website_deals
            SET status = 'refunded', loss_reason = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND payment_plan_id = ?`,
      args: [reason, input.occurredAt, input.tenantId, input.dealId, input.paymentPlanId],
    });
    if (dealUpdate.rowsAffected !== 1) throw new Error("website_deal_refund_cas_failed");

    const blockedIntake = {
      ...intake,
      payment_block: {
        state: input.terminalState,
        receipt_id: input.receiptId,
        provider_reference: input.reference,
        previous_status: String(onboarding.status ?? "unknown"),
        detected_at: input.occurredAt,
      },
    };
    const onboardingUpdate = await tx.execute({
      sql: `UPDATE website_onboarding
            SET status = 'blocked', intake = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND deal_id = ?`,
      args: [
        JSON.stringify(blockedIntake),
        input.occurredAt,
        input.tenantId,
        String(onboarding.id),
        input.dealId,
      ],
    });
    if (onboardingUpdate.rowsAffected !== 1) throw new Error("website_onboarding_block_cas_failed");

    const lastTouch = latestIso(lead.last_contacted_at, input.occurredAt);
    const updatedLead = {
      ...lead,
      payment_verified: false,
      payment_status: input.terminalState,
      payment_provider_status: reason,
      payment_terminal_at: input.occurredAt,
      payment_reconciliation_receipt_id: input.receiptId,
      fulfillment_blocked: true,
      fulfillment_blocked_at: input.occurredAt,
      fulfillment_blocked_reason: reason,
      last_contacted_at: lastTouch,
    };
    const leadUpdate = await tx.execute({
      sql: `UPDATE tenant_records SET data = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND entity_type = 'lead'`,
      args: [JSON.stringify(updatedLead), input.occurredAt, input.tenantId, input.leadId],
    });
    if (leadUpdate.rowsAffected !== 1) throw new Error("lead_payment_block_cas_failed");

    const subject = input.terminalState === "disputed"
      ? "Stripe payment disputed — fulfillment blocked"
      : "Stripe payment refunded — fulfillment blocked";
    await tx.execute({
      sql: `INSERT INTO lead_interactions
              (id, tenant_id, lead_id, type, channel, direction, agent_source,
               actor_user_id, subject, content, content_preview, metadata, created_at)
            VALUES (?, ?, ?, 'payment_status_change', 'internal', 'internal',
                    'website_sales_payment_reconciler', NULL, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        input.tenantId,
        input.leadId,
        subject,
        `${subject}. Receipt ${input.receiptId}; ${reversedCount} commission line(s) offset; ` +
          `${skipped.length} line(s) require no automatic adjustment.`,
        subject,
        JSON.stringify({
          actor: "system",
          terminal_state: input.terminalState,
          receipt_id: input.receiptId,
          provider_reference: input.reference,
          deal_id: input.dealId,
          reversed_count: reversedCount,
          skipped,
        }),
        input.occurredAt,
      ],
    });

    const receiptUpdate = await tx.execute({
      sql: `UPDATE website_sales_payment_receipts
            SET status = ?, provider_status = ?,
                last_reconciliation_attempt_at = ?, last_reconciled_at = ?,
                reconciliation_attempts = reconciliation_attempts + 1,
                last_reconciliation_error = NULL,
                terminal_at = ?, terminal_reason = ?, summary = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND lead_id = ?
              AND provider = 'stripe' AND status = 'verified'`,
      args: [
        input.terminalState,
        reason,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
        reason,
        JSON.stringify({
          ...receiptSummary,
          reconciliation_terminal_state: input.terminalState,
          reconciliation_detected_at: input.occurredAt,
          commission_offsets_created: reversedCount,
          commission_offsets_skipped: skipped,
        }),
        input.occurredAt,
        input.tenantId,
        input.receiptId,
        input.leadId,
      ],
    });
    if (receiptUpdate.rowsAffected !== 1) throw new Error("stripe_receipt_terminal_cas_failed");

    await tx.commit();
    return { idempotent: false, reversedCount, skippedCount: skipped.length };
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw dbError("website_sales_reconciliation.apply_terminal_state", driverError(error));
  } finally {
    tx.close();
  }
}

/**
 * Re-fetch every due Stripe receipt and close the post-payment loop. Manual
 * receipts are intentionally absent from the candidate query: only Stripe can
 * be independently re-verified by this unattended process.
 */
export async function reconcileWebsiteSalesPayments(
  client: Client,
  options: ReconcileOptions,
): Promise<WebsiteSalesReconciliationResult> {
  const now = options.now ?? new Date();
  const occurredAt = now.toISOString();
  const candidates = await loadCandidates(client, {
    now,
    lookbackDays: Math.max(1, Math.min(options.lookbackDays ?? 540, 730)),
    reconcileIntervalMinutes: Math.max(5, options.reconcileIntervalMinutes ?? 55),
    limit: Math.max(1, Math.min(options.limit ?? 100, 250)),
  });
  const result: WebsiteSalesReconciliationResult = {
    scanned: candidates.length,
    healthy: 0,
    refunded: 0,
    disputed: 0,
    errors: [],
  };
  const secretCache = new Map<string, Promise<string | null>>();
  const verifyPayment = options.verifyPayment ?? verifyStripeWebsitePayment;

  for (const candidate of candidates) {
    try {
      if (candidate.validationError) throw new Error(candidate.validationError);
      let secret = secretCache.get(candidate.tenantId);
      if (!secret) {
        secret = options.resolveStripeSecret(candidate.tenantId);
        secretCache.set(candidate.tenantId, secret);
      }
      const secretKey = await secret;
      if (!secretKey) throw new Error("stripe_not_connected");

      try {
        await verifyPayment({
          secretKey,
          reference: candidate.reference,
          expectedAmountCents: candidate.amountCents,
          expectedCurrency: candidate.currency,
          expectedTenantId: candidate.tenantId,
          expectedLeadId: candidate.leadId,
          expectedPaymentToken: candidate.paymentToken,
          expectedPaymentPlanId: candidate.paymentPlanId,
        });
        await recordAttempt(client, candidate, {
          occurredAt,
          error: null,
          reconciled: true,
        });
        result.healthy += 1;
      } catch (verificationError) {
        const terminalState = terminalStateFromError(verificationError);
        if (!terminalState) throw verificationError;
        await applyStripeReceiptTerminalState(client, {
          ...candidate,
          terminalState,
          occurredAt,
        });
        result[terminalState] += 1;
      }
    } catch (error) {
      const code = canonicalError(error);
      try {
        await recordAttempt(client, candidate, {
          occurredAt,
          error: code,
          reconciled: false,
        });
      } catch (attemptError) {
        result.errors.push({
          tenantId: candidate.tenantId,
          receiptId: candidate.receiptId,
          leadId: candidate.leadId,
          error: `${code}; attempt_record_failed:${canonicalError(attemptError)}`,
        });
        continue;
      }
      result.errors.push({
        tenantId: candidate.tenantId,
        receiptId: candidate.receiptId,
        leadId: candidate.leadId,
        error: code,
      });
    }
  }

  return result;
}
