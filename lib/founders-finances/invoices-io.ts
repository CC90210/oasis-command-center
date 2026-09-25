/**
 * Invoicing: contacts, drafts, finalise + send (number, recognition entry,
 * Stripe Payment Link, PDF, email), manual payment, void, overdue sweep and
 * reminders. Business entity only — the personal books do not invoice.
 *
 * Status flow: draft -> sent -> (overdue) -> paid, or -> void. "sent" means
 * ISSUED (numbered, receivable recognised); sent_at records the successful
 * email. Sending makes every Stripe link the email needs, checks Wise and the
 * mailbox BEFORE the draft is numbered, so a refusal (a key without Prices /
 * Payment Links write, no way to pay, no mailbox) leaves a draft. Only the
 * email itself can fail after issue: that invoice shows as "issued, not
 * emailed" and can be re-sent without re-numbering.
 *
 * HOW THE CLIENT PAYS (payment_method, migration 184): "wise" prints the Wise
 * receiving details for the invoice currency with the invoice number as the
 * payment reference (the default for a new one-off invoice); "stripe" attaches
 * a card Payment Link (every invoice from before 184); "wise_stripe" offers
 * both. A Wise invoice whose details cannot be read (not connected, Wise down)
 * still goes out — with the card link, or the founders' payment instructions
 * — and the send result says why.
 *
 * ONE-TIME + MONTHLY RETAINER (migration 185). A line is billed once (the
 * implementation price) or monthly (the retainer). The invoice's receivable,
 * "due now", paid and overdue are the ONE-TIME part only, paid as above. The
 * monthly part is paid by a Stripe RECURRING Payment Link (ensureRetainerLink)
 * the client uses to start automatic monthly card payments; it is never
 * booked at issue — each month's charge reaches the books through the Stripe
 * ingest as subscription revenue — so a retainer is counted once. An invoice
 * may be all one-time (as before 185), all monthly (nothing due now: a
 * retainer set-up invoice, listed as "retainer" and never counted as open or
 * overdue) or both. Without a live retainer link an invoice with a retainer is
 * never emailed: the retainer would have no way to be paid. A stored link is
 * checked with Stripe before every send; a dead one is never emailed. Overdue
 * reminders chase the one-time balance only: no retainer in the email or PDF.
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
  hasAmountDueNow as hasAmountDueNowRule,
  invoiceListStatus,
  parseLineBilling,
  retainerTaxRefusal,
  storedLineBilling,
  totalsFromStoredLines,
  validateInvoiceCurrency,
  type InvoiceLineInput,
  type InvoiceListStatus,
  type InvoiceStatus,
  type InvoiceTotals,
  type LineBilling,
} from "./invoice";
import { isIsoDate, torontoToday, usdToCadCents } from "./fx";
import { formatCents, parseMoneyToCents } from "./money";
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
  paymentMethodColumnReady,
  recomputeInvoicePaidStatement,
  retainerColumnsReady,
  retainerMonthlyCents,
  type ContactRow,
  type InvoiceLineRow,
  type InvoiceRow,
} from "./invoice-store";
import { addressLines, loadSettings } from "./settings-io";
import { renderInvoicePdf } from "./invoice-pdf";
import { composeInvoiceEmail, resolveInvoiceMailbox, sendInvoiceEmail } from "./invoice-email";
import { getStripeClient, stripeRequest, financeTenantId, StripeApiError, StripeNotReady } from "./stripe-io";
import { stripeErrorSentence } from "./http";
import {
  bankTransferLines,
  DEFAULT_NEW_INVOICE_METHOD,
  offersBankTransfer,
  offersCard,
  parsePaymentMethod,
  storedPaymentMethod,
  type InvoicePaymentMethod,
  type WiseDetailField,
  type WiseReceivingDetails,
} from "./wise";
import { receivingDetailsOrReason } from "./wise-io";
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
  lines: Array<InvoiceLineInput & { revenueAccountId: string; billing: LineBilling }>;
  /** null = not given: a new draft takes the default, an edit keeps what it had. */
  paymentMethod: InvoicePaymentMethod | null;
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
    const billingRaw = l.billing;
    const billing = billingRaw === undefined || billingRaw === null || billingRaw === "" ? "one_time" : parseLineBilling(billingRaw);
    if (!billing) throw new FinanceInputError(`line ${i + 1}: choose one-time or monthly`);
    return {
      description: text(l.description, 500),
      quantity: typeof l.quantity === "number" ? String(l.quantity) : text(l.quantity, 20) || "1",
      unitPrice: typeof l.unit_price === "number" ? (l.unit_price as number) : text(l.unit_price, 30),
      taxable: l.taxable !== false,
      revenueAccountId: acct,
      billing,
    };
  });
  let paymentMethod: InvoicePaymentMethod | null = null;
  if (raw.payment_method !== undefined && raw.payment_method !== null && raw.payment_method !== "") {
    paymentMethod = parsePaymentMethod(raw.payment_method);
    if (!paymentMethod) throw new FinanceInputError("payment method must be bank transfer (Wise), card (Stripe) or both");
  }
  return { contactId, issueDate, dueDate, currency, notes: text(raw.notes, 2000), lines, paymentMethod };
}

/**
 * The statement that stores a draft's payment method, or none. Before
 * migration 184 there is no column: asking for anything but the card flow
 * then is refused rather than silently dropped.
 */
async function paymentMethodStatement(invoiceId: string, method: InvoicePaymentMethod | null): Promise<InStatement[]> {
  if (method === null) return [];
  if (!(await paymentMethodColumnReady())) {
    if (method === "stripe") return [];
    throw new FinanceInputError("Bank transfer (Wise) isn't available on invoices yet, so choose the card link for now.");
  }
  return [{ sql: `UPDATE fin_invoices SET payment_method = ? WHERE id = ? AND status = 'draft'`, args: [method, invoiceId] }];
}

/**
 * Before migration 185 there is no billing column and no retainer: every line
 * is written exactly as before, and a monthly line is refused rather than
 * silently booked as a one-time receivable. Returns whether the columns exist.
 */
async function retainerReadyFor(lines: DraftInput["lines"]): Promise<boolean> {
  const ready = await retainerColumnsReady();
  if (!ready && lines.some((l) => l.billing === "monthly")) {
    throw new FinanceInputError("Monthly retainer lines aren't available on invoices yet (the database needs migration 185), so bill every line as one-time for now.");
  }
  return ready;
}

