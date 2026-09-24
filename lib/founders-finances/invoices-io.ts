/**
 * Invoicing: contacts, drafts, finalise + send (number, recognition entry,
 * Stripe Payment Link, PDF, email), manual payment, void, overdue sweep and
 * reminders. Business entity only — the personal books do not invoice.
 *
 * Status flow: draft -> sent -> (overdue) -> paid, or -> void. "sent" means
 * ISSUED (numbered, receivable recognised); sent_at records the successful
 * email. An invoice that was issued but whose email failed shows as
 * "issued, not emailed" and can be re-sent without re-numbering.
 */
import "server-only";

import { accountId, BUSINESS_ENTITY_ID, SYS, CASH_SUBTYPES } from "./chart";
import {
  allocateInvoiceNumber,
  balanceDueCents,
  canTransition,
  computeInvoiceTotals,
  dueDateFor,
  effectiveInvoiceStatus,
  totalsFromStoredLines,
  validateInvoiceCurrency,
  type InvoiceLineInput,
  type InvoiceStatus,
} from "./invoice";
import { isIsoDate, torontoToday, usdToCadCents } from "./fx";
import { parseMoneyToCents } from "./money";
import { validateRegistration } from "./tax";
import { viewerLabel, type FinanceViewer } from "./access";
import { auditStatement, finDb, isUniqueViolation, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import { FinanceInputError, FinanceNotFound, requireEntity, requireRowEntity, type EntityRow } from "./access-io";
import { buildReversal } from "./ledger-io";
import { usdCadRate } from "./fx-io";
import {
  buildRecognitionPosting,
  buildSettlementPosting,
  loadContact,
  loadInvoice,
  loadInvoiceLines,
  recomputeInvoicePaidStatement,
  type ContactRow,
  type InvoiceLineRow,
  type InvoiceRow,
} from "./invoice-store";
import { addressLines, loadSettings } from "./settings-io";
import { renderInvoicePdf } from "./invoice-pdf";
import { composeInvoiceEmail, sendInvoiceEmail } from "./invoice-email";
import { getStripeClient, stripeRequest, financeTenantId } from "./stripe-io";
import { deactivatePaymentLinkIfPaid } from "./stripe-ingest";
import { validateEmail } from "./validation";

function businessOnly(entity: EntityRow): void {
  if (entity.kind !== "business") throw new FinanceInputError("invoicing is only available on the business book");
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// ── contacts ─────────────────────────────────────────────────────────────

export async function listContacts(viewer: FinanceViewer, entityRef: string, kind?: "customer" | "vendor"): Promise<ContactRow[]> {
  const entity = await requireEntity(viewer, entityRef);
  const kinds = kind === "customer" ? ["customer", "both"] : kind === "vendor" ? ["vendor", "both"] : ["customer", "vendor", "both"];
  return query<ContactRow>(
    `SELECT id, entity_id, kind, name, email, company, address, stripe_customer_id FROM fin_contacts
      WHERE entity_id = ? AND archived = 0 AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY name`,
    [entity.id, ...kinds],
  );
}

export async function createContact(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  const kind = raw.kind === "vendor" || raw.kind === "both" ? raw.kind : "customer";
  const name = text(raw.name, 200);
  if (!name) throw new FinanceInputError("contact name is required");
  const emailRaw = text(raw.email, 254);
  const email = emailRaw ? validateEmail(emailRaw) : "";
  if (emailRaw && !email) throw new FinanceInputError("contact email is not valid");
  const id = newId("con");
  await writeBatch([
    {
      sql: `INSERT INTO fin_contacts (id, entity_id, kind, name, email, company, address, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, kind, name, email || "", text(raw.company, 200), text(raw.address, 500), text(raw.notes, 1000)],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "contact.created", objectType: "contact", objectId: id }),
  ]);
  return id;
}

// ── drafts ───────────────────────────────────────────────────────────────

type DraftInput = {
  contactId: string;
  issueDate: string;
  dueDate: string;
  currency: "CAD" | "USD";
  notes: string;
  lines: Array<InvoiceLineInput & { revenueAccountId: string }>;
};

async function parseDraftInput(entity: EntityRow, raw: Record<string, unknown>, viewer: FinanceViewer): Promise<DraftInput> {
  const settings = await loadSettings(entity.id);
  let contactId = text(raw.contact_id, 120);
  if (!contactId) {
    const nc = raw.new_contact && typeof raw.new_contact === "object" ? (raw.new_contact as Record<string, unknown>) : null;
    if (!nc || !text(nc.name, 200)) throw new FinanceInputError("choose a customer or enter a new one");
    contactId = await createContact(viewer, entity.id, { ...nc, kind: "customer" });
  } else {
    const c = await loadContact(contactId);
    if (!c || c.entity_id !== entity.id) throw new FinanceInputError("customer does not belong to this book");
  }
  const issueDate = text(raw.issue_date, 10) || torontoToday();
  if (!isIsoDate(issueDate)) throw new FinanceInputError("issue date must be YYYY-MM-DD");
  const dueRaw = text(raw.due_date, 10);
  const dueDate = dueRaw || dueDateFor(issueDate, settings.payment_terms_days);
  if (!isIsoDate(dueDate) || dueDate < issueDate) throw new FinanceInputError("due date must be on or after the issue date");
  let currency: "CAD" | "USD";
  try {
    currency = validateInvoiceCurrency(text(raw.currency, 3).toUpperCase() || "CAD");
  } catch (e) {
    throw new FinanceInputError((e as Error).message);
  }
  const rawLines = Array.isArray(raw.lines) ? (raw.lines as Array<Record<string, unknown>>) : [];
  const revenueAccounts = new Set(
    (await query<{ id: string }>(`SELECT id FROM fin_accounts WHERE entity_id = ? AND type = 'revenue' AND subtype = 'revenue'`, [entity.id])).map((r) => r.id),
  );
  const lines = rawLines.map((l, i) => {
    const acct = text(l.revenue_account_id, 120) || accountId(entity.id, SYS.serviceRevenue);
    if (!revenueAccounts.has(acct)) throw new FinanceInputError(`line ${i + 1}: revenue account is not a revenue account of this book`);
    return {
      description: text(l.description, 500),
      quantity: typeof l.quantity === "number" ? String(l.quantity) : text(l.quantity, 20) || "1",
      unitPrice: typeof l.unit_price === "number" ? (l.unit_price as number) : text(l.unit_price, 30),
      taxable: l.taxable !== false,
      revenueAccountId: acct,
    };
  });
  return { contactId, issueDate, dueDate, currency, notes: text(raw.notes, 2000), lines };
}

function lineStatements(invoiceId: string, lines: DraftInput["lines"], computed: ReturnType<typeof computeInvoiceTotals>): InStatement[] {
  return computed.lines.map((l, i) => ({
    sql: `INSERT INTO fin_invoice_lines (id, invoice_id, line_no, description, quantity_milli, unit_price_cents, amount_cents, taxable, revenue_account_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [newId("il"), invoiceId, i + 1, l.description, l.quantityMilli, l.unitPriceCents, l.amountCents, l.taxable ? 1 : 0, lines[i].revenueAccountId],
  }));
}

export async function createDraftInvoice(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  businessOnly(entity);
  const input = await parseDraftInput(entity, raw, viewer);
  const settings = await loadSettings(entity.id);
  let totals;
  try {
    totals = computeInvoiceTotals(input.lines, { registered: settings.gst_qst_registered === 1 });
  } catch (e) {
    throw new FinanceInputError((e as Error).message);
  }
  const id = newId("inv");
  await writeBatch([
    {
      sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, status, issue_date, due_date, currency, subtotal_cents, gst_cents,
              qst_cents, total_cents, tax_registered_snapshot, notes, created_by)
            VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, input.contactId, input.issueDate, input.dueDate, input.currency, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, settings.gst_qst_registered, input.notes, viewerLabel(viewer)],
    },
    ...lineStatements(id, input.lines, totals),
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.draft_created", objectType: "invoice", objectId: id, detail: { total: totals.totalCents, currency: input.currency } }),
  ]);
  return id;
}

export async function updateDraftInvoice(viewer: FinanceViewer, invoiceId: string, raw: Record<string, unknown>): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  if (inv.status !== "draft") throw new FinanceInputError("only a draft can be edited; void it and create a new one");
  const input = await parseDraftInput(entity, raw, viewer);
  const settings = await loadSettings(entity.id);
  let totals;
  try {
    totals = computeInvoiceTotals(input.lines, { registered: settings.gst_qst_registered === 1 });
  } catch (e) {
    throw new FinanceInputError((e as Error).message);
  }
  await writeBatch([
    { sql: `DELETE FROM fin_invoice_lines WHERE invoice_id = ? AND (SELECT status FROM fin_invoices WHERE id = ?) = 'draft'`, args: [invoiceId, invoiceId] },
    ...lineStatements(invoiceId, input.lines, totals),
    {
      sql: `UPDATE fin_invoices SET contact_id = ?, issue_date = ?, due_date = ?, currency = ?, subtotal_cents = ?, gst_cents = ?, qst_cents = ?,
                   total_cents = ?, tax_registered_snapshot = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ? AND status = 'draft'`,
      args: [input.contactId, input.issueDate, input.dueDate, input.currency, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, settings.gst_qst_registered, input.notes, invoiceId],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.draft_updated", objectType: "invoice", objectId: invoiceId }),
  ]);
}

// ── reads ────────────────────────────────────────────────────────────────

export type InvoiceListRow = InvoiceRow & { contact_name: string; contact_email: string; effective_status: InvoiceStatus; balance_cents: number };

export async function listInvoices(viewer: FinanceViewer, entityRef: string, status?: string): Promise<InvoiceListRow[]> {
  const entity = await requireEntity(viewer, entityRef);
  const rows = await query<InvoiceRow & { contact_name: string; contact_email: string }>(
    `SELECT i.*, c.name AS contact_name, c.email AS contact_email FROM fin_invoices i
       JOIN fin_contacts c ON c.id = i.contact_id
      WHERE i.entity_id = ? ORDER BY COALESCE(i.number, '') DESC, i.created_at DESC LIMIT 500`,
    [entity.id],
  );
  const today = torontoToday();
  const out = rows.map((r) => ({
    ...r,
    effective_status: effectiveInvoiceStatus(
      { status: r.status, dueDate: r.due_date, totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents },
      today,
    ),
    balance_cents: r.status === "void" ? 0 : balanceDueCents({ totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents }),
  }));
  return status ? out.filter((r) => r.effective_status === status) : out;
}

export async function getInvoiceDetail(viewer: FinanceViewer, invoiceId: string) {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  const [lines, contact, payments, settings] = await Promise.all([
    loadInvoiceLines(invoiceId),
    loadContact(inv.contact_id),
    query<{ id: string; kind: string; source: string; occurred_on: string; amount_cents: number; currency: string; description: string }>(
      `SELECT id, kind, source, occurred_on, amount_cents, currency, description FROM fin_payments
        WHERE invoice_id = ? OR parent_payment_id IN (SELECT id FROM fin_payments WHERE invoice_id = ?) ORDER BY occurred_at`,
      [invoiceId, invoiceId],
    ),
    loadSettings(entity.id),
  ]);
  return {
    entity,
    invoice: inv,
    effectiveStatus: effectiveInvoiceStatus(
      { status: inv.status, dueDate: inv.due_date, totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents },
      torontoToday(),
    ),
    lines,
    contact,
    payments,
    settings,
  };
}

export async function invoicePdfBytes(viewer: FinanceViewer, invoiceId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const d = await getInvoiceDetail(viewer, invoiceId);
  return { bytes: await pdfFor(d.invoice, d.lines, d.contact, d.settings), filename: `${d.invoice.number || "DRAFT"}.pdf` };
}

async function pdfFor(inv: InvoiceRow, lines: InvoiceLineRow[], contact: ContactRow | null, settings: Awaited<ReturnType<typeof loadSettings>>): Promise<Uint8Array> {
  return renderInvoicePdf({
    seller: {
      legalName: settings.legal_name,
      addressLines: addressLines(settings),
      email: settings.contact_email,
      gstNumber: settings.gst_number,
      qstNumber: settings.qst_number,
    },
    invoice: {
      number: inv.number || "DRAFT",
      status: inv.status,
      issueDate: inv.issue_date,
      dueDate: inv.due_date,
      currency: inv.currency,
      subtotalCents: inv.subtotal_cents,
      gstCents: inv.gst_cents,
      qstCents: inv.qst_cents,
      totalCents: inv.total_cents,
      amountPaidCents: inv.amount_paid_cents,
      taxRegistered: inv.tax_registered_snapshot === 1,
      notes: inv.notes,
      paymentLinkUrl: inv.stripe_payment_link_url,
      paymentInstructions: settings.payment_instructions,
    },
    customer: { name: contact?.name || "", company: contact?.company || "", email: contact?.email || "", address: contact?.address || "" },
    lines: lines.map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unitPriceCents: l.unit_price_cents, amountCents: l.amount_cents })),
  });
}

