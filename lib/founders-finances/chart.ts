/**
 * Entities, charts of accounts, categories and tax codes — the ONE seed
 * definition. PURE: seedStatements() returns SQL + args; seed-io.ts runs them.
 *
 * Ids are deterministic (`<entity>:<code>`), and every statement is INSERT OR
 * IGNORE, so seeding is idempotent and safe to run on every cold start. A
 * founder's later edits to a seeded row (renaming an account, settings) are
 * never overwritten: OR IGNORE only fills what is missing.
 */

import { FINANCE_OWNER_EMAILS, type OwnerKey } from "./access";
import { GST_RATE_PPM, QST_RATE_PPM } from "./tax";
import type { AccountType } from "./ledger";

export type EntitySeed = {
  id: string;
  slug: string;
  name: string;
  kind: "business" | "personal";
  ownerKey: OwnerKey | null;
};

export const BUSINESS_ENTITY_ID = "fin_ent_oasis";

export const ENTITY_SEEDS: readonly EntitySeed[] = [
  { id: BUSINESS_ENTITY_ID, slug: "oasis", name: "OASIS AI Solutions", kind: "business", ownerKey: null },
  { id: "fin_ent_cc", slug: "cc-personal", name: "CC personal", kind: "personal", ownerKey: "cc" },
  { id: "fin_ent_adon", slug: "adon-personal", name: "Adon personal", kind: "personal", ownerKey: "adon" },
];

export type AccountSubtype =
  | "bank"
  | "cash"
  | "clearing"
  | "receivable"
  | "tax_receivable"
  | "prepaid"
  | "fixed_asset"
  | "investment"
  | "payable"
  | "credit_card"
  | "tax_payable"
  | "loan"
  | "owner_equity"
  | "owner_draw"
  | "retained_earnings"
  | "revenue"
  | "contra_revenue"
  | "expense"
  | "other";

export type ChartAccount = {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  ownerKey?: OwnerKey;
  /** Offered as a user-facing category for transactions when set. */
  category?: "income" | "expense" | "transfer";
};

/** Accounts the code posts to by role. Must exist in BUSINESS_CHART. */
export const SYS = {
  chequing: "1000",
  savings: "1010",
  stripeClearing: "1050",
  fxClearing: "1060",
  ar: "1100",
  gstReceivable: "1200",
  qstReceivable: "1210",
  ap: "2000",
  creditCard: "2100",
  gstPayable: "2200",
  qstPayable: "2210",
  equityCc: "3000",
  equityAdon: "3010",
  drawsCc: "3100",
  drawsAdon: "3110",
  retained: "3900",
  serviceRevenue: "4000",
  subscriptionRevenue: "4010",
  refunds: "4950",
  uncategorizedIncome: "4999",
  stripeFees: "5000",
  uncategorizedExpense: "5990",
  fxGainLoss: "6000",
} as const;