function lineStatements(
  invoiceId: string,
  lines: DraftInput["lines"],
  computed: ReturnType<typeof computeInvoiceTotals>,
  withBilling: boolean,
): InStatement[] {
  return computed.lines.map((l, i) =>
    withBilling
      ? {
          sql: `INSERT INTO fin_invoice_lines (id, invoice_id, line_no, description, quantity_milli, unit_price_cents, amount_cents, taxable, revenue_account_id, billing)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [newId("il"), invoiceId, i + 1, l.description, l.quantityMilli, l.unitPriceCents, l.amountCents, l.taxable ? 1 : 0, lines[i].revenueAccountId, l.billing],
        }
      : {
          sql: `INSERT INTO fin_invoice_lines (id, invoice_id, line_no, description, quantity_milli, unit_price_cents, amount_cents, taxable, revenue_account_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [newId("il"), invoiceId, i + 1, l.description, l.quantityMilli, l.unitPriceCents, l.amountCents, l.taxable ? 1 : 0, lines[i].revenueAccountId],
        },
  );
}

/** Total a draft's lines; a bad line, or a retainer that would carry GST/QST (invoice.ts RETAINER_TAX_REFUSED), is refused in a sentence. */
function draftTotals(lines: DraftInput["lines"], registered: boolean): ReturnType<typeof computeInvoiceTotals> {
  let totals;
  try {
    totals = computeInvoiceTotals(lines, { registered });
  } catch (e) {
    throw new FinanceInputError((e as Error).message);
  }
  const taxedRetainer = retainerTaxRefusal(totals);
  if (taxedRetainer) throw new FinanceInputError(taxedRetainer);
  return totals;
}

/** The draft's retainer per month (its monthly lines). Only once migration 185 is there. */
function retainerStatement(invoiceId: string, totals: ReturnType<typeof computeInvoiceTotals>, ready: boolean): InStatement[] {
  if (!ready) return [];
  return [{ sql: `UPDATE fin_invoices SET retainer_monthly_cents = ? WHERE id = ? AND status = 'draft'`, args: [totals.monthly.totalCents, invoiceId] }];
}

export async function createDraftInvoice(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  businessOnly(entity);
  const input = await parseDraftInput(entity, raw, viewer);
  const settings = await loadSettings(entity.id);
  const totals = draftTotals(input.lines, settings.gst_qst_registered === 1);
  const id = newId("inv");
  const method = input.paymentMethod ?? ((await paymentMethodColumnReady()) ? DEFAULT_NEW_INVOICE_METHOD : null);
  const retainerReady = await retainerReadyFor(input.lines);
  await writeBatch([
    {
      sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, status, issue_date, due_date, currency, subtotal_cents, gst_cents,
              qst_cents, total_cents, tax_registered_snapshot, notes, created_by)
            VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, input.contactId, input.issueDate, input.dueDate, input.currency, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, settings.gst_qst_registered, input.notes, viewerLabel(viewer)],
    },
    ...(await paymentMethodStatement(id, method)),
    ...retainerStatement(id, totals, retainerReady),
    ...lineStatements(id, input.lines, totals, retainerReady),
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.draft_created", objectType: "invoice", objectId: id, detail: { total: totals.totalCents, monthly: totals.monthly.totalCents, currency: input.currency } }),
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
  const totals = draftTotals(input.lines, settings.gst_qst_registered === 1);
  const retainerReady = await retainerReadyFor(input.lines);
  await writeBatch([
    { sql: `DELETE FROM fin_invoice_lines WHERE invoice_id = ? AND (SELECT status FROM fin_invoices WHERE id = ?) = 'draft'`, args: [invoiceId, invoiceId] },
    ...lineStatements(invoiceId, input.lines, totals, retainerReady),
    {
      sql: `UPDATE fin_invoices SET contact_id = ?, issue_date = ?, due_date = ?, currency = ?, subtotal_cents = ?, gst_cents = ?, qst_cents = ?,
                   total_cents = ?, tax_registered_snapshot = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ? AND status = 'draft'`,
      args: [input.contactId, input.issueDate, input.dueDate, input.currency, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, settings.gst_qst_registered, input.notes, invoiceId],
    },
    ...(await paymentMethodStatement(invoiceId, input.paymentMethod)),
    ...retainerStatement(invoiceId, totals, retainerReady),
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.draft_updated", objectType: "invoice", objectId: invoiceId }),
  ]);
}

// ── reads ────────────────────────────────────────────────────────────────

export type InvoiceListRow = InvoiceRow & {
  contact_name: string;
  contact_email: string;
  effective_status: InvoiceStatus;
  /**
   * What lists, filters and Atlas show: the effective status, except that an
   * issued invoice with nothing due now (retainer only) is `retainer`, never
   * an open "sent" or "overdue" one (invoice.ts invoiceListStatus).
   */
  list_status: InvoiceListStatus;
  /** The ONE-TIME balance still owed (the retainer is never a balance). */
  balance_cents: number;
  /** The monthly retainer the invoice sets up (0 = none). */
  retainer_cents: number;
  /** What this app knows locally about the retainer's link (no Stripe call): none yet, made but never emailed, or emailed. */
  retainer_link: "none" | "not_emailed" | "emailed";
};

/** The retainer link as far as the database knows (the live state needs Stripe: retainerLinkStatus). */
function localRetainerLink(r: InvoiceRow): InvoiceListRow["retainer_link"] {
  if (!r.stripe_retainer_link_url) return "none";
  return r.sent_at ? "emailed" : "not_emailed";
}

/**
 * `status` filters on list_status: "sent" and "overdue" are invoices with money
 * owed now; a retainer-only invoice is found under "retainer".
 */
export async function listInvoices(viewer: FinanceViewer, entityRef: string, status?: string): Promise<InvoiceListRow[]> {
  const entity = await requireEntity(viewer, entityRef);
  const rows = await query<InvoiceRow & { contact_name: string; contact_email: string }>(
    `SELECT i.*, c.name AS contact_name, c.email AS contact_email FROM fin_invoices i
       JOIN fin_contacts c ON c.id = i.contact_id
      WHERE i.entity_id = ? ORDER BY COALESCE(i.number, '') DESC, i.created_at DESC LIMIT 500`,
    [entity.id],
  );
  const today = torontoToday();
  const out = rows.map((r): InvoiceListRow => {
    const effective = effectiveInvoiceStatus(
      { status: r.status, dueDate: r.due_date, totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents },
      today,
    );
    return {
      ...r,
      effective_status: effective,
      list_status: invoiceListStatus(effective, hasAmountDueNow(r)),
      balance_cents: r.status === "void" ? 0 : balanceDueCents({ totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents }),
      retainer_cents: retainerMonthlyCents(r),
      retainer_link: localRetainerLink(r),
    };
  });
  return status ? out.filter((r) => r.list_status === status) : out;
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
  const effectiveStatus = effectiveInvoiceStatus(
    { status: inv.status, dueDate: inv.due_date, totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents },
    torontoToday(),
  );
  return {
    entity,
    invoice: inv,
    effectiveStatus,
    /** What the page labels it: `retainer` for an issued invoice with nothing due now (never "open"). */
    listStatus: invoiceListStatus(effectiveStatus, hasAmountDueNow(inv)),
    lines,
    contact,
    payments,
    settings,
    paymentMethod: storedPaymentMethod(inv.payment_method),
    /** The monthly retainer (0 = none) and its Stripe recurring link once created. */
    retainerMonthlyCents: retainerMonthlyCents(inv),
    retainerLinkUrl: inv.stripe_retainer_link_url || null,
  };
}

/**
 * The invoice PDF a founder downloads or previews. Once the retainer's link
 * exists its live state is asked of Stripe first, so the PDF never prints a
 * dead link: used -> "already set up"; switched off, or state unknown -> no
 * link printed.
 */
export async function invoicePdfBytes(viewer: FinanceViewer, invoiceId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const d = await getInvoiceDetail(viewer, invoiceId);
  const [wise, link] = await Promise.all([bankTransferFor(d.invoice), retainerLinkStatus(d.invoice)]);
  const printable = link.state === "active" && !link.stale ? d.invoice : { ...d.invoice, stripe_retainer_link_url: null };
  return {
    bytes: await pdfFor(printable, d.lines, d.contact, d.settings, { bankTransfer: wise.lines, retainerSetUp: link.state === "used" && !link.stale }),
    filename: `${d.invoice.number || "DRAFT"}.pdf`,
  };
}

/**
 * Whether Wise can supply the receiving details, asked BEFORE the invoice is
 * numbered (sendInvoice decides from it whether a card link is needed as the
 * fallback). `notice` says why they are missing when they should be there
 * (Wise not connected, unreachable) — the invoice still goes out without them.
 */
async function wiseDetailsFor(inv: InvoiceRow): Promise<{ details: WiseReceivingDetails | null; notice: string | null }> {
  if (!offersBankTransfer(storedPaymentMethod(inv.payment_method))) return { details: null, notice: null };
  // A retainer-only invoice has nothing to pay by transfer: its retainer is paid by card through Stripe.
  if (!hasAmountDueNow(inv)) return { details: null, notice: null };
  const r = await receivingDetailsOrReason(inv.currency);
  if (!r.ok) return { details: null, notice: r.reason };
  return { details: r.details, notice: null };
}

/** The Wise rows an invoice prints, its number as the payment reference (a draft preview says it is assigned when issued). */
function wiseLines(details: WiseReceivingDetails | null, inv: InvoiceRow): WiseDetailField[] | null {
  return details ? bankTransferLines(details, inv.number || "the invoice number (assigned when issued)") : null;
}

/** The Wise lines an invoice prints, when its method offers a bank transfer (previews, reminders). */
async function bankTransferFor(inv: InvoiceRow): Promise<{ lines: WiseDetailField[] | null; notice: string | null }> {
  const w = await wiseDetailsFor(inv);
  return { lines: wiseLines(w.details, inv), notice: w.notice };
}

/** invoice.ts hasAmountDueNow() for a stored row: false only for a retainer-only invoice. */
function hasAmountDueNow(inv: InvoiceRow): boolean {
  return hasAmountDueNowRule({ totalCents: inv.total_cents, retainerMonthlyCents: retainerMonthlyCents(inv) });
}

/** Re-total stored lines (one-time and monthly apart) under the given registration. */
function storedTotals(lines: readonly InvoiceLineRow[], registered: boolean) {
  return totalsFromStoredLines(
    lines.map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unitPriceCents: l.unit_price_cents, taxable: l.taxable === 1, billing: storedLineBilling(l.billing) })),
    { registered },
  );
}

