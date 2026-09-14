/**
 * close_website_deal + refund_website_deal, exercised against a REAL libsql
 * database with the real migration-154 schema.
 *
 * The unit tests in website-sales-comp.test.ts prove the arithmetic. They
 * cannot prove that four rows actually land, that the uniqueness rule permits
 * them, that a replay is idempotent, or that a refund reverses the right ones —
 * all of which are properties of the SCHEMA plus the write path, and all of
 * which are how money goes wrong in practice.
 */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import {
  close_website_deal as closeWebsiteDealRpc,
  refund_website_deal,
  CLAWBACK_WINDOW_DAYS,
  TURSO_RPC_SHIM,
} from "../lib/turso-rpc-shim";
import {
  mayAdminSetWebsiteSalesStage,
  mayCreditAdminVerifiedCloser,
  mayRepRunWebsiteSalesDeal,
  resolveWebsiteSalesCloseParties,
} from "../lib/website-sales-workflow";

/* ── 0. REACHABILITY, before any behaviour. ────────────────────────────────
 * getServiceSupabase's rpc handler resolves by name against TURSO_RPC_SHIM.
 * A function that is exported but absent from that registry is unreachable in
 * production no matter how well it works.
 *
 * refund_website_deal shipped exactly that way: fully implemented, fully
 * tested, and impossible to call. The tests could not see it because they
 * import the function DIRECTLY — proving the logic while the feature did not
 * exist. Assert registration first, so behaviour tests can never again pass
 * for something nobody can invoke. */
for (const name of ["close_website_deal", "refund_website_deal"]) {
  assert.equal(
    typeof TURSO_RPC_SHIM[name],
    "function",
    `${name} must be registered in TURSO_RPC_SHIM — an unregistered RPC is dead code with a green test`,
  );
}

const TENANT = "t-oasis";
const FOUNDER = "u-cc";
const CLOSER = "u-closer";
const OPENER = "u-opener";
const BUILDER = "u-builder";
const SOLO_CLOSER = "u-solo-closer";
const CLOSER_BUILDER = "u-closer-builder";
const REPLAY_CLOSER = "u-replay-closer";
const REASSIGNED_CLOSER = "u-reassigned-closer";
const LEGACY_SELF_CLOSER = "u-legacy-self-closer";
const ADMIN_VERIFIED_SOLO = "44444444-4444-4444-8444-444444444444";
const ACCEL_OPENER = "u-accelerated-opener";
const ACCEL_CLOSER = "u-accelerated-closer";
const MANAGER = "u-manager";
const BUILDER_HANDOFF_CLOSER = "u-builder-handoff-closer";
const BUILD_BRIEF = {
  version: 1,
  status: "ready_for_pricing",
  businessGoal: "Generate qualified calls",
  targetAudience: "Local business customers",
  mustHavePages: "Home, services, contact",
  requiredFeatures: "Quote form and analytics",
  integrations: "GA4",
  contentAndAssets: "Logo ready; copy to draft",
  domainAndAccess: "Client owns domain",
  launchTiming: "Four weeks",
  decisionProcess: "Owner approves launch",
  transcriptNotes: "",
  capturedAt: "2026-08-24T00:00:00.000Z",
  capturedBy: FOUNDER,
};

const client = createClient({ url: "file::memory:?cache=shared" });

async function exec(sql: string) {
  for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^--/.test(s))) {
    await client.execute(stmt);
  }
}

async function setup() {
  await exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE user_profiles (
      auth_user_id TEXT,
      tenant_id TEXT,
      team_role TEXT,
      is_owner INTEGER DEFAULT 0,
      manager_user_id TEXT
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT,
      direction TEXT, agent_source TEXT, actor_user_id TEXT, subject TEXT,
      content TEXT, content_preview TEXT, metadata TEXT, created_at TEXT
    );
    CREATE UNIQUE INDEX website_sales_interaction_request_uidx
      ON lead_interactions (tenant_id, json_extract(metadata, '$.request_id'))
      WHERE agent_source = 'website_sales_pipeline'
        AND json_extract(metadata, '$.request_id') IS NOT NULL;
    CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT, statements INTEGER);
  `);
  // The real v3 tables, straight from the migration file — no hand-rewritten
  // copy that could drift from what production actually has.
  const migration = readFileSync("database/turso/154_commission_ledger_v3.turso.sql", "utf8");
  const created = migration
    .split(/;\s*\n/)
    .filter((s) => /^\s*CREATE TABLE "website_(deals|sales_commissions|onboarding)"/m.test(s));
  for (const stmt of created) await client.execute(stmt);
  const paymentMigration = readFileSync("database/turso/160_website_sales_payment_receipts.turso.sql", "utf8");
  const receiptTable = paymentMigration.match(
    /CREATE TABLE IF NOT EXISTS "website_sales_payment_receipts"[\s\S]*?\n\);/,
  )?.[0];
  assert.ok(receiptTable, "migration 160 must define the verified-payment receipt table");
  await client.execute(receiptTable);
  for (const match of paymentMigration.matchAll(/ALTER TABLE "website_deals" ADD COLUMN[\s\S]*?;/g)) {
    await client.execute(match[0].slice(0, -1));
  }
  await client.executeMultiple(
    readFileSync("database/turso/164_website_sales_installment_ledger.turso.sql", "utf8"),
  );

  await client.execute({ sql: `INSERT INTO tenants VALUES (?, 'oasis-webdev')`, args: [TENANT] });
  for (const [u, role] of [[FOUNDER, "owner"], [CLOSER, "closer"], [OPENER, "opener"], [BUILDER, "builder"], [SOLO_CLOSER, "closer"], [CLOSER_BUILDER, "builder"], [REPLAY_CLOSER, "closer"], [REASSIGNED_CLOSER, "closer"], [LEGACY_SELF_CLOSER, "closer"], [ADMIN_VERIFIED_SOLO, "builder"], [ACCEL_OPENER, "opener"], [ACCEL_CLOSER, "closer"], [MANAGER, "manager"], [BUILDER_HANDOFF_CLOSER, "closer"]] as const) {
    await client.execute({
      sql: `INSERT INTO user_profiles (auth_user_id, tenant_id, team_role, is_owner) VALUES (?,?,?,?)`,
      args: [u, TENANT, role, u === FOUNDER ? 1 : 0],
    });
  }
}

async function seedLead(
  id: string,
  assignedTo: string,
  attributedRepUserId?: string,
  stage = "qualified",
  leadSourceTrack: "company" | "self" = "company",
  sourcedByUserId: string | null | undefined = leadSourceTrack === "self" ? assignedTo : undefined,
) {
  await client.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?,?, 'lead', ?)`,
    args: [
      id,
      TENANT,
      JSON.stringify({
        assigned_to: assignedTo,
        stage,
        lead_source_track: leadSourceTrack,
        build_brief: BUILD_BRIEF,
        ...(attributedRepUserId ? { attributed_rep_user_id: attributedRepUserId } : {}),
        ...(typeof sourcedByUserId === "string" && sourcedByUserId.trim()
          ? { sourced_by_user_id: sourcedByUserId }
          : {}),
      }),
    ],
  });
}

