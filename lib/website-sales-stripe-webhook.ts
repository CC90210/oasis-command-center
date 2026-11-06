import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { dbError, type DriverError } from "@/lib/db-error";
import {
  verifyStripeWebsitePayment,
  type VerifiedWebsitePayment,
} from "@/lib/website-sales-payment";

const CHECKOUT_REFERENCE = /^cs_(?:test|live)_[A-Za-z0-9_]+$/;
const EVENT_REFERENCE = /^evt_[A-Za-z0-9_]+$/;
const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

type JsonObject = Record<string, unknown>;
type InstallmentKind = "deposit" | "balance" | "full";
type PaymentState = "deposit_collected" | "paid_awaiting_builder";
type SqlClient = Pick<Client, "execute" | "transaction">;
type VerifyPayment = typeof verifyStripeWebsitePayment;

export type StripeCheckoutCompletedEvent = {
  eventId: string;
  tenantId: string;
  leadId: string;
  reference: string;
  paymentToken: string;
  paymentPlanId: string;
  installmentKind: InstallmentKind;
  createdAt: string;
};

export type StripeCheckoutIngestResult = {
  idempotent: boolean;
  receiptId: string;
  state: PaymentState;
  collectedAmountCents: number;
  balanceDueCents: number;
  touchAt: string;
};

function object(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonObject;
}

function requiredString(value: unknown, code: string, max = 500): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) throw new Error(code);
  return normalized;
}

function parseJsonObject(value: unknown, code: string): JsonObject {
  if (typeof value !== "string") return object(value, code);
  try {
    return object(JSON.parse(value), code);
  } catch {
    throw new Error(code);
  }
}

function moneyCents(value: unknown, code: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) throw new Error(code);
  return cents;
}

function latestIso(current: unknown, candidate: string): string {
  const currentMs = typeof current === "string" ? Date.parse(current) : Number.NaN;
  const candidateMs = Date.parse(candidate);
  return Number.isFinite(currentMs) && currentMs > candidateMs ? String(current) : candidate;
}

export function parseStripeCheckoutCompletedEvent(rawBody: string): StripeCheckoutCompletedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("stripe_webhook_invalid_json");
  }
  const event = object(parsed, "stripe_webhook_invalid_event");
  if (event.type !== "checkout.session.completed") throw new Error("stripe_webhook_event_unsupported");
  if (event.livemode !== true) throw new Error("stripe_webhook_live_mode_required");
  const eventId = requiredString(event.id, "stripe_webhook_event_id_missing");
  if (!EVENT_REFERENCE.test(eventId)) throw new Error("stripe_webhook_event_id_invalid");
  const createdSeconds = typeof event.created === "number" && Number.isSafeInteger(event.created)
    ? event.created
    : null;
  if (createdSeconds === null || createdSeconds <= 0) throw new Error("stripe_webhook_created_invalid");
  const checkout = object(object(event.data, "stripe_webhook_data_missing").object, "stripe_webhook_checkout_missing");
  if (checkout.object !== "checkout.session" || checkout.livemode !== true) {
    throw new Error("stripe_webhook_checkout_invalid");
  }
  const reference = requiredString(checkout.id, "stripe_webhook_checkout_id_missing");
  if (!CHECKOUT_REFERENCE.test(reference)) throw new Error("stripe_webhook_checkout_id_invalid");
  const metadata = object(checkout.metadata, "stripe_webhook_metadata_missing");
  const leadId = requiredString(metadata.oasis_lead_id, "stripe_webhook_lead_missing");
  if (checkout.client_reference_id !== leadId) throw new Error("stripe_event_lead_binding_mismatch");
  const installmentKind = requiredString(metadata.oasis_installment_kind, "stripe_webhook_installment_missing") as InstallmentKind;
  if (!(["deposit", "balance", "full"] as string[]).includes(installmentKind)) {
    throw new Error("stripe_webhook_installment_invalid");
  }
  return {
    eventId,
    tenantId: requiredString(metadata.oasis_tenant_id, "stripe_webhook_tenant_missing"),
    leadId,
    reference,
    paymentToken: requiredString(metadata.oasis_payment_token, "stripe_webhook_payment_token_missing"),
    paymentPlanId: requiredString(metadata.oasis_payment_plan_id, "stripe_webhook_payment_plan_missing"),
    installmentKind,
    createdAt: new Date(createdSeconds * 1_000).toISOString(),
  };
}

