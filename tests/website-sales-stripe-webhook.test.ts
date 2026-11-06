import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { isPublic } from "../middleware";
import {
  ingestStripeCheckoutCompleted,
  parseStripeCheckoutCompletedEvent,
  verifyStripeWebhookSignature,
} from "../lib/website-sales-stripe-webhook";
import type { VerifiedWebsitePayment } from "../lib/website-sales-payment";

const routeSource = readFileSync("app/api/webhooks/stripe/route.ts", "utf8");
const storeSource = readFileSync("lib/tenant-integration-store.ts", "utf8");
const schemaSource = readFileSync("lib/tenant-integration-schemas.ts", "utf8");
assert.match(routeSource, /await req\.text\(\)/, "Stripe signatures must be checked against the untouched raw body");
assert.match(routeSource, /stripe-signature/i, "the webhook route must require Stripe's signature header");
assert.match(routeSource, /getTenantIntegrationValue\(tenantId,\s*"stripe",\s*"webhook_secret"\)/, "the signing secret must resolve inside the event tenant");
assert.match(routeSource, /verifyStripeWebsitePayment/, "the webhook must independently re-read Checkout from Stripe");
assert.doesNotMatch(routeSource, /getSessionUser|getOasisWebsiteSalesSession/, "Stripe authenticates this machine endpoint with its signature, not a browser session");
assert.equal(isPublic("/api/webhooks/stripe"), true, "session middleware must let Stripe reach its own signature gate");
assert.match(storeSource, /webhook_secret:\s*"STRIPE_WEBHOOK_SECRET"/, "deployments need an env fallback for the Stripe webhook secret");
assert.match(schemaSource, /key:\s*"webhook_secret"/, "Settings must expose the tenant-scoped Stripe webhook secret");

const WEBHOOK_SECRET = "unit-test-stripe-signing-key";
const NOW_MS = Date.parse("2026-08-25T15:00:00.000Z");
const TENANT = "tenant-oasis";

function signedHeader(rawBody: string, timestampSeconds = Math.floor(NOW_MS / 1_000)): string {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

const signatureBody = JSON.stringify({ id: "evt_signature", type: "checkout.session.completed" });
assert.doesNotThrow(() => verifyStripeWebhookSignature({
  rawBody: signatureBody,
  signatureHeader: signedHeader(signatureBody),
  secret: WEBHOOK_SECRET,
  nowMs: NOW_MS,
}));
assert.throws(() => verifyStripeWebhookSignature({
  rawBody: `${signatureBody} `,
  signatureHeader: signedHeader(signatureBody),
  secret: WEBHOOK_SECRET,
  nowMs: NOW_MS,
}), /stripe_webhook_signature_invalid/);
assert.throws(() => verifyStripeWebhookSignature({
  rawBody: signatureBody,
  signatureHeader: signedHeader(signatureBody, Math.floor(NOW_MS / 1_000) - 301),
  secret: WEBHOOK_SECRET,
  nowMs: NOW_MS,
}), /stripe_webhook_timestamp_outside_tolerance/);

async function main() {
const db = createClient({ url: "file::memory:?cache=shared" });
await db.executeMultiple(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE tenants (id TEXT PRIMARY KEY);
  CREATE TABLE tenant_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
    data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
    type TEXT, channel TEXT, direction TEXT, agent_source TEXT,
    actor_user_id TEXT, subject TEXT, content TEXT, content_preview TEXT,
    metadata TEXT, created_at TEXT
  );
  CREATE UNIQUE INDEX website_sales_action_request_idx
    ON lead_interactions (tenant_id, json_extract(metadata, '$.request_id'))
    WHERE agent_source = 'website_sales_pipeline'
      AND json_extract(metadata, '$.request_id') IS NOT NULL;
  CREATE TABLE website_sales_payment_receipts (
    id TEXT NOT NULL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','manual')),
    provider_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('verified','refunded','disputed','voided')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL CHECK (currency IN ('CAD','USD')),
    provider_status TEXT NOT NULL,
    verification_source TEXT NOT NULL CHECK (verification_source IN ('stripe_api','founder_manual')),
    verified_by TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '{}',
    payment_plan_id TEXT,
    payment_token TEXT,
    installment_kind TEXT CHECK (installment_kind IS NULL OR installment_kind IN ('deposit','balance','full')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, provider, provider_reference),
    UNIQUE (tenant_id, id)
  );
  CREATE TABLE website_deals (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT);
  CREATE TABLE website_onboarding (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT);
  CREATE TABLE website_sales_commissions (id TEXT PRIMARY KEY, tenant_id TEXT, deal_id TEXT);
`);
await db.execute({ sql: "INSERT INTO tenants (id) VALUES (?)", args: [TENANT] });

type SeedOptions = {
  suffix: string;
  setupAmount: number;
  paymentDueAmount: number;
  collectedAmount?: number;
  installmentKind: "deposit" | "balance" | "full";
};

async function seed(options: SeedOptions) {
  const leadId = `lead-${options.suffix}`;
  const paymentPlanId = `plan-${options.suffix}`;
  const paymentToken = `token-${options.suffix}`;
  const reference = `cs_live_${options.suffix}`;
  const eventId = `evt_${options.suffix}`;
  await db.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at)
          VALUES (?, ?, 'lead', ?, ?)`,
    args: [
      leadId,
      TENANT,
      JSON.stringify({
        stage: "proposal_sent",
        assigned_to: "closer-one",
        attributed_rep_user_id: "opener-one",
        quoted_setup_amount: options.setupAmount,
        collected_setup_amount: options.collectedAmount ?? 0,
        setup_balance_due: options.setupAmount - (options.collectedAmount ?? 0),
        payment_due_amount: options.paymentDueAmount,
        currency: "CAD",
        payment_plan_id: paymentPlanId,
        proposal_payment_token: paymentToken,
        payment_plan_status: "awaiting_first_payment",
        payment_installment_number: options.collectedAmount ? 2 : 1,
        stripe_checkout_session_id: reference,
        stripe_checkout_url: `https://checkout.stripe.com/c/pay/${reference}`,
        last_contacted_at: "2026-08-20T00:00:00.000Z",
      }),
      "2026-08-20T00:00:00.000Z",
    ],
  });
  const event = parseStripeCheckoutCompletedEvent(JSON.stringify({
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(NOW_MS / 1_000),
    livemode: true,
    data: {
      object: {
        id: reference,
        object: "checkout.session",
        client_reference_id: leadId,
        livemode: true,
        metadata: {
          oasis_tenant_id: TENANT,
          oasis_lead_id: leadId,
          oasis_payment_token: paymentToken,
          oasis_payment_plan_id: paymentPlanId,
          oasis_installment_kind: options.installmentKind,
        },
      },
    },
  }));
  return { leadId, paymentPlanId, paymentToken, reference, eventId, event };
}

