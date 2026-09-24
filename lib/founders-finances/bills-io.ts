/**
 * Bills (owed to a vendor, paid later) and expenses (already paid), plus
 * owner draws/contributions and receipts.
 *
 *   bill:     Dr expense (+ GST/QST receivable when registered) / Cr AP
 *   pay bill: Dr AP / Cr bank or card
 *   expense:  Dr expense (+ ITC/ITR when registered) / Cr the account it was paid from
 * When the business is NOT registered, sales tax paid is part of the cost —
 * it is debited to the expense, never to a receivable it cannot claim.
 */
import "server-only";

import { createHash } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";

import { accountId, CASH_SUBTYPES, REGISTER_SUBTYPES, SYS } from "./chart";
import { isIsoDate, torontoToday } from "./fx";
import { parseMoneyToCents } from "./money";
import { ownerParity, type EquityEvent } from "./parity";
import { validateBillInput, validateEquityInput } from "./validation";
import { viewerLabel, type FinanceViewer } from "./access";
import { auditStatement, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import {
  FinanceInputError,
  FinanceNotFound,
  requireAccountOf,
  requireCategoryOf,
  requireEntity,
  requireRowEntity,
} from "./access-io";
import { buildPosting, buildReversal } from "./ledger-io";
import { loadSettings } from "./settings-io";
import type { JournalLineInput } from "./ledger";

export type BillRow = {
  id: string;
  entity_id: string;
  kind: "bill" | "expense";
  contact_id: string | null;
  vendor_name: string;
  reference: string;
  bill_date: string;
  due_date: string | null;
  currency: "CAD" | "USD";
  subtotal_cents: number;
  gst_cents: number;
  qst_cents: number;
  total_cents: number;
  status: "open" | "paid" | "void";
  paid_at: string | null;
  paid_from_account_id: string | null;
  memo: string;
  entry_id: string | null;
  payment_entry_id: string | null;
  source: string;
  created_by: string;
  created_at: string;
};

export async function listBills(viewer: FinanceViewer, entityRef: string) {
  const entity = await requireEntity(viewer, entityRef);
  return query<BillRow & { category_name: string | null; attachments: number }>(
    `SELECT b.*, (SELECT a.name FROM fin_bill_lines l JOIN fin_accounts a ON a.id = l.account_id WHERE l.bill_id = b.id ORDER BY l.line_no LIMIT 1) AS category_name,
            (SELECT COUNT(*) FROM fin_attachments f WHERE f.owner_type = 'bill' AND f.owner_id = b.id) AS attachments
       FROM fin_bills b WHERE b.entity_id = ? ORDER BY b.bill_date DESC, b.created_at DESC LIMIT 500`,
    [entity.id],
  );
}

export async function createBill(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  const v = validateBillInput(raw);
  if (!v.ok) throw new FinanceInputError(v.error);
  const input = v.value;
  if (input.kind === "bill" && entity.kind !== "business") throw new FinanceInputError("personal books record expenses, not bills");
  const category = await requireCategoryOf(entity.id, input.categoryId);
  if (category.kind !== "expense") throw new FinanceInputError("choose an expense category");
  const settings = await loadSettings(entity.id);
  const registered = entity.kind === "business" && settings.gst_qst_registered === 1;
  const taxTotal = input.gstCents + input.qstCents;
  const total = input.subtotalCents + taxTotal;
  const lines: JournalLineInput[] = [
    { accountId: category.account_id, currency: input.currency, debitCents: registered ? input.subtotalCents : total, memo: input.vendorName },
  ];
  if (registered && input.gstCents > 0) lines.push({ accountId: accountId(entity.id, SYS.gstReceivable), currency: input.currency, debitCents: input.gstCents, memo: "GST paid (ITC)" });
  if (registered && input.qstCents > 0) lines.push({ accountId: accountId(entity.id, SYS.qstReceivable), currency: input.currency, debitCents: input.qstCents, memo: "QST paid (ITR)" });
  let creditAccount: string;
  if (input.kind === "expense") {
    const paidFrom = await requireAccountOf(entity.id, input.paidFromAccountId as string);
    if (!REGISTER_SUBTYPES.has(paidFrom.subtype)) throw new FinanceInputError("paid-from must be a bank, cash or card account");
    creditAccount = paidFrom.id;
  } else creditAccount = accountId(entity.id, SYS.ap);
  lines.push({ accountId: creditAccount, currency: input.currency, creditCents: total, memo: input.vendorName });
  const id = newId("bill");
  const posting = await buildPosting({
    entityId: entity.id,
    entryDate: input.billDate,
    memo: `${input.kind === "bill" ? "Bill" : "Expense"}: ${input.vendorName}`,
    source: input.kind,
    sourceRef: id,
    createdBy: viewerLabel(viewer),
    lines,
  });
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO fin_bills (id, entity_id, kind, contact_id, vendor_name, reference, bill_date, due_date, currency, subtotal_cents, gst_cents,
              qst_cents, total_cents, status, paid_at, paid_from_account_id, memo, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        entity.id,
        input.kind,
        input.contactId,
        input.vendorName,
        input.reference,
        input.billDate,
        input.dueDate,
        input.currency,
        input.subtotalCents,
        input.gstCents,
        input.qstCents,
        total,
        input.kind === "expense" ? "paid" : "open",
        input.kind === "expense" ? input.billDate : null,
        input.kind === "expense" ? creditAccount : null,
        input.memo,
        viewerLabel(viewer),
      ],
    },
    {
      sql: `INSERT INTO fin_bill_lines (id, bill_id, line_no, description, account_id, amount_cents) VALUES (?, ?, 1, ?, ?, ?)`,
      args: [newId("bl"), id, input.memo || input.vendorName, category.account_id, registered ? input.subtotalCents : total],
    },
    ...posting.statements,
    { sql: `UPDATE fin_bills SET entry_id = ? WHERE id = ?`, args: [posting.entryId, id] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: `${input.kind}.created`, objectType: "bill", objectId: id, detail: { total, currency: input.currency } }),
  ];
  await writeBatch(statements);
  return id;
}

