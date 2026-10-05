import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import {
  applyStripeReceiptTerminalState,
  reconcileWebsiteSalesPayments,
} from "../lib/website-sales-payment-reconciliation";
import type { verifyStripeWebsitePayment } from "../lib/website-sales-payment";

const routeSource = readFileSync("app/api/cron/reconcile-website-sales-payments/route.ts", "utf8");
const cronRegistry = readFileSync("config/cron-registry.json", "utf8");
const driver = readFileSync(".github/workflows/cron-driver.yml", "utf8");
assert.match(routeSource, /checkCronAuth\(req\)/, "the unattended reconciler must require shared cron auth");
assert.match(routeSource, /getTursoClient\(\)/, "website-sale reconciliation must use Turso directly");
assert.doesNotMatch(routeSource, /Supabase|Postgres/i, "the reconciliation route must not introduce a second data plane");
assert.ok(cronRegistry.includes("/api/cron/reconcile-website-sales-payments"), "the cron registry must schedule the reconciler");
assert.ok(driver.includes("/api/cron/reconcile-website-sales-payments"), "the fallback cron driver must run it too");

async function main() {
const db = createClient({ url: "file::memory:?cache=shared" });
const NOW = new Date("2026-08-24T18:00:00.000Z");
const DEADLINE = "2026-09-20T00:00:00.000Z";

await db.executeMultiple(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE tenants (id TEXT PRIMARY KEY);
  CREATE TABLE tenant_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
    data TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
    type TEXT, channel TEXT, direction TEXT, agent_source TEXT,
    actor_user_id TEXT, subject TEXT, content TEXT, content_preview TEXT,
    metadata TEXT, created_at TEXT
  );
  CREATE TABLE website_deals (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','won','lost','refunded')),
    loss_reason TEXT, payment_reference TEXT, payment_provider TEXT,
    verified_payment_id TEXT, updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, lead_id), UNIQUE (tenant_id, id)
  );
  CREATE TABLE website_onboarding (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, deal_id TEXT NOT NULL,
    lead_id TEXT NOT NULL, fulfillment_owner_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('assets_needed','ready','in_build','client_review','launched','blocked')),
    intake TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, deal_id)
  );
  CREATE TABLE website_sales_commissions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, deal_id TEXT NOT NULL,
    rep_user_id TEXT NOT NULL, party_role TEXT NOT NULL,
    payment_reference TEXT NOT NULL, entry_type TEXT NOT NULL,
    comp_version INTEGER NOT NULL, basis_amount_cents INTEGER, rate_bps INTEGER,
    amount_cents INTEGER, notes TEXT NOT NULL DEFAULT '[]',
    collected_setup_amount REAL NOT NULL, rate REAL NOT NULL, amount REAL NOT NULL,
    status TEXT NOT NULL, clawback_deadline_at TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, payment_reference, entry_type, party_role)
  );
  CREATE TABLE website_sales_payment_receipts (
    id TEXT NOT NULL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','manual')),
    provider_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('verified','refunded','voided')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL CHECK (currency IN ('CAD','USD')),
    provider_status TEXT NOT NULL,
    verification_source TEXT NOT NULL CHECK (verification_source IN ('stripe_api','founder_manual')),
    verified_by TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, provider, provider_reference),
    UNIQUE (tenant_id, id)
  );
  CREATE INDEX website_sales_receipts_lead_idx
    ON website_sales_payment_receipts (tenant_id, lead_id, verified_at DESC);