export const BUSINESS_CHART: readonly ChartAccount[] = [
  { code: "1000", name: "Business chequing", type: "asset", subtype: "bank" },
  { code: "1010", name: "Business savings", type: "asset", subtype: "bank" },
  { code: "1050", name: "Stripe clearing", type: "asset", subtype: "clearing", category: "transfer" },
  { code: "1060", name: "Currency exchange clearing", type: "asset", subtype: "clearing" },
  { code: "1100", name: "Accounts receivable", type: "asset", subtype: "receivable" },
  { code: "1200", name: "GST receivable (ITC)", type: "asset", subtype: "tax_receivable" },
  { code: "1210", name: "QST receivable (ITR)", type: "asset", subtype: "tax_receivable" },
  { code: "1300", name: "Prepaid expenses", type: "asset", subtype: "prepaid" },
  { code: "1500", name: "Computer equipment", type: "asset", subtype: "fixed_asset" },
  { code: "2000", name: "Accounts payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Business credit card", type: "liability", subtype: "credit_card", category: "transfer" },
  { code: "2200", name: "GST payable", type: "liability", subtype: "tax_payable" },
  { code: "2210", name: "QST payable", type: "liability", subtype: "tax_payable" },
  { code: "3000", name: "Owner equity — CC", type: "equity", subtype: "owner_equity", ownerKey: "cc" },
  { code: "3010", name: "Owner equity — Adon", type: "equity", subtype: "owner_equity", ownerKey: "adon" },
  { code: "3100", name: "Owner draws — CC", type: "equity", subtype: "owner_draw", ownerKey: "cc" },
  { code: "3110", name: "Owner draws — Adon", type: "equity", subtype: "owner_draw", ownerKey: "adon" },
  { code: "3900", name: "Retained earnings", type: "equity", subtype: "retained_earnings" },
  { code: "4000", name: "Service revenue", type: "revenue", subtype: "revenue", category: "income" },
  { code: "4010", name: "Subscription revenue", type: "revenue", subtype: "revenue", category: "income" },
  { code: "4900", name: "Other income", type: "revenue", subtype: "revenue", category: "income" },
  { code: "4950", name: "Refunds", type: "revenue", subtype: "contra_revenue" },
  { code: "4999", name: "Uncategorized income", type: "revenue", subtype: "revenue", category: "income" },
  { code: "5000", name: "Stripe fees", type: "expense", subtype: "expense", category: "expense" },
  { code: "5010", name: "Bank fees", type: "expense", subtype: "expense", category: "expense" },
  { code: "5100", name: "Software & subscriptions", type: "expense", subtype: "expense", category: "expense" },
  { code: "5200", name: "Advertising & marketing", type: "expense", subtype: "expense", category: "expense" },
  { code: "5300", name: "Contractors", type: "expense", subtype: "expense", category: "expense" },
  { code: "5400", name: "Meals & entertainment", type: "expense", subtype: "expense", category: "expense" },
  { code: "5500", name: "Travel", type: "expense", subtype: "expense", category: "expense" },
  { code: "5600", name: "Office supplies", type: "expense", subtype: "expense", category: "expense" },
  { code: "5650", name: "Rent & occupancy", type: "expense", subtype: "expense", category: "expense" },
  { code: "5700", name: "Professional fees", type: "expense", subtype: "expense", category: "expense" },
  { code: "5800", name: "Phone & internet", type: "expense", subtype: "expense", category: "expense" },
  { code: "5900", name: "Hosting & cloud", type: "expense", subtype: "expense", category: "expense" },
  { code: "5950", name: "Education & training", type: "expense", subtype: "expense", category: "expense" },
  { code: "5990", name: "Uncategorized expense", type: "expense", subtype: "expense", category: "expense" },
  { code: "6000", name: "FX gain/loss", type: "expense", subtype: "expense" },
];

export const PERSONAL_CHART: readonly ChartAccount[] = [
  { code: "1000", name: "Chequing", type: "asset", subtype: "bank" },
  { code: "1010", name: "Savings", type: "asset", subtype: "bank" },
  { code: "1020", name: "Cash", type: "asset", subtype: "cash" },
  { code: "1500", name: "Investments", type: "asset", subtype: "investment" },
  { code: "2000", name: "Credit card", type: "liability", subtype: "credit_card", category: "transfer" },
  { code: "2100", name: "Loans", type: "liability", subtype: "loan", category: "transfer" },
  { code: "3000", name: "Net worth (opening balance)", type: "equity", subtype: "owner_equity" },
  { code: "4000", name: "Salary & wages", type: "revenue", subtype: "revenue", category: "income" },
  { code: "4100", name: "Draws from OASIS", type: "revenue", subtype: "revenue", category: "income" },
  { code: "4900", name: "Other income", type: "revenue", subtype: "revenue", category: "income" },
  { code: "5000", name: "Housing", type: "expense", subtype: "expense", category: "expense" },
  { code: "5100", name: "Groceries", type: "expense", subtype: "expense", category: "expense" },
  { code: "5200", name: "Dining out", type: "expense", subtype: "expense", category: "expense" },
  { code: "5300", name: "Transportation", type: "expense", subtype: "expense", category: "expense" },
  { code: "5400", name: "Utilities & phone", type: "expense", subtype: "expense", category: "expense" },
  { code: "5500", name: "Subscriptions", type: "expense", subtype: "expense", category: "expense" },
  { code: "5600", name: "Health", type: "expense", subtype: "expense", category: "expense" },
  { code: "5700", name: "Shopping", type: "expense", subtype: "expense", category: "expense" },
  { code: "5800", name: "Entertainment", type: "expense", subtype: "expense", category: "expense" },
  { code: "5900", name: "Travel", type: "expense", subtype: "expense", category: "expense" },
  { code: "5950", name: "Taxes paid", type: "expense", subtype: "expense", category: "expense" },
  { code: "5990", name: "Uncategorized", type: "expense", subtype: "expense", category: "expense" },
];

