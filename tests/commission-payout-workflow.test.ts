import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import {
  transition_commission_entry,
  TURSO_RPC_SHIM,
} from "../lib/turso-rpc-shim";

const TENANT = "tenant-oasis";
const OTHER_TENANT = "tenant-other";
const REP = "rep-one";
const FOUNDER = "founder-one";
const OTHER_FOUNDER = "founder-two";
const client = createClient({ url: "file::memory:?cache=shared" });

async function row(id: string) {
  const result = await client.execute({
    sql: `SELECT * FROM website_sales_commissions WHERE id = ?`,
    args: [id],
  });
  assert.equal(result.rows.length, 1);
  return result.rows[0] as Record<string, unknown>;
}

async function eventCount(id: string) {
  const result = await client.execute({
    sql: `SELECT count(*) AS total
            FROM tenant_audit_log
           WHERE tenant_id = ? AND target_table = 'website_sales_commissions' AND target_id = ?`,
    args: [TENANT, id],
  });
  return Number(result.rows[0].total);
}

async function main() {
  await client.executeMultiple(`
    CREATE TABLE website_deals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      verified_payment_id TEXT,
      currency TEXT NOT NULL DEFAULT 'CAD'
    );
    CREATE TABLE website_sales_payment_receipts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      provider_reference TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );
    CREATE TABLE website_sales_commissions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      rep_user_id TEXT NOT NULL,
      party_role TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      basis_amount_cents INTEGER,
      rate_bps INTEGER,
      amount_cents INTEGER,
      collected_setup_amount REAL NOT NULL,
      rate REAL NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT CHECK (actor_user_id <> 'force_failure'),
      actor_email TEXT,
      action_type TEXT NOT NULL,
      target_table TEXT,
      target_id TEXT,
      before TEXT,
      after TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const migration = readFileSync("database/turso/162_commission_payout_workflow.turso.sql", "utf8");
  await client.executeMultiple(migration);
  await client.executeMultiple(
    readFileSync("database/turso/164_website_sales_installment_ledger.turso.sql", "utf8"),
  );
  assert(migration.includes("website_commission_status_transition_guard"));
  assert(migration.includes("website_commission_status_evidence_guard"));
  assert(migration.includes("website_commission_terminal_evidence_immutable"));

  const now = "2026-08-24T20:00:00.000Z";
  await client.batch([
    { sql: "INSERT INTO website_deals (id,tenant_id,lead_id,verified_payment_id,currency,payment_plan_id) VALUES ('deal-one', ?, 'lead-one', 'receipt-one', 'CAD', 'plan-one')", args: [TENANT] },
    { sql: "INSERT INTO website_deals (id,tenant_id,lead_id,verified_payment_id,currency,payment_plan_id) VALUES ('deal-two', ?, 'lead-two', 'receipt-two', 'CAD', 'plan-two')", args: [TENANT] },
    { sql: "INSERT INTO website_deals (id,tenant_id,lead_id,verified_payment_id,currency,payment_plan_id) VALUES ('deal-rollback', ?, 'lead-rollback', 'receipt-rollback', 'CAD', 'plan-rollback')", args: [TENANT] },
    { sql: "INSERT INTO website_deals (id,tenant_id,lead_id,verified_payment_id,currency,payment_plan_id) VALUES ('deal-other', ?, 'lead-other', 'receipt-other', 'CAD', 'plan-other')", args: [OTHER_TENANT] },
    { sql: "INSERT INTO website_sales_payment_receipts (id,tenant_id,lead_id,provider_reference,status,amount_cents,currency,verified_at,payment_plan_id,installment_kind) VALUES ('receipt-one', ?, 'lead-one', 'cs_live_one', 'verified', 400000, 'CAD', ?, 'plan-one', 'full')", args: [TENANT, now] },
    { sql: "INSERT INTO website_sales_payment_receipts (id,tenant_id,lead_id,provider_reference,status,amount_cents,currency,verified_at,payment_plan_id,installment_kind) VALUES ('receipt-two', ?, 'lead-two', 'cs_live_two', 'verified', 500000, 'CAD', ?, 'plan-two', 'full')", args: [TENANT, now] },
    { sql: "INSERT INTO website_sales_payment_receipts (id,tenant_id,lead_id,provider_reference,status,amount_cents,currency,verified_at,payment_plan_id,installment_kind) VALUES ('receipt-rollback', ?, 'lead-rollback', 'cs_live_rollback', 'verified', 300000, 'CAD', ?, 'plan-rollback', 'full')", args: [TENANT, now] },
    { sql: "INSERT INTO website_sales_payment_receipts (id,tenant_id,lead_id,provider_reference,status,amount_cents,currency,verified_at,payment_plan_id,installment_kind) VALUES ('receipt-other', ?, 'lead-other', 'cs_live_other', 'verified', 100000, 'CAD', ?, 'plan-other', 'full')", args: [OTHER_TENANT, now] },
    {
      sql: `INSERT INTO website_sales_commissions
              (id,tenant_id,deal_id,rep_user_id,party_role,payment_reference,payment_plan_id,entry_type,
               basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,
               status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accrued',?,?)`,
      args: ["commission-one", TENANT, "deal-one", REP, "opener", "cs_live_one", "plan-one", "accrual", 400000, 1000, 40000, 4000, 0.1, 400, now, now],
    },
    {
      sql: `INSERT INTO website_sales_commissions
              (id,tenant_id,deal_id,rep_user_id,party_role,payment_reference,payment_plan_id,entry_type,
               basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,
               status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accrued',?,?)`,
      args: ["commission-void", TENANT, "deal-two", "rep-two", "closer", "cs_live_two", "plan-two", "accrual", 500000, 2500, 125000, 5000, 0.25, 1250, now, now],
    },
    {
      sql: `INSERT INTO website_sales_commissions
              (id,tenant_id,deal_id,rep_user_id,party_role,payment_reference,payment_plan_id,entry_type,
               basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,
               status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accrued',?,?)`,
      args: ["commission-rollback", TENANT, "deal-rollback", "rep-three", "opener", "cs_live_rollback", "plan-rollback", "accrual", 300000, 1000, 30000, 3000, 0.1, 300, now, now],
    },
    {
      sql: `INSERT INTO website_sales_commissions
              (id,tenant_id,deal_id,rep_user_id,party_role,payment_reference,payment_plan_id,entry_type,
               basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,
               status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'offset',?,?)`,
      args: ["commission-offset", TENANT, "deal-one", REP, "opener", "refund_one", "plan-one", "refund_offset", -400000, 1000, -40000, -4000, 0.1, -400, now, now],
    },
    {
      sql: `INSERT INTO website_sales_commissions
              (id,tenant_id,deal_id,rep_user_id,party_role,payment_reference,payment_plan_id,entry_type,
               basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,
               status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accrued',?,?)`,
      args: ["commission-other", OTHER_TENANT, "deal-other", "rep-other", "opener", "cs_live_other", "plan-other", "accrual", 100000, 1000, 10000, 1000, 0.1, 100, now, now],
    },
  ], "write");

  assert.equal(
    TURSO_RPC_SHIM.transition_commission_entry,
    transition_commission_entry,
    "the payout transition must be reachable through the production Turso RPC registry",
  );

  const approved = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-one",
    p_actor_user_id: FOUNDER,
    p_action: "approve",
    p_request_id: "commission-request-approve",
    p_occurred_at: "2026-08-24T21:00:00.000Z",
  }) as Record<string, unknown>;
  assert.deepEqual(
    { ok: approved.ok, from: approved.previous_status, to: approved.current_status },
    { ok: true, from: "accrued", to: "approved" },
  );
  const approvedRow = await row("commission-one");
  assert.equal(approvedRow.status, "approved");
  assert.equal(approvedRow.approved_by, FOUNDER);
  assert.equal(approvedRow.approved_at, "2026-08-24T21:00:00.000Z");
  assert.equal(await eventCount("commission-one"), 1);
  const audit = await client.execute({
    sql: "SELECT actor_user_id, action_type, before, after, metadata FROM tenant_audit_log WHERE target_id = ?",
    args: ["commission-one"],
  });
  assert.equal(audit.rows[0].actor_user_id, FOUNDER);
  assert.equal(audit.rows[0].action_type, "website_sales.commission.approved");
  assert.equal(JSON.parse(String(audit.rows[0].before)).status, "accrued");
  assert.equal(JSON.parse(String(audit.rows[0].after)).status, "approved");
  assert.equal(JSON.parse(String(audit.rows[0].metadata)).lead_id, "lead-one");

  const replay = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-one",
    p_actor_user_id: FOUNDER,
    p_action: "approve",
    p_request_id: "commission-request-approve",
    p_occurred_at: "2026-08-24T21:01:00.000Z",
  }) as Record<string, unknown>;
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  assert.equal(await eventCount("commission-one"), 1, "a transport retry cannot duplicate the audit event");

  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-void",
      p_actor_user_id: "rep-two",
      p_action: "approve",
      p_request_id: "self-approve",
      p_occurred_at: "2026-08-24T21:02:00.000Z",
    }),
    /self_approval_forbidden/,
  );
  assert.equal((await row("commission-void")).status, "accrued");

  const paidConflict = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-void",
    p_actor_user_id: FOUNDER,
    p_action: "mark_paid",
    p_request_id: "pay-before-approve",
    p_occurred_at: "2026-08-24T21:03:00.000Z",
    p_payout_reference: "etransfer-before-approval",
  }) as Record<string, unknown>;
  assert.deepEqual(
    { ok: paidConflict.ok, error: paidConflict.error, current: paidConflict.current_status },
    { ok: false, error: "status_conflict", current: "accrued" },
  );

  await client.execute("UPDATE website_sales_payment_receipts SET status = 'voided' WHERE id = 'receipt-two'");
  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-void",
      p_actor_user_id: FOUNDER,
      p_action: "approve",
      p_request_id: "voided-receipt-cannot-approve",
      p_occurred_at: "2026-08-24T21:03:15.000Z",
    }),
    /verified_payment_required/,
    "a voided collection receipt can never be approved for payout",
  );
  await client.execute("UPDATE website_sales_payment_receipts SET status = 'verified' WHERE id = 'receipt-two'");

  const approvedForVoid = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-void",
    p_actor_user_id: FOUNDER,
    p_action: "approve",
    p_request_id: "approve-before-void",
    p_occurred_at: "2026-08-24T21:03:30.000Z",
  }) as Record<string, unknown>;
  assert.equal(approvedForVoid.current_status, "approved");

  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-one",
      p_actor_user_id: OTHER_FOUNDER,
      p_action: "mark_paid",
      p_request_id: "missing-payout-ref",
      p_occurred_at: "2026-08-24T21:04:00.000Z",
    }),
    /payout_reference_required/,
  );

  await client.execute("UPDATE website_sales_payment_receipts SET status = 'refunded' WHERE id = 'receipt-one'");
  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-one",
      p_actor_user_id: OTHER_FOUNDER,
      p_action: "mark_paid",
      p_request_id: "refunded-receipt-cannot-pay",
      p_occurred_at: "2026-08-24T21:04:30.000Z",
      p_payout_reference: "etransfer-must-not-land",
    }),
    /verified_payment_required/,
    "a receipt refunded after approval must fail closed before payout",
  );
  await client.execute("UPDATE website_sales_payment_receipts SET status = 'verified' WHERE id = 'receipt-one'");

  const paid = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-one",
    p_actor_user_id: OTHER_FOUNDER,
    p_action: "mark_paid",
    p_request_id: "commission-request-paid",
    p_occurred_at: "2026-08-24T21:05:00.000Z",
    p_payout_reference: "etransfer-2026-08-24-0042",
  }) as Record<string, unknown>;
  assert.equal(paid.current_status, "paid");
  const paidRow = await row("commission-one");
  assert.equal(paidRow.paid_by, OTHER_FOUNDER);
  assert.equal(paidRow.paid_at, "2026-08-24T21:05:00.000Z");
  assert.equal(paidRow.payout_reference, "etransfer-2026-08-24-0042");

  const paidRewrite = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-one",
    p_actor_user_id: FOUNDER,
    p_action: "mark_paid",
    p_request_id: "try-rewrite-paid",
    p_occurred_at: "2026-08-24T21:06:00.000Z",
    p_payout_reference: "different-reference",
  }) as Record<string, unknown>;
  assert.equal(paidRewrite.error, "status_conflict");
  assert.equal((await row("commission-one")).payout_reference, "etransfer-2026-08-24-0042");
  await assert.rejects(
    client.execute("UPDATE website_sales_commissions SET payout_reference = 'rewritten' WHERE id = 'commission-one'"),
    /terminal_commission_entry_immutable/,
    "a paid payout receipt is immutable even if a future route tries a direct update",
  );

  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-void",
      p_actor_user_id: FOUNDER,
      p_action: "void",
      p_request_id: "void-without-reason",
      p_occurred_at: "2026-08-24T21:07:00.000Z",
    }),
    /void_reason_required/,
  );
  const voided = await transition_commission_entry(client, {
    p_tenant_id: TENANT,
    p_commission_id: "commission-void",
    p_actor_user_id: FOUNDER,
    p_action: "void",
    p_request_id: "commission-request-void",
    p_occurred_at: "2026-08-24T21:08:00.000Z",
    p_void_reason: "Duplicate attribution confirmed against the signed deal record.",
  }) as Record<string, unknown>;
  assert.equal(voided.current_status, "voided");
  assert.equal(voided.previous_status, "approved", "an approved but unpaid accrual may be voided with an audit reason");
  const voidedRow = await row("commission-void");
  assert.equal(voidedRow.voided_by, FOUNDER);
  assert.equal(voidedRow.void_reason, "Duplicate attribution confirmed against the signed deal record.");

  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-offset",
      p_actor_user_id: FOUNDER,
      p_action: "approve",
      p_request_id: "mutate-refund-offset",
      p_occurred_at: "2026-08-24T21:09:00.000Z",
    }),
    /commission_entry_immutable/,
    "refund offsets are append-only accounting facts and cannot be repurposed as payouts",
  );

  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-other",
      p_actor_user_id: FOUNDER,
      p_action: "approve",
      p_request_id: "wrong-tenant",
      p_occurred_at: "2026-08-24T21:10:00.000Z",
    }),
    /commission_not_found_or_wrong_tenant/,
  );

  await assert.rejects(
    client.execute({
      sql: `UPDATE website_sales_commissions
               SET status = 'paid', paid_by = ?, paid_at = ?, payout_reference = ?
             WHERE id = 'commission-rollback'`,
      args: [FOUNDER, "2026-08-24T21:10:30.000Z", "direct-bypass"],
    }),
    /(invalid_commission_status_transition|commission_status_evidence_required)/,
    "Turso itself rejects a direct accrued-to-paid bypass",
  );
  await assert.rejects(
    transition_commission_entry(client, {
      p_tenant_id: TENANT,
      p_commission_id: "commission-rollback",
      p_actor_user_id: "force_failure",
      p_action: "approve",
      p_request_id: "force-audit-failure",
      p_occurred_at: "2026-08-24T21:11:00.000Z",
    }),
    /CHECK constraint failed/,
  );
  assert.equal(
    (await row("commission-rollback")).status,
    "accrued",
    "the commission CAS must roll back if its attributed audit event cannot be committed",
  );

  const route = readFileSync("app/api/website-sales/commissions/route.ts", "utf8");
  const page = readFileSync("app/commissions/page.tsx", "utf8");
  const clientUi = readFileSync("app/commissions/CommissionPortal.tsx", "utf8");
  const nav = readFileSync("lib/nav-config.ts", "utf8");
  assert(route.includes('.eq("tenant_id", session.tenantId)'), "every commission read stays tenant-scoped");
  assert(route.includes('.eq("rep_user_id", session.userId)'), "a rep can fetch only their own ledger rows");
  assert(route.includes("session.isTrueAdmin"), "payout mutations require a permanent founder/admin role");
  assert(route.includes('rpc("transition_commission_entry"'), "the API delegates money-state CAS to Turso");
  assert.equal(route.includes('.from("website_sales_commissions").update'), false, "the route cannot rewrite status directly");
  for (const fact of ["clientName", "paymentReference", "paymentStatus", "partyRole", "rateBps", "quotedAmountCents", "amountCents", "effectiveAt"]) {
    assert(route.includes(fact), `live commission hydration includes ${fact}`);
  }
  assert(page.includes("CommissionPortal") && !page.includes("ComingSoon"), "the commission page is live, not a placeholder");
  assert(
    nav.includes('{ group: "Leads", href: "/commissions", label: "Commissions", icon: "DollarSign" }'),
    "OASIS reps can discover their commission portal from the live sidebar",
  );
  for (const control of ["Approve accrual", "Mark as paid", "Void accrual", "Payout reference", "Reason for voiding"]) {
    assert(clientUi.includes(control), `the founder payout UI renders ${control}`);
  }
  assert(clientUi.includes("Full quote") && clientUi.includes("Verified collection"), "the portal compares the full quote with exact collected cash");

  await client.close();
  console.log("commission-payout-workflow: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