// ── finalise + send ──────────────────────────────────────────────────────

/** Number the draft, re-total it under current registration, recognise the receivable. Atomic. */
export async function finalizeInvoice(viewer: FinanceViewer, invoiceId: string): Promise<InvoiceRow> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  businessOnly(entity);
  for (let attempt = 0; attempt < 3; attempt++) {
    const inv = await loadInvoice(invoiceId);
    if (!inv) throw new FinanceNotFound();
    if (inv.status !== "draft") return inv;
    const settings = await loadSettings(entity.id);
    const registered = settings.gst_qst_registered === 1;
    if (registered) {
      const reg = validateRegistration({ registered, gstNumber: settings.gst_number, qstNumber: settings.qst_number });
      if (!reg.ok) throw new FinanceInputError(reg.error);
    }
    const lines = await loadInvoiceLines(invoiceId);
    const totals = totalsFromStoredLines(
      lines.map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unitPriceCents: l.unit_price_cents, taxable: l.taxable === 1 })),
      { registered },
    );
    if (totals.totalCents <= 0) throw new FinanceInputError("an invoice total must be greater than zero");
    const year = Number(torontoToday().slice(0, 4));
    const alloc = allocateInvoiceNumber(
      { prefix: settings.invoice_prefix, nextNumber: settings.invoice_next_number, numberYear: settings.invoice_number_year },
      year,
    );
    const finalized: InvoiceRow = {
      ...inv,
      number: alloc.number,
      subtotal_cents: totals.subtotalCents,
      gst_cents: totals.gstCents,
      qst_cents: totals.qstCents,
      total_cents: totals.totalCents,
      tax_registered_snapshot: registered ? 1 : 0,
    };
    const recognition = await buildRecognitionPosting(finalized, lines, viewerLabel(viewer), {
      sql: `(SELECT status FROM fin_invoices WHERE id = ?) = 'draft'`,
      args: [invoiceId],
    });
    try {
      await writeBatch([
        {
          sql: `UPDATE fin_settings SET invoice_next_number = ?, invoice_number_year = ?
                 WHERE entity_id = ? AND invoice_next_number = ? AND COALESCE(invoice_number_year, -1) = ?`,
          args: [alloc.nextNumber, alloc.numberYear, entity.id, settings.invoice_next_number, settings.invoice_number_year ?? -1],
        },
        ...recognition.statements,
        {
          sql: `UPDATE fin_invoices SET number = ?, status = 'sent', subtotal_cents = ?, gst_cents = ?, qst_cents = ?, total_cents = ?,
                       tax_registered_snapshot = ?, recognition_entry_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id = ? AND status = 'draft' AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
          args: [alloc.number, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, registered ? 1 : 0, recognition.entryId, invoiceId, recognition.entryId],
        },
        auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.issued", objectType: "invoice", objectId: invoiceId, detail: { number: alloc.number, total: totals.totalCents } }),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) continue; // lost a numbering race: re-read settings and try again
      throw e;
    }
    const after = await loadInvoice(invoiceId);
    if (after && after.status !== "draft") return after;
  }
  throw new Error("could not allocate an invoice number after 3 attempts");
}

/** Create (once) the Stripe Payment Link for an issued invoice. */
export async function ensurePaymentLink(inv: InvoiceRow): Promise<string> {
  if (inv.stripe_payment_link_url) return inv.stripe_payment_link_url;
  if (!inv.number) throw new FinanceInputError("issue the invoice before creating its payment link");
  const { key } = await getStripeClient();
  const due = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  if (due <= 0) throw new FinanceInputError("nothing is due on this invoice");
  const price = await stripeRequest(
    key,
    "POST",
    "/v1/prices",
    {
      currency: inv.currency.toLowerCase(),
      unit_amount: due,
      "product_data[name]": `Invoice ${inv.number}`,
      "metadata[fin_invoice_id]": inv.id,
    },
    { idempotencyKey: `fin-price-${inv.id}-${due}-${inv.currency}` },
  );
  const priceId = typeof price.id === "string" ? price.id : "";
  if (!priceId.startsWith("price_")) throw new Error("Stripe did not return a price id");
  if (price.livemode !== true) throw new FinanceInputError("the Stripe key is in test mode; refusing to email a test payment link to a real customer");
  const link = await stripeRequest(
    key,
    "POST",
    "/v1/payment_links",
    {
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      "metadata[fin_invoice_id]": inv.id,
      "metadata[fin_entity_id]": inv.entity_id,
      "metadata[fin_invoice_number]": inv.number,
      "payment_intent_data[metadata][fin_invoice_id]": inv.id,
      "payment_intent_data[metadata][fin_entity_id]": inv.entity_id,
      "payment_intent_data[metadata][fin_invoice_number]": inv.number,
      "restrictions[completed_sessions][limit]": 1,
      "after_completion[type]": "hosted_confirmation",
      "after_completion[hosted_confirmation][custom_message]": `Thank you — payment for invoice ${inv.number} received.`,
    },
    { idempotencyKey: `fin-plink-${inv.id}-${priceId}` },
  );
  const linkId = typeof link.id === "string" ? link.id : "";
  const url = typeof link.url === "string" ? link.url : "";
  if (!linkId.startsWith("plink_") || !url.startsWith("https://")) throw new Error("Stripe did not return a payment link");
  await finDb().execute({
    sql: `UPDATE fin_invoices SET stripe_price_id = ?, stripe_payment_link_id = ?, stripe_payment_link_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    args: [priceId, linkId, url, inv.id],
  });
  return url;
}

export type SendResult = { invoiceId: string; number: string; emailedTo: string; paymentLinkUrl: string | null; messageId: string };

/**
 * Finalise (if draft), attach a payment link (unless explicitly declined),
 * render the PDF and email it from the OASIS mailbox. Every failure throws:
 * the caller sees it and nothing pretends the customer was emailed.
 */
export async function sendInvoice(
  viewer: FinanceViewer,
  invoiceId: string,
  opts: { to?: string; paymentLink?: boolean } = {},
): Promise<SendResult> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  businessOnly(entity);
  const before = await loadInvoice(invoiceId);
  if (!before) throw new FinanceNotFound();
  if (before.status === "void" || before.status === "paid") throw new FinanceInputError(`a ${before.status} invoice cannot be sent`);
  const contact = await loadContact(before.contact_id);
  const to = opts.to ? validateEmail(opts.to) : contact?.email ? validateEmail(contact.email) : null;
  if (!to) throw new FinanceInputError("the customer has no valid email address; add one or enter a recipient");
  let inv = await finalizeInvoice(viewer, invoiceId);
  let url: string | null = inv.stripe_payment_link_url;
  if (opts.paymentLink !== false && !url) {
    url = await ensurePaymentLink(inv);
    inv = (await loadInvoice(invoiceId)) as InvoiceRow;
  }
  const settings = await loadSettings(entity.id);
  const lines = await loadInvoiceLines(invoiceId);
  const pdf = await pdfFor(inv, lines, contact, settings);
  const mail = composeInvoiceEmail({
    kind: "invoice",
    sellerName: settings.legal_name,
    customerName: contact?.name || "",
    number: inv.number as string,
    totalCents: inv.total_cents,
    balanceCents: balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents }),
    currency: inv.currency,
    dueDate: inv.due_date,
    paymentLinkUrl: opts.paymentLink === false ? null : url,
    paymentInstructions: settings.payment_instructions,
  });
  const sent = await sendInvoiceEmail({ tenantId: financeTenantId(), to, ...mail, pdf, filename: `${inv.number}.pdf` });
  await writeBatch([
    { sql: `UPDATE fin_invoices SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), sent_to = ? WHERE id = ?`, args: [to, invoiceId] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.emailed", objectType: "invoice", objectId: invoiceId, detail: { to, from: sent.from, link: Boolean(url) } }),
  ]);
  return { invoiceId, number: inv.number as string, emailedTo: to, paymentLinkUrl: opts.paymentLink === false ? null : url, messageId: sent.messageId };
}