`);

// Run the real migration. This proves the disputed state and reconciliation
// bookkeeping can actually be deployed, not merely represented in a mock.
await db.executeMultiple(
  readFileSync("database/turso/163_website_sales_reconciliation.turso.sql", "utf8"),
);
await db.executeMultiple(
  readFileSync("database/turso/164_website_sales_installment_ledger.turso.sql", "utf8"),
);

type SeedInput = {
  tenantId?: string;
  suffix: string;
  provider?: "stripe" | "manual";
  commissionStatus?: "accrued" | "approved" | "paid";
};

async function seed(input: SeedInput) {
  const tenantId = input.tenantId ?? "tenant-one";
  const leadId = `lead-${input.suffix}`;
  const receiptId = `receipt-${input.suffix}`;
  const dealId = `deal-${input.suffix}`;
  const paymentPlanId = `plan-${input.suffix}`;
  const paymentToken = `token-${input.suffix}`;
  const reference = `${input.provider === "manual" ? "manual" : "cs_live"}_${input.suffix}`;
  const provider = input.provider ?? "stripe";
  await db.execute({ sql: "INSERT OR IGNORE INTO tenants (id) VALUES (?)", args: [tenantId] });
  await db.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at)
          VALUES (?, ?, 'lead', ?, ?)`,
    args: [
      leadId,
      tenantId,
      JSON.stringify({
        stage: "in_build",
        assigned_to: "builder-one",
        proposal_payment_token: paymentToken,
        payment_plan_id: paymentPlanId,
        payment_verified: true,
        last_contacted_at: "2026-08-20T00:00:00.000Z",
      }),
      "2026-08-20T00:00:00.000Z",
    ],
  });
  await db.execute({
    sql: `INSERT INTO website_sales_payment_receipts
            (id, tenant_id, lead_id, provider, provider_reference, status,
             amount_cents, currency, provider_status, verification_source,
             verified_by, verified_at, payment_plan_id, payment_token,
             installment_kind, summary, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'verified', 400000, 'CAD', 'paid', ?,
                  'founder-one', '2026-08-23T00:00:00.000Z',
                  ?, ?, 'full', '{}', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    args: [
      receiptId,
      tenantId,
      leadId,
      provider,
      reference,
      provider === "stripe" ? "stripe_api" : "founder_manual",
      paymentPlanId,
      paymentToken,
    ],
  });
  await db.execute({
    sql: `INSERT INTO website_deals
            (id, tenant_id, lead_id, status, payment_reference, payment_provider,
             verified_payment_id, updated_at, payment_plan_id)
          VALUES (?, ?, ?, 'won', ?, ?, ?, '2026-08-23T00:00:00.000Z', ?)`,
    args: [dealId, tenantId, leadId, reference, provider, receiptId, paymentPlanId],
  });
  await db.execute({
    sql: `INSERT INTO website_onboarding
            (id, tenant_id, deal_id, lead_id, fulfillment_owner_id, status, intake, updated_at)
          VALUES (?, ?, ?, ?, 'builder-one', 'in_build', '{"brief":"ready"}',
                  '2026-08-23T00:00:00.000Z')`,
    args: [`onboarding-${input.suffix}`, tenantId, dealId, leadId],
  });
  await db.execute({
    sql: `INSERT INTO website_sales_commissions
            (id, tenant_id, deal_id, rep_user_id, party_role, payment_reference,
             entry_type, comp_version, basis_amount_cents, rate_bps, amount_cents,
             notes, collected_setup_amount, rate, amount, status,
             clawback_deadline_at, created_at, updated_at, payment_plan_id)
          VALUES (?, ?, ?, 'rep-one', 'opener', ?, 'accrual', 3, 400000,
                  2000, 80000, '[]', 4000, 0.2, 800, ?, ?,
                  '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z', ?)`,
    args: [
      `commission-${input.suffix}`,
      tenantId,
      dealId,
      reference,
      input.commissionStatus ?? "accrued",
      DEADLINE,
      paymentPlanId,
    ],
  });
  return { tenantId, leadId, receiptId, dealId, reference, paymentToken, paymentPlanId };
}

const refunded = await seed({ suffix: "refund" });
const partiallyRefunded = await seed({ suffix: "partial-refund" });
const disputed = await seed({ tenantId: "tenant-two", suffix: "dispute" });
const healthy = await seed({ suffix: "healthy" });
const failed = await seed({ suffix: "provider-failure" });
const rollback = await seed({ suffix: "rollback" });
// A deposit is verified before a deal, commission, or fulfillment row exists.
// The unattended worker must still detect a refund or the later balance could
// close against money that is no longer collected.
const refundedDeposit = await seed({ suffix: "deposit-refund" });
await db.batch([
  { sql: "DELETE FROM website_sales_commissions WHERE deal_id = ?", args: [refundedDeposit.dealId] },
  { sql: "DELETE FROM website_onboarding WHERE deal_id = ?", args: [refundedDeposit.dealId] },
  { sql: "DELETE FROM website_deals WHERE id = ?", args: [refundedDeposit.dealId] },
  {
    sql: "UPDATE website_sales_payment_receipts SET amount_cents = 100000, installment_kind = 'deposit' WHERE id = ?",
    args: [refundedDeposit.receiptId],
  },
  {
    sql: "UPDATE tenant_records SET data = ? WHERE id = ?",
    args: [
      JSON.stringify({
        stage: "proposal_sent",
        assigned_to: "founder-one",
        proposal_payment_token: refundedDeposit.paymentToken,
        payment_plan_id: refundedDeposit.paymentPlanId,
        payment_verified: true,
        payment_plan_status: "deposit_collected",
        quoted_setup_amount: 4000,
        collected_setup_amount: 1000,
        setup_balance_due: 3000,
        payment_due_amount: 3000,
        last_contacted_at: "2026-08-20T00:00:00.000Z",
      }),
      refundedDeposit.leadId,
    ],
  },
], "write");
const manual = await seed({ suffix: "manual", provider: "manual" });

await db.execute(`
  CREATE TRIGGER fail_rollback_interaction
  BEFORE INSERT ON lead_interactions
  WHEN NEW.lead_id = 'lead-rollback'
  BEGIN
    SELECT RAISE(ABORT, 'synthetic interaction failure');
  END
`);

const verifyPayment: typeof verifyStripeWebsitePayment = async (input) => {
  assert.equal(input.secretKey, input.reference.includes("dispute") ? "sk_tenant_two" : "sk_tenant_one");
  assert.equal(input.expectedTenantId, input.reference.includes("dispute") ? "tenant-two" : "tenant-one");
  assert.equal(input.expectedLeadId, `lead-${input.reference.replace(/^cs_live_/, "")}`);
  assert.equal(input.expectedPaymentToken, `token-${input.reference.replace(/^cs_live_/, "")}`);
  assert.equal(input.expectedPaymentPlanId, `plan-${input.reference.replace(/^cs_live_/, "")}`);
  if (input.reference.includes("partial-refund")) throw new Error("payment_partially_refunded:25000");
  if (input.reference.includes("refund")) throw new Error("payment_refunded");
  if (input.reference.includes("dispute")) throw new Error("payment_disputed");
  if (input.reference.includes("rollback")) throw new Error("payment_refunded");
  if (input.reference.includes("provider-failure")) throw new Error("stripe_verification_failed");
  return {
    provider: "stripe",
    reference: input.reference,
    amountCents: input.expectedAmountCents,
    currency: input.expectedCurrency,
    providerStatus: "paid",
    verificationSource: "stripe_api",
    summary: { livemode: true },
  };
};

const result = await reconcileWebsiteSalesPayments(db, {
  now: NOW,
  reconcileIntervalMinutes: 5,
  resolveStripeSecret: async (tenantId) => tenantId === "tenant-two" ? "sk_tenant_two" : "sk_tenant_one",
  verifyPayment,
});
assert.deepEqual(
  { scanned: result.scanned, healthy: result.healthy, refunded: result.refunded, disputed: result.disputed },
  { scanned: 7, healthy: 1, refunded: 2, disputed: 1 },
  "Stripe receipts are re-fetched; manual receipts never enter the unattended loop",
);
assert.equal(result.errors.length, 3, "partial refunds, provider failures, and atomic-write failures are returned per receipt, not hidden as success");
assert.ok(result.errors.some((row) => row.receiptId === partiallyRefunded.receiptId && row.error === "payment_partially_refunded:25000"));
assert.ok(result.errors.some((row) => row.receiptId === failed.receiptId && row.error === "stripe_verification_failed"));
assert.ok(result.errors.some((row) => row.receiptId === rollback.receiptId && row.error.includes("synthetic interaction failure")));
assert.equal(result.errors.some((row) => row.receiptId === refundedDeposit.receiptId), false);

async function one(sql: string, args: unknown[] = []) {
  const rs = await db.execute({ sql, args: args as Array<string | number | null> });
  assert.equal(rs.rows.length, 1, `expected one row: ${sql}`);
  return rs.rows[0] as unknown as Record<string, unknown>;
}

for (const terminal of [
  { fixture: refunded, state: "refunded" },
  { fixture: disputed, state: "disputed" },
] as const) {
  const receipt = await one(
    "SELECT status, terminal_reason, reconciliation_attempts FROM website_sales_payment_receipts WHERE id = ?",
    [terminal.fixture.receiptId],
  );
  assert.equal(receipt.status, terminal.state);
  assert.equal(receipt.terminal_reason, `stripe_${terminal.state}`);
  assert.equal(Number(receipt.reconciliation_attempts), 1);

  const deal = await one("SELECT status, loss_reason FROM website_deals WHERE id = ?", [terminal.fixture.dealId]);
  assert.deepEqual({ status: deal.status, loss_reason: deal.loss_reason }, {
    status: "refunded",
    loss_reason: `stripe_${terminal.state}`,
  });

  const onboarding = await one("SELECT status, intake FROM website_onboarding WHERE deal_id = ?", [terminal.fixture.dealId]);
  assert.equal(onboarding.status, "blocked");
  const paymentBlock = object(object(onboarding.intake).payment_block);
  assert.equal(paymentBlock.state, terminal.state);
  assert.equal(paymentBlock.previous_status, "in_build");

  const lead = object((await one("SELECT data FROM tenant_records WHERE id = ?", [terminal.fixture.leadId])).data);
  assert.equal(lead.payment_verified, false);
  assert.equal(lead.payment_status, terminal.state);
  assert.equal(lead.fulfillment_blocked, true);
  assert.equal(lead.last_contacted_at, NOW.toISOString(), "provider reversal is a canonical Last Touch");

  const interaction = await one("SELECT agent_source, actor_user_id, metadata FROM lead_interactions WHERE lead_id = ?", [terminal.fixture.leadId]);
  assert.equal(interaction.agent_source, "website_sales_payment_reconciler");
  assert.equal(interaction.actor_user_id, null);
  assert.equal(object(interaction.metadata).actor, "system", "timeline attribution is explicit, not impersonated as a rep");

  const ledger = await db.execute({
    sql: `SELECT entry_type, amount_cents, status FROM website_sales_commissions
          WHERE deal_id = ? ORDER BY entry_type`,
    args: [terminal.fixture.dealId],
  });
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows.find((row) => row.entry_type === "accrual")?.status, "offset");
  assert.equal(Number(ledger.rows.find((row) => row.entry_type === "refund_offset")?.amount_cents), -80000);
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const parsed = JSON.parse(String(value)) as unknown;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

const healthyReceipt = await one(
  "SELECT status, last_reconciled_at, last_reconciliation_error FROM website_sales_payment_receipts WHERE id = ?",
  [healthy.receiptId],
);
assert.equal(healthyReceipt.status, "verified");
assert.equal(healthyReceipt.last_reconciled_at, NOW.toISOString());
assert.equal(healthyReceipt.last_reconciliation_error, null);

const failedReceipt = await one(
  "SELECT status, last_reconciled_at, last_reconciliation_error FROM website_sales_payment_receipts WHERE id = ?",
  [failed.receiptId],
);
assert.equal(failedReceipt.status, "verified");
assert.equal(failedReceipt.last_reconciled_at, null, "a failed Stripe fetch remains due for retry");
assert.equal(failedReceipt.last_reconciliation_error, "stripe_verification_failed");

const partialReceipt = await one(
  "SELECT status, last_reconciled_at, last_reconciliation_error FROM website_sales_payment_receipts WHERE id = ?",
  [partiallyRefunded.receiptId],
);
assert.equal(partialReceipt.status, "verified", "a partial refund must not become a full terminal reversal");
assert.equal(partialReceipt.last_reconciled_at, null, "a partial refund remains open for operator settlement");
assert.equal(partialReceipt.last_reconciliation_error, "payment_partially_refunded:25000", "the exact refunded amount is preserved");
assert.equal((await one("SELECT status FROM website_deals WHERE id = ?", [partiallyRefunded.dealId])).status, "won");
assert.equal((await one("SELECT status FROM website_onboarding WHERE deal_id = ?", [partiallyRefunded.dealId])).status, "in_build");
assert.equal((await one("SELECT status FROM website_sales_commissions WHERE id = ?", ["commission-partial-refund"])).status, "accrued");
assert.equal(Number((await one(
  "SELECT COUNT(*) AS count FROM website_sales_commissions WHERE deal_id = ? AND entry_type = 'refund_offset'",
  [partiallyRefunded.dealId],
)).count), 0, "a partial refund cannot offset the full commission accrual");

const manualReceipt = await one(
  "SELECT reconciliation_attempts FROM website_sales_payment_receipts WHERE id = ?",
  [manual.receiptId],
);
assert.equal(Number(manualReceipt.reconciliation_attempts), 0, "founder-confirmed manual payments are never auto-reconciled");

const depositReceipt = await one(
  "SELECT status, terminal_reason, last_reconciled_at FROM website_sales_payment_receipts WHERE id = ?",
  [refundedDeposit.receiptId],
);
assert.equal(depositReceipt.status, "refunded", "a pre-close deposit refund is not skipped for lacking a deal row");
assert.equal(depositReceipt.terminal_reason, "stripe_refunded");
assert.equal(depositReceipt.last_reconciled_at, NOW.toISOString());
const depositLead = object((await one(
  "SELECT data FROM tenant_records WHERE id = ?",
  [refundedDeposit.leadId],
)).data);
assert.equal(depositLead.payment_verified, false);
assert.equal(depositLead.payment_plan_status, "payment_issue");
assert.equal(depositLead.collected_setup_amount, 0);
assert.equal(depositLead.setup_balance_due, 4000);
assert.equal(depositLead.last_contacted_at, NOW.toISOString(), "a deposit reversal updates canonical Last Touch");
assert.equal(Number((await one(
  "SELECT COUNT(*) AS count FROM website_deals WHERE lead_id = ?",
  [refundedDeposit.leadId],
)).count), 0, "deposit reconciliation cannot fabricate a closed deal");
assert.equal(Number((await one(
  "SELECT COUNT(*) AS count FROM website_sales_commissions WHERE deal_id = ?",
  [refundedDeposit.dealId],
)).count), 0, "deposit reconciliation cannot accrue commission");
assert.equal(Number((await one(
  "SELECT COUNT(*) AS count FROM website_onboarding WHERE lead_id = ?",
  [refundedDeposit.leadId],
)).count), 0, "deposit reconciliation cannot open fulfillment");

// The interaction insert failed after every preceding domain write. The write
// transaction must roll all of them back; only the separate attempt diagnostic
// is allowed to persist.
const rollbackReceipt = await one(
  "SELECT status, last_reconciliation_error FROM website_sales_payment_receipts WHERE id = ?",
  [rollback.receiptId],
);
assert.equal(rollbackReceipt.status, "verified");
assert.ok(String(rollbackReceipt.last_reconciliation_error).includes("synthetic interaction failure"));
assert.equal((await one("SELECT status FROM website_deals WHERE id = ?", [rollback.dealId])).status, "won");
assert.equal((await one("SELECT status FROM website_onboarding WHERE deal_id = ?", [rollback.dealId])).status, "in_build");
assert.equal((await one("SELECT status FROM website_sales_commissions WHERE id = ?", [`commission-rollback`])).status, "accrued");
assert.equal(object((await one("SELECT data FROM tenant_records WHERE id = ?", [rollback.leadId])).data).fulfillment_blocked, undefined);

const offsetsBeforeReplay = Number((await one(
  "SELECT COUNT(*) AS count FROM website_sales_commissions WHERE deal_id = ? AND entry_type = 'refund_offset'",
  [refunded.dealId],
)).count);
const replay = await applyStripeReceiptTerminalState(db, {
  ...refunded,
  amountCents: 400000,
  currency: "CAD",
  terminalState: "refunded",
  occurredAt: new Date(NOW.getTime() + 60_000).toISOString(),
});
assert.equal(replay.idempotent, true);
assert.equal(Number((await one(
  "SELECT COUNT(*) AS count FROM website_sales_commissions WHERE deal_id = ? AND entry_type = 'refund_offset'",
  [refunded.dealId],
)).count), offsetsBeforeReplay, "a replay cannot create a second clawback");

console.log(
  "website-sales-payment-reconciliation: OK — Turso atomically blocks fulfillment, offsets commissions, updates Last Touch/timeline, retries failures, and excludes manual receipts",
);
}

main().then(
  () => process.exit(0),
  (error) => { console.error(error); process.exit(1); },
);