export async function payBill(viewer: FinanceViewer, billId: string, raw: Record<string, unknown>): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_bills", billId);
  const bill = await queryOne<BillRow>(`SELECT * FROM fin_bills WHERE id = ?`, [billId]);
  if (!bill) throw new FinanceNotFound();
  if (bill.kind !== "bill" || bill.status !== "open") throw new FinanceInputError("only an open bill can be paid");
  const from = await requireAccountOf(entity.id, typeof raw.account_id === "string" && raw.account_id ? raw.account_id : accountId(entity.id, SYS.chequing));
  if (!REGISTER_SUBTYPES.has(from.subtype)) throw new FinanceInputError("pay from a bank, cash or card account");
  const date = typeof raw.date === "string" && raw.date ? raw.date : torontoToday();
  if (!isIsoDate(date)) throw new FinanceInputError("date must be YYYY-MM-DD");
  const posting = await buildPosting({
    entityId: entity.id,
    entryDate: date,
    memo: `Pay bill: ${bill.vendor_name}`,
    source: "bill_payment",
    sourceRef: bill.id,
    createdBy: viewerLabel(viewer),
    gate: { sql: `(SELECT status FROM fin_bills WHERE id = ?) = 'open'`, args: [bill.id] },
    lines: [
      { accountId: accountId(entity.id, SYS.ap), currency: bill.currency, debitCents: bill.total_cents },
      { accountId: from.id, currency: bill.currency, creditCents: bill.total_cents },
    ],
  });
  await writeBatch([
    ...posting.statements,
    {
      sql: `UPDATE fin_bills SET status = 'paid', paid_at = ?, paid_from_account_id = ?, payment_entry_id = ? WHERE id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
      args: [date, from.id, posting.entryId, bill.id, posting.entryId],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "bill.paid", objectType: "bill", objectId: bill.id }),
  ]);
}

export async function voidBill(viewer: FinanceViewer, billId: string): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_bills", billId);
  const bill = await queryOne<BillRow>(`SELECT * FROM fin_bills WHERE id = ?`, [billId]);
  if (!bill) throw new FinanceNotFound();
  if (bill.status === "void") return;
  const statements: InStatement[] = [];
  for (const entryId of [bill.payment_entry_id, bill.entry_id]) {
    if (!entryId) continue;
    const rev = await buildReversal({ entityId: entity.id, entryId, date: torontoToday(), memo: `Void ${bill.kind}: ${bill.vendor_name}`, createdBy: viewerLabel(viewer) });
    statements.push(...rev.statements);
  }
  statements.push(
    { sql: `UPDATE fin_bills SET status = 'void' WHERE id = ? AND status = ?`, args: [bill.id, bill.status] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "bill.voided", objectType: "bill", objectId: bill.id }),
  );
  await writeBatch(statements);
}

// ── owner equity ─────────────────────────────────────────────────────────

export async function recordEquityEvent(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  if (entity.kind !== "business") throw new FinanceInputError("owner draws and contributions are recorded on the business book");
  const v = validateEquityInput(raw);
  if (!v.ok) throw new FinanceInputError(v.error);
  const e = v.value;
  const cash = await requireAccountOf(entity.id, e.cashAccountId);
  if (!CASH_SUBTYPES.has(cash.subtype) && cash.subtype !== "credit_card") throw new FinanceInputError("choose the bank or cash account the money moved through");
  const equityCode = e.kind === "draw" ? (e.ownerKey === "cc" ? SYS.drawsCc : SYS.drawsAdon) : e.ownerKey === "cc" ? SYS.equityCc : SYS.equityAdon;
  const equityAcct = accountId(entity.id, equityCode);
  const id = newId("eq");
  const posting = await buildPosting({
    entityId: entity.id,
    entryDate: e.eventDate,
    memo: `${e.kind === "draw" ? "Owner draw" : "Owner contribution"} — ${e.ownerKey === "cc" ? "CC" : "Adon"}`,
    source: "owner_equity",
    sourceRef: id,
    createdBy: viewerLabel(viewer),
    lines:
      e.kind === "draw"
        ? [
            { accountId: equityAcct, currency: e.currency, debitCents: e.amountCents, memo: e.memo },
            { accountId: cash.id, currency: e.currency, creditCents: e.amountCents, memo: e.memo },
          ]
        : [
            { accountId: cash.id, currency: e.currency, debitCents: e.amountCents, memo: e.memo },
            { accountId: equityAcct, currency: e.currency, creditCents: e.amountCents, memo: e.memo },
          ],
  });
  await writeBatch([
    {
      sql: `INSERT INTO fin_owner_equity_events (id, entity_id, owner_key, kind, amount_cents, currency, event_date, cash_account_id, memo, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, e.ownerKey, e.kind, e.amountCents, e.currency, e.eventDate, cash.id, e.memo, viewerLabel(viewer)],
    },
    ...posting.statements,
    { sql: `UPDATE fin_owner_equity_events SET entry_id = ? WHERE id = ?`, args: [posting.entryId, id] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: `equity.${e.kind}`, objectType: "equity", objectId: id, detail: { owner: e.ownerKey, amount: e.amountCents } }),
  ]);
  return id;
}