// ── manual payment ───────────────────────────────────────────────────────

/**
 * Record an e-transfer / cheque / wire against an invoice. One fin_payments
 * row (source manual) + one settlement entry, atomically. The amount is in
 * the invoice's currency; for a USD invoice `received_cad` is what landed in
 * CAD (else it is estimated at the payment day's Bank of Canada rate and
 * flagged as estimated).
 */
export async function markInvoicePaidManually(viewer: FinanceViewer, invoiceId: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  businessOnly(entity);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  const status = effectiveInvoiceStatus({ status: inv.status, dueDate: inv.due_date, totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents }, torontoToday());
  if (status !== "sent" && status !== "overdue") throw new FinanceInputError(`a ${status} invoice cannot take a payment${status === "draft" ? " — issue it first" : ""}`);
  const due = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  const amount = raw.amount === undefined || raw.amount === "" ? due : parseMoneyToCents(raw.amount as string | number);
  if (amount === null || amount <= 0) throw new FinanceInputError("payment amount must be greater than zero");
  if (amount > due) throw new FinanceInputError(`payment is more than the balance due (${due} cents)`);
  const date = text(raw.date, 10) || torontoToday();
  if (!isIsoDate(date)) throw new FinanceInputError("payment date must be YYYY-MM-DD");
  const depositId = text(raw.deposit_account_id, 120) || accountId(entity.id, SYS.chequing);
  const deposit = await queryOne<{ subtype: string }>(`SELECT subtype FROM fin_accounts WHERE id = ? AND entity_id = ?`, [depositId, entity.id]);
  if (!deposit || !CASH_SUBTYPES.has(deposit.subtype)) throw new FinanceInputError("deposit account must be a bank or cash account of this book");
  let receivedCad: number;
  let estimated = 0;
  if (inv.currency === "CAD") receivedCad = amount;
  else if (raw.received_cad !== undefined && raw.received_cad !== "") {
    const r = parseMoneyToCents(raw.received_cad as string | number);
    if (r === null || r <= 0) throw new FinanceInputError("CAD received must be greater than zero");
    receivedCad = r;
  } else {
    const rate = await usdCadRate(date);
    if (!rate) throw new FinanceInputError("no Bank of Canada rate for that date yet; enter the CAD amount received");
    receivedCad = usdToCadCents(amount, rate.micro);
    estimated = 1;
  }
  const contact = await loadContact(inv.contact_id);
  const paymentId = newId("pay");
  const posting = await buildSettlementPosting({
    inv,
    amountCents: amount,
    receivedCadCents: receivedCad,
    debitAccountId: depositId,
    date,
    source: "invoice_payment",
    sourceRef: paymentId,
    memo: `Payment for invoice ${inv.number}${text(raw.reference, 60) ? ` (${text(raw.reference, 60)})` : ""}`,
    createdBy: viewerLabel(viewer),
  });
  await writeBatch([
    {
      sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents,
              fee_status, settlement_estimated, invoice_id, contact_id, customer_name, customer_email, deposit_account_id, description, livemode, created_by)
            VALUES (?, ?, 'payment', 'manual', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [paymentId, entity.id, `${date}T12:00:00.000Z`, date, amount, inv.currency, receivedCad, estimated, inv.id, inv.contact_id, contact?.name || "", contact?.email || "", depositId, text(raw.reference, 200) || "Manual payment", viewerLabel(viewer)],
    },
    ...posting.statements,
    { sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ?`, args: [posting.entryId, paymentId] },
    recomputeInvoicePaidStatement(inv.id, new Date().toISOString()),
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.paid_manually", objectType: "invoice", objectId: inv.id, detail: { amount, receivedCad, estimated: estimated === 1 } }),
  ]);
  await deactivatePaymentLinkIfPaid(inv.id).catch((e) => console.error("[finances:invoices] link deactivate failed", e instanceof Error ? e.message : e));
  return paymentId;
}

// ── void, overdue, reminders ─────────────────────────────────────────────

export async function voidInvoice(viewer: FinanceViewer, invoiceId: string): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  if (!canTransition(inv.status, "void")) throw new FinanceInputError(`a ${inv.status} invoice cannot be voided`);
  if (inv.amount_paid_cents > 0) throw new FinanceInputError("this invoice has payments; refund them before voiding");
  const statements: InStatement[] = [];
  if (inv.recognition_entry_id) {
    const rev = await buildReversal({ entityId: entity.id, entryId: inv.recognition_entry_id, date: torontoToday(), memo: `Void invoice ${inv.number}`, createdBy: viewerLabel(viewer) });
    statements.push(...rev.statements);
  }
  statements.push(
    { sql: `UPDATE fin_invoices SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = ? AND amount_paid_cents = 0`, args: [invoiceId, inv.status] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.voided", objectType: "invoice", objectId: invoiceId }),
  );
  await writeBatch(statements);
  await deactivatePaymentLinkIfPaid(invoiceId, true).catch((e) => console.error("[finances:invoices] link deactivate failed", e instanceof Error ? e.message : e));
}

/** Persist overdue status for issued, unpaid invoices past their due date. */
export async function sweepOverdue(entityId: string): Promise<number> {
  const rs = await finDb().execute({
    sql: `UPDATE fin_invoices SET status = 'overdue', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE entity_id = ? AND status = 'sent' AND due_date < ? AND amount_paid_cents < total_cents`,
    args: [entityId, torontoToday()],
  });
  return rs.rowsAffected;
}

export type ReminderPlan = {
  invoice_id: string;
  number: string | null;
  to: string | null;
  balance_cents: number;
  currency: string;
  due_date: string;
  days_overdue: number;
  action: "would_send" | "sent" | "skipped" | "failed";
  reason: string | null;
};

/**
 * Overdue reminders for the business book. Returns what it WOULD send; sends
 * only when `send` is exactly true. Skips an invoice reminded within
 * `minDaysBetween` days so a retried call cannot spam a client.
 */
export async function remindOverdue(viewer: FinanceViewer, opts: { send: boolean; minDaysBetween?: number }): Promise<ReminderPlan[]> {
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  await sweepOverdue(entity.id);
  const today = torontoToday();
  const minDays = Math.max(1, opts.minDaysBetween ?? 3);
  const rows = await query<InvoiceRow & { contact_name: string; contact_email: string }>(
    `SELECT i.*, c.name AS contact_name, c.email AS contact_email FROM fin_invoices i JOIN fin_contacts c ON c.id = i.contact_id
      WHERE i.entity_id = ? AND i.status = 'overdue' ORDER BY i.due_date`,
    [entity.id],
  );
  const settings = await loadSettings(entity.id);
  const plans: ReminderPlan[] = [];
  for (const r of rows) {
    const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.due_date}T00:00:00Z`)) / 86_400_000);
    const to = validateEmail(r.contact_email);
    const plan: ReminderPlan = {
      invoice_id: r.id,
      number: r.number,
      to,
      balance_cents: balanceDueCents({ totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents }),
      currency: r.currency,
      due_date: r.due_date,
      days_overdue: days,
      action: "would_send",
      reason: null,
    };
    const recent = r.last_reminded_at && Date.parse(r.last_reminded_at) > Date.now() - minDays * 86_400_000;
    if (!to) {
      plan.action = "skipped";
      plan.reason = "customer has no valid email";
    } else if (recent) {
      plan.action = "skipped";
      plan.reason = `reminded within the last ${minDays} days`;
    } else if (opts.send === true) {
      try {
        const lines = await loadInvoiceLines(r.id);
        const contact = await loadContact(r.contact_id);
        const pdf = await pdfFor(r, lines, contact, settings);
        const mail = composeInvoiceEmail({
          kind: "reminder",
          sellerName: settings.legal_name,
          customerName: r.contact_name,
          number: r.number || "",
          totalCents: r.total_cents,
          balanceCents: plan.balance_cents,
          currency: r.currency,
          dueDate: r.due_date,
          paymentLinkUrl: r.stripe_payment_link_url,
          paymentInstructions: settings.payment_instructions,
        });
        await sendInvoiceEmail({ tenantId: financeTenantId(), to, ...mail, pdf, filename: `${r.number}.pdf` });
        await writeBatch([
          { sql: `UPDATE fin_invoices SET last_reminded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reminder_count = reminder_count + 1 WHERE id = ?`, args: [r.id] },
          auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.reminder_sent", objectType: "invoice", objectId: r.id, detail: { to } }),
        ]);
        plan.action = "sent";
      } catch (e) {
        plan.action = "failed";
        plan.reason = e instanceof Error ? e.message.slice(0, 300) : "send failed";
      }
    }
    plans.push(plan);
  }
  return plans;
}