export function verifyStripeWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): void {
  const secret = input.secret.trim();
  if (!secret) throw new Error("stripe_webhook_secret_missing");
  const header = input.signatureHeader?.trim() ?? "";
  if (!header) throw new Error("stripe_webhook_signature_missing");
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const member of header.split(",")) {
    const [rawKey, ...rawValue] = member.trim().split("=");
    const value = rawValue.join("=").trim();
    if (rawKey === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (rawKey === "v1" && /^[a-f0-9]{64}$/i.test(value)) v1.push(value.toLowerCase());
  }
  if (!Number.isSafeInteger(timestamp) || timestamp === null || timestamp <= 0 || v1.length === 0) {
    throw new Error("stripe_webhook_signature_invalid");
  }
  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(tolerance) || tolerance <= 0 || tolerance > 900) {
    throw new Error("stripe_webhook_tolerance_invalid");
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new Error("stripe_webhook_timestamp_outside_tolerance");
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${input.rawBody}`, "utf8")
    .digest();
  const valid = v1.some((candidate) => {
    const supplied = Buffer.from(candidate, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new Error("stripe_webhook_signature_invalid");
}

type LeadPaymentFacts = {
  data: JsonObject;
  rawData: string;
  stage: string;
  setupCents: number;
  alreadyCollectedCents: number;
  paymentDueCents: number;
  currency: "CAD" | "USD";
  expectedInstallmentKind: InstallmentKind;
};

async function readLeadPaymentFacts(client: Pick<Client | Transaction, "execute">, event: StripeCheckoutCompletedEvent): Promise<LeadPaymentFacts> {
  const selected = await client.execute({
    sql: `SELECT data FROM tenant_records
           WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1`,
    args: [event.tenantId, event.leadId],
  });
  if (selected.rows.length !== 1) throw new Error("stripe_webhook_lead_not_found");
  const rawData = requiredString(selected.rows[0].data, "stripe_webhook_lead_data_invalid", 1_000_000);
  const data = parseJsonObject(rawData, "stripe_webhook_lead_data_invalid");
  const stage = requiredString(data.stage, "stripe_webhook_lead_stage_missing", 100);
  if (stage !== "proposal_sent") throw new Error("stripe_webhook_lead_not_awaiting_payment");
  if (
    data.payment_plan_id !== event.paymentPlanId ||
    data.proposal_payment_token !== event.paymentToken ||
    data.stripe_checkout_session_id !== event.reference
  ) {
    throw new Error("stripe_webhook_payment_binding_mismatch");
  }
  const setupCents = moneyCents(data.quoted_setup_amount, "stripe_webhook_quote_invalid");
  const alreadyCollectedCents = moneyCents(data.collected_setup_amount ?? 0, "stripe_webhook_collected_invalid", true);
  const paymentDueCents = moneyCents(data.payment_due_amount, "stripe_webhook_payment_due_invalid");
  if (alreadyCollectedCents >= setupCents || paymentDueCents > setupCents - alreadyCollectedCents) {
    throw new Error("stripe_webhook_payment_schedule_invalid");
  }
  const currency = data.currency === "USD" ? "USD" : data.currency === "CAD" ? "CAD" : null;
  if (!currency) throw new Error("stripe_webhook_currency_invalid");
  const expectedInstallmentKind: InstallmentKind = alreadyCollectedCents > 0
    ? "balance"
    : paymentDueCents === setupCents
      ? "full"
      : "deposit";
  if (event.installmentKind !== expectedInstallmentKind) {
    throw new Error("stripe_webhook_installment_binding_mismatch");
  }
  return {
    data,
    rawData,
    stage,
    setupCents,
    alreadyCollectedCents,
    paymentDueCents,
    currency,
    expectedInstallmentKind,
  };
}

type ExistingReceipt = {
  id: string;
  leadId: string;
  status: string;
  amountCents: number;
  currency: "CAD" | "USD";
  paymentPlanId: string;
  paymentToken: string;
  installmentKind: InstallmentKind;
  verifiedAt: string;
};

async function readExistingReceipt(client: Pick<Client | Transaction, "execute">, event: StripeCheckoutCompletedEvent): Promise<ExistingReceipt | null> {
  const result = await client.execute({
    sql: `SELECT id, lead_id, status, amount_cents, currency, payment_plan_id,
                 payment_token, installment_kind, verified_at
            FROM website_sales_payment_receipts
           WHERE tenant_id = ? AND provider = 'stripe' AND provider_reference = ?
           LIMIT 1`,
    args: [event.tenantId, event.reference],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Record<string, unknown>;
  const currency = row.currency === "USD" ? "USD" : row.currency === "CAD" ? "CAD" : null;
  const installmentKind = row.installment_kind as InstallmentKind;
  if (
    !currency ||
    !(["deposit", "balance", "full"] as string[]).includes(installmentKind) ||
    row.lead_id !== event.leadId ||
    row.status !== "verified" ||
    row.payment_plan_id !== event.paymentPlanId ||
    row.payment_token !== event.paymentToken ||
    installmentKind !== event.installmentKind
  ) {
    throw new Error("stripe_webhook_payment_reference_already_used");
  }
  const amountCents = Number(row.amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("stripe_webhook_receipt_invalid");
  }
  return {
    id: requiredString(row.id, "stripe_webhook_receipt_invalid"),
    leadId: event.leadId,
    status: "verified",
    amountCents,
    currency,
    paymentPlanId: event.paymentPlanId,
    paymentToken: event.paymentToken,
    installmentKind,
    verifiedAt: requiredString(row.verified_at, "stripe_webhook_receipt_invalid"),
  };
}

async function independentlyVerify(
  event: StripeCheckoutCompletedEvent,
  secretKey: string,
  expected: { amountCents: number; currency: "CAD" | "USD" },
  verifyPayment: VerifyPayment,
): Promise<VerifiedWebsitePayment> {
  const verified = await verifyPayment({
    secretKey,
    reference: event.reference,
    expectedAmountCents: expected.amountCents,
    expectedCurrency: expected.currency,
    expectedTenantId: event.tenantId,
    expectedLeadId: event.leadId,
    expectedPaymentToken: event.paymentToken,
    expectedPaymentPlanId: event.paymentPlanId,
  });
  if (
    verified.provider !== "stripe" ||
    verified.reference !== event.reference ||
    verified.amountCents !== expected.amountCents ||
    verified.currency !== expected.currency ||
    verified.verificationSource !== "stripe_api"
  ) {
    throw new Error("stripe_webhook_independent_verification_mismatch");
  }
  return verified;
}

function stateForReceipt(installmentKind: InstallmentKind, collectedCents: number, setupCents: number): PaymentState {
  if (collectedCents < setupCents) return "deposit_collected";
  if (installmentKind === "deposit") throw new Error("stripe_webhook_installment_total_mismatch");
  return "paid_awaiting_builder";
}

export async function ingestStripeCheckoutCompleted(
  client: SqlClient,
  input: {
    event: StripeCheckoutCompletedEvent;
    secretKey: string;
    now?: Date;
    verifyPayment?: VerifyPayment;
  },
): Promise<StripeCheckoutIngestResult> {
  if (!input.secretKey.trim()) throw new Error("stripe_not_connected");
  const event = input.event;
  const verifyPayment = input.verifyPayment ?? verifyStripeWebsitePayment;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("stripe_webhook_clock_invalid");
  const occurredAt = now.toISOString();

  // A retry arrives after the deposit path deliberately rotates the lead token.
  // Resolve its immutable receipt first, then still re-query Stripe: idempotency
  // never turns into a trust-the-webhook shortcut.
  const existing = await readExistingReceipt(client as Client, event);
  if (existing) {
    await independentlyVerify(event, input.secretKey, {
      amountCents: existing.amountCents,
      currency: existing.currency,
    }, verifyPayment);
    const current = await client.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
      args: [event.tenantId, event.leadId],
    });
    if (current.rows.length !== 1) throw new Error("stripe_webhook_lead_not_found");
    const lead = parseJsonObject(current.rows[0].data, "stripe_webhook_lead_data_invalid");
    const collectedCents = moneyCents(lead.collected_setup_amount ?? 0, "stripe_webhook_collected_invalid", true);
    const balanceDueCents = moneyCents(lead.setup_balance_due ?? 0, "stripe_webhook_balance_invalid", true);
    // The lead may have advanced after the receipt was processed. Stripe retry
    // acknowledgement is tied to the immutable receipt, not to today's stage;
    // otherwise a valid retry after builder assignment would loop forever.
    const state: PaymentState = existing.installmentKind === "deposit"
      ? "deposit_collected"
      : "paid_awaiting_builder";
    return {
      idempotent: true,
      receiptId: existing.id,
      state,
      collectedAmountCents: collectedCents,
      balanceDueCents,
      touchAt: existing.verifiedAt,
    };
  }

  const before = await readLeadPaymentFacts(client as Client, event);
  const verified = await independentlyVerify(event, input.secretKey, {
    amountCents: before.paymentDueCents,
    currency: before.currency,
  }, verifyPayment);

  const tx = await client.transaction("write");
  try {
    const raced = await readExistingReceipt(tx, event);
    if (raced) {
      const latest = await tx.execute({
        sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
        args: [event.tenantId, event.leadId],
      });
      if (latest.rows.length !== 1) throw new Error("stripe_webhook_lead_not_found");
      const latestLead = parseJsonObject(latest.rows[0].data, "stripe_webhook_lead_data_invalid");
      const collectedAmountCents = moneyCents(latestLead.collected_setup_amount ?? 0, "stripe_webhook_collected_invalid", true);
      const balanceDueCents = moneyCents(latestLead.setup_balance_due ?? 0, "stripe_webhook_balance_invalid", true);
      await tx.commit();
      return {
        idempotent: true,
        receiptId: raced.id,
        state: raced.installmentKind === "deposit" ? "deposit_collected" : "paid_awaiting_builder",
        collectedAmountCents,
        balanceDueCents,
        touchAt: raced.verifiedAt,
      };
    }
    const current = await readLeadPaymentFacts(tx, event);
    if (
      current.rawData !== before.rawData ||
      current.paymentDueCents !== verified.amountCents ||
      current.currency !== verified.currency
    ) {
      throw new Error("stripe_webhook_lead_changed_during_verification");
    }
    const priorReceipts = await tx.execute({
      sql: `SELECT amount_cents, currency
              FROM website_sales_payment_receipts
             WHERE tenant_id = ? AND lead_id = ? AND payment_plan_id = ? AND status = 'verified'`,
      args: [event.tenantId, event.leadId, event.paymentPlanId],
    });
    let priorCollectedCents = 0;
    for (const row of priorReceipts.rows as Array<Record<string, unknown>>) {
      if (row.currency !== current.currency) throw new Error("stripe_webhook_payment_plan_currency_mismatch");
      const amount = Number(row.amount_cents);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("stripe_webhook_payment_plan_invalid");
      priorCollectedCents += amount;
    }
    if (priorCollectedCents !== current.alreadyCollectedCents) {
      throw new Error("stripe_webhook_payment_plan_ledger_mismatch");
    }
    const collectedCents = priorCollectedCents + verified.amountCents;
    if (!Number.isSafeInteger(collectedCents) || collectedCents > current.setupCents) {
      throw new Error("stripe_webhook_payment_plan_overpaid");
    }
    const balanceDueCents = current.setupCents - collectedCents;
    const state = stateForReceipt(event.installmentKind, collectedCents, current.setupCents);
    const receiptId = randomUUID();
    await tx.execute({
      sql: `INSERT INTO website_sales_payment_receipts
              (id, tenant_id, lead_id, provider, provider_reference, status,
               amount_cents, currency, provider_status, verification_source,
               verified_by, verified_at, summary, payment_plan_id, payment_token,
               installment_kind, created_at, updated_at)
            VALUES (?, ?, ?, 'stripe', ?, 'verified', ?, ?, ?, 'stripe_api',
                    'stripe_webhook', ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        receiptId,
        event.tenantId,
        event.leadId,
        event.reference,
        verified.amountCents,
        verified.currency,
        verified.providerStatus,
        occurredAt,
        JSON.stringify({ ...verified.summary, stripe_event_id: event.eventId }),
        event.paymentPlanId,
        event.paymentToken,
        event.installmentKind,
        occurredAt,
        occurredAt,
      ],
    });

    const merged: JsonObject = {
      ...current.data,
      payment_plan_status: state,
      payment_verified: state === "paid_awaiting_builder",
      payment_verified_by: "stripe_webhook",
      payment_verified_at: occurredAt,
      latest_verified_payment_id: receiptId,
      collected_setup_amount: collectedCents / 100,
      setup_balance_due: balanceDueCents / 100,
      payment_due_amount: balanceDueCents / 100,
      stripe_checkout_session_id: null,
      stripe_checkout_url: null,
      stripe_checkout_created_at: null,
      last_contacted_at: latestIso(current.data.last_contacted_at, occurredAt),
    };
    if (state === "deposit_collected") {
      merged.proposal_payment_token = randomUUID();
      merged.payment_installment_number = Number(current.data.payment_installment_number || 1) + 1;
    }
    const updated = await tx.execute({
      sql: `UPDATE tenant_records
               SET data = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' AND data IS ?`,
      args: [JSON.stringify(merged), occurredAt, event.tenantId, event.leadId, current.rawData],
    });
    if (updated.rowsAffected !== 1) throw new Error("stripe_webhook_lead_compare_and_swap_failed");

    const interactionId = randomUUID();
    const subject = state === "deposit_collected"
      ? "Stripe setup deposit received"
      : "Stripe setup payment received — builder required";
    const content = state === "deposit_collected"
      ? `${verified.currency} ${verified.amountCents / 100} setup deposit verified by Stripe. ${verified.currency} ${balanceDueCents / 100} remains before fulfillment can open.`
      : `${verified.currency} ${collectedCents / 100} setup payment verified by Stripe. Select and confirm a builder before fulfillment or commission can open.`;
    await tx.execute({
      sql: `INSERT INTO lead_interactions
              (id, tenant_id, lead_id, type, channel, direction, agent_source,
               actor_user_id, subject, content, content_preview, metadata, created_at)
            VALUES (?, ?, ?, 'payment_received', 'stripe', 'inbound',
                    'website_sales_pipeline', NULL, ?, ?, ?, ?, ?)`,
      args: [
        interactionId,
        event.tenantId,
        event.leadId,
        subject,
        content,
        content.slice(0, 1_024),
        JSON.stringify({
          request_id: event.eventId,
          action: "stripe_checkout_completed",
          stripe_event_id: event.eventId,
          provider_reference: event.reference,
          verified_payment_id: receiptId,
          payment_plan_id: event.paymentPlanId,
          payment_token: event.paymentToken,
          installment_kind: event.installmentKind,
          installment_amount_cents: verified.amountCents,
          collected_setup_amount_cents: collectedCents,
          setup_balance_due_cents: balanceDueCents,
          from: current.stage,
          to: current.stage,
        }),
        occurredAt,
      ],
    });
    await tx.commit();
    return {
      idempotent: false,
      receiptId,
      state,
      collectedAmountCents: collectedCents,
      balanceDueCents,
      touchAt: occurredAt,
    };
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    const safeError = error instanceof Error
      ? error
      : dbError("stripe_webhook.ingest", error as DriverError);
    throw safeError;
  } finally {
    tx.close();
  }
}