/** Stop a Stripe Payment Link taking new checkouts. */
async function switchOffPaymentLink(key: string, linkId: string): Promise<void> {
  await stripeRequest(key, "POST", `/v1/payment_links/${encodeURIComponent(linkId)}`, { active: "false" });
}

/**
 * The retainer block the PDF prints (null = no retainer: the PDF is exactly
 * what it was before 185). `setUp`: Stripe says the client already started the
 * subscription, so the PDF says so instead of printing the used-up link.
 */
function retainerForPdf(inv: InvoiceRow, lines: readonly InvoiceLineRow[], setUp: boolean) {
  const monthlyCents = retainerMonthlyCents(inv);
  if (monthlyCents <= 0) return null;
  const monthly = storedTotals(lines, inv.tax_registered_snapshot === 1).monthly;
  return {
    subtotalCents: monthly.subtotalCents,
    gstCents: monthly.gstCents,
    qstCents: monthly.qstCents,
    totalCents: monthlyCents,
    linkUrl: inv.stripe_retainer_link_url || null,
    ...(setUp ? { setUp: true } : {}),
  };
}

/**
 * `oneTimeOnly` (overdue reminders): the PDF chases the one-time balance and
 * nothing else — the monthly lines, the retainer totals and the retainer's
 * section and link are left off, so what is printed adds up to what is owed.
 */
async function pdfFor(
  inv: InvoiceRow,
  allLines: InvoiceLineRow[],
  contact: ContactRow | null,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  opts: { bankTransfer?: WiseDetailField[] | null; retainerSetUp?: boolean; oneTimeOnly?: boolean } = {},
): Promise<Uint8Array> {
  const bankTransfer = opts.bankTransfer ?? null;
  const lines = opts.oneTimeOnly ? allLines.filter((l) => storedLineBilling(l.billing) === "one_time") : allLines;
  const retainer = opts.oneTimeOnly ? null : retainerForPdf(inv, allLines, opts.retainerSetUp === true);
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
      // A retainer-only invoice asks for nothing by transfer: the instructions would only confuse.
      paymentInstructions: hasAmountDueNow(inv) ? settings.payment_instructions : "",
      bankTransfer,
      ...(retainer ? { retainer } : {}),
    },
    customer: { name: contact?.name || "", company: contact?.company || "", email: contact?.email || "", address: contact?.address || "" },
    lines: lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantity_milli,
      unitPriceCents: l.unit_price_cents,
      amountCents: l.amount_cents,
      ...(storedLineBilling(l.billing) === "monthly" ? { monthly: true } : {}),
    })),
  });
}

// ── finalise + send ──────────────────────────────────────────────────────

/**
 * The totals a draft is issued with — re-totalled under the CURRENT GST/QST
 * registration — and every refusal issuing makes. finalizeInvoice uses it, and
 * sendInvoice runs it first so that nothing (no Stripe link, no number) is made
 * for an invoice that would be refused.
 */
async function issueTotals(entityId: string, lines: readonly InvoiceLineRow[]): Promise<{ settings: Awaited<ReturnType<typeof loadSettings>>; registered: boolean; totals: InvoiceTotals }> {
  const settings = await loadSettings(entityId);
  const registered = settings.gst_qst_registered === 1;
  if (registered) {
    const reg = validateRegistration({ registered, gstNumber: settings.gst_number, qstNumber: settings.qst_number });
    if (!reg.ok) throw new FinanceInputError(reg.error);
  }
  const totals = storedTotals(lines, registered);
  // Re-checked here: registration may have been switched on after the draft was saved.
  const taxedRetainer = retainerTaxRefusal(totals);
  if (taxedRetainer) throw new FinanceInputError(taxedRetainer);
  if (totals.totalCents <= 0 && totals.monthly.totalCents <= 0) throw new FinanceInputError("an invoice total must be greater than zero");
  return { settings, registered, totals };
}

/**
 * What sendInvoice made the Stripe links for: finalising anything else is
 * refused (the invoice stays a draft). `cardLinkVerified`: the card link now on
 * the row was checked by this send for exactly this amount, so it is kept.
 */
type IssueExpectation = { totalCents: number; monthlyCents: number; currency: string; contactId: string; cardLinkVerified: boolean };

export const ISSUE_CHANGED_DURING_SEND =
  "This invoice changed while it was being sent (its lines, customer or currency, or the GST/QST settings, were edited at the same moment), so it was not issued and nothing was emailed: open it again and send it.";

/**
 * Number the draft, re-total it under current registration, recognise the
 * receivable. Atomic. `expect` (from sendInvoice): the amounts, currency and
 * customer the invoice's Stripe links were made for — if the draft no longer
 * matches them it is not issued, so a link is never emailed for another amount.
 */