export async function equitySummary(viewer: FinanceViewer, entityRef: string) {
  const entity = await requireEntity(viewer, entityRef);
  const events = await query<{
    id: string;
    owner_key: "cc" | "adon";
    kind: "draw" | "contribution";
    amount_cents: number;
    currency: string;
    event_date: string;
    memo: string;
    cad_cents: number | null;
  }>(
    `SELECT e.id, e.owner_key, e.kind, e.amount_cents, e.currency, e.event_date, e.memo,
            (SELECT SUM(l.cad_debit_cents) FROM fin_journal_lines l WHERE l.entry_id = e.entry_id) AS cad_cents
       FROM fin_owner_equity_events e WHERE e.entity_id = ? ORDER BY e.event_date DESC, e.created_at DESC`,
    [entity.id],
  );
  const parity = ownerParity(
    events.map((ev): EquityEvent => ({ ownerKey: ev.owner_key, kind: ev.kind, cadCents: Number(ev.cad_cents ?? (ev.currency === "CAD" ? ev.amount_cents : 0)) })),
  );
  return { events, parity };
}

// ── receipts ─────────────────────────────────────────────────────────────

export const RECEIPT_BUCKET = "finance-receipts";
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export async function attachReceipt(
  viewer: FinanceViewer,
  args: { ownerType: "bill" | "transaction"; ownerId: string; filename: string; contentType: string; bytes: Uint8Array },
): Promise<string> {
  const table = args.ownerType === "bill" ? "fin_bills" : "fin_bank_transactions";
  const entity = await requireRowEntity(viewer, table, args.ownerId);
  if (!ALLOWED_TYPES.has(args.contentType)) throw new FinanceInputError("receipts must be PDF, JPEG, PNG, WebP or HEIC");
  if (args.bytes.byteLength === 0 || args.bytes.byteLength > MAX_RECEIPT_BYTES) throw new FinanceInputError("receipt must be between 1 byte and 10 MB");

  const sha = createHash("sha256").update(args.bytes).digest("hex");
  const id = newId("att");
  const safeName = args.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "receipt";
  const path = `${entity.id}/${args.ownerType}/${args.ownerId}/${id}-${safeName}`;

  const up = await getServiceSupabase().storage.from(RECEIPT_BUCKET).upload(path, args.bytes, { contentType: args.contentType, upsert: false });
  if (up.error) throw new Error(`receipt upload failed: ${up.error.message}`);
  await writeBatch([
    {
      sql: `INSERT INTO fin_attachments (id, entity_id, owner_type, owner_id, storage_bucket, storage_path, filename, content_type, size_bytes, sha256, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, args.ownerType, args.ownerId, RECEIPT_BUCKET, path, args.filename.slice(0, 200), args.contentType, args.bytes.byteLength, sha, viewerLabel(viewer)],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "receipt.attached", objectType: args.ownerType, objectId: args.ownerId, detail: { attachment: id } }),
  ]);
  return id;
}

/** Short-lived signed URL for one receipt, after the entity gate. */
export async function receiptUrl(viewer: FinanceViewer, attachmentId: string): Promise<string> {
  await requireRowEntity(viewer, "fin_attachments", attachmentId);
  const a = await queryOne<{ storage_bucket: string; storage_path: string }>(`SELECT storage_bucket, storage_path FROM fin_attachments WHERE id = ?`, [attachmentId]);
  if (!a) throw new FinanceNotFound();

  const r = await getServiceSupabase().storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 300);
  if (r.error || !r.data?.signedUrl) throw new Error(`could not sign receipt URL: ${r.error?.message || "no url"}`);
  return r.data.signedUrl;
}

export async function listAttachments(viewer: FinanceViewer, ownerType: "bill" | "transaction", ownerId: string) {
  const table = ownerType === "bill" ? "fin_bills" : "fin_bank_transactions";
  await requireRowEntity(viewer, table, ownerId);
  return query<{ id: string; filename: string; content_type: string; size_bytes: number; created_at: string }>(
    `SELECT id, filename, content_type, size_bytes, created_at FROM fin_attachments WHERE owner_type = ? AND owner_id = ? ORDER BY created_at`,
    [ownerType, ownerId],
  );
}

// ── recurring ────────────────────────────────────────────────────────────

export async function listRecurring(viewer: FinanceViewer, entityRef: string) {
  const entity = await requireEntity(viewer, entityRef);
  return query<{ id: string; name: string; kind: string; amount_cents: number; currency: string; cadence: string; next_run_on: string; active: number; category_name: string | null }>(
    `SELECT r.id, r.name, r.kind, r.amount_cents, r.currency, r.cadence, r.next_run_on, r.active, c.name AS category_name
       FROM fin_recurring_items r LEFT JOIN fin_categories c ON c.id = r.category_id WHERE r.entity_id = ? ORDER BY r.next_run_on`,
    [entity.id],
  );
}

export function advanceDate(date: string, cadence: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cadence === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function createRecurring(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  if (!name) throw new FinanceInputError("name is required");
  const amount = parseMoneyToCents(raw.amount as string);
  if (amount === null || amount <= 0) throw new FinanceInputError("amount must be greater than zero");
  const cadence = ["weekly", "monthly", "quarterly", "yearly"].includes(String(raw.cadence)) ? String(raw.cadence) : "monthly";
  const next = typeof raw.next_run_on === "string" && isIsoDate(raw.next_run_on) ? raw.next_run_on : torontoToday();
  const currency = raw.currency === "USD" ? "USD" : "CAD";
  const category = await requireCategoryOf(entity.id, String(raw.category_id || ""));
  const paidFrom = await requireAccountOf(entity.id, String(raw.paid_from_account_id || accountId(entity.id, SYS.chequing)));
  const id = newId("rec");
  await writeBatch([
    {
      sql: `INSERT INTO fin_recurring_items (id, entity_id, kind, name, category_id, paid_from_account_id, amount_cents, currency, cadence, next_run_on, created_by)
            VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, name, category.id, paidFrom.id, amount, currency, cadence, next, viewerLabel(viewer)],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "recurring.created", objectType: "recurring", objectId: id }),
  ]);
  return id;
}