async function close_website_deal(db: typeof client, args: Record<string, unknown>) {
  const reference = String(args.p_payment_reference);
  const paymentPlanId = typeof args.p_payment_plan_id === "string"
    ? args.p_payment_plan_id
    : `plan-${reference}`;
  const receiptId = `receipt-${reference}`;
  const collectedAmount = Number(args.p_collected_amount ?? args.p_setup_amount);
  await db.execute({
    sql: `INSERT OR IGNORE INTO website_sales_payment_receipts
            (id, tenant_id, lead_id, provider, provider_reference, status,
             amount_cents, currency, provider_status, verification_source,
             verified_by, verified_at, payment_plan_id, payment_token,
             installment_kind, summary)
          VALUES (?, ?, ?, 'manual', ?, 'verified', ?, ?, 'founder_confirmed_collected',
                  'founder_manual', ?, ?, ?, ?, 'full', '{}')`,
    args: [
      receiptId,
      String(args.p_tenant_id),
      String(args.p_lead_id),
      reference,
      Math.round(collectedAmount * 100),
      String(args.p_currency),
      FOUNDER,
      new Date().toISOString(),
      paymentPlanId,
      `token-${reference}`,
    ],
  });
  return closeWebsiteDealRpc(db, {
    ...args,
    p_payment_provider: "manual",
    p_verified_payment_id: receiptId,
    p_payment_plan_id: paymentPlanId,
    p_expected_stage: args.p_expected_stage ?? "qualified",
    p_expected_owner_id: args.p_expected_owner_id ?? args.p_rep_user_id,
    p_request_id: args.p_request_id ?? `close-${reference}`,
    p_occurred_at: args.p_occurred_at ?? new Date().toISOString(),
    p_actor_user_id: args.p_actor_user_id ?? FOUNDER,
    p_interaction_subject: "Payment verified and builder assigned",
    p_interaction_content: `Verified ${reference}`,
    p_interaction_metadata: {},
    p_lead_patch: {
      closed_by_user_id: args.p_rep_user_id,
      payment_verified_by: FOUNDER,
      ...(args.p_builder_user_id
        ? { assigned_to: args.p_builder_user_id, fulfillment_owner_id: args.p_builder_user_id }
        : {}),
    },
  });
}

const lines = (r: unknown) => (r as { payout_lines: Array<{ role: string; user_id: string; amount_cents: number; rate_bps: number }> }).payout_lines;
const roleOf = (r: unknown, role: string) => lines(r).find((l) => l.role === role);

