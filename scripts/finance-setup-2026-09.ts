/**
 * One-time: put OASIS's real recurring costs and its Stripe account into the
 * Finances books (CC, 2026-09-24).
 *
 *   node --conditions=react-server --import tsx scripts/finance-setup-2026-09.ts            (dry run)
 *   node --conditions=react-server --import tsx scripts/finance-setup-2026-09.ts --apply
 *
 * 1. Seeds the chart (INSERT OR IGNORE) so the new "Rent & occupancy" account exists.
 * 2. Pins OASIS's Stripe account. The Worker's key (the restricted live key)
 *    was verified to reach exactly this account with
 *    Business-Empire-Agent/scripts/integrations/stripe_key_account.py before
 *    this ran; the pin is what Finances > Settings would write on "Confirm".
 * 3. Creates the recurring expenses CC listed, through the same createRecurring
 *    the Bills page uses, and records September's occurrence of each monthly one
 *    (recordRecurringNow — idempotent per item and due date). Billing days are
 *    not known, so each is dated the 1st; a founder can edit the date.
 *
 * Safe to re-run: an item that already exists by name is left alone, the pin is
 * skipped when already set, and a recorded month is never recorded twice.
 */

import { loadEnvConfig } from "@next/env";

process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
loadEnvConfig(process.cwd());

const OASIS_STRIPE_ACCOUNT = "acct_1RyM4HHj2zGc7I1J";
const CC_EMAIL = "conaugh@oasisai.work";

type Item = { name: string; code: string; amount: string; currency: "USD" | "CAD"; cadence: "monthly" | "yearly"; next: string; recordNow: boolean };

// CC's figures, 2026-09-24. USD unless stated. Domains are ~US$30/year with an
// unknown renewal date — scheduled a year out and NOT recorded now.
const ITEMS: Item[] = [
  { name: "Turso (database)", code: "5900", amount: "27.99", currency: "USD", cadence: "monthly", next: "2026-09-01", recordNow: true },
  { name: "Google Workspace", code: "5100", amount: "30.00", currency: "USD", cadence: "monthly", next: "2026-09-01", recordNow: true },
  { name: "Cloudflare", code: "5900", amount: "5.00", currency: "USD", cadence: "monthly", next: "2026-09-01", recordNow: true },
  { name: "Zernio (social scheduling)", code: "5100", amount: "45.00", currency: "USD", cadence: "monthly", next: "2026-09-01", recordNow: true },
  { name: "AI subscriptions", code: "5100", amount: "420.00", currency: "USD", cadence: "monthly", next: "2026-09-01", recordNow: true },
  { name: "Office rent", code: "5650", amount: "2750.00", currency: "CAD", cadence: "monthly", next: "2026-09-01", recordNow: true },
  { name: "Domains", code: "5900", amount: "30.00", currency: "USD", cadence: "yearly", next: "2027-09-01", recordNow: false },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const { tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured: refusing to run without the Turso data client");

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { seedStatements, BUSINESS_ENTITY_ID, categoryId } = await import("../lib/founders-finances/chart");
  const { auditStatement, query, queryOne, writeBatch } = await import("../lib/founders-finances/db");
  const { createRecurring, recordRecurringNow } = await import("../lib/founders-finances/bills-io");

  const profile = await getServiceSupabase()
    .from("user_profiles")
    .select("auth_user_id")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("email", CC_EMAIL)
    .maybeSingle();
  const ccUserId = (profile.data as { auth_user_id?: string } | null)?.auth_user_id;
  if (!ccUserId) throw new Error(`cc_profile_not_found: ${profile.error?.message || "no row"}`);
  const viewer = { kind: "founder" as const, ownerKey: "cc" as const, email: CC_EMAIL, userId: ccUserId };

  console.log(`mode: ${apply ? "APPLY" : "dry run"}`);

  // 1. seed
  if (apply) await writeBatch(seedStatements().map((s) => ({ sql: s.sql, args: s.args })));
  console.log(`seed: ${apply ? "applied" : "would apply"} (${seedStatements().length} INSERT OR IGNORE statements)`);

  // 2. Stripe pin
  const pin = await queryOne<{ stripe_account_id: string | null }>(`SELECT stripe_account_id FROM fin_settings WHERE entity_id = ?`, [BUSINESS_ENTITY_ID]);
  if (pin?.stripe_account_id === OASIS_STRIPE_ACCOUNT) {
    console.log(`stripe pin: already ${OASIS_STRIPE_ACCOUNT}`);
  } else if (pin?.stripe_account_id) {
    throw new Error(`stripe pin is ${pin.stripe_account_id}, not ${OASIS_STRIPE_ACCOUNT} — refusing to overwrite a different account`);
  } else {
    if (apply) {
      await writeBatch([
        { sql: `UPDATE fin_settings SET stripe_account_id = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_id = ?`, args: [OASIS_STRIPE_ACCOUNT, CC_EMAIL, BUSINESS_ENTITY_ID] },
        auditStatement({ entityId: BUSINESS_ENTITY_ID, actor: CC_EMAIL, action: "stripe.account_pinned", objectType: "settings", objectId: BUSINESS_ENTITY_ID, detail: { account: OASIS_STRIPE_ACCOUNT, via: "scripts/finance-setup-2026-09.ts" } }),
      ]);
    }
    console.log(`stripe pin: ${apply ? "set" : "would set"} ${OASIS_STRIPE_ACCOUNT}`);
  }

  // 3. recurring expenses
  const existing = await query<{ id: string; name: string }>(`SELECT id, name FROM fin_recurring_items WHERE entity_id = ?`, [BUSINESS_ENTITY_ID]);
  for (const item of ITEMS) {
    let id = existing.find((r) => r.name === item.name)?.id ?? null;
    if (!id) {
      if (apply) {
        id = await createRecurring(viewer, "oasis", {
          name: item.name,
          amount: item.amount,
          currency: item.currency,
          cadence: item.cadence,
          next_run_on: item.next,
          category_id: categoryId(BUSINESS_ENTITY_ID, item.code),
        });
      }
      console.log(`recurring: ${apply ? "created" : "would create"} ${item.name} ${item.currency} ${item.amount} ${item.cadence}`);
    } else {
      console.log(`recurring: exists ${item.name}`);
    }
    if (item.recordNow && id && apply) {
      const due = await queryOne<{ next_run_on: string }>(`SELECT next_run_on FROM fin_recurring_items WHERE id = ?`, [id]);
      if (due && due.next_run_on <= "2026-09-30") {
        const billId = await recordRecurringNow(viewer, id);
        console.log(`  recorded ${item.name} for ${due.next_run_on} -> ${billId}`);
      } else {
        console.log(`  ${item.name}: September already recorded (next ${due?.next_run_on})`);
      }
    } else if (item.recordNow) {
      console.log(`  would record ${item.name} for ${item.next}`);
    }
  }

  const totals = await query<{ currency: string; n: number; total: number }>(
    `SELECT currency, COUNT(*) AS n, SUM(total_cents) AS total FROM fin_bills WHERE entity_id = ? AND source = 'recurring' AND bill_date >= '2026-09-01' AND bill_date < '2026-10-01' GROUP BY currency`,
    [BUSINESS_ENTITY_ID],
  );
  console.log("september recurring expenses on the books:", totals.map((t) => `${t.currency} ${(Number(t.total) / 100).toFixed(2)} (${t.n})`).join(", ") || "none");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