export async function finalizeInvoice(viewer: FinanceViewer, invoiceId: string, expect?: IssueExpectation): Promise<InvoiceRow> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  businessOnly(entity);
  let droppedCardLink: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const inv = await loadInvoice(invoiceId);
    if (!inv) throw new FinanceNotFound();
    if (inv.status !== "draft") return inv;
    const lines = await loadInvoiceLines(invoiceId);
    const { settings, registered, totals } = await issueTotals(entity.id, lines);
    if (
      expect &&
      (expect.totalCents !== totals.totalCents || expect.monthlyCents !== totals.monthly.totalCents || expect.currency !== inv.currency || expect.contactId !== inv.contact_id)
    ) {
      throw new FinanceInputError(ISSUE_CHANGED_DURING_SEND);
    }
    // A monthly line can only exist once migration 185 is there, so its columns are too.
    const hasMonthly = lines.some((l) => storedLineBilling(l.billing) === "monthly");
    // A card link made on the draft that this issue did not verify (Issue without emailing, or a send that no
    // longer attaches it) may charge another amount: it is dropped, so no later send or reminder hands it out.
    const dropCardLink = inv.stripe_payment_link_id && !expect?.cardLinkVerified ? inv.stripe_payment_link_id : null;
    if (dropCardLink) droppedCardLink = dropCardLink;
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
    // The receivable is the ONE-TIME part. A retainer-only invoice books
    // nothing at issue: its revenue arrives with each Stripe charge.
    const recognition =
      totals.totalCents > 0
        ? await buildRecognitionPosting(finalized, lines, viewerLabel(viewer), {
            sql: `(SELECT status FROM fin_invoices WHERE id = ?) = 'draft'`,
            args: [invoiceId],
          })
        : null;
    try {
      await writeBatch([
        {
          sql: `UPDATE fin_settings SET invoice_next_number = ?, invoice_number_year = ?
                 WHERE entity_id = ? AND invoice_next_number = ? AND COALESCE(invoice_number_year, -1) = ?`,
          args: [alloc.nextNumber, alloc.numberYear, entity.id, settings.invoice_next_number, settings.invoice_number_year ?? -1],
        },
        ...(recognition ? recognition.statements : []),
        ...(hasMonthly
          ? [{ sql: `UPDATE fin_invoices SET retainer_monthly_cents = ? WHERE id = ? AND status = 'draft'`, args: [totals.monthly.totalCents, invoiceId] }]
          : []),
        ...(dropCardLink
          ? [{ sql: `UPDATE fin_invoices SET stripe_price_id = NULL, stripe_payment_link_id = NULL, stripe_payment_link_url = NULL WHERE id = ? AND status = 'draft'`, args: [invoiceId] }]
          : []),
        recognition
          ? {
              sql: `UPDATE fin_invoices SET number = ?, status = 'sent', subtotal_cents = ?, gst_cents = ?, qst_cents = ?, total_cents = ?,
                           tax_registered_snapshot = ?, recognition_entry_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = ? AND status = 'draft' AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
              args: [alloc.number, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, registered ? 1 : 0, recognition.entryId, invoiceId, recognition.entryId],
            }
          : {
              sql: `UPDATE fin_invoices SET number = ?, status = 'sent', subtotal_cents = ?, gst_cents = ?, qst_cents = ?, total_cents = ?,
                           tax_registered_snapshot = ?, recognition_entry_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = ? AND status = 'draft'`,
              args: [alloc.number, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, registered ? 1 : 0, invoiceId],
            },
        auditStatement({
          entityId: entity.id,
          actor: viewerLabel(viewer),
          action: "invoice.issued",
          objectType: "invoice",
          objectId: invoiceId,
          detail: { number: alloc.number, total: totals.totalCents, ...(hasMonthly ? { monthly: totals.monthly.totalCents } : {}) },
        }),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) continue; // lost a numbering race: re-read settings and try again
      throw e;
    }
    const after = await loadInvoice(invoiceId);
    if (after && after.status !== "draft") {
      if (droppedCardLink) await switchOffUnsentLink(invoiceId, droppedCardLink);
      return after;
    }
  }
  throw new Error("could not allocate an invoice number after 3 attempts");
}

/** What the client reads after paying the one-time card link. */
function cardThanks(number: string | null): string {
  return number ? `Thank you — payment for invoice ${number} received.` : "Thank you — your payment was received.";
}

/** What the client reads after starting the retainer subscription. */
function retainerThanks(number: string | null): string {
  return number
    ? `Thank you — your monthly retainer (invoice ${number}) is set up. Your card will be charged automatically each month.`
    : "Thank you — your monthly retainer is set up. Your card will be charged automatically each month.";
}

/** What an old email's retainer link shows once it has been used, replaced or the invoice voided. */
function retainerInactive(number: string | null): string {
  return `This link for the monthly retainer${number ? ` on invoice ${number}` : ""} is no longer active. If you already set up your monthly card payments with it, there is nothing more to do. Otherwise, reply to the invoice email for a new link.`;
}

/** How many checkouts completed on a payment link (null = Stripe doesn't say: the one-checkout limit was removed). */
function completedSessions(link: Record<string, unknown>): number | null {
  const restrictions = link.restrictions && typeof link.restrictions === "object" ? (link.restrictions as Record<string, unknown>) : null;
  const completed =
    restrictions?.completed_sessions && typeof restrictions.completed_sessions === "object" ? (restrictions.completed_sessions as Record<string, unknown>) : null;
  const n = completed ? Number(completed.count) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export const DRAFT_CARD_LINK_USED =
  "Someone already paid with this invoice's card link before the invoice was issued, so a new link could charge them twice: find that payment in Stripe → Payments and record it before sending. Nothing was emailed.";
export const DRAFT_CARD_LINK_UNKNOWN =
  "Stripe no longer reports whether this invoice's card link was used (its one-payment limit was removed in Stripe), so the app can't tell whether the client already paid with it: check Stripe → Payments, set the link's payment limit back to 1 in Stripe → Payment links, then send again. Nothing was emailed.";

/**
 * A card link made while the invoice was still a draft: never emailed, and the
 * draft may have changed since. Reused only while Stripe says it is live,
 * unused and for exactly the amount and currency due now.
 */
async function draftCardLinkReusable(key: string, inv: InvoiceRow, due: number): Promise<boolean> {
  const link = await stripeRequest(key, "GET", `/v1/payment_links/${encodeURIComponent(inv.stripe_payment_link_id as string)}`);
  const used = completedSessions(link);
  if (used === null) throw new FinanceInputError(DRAFT_CARD_LINK_UNKNOWN);
  if (used > 0) throw new FinanceInputError(DRAFT_CARD_LINK_USED);
  if (link.active !== true || !inv.stripe_price_id) return false;
  const price = await stripeRequest(key, "GET", `/v1/prices/${encodeURIComponent(inv.stripe_price_id)}`);
  return Number(price.unit_amount) === due && String(price.currency || "").toUpperCase() === inv.currency;
}

/**
 * Create (once) the Stripe card Payment Link for the invoice's one-time amount
 * due. sendInvoice asks for it BEFORE the invoice is numbered, so a key that
 * can't make it leaves a draft — never an issued, booked invoice nobody was
 * sent. A link made on a draft carries the invoice id (and the entity) in its
 * metadata — all the Stripe ingest reads — and its number is added once the
 * invoice is issued (numberPaymentLinks). Its price's product is named
 * "Invoice dated {issue date}": renaming it afterwards would need Products
 * write, which the card flow does not otherwise ask of the key, so it stays.
 *
 * An issued invoice's link is reused as it is: its amount was fixed at issue
 * (finalizeInvoice drops a draft link it did not verify). A draft's link is
 * reused only while Stripe says it is live, unused and for exactly this amount
 * (draftCardLinkReusable); otherwise a new one replaces it and the old one —
 * never emailed — is switched off.
 */
export async function ensurePaymentLink(inv: InvoiceRow): Promise<string> {
  if (inv.status !== "draft" && inv.stripe_payment_link_url) return inv.stripe_payment_link_url;
  const due = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  if (due <= 0) throw new FinanceInputError("nothing is due on this invoice");
  const { key } = await getStripeClient();
  let replacing: string | null = null;
  if (inv.stripe_payment_link_id) {
    if (inv.stripe_payment_link_url && (await draftCardLinkReusable(key, inv, due))) return inv.stripe_payment_link_url;
    replacing = inv.stripe_payment_link_id;
  }
  // Objects made before the number exists differ in name/metadata: their own idempotency keys, so a later numbered request never collides with one.
  const draft = inv.number ? "" : "-d";
  const price = await stripeRequest(
    key,
    "POST",
    "/v1/prices",
    {
      currency: inv.currency.toLowerCase(),
      unit_amount: due,
      "product_data[name]": inv.number ? `Invoice ${inv.number}` : `Invoice dated ${inv.issue_date}`,
      "metadata[fin_invoice_id]": inv.id,
    },
    { idempotencyKey: `fin-price-${inv.id}-${due}-${inv.currency}${draft}` },
  );
  const priceId = typeof price.id === "string" ? price.id : "";
  if (!priceId.startsWith("price_")) throw new Error("Stripe did not return a price id");
  if (price.livemode !== true) throw new FinanceInputError("the Stripe key is in test mode; refusing to email a test payment link to a real customer");
  const numbered = (k: string): Record<string, string> => (inv.number ? { [k]: inv.number } : {});
  const link = await stripeRequest(
    key,
    "POST",
    "/v1/payment_links",
    {
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      "metadata[fin_invoice_id]": inv.id,
      "metadata[fin_entity_id]": inv.entity_id,
      ...numbered("metadata[fin_invoice_number]"),
      "payment_intent_data[metadata][fin_invoice_id]": inv.id,
      "payment_intent_data[metadata][fin_entity_id]": inv.entity_id,
      ...numbered("payment_intent_data[metadata][fin_invoice_number]"),
      "restrictions[completed_sessions][limit]": 1,
      "after_completion[type]": "hosted_confirmation",
      "after_completion[hosted_confirmation][custom_message]": cardThanks(inv.number),
    },
    // + the link it replaces: going back to an earlier amount must make a NEW link, not replay the switched-off one.
    { idempotencyKey: `fin-plink-${inv.id}-${priceId}${draft}${replacing ? `-${replacing}` : ""}` },
  );
  const linkId = typeof link.id === "string" ? link.id : "";
  const url = typeof link.url === "string" ? link.url : "";
  if (!linkId.startsWith("plink_") || !url.startsWith("https://")) throw new Error("Stripe did not return a payment link");
  if (replacing && replacing !== linkId) await switchOffPaymentLink(key, replacing);
  await finDb().execute({
    sql: `UPDATE fin_invoices SET stripe_price_id = ?, stripe_payment_link_id = ?, stripe_payment_link_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    args: [priceId, linkId, url, inv.id],
  });
  return url;
}

/** The retainer's link to email, or `set_up`: the client already started the subscription with it. */
export type RetainerLink = { kind: "link"; url: string } | { kind: "set_up" };

export const RETAINER_LINK_STATE_UNKNOWN =
  "Stripe no longer reports whether the client used this invoice's retainer link (its one-payment limit was removed in Stripe), so the app can't tell whether they already subscribed and won't email that link or a new one: check the client's subscriptions in Stripe → Customers, set the link's payment limit back to 1 in Stripe → Payment links, then send again. Nothing was emailed.";

/**
 * Create (idempotently, keyed to the invoice) the Stripe RECURRING Payment
 * Link for the invoice's monthly retainer: a Product for the invoice's
 * retainer, a monthly Price for the retainer amount in the invoice currency,
 * and a Payment Link for it. sendInvoice asks for it BEFORE the invoice is
 * numbered, so on a draft it carries the invoice id only; the number is added
 * to the link once issued (numberPaymentLinks). Reused while the amount and
 * currency are the ones it was made for; replaced (the old link switched off)
 * when they change.
 *
 * Metadata ties the link and every subscription it starts back to the
 * invoice and the contact under fin_retainer_* keys — deliberately NOT
 * fin_invoice_id, which the Stripe ingest reads as "this charge settles the
 * invoice's receivable". A retainer charge is subscription revenue in its own
 * month and must never clear the one-time AR.
 *
 * A stored link is checked with Stripe before it is handed out again, so a
 * dead link is never emailed. The link allows one completed checkout, and
 * Stripe switches it off once the client has used it, so: used at this amount
 * -> `set_up` (the email says the monthly payments are already set up); used
 * at an OLD amount -> the send is refused (a new link would start a second
 * subscription and charge the client twice a month); switched off UNUSED (the
 * client has not subscribed with it) -> a fresh link replaces it; Stripe no
 * longer reporting its checkouts -> refused (RETAINER_LINK_STATE_UNKNOWN): the
 * app can't tell whether the client subscribed.
 *
 * The price is saved the moment Stripe creates it, so a send whose link Stripe
 * refuses (Prices write granted, Payment Links not) is retried with the same
 * price instead of leaving an unused recurring price behind each attempt.
 */
export async function ensureRetainerLink(inv: InvoiceRow, actor = "finances"): Promise<RetainerLink> {
  const monthly = retainerMonthlyCents(inv);
  if (monthly <= 0) throw new FinanceInputError("this invoice has no monthly retainer");
  const { key } = await getStripeClient();
  let oldIsOff = false;
  if (inv.stripe_retainer_link_id) {
    const sameAmount = Number(inv.stripe_retainer_link_cents) === monthly && inv.stripe_retainer_link_currency === inv.currency;
    const state = await retainerLinkState(key, inv.stripe_retainer_link_id);
    if (state === "unknown") throw new FinanceInputError(RETAINER_LINK_STATE_UNKNOWN);
    if (state === "used") {
      if (sameAmount) return { kind: "set_up" };
      const was = formatCents(Number(inv.stripe_retainer_link_cents), inv.stripe_retainer_link_currency || inv.currency);
      throw new FinanceInputError(
        `The client already set up monthly card payments of ${was}/month with this invoice's retainer link, so a new link would charge them twice a month: change the amount on their subscription in Stripe instead. Nothing was emailed.`,
      );
    }
    if (state === "active" && sameAmount && inv.stripe_retainer_link_url) return { kind: "link", url: inv.stripe_retainer_link_url };
    // Switched off before the client used it (nobody subscribed with it), or made for another amount: a fresh link replaces it.
    oldIsOff = state === "switched_off";
  }
  const number = inv.number || null;
  const draft = number ? "" : "-d";
  const metadata: Record<string, string> = {
    "metadata[fin_retainer_invoice_id]": inv.id,
    ...(number ? { "metadata[fin_retainer_invoice_number]": number } : {}),
  };
  let productId = inv.stripe_retainer_product_id || "";
  if (!productId) {
    const product = await stripeRequest(
      key,
      "POST",
      "/v1/products",
      { name: number ? `Monthly retainer — invoice ${number}` : `Monthly retainer (invoice dated ${inv.issue_date})`, ...metadata },
      { idempotencyKey: `fin-rprod-${inv.id}${draft}` },
    );
    productId = typeof product.id === "string" ? product.id : "";
    if (!productId.startsWith("prod_")) throw new Error("Stripe did not return a product id");
    await finDb().execute({ sql: `UPDATE fin_invoices SET stripe_retainer_product_id = ? WHERE id = ?`, args: [productId, inv.id] });
  }
  let priceId = "";
  if (inv.stripe_retainer_price_id && Number(inv.stripe_retainer_price_cents) === monthly && inv.stripe_retainer_price_currency === inv.currency) {
    priceId = inv.stripe_retainer_price_id;
  } else {
    const price = await stripeRequest(
      key,
      "POST",
      "/v1/prices",
      {
        currency: inv.currency.toLowerCase(),
        unit_amount: monthly,
        "recurring[interval]": "month",
        "recurring[interval_count]": 1,
        product: productId,
        ...metadata,
      },
      { idempotencyKey: `fin-rprice-${inv.id}-${monthly}-${inv.currency}${draft}` },
    );
    priceId = typeof price.id === "string" ? price.id : "";
    if (!priceId.startsWith("price_")) throw new Error("Stripe did not return a price id");
    if (price.livemode !== true) throw new FinanceInputError("the Stripe key is in test mode; refusing to email a test retainer link to a real customer");
    await finDb().execute({
      sql: `UPDATE fin_invoices SET stripe_retainer_price_id = ?, stripe_retainer_price_cents = ?, stripe_retainer_price_currency = ? WHERE id = ?`,
      args: [priceId, monthly, inv.currency, inv.id],
    });
  }
  const link = await stripeRequest(
    key,
    "POST",
    "/v1/payment_links",
    {
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      ...metadata,
      "subscription_data[metadata][fin_retainer_invoice_id]": inv.id,
      ...(number ? { "subscription_data[metadata][fin_retainer_invoice_number]": number } : {}),
      "subscription_data[metadata][fin_contact_id]": inv.contact_id,
      // One subscription per retainer link: a second checkout would bill the client twice a month.
      "restrictions[completed_sessions][limit]": 1,
      "after_completion[type]": "hosted_confirmation",
      "after_completion[hosted_confirmation][custom_message]": retainerThanks(number),
      inactive_message: retainerInactive(number),
    },
    // + the link it replaces: going back to an earlier amount must make a NEW link, not replay the switched-off one.
    { idempotencyKey: `fin-rplink-${inv.id}-${priceId}-${inv.stripe_retainer_link_id || "first"}${draft}` },
  );
  const linkId = typeof link.id === "string" ? link.id : "";
  const url = typeof link.url === "string" ? link.url : "";
  if (!linkId.startsWith("plink_") || !url.startsWith("https://")) throw new Error("Stripe did not return a payment link");
  // The amount changed: the old link must stop taking subscriptions at the old price before the new one is handed out.
  if (inv.stripe_retainer_link_id && inv.stripe_retainer_link_id !== linkId && !oldIsOff) {
    await switchOffPaymentLink(key, inv.stripe_retainer_link_id);
  }
  await writeBatch([
    {
      // The price is already saved (above, or on the attempt that made it).
      sql: `UPDATE fin_invoices SET stripe_retainer_link_id = ?, stripe_retainer_link_url = ?, stripe_retainer_link_cents = ?,
                   stripe_retainer_link_currency = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      args: [linkId, url, monthly, inv.currency, inv.id],
    },
    auditStatement({
      entityId: inv.entity_id,
      actor,
      action: inv.stripe_retainer_link_id ? "invoice.retainer_link_replaced" : "invoice.retainer_link_created",
      objectType: "invoice",
      objectId: inv.id,
      detail: { link: linkId, price: priceId, monthly, currency: inv.currency, replaced: inv.stripe_retainer_link_id || null, replaced_was_off: oldIsOff },
    }),
  ]);
  return { kind: "link", url };
}

type LinkState = "active" | "used" | "switched_off" | "unknown";

/**
 * Stripe's view of a retainer link already handed out: `used` once a checkout
 * completed on it (the client started the subscription; Stripe then switches
 * the one-checkout link off itself), else `active` or `switched_off`; and
 * `unknown` when Stripe no longer reports its checkouts (the one-checkout
 * limit was removed in Stripe), so whether the client subscribed can't be told.
 */
async function retainerLinkState(key: string, linkId: string): Promise<LinkState> {
  const link = await stripeRequest(key, "GET", `/v1/payment_links/${encodeURIComponent(linkId)}`);
  const used = completedSessions(link);
  if (used === null) return "unknown";
  if (used > 0) return "used";
  return link.active === true ? "active" : "switched_off";
}

/**
 * The retainer link as a founder should see it on the invoice page (and as
 * the downloadable PDF prints it): `none` until one exists; otherwise Stripe's
 * live state — `active` (the client can use it), `used` (the client has
 * subscribed; the link is spent), `switched_off` (off, never used: the next
 * send makes a fresh one) or `unknown` with the reason in a sentence. `stale`:
 * it was made for another amount or currency than the retainer now asks, so
 * the next send replaces it. Never throws.
 */
export type RetainerLinkStatus =
  | { state: "none" }
  | { state: LinkState; url: string; linkCents: number; linkCurrency: string; stale: boolean; reason: string | null };

class StripeCheckTimedOut extends Error {}

export async function retainerLinkStatus(inv: InvoiceRow, timeoutMs = 5_000): Promise<RetainerLinkStatus> {
  if (!inv.stripe_retainer_link_id || !inv.stripe_retainer_link_url) return { state: "none" };
  const linkCents = Number(inv.stripe_retainer_link_cents ?? 0);
  const linkCurrency = inv.stripe_retainer_link_currency || inv.currency;
  const base = { url: inv.stripe_retainer_link_url, linkCents, linkCurrency, stale: linkCents !== retainerMonthlyCents(inv) || linkCurrency !== inv.currency };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { key } = await getStripeClient();
    const state = await Promise.race([
      retainerLinkState(key, inv.stripe_retainer_link_id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StripeCheckTimedOut()), timeoutMs);
      }),
    ]);
    return {
      ...base,
      state,
      reason: state === "unknown" ? "Stripe no longer reports whether it was used (its one-payment limit was removed in Stripe), so the app can't tell whether the client subscribed." : null,
    };
  } catch (e) {
    console.error("[finances:invoices] could not read the retainer link's state", inv.id, e instanceof StripeApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
    let reason: string;
    if (e instanceof StripeCheckTimedOut) reason = "Stripe didn't answer in time; reload the page to check again.";
    else if (e instanceof StripeApiError) reason = stripeErrorSentence(e.status, { failed: "Stripe couldn't be asked about the link", retry: "reload this page" });
    else if (e instanceof StripeNotReady) reason = `Stripe isn't ready (${stripeNotReadyPlain(e)}), so the link's state can't be checked.`;
    else reason = "The link's state couldn't be checked; the detail is in the server log.";
    return { ...base, state: "unknown", reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Links made while the invoice was a draft carry its id only (sendInvoice
 * makes them before the number exists). Once it is issued the number is added
 * to each link's own metadata and to what the client reads after paying and
 * once the link is off — Payment Links write, the permission the send already
 * used to make them, is all this needs. Best effort: the Stripe ingest matches
 * by id, so a failure is logged and the email still goes out. Not added: the
 * number in the metadata the PAYMENT / SUBSCRIPTION itself carries (they keep
 * the invoice id) and in the product name (renaming a card link's product
 * would need Products write).
 */
async function numberPaymentLinks(inv: InvoiceRow, links: { card: string | null; retainer: string | null }): Promise<void> {
  const number = inv.number;
  if (!number || (!links.card && !links.retainer)) return;
  let key: string;
  try {
    ({ key } = await getStripeClient());
  } catch (e) {
    console.error("[finances:invoices] could not add the invoice number to its Stripe links", inv.id, e instanceof Error ? e.message : e);
    return;
  }
  const updates: Array<[string, Record<string, string>]> = [];
  if (links.card) {
    updates.push([
      links.card,
      {
        "metadata[fin_invoice_number]": number,
        "after_completion[type]": "hosted_confirmation",
        "after_completion[hosted_confirmation][custom_message]": cardThanks(number),
      },
    ]);
  }
  if (links.retainer) {
    updates.push([
      links.retainer,
      {
        "metadata[fin_retainer_invoice_number]": number,
        "after_completion[type]": "hosted_confirmation",
        "after_completion[hosted_confirmation][custom_message]": retainerThanks(number),
        inactive_message: retainerInactive(number),
      },
    ]);
  }
  for (const [linkId, params] of updates) {
    try {
      await stripeRequest(key, "POST", `/v1/payment_links/${encodeURIComponent(linkId)}`, params);
    } catch (e) {
      console.error("[finances:invoices] could not add the invoice number to a Stripe link", inv.id, linkId, e instanceof StripeApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
    }
  }
}

/** Switch off a card link that was never emailed (a draft's, dropped at issue). Best effort. */
async function switchOffUnsentLink(invoiceId: string, linkId: string): Promise<void> {
  try {
    const { key } = await getStripeClient();
    await switchOffPaymentLink(key, linkId);
  } catch (e) {
    console.error("[finances:invoices] could not switch off an unsent card link", invoiceId, linkId, e instanceof Error ? e.message : e);
  }
}

/** What the founders see when Stripe refuses to create a link: one sentence saying what to change, never a raw API error. */
export const STRIPE_LINK_REFUSED = {
  retainer:
    "Stripe won't let this app create the retainer's card link yet: give the OASIS restricted key write access to Prices and Payment Links in Stripe → Developers → API keys, then send again. Nothing was emailed.",
  card: "Stripe won't let this app create the invoice's card payment link yet: give the OASIS restricted key write access to Prices and Payment Links in Stripe → Developers → API keys, then send again. Nothing was emailed.",
} as const;

/** A StripeNotReady in words a founder can act on (an unreachable account's message carries Stripe's raw error, which stays in the log). */
function stripeNotReadyPlain(e: StripeNotReady): string {
  if (e.code === "stripe_account_unreachable") return "Stripe couldn't be reached to confirm OASIS's account — Stripe may be down, or the key was revoked or rolled";
  return e.message.replace(/[.\s]+$/, "");
}

/**
 * Any Stripe API failure while the send makes or checks a link becomes one
 * plain sentence (what failed, what to do) — a permission refusal (403: the
 * restricted key lacks a write permission) the sentence above, every other
 * status (401/404/409/429/5xx/400) stripeErrorSentence — with Stripe's own
 * message in the server log only. A retainer that cannot get its link because
 * Stripe isn't set up says so too: without the link the retainer has no way
 * to be paid. Anything else is left as it was.
 */
function refusedByStripe(e: unknown, what: keyof typeof STRIPE_LINK_REFUSED): unknown {
  const thing = what === "retainer" ? "The retainer's card link" : "The invoice's card payment link";
  if (e instanceof StripeApiError) {
    console.error(`[finances:invoices] Stripe refused the ${what} link`, e.status, e.stripeCode ?? "", e.message);
    if (e.status === 403) return new FinanceInputError(STRIPE_LINK_REFUSED[what]);
    return new FinanceInputError(stripeErrorSentence(e.status, { failed: `${thing} couldn't be set up`, retry: "send again", tail: "Nothing was emailed." }));
  }
  if (e instanceof StripeNotReady && e.code === "stripe_account_unreachable") {
    console.error(`[finances:invoices] Stripe unreachable for the ${what} link`, e.message);
    return new FinanceInputError(`${thing} couldn't be set up because ${stripeNotReadyPlain(e)}: check Finances → Settings → Stripe, then send again. Nothing was emailed.`);
  }
  if (what === "retainer" && e instanceof StripeNotReady) {
    return new FinanceInputError(`The monthly retainer is paid by card through Stripe, and Stripe isn't ready: ${stripeNotReadyPlain(e)}. Nothing was emailed.`);
  }
  return e;
}

export type SendResult = {
  invoiceId: string;
  number: string;
  emailedTo: string;
  paymentLinkUrl: string | null;
  /** The Stripe recurring link for the monthly retainer (null = no retainer, or it is already set up). */
  retainerLinkUrl: string | null;
  /** The client already started the retainer's subscription: the email says so instead of carrying the used link. */
  retainerAlreadySetUp: boolean;
  messageId: string;
  /** The email and PDF carry the Wise receiving details. */
  bankTransfer: boolean;
  /** Set when the invoice asked for a bank transfer but Wise could not supply the details — the reason, in a sentence. */
  notice: string | null;
};

/**
 * Attach the payment options the invoice's method asks for, finalise it (if
 * draft), render the PDF and email it from the OASIS mailbox. Every failure
 * throws: the caller sees it and nothing pretends the customer was emailed.
 *
 * ORDER. Everything that can refuse happens BEFORE the draft is numbered and
 * its receivable booked: the issue checks (issueTotals), every Stripe link the
 * email needs (the retainer's, and the one-off card link when the method
 * includes card), whether Wise can supply its details, "is there any way to
 * pay", and the mailbox. So a key without Prices / Payment Links write, a Wise
 * outage with no fallback, or a missing mailbox leaves a DRAFT with one plain
 * sentence — never an issued, booked invoice nobody was sent. finalizeInvoice
 * then refuses to issue anything other than what the links were made for.
 * (Once issued, only the SMTP send itself can still fail; the invoice then
 * shows "issued, not emailed" and is re-sent without renumbering.)
 *
 * Card link: attached when the method offers card (unless the sender turned
 * it off — the flow every invoice before migration 184 used, unchanged), and
 * as the fallback when a bank-transfer invoice cannot show Wise details. A
 * bank-transfer invoice with neither Wise nor Stripe nor written payment
 * instructions is refused: it would ask for money with no way to pay.
 *
 * Both of those are about the ONE-TIME amount. A monthly retainer always gets
 * its Stripe recurring link (ensureRetainerLink) first; if Stripe refuses it,
 * the send stops there with one sentence and nothing is emailed. Once the
 * client has used the link, a re-send says the retainer is set up — and a
 * retainer-only invoice then has nothing left to send, so it is refused.
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
  const lines = await loadInvoiceLines(invoiceId);
  const wasDraft = before.status === "draft";

  // 1. What the draft will be issued with (re-totalled under the current GST/QST registration). Every refusal
  //    issuing makes happens here, before Stripe is asked for anything.
  let planned: InvoiceRow = before;
  if (wasDraft) {
    const { totals } = await issueTotals(entity.id, lines);
    planned = {
      ...before,
      subtotal_cents: totals.subtotalCents,
      gst_cents: totals.gstCents,
      qst_cents: totals.qstCents,
      total_cents: totals.totalCents,
      // Before migration 185 the row has no retainer column (and no monthly line can exist).
      ...("retainer_monthly_cents" in before ? { retainer_monthly_cents: totals.monthly.totalCents } : {}),
    };
  }
  const method = storedPaymentMethod(planned.payment_method);

  // 2. Every Stripe link the email needs, made or checked while the invoice can still stay a draft.
  const retainerCents = retainerMonthlyCents(planned);
  let retainer: RetainerLink | null = null;
  if (retainerCents > 0) {
    try {
      retainer = await ensureRetainerLink(planned, viewerLabel(viewer));
    } catch (e) {
      throw refusedByStripe(e, "retainer");
    }
    if (retainer.kind === "set_up" && !hasAmountDueNow(planned)) {
      throw new FinanceInputError(
        "The client already set up the monthly card payments with this invoice's link, and nothing else is due on it, so there is nothing to send. Nothing was emailed.",
      );
    }
  }
  const dueNow = hasAmountDueNow(planned);
  const wise = await wiseDetailsFor(planned);
  const settings = await loadSettings(entity.id);
  const cardWanted = dueNow && opts.paymentLink !== false && (offersCard(method) || (offersBankTransfer(method) && !wise.details));
  let url: string | null = null;
  if (cardWanted) {
    try {
      url = await ensurePaymentLink(planned);
    } catch (e) {
      // A card invoice needs its link: that failure stays loud. The FALLBACK
      // link for a Wise invoice may be skipped when the founders wrote their
      // own payment instructions.
      if (offersCard(method) || !(e instanceof StripeNotReady)) throw refusedByStripe(e, "card");
      if (!settings.payment_instructions.trim()) {
        throw new FinanceInputError(
          `${wise.notice} Stripe is not ready either (${stripeNotReadyPlain(e)}). Add payment instructions in Finances > Settings, or connect one of them. The invoice was NOT emailed.`,
        );
      }
      url = null;
    }
  }
  if (dueNow && offersBankTransfer(method) && !wise.details && !url && !settings.payment_instructions.trim()) {
    throw new FinanceInputError(`${wise.notice} No card link and no payment instructions either, so the client would have no way to pay. The invoice was NOT emailed.`);
  }
  // 3. The mailbox it leaves from (InvoiceMailerNotConfigured, still a draft).
  await resolveInvoiceMailbox(financeTenantId());

  // 4. Only now: number it and book the receivable — exactly what the links were made for.
  const inv = await finalizeInvoice(
    viewer,
    invoiceId,
    wasDraft ? { totalCents: planned.total_cents, monthlyCents: retainerCents, currency: planned.currency, contactId: planned.contact_id, cardLinkVerified: url !== null } : undefined,
  );
  if (wasDraft) {
    await numberPaymentLinks(inv, { card: url ? inv.stripe_payment_link_id : null, retainer: retainer?.kind === "link" ? inv.stripe_retainer_link_id ?? null : null });
  }
  const retainerUrl = retainer?.kind === "link" ? retainer.url : null;
  const retainerSetUp = retainer?.kind === "set_up";
  const bankLines = wiseLines(wise.details, inv);
  // The PDF carries the card link this send verified, never another one stored on the row.
  const pdf = await pdfFor({ ...inv, stripe_payment_link_url: url }, lines, contact, settings, { bankTransfer: bankLines, retainerSetUp });
  const mail = composeInvoiceEmail({
    kind: "invoice",
    sellerName: settings.legal_name,
    customerName: contact?.name || "",
    number: inv.number as string,
    totalCents: inv.total_cents,
    balanceCents: balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents }),
    currency: inv.currency,
    dueDate: inv.due_date,
    paymentLinkUrl: url,
    paymentInstructions: dueNow ? settings.payment_instructions : "",
    bankTransfer: bankLines,
    ...(retainer
      ? { retainer: retainer.kind === "link" ? { monthlyCents: retainerCents, linkUrl: retainer.url } : { monthlyCents: retainerCents, setUp: true as const } }
      : {}),
  });
  const sent = await sendInvoiceEmail({ tenantId: financeTenantId(), to, ...mail, pdf, filename: `${inv.number}.pdf` });
  await writeBatch([
    { sql: `UPDATE fin_invoices SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), sent_to = ? WHERE id = ?`, args: [to, invoiceId] },
    auditStatement({
      entityId: entity.id,
      actor: viewerLabel(viewer),
      action: "invoice.emailed",
      objectType: "invoice",
      objectId: invoiceId,
      detail: { to, from: sent.from, link: Boolean(url), method, wise: Boolean(bankLines), notice: wise.notice, ...(retainerCents > 0 ? { retainer: retainerCents, retainer_link: Boolean(retainerUrl), retainer_set_up: retainerSetUp } : {}) },
    }),
  ]);
  return {
    invoiceId,
    number: inv.number as string,
    emailedTo: to,
    paymentLinkUrl: url,
    retainerLinkUrl: retainerUrl,
    retainerAlreadySetUp: retainerSetUp,
    messageId: sent.messageId,
    bankTransfer: Boolean(bankLines),
    notice: wise.notice,
  };
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
  if (!hasAmountDueNow(inv)) {
    throw new FinanceInputError("This invoice has nothing due now: it only sets up the monthly retainer, which the client pays by card through Stripe.");
  }
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
  await deactivateRetainerLink(inv).catch((e) => console.error("[finances:invoices] retainer link deactivate failed", e instanceof Error ? e.message : e));
}

/**
 * A voided invoice's retainer link stops taking new subscriptions. A
 * subscription the client already started keeps running: cancelling one is a
 * decision for Stripe's dashboard, not a side effect of voiding a document.
 */
async function deactivateRetainerLink(inv: InvoiceRow): Promise<void> {
  if (!inv.stripe_retainer_link_id) return;
  const { key } = await getStripeClient();
  await switchOffPaymentLink(key, inv.stripe_retainer_link_id);
}

/** Persist overdue status for issued, unpaid invoices past their due date. `total_cents` is the one-time part, so a retainer-only invoice (total 0) is never overdue. */
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
        const wise = await bankTransferFor(r);
        if (wise.notice) console.error("[finances:invoices] reminder without Wise details", r.number, wise.notice);
        // Same rule as sendInvoice: never ask for money with no way to pay.
        if (offersBankTransfer(storedPaymentMethod(r.payment_method)) && !wise.lines && !r.stripe_payment_link_url && !settings.payment_instructions.trim()) {
          throw new FinanceInputError(
            `${wise.notice || "Wise bank details are unavailable."} There is no card link or payment instructions either, so the reminder was NOT sent.`,
          );
        }
        // A reminder chases the ONE-TIME balance only: its PDF leaves off the retainer (lines, totals, section and link),
        // and composeInvoiceEmail never puts the retainer in a reminder.
        const pdf = await pdfFor(r, lines, contact, settings, { bankTransfer: wise.lines, oneTimeOnly: true });
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
          bankTransfer: wise.lines,
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