let verificationCalls = 0;
const verifyPayment = async (input: {
  reference: string;
  expectedAmountCents: number;
  expectedCurrency: "CAD" | "USD";
  expectedTenantId: string;
  expectedLeadId: string;
  expectedPaymentToken: string;
  expectedPaymentPlanId: string;
}): Promise<VerifiedWebsitePayment> => {
  verificationCalls += 1;
  return ({
  provider: "stripe",
  reference: input.reference,
  amountCents: input.expectedAmountCents,
  currency: input.expectedCurrency,
  providerStatus: "paid",
  verificationSource: "stripe_api",
  summary: {
    payment_plan_id: input.expectedPaymentPlanId,
    payment_token: input.expectedPaymentToken,
    independently_verified: true,
  },
  });
};

async function one(sql: string, args: Array<string> = []) {
  const result = await db.execute({ sql, args });
  assert.equal(result.rows.length, 1, sql);
  return result.rows[0] as Record<string, unknown>;
}

const deposit = await seed({ suffix: "deposit", setupAmount: 4_000, paymentDueAmount: 1_000, installmentKind: "deposit" });
const depositResult = await ingestStripeCheckoutCompleted(db, {
  event: deposit.event,
  secretKey: "unit-test-stripe-api-key",
  now: new Date(NOW_MS),
  verifyPayment,
});
assert.equal(depositResult.state, "deposit_collected");
assert.equal(depositResult.idempotent, false);
assert.equal(verificationCalls, 1, "a completion is never trusted without a Stripe API read");
const depositLead = JSON.parse(String((await one("SELECT data FROM tenant_records WHERE id = ?", [deposit.leadId])).data));
assert.equal(depositLead.stage, "proposal_sent");
assert.equal(depositLead.payment_plan_status, "deposit_collected");
assert.equal(depositLead.collected_setup_amount, 1_000);
assert.equal(depositLead.setup_balance_due, 3_000);
assert.equal(depositLead.payment_due_amount, 3_000);
assert.notEqual(depositLead.proposal_payment_token, deposit.paymentToken, "the balance receives a fresh payment token");
assert.equal((await one("SELECT count(*) AS count FROM website_sales_payment_receipts WHERE lead_id = ?", [deposit.leadId])).count, 1);
assert.equal((await one("SELECT count(*) AS count FROM lead_interactions WHERE lead_id = ?", [deposit.leadId])).count, 1);