export function chartFor(kind: "business" | "personal"): readonly ChartAccount[] {
  return kind === "business" ? BUSINESS_CHART : PERSONAL_CHART;
}

export function accountId(entityId: string, code: string): string {
  return `${entityId}:${code}`;
}

export function categoryId(entityId: string, code: string): string {
  return `${entityId}:cat:${code}`;
}

/** Cash-like accounts: what the cash-flow report and "cash" tiles sum. */
export const CASH_SUBTYPES: ReadonlySet<string> = new Set(["bank", "cash", "clearing"]);

/** Accounts a transaction may be recorded against (the register's "account"). */
export const REGISTER_SUBTYPES: ReadonlySet<string> = new Set(["bank", "cash", "clearing", "credit_card"]);

export type SeedStatement = { sql: string; args: Array<string | number | null> };

export function seedStatements(): SeedStatement[] {
  const out: SeedStatement[] = [];
  for (const e of ENTITY_SEEDS) {
    out.push({
      sql: `INSERT OR IGNORE INTO fin_entities (id, slug, name, kind, owner_key, owner_email, base_currency)
            VALUES (?, ?, ?, ?, ?, ?, 'CAD')`,
      args: [e.id, e.slug, e.name, e.kind, e.ownerKey, e.ownerKey ? FINANCE_OWNER_EMAILS[e.ownerKey] : null],
    });
    const business = e.kind === "business";
    out.push({
      sql: `INSERT OR IGNORE INTO fin_settings
              (entity_id, legal_name, address_line1, city, region, postal_code, country, contact_email,
               gst_qst_registered, invoice_prefix, invoice_next_number, payment_terms_days)
            VALUES (?, ?, ?, ?, ?, ?, 'Canada', ?, 0, ?, 1, 14)`,
      args: business
        ? [e.id, "OASIS AI Solutions", "6993 Decarie Blvd", "Montreal", "QC", "H3W 0B5", FINANCE_OWNER_EMAILS.cc, "OASIS"]
        : [e.id, e.name, "", "", "", "", e.ownerKey ? FINANCE_OWNER_EMAILS[e.ownerKey] : "", "INV"],
    });
    for (const a of chartFor(e.kind)) {
      out.push({
        sql: `INSERT OR IGNORE INTO fin_accounts (id, entity_id, code, name, type, subtype, currency, owner_key, is_system)
              VALUES (?, ?, ?, ?, ?, ?, 'CAD', ?, 1)`,
        args: [accountId(e.id, a.code), e.id, a.code, a.name, a.type, a.subtype, a.ownerKey ?? null],
      });
      if (a.category) {
        out.push({
          sql: `INSERT OR IGNORE INTO fin_categories (id, entity_id, name, kind, account_id) VALUES (?, ?, ?, ?, ?)`,
          args: [categoryId(e.id, a.code), e.id, a.name, a.category, accountId(e.id, a.code)],
        });
      }
    }
    if (business) {
      out.push({
        sql: `INSERT OR IGNORE INTO fin_tax_codes (id, entity_id, code, name, rate_ppm, payable_account_id, receivable_account_id)
              VALUES (?, ?, 'GST', 'GST 5%', ?, ?, ?)`,
        args: [`${e.id}:tax:GST`, e.id, GST_RATE_PPM, accountId(e.id, SYS.gstPayable), accountId(e.id, SYS.gstReceivable)],
      });
      out.push({
        sql: `INSERT OR IGNORE INTO fin_tax_codes (id, entity_id, code, name, rate_ppm, payable_account_id, receivable_account_id)
              VALUES (?, ?, 'QST', 'QST 9.975%', ?, ?, ?)`,
        args: [`${e.id}:tax:QST`, e.id, QST_RATE_PPM, accountId(e.id, SYS.qstPayable), accountId(e.id, SYS.qstReceivable)],
      });
      // A Stripe payout landing in the bank is a transfer out of Stripe
      // clearing, not revenue — the revenue was booked when the charge
      // succeeded. Without this rule every payout would be counted twice.
      out.push({
        sql: `INSERT OR IGNORE INTO fin_rules (id, entity_id, name, match_field, match_type, pattern, direction,
                set_category_id, priority, active, created_by)
              VALUES (?, ?, 'Stripe payouts are transfers', 'description', 'contains', 'stripe', 'in', ?, 10, 1, 'seed')`,
        args: [`${e.id}:rule:stripe-payout`, e.id, categoryId(e.id, SYS.stripeClearing)],
      });
    }
  }
  return out;
}