async function main() {
  await setup();

  await seedLead("lead-unverified", CLOSER);
  await assert.rejects(
    closeWebsiteDealRpc(client, {
      p_tenant_id: TENANT,
      p_lead_id: "lead-unverified",
      p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER,
      p_package_id: "starter",
      p_currency: "CAD",
      p_setup_amount: 500,
      p_monthly_amount: 0,
      p_payment_reference: "pay-unverified",
      p_payment_provider: "manual",
      p_verified_payment_id: "missing-receipt",
      p_payment_plan_id: "plan-pay-unverified",
      p_closed_by_rep: true,
      p_expected_stage: "qualified",
      p_expected_owner_id: CLOSER,
      p_request_id: "close-pay-unverified",
      p_occurred_at: new Date().toISOString(),
      p_actor_user_id: FOUNDER,
      p_interaction_subject: "Payment verified",
      p_interaction_content: "Payment verified",
      p_interaction_metadata: {},
      p_lead_patch: {},
    }),
    /verified_payment_required/,
    "the ledger must reject a close that has no verified cash receipt",
  );

  /* ── 1. A $500 deal must BOOK. Migration 147 threw here. ─────────────────*/
  await seedLead("lead-500", CLOSER, undefined, "qualified", "self");
  const small = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-500", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 0, p_payment_reference: "pay-500",
    p_closed_by_rep: true, p_lead_source_track: "self",
  });
  assert.ok(small, "a $500 deal must close — 147 raised 'collected setup below commission floor' here");
  assert.equal(lines(small).length, 1, "one find-and-close line is written");
  assert.equal(roleOf(small, "full_stack")?.user_id, CLOSER);
  assert.equal(roleOf(small, "full_stack")?.amount_cents, 17_500, "find + close pays 35% of $500");

  await seedLead("lead-500-split", CLOSER, OPENER, "qualified", "company");
  assert.equal(
    mayRepRunWebsiteSalesDeal({ actorUserId: OPENER, assignedTo: CLOSER, auditHostUserId: CLOSER }),
    false,
    "the frozen opener cannot execute the close after handoff",
  );
  assert.equal(
    mayRepRunWebsiteSalesDeal({ actorUserId: CLOSER, assignedTo: CLOSER, auditHostUserId: CLOSER }),
    true,
    "the assigned closer can execute the close",
  );
  const smallSplit = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-500-split", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-500-split",
    p_closed_by_rep: true, p_opener_user_id: OPENER, p_lead_source_track: "company",
  });
  assert.deepEqual(
    lines(smallSplit).map((entry) => entry.role).sort(),
    ["closer", "opener"],
    "$500 supports distinct opener and closer accruals",
  );
  assert.equal(roleOf(smallSplit, "opener")?.amount_cents, 7_500, "opening pays 15% of $500");
  assert.equal(roleOf(smallSplit, "closer")?.amount_cents, 12_500, "closing pays 25% of $500");
  const smallSplitSummary = smallSplit as {
    commission_id: string;
    commission_amount: number;
  };
  const primaryCommission = await client.execute({
    sql: "SELECT party_role, amount_cents FROM website_sales_commissions WHERE id = ?",
    args: [smallSplitSummary.commission_id],
  });
  assert.equal(primaryCommission.rows[0].party_role, "closer");
  assert.equal(
    Number(primaryCommission.rows[0].amount_cents),
    smallSplitSummary.commission_amount * 100,
    "commission_id and commission_amount describe the same primary ledger row",
  );

  for (const collision of [
    { type: "audit_completed", action: "complete_audit" },
    { type: "payment_received", action: "record_payment" },
  ]) {
    const leadId = `lead-cross-action-${collision.type}`;
    const requestId = `request-cross-action-${collision.type}`;
    await seedLead(leadId, CLOSER);
    await client.execute({
      sql: `INSERT INTO lead_interactions
              (id, tenant_id, lead_id, type, channel, direction, agent_source,
               actor_user_id, subject, content, content_preview, metadata, created_at)
            VALUES (?, ?, ?, ?, 'system', 'internal', 'website_sales_pipeline',
                    ?, 'Existing lifecycle action', '', '', ?, ?)`,
      args: [
        `interaction-${collision.type}`,
        TENANT,
        leadId,
        collision.type,
        FOUNDER,
        JSON.stringify({ request_id: requestId, action: collision.action }),
        new Date().toISOString(),
      ],
    });
    await assert.rejects(
      close_website_deal(client, {
        p_tenant_id: TENANT,
        p_lead_id: leadId,
        p_rep_user_id: CLOSER,
        p_founder_user_id: FOUNDER,
        p_package_id: "starter",
        p_currency: "CAD",
        p_setup_amount: 500,
        p_monthly_amount: 150,
        p_payment_reference: `pay-${collision.type}`,
        p_closed_by_rep: true,
        p_lead_source_track: "company",
        p_request_id: requestId,
      }),
      /request_id_reused_for_different_action/,
      `${collision.type} cannot be mistaken for an idempotent deal close`,
    );
    const untouchedLead = await client.execute({
      sql: "SELECT json_extract(data, '$.stage') AS stage FROM tenant_records WHERE id = ?",
      args: [leadId],
    });
    assert.equal(untouchedLead.rows[0].stage, "qualified");
    for (const [table, predicate, value] of [
      ["website_deals", "lead_id", leadId],
      ["website_sales_commissions", "payment_reference", `pay-${collision.type}`],
      ["website_onboarding", "lead_id", leadId],
    ] as const) {
      const count = await client.execute({
        sql: `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ? AND ${predicate} = ?`,
        args: [TENANT, value],
      });
      assert.equal(Number(count.rows[0].c), 0, `${collision.type} leaves ${table} untouched`);
    }
  }

  // A builder is also an explicitly supported selling seat in the OASIS
  // pipeline. If they source/open the relationship and then hand it to a
  // separate closer, their frozen opener credit must survive the atomic close
  // just like every other opener seat.
  await seedLead("lead-builder-opener", BUILDER_HANDOFF_CLOSER, BUILDER, "qualified", "company");
  const builderOpenedSplit = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-builder-opener", p_rep_user_id: BUILDER_HANDOFF_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-builder-opener",
    p_closed_by_rep: true, p_opener_user_id: BUILDER, p_builder_user_id: CLOSER_BUILDER,
    p_lead_source_track: "company",
  });
  assert.equal(roleOf(builderOpenedSplit, "opener")?.user_id, BUILDER);
  assert.equal(
    roleOf(builderOpenedSplit, "opener")?.amount_cents,
    7_500,
    "a selling builder who opens then hands off receives the frozen 15% opener accrual",
  );
  assert.equal(roleOf(builderOpenedSplit, "closer")?.amount_cents, 12_500);

  await seedLead("lead-company-solo", SOLO_CLOSER, undefined, "qualified", "company");
  const companySolo = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-company-solo", p_rep_user_id: SOLO_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-company-solo",
    p_closed_by_rep: true, p_lead_source_track: "company",
  });
  assert.deepEqual(
    lines(companySolo).map((entry) => entry.role),
    ["closer"],
    "a sole closer on a company-fed lead is ledgered as a closer, not as full_stack",
  );
  assert.equal(roleOf(companySolo, "closer")?.amount_cents, 12_500, "company-fed sole close pays 25% of $500");

  /* `self` is provenance, not a transferable coupon. Reassignment must not
   * let a new closer inherit the source rep's 35%; legacy self rows with no
   * source identity fail closed the same way. The effective payout track is
   * frozen on the deal so retries reconstruct the exact first result. */
  await seedLead("lead-reassigned-self", REASSIGNED_CLOSER, undefined, "qualified", "self", OPENER);
  const reassignedSelfClose = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-reassigned-self", p_rep_user_id: REASSIGNED_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-reassigned-self",
    p_closed_by_rep: true, p_lead_source_track: "self",
  }) as Record<string, unknown>;
  assert.deepEqual(lines(reassignedSelfClose).map((line) => line.role), ["closer"]);
  assert.equal(roleOf(reassignedSelfClose, "closer")?.rate_bps, 2_500, "a reassigned closer gets 25%, not inherited finding credit");
  const reassignedDeal = await client.execute({
    sql: `SELECT lead_source_track FROM website_deals WHERE tenant_id = ? AND payment_reference = ?`,
    args: [TENANT, "pay-reassigned-self"],
  });
  assert.equal(
    String(reassignedDeal.rows[0].lead_source_track),
    "self",
    "the lead's real source track stays frozen while the persisted closer role reconstructs the 25% payout",
  );
  const reassignedReplay = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-reassigned-self", p_rep_user_id: REASSIGNED_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-reassigned-self",
    p_closed_by_rep: true, p_lead_source_track: "self",
  }) as Record<string, unknown>;
  assert.deepEqual({ ...reassignedReplay, idempotent: false }, reassignedSelfClose, "reassigned-close replay preserves the frozen 25% result");

  await seedLead("lead-legacy-self", LEGACY_SELF_CLOSER, undefined, "qualified", "self", null);
  const legacySelfClose = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-legacy-self", p_rep_user_id: LEGACY_SELF_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-legacy-self",
    p_closed_by_rep: true, p_lead_source_track: "self",
  });
  assert.deepEqual(lines(legacySelfClose).map((line) => line.role), ["closer"]);
  assert.equal(roleOf(legacySelfClose, "closer")?.rate_bps, 2_500, "legacy self lead without source identity fails closed to 25%");

  const adminVerifiedSolo = resolveWebsiteSalesCloseParties({
    assignedTo: ADMIN_VERIFIED_SOLO,
    attributedRepUserId: ADMIN_VERIFIED_SOLO,
    actorUserId: FOUNDER,
    isTrueAdmin: true,
    trustedCloserUserId: ADMIN_VERIFIED_SOLO,
  });
  assert.deepEqual(adminVerifiedSolo, {
    closerUserId: ADMIN_VERIFIED_SOLO,
    openerUserId: null,
    closedByRep: true,
  });
  assert.equal(
    mayCreditAdminVerifiedCloser({
      candidateUserId: ADMIN_VERIFIED_SOLO,
      frozenOpenerUserId: ADMIN_VERIFIED_SOLO,
      auditHostUserId: ADMIN_VERIFIED_SOLO,
      assignedTo: ADMIN_VERIFIED_SOLO,
      recordedAuditHostRole: "builder",
      liveTeamRole: "builder",
      isOwner: false,
    }),
    true,
    "the founder verifier recognizes the canonical selling-builder role",
  );
  assert.ok(adminVerifiedSolo);
  await seedLead("lead-admin-solo-company", ADMIN_VERIFIED_SOLO, ADMIN_VERIFIED_SOLO, "qualified", "company");
  const adminSoloCompany = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-admin-solo-company", p_rep_user_id: adminVerifiedSolo.closerUserId,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-admin-solo-company",
    p_closed_by_rep: adminVerifiedSolo.closedByRep, p_opener_user_id: adminVerifiedSolo.openerUserId,
    p_lead_source_track: "company",
  });
  assert.deepEqual(lines(adminSoloCompany).map((entry) => entry.role), ["closer"]);
  assert.equal(roleOf(adminSoloCompany, "closer")?.rate_bps, 2_500, "admin verification preserves a selling builder's company close at 25%");

  await seedLead("lead-admin-solo-self", ADMIN_VERIFIED_SOLO, ADMIN_VERIFIED_SOLO, "qualified", "self");
  const adminSoloSelf = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-admin-solo-self", p_rep_user_id: adminVerifiedSolo.closerUserId,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-admin-solo-self",
    p_closed_by_rep: adminVerifiedSolo.closedByRep, p_opener_user_id: adminVerifiedSolo.openerUserId,
    p_lead_source_track: "self",
  });
  assert.deepEqual(lines(adminSoloSelf).map((entry) => entry.role), ["full_stack"]);
  assert.equal(roleOf(adminSoloSelf, "full_stack")?.rate_bps, 3_500, "admin verification preserves a selling builder's self source+close at 35%");

  await seedLead("lead-company-close-build", CLOSER_BUILDER, undefined, "qualified", "company");
  const companyCloseAndBuild = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-company-close-build", p_rep_user_id: CLOSER_BUILDER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-company-close-build",
    p_closed_by_rep: true, p_builder_user_id: CLOSER_BUILDER, p_lead_source_track: "company",
  });
  assert.deepEqual(
    lines(companyCloseAndBuild).map((entry) => entry.role).sort(),
    ["builder", "closer"],
    "a company-fed closer who also builds keeps the distinct flat builder accrual",
  );
  assert.equal(roleOf(companyCloseAndBuild, "closer")?.amount_cents, 12_500, "same-person company close stays at 25%");
  assert.equal(roleOf(companyCloseAndBuild, "builder")?.amount_cents, 15_000, "Starter builder fee remains $150");

  const smallState = await client.execute({
    sql: `SELECT json_extract(data, '$.stage') AS stage FROM tenant_records WHERE id = ?`,
    args: ["lead-500"],
  });
  assert.equal(String(smallState.rows[0].stage), "won", "verified full payment lands the lead in Won");
  const smallAccrual = await client.execute({
    sql: `SELECT status FROM website_sales_commissions WHERE payment_reference = ?`,
    args: ["pay-500"],
  });
  assert.ok(smallAccrual.rows.every((row) => row.status === "accrued"), "Won creates accrued, not auto-paid, rows");

  /* Once payment has created a Won deal and accrual, the generic admin stage
   * repair path must not make the lead look lost while leaving that paid fact
   * and payout ledger alive. This mirrors the route's guarded write. */
  const smallLedgerCountBeforeStageRepair = Number(smallAccrual.rows.length);
  if (mayAdminSetWebsiteSalesStage("won", "lost")) {
    await client.execute({
      sql: `UPDATE tenant_records SET data = json_set(data, '$.stage', 'lost') WHERE id = ? AND tenant_id = ?`,
      args: ["lead-500", TENANT],
    });
  }
  const protectedWonState = await client.execute({
    sql: `SELECT json_extract(data, '$.stage') AS stage,
                 (SELECT COUNT(*) FROM website_sales_commissions WHERE payment_reference = ?) AS ledger_count
          FROM tenant_records WHERE id = ? AND tenant_id = ?`,
    args: ["pay-500", "lead-500", TENANT],
  });
  assert.deepEqual(
    {
      stage: String(protectedWonState.rows[0].stage),
      ledgerCount: Number(protectedWonState.rows[0].ledger_count),
    },
    { stage: "won", ledgerCount: smallLedgerCountBeforeStageRepair },
    "Won→lost generic repair is refused and its verified-payment ledger remains coupled to Won",
  );

  await seedLead("lead-source-mismatch", CLOSER, undefined, "qualified", "company");
  await assert.rejects(
    close_website_deal(client, {
      p_tenant_id: TENANT, p_lead_id: "lead-source-mismatch", p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
      p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-source-mismatch",
      p_closed_by_rep: true, p_lead_source_track: "self",
    }),
    /lead_source_track_does_not_match_frozen_lead/,
    "an RPC caller cannot upgrade a company lead to the self-sourced payout track",
  );

  /* ── 2. FOUR PAYEES ON ONE PAYMENT — the point of migration 154. ─────────*/
  await client.execute({
    sql: "UPDATE user_profiles SET manager_user_id = ? WHERE tenant_id = ? AND auth_user_id = ?",
    args: [CLOSER, TENANT, CLOSER],
  });
  await seedLead("lead-manager-self", CLOSER, OPENER);
  await assert.rejects(
    close_website_deal(client, {
      p_tenant_id: TENANT, p_lead_id: "lead-manager-self", p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
      p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-manager-self",
      p_closed_by_rep: true, p_opener_user_id: OPENER, p_manager_user_id: CLOSER,
      p_lead_source_track: "company",
    }),
    /manager_cannot_manage_self/,
    "a closer cannot mint an override to themselves",
  );
  await client.execute({
    sql: "UPDATE user_profiles SET manager_user_id = ? WHERE tenant_id = ? AND auth_user_id = ?",
    args: [BUILDER, TENANT, CLOSER],
  });
  await seedLead("lead-manager-invalid-role", CLOSER, OPENER);
  await assert.rejects(
    close_website_deal(client, {
      p_tenant_id: TENANT, p_lead_id: "lead-manager-invalid-role", p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
      p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-manager-invalid-role",
      p_closed_by_rep: true, p_opener_user_id: OPENER, p_manager_user_id: BUILDER,
      p_lead_source_track: "company",
    }),
    /manager_not_authorized_for_tenant/,
    "a non-manager profile cannot receive the override",
  );
  await client.execute({
    sql: "UPDATE user_profiles SET manager_user_id = ? WHERE tenant_id = ? AND auth_user_id = ?",
    args: ["foreign-manager", TENANT, CLOSER],
  });
  await seedLead("lead-manager-foreign", CLOSER, OPENER);
  await assert.rejects(
    close_website_deal(client, {
      p_tenant_id: TENANT, p_lead_id: "lead-manager-foreign", p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
      p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-manager-foreign",
      p_closed_by_rep: true, p_opener_user_id: OPENER, p_manager_user_id: "foreign-manager",
      p_lead_source_track: "company",
    }),
    /manager_not_authorized_for_tenant/,
    "a manager relationship cannot cross tenant scope",
  );
  await client.execute({
    sql: "UPDATE user_profiles SET manager_user_id = ? WHERE tenant_id = ? AND auth_user_id = ?",
    args: [MANAGER, TENANT, CLOSER],
  });

  await seedLead("lead-8k", CLOSER, OPENER);
  const big = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-8k", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
    p_setup_amount: 8000, p_monthly_amount: 500, p_payment_reference: "pay-8k",
    p_closed_by_rep: true, p_opener_user_id: OPENER, p_builder_user_id: BUILDER,
    p_manager_user_id: MANAGER, p_lead_source_track: "company",
  });
  const roles = lines(big).map((l) => l.role).sort();
  assert.deepEqual(roles, ["builder", "closer", "manager", "opener"], "all four parties are paid from one payment");
  assert.equal(roleOf(big, "opener")?.amount_cents, 120_000, "opener 15% of $8,000");
  assert.equal(
    roleOf(big, "closer")?.amount_cents,
    200_000,
    "closer remains at the 25% base while trailing collected is below $10,000",
  );
  assert.equal(roleOf(big, "builder")?.amount_cents, 100_000, "builder flat $1,000 for authority");
  assert.ok((roleOf(big, "manager")?.amount_cents ?? 0) > 0, "the manager earns an override");

  /* Founder closes after one opener books the meeting: opener 15%, never the
   * 35% full-stack line. This is the ordinary OASIS handoff, not an edge case. */
  await seedLead("lead-founder-close", OPENER, OPENER);
  const founderClose = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-founder-close", p_rep_user_id: OPENER,
    p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
    p_setup_amount: 8000, p_monthly_amount: 500, p_payment_reference: "pay-founder-close",
    p_closed_by_rep: false, p_lead_source_track: "company",
  });
  assert.deepEqual(lines(founderClose).map((line) => line.role), ["opener"]);
  assert.equal(roleOf(founderClose, "opener")?.amount_cents, 120_000, "founder close pays opener 15%");

  /* Accelerators follow each contractor's OWN trailing collected revenue.
   * Opener volume must not disappear just because a founder or a different rep
   * closed the next deal. Seed the opener to the exact $10k boundary, then
   * exercise both handoff paths. */
  await seedLead("lead-opener-volume-prior", ACCEL_OPENER, ACCEL_OPENER);
  await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-opener-volume-prior", p_rep_user_id: ACCEL_OPENER,
    p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
    p_setup_amount: 10_000, p_monthly_amount: 500, p_payment_reference: "pay-opener-volume-prior",
    p_closed_by_rep: false, p_lead_source_track: "company",
  });
  await seedLead("lead-opener-founder-accelerated", ACCEL_OPENER, ACCEL_OPENER);
  const acceleratedFounderHandoff = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-opener-founder-accelerated", p_rep_user_id: ACCEL_OPENER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-opener-founder-accelerated",
    p_closed_by_rep: false, p_lead_source_track: "company",
  });
  assert.equal(roleOf(acceleratedFounderHandoff, "opener")?.rate_bps, 1_700, "founder-close opener gets the +2% accelerator at $10k");
  assert.equal(roleOf(acceleratedFounderHandoff, "opener")?.amount_cents, 8_500);

  await seedLead("lead-opener-split-accelerated", ACCEL_CLOSER, ACCEL_OPENER);
  const acceleratedSplitHandoff = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-opener-split-accelerated", p_rep_user_id: ACCEL_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-opener-split-accelerated",
    p_closed_by_rep: true, p_opener_user_id: ACCEL_OPENER, p_lead_source_track: "company",
  });
  assert.equal(roleOf(acceleratedSplitHandoff, "opener")?.rate_bps, 1_700, "separate opener keeps their own +2% accelerator");
  assert.equal(roleOf(acceleratedSplitHandoff, "opener")?.amount_cents, 8_500);
  assert.equal(roleOf(acceleratedSplitHandoff, "closer")?.rate_bps, 2_500, "closer with no prior volume remains at 25%");

  const stored = await client.execute({
    sql: `SELECT party_role, amount_cents, comp_version, clawback_deadline_at FROM website_sales_commissions
          WHERE payment_reference = 'pay-8k' ORDER BY party_role`,
    args: [],
  });
  assert.equal(stored.rows.length, 4, "four ledger ROWS exist — not just four numbers in a response");
  assert.ok(stored.rows.every((r) => Number(r.comp_version) === 4), "every row records comp v4");
  assert.ok(stored.rows.every((r) => r.clawback_deadline_at), "every row carries a clawback deadline");
  const oasisKeeps = 800_000 - lines(big).reduce((s, l) => s + l.amount_cents, 0);
  assert.ok(oasisKeeps > 0, `OASIS must retain something after four payees (kept ${oasisKeeps}c)`);

  /* ── 3. IDEMPOTENCY. A replay must not pay anyone twice. ─────────────────*/
  const replay = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-8k", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
    p_setup_amount: 8000, p_monthly_amount: 500, p_payment_reference: "pay-8k",
    p_closed_by_rep: true, p_opener_user_id: OPENER, p_builder_user_id: BUILDER,
    p_manager_user_id: MANAGER, p_lead_source_track: "company",
  });
  assert.ok(replay, "an identical replay succeeds rather than erroring");
  const afterReplay = await client.execute(`SELECT COUNT(*) c FROM website_sales_commissions WHERE payment_reference = 'pay-8k'`);
  assert.equal(
    Number(afterReplay.rows[0].c), 4,
    "STILL four rows after a replay — a double-pay is the worst failure this ledger can have",
  );

  /* A replay must return the frozen rows, not re-rate the deal against today's
   * trailing volume. The first $500 close sees $9,500 and earns no accelerator;
   * that close itself lifts trailing collected to exactly $10,000. Recomputing
   * on replay would incorrectly return 27% even though the stored row is 25%. */
  await seedLead("lead-replay-prior", REPLAY_CLOSER);
  await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-replay-prior", p_rep_user_id: REPLAY_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
    p_setup_amount: 9500, p_monthly_amount: 500, p_payment_reference: "pay-replay-prior",
    p_closed_by_rep: true, p_lead_source_track: "company",
  });
  await seedLead("lead-replay-boundary", REPLAY_CLOSER);
  const firstBoundaryClose = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-replay-boundary", p_rep_user_id: REPLAY_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-replay-boundary",
    p_closed_by_rep: true, p_lead_source_track: "company",
  }) as Record<string, unknown>;
  assert.equal(roleOf(firstBoundaryClose, "closer")?.amount_cents, 12_500, "first close freezes 25% below the band");
  const replayBoundaryClose = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-replay-boundary", p_rep_user_id: REPLAY_CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 150, p_payment_reference: "pay-replay-boundary",
    p_closed_by_rep: true, p_lead_source_track: "company",
  }) as Record<string, unknown>;
  assert.equal(replayBoundaryClose.idempotent, true, "the second call is explicitly identified as a replay");
  assert.deepEqual(
    { ...replayBoundaryClose, idempotent: false },
    firstBoundaryClose,
    "apart from the replay marker, every returned id, rate, amount, note, and total is the exact first result",
  );
  const boundaryRows = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM website_sales_commissions WHERE payment_reference = ?`,
    args: ["pay-replay-boundary"],
  });
  assert.equal(Number(boundaryRows.rows[0].c), 1, "boundary replay creates no extra commission row");

  /* ── 3b. A replay with DIFFERENT parties must be REJECTED, not paid. ─────
   * The double-pay the identical-replay test above cannot see. A second call
   * on the same payment_reference carrying a new opener passes any v2-only
   * mismatch gate, and computePayout then emits opener+closer lines where the
   * first close emitted a different shape. Different roles do not collide on
   * the uniqueness key, so fresh rows land and ONE collected payment pays
   * twice. Only the mismatch gate can catch this. */
  let rejected = false;
  try {
    await close_website_deal(client, {
      p_tenant_id: TENANT, p_lead_id: "lead-8k", p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
      p_setup_amount: 8000, p_monthly_amount: 500, p_payment_reference: "pay-8k",
      p_closed_by_rep: true,
      p_opener_user_id: "someone-else",   // <- the only change
      p_builder_user_id: BUILDER, p_manager_user_id: MANAGER, p_lead_source_track: "company",
    });
  } catch (err) {
    rejected = /deal_already_closed_mismatch|opener_does_not_match_frozen_attribution/.test(String(err));
  }
  assert.equal(rejected, true, "a replay that CHANGES the parties must be rejected as a mismatch");
  const afterDrift = await client.execute(`SELECT COUNT(*) c FROM website_sales_commissions WHERE payment_reference = 'pay-8k'`);
  assert.equal(
    Number(afterDrift.rows[0].c), 4,
    "still four rows — a changed-party replay must not add payees to a paid deal",
  );
  await client.execute({
    sql: "UPDATE user_profiles SET manager_user_id = NULL WHERE tenant_id = ? AND auth_user_id = ?",
    args: [TENANT, CLOSER],
  });

  /* ── 3c. The accelerator measures COLLECTED REVENUE, not commission. ─────
   * Summing amount_cents under-counts by the commission rate, so a rep who
   * collected $25k sums ~$7.5k, never reaches the $10k band, and is paid below
   * the rate their signed agreement states. */
  const trailing = await client.execute({
    sql: `SELECT COALESCE(SUM(c), 0) AS c FROM (
            SELECT DISTINCT "payment_reference", "basis_amount_cents" AS c
            FROM website_sales_commissions
            WHERE tenant_id = ? AND rep_user_id = ? AND entry_type = 'accrual'
          )`,
    args: [TENANT, CLOSER],
  });
  assert.equal(
    Number(trailing.rows[0].c), 900_000,
    "trailing volume is the COLLECTED basis ($500 + $500 + $8,000), counted once per payment — " +
      "not the sum of commission amounts, and not multiplied by the roles a rep played",
  );

  /* basis_amount_cents does NOT mean the same thing on every row: a manager
   * line's basis is what OASIS retained, not what was collected. Without the
   * sales-role filter, a manager who also closed the deal has two rows with two
   * different bases against one payment, DISTINCT keeps both, and their volume
   * is inflated by the retainer — buying an accelerator band they did not sell. */
  const mgrRow = await client.execute({
    sql: `SELECT basis_amount_cents FROM website_sales_commissions
          WHERE payment_reference = 'pay-8k' AND party_role = 'manager'`,
    args: [],
  });
  assert.ok(
    Number(mgrRow.rows[0].basis_amount_cents) !== 800_000,
    "a manager line's basis is the RETAINER, not the collected amount — which is exactly " +
      "why trailing volume must exclude it",
  );
  const salesOnly = await client.execute({
    sql: `SELECT COALESCE(SUM(c), 0) AS c FROM (
            SELECT DISTINCT "payment_reference", "basis_amount_cents" AS c
            FROM website_sales_commissions
            WHERE tenant_id = ? AND rep_user_id = ? AND entry_type = 'accrual'
              AND "party_role" IN ('opener','closer','full_stack')
          )`,
    args: [TENANT, MANAGER],
  });
  assert.equal(
    Number(salesOnly.rows[0].c), 0,
    "a pure manager sold nothing, so their trailing SALES volume is 0 — their override " +
      "must never earn them a volume accelerator",
  );

  /* ── 4. A rep hired as `closer` can close. ───────────────────────────────
   * 147 gated on team_role='agent'; migration 153 introduced the job titles,
   * which would have made every new hire unable to close anything. */
  /* Until a remaining-balance ledger exists, a partial deposit cannot open
   * fulfillment or accrue commission. Failing closed avoids representing the
   * unpaid balance as a fully won deal. */
  await seedLead("lead-deposit", CLOSER, OPENER);
  await assert.rejects(
    close_website_deal(client, {
      p_tenant_id: TENANT, p_lead_id: "lead-deposit", p_rep_user_id: CLOSER,
      p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
      p_setup_amount: 8000, p_collected_amount: 4000, p_monthly_amount: 500,
      p_payment_reference: "pay-deposit", p_closed_by_rep: true,
      p_opener_user_id: OPENER, p_builder_user_id: BUILDER,
      p_lead_source_track: "company",
    }),
    /collected_amount_must_equal_quoted_setup/,
  );
  const partialWrites = await client.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM website_deals WHERE lead_id = ?) AS deals,
            (SELECT COUNT(*) FROM website_sales_commissions WHERE payment_reference = ?) AS commissions,
            (SELECT COUNT(*) FROM website_onboarding WHERE lead_id = ?) AS onboarding`,
    args: ["lead-deposit", "pay-deposit", "lead-deposit"],
  });
  assert.deepEqual(
    {
      deals:Number(partialWrites.rows[0].deals),
      commissions:Number(partialWrites.rows[0].commissions),
      onboarding:Number(partialWrites.rows[0].onboarding),
    },
    { deals:0, commissions:0, onboarding:0 },
    "a partial deposit creates no financial or fulfillment truth",
  );

  /* A competing Lost transition that wins the write lock must make the close
   * return a stage conflict with zero deal/commission/onboarding writes. This
   * exercises two real libSQL connections against one shared database rather
   * than faking the conflict in a unit stub. */
  await seedLead("lead-close-race", CLOSER, OPENER, "proposal_sent");
  await client.execute({
    sql: `INSERT INTO website_sales_payment_receipts
            (id, tenant_id, lead_id, provider, provider_reference, status,
             amount_cents, currency, provider_status, verification_source,
             verified_by, verified_at, payment_plan_id, payment_token,
             installment_kind, summary)
          VALUES ('receipt-race', ?, 'lead-close-race', 'manual', 'pay-race', 'verified',
                  800000, 'CAD', 'founder_confirmed_collected', 'founder_manual', ?, ?,
                  'plan-pay-race', 'token-pay-race', 'full', '{}')`,
    args: [TENANT, FOUNDER, new Date().toISOString()],
  });
  const racingClient = createClient({ url: "file::memory:?cache=shared" });
  const lossTx = await racingClient.transaction("write");
  await lossTx.execute({
    sql: `UPDATE tenant_records
          SET data = json_set(data, '$.stage', 'lost', '$.loss_reason', 'Declined during payment')
          WHERE tenant_id = ? AND id = 'lead-close-race'`,
    args: [TENANT],
  });
  const racedClosePromise = closeWebsiteDealRpc(client, {
    p_tenant_id:TENANT,
    p_lead_id:"lead-close-race",
    p_rep_user_id:CLOSER,
    p_opener_user_id:OPENER,
    p_founder_user_id:FOUNDER,
    p_package_id:"authority",
    p_automation_ids:[],
    p_currency:"CAD",
    p_setup_amount:8000,
    p_collected_amount:8000,
    p_monthly_amount:500,
    p_payment_reference:"pay-race",
    p_payment_provider:"manual",
    p_verified_payment_id:"receipt-race",
    p_payment_plan_id:"plan-pay-race",
    p_closed_by_rep:true,
    p_builder_user_id:BUILDER,
    p_expected_stage:"proposal_sent",
    p_expected_owner_id:CLOSER,
    p_request_id:"close-pay-race",
    p_occurred_at:new Date().toISOString(),
    p_actor_user_id:FOUNDER,
    p_interaction_subject:"Payment verified",
    p_interaction_content:"Payment verified",
    p_interaction_metadata:{},
    p_lead_patch:{assigned_to:BUILDER,fulfillment_owner_id:BUILDER},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await lossTx.commit();
  lossTx.close();
  const racedClose = await racedClosePromise as Record<string, unknown>;
  assert.deepEqual(
    { ok:racedClose.ok, error:racedClose.error, current_stage:racedClose.current_stage },
    { ok:false, error:"stage_conflict", current_stage:"lost" },
    "the Lost writer wins and the financial close reports a clean conflict",
  );
  const racedWrites = await client.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM website_deals WHERE lead_id = 'lead-close-race') AS deals,
            (SELECT COUNT(*) FROM website_sales_commissions WHERE payment_reference = 'pay-race') AS commissions,
            (SELECT COUNT(*) FROM website_onboarding WHERE lead_id = 'lead-close-race') AS onboarding,
            (SELECT COUNT(*) FROM lead_interactions WHERE lead_id = 'lead-close-race') AS interactions`,
    args: [],
  });
  assert.deepEqual(
    {
      deals:Number(racedWrites.rows[0].deals),
      commissions:Number(racedWrites.rows[0].commissions),
      onboarding:Number(racedWrites.rows[0].onboarding),
      interactions:Number(racedWrites.rows[0].interactions),
    },
    { deals:0, commissions:0, onboarding:0, interactions:0 },
    "a lifecycle conflict rolls back every financial, fulfillment, and timeline write",
  );
  racingClient.close();

  const closerProfile = await client.execute({
    sql: `SELECT team_role FROM user_profiles WHERE auth_user_id = ?`, args: [CLOSER],
  });
  assert.equal(String(closerProfile.rows[0].team_role), "closer", "the fixture rep really is a 'closer', not an 'agent'");

  /* ── 5. CLAWBACK inside the window reverses every line. ──────────────────*/
  const refund = await refund_website_deal(client, {
    p_tenant_id: TENANT, p_deal_id: (big as { deal_id: string }).deal_id, p_reason: "chargeback",
  }) as { reversed_count: number; skipped_count: number };
  assert.equal(refund.reversed_count, 4, "all four accruals reverse");
  const offsets = await client.execute(`SELECT amount_cents FROM website_sales_commissions WHERE entry_type='refund_offset'`);
  assert.equal(offsets.rows.length, 4, "four offset rows written");
  assert.ok(offsets.rows.every((r) => Number(r.amount_cents) < 0), "offsets are NEGATIVE amounts");
  const net = await client.execute(`SELECT COALESCE(SUM(amount_cents),0) n FROM website_sales_commissions WHERE payment_reference='pay-8k'`);
  assert.equal(Number(net.rows[0].n), 0, "accruals plus offsets net to zero — the refund is fully unwound");
  const originals = await client.execute(`SELECT status FROM website_sales_commissions WHERE payment_reference='pay-8k' AND entry_type='accrual'`);
  assert.ok(originals.rows.every((r) => String(r.status) === "offset"), "originals are marked offset, never deleted");

  /* ── 6. OUTSIDE the window, the rep KEEPS it. ────────────────────────────
   * The whole point of a bounded clawback: pay stops being provisional. */
  await seedLead("lead-old", CLOSER);
  const old = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-old", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "growth", p_currency: "CAD",
    p_setup_amount: 4000, p_monthly_amount: 350, p_payment_reference: "pay-old",
    p_closed_by_rep: true, p_lead_source_track: "company",
  });
  const expired = new Date(Date.now() - 864e5).toISOString();
  await client.execute({
    sql: `UPDATE website_sales_commissions SET clawback_deadline_at = ? WHERE payment_reference = 'pay-old'`,
    args: [expired],
  });
  const lateRefund = await refund_website_deal(client, {
    p_tenant_id: TENANT, p_deal_id: (old as { deal_id: string }).deal_id, p_reason: "very late",
  }) as { reversed_count: number; skipped_count: number; skipped: Array<{ reason: string }> };
  assert.equal(lateRefund.reversed_count, 0, `a refund after ${CLAWBACK_WINDOW_DAYS} days must NOT claw back`);
  assert.ok(lateRefund.skipped_count > 0, "and it must SAY it skipped them, not stay silent");
  assert.ok(
    lateRefund.skipped.every((s) => s.reason === "clawback_window_expired"),
    "with the reason attached, so an operator knows why the rep kept it",
  );

  console.log(
    `website-sales-close-ledger: OK — $500 books, 4 payees on one payment, replay stays at 4 rows, ` +
      `clawback nets to zero inside ${CLAWBACK_WINDOW_DAYS}d and is refused outside it`,
  );
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
