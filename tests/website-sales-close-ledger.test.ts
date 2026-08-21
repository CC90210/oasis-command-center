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
import { close_website_deal, refund_website_deal, CLAWBACK_WINDOW_DAYS } from "../lib/turso-rpc-shim";

const TENANT = "t-oasis";
const FOUNDER = "u-cc";
const CLOSER = "u-closer";
const OPENER = "u-opener";
const BUILDER = "u-builder";
const MANAGER = "u-manager";

const client = createClient({ url: ":memory:" });

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
    CREATE TABLE user_profiles (auth_user_id TEXT, tenant_id TEXT, team_role TEXT, is_owner INTEGER DEFAULT 0);
    CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT, statements INTEGER);
  `);
  // The real v3 tables, straight from the migration file — no hand-rewritten
  // copy that could drift from what production actually has.
  const migration = readFileSync("database/turso/154_commission_ledger_v3.turso.sql", "utf8");
  const created = migration
    .split(/;\s*\n/)
    .filter((s) => /^\s*CREATE TABLE "website_(deals|sales_commissions|onboarding)"/m.test(s));
  for (const stmt of created) await client.execute(stmt);

  await client.execute({ sql: `INSERT INTO tenants VALUES (?, 'oasis-webdev')`, args: [TENANT] });
  for (const [u, role] of [[FOUNDER, "owner"], [CLOSER, "closer"], [OPENER, "opener"], [BUILDER, "builder"], [MANAGER, "manager"]] as const) {
    await client.execute({
      sql: `INSERT INTO user_profiles (auth_user_id, tenant_id, team_role, is_owner) VALUES (?,?,?,?)`,
      args: [u, TENANT, role, u === FOUNDER ? 1 : 0],
    });
  }
}

async function seedLead(id: string, assignedTo: string) {
  await client.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?,?, 'lead', ?)`,
    args: [id, TENANT, JSON.stringify({ assigned_to: assignedTo, stage: "qualified" })],
  });
}

const lines = (r: unknown) => (r as { payout_lines: Array<{ role: string; user_id: string; amount_cents: number }> }).payout_lines;
const roleOf = (r: unknown, role: string) => lines(r).find((l) => l.role === role);

async function main() {
  await setup();

  /* ── 1. A $500 deal must BOOK. Migration 147 threw here. ─────────────────*/
  await seedLead("lead-500", CLOSER);
  const small = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-500", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "starter", p_currency: "CAD",
    p_setup_amount: 500, p_monthly_amount: 0, p_payment_reference: "pay-500",
    p_closed_by_rep: true, p_lead_source_track: "self",
  });
  assert.ok(small, "a $500 deal must close — 147 raised 'collected setup below commission floor' here");
  assert.equal(lines(small).length, 1, "under the split floor exactly one full-stack line is written");
  assert.equal(roleOf(small, "full_stack")?.user_id, CLOSER);

  /* ── 2. FOUR PAYEES ON ONE PAYMENT — the point of migration 154. ─────────*/
  await seedLead("lead-8k", CLOSER);
  const big = await close_website_deal(client, {
    p_tenant_id: TENANT, p_lead_id: "lead-8k", p_rep_user_id: CLOSER,
    p_founder_user_id: FOUNDER, p_package_id: "authority", p_currency: "CAD",
    p_setup_amount: 8000, p_monthly_amount: 500, p_payment_reference: "pay-8k",
    p_closed_by_rep: true, p_opener_user_id: OPENER, p_builder_user_id: BUILDER,
    p_manager_user_id: MANAGER, p_lead_source_track: "company",
  });
  const roles = lines(big).map((l) => l.role).sort();
  assert.deepEqual(roles, ["builder", "closer", "manager", "opener"], "all four parties are paid from one payment");
  assert.equal(roleOf(big, "opener")?.amount_cents, 160_000, "opener 20% of $8,000");
  assert.equal(roleOf(big, "closer")?.amount_cents, 240_000, "closer 30% of $8,000");
  assert.equal(roleOf(big, "builder")?.amount_cents, 100_000, "builder flat $1,000 for authority");
  assert.ok((roleOf(big, "manager")?.amount_cents ?? 0) > 0, "the manager earns an override");

  const stored = await client.execute({
    sql: `SELECT party_role, amount_cents, comp_version, clawback_deadline_at FROM website_sales_commissions
          WHERE payment_reference = 'pay-8k' ORDER BY party_role`,
    args: [],
  });
  assert.equal(stored.rows.length, 4, "four ledger ROWS exist — not just four numbers in a response");
  assert.ok(stored.rows.every((r) => Number(r.comp_version) === 3), "every row records comp v3");
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
    rejected = /deal_already_closed_mismatch/.test(String(err));
  }
  assert.equal(rejected, true, "a replay that CHANGES the parties must be rejected as a mismatch");
  const afterDrift = await client.execute(`SELECT COUNT(*) c FROM website_sales_commissions WHERE payment_reference = 'pay-8k'`);
  assert.equal(
    Number(afterDrift.rows[0].c), 4,
    "still four rows — a changed-party replay must not add payees to a paid deal",
  );

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
    Number(trailing.rows[0].c), 850_000,
    "trailing volume is the COLLECTED basis ($500 + $8,000), counted once per payment — " +
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