const duplicateResult = await ingestStripeCheckoutCompleted(db, {
  event: deposit.event,
  secretKey: "unit-test-stripe-api-key",
  now: new Date(NOW_MS + 1_000),
  verifyPayment,
});
assert.equal(duplicateResult.idempotent, true);
assert.equal(verificationCalls, 2, "a duplicate still independently re-verifies Checkout with Stripe");
assert.equal((await one("SELECT count(*) AS count FROM website_sales_payment_receipts WHERE lead_id = ?", [deposit.leadId])).count, 1);
assert.equal((await one("SELECT count(*) AS count FROM lead_interactions WHERE lead_id = ?", [deposit.leadId])).count, 1);

const full = await seed({ suffix: "full", setupAmount: 4_000, paymentDueAmount: 4_000, installmentKind: "full" });
const fullResult = await ingestStripeCheckoutCompleted(db, {
  event: full.event,
  secretKey: "unit-test-stripe-api-key",
  now: new Date(NOW_MS),
  verifyPayment,
});
assert.equal(fullResult.state, "paid_awaiting_builder");
const fullLead = JSON.parse(String((await one("SELECT data FROM tenant_records WHERE id = ?", [full.leadId])).data));
assert.equal(fullLead.stage, "proposal_sent", "a payment webhook cannot silently open fulfillment");
assert.equal(fullLead.payment_plan_status, "paid_awaiting_builder");
assert.equal(fullLead.collected_setup_amount, 4_000);
assert.equal(fullLead.setup_balance_due, 0);
assert.equal(fullLead.payment_due_amount, 0);
assert.equal(fullLead.assigned_to, "closer-one", "without a preselected builder, ownership stays frozen");
assert.equal((await one("SELECT count(*) AS count FROM website_deals")).count, 0);
assert.equal((await one("SELECT count(*) AS count FROM website_onboarding")).count, 0);
assert.equal((await one("SELECT count(*) AS count FROM website_sales_commissions")).count, 0);
assert.equal((await one("SELECT count(*) AS count FROM website_sales_payment_receipts WHERE lead_id = ?", [full.leadId])).count, 1);
assert.equal((await one("SELECT count(*) AS count FROM lead_interactions WHERE lead_id = ?", [full.leadId])).count, 1);

const mismatched = await seed({ suffix: "mismatch", setupAmount: 4_000, paymentDueAmount: 1_000, installmentKind: "deposit" });
await assert.rejects(() => ingestStripeCheckoutCompleted(db, {
  event: { ...mismatched.event, paymentToken: "token-someone-else" },
  secretKey: "unit-test-stripe-api-key",
  now: new Date(NOW_MS),
  verifyPayment,
}), /stripe_webhook_payment_binding_mismatch/);
assert.equal((await one("SELECT count(*) AS count FROM website_sales_payment_receipts WHERE lead_id = ?", [mismatched.leadId])).count, 0);

const rollback = await seed({ suffix: "rollback", setupAmount: 4_000, paymentDueAmount: 1_000, installmentKind: "deposit" });
await db.executeMultiple(`
  CREATE TRIGGER fail_stripe_webhook_touch
  BEFORE INSERT ON lead_interactions
  WHEN NEW.lead_id = 'lead-rollback'
  BEGIN
    SELECT RAISE(ABORT, 'synthetic timeline failure');
  END;
`);
await assert.rejects(() => ingestStripeCheckoutCompleted(db, {
  event: rollback.event,
  secretKey: "unit-test-stripe-api-key",
  now: new Date(NOW_MS),
  verifyPayment,
}), /synthetic timeline failure/);
assert.equal((await one("SELECT count(*) AS count FROM website_sales_payment_receipts WHERE lead_id = ?", [rollback.leadId])).count, 0, "receipt insertion rolls back with the failed touch");
const rollbackLead = JSON.parse(String((await one("SELECT data FROM tenant_records WHERE id = ?", [rollback.leadId])).data));
assert.equal(rollbackLead.payment_plan_status, "awaiting_first_payment", "lead payment state rolls back with the failed touch");

console.log("website-sales-stripe-webhook: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
