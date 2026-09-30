/**
 * lib/founders-finances/activity-io.ts — every money movement the books
 * record, newest first: bank lines, payments (Stripe and by hand), refunds,
 * and bills and expenses.
 *
 * WHY. "Recent transactions" on the Money overview and the Transactions tab
 * read fin_bank_transactions only. OASIS has no bank feed yet (the Wise feed's
 * writes are off), so on 2026-09-30 both said "Nothing recorded yet" while the
 * books held September's rent and software bills and the 09-05 Stripe payment
 * and refund. This is one read that lists them all.
 *
 * ONE MOVEMENT, ONE ROW. A bank line that was linked to a bill's or a
 * payment's own entry (the Wise feed matching a paid expense, a deposit
 * matched to a payment) is the same money as that bill or payment, so it is
 * left out; the bill or payment row stands for it. Excluded bank lines and
 * voided bills are not movements.
 *
 * Amounts are signed from the business's side: money in positive, money out
 * negative. An open bill has not moved money yet; it is listed with its due
 * status so it is not mistaken for a payment.
 */
import "server-only";

import type { FinanceViewer } from "./access";
import { requireEntity } from "./access-io";
import { isIsoDate } from "./fx";
import { query } from "./db";

export type ActivityKind = "bank" | "payment" | "refund" | "expense" | "bill";

export type ActivityRow = {
  kind: ActivityKind;
  id: string;
  /** The day it happened: posted (bank), occurred (payment), bill date (bill). */
  date: string;
  description: string;
  /** Category (bank line, bill), or where a payment came from. Empty when none. */
  detail: string;
  /** Signed: + money in, - money out. */
  amount_cents: number;
  currency: string;
  /** bank: unreviewed | posted | draft; payment/refund: posted | not_posted; bill/expense: open | paid. */
  status: string;
  /** A bill's due date while it is open; null otherwise. */
  due_date: string | null;
};

export type ActivityFilters = { from?: string; to?: string; q?: string; limit?: number };

/** Newest first. `from`/`to` bound the day ([from, to)); `q` searches the description. */
export async function listActivity(viewer: FinanceViewer, entityRef: string, f: ActivityFilters = {}): Promise<ActivityRow[]> {
  const entity = await requireEntity(viewer, entityRef);
  const outer: string[] = [];
  const outerArgs: Array<string | number> = [];
  if (f.from && isIsoDate(f.from)) {
    outer.push("date >= ?");
    outerArgs.push(f.from);
  }
  if (f.to && isIsoDate(f.to)) {
    outer.push("date < ?");
    outerArgs.push(f.to);
  }
  if (f.q && f.q.trim()) {
    outer.push("(lower(description) LIKE ? OR lower(detail) LIKE ?)");
    const like = `%${f.q.trim().toLowerCase().replace(/[%_]/g, "")}%`;
    outerArgs.push(like, like);
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(f.limit ?? 50)));
  const rows = await query<ActivityRow & { created_at: string }>(
    `SELECT kind, id, date, description, detail, amount_cents, currency, status, due_date, created_at FROM (
       SELECT 'bank' AS kind, t.id, t.posted_date AS date, t.description, COALESCE(c.name, '') AS detail,
              t.amount_cents, t.currency, t.status, NULL AS due_date, t.created_at
         FROM fin_bank_transactions t LEFT JOIN fin_categories c ON c.id = t.category_id
        WHERE t.entity_id = ? AND t.status <> 'excluded'
          AND NOT (t.entry_id IS NOT NULL AND (
                EXISTS (SELECT 1 FROM fin_bills b WHERE b.entity_id = t.entity_id AND (b.entry_id = t.entry_id OR b.payment_entry_id = t.entry_id))
             OR EXISTS (SELECT 1 FROM fin_payments p WHERE p.entity_id = t.entity_id AND p.entry_id = t.entry_id)))
       UNION ALL
       SELECT CASE p.kind WHEN 'refund' THEN 'refund' ELSE 'payment' END, p.id, p.occurred_on,
              COALESCE(NULLIF(p.customer_name, ''), NULLIF(p.customer_email, ''), 'Customer not named'),
              CASE WHEN p.kind = 'refund' THEN 'Refund' WHEN p.source = 'stripe' THEN 'Stripe' ELSE 'Recorded by hand' END,
              CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END, p.currency,
              CASE WHEN p.entry_id IS NULL THEN 'not_posted' ELSE 'posted' END, NULL, p.created_at
         FROM fin_payments p WHERE p.entity_id = ?
       UNION ALL
       SELECT b.kind, b.id, b.bill_date, b.vendor_name,
              COALESCE((SELECT a.name FROM fin_bill_lines l JOIN fin_accounts a ON a.id = l.account_id WHERE l.bill_id = b.id ORDER BY l.line_no LIMIT 1), ''),
              -b.total_cents, b.currency, b.status, CASE WHEN b.status = 'open' THEN b.due_date END, b.created_at
         FROM fin_bills b WHERE b.entity_id = ? AND b.status <> 'void'
     ) ${outer.length ? `WHERE ${outer.join(" AND ")}` : ""}
     ORDER BY date DESC, created_at DESC, id DESC LIMIT ${limit}`,
    [entity.id, entity.id, entity.id, ...outerArgs],
  );
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    date: r.date,
    description: r.description,
    detail: r.detail || "",
    amount_cents: Number(r.amount_cents),
    currency: r.currency,
    status: r.status,
    due_date: r.due_date ?? null,
  }));
}

/** How a row's kind reads in a table. */
export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  bank: "Bank line",
  payment: "Payment",
  refund: "Refund",
  expense: "Expense",
  bill: "Bill",
};