/**
 * Record a due recurring expense now (a founder clicks "Record"): creates the
 * expense exactly as if typed in, and advances the schedule in the same step.
 * Idempotent per (item, due date) through the expense's source ref.
 */
export async function recordRecurringNow(viewer: FinanceViewer, itemId: string): Promise<string> {
  const entity = await requireRowEntity(viewer, "fin_recurring_items", itemId);
  const item = await queryOne<{ id: string; name: string; category_id: string; paid_from_account_id: string; amount_cents: number; currency: string; cadence: string; next_run_on: string; active: number }>(
    `SELECT * FROM fin_recurring_items WHERE id = ?`,
    [itemId],
  );
  if (!item || item.active !== 1) throw new FinanceNotFound();
  const already = await queryOne<{ id: string }>(`SELECT id FROM fin_bills WHERE entity_id = ? AND source = 'recurring' AND source_ref = ?`, [entity.id, `${item.id}:${item.next_run_on}`]);
  if (already) return already.id;
  const billId = await createBill(viewer, entity.id, {
    kind: "expense",
    vendor_name: item.name,
    bill_date: item.next_run_on,
    currency: item.currency,
    subtotal: (item.amount_cents / 100).toFixed(2),
    category_id: item.category_id,
    paid_from_account_id: item.paid_from_account_id,
    memo: `Recurring (${item.cadence})`,
  });
  await writeBatch([
    { sql: `UPDATE fin_bills SET source = 'recurring', source_ref = ? WHERE id = ?`, args: [`${item.id}:${item.next_run_on}`, billId] },
    { sql: `UPDATE fin_recurring_items SET next_run_on = ? WHERE id = ? AND next_run_on = ?`, args: [advanceDate(item.next_run_on, item.cadence), item.id, item.next_run_on] },
  ]);
  return billId;
}
