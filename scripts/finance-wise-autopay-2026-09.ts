/**
 * One-time: make two recurring costs match what Wise actually pays (CC, 2026-09-25).
 *
 *   node --conditions=react-server --import tsx scripts/finance-wise-autopay-2026-09.ts            (dry run)
 *   node --conditions=react-server --import tsx scripts/finance-wise-autopay-2026-09.ts --apply
 *
 * Wise's statement (Business-Empire-Agent/scripts/integrations/wise_tool.py,
 * read 2026-09-25) shows:
 *   - Turso charges the Wise USD card US$26.99 on the 1st (not 27.99 — CC
 *     confirmed the correction).
 *   - Office rent is an AUTOMATIC Wise transfer to LAMEER MANAGEMENT INC. of a
 *     fixed US$1,944.12 (US$1,937.28 converted + US$6.84 Wise fee) from the USD
 *     balance on the 2nd (2026-08-02, 2026-09-02). The landlord receives the CAD
 *     that buys at the day's rate (CA$2,715.19 in August, CA$2,696.31 in
 *     September), so the books record what left Wise: US$1,944.12 on the 2nd.
 *
 * For each: void September's occurrence (a reversing entry, never a delete),
 * free its (item, date) key so the corrected occurrence can be recorded, set the
 * recurring item to the Wise amount/currency/day, and record September again
 * through recordRecurringNow — the same path the Bills page's "Record" uses.
 * Both stay paid from 1000 Business chequing, which IS the Wise account.
 *
 * Safe to re-run: an item whose September occurrence already has the Wise
 * amount is left alone.
 */

import { loadEnvConfig } from "@next/env";

process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
loadEnvConfig(process.cwd());

const CC_EMAIL = "conaugh@oasisai.work";

type Fix = { name: string; amountCents: number; currency: "USD" | "CAD"; septemberDate: string; why: string };

const FIXES: Fix[] = [
  { name: "Turso (database)", amountCents: 2699, currency: "USD", septemberDate: "2026-09-01", why: "Wise card charge US$26.99 on the 1st" },
  { name: "Office rent", amountCents: 194412, currency: "USD", septemberDate: "2026-09-02", why: "automatic Wise transfer to LAMEER MANAGEMENT INC., US$1,944.12 on the 2nd" },
];

type ItemRow = { id: string; name: string; amount_cents: number; currency: string; next_run_on: string; paid_from_account_id: string; active: number };
type BillRow = { id: string; bill_date: string; total_cents: number; currency: string; status: string; source_ref: string };

const money = (cents: number, cur: string) => `${cur} ${(Number(cents) / 100).toFixed(2)}`;

async function main() {
  const apply = process.argv.includes("--apply");
  const { tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured: refusing to run without the Turso data client");

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { BUSINESS_ENTITY_ID } = await import("../lib/founders-finances/chart");
  const { auditStatement, query, queryOne, writeBatch } = await import("../lib/founders-finances/db");
  const { voidBill, recordRecurringNow } = await import("../lib/founders-finances/bills-io");

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

  for (const fix of FIXES) {
    const item = await queryOne<ItemRow>(`SELECT * FROM fin_recurring_items WHERE entity_id = ? AND name = ?`, [BUSINESS_ENTITY_ID, fix.name]);
    if (!item) throw new Error(`recurring item not found: ${fix.name}`);
    const bills = await query<BillRow>(
      `SELECT id, bill_date, total_cents, currency, status, source_ref FROM fin_bills
        WHERE entity_id = ? AND source = 'recurring' AND source_ref LIKE ? AND bill_date >= '2026-09-01' AND bill_date < '2026-10-01'`,
      [BUSINESS_ENTITY_ID, `${item.id}:%`],
    );
    const live = bills.filter((b) => b.status !== "void");
    console.log(`\n${fix.name}: item ${money(item.amount_cents, item.currency)} next ${item.next_run_on}; september: ${live.map((b) => `${b.id} ${b.bill_date} ${money(b.total_cents, b.currency)} ${b.status}`).join(", ") || "none"}`);
    console.log(`  target: ${money(fix.amountCents, fix.currency)} on ${fix.septemberDate} (${fix.why})`);

    const done = live.length === 1 && live[0].total_cents === fix.amountCents && live[0].currency === fix.currency && live[0].bill_date === fix.septemberDate
      && item.amount_cents === fix.amountCents && item.currency === fix.currency;
    if (done) {
      console.log("  already correct — nothing to do");
      continue;
    }
    if (live.length > 1) throw new Error(`${fix.name}: ${live.length} live September occurrences — resolve by hand, refusing to guess`);
    if (!apply) {
      console.log(`  would void ${live[0]?.id ?? "(none)"}, set the item to ${money(fix.amountCents, fix.currency)} from ${fix.septemberDate}, and record September again`);
      continue;
    }

    if (live[0]) {
      await voidBill(viewer, live[0].id);
      // The (item, date) key is how recordRecurringNow stays idempotent; a voided
      // occurrence keeps its history under a retired key so the corrected one can be recorded.
      await writeBatch([
        { sql: `UPDATE fin_bills SET source_ref = source_ref || ':void' WHERE id = ? AND status = 'void' AND source_ref NOT LIKE '%:void'`, args: [live[0].id] },
      ]);
      console.log(`  voided ${live[0].id} (${money(live[0].total_cents, live[0].currency)})`);
    }
    await writeBatch([
      {
        sql: `UPDATE fin_recurring_items SET amount_cents = ?, currency = ?, next_run_on = ? WHERE id = ?`,
        args: [fix.amountCents, fix.currency, fix.septemberDate, item.id],
      },
      auditStatement({
        entityId: BUSINESS_ENTITY_ID,
        actor: CC_EMAIL,
        action: "recurring.updated",
        objectType: "recurring",
        objectId: item.id,
        detail: {
          before: { amount_cents: item.amount_cents, currency: item.currency, next_run_on: item.next_run_on },
          after: { amount_cents: fix.amountCents, currency: fix.currency, next_run_on: fix.septemberDate },
          why: fix.why,
          via: "scripts/finance-wise-autopay-2026-09.ts",
        },
      }),
    ]);
    const billId = await recordRecurringNow(viewer, item.id);
    const after = await queryOne<ItemRow>(`SELECT * FROM fin_recurring_items WHERE id = ?`, [item.id]);
    const bill = await queryOne<BillRow>(`SELECT id, bill_date, total_cents, currency, status, source_ref FROM fin_bills WHERE id = ?`, [billId]);
    console.log(`  recorded ${bill?.id} ${bill?.bill_date} ${money(bill?.total_cents ?? 0, bill?.currency ?? "")} ${bill?.status}; item now ${money(after?.amount_cents ?? 0, after?.currency ?? "")} next ${after?.next_run_on}`);
  }

  const totals = await query<{ currency: string; n: number; total: number }>(
    `SELECT currency, COUNT(*) AS n, SUM(total_cents) AS total FROM fin_bills WHERE entity_id = ? AND source = 'recurring' AND status != 'void' AND bill_date >= '2026-09-01' AND bill_date < '2026-10-01' GROUP BY currency`,
    [BUSINESS_ENTITY_ID],
  );
  console.log("\nseptember recurring expenses on the books:", totals.map((t) => `${t.currency} ${(Number(t.total) / 100).toFixed(2)} (${t.n})`).join(", ") || "none");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
