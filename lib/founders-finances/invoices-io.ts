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
 * a card Payment Link (every invoice from before 184); "wise_stripe" is
 * Hybrid: implementation by bank plus a monthly retainer by card. A bank-mode
 * invoice whose Wise details cannot be read needs written payment instructions
 * or stays unsent; it never silently changes to a one-time card rail.
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
  invoiceDisplayState,
  invoiceListStatus,
  parseLineBilling,
  retainerTaxRefusal,
  storedLineBilling,
  totalsFromStoredLines,
  validateInvoiceCurrency,
  type InvoiceLineInput,
  type InvoiceDisplayStatus,
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
import { addressLines, loadSettings, type SettingsRow } from "./settings-io";
import { renderInvoicePdf } from "./invoice-pdf";
import { composeInvoiceEmail, resolveInvoiceMailbox, sendInvoiceEmail } from "./invoice-email";
import { getStripeClient, stripeRequest, financeTenantId, StripeApiError, StripeNotReady } from "./stripe-io";
import { stripeErrorSentence } from "./http";
import {
  bankTransferLines,
  DEFAULT_NEW_INVOICE_METHOD,
  invoicePaymentModeError,
  offersBankTransfer,
  offersCard,
  parsePaymentMethod,
  storedPaymentMethod,
  type InvoicePaymentMethod,
  type WiseDetailField,
  type WiseReceivingDetails,
} from "./wise";
import { receivingDetailsOrReason } from "./wise-io";
import {
  clearOneTimePaymentLinkStatement,
  deactivateAndConfirmPaymentLink,
  oneTimeLinkSnapshot,
  retireLegacyOneTimePaymentLink,
  retireOneTimePaymentLinkForDraftEdit,
  retireOneTimePaymentLinkForExternalPayment,
} from "./stripe-ingest";
import { validateEmail } from "./validation";

function businessOnly(entity: EntityRow): void {
  if (entity.kind !== "business") throw new FinanceInputError("invoicing is only available on the business book");
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const ACTIVE_CUSTOMER_REQUIRED = "choose an active customer from this book";
const DRAFT_CUSTOMER_ARCHIVE_BLOCKED =
  "This customer has a draft invoice. Reassign or void the draft invoice before archiving the customer.";

/** Plain diagnostic for a deliberately non-expiring email claim; never expose its token. */
export function unresolvedInvoiceEmailMessage(inv: Pick<InvoiceRow, "send_claimed_at">, action = "changed"): string {
  const when = inv.send_claimed_at ? ` since ${inv.send_claimed_at}` : "";
  return `An email attempt for this invoice is unresolved${when}. Verify the mailbox before clearing the send claim manually; the invoice was not ${action}.`;
}

function assertNoUnresolvedInvoiceEmail(inv: InvoiceRow, action: string): void {
  if (inv.send_claim_token) throw new FinanceInputError(unresolvedInvoiceEmailMessage(inv, action));
}

/** An audit insert gated by a SQL fact in the same transaction. */
function conditionalAuditStatement(
  input: Parameters<typeof auditStatement>[0],
  condition: string,
  conditionArgs: Array<string | number | null> = [],
): InStatement {
  return {
    sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`,
    args: [
      newId("aud"),
      input.entityId,
      input.actor.slice(0, 200),
      input.action,
      input.objectType,
      input.objectId,
      JSON.stringify(input.detail || {}).slice(0, 8000),
      ...conditionArgs,
    ],
  };
}

// ── contacts ─────────────────────────────────────────────────────────────

export async function listContacts(
  viewer: FinanceViewer,
  entityRef: string,
  kind?: "customer" | "vendor",
  opts: { includeArchived?: boolean } = {},
): Promise<ContactRow[]> {
  const entity = await requireEntity(viewer, entityRef);
  const kinds = kind === "customer" ? ["customer", "both"] : kind === "vendor" ? ["vendor", "both"] : ["customer", "vendor", "both"];
  return query<ContactRow>(
    `SELECT id, entity_id, kind, name, email, company, address, stripe_customer_id, archived FROM fin_contacts
      WHERE entity_id = ? ${opts.includeArchived ? "" : "AND archived = 0"} AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY archived, name`,
    [entity.id, ...kinds],
  );
}

type ContactFields = { name: string; email: string; company: string; address: string };

function validateContactFields(raw: Record<string, unknown>): ContactFields {
  const name = text(raw.name, 200);
  if (!name) throw new FinanceInputError("contact name is required");
  const emailRaw = text(raw.email, 254);
  const email = emailRaw ? validateEmail(emailRaw) : "";
  if (emailRaw && !email) throw new FinanceInputError("contact email is not valid");
  return { name, email: email || "", company: text(raw.company, 200), address: text(raw.address, 500) };
}

export async function createContact(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  businessOnly(entity);
  const kind = raw.kind === "vendor" || raw.kind === "both" ? raw.kind : "customer";
  const fields = validateContactFields(raw);
  const id = newId("con");
  await writeBatch([
    {
      sql: `INSERT INTO fin_contacts (id, entity_id, kind, name, email, company, address, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, entity.id, kind, fields.name, fields.email, fields.company, fields.address, text(raw.notes, 1000)],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "contact.created", objectType: "contact", objectId: id }),
  ]);
  return id;
}

export async function updateContact(viewer: FinanceViewer, contactId: string, raw: Record<string, unknown>): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_contacts", contactId);
  businessOnly(entity);
  const fields = validateContactFields(raw);
  await writeBatch([
    {
      sql: `UPDATE fin_contacts SET name = ?, email = ?, company = ?, address = ? WHERE id = ? AND entity_id = ?`,
      args: [fields.name, fields.email, fields.company, fields.address, contactId, entity.id],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "contact.updated", objectType: "contact", objectId: contactId }),
  ]);
}

export async function setContactArchived(viewer: FinanceViewer, contactId: string, archived: boolean): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_contacts", contactId);
  businessOnly(entity);
  const desired = archived ? 1 : 0;
  const out = await writeBatch([
    {
      sql: `UPDATE fin_contacts SET archived = ?
             WHERE id = ? AND entity_id = ? AND archived <> ?
               AND (? = 0 OR NOT EXISTS (
                 SELECT 1 FROM fin_invoices WHERE contact_id = fin_contacts.id AND entity_id = fin_contacts.entity_id AND status = 'draft'
               ))`,
      args: [desired, contactId, entity.id, desired, desired],
    },
    conditionalAuditStatement(
      {
        entityId: entity.id,
        actor: viewerLabel(viewer),
        action: archived ? "contact.archived" : "contact.restored",
        objectType: "contact",
        objectId: contactId,
      },
      "changes() = 1",
    ),
  ]);
  if (out[0]?.rowsAffected === 1) return;
  const current = await queryOne<{ archived: number; drafts: number }>(
    `SELECT c.archived,
            (SELECT COUNT(*) FROM fin_invoices i WHERE i.contact_id = c.id AND i.entity_id = c.entity_id AND i.status = 'draft') AS drafts
       FROM fin_contacts c WHERE c.id = ? AND c.entity_id = ?`,
    [contactId, entity.id],
  );
  if (current?.archived === desired) return;
  if (archived && Number(current?.drafts ?? 0) > 0) throw new FinanceInputError(DRAFT_CUSTOMER_ARCHIVE_BLOCKED);
  throw new FinanceInputError(ACTIVE_CUSTOMER_REQUIRED);
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
    if (!c || c.entity_id !== entity.id || c.archived === 1 || (c.kind !== "customer" && c.kind !== "both")) {
      throw new FinanceInputError(ACTIVE_CUSTOMER_REQUIRED);
    }
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
    if (!paymentMethod) throw new FinanceInputError("payment method must be bank transfer (Wise), card (Stripe), or Hybrid");
  }
  return { contactId, issueDate, dueDate, currency, notes: text(raw.notes, 2000), lines, paymentMethod };
}

/**
 * The statement that stores a draft's payment method, or none. Before
 * migration 184 there is no column: asking for anything but the card flow
 * then is refused rather than silently dropped.
 */
async function paymentMethodStatement(
  invoiceId: string,
  method: InvoicePaymentMethod | null,
  gate?: { sql: string; args: Array<string | number | null> },
): Promise<InStatement[]> {
  if (method === null) return [];
  if (!(await paymentMethodColumnReady())) {
    if (method === "stripe") return [];
    throw new FinanceInputError("Bank transfer (Wise) isn't available on invoices yet, so choose the card link for now.");
  }
  return [{ sql: `UPDATE fin_invoices SET payment_method = ? WHERE id = ? AND status = 'draft'${gate ? ` AND (${gate.sql})` : ""}`, args: [method, invoiceId, ...(gate?.args || [])] }];
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
  gate?: { sql: string; args: Array<string | number | null> },
): InStatement[] {
  return computed.lines.map((l, i) =>
    withBilling
      ? {
          sql: `INSERT INTO fin_invoice_lines (id, invoice_id, line_no, description, quantity_milli, unit_price_cents, amount_cents, taxable, revenue_account_id, billing)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM fin_invoices WHERE id = ? AND status = 'draft')${gate ? ` AND (${gate.sql})` : ""}`,
          args: [newId("il"), invoiceId, i + 1, l.description, l.quantityMilli, l.unitPriceCents, l.amountCents, l.taxable ? 1 : 0, lines[i].revenueAccountId, l.billing, invoiceId, ...(gate?.args || [])],
        }
      : {
          sql: `INSERT INTO fin_invoice_lines (id, invoice_id, line_no, description, quantity_milli, unit_price_cents, amount_cents, taxable, revenue_account_id)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM fin_invoices WHERE id = ? AND status = 'draft')${gate ? ` AND (${gate.sql})` : ""}`,
          args: [newId("il"), invoiceId, i + 1, l.description, l.quantityMilli, l.unitPriceCents, l.amountCents, l.taxable ? 1 : 0, lines[i].revenueAccountId, invoiceId, ...(gate?.args || [])],
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

/** Refuse a payment label whose line mix would promise a rail it does not provide. */
function assertPaymentMode(method: InvoicePaymentMethod, totals: { totalCents: number; monthly: { totalCents: number } }): void {
  const error = invoicePaymentModeError(method, { oneTimeCents: totals.totalCents, monthlyCents: totals.monthly.totalCents });
  if (error) throw new FinanceInputError(error);
}

/** The draft's retainer per month (its monthly lines). Only once migration 185 is there. */
function retainerStatement(
  invoiceId: string,
  totals: ReturnType<typeof computeInvoiceTotals>,
  ready: boolean,
  gate?: { sql: string; args: Array<string | number | null> },
): InStatement[] {
  if (!ready) return [];
  return [{ sql: `UPDATE fin_invoices SET retainer_monthly_cents = ? WHERE id = ? AND status = 'draft'${gate ? ` AND (${gate.sql})` : ""}`, args: [totals.monthly.totalCents, invoiceId, ...(gate?.args || [])] }];
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
  if (method) assertPaymentMode(method, totals);
  const out = await writeBatch([
    {
      sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, status, issue_date, due_date, currency, subtotal_cents, gst_cents,
              qst_cents, total_cents, tax_registered_snapshot, notes, created_by)
            SELECT ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM fin_contacts
                WHERE id = ? AND entity_id = ? AND archived = 0 AND kind IN ('customer', 'both')
             )`,
      args: [id, entity.id, input.contactId, input.issueDate, input.dueDate, input.currency, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, settings.gst_qst_registered, input.notes, viewerLabel(viewer), input.contactId, entity.id],
    },
    ...(await paymentMethodStatement(id, method)),
    ...retainerStatement(id, totals, retainerReady),
    ...lineStatements(id, input.lines, totals, retainerReady),
    conditionalAuditStatement(
      { entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.draft_created", objectType: "invoice", objectId: id, detail: { total: totals.totalCents, monthly: totals.monthly.totalCents, currency: input.currency } },
      "EXISTS (SELECT 1 FROM fin_invoices WHERE id = ?)",
      [id],
    ),
  ]);
  if (out[0]?.rowsAffected !== 1) throw new FinanceInputError(ACTIVE_CUSTOMER_REQUIRED);
  return id;
}

export async function updateDraftInvoice(viewer: FinanceViewer, invoiceId: string, raw: Record<string, unknown>): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  if (inv.status !== "draft") throw new FinanceInputError("only a draft can be edited; void it and create a new one");
  assertNoUnresolvedInvoiceEmail(inv, "edited");
  const input = await parseDraftInput(entity, raw, viewer);
  const settings = await loadSettings(entity.id);
  const totals = draftTotals(input.lines, settings.gst_qst_registered === 1);
  const retainerReady = await retainerReadyFor(input.lines);
  const method = input.paymentMethod ?? storedPaymentMethod(inv.payment_method);
  assertPaymentMode(method, totals);
  const linkWouldBeWrong =
    Boolean(inv.stripe_price_id || inv.stripe_payment_link_id || inv.stripe_payment_link_url) &&
    (method !== "stripe" || totals.totalCents !== inv.total_cents || input.currency !== inv.currency);
  if (linkWouldBeWrong) await retireOneTimePaymentLinkForDraftEdit(inv);
  const writeSnapshot = oneTimeLinkSnapshot(inv);
  const updateAuditId = newId("aud");
  const updateGate = { sql: `EXISTS (SELECT 1 FROM fin_audit_log WHERE id = ?)`, args: [updateAuditId] };
  const out = await writeBatch([
    {
      sql: `UPDATE fin_invoices SET contact_id = ?, issue_date = ?, due_date = ?, currency = ?, subtotal_cents = ?, gst_cents = ?, qst_cents = ?,
                   total_cents = ?, tax_registered_snapshot = ?, notes = ?${linkWouldBeWrong ? ", stripe_price_id = NULL, stripe_payment_link_id = NULL, stripe_payment_link_url = NULL" : ""},
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE ${writeSnapshot.sql} AND send_claim_token IS NULL
               AND EXISTS (
                 SELECT 1 FROM fin_contacts
                  WHERE id = ? AND entity_id = ? AND archived = 0 AND kind IN ('customer', 'both')
               )`,
      args: [input.contactId, input.issueDate, input.dueDate, input.currency, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, settings.gst_qst_registered, input.notes, ...writeSnapshot.args, input.contactId, entity.id],
    },
    {
      sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
            SELECT ?, ?, ?, 'invoice.draft_updated', 'invoice', ?, '{}' WHERE changes() = 1`,
      args: [updateAuditId, entity.id, viewerLabel(viewer).slice(0, 200), invoiceId],
    },
    { sql: `DELETE FROM fin_invoice_lines WHERE invoice_id = ? AND (SELECT status FROM fin_invoices WHERE id = ?) = 'draft' AND (${updateGate.sql})`, args: [invoiceId, invoiceId, ...updateGate.args] },
    ...lineStatements(invoiceId, input.lines, totals, retainerReady, updateGate),
    ...(await paymentMethodStatement(invoiceId, input.paymentMethod, updateGate)),
    ...retainerStatement(invoiceId, totals, retainerReady, updateGate),
  ]);
  if (out[0]?.rowsAffected !== 1) {
    const current = await loadInvoice(invoiceId);
    if (current?.send_claim_token) throw new FinanceInputError(unresolvedInvoiceEmailMessage(current, "edited"));
    throw new FinanceInputError("only a draft can be edited; void it and create a new one");
  }
}

/** Delete a never-issued invoice after every checkout URL is proved inactive. */
export async function deleteDraftInvoice(viewer: FinanceViewer, invoiceId: string): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  if (inv.status !== "draft") throw new FinanceInputError("only a draft invoice can be deleted; issued invoices must be voided");
  assertNoUnresolvedInvoiceEmail(inv, "deleted");
  await deactivateInvoiceLinksStrict(inv, "delete");
  const hasRetainerColumns = await retainerColumnsReady();
  const snapshot = oneTimeLinkSnapshot(inv);
  const exact = `${snapshot.sql}
    AND recognition_entry_id IS ?
    AND send_claim_token IS NULL
    ${
      hasRetainerColumns
        ? `AND stripe_retainer_product_id IS ? AND stripe_retainer_price_id IS ?
           AND stripe_retainer_price_cents IS ? AND stripe_retainer_price_currency IS ?
           AND stripe_retainer_link_id IS ? AND stripe_retainer_link_url IS ?
           AND stripe_retainer_link_cents IS ? AND stripe_retainer_link_currency IS ?`
        : ""
    }`;
  const exactArgs = [
    ...snapshot.args,
    inv.recognition_entry_id,
    ...(
      hasRetainerColumns
        ? [
            inv.stripe_retainer_product_id ?? null,
            inv.stripe_retainer_price_id ?? null,
            inv.stripe_retainer_price_cents ?? null,
            inv.stripe_retainer_price_currency ?? null,
            inv.stripe_retainer_link_id ?? null,
            inv.stripe_retainer_link_url ?? null,
            inv.stripe_retainer_link_cents ?? null,
            inv.stripe_retainer_link_currency ?? null,
          ]
        : []
    ),
  ];
  const out = await writeBatch([
    {
      sql: `DELETE FROM fin_invoice_lines
             WHERE invoice_id = ? AND EXISTS (SELECT 1 FROM fin_invoices WHERE ${exact})`,
      args: [invoiceId, ...exactArgs],
    },
    {
      sql: `DELETE FROM fin_invoices
             WHERE ${exact}
               AND NOT EXISTS (SELECT 1 FROM fin_invoice_lines WHERE invoice_id = ?)`,
      args: [...exactArgs, invoiceId],
    },
    {
      sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
            SELECT ?, ?, ?, 'invoice.draft_deleted', 'invoice', ?, ? WHERE changes() = 1`,
      args: [newId("aud"), entity.id, viewerLabel(viewer).slice(0, 200), invoiceId, JSON.stringify({ total: inv.total_cents, currency: inv.currency })],
    },
  ]);
  if (out[1]?.rowsAffected !== 1) {
    const current = await loadInvoice(invoiceId);
    if (current?.send_claim_token) throw new FinanceInputError(unresolvedInvoiceEmailMessage(current, "deleted"));
    throw new FinanceInputError("This draft changed while it was being deleted. Reload it and try again; it was kept.");
  }
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
  /** The founder-facing lifecycle; unlike list_status, overdue never replaces the lifecycle state. */
  display_status: InvoiceDisplayStatus;
  /** Secondary warning for an issued or partially-paid invoice past its due date. */
  is_overdue: boolean;
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
 * Founder-facing filters use display_status. Legacy "sent" and "overdue"
 * continue to filter list_status for internal callers.
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
    const retainerCents = retainerMonthlyCents(r);
    const effective = effectiveInvoiceStatus(
      { status: r.status, dueDate: r.due_date, totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents },
      today,
    );
    const display = invoiceDisplayState(
      { status: r.status, dueDate: r.due_date, totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents, retainerMonthlyCents: retainerCents },
      today,
    );
    return {
      ...r,
      effective_status: effective,
      list_status: invoiceListStatus(effective, hasAmountDueNow(r)),
      display_status: display.displayStatus,
      is_overdue: display.isOverdue,
      balance_cents: r.status === "void" ? 0 : balanceDueCents({ totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents }),
      retainer_cents: retainerCents,
      retainer_link: localRetainerLink(r),
    };
  });
  return status ? out.filter((r) => r.display_status === status || r.list_status === status) : out;
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
  const today = torontoToday();
  const effectiveStatus = effectiveInvoiceStatus(
    { status: inv.status, dueDate: inv.due_date, totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents },
    today,
  );
  const display = invoiceDisplayState(
    {
      status: inv.status,
      dueDate: inv.due_date,
      totalCents: inv.total_cents,
      amountPaidCents: inv.amount_paid_cents,
      retainerMonthlyCents: retainerMonthlyCents(inv),
    },
    today,
  );
  return {
    entity,
    invoice: inv,
    effectiveStatus,
    /** Backward-compatible internal/list status used by finance summaries. */
    listStatus: invoiceListStatus(effectiveStatus, hasAmountDueNow(inv)),
    displayStatus: display.displayStatus,
    isOverdue: display.isOverdue,
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
  const [wise, link, oneTimeUrl] = await Promise.all([
    d.invoice.status === "void" ? Promise.resolve({ lines: null, notice: null }) : bankTransferFor(d.invoice),
    retainerLinkStatus(d.invoice),
    verifiedOneTimePaymentLink(d.invoice),
  ]);
  const printable = {
    ...d.invoice,
    stripe_payment_link_url: oneTimeUrl,
    ...(link.state === "active" && !link.stale ? {} : { stripe_retainer_link_url: null }),
  };
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

function isActiveInvoiceCustomer(inv: InvoiceRow, contact: ContactRow | null): boolean {
  return Boolean(
    contact &&
      contact.id === inv.contact_id &&
      contact.entity_id === inv.entity_id &&
      contact.archived === 0 &&
      (contact.kind === "customer" || contact.kind === "both"),
  );
}

/** Re-total stored lines (one-time and monthly apart) under the given registration. */
function storedTotals(lines: readonly InvoiceLineRow[], registered: boolean) {
  return totalsFromStoredLines(
    lines.map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unitPriceCents: l.unit_price_cents, taxable: l.taxable === 1, billing: storedLineBilling(l.billing) })),
    { registered },
  );
}

/**
 * The retainer block the PDF prints (null = no retainer: the PDF is exactly
 * what it was before 185). `setUp`: Stripe says the client already started the
 * subscription, so the PDF says so instead of printing the used-up link.
 */
function retainerForPdf(inv: InvoiceRow, lines: readonly InvoiceLineRow[], setUp: boolean) {
  if (inv.status === "void") return null;
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
type IssueExpectation = {
  totalCents: number;
  monthlyCents: number;
  currency: string;
  contactId: string;
  cardLinkVerified: boolean;
  sendClaimToken: string;
};

/** One SQL fact proving every row used to compute an issue is still byte-for-byte current. */
function issueSnapshotGate(
  inv: InvoiceRow,
  lines: readonly InvoiceLineRow[],
  settings: SettingsRow,
  opts: { paymentMethodReady: boolean; retainerReady: boolean },
): { sql: string; args: Array<string | number | null> } {
  const invoiceParts = [
    "issue_i.id = ?",
    "issue_i.status = 'draft'",
    "issue_i.updated_at = ?",
    "issue_i.contact_id = ?",
    "issue_i.number IS ?",
    "issue_i.issue_date = ?",
    "issue_i.due_date = ?",
    "issue_i.currency = ?",
    "issue_i.subtotal_cents = ?",
    "issue_i.gst_cents = ?",
    "issue_i.qst_cents = ?",
    "issue_i.total_cents = ?",
    "issue_i.amount_paid_cents = ?",
    "issue_i.tax_registered_snapshot = ?",
    "issue_i.recognition_entry_id IS ?",
    "issue_i.stripe_price_id IS ?",
    "issue_i.stripe_payment_link_id IS ?",
    "issue_i.stripe_payment_link_url IS ?",
    "issue_i.send_claim_token IS ?",
  ];
  const invoiceArgs: Array<string | number | null> = [
    inv.id,
    inv.updated_at,
    inv.contact_id,
    inv.number,
    inv.issue_date,
    inv.due_date,
    inv.currency,
    inv.subtotal_cents,
    inv.gst_cents,
    inv.qst_cents,
    inv.total_cents,
    inv.amount_paid_cents,
    inv.tax_registered_snapshot,
    inv.recognition_entry_id,
    inv.stripe_price_id,
    inv.stripe_payment_link_id,
    inv.stripe_payment_link_url,
    inv.send_claim_token ?? null,
  ];
  if (opts.paymentMethodReady) {
    invoiceParts.push("issue_i.payment_method IS ?");
    invoiceArgs.push(inv.payment_method ?? null);
  }
  if (opts.retainerReady) {
    invoiceParts.push(
      "issue_i.retainer_monthly_cents IS ?",
      "issue_i.stripe_retainer_product_id IS ?",
      "issue_i.stripe_retainer_price_id IS ?",
      "issue_i.stripe_retainer_price_cents IS ?",
      "issue_i.stripe_retainer_price_currency IS ?",
      "issue_i.stripe_retainer_link_id IS ?",
      "issue_i.stripe_retainer_link_url IS ?",
      "issue_i.stripe_retainer_link_cents IS ?",
      "issue_i.stripe_retainer_link_currency IS ?",
    );
    invoiceArgs.push(
      inv.retainer_monthly_cents ?? null,
      inv.stripe_retainer_product_id ?? null,
      inv.stripe_retainer_price_id ?? null,
      inv.stripe_retainer_price_cents ?? null,
      inv.stripe_retainer_price_currency ?? null,
      inv.stripe_retainer_link_id ?? null,
      inv.stripe_retainer_link_url ?? null,
      inv.stripe_retainer_link_cents ?? null,
      inv.stripe_retainer_link_currency ?? null,
    );
  }
  const linePredicates: string[] = [];
  const lineArgs: Array<string | number | null> = [inv.id, lines.length];
  for (const line of lines) {
    linePredicates.push(`EXISTS (
      SELECT 1 FROM fin_invoice_lines issue_l
       WHERE issue_l.invoice_id = ? AND issue_l.id = ? AND issue_l.line_no = ? AND issue_l.description = ?
         AND issue_l.quantity_milli = ? AND issue_l.unit_price_cents = ? AND issue_l.amount_cents = ?
         AND issue_l.taxable = ? AND issue_l.revenue_account_id = ?${opts.retainerReady ? " AND issue_l.billing IS ?" : ""}
    )`);
    lineArgs.push(
      inv.id,
      line.id,
      line.line_no,
      line.description,
      line.quantity_milli,
      line.unit_price_cents,
      line.amount_cents,
      line.taxable,
      line.revenue_account_id,
      ...(opts.retainerReady ? [line.billing ?? null] : []),
    );
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM fin_invoices issue_i
      JOIN fin_contacts issue_c ON issue_c.id = issue_i.contact_id AND issue_c.entity_id = issue_i.entity_id
      WHERE ${invoiceParts.join(" AND ")}
        AND issue_c.archived = 0 AND issue_c.kind IN ('customer', 'both')
        AND EXISTS (
          SELECT 1 FROM fin_settings issue_s
           WHERE issue_s.entity_id = ? AND issue_s.updated_at = ? AND issue_s.invoice_prefix = ?
             AND issue_s.invoice_next_number = ? AND issue_s.invoice_number_year IS ?
             AND issue_s.gst_qst_registered = ? AND issue_s.gst_number = ? AND issue_s.qst_number = ?
        )
        AND (SELECT COUNT(*) FROM fin_invoice_lines count_l WHERE count_l.invoice_id = ?) = ?
        ${linePredicates.length ? `AND ${linePredicates.join(" AND ")}` : ""}
    )`,
    args: [
      ...invoiceArgs,
      settings.entity_id,
      settings.updated_at,
      settings.invoice_prefix,
      settings.invoice_next_number,
      settings.invoice_number_year,
      settings.gst_qst_registered,
      settings.gst_number,
      settings.qst_number,
      ...lineArgs,
    ],
  };
}

export const ISSUE_CHANGED_DURING_SEND =
  "This invoice changed while it was being sent (its lines, customer or currency, or the GST/QST settings, were edited at the same moment), so it was not issued and nothing was emailed: open it again and send it.";
export const ISSUE_CHANGED_DURING_FINALIZE =
  "This invoice changed while it was being issued, so no number or bookkeeping entry was created. Open it again and issue it once more.";

/**
 * Number the draft, re-total it under current registration, recognise the
 * receivable. Atomic. `expect` (from sendInvoice): the amounts, currency and
 * customer the invoice's Stripe links were made for — if the draft no longer
 * matches them it is not issued, so a link is never emailed for another amount.
 */
export async function finalizeInvoice(viewer: FinanceViewer, invoiceId: string, expect?: IssueExpectation): Promise<InvoiceRow> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  businessOnly(entity);
  for (let attempt = 0; attempt < 3; attempt++) {
    const inv = await loadInvoice(invoiceId);
    if (!inv) throw new FinanceNotFound();
    if (inv.status !== "draft") {
      if (expect) throw new FinanceInputError(ISSUE_CHANGED_DURING_SEND);
      return inv;
    }
    if (!isActiveInvoiceCustomer(inv, await loadContact(inv.contact_id))) throw new FinanceInputError(ACTIVE_CUSTOMER_REQUIRED);
    const lines = await loadInvoiceLines(invoiceId);
    const { settings, registered, totals } = await issueTotals(entity.id, lines);
    assertPaymentMode(storedPaymentMethod(inv.payment_method), totals);
    if (
      expect &&
      (expect.totalCents !== totals.totalCents ||
        expect.monthlyCents !== totals.monthly.totalCents ||
        expect.currency !== inv.currency ||
        expect.contactId !== inv.contact_id ||
        expect.sendClaimToken !== inv.send_claim_token)
    ) {
      throw new FinanceInputError(ISSUE_CHANGED_DURING_SEND);
    }
    // A monthly line can only exist once migration 185 is there, so its columns are too.
    const hasMonthly = lines.some((l) => storedLineBilling(l.billing) === "monthly");
    // A card link made on the draft that this issue did not verify (Issue without emailing, or a send that no
    // longer attaches it) may charge another amount: it is dropped, so no later send or reminder hands it out.
    const dropCardLink = Boolean(inv.stripe_price_id || inv.stripe_payment_link_id || inv.stripe_payment_link_url) && !expect?.cardLinkVerified;
    if (dropCardLink) {
      // Issuing without a send must not leave an unchecked draft checkout in
      // the wild. Prove it off before numbering/bookkeeping; the gated issue
      // batch below clears the local fields atomically with issuance.
      await retireOneTimePaymentLinkForDraftEdit(inv);
    }
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
    const paymentMethodReady = await paymentMethodColumnReady();
    const retainerReady = await retainerColumnsReady();
    const snapshot = issueSnapshotGate(inv, lines, settings, { paymentMethodReady, retainerReady });
    const operationId = newId("aud");
    const operationGate = { sql: `EXISTS (SELECT 1 FROM fin_audit_log WHERE id = ?)`, args: [operationId] };
    const recognition =
      totals.totalCents > 0
        ? await buildRecognitionPosting(finalized, lines, viewerLabel(viewer), operationGate)
        : null;
    try {
      const out = await writeBatch([
        {
          sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
                SELECT ?, ?, ?, 'invoice.issued', 'invoice', ?, ? WHERE ${snapshot.sql}`,
          args: [
            operationId,
            entity.id,
            viewerLabel(viewer).slice(0, 200),
            invoiceId,
            JSON.stringify({ number: alloc.number, total: totals.totalCents, ...(hasMonthly ? { monthly: totals.monthly.totalCents } : {}) }),
            ...snapshot.args,
          ],
        },
        {
          sql: `UPDATE fin_settings SET invoice_next_number = ?, invoice_number_year = ?
                 WHERE entity_id = ? AND invoice_next_number = ? AND invoice_number_year IS ? AND (${operationGate.sql})`,
          args: [alloc.nextNumber, alloc.numberYear, entity.id, settings.invoice_next_number, settings.invoice_number_year, ...operationGate.args],
        },
        ...(recognition ? recognition.statements : []),
        ...(hasMonthly
          ? [{
              sql: `UPDATE fin_invoices SET retainer_monthly_cents = ? WHERE id = ? AND status = 'draft' AND (${operationGate.sql})`,
              args: [totals.monthly.totalCents, invoiceId, ...operationGate.args],
            }]
          : []),
        ...(dropCardLink
          ? [{
              sql: `UPDATE fin_invoices SET stripe_price_id = NULL, stripe_payment_link_id = NULL, stripe_payment_link_url = NULL
                     WHERE id = ? AND status = 'draft' AND (${operationGate.sql})`,
              args: [invoiceId, ...operationGate.args],
            }]
          : []),
        recognition
          ? {
              sql: `UPDATE fin_invoices SET number = ?, status = 'sent', subtotal_cents = ?, gst_cents = ?, qst_cents = ?, total_cents = ?,
                           tax_registered_snapshot = ?, recognition_entry_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = ? AND status = 'draft' AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)
                       AND (${operationGate.sql})`,
              args: [alloc.number, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, registered ? 1 : 0, recognition.entryId, invoiceId, recognition.entryId, ...operationGate.args],
            }
          : {
              sql: `UPDATE fin_invoices SET number = ?, status = 'sent', subtotal_cents = ?, gst_cents = ?, qst_cents = ?, total_cents = ?,
                           tax_registered_snapshot = ?, recognition_entry_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = ? AND status = 'draft' AND (${operationGate.sql})`,
              args: [alloc.number, totals.subtotalCents, totals.gstCents, totals.qstCents, totals.totalCents, registered ? 1 : 0, invoiceId, ...operationGate.args],
            },
      ]);
      if (out[0]?.rowsAffected !== 1) {
        const current = await loadInvoice(invoiceId);
        if (current && !isActiveInvoiceCustomer(current, await loadContact(current.contact_id))) throw new FinanceInputError(ACTIVE_CUSTOMER_REQUIRED);
        throw new FinanceInputError(expect ? ISSUE_CHANGED_DURING_SEND : ISSUE_CHANGED_DURING_FINALIZE);
      }
    } catch (e) {
      if (isUniqueViolation(e)) continue; // lost a numbering race: re-read settings and try again
      throw e;
    }
    const after = await loadInvoice(invoiceId);
    if (after && after.status !== "draft") {
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
 * A stored one-time card link, whether made on a draft or already emailed, is
 * reusable only while Stripe says it is live, unused and for exactly the
 * current unpaid balance and currency.
 */
async function storedCardLinkReusable(key: string, inv: InvoiceRow, due: number): Promise<boolean> {
  const link = await stripeRequest(key, "GET", `/v1/payment_links/${encodeURIComponent(inv.stripe_payment_link_id as string)}`);
  if (link.livemode !== true) throw new FinanceInputError("the stored Stripe card link is in test mode; refusing to email it to a real customer");
  const used = completedSessions(link);
  if (used === null) throw new FinanceInputError(DRAFT_CARD_LINK_UNKNOWN);
  if (used > 0) throw new FinanceInputError(DRAFT_CARD_LINK_USED);
  if (link.active !== true || !inv.stripe_price_id || link.id !== inv.stripe_payment_link_id || link.url !== inv.stripe_payment_link_url) return false;
  const lineItems = await stripeRequest(
    key,
    "GET",
    `/v1/payment_links/${encodeURIComponent(inv.stripe_payment_link_id as string)}/line_items`,
    { limit: 2 },
  );
  const data = Array.isArray(lineItems.data) ? lineItems.data : [];
  const only = data.length === 1 && lineItems.has_more === false && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  const linkedPrice = only?.price;
  const linkedPriceId = typeof linkedPrice === "string" ? linkedPrice : linkedPrice && typeof linkedPrice === "object" ? (linkedPrice as Record<string, unknown>).id : null;
  if (Number(only?.quantity) !== 1 || linkedPriceId !== inv.stripe_price_id) return false;
  const price = await stripeRequest(key, "GET", `/v1/prices/${encodeURIComponent(inv.stripe_price_id)}`);
  if (price.livemode !== true) throw new FinanceInputError("the stored Stripe price is in test mode; refusing to email its link to a real customer");
  return Number(price.unit_amount) === due && String(price.currency || "").toUpperCase() === inv.currency;
}

/** Read-only, fail-closed link selection for downloaded PDFs. */
export async function verifiedOneTimePaymentLink(inv: InvoiceRow): Promise<string | null> {
  if (inv.status !== "sent" && inv.status !== "overdue") return null;
  if (!offersCard(storedPaymentMethod(inv.payment_method))) return null;
  const due = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  if (due <= 0 || !inv.stripe_payment_link_id || !inv.stripe_payment_link_url || !inv.stripe_price_id) return null;
  try {
    const { key } = await getStripeClient();
    return (await storedCardLinkReusable(key, inv, due)) ? inv.stripe_payment_link_url : null;
  } catch (e) {
    console.error("[finances:invoices] omitted an unverified one-time link", inv.id, e instanceof Error ? e.message : e);
    return null;
  }
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
 * Every stored link, including an issued one, is reused only while Stripe says
 * it is live, unused and for exactly the current balance and currency. Otherwise
 * the old link is confirmed off before a replacement is made.
 */
export async function ensurePaymentLink(inv: InvoiceRow, storeSnapshot: InvoiceRow = inv): Promise<string> {
  const due = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  if (due <= 0) throw new FinanceInputError("nothing is due on this invoice");
  const { key } = await getStripeClient();
  let replacing: string | null = null;
  if (inv.stripe_payment_link_id) {
    if (inv.stripe_payment_link_url && (await storedCardLinkReusable(key, inv, due))) return inv.stripe_payment_link_url;
    replacing = inv.stripe_payment_link_id;
    // The old amount must be impossible to pay before Stripe is asked to make
    // its replacement. The GET proves the POST took effect.
    await deactivateAndConfirmPaymentLink(key, replacing);
  }
  // Objects made before the number exists differ in name/metadata: their own idempotency keys, so a later numbered request never collides with one.
  const draft = inv.number ? "" : "-d";
  const sendAttempt = inv.send_claim_token ? `-${inv.send_claim_token}` : "";
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
    { idempotencyKey: `fin-price-${inv.id}-${due}-${inv.currency}${draft}-${replacing || "first"}${sendAttempt}` },
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
      "metadata[fin_invoice_price_id]": priceId,
      ...numbered("metadata[fin_invoice_number]"),
      "payment_intent_data[metadata][fin_invoice_id]": inv.id,
      "payment_intent_data[metadata][fin_entity_id]": inv.entity_id,
      "payment_intent_data[metadata][fin_invoice_price_id]": priceId,
      ...numbered("payment_intent_data[metadata][fin_invoice_number]"),
      "restrictions[completed_sessions][limit]": 1,
      "after_completion[type]": "hosted_confirmation",
      "after_completion[hosted_confirmation][custom_message]": cardThanks(inv.number),
    },
    // + the link it replaces: going back to an earlier amount must make a NEW link, not replay the switched-off one.
    { idempotencyKey: `fin-plink-${inv.id}-${priceId}${draft}${replacing ? `-${replacing}` : ""}${sendAttempt}` },
  );
  const linkId = typeof link.id === "string" ? link.id : "";
  const url = typeof link.url === "string" ? link.url : "";
  if (!linkId.startsWith("plink_") || !url.startsWith("https://")) throw new Error("Stripe did not return a payment link");
  const stored = await finDb().execute({
    sql: `UPDATE fin_invoices
             SET stripe_price_id = ?, stripe_payment_link_id = ?, stripe_payment_link_url = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ? AND status = ? AND total_cents = ? AND amount_paid_cents = ? AND currency = ?
             AND stripe_price_id IS ? AND stripe_payment_link_id IS ? AND stripe_payment_link_url IS ?`,
    args: [
      priceId,
      linkId,
      url,
      inv.id,
      storeSnapshot.status,
      storeSnapshot.total_cents,
      storeSnapshot.amount_paid_cents,
      storeSnapshot.currency,
      storeSnapshot.stripe_price_id,
      storeSnapshot.stripe_payment_link_id,
      storeSnapshot.stripe_payment_link_url,
    ],
  });
  if (stored.rowsAffected !== 1) {
    const winner = await loadInvoice(inv.id);
    const winnerDue = winner ? balanceDueCents({ totalCents: winner.total_cents, amountPaidCents: winner.amount_paid_cents }) : -1;
    if (
      winner?.stripe_payment_link_id === linkId &&
      winner.stripe_price_id === priceId &&
      winner.stripe_payment_link_url === url &&
      winner.status === storeSnapshot.status &&
      winner.currency === inv.currency &&
      winnerDue === due &&
      offersCard(storedPaymentMethod(winner.payment_method))
    ) {
      return url;
    }
    // Stripe idempotency can hand concurrent callers the SAME object. Never
    // switch off an id that another caller just stored as the invoice winner.
    if (winner?.stripe_payment_link_id === linkId) {
      throw new FinanceInputError("This invoice changed while its card link was being made. Reload the invoice and send again. Nothing was emailed.");
    }
    await deactivateAndConfirmPaymentLink(key, linkId);
    throw new FinanceInputError("This invoice changed while its card link was being made, so the new link was switched off. Reload the invoice and send again. Nothing was emailed.");
  }
  return url;
}

/** The retainer's link to email, or `set_up`: the client already started the subscription with it. */
export type RetainerLink = { kind: "link"; url: string } | { kind: "set_up" };

export const RETAINER_LINK_STATE_UNKNOWN =
  "Stripe no longer reports whether the client used this invoice's retainer link (its one-payment limit was removed in Stripe), so the app can't tell whether they already subscribed and won't email that link or a new one: check the client's subscriptions in Stripe → Customers, set the link's payment limit back to 1 in Stripe → Payment links, then send again. Nothing was emailed.";

type RetainerInspection = {
  state: LinkState;
  exact: boolean;
  productExact: boolean;
  priceExact: boolean;
  reason: string | null;
};

/** Exact local snapshot used for every recurring Product/Price/Link persistence write. */
function retainerSnapshot(inv: InvoiceRow, alias = "fin_invoices"): { sql: string; args: Array<string | number | null> } {
  const fields: Array<[string, string | number | null]> = [
    ["id", inv.id],
    ["status", inv.status],
    ["updated_at", inv.updated_at],
    ["entity_id", inv.entity_id],
    ["contact_id", inv.contact_id],
    ["number", inv.number],
    ["issue_date", inv.issue_date],
    ["due_date", inv.due_date],
    ["currency", inv.currency],
    ["total_cents", inv.total_cents],
    ["amount_paid_cents", inv.amount_paid_cents],
    ["payment_method", inv.payment_method ?? null],
    ["retainer_monthly_cents", inv.retainer_monthly_cents ?? null],
    ["stripe_retainer_product_id", inv.stripe_retainer_product_id ?? null],
    ["stripe_retainer_price_id", inv.stripe_retainer_price_id ?? null],
    ["stripe_retainer_price_cents", inv.stripe_retainer_price_cents ?? null],
    ["stripe_retainer_price_currency", inv.stripe_retainer_price_currency ?? null],
    ["stripe_retainer_link_id", inv.stripe_retainer_link_id ?? null],
    ["stripe_retainer_link_url", inv.stripe_retainer_link_url ?? null],
    ["stripe_retainer_link_cents", inv.stripe_retainer_link_cents ?? null],
    ["stripe_retainer_link_currency", inv.stripe_retainer_link_currency ?? null],
    ["send_claim_token", inv.send_claim_token ?? null],
  ];
  return { sql: fields.map(([name]) => `${alias}.${name} IS ?`).join(" AND "), args: fields.map(([, value]) => value) };
}

/** A concurrent writer is adoptable only while it is still making the same invoice request. */
function sameRetainerRequest(current: InvoiceRow | null, expected: InvoiceRow): current is InvoiceRow {
  return Boolean(
    current &&
      current.status === expected.status &&
      current.status !== "void" &&
      current.status !== "paid" &&
      current.entity_id === expected.entity_id &&
      current.contact_id === expected.contact_id &&
      current.number === expected.number &&
      current.issue_date === expected.issue_date &&
      current.due_date === expected.due_date &&
      current.currency === expected.currency &&
      current.total_cents === expected.total_cents &&
      current.amount_paid_cents === expected.amount_paid_cents &&
      (current.payment_method ?? null) === (expected.payment_method ?? null) &&
      retainerMonthlyCents(current) === retainerMonthlyCents(expected) &&
      (current.send_claim_token ?? null) === (expected.send_claim_token ?? null),
  );
}

/** Products and Prices have no delete API; archive, then GET-prove the exact object is inactive. */
async function retireStripeCatalogObject(key: string, kind: "products" | "prices", id: string): Promise<void> {
  await stripeRequest(key, "POST", `/v1/${kind}/${encodeURIComponent(id)}`, { active: "false" });
  const checked = await stripeRequest(key, "GET", `/v1/${kind}/${encodeURIComponent(id)}`);
  if (checked.id !== id || checked.active !== false) throw new Error(`Stripe did not confirm ${kind.slice(0, -1)} ${id} inactive`);
}

type MadeRetainerObjects = { productId?: string; priceId?: string; linkId?: string };

/** Retire only objects this caller made and which no compatible winning row adopted. */
async function cleanupRetainerLoser(key: string, made: MadeRetainerObjects, winner: InvoiceRow | null): Promise<void> {
  const protects = winner && winner.status !== "void" && winner.status !== "paid" ? winner : null;
  const failures: string[] = [];
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (made.linkId && protects?.stripe_retainer_link_id !== made.linkId) {
    await run(`Payment Link ${made.linkId}`, () => deactivateAndConfirmPaymentLink(key, made.linkId as string));
  }
  if (made.priceId && protects?.stripe_retainer_price_id !== made.priceId) {
    await run(`Price ${made.priceId}`, () => retireStripeCatalogObject(key, "prices", made.priceId as string));
  }
  if (made.productId && protects?.stripe_retainer_product_id !== made.productId) {
    await run(`Product ${made.productId}`, () => retireStripeCatalogObject(key, "products", made.productId as string));
  }
  if (failures.length) throw new Error(`could not retire Stripe objects from a lost invoice race (${failures.join("; ")})`);
}

function recurringMismatchReason(): string {
  return "Stripe's live Payment Link, Price, or Product does not match this invoice, so the stored URL cannot be verified or shown.";
}

/** Prove stored Link -> only line item -> monthly Price -> live Product exactly. */
async function inspectRetainerObjects(key: string, inv: InvoiceRow): Promise<RetainerInspection> {
  const monthly = retainerMonthlyCents(inv);
  const productId = inv.stripe_retainer_product_id || "";
  const priceId = inv.stripe_retainer_price_id || "";
  const linkId = inv.stripe_retainer_link_id || "";
  let state: LinkState = linkId ? "unknown" : "switched_off";
  let linkIdentity = false;
  let linkIdExact = false;
  let linkUrlExact = false;
  let linkModeExact = false;
  let lineExact = false;

  if (linkId) {
    const link = await stripeRequest(key, "GET", `/v1/payment_links/${encodeURIComponent(linkId)}`);
    const used = completedSessions(link);
    state = used === null ? "unknown" : used > 0 ? "used" : link.active === true ? "active" : "switched_off";
    linkIdExact = link.id === linkId;
    linkUrlExact = link.url === inv.stripe_retainer_link_url;
    linkModeExact = link.livemode === true;
    linkIdentity =
      linkIdExact &&
      linkUrlExact &&
      linkModeExact &&
      Number(inv.stripe_retainer_link_cents) === monthly &&
      inv.stripe_retainer_link_currency === inv.currency;
    const lineItems = await stripeRequest(key, "GET", `/v1/payment_links/${encodeURIComponent(linkId)}/line_items`, { limit: 2 });
    const data = Array.isArray(lineItems.data) ? lineItems.data : [];
    const only = data.length === 1 && lineItems.has_more === false && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
    const linked = only?.price;
    const linkedPriceId = typeof linked === "string" ? linked : linked && typeof linked === "object" ? (linked as Record<string, unknown>).id : null;
    lineExact = Number(only?.quantity) === 1 && linkedPriceId === priceId;
  }

  let rawPriceExact = false;
  if (priceId) {
    const price = await stripeRequest(key, "GET", `/v1/prices/${encodeURIComponent(priceId)}`);
    const recurring = price.recurring && typeof price.recurring === "object" ? (price.recurring as Record<string, unknown>) : null;
    const product = price.product;
    const priceProductId = typeof product === "string" ? product : product && typeof product === "object" ? (product as Record<string, unknown>).id : null;
    rawPriceExact =
      price.id === priceId &&
      price.livemode === true &&
      price.active === true &&
      Number(price.unit_amount) === monthly &&
      String(price.currency || "").toUpperCase() === inv.currency &&
      priceProductId === productId &&
      recurring?.interval === "month" &&
      Number(recurring.interval_count) === 1 &&
      Number(inv.stripe_retainer_price_cents) === monthly &&
      inv.stripe_retainer_price_currency === inv.currency;
  }

  let productExact = false;
  if (productId) {
    const product = await stripeRequest(key, "GET", `/v1/products/${encodeURIComponent(productId)}`);
    productExact = product.id === productId && product.livemode === true && product.active === true;
  }

  const priceExact = rawPriceExact && productExact;
  const exact = Boolean(linkId && inv.stripe_retainer_link_url && linkIdentity && lineExact && priceExact);
  const mismatch = !linkIdentity
    ? linkId && Number(inv.stripe_retainer_link_cents) !== monthly
      ? "Stripe's stored Payment Link amount does not match this invoice."
      : linkId && inv.stripe_retainer_link_currency !== inv.currency
        ? "Stripe's stored Payment Link currency does not match this invoice."
        : !linkIdExact
          ? "Stripe's live Payment Link identity does not match this invoice."
          : !linkUrlExact
            ? "Stripe's live Payment Link URL does not match this invoice."
            : !linkModeExact
              ? "Stripe's live Payment Link mode does not match this invoice."
              : "Stripe's live Payment Link could not be verified against this invoice."
    : !lineExact
      ? "Stripe's live Payment Link does not match exactly one unit of this invoice's stored Price."
      : !rawPriceExact
        ? "Stripe's live recurring Price does not match this invoice's amount, currency, Product, or monthly cadence."
        : !productExact
          ? "Stripe's live Product identity, mode, or active state does not match this invoice."
          : recurringMismatchReason();
  return {
    state,
    exact,
    productExact,
    priceExact,
    reason:
      state === "unknown" && linkIdentity
        ? "Stripe no longer reports whether it was used (its one-payment limit was removed in Stripe), so the app can't tell whether the client subscribed."
        : exact
          ? null
          : mismatch,
  };
}

async function recurringCasLost(key: string, expected: InvoiceRow, made: MadeRetainerObjects): Promise<InvoiceRow> {
  const current = await loadInvoice(expected.id);
  const adoptable = sameRetainerRequest(current, expected);
  await cleanupRetainerLoser(key, made, adoptable ? current : null);
  if (!adoptable) {
    throw new FinanceInputError("This invoice changed, was voided, or was deleted while its retainer link was being made. Every new Stripe object was switched off. Reload it and try again. Nothing was emailed.");
  }
  return current;
}

/** Persist an intermediate recurring-object winner with a full invoice CAS. */
async function persistRetainerObject(expected: InvoiceRow, setSql: string, setArgs: Array<string | number | null>): Promise<InvoiceRow | null> {
  const snapshot = retainerSnapshot(expected);
  const out = await finDb().execute({
    sql: `UPDATE fin_invoices SET ${setSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${snapshot.sql}`,
    args: [...setArgs, ...snapshot.args],
  });
  return out.rowsAffected === 1 ? await loadInvoice(expected.id) : null;
}

/** Exact, race-safe recurring Product/Price/Payment-Link provisioning. */
export async function ensureRetainerLink(inv: InvoiceRow, actor = "finances"): Promise<RetainerLink> {
  const monthly = retainerMonthlyCents(inv);
  if (monthly <= 0) throw new FinanceInputError("this invoice has no monthly retainer");
  const { key } = await getStripeClient();
  const inspection = await inspectRetainerObjects(key, inv);

  if (inv.stripe_retainer_link_id) {
    if (inspection.state === "unknown") throw new FinanceInputError(RETAINER_LINK_STATE_UNKNOWN);
    if (inspection.state === "used") {
      if (inspection.exact) return { kind: "set_up" };
      const was = formatCents(Number(inv.stripe_retainer_link_cents), inv.stripe_retainer_link_currency || inv.currency);
      if (Number(inv.stripe_retainer_link_cents) !== monthly || inv.stripe_retainer_link_currency !== inv.currency) {
        throw new FinanceInputError(
          `The client already set up monthly card payments of ${was}/month with this invoice's retainer link, so a new link would charge them twice a month: change the amount on their subscription in Stripe instead. Nothing was emailed.`,
        );
      }
      throw new FinanceInputError(
        `The client may already have set up monthly card payments of ${was}/month with this invoice's retainer link, but its Stripe objects no longer match (${inspection.reason}). A new link could charge them twice a month: inspect the subscription in Stripe first. Nothing was emailed.`,
      );
    }
    if (inspection.state === "active" && inspection.exact && inv.stripe_retainer_link_url) return { kind: "link", url: inv.stripe_retainer_link_url };
    if (inspection.state === "active") await deactivateAndConfirmPaymentLink(key, inv.stripe_retainer_link_id);
  }

  if (inv.stripe_retainer_price_id && !inspection.priceExact) {
    await retireStripeCatalogObject(key, "prices", inv.stripe_retainer_price_id);
  }
  if (inv.stripe_retainer_product_id && !inspection.productExact) {
    await retireStripeCatalogObject(key, "products", inv.stripe_retainer_product_id);
  }

  const number = inv.number || null;
  const draft = number ? "" : "-d";
  const metadata: Record<string, string> = {
    "metadata[fin_retainer_invoice_id]": inv.id,
    ...(number ? { "metadata[fin_retainer_invoice_number]": number } : {}),
  };
  let current = inv;
  const made: MadeRetainerObjects = {};

  if (!inspection.productExact) {
    const product = await stripeRequest(
      key,
      "POST",
      "/v1/products",
      { name: number ? `Monthly retainer — invoice ${number}` : `Monthly retainer (invoice dated ${inv.issue_date})`, ...metadata },
      { idempotencyKey: `fin-rprod-${inv.id}${draft}-${inv.stripe_retainer_product_id || "first"}` },
    );
    const productId = typeof product.id === "string" ? product.id : "";
    if (!productId.startsWith("prod_") || product.livemode !== true || product.active !== true) throw new Error("Stripe did not return a live active product");
    made.productId = productId;
    const stored = await persistRetainerObject(
      current,
      `stripe_retainer_product_id = ?, stripe_retainer_price_id = NULL, stripe_retainer_price_cents = NULL,
       stripe_retainer_price_currency = NULL, stripe_retainer_link_id = NULL, stripe_retainer_link_url = NULL,
       stripe_retainer_link_cents = NULL, stripe_retainer_link_currency = NULL`,
      [productId],
    );
    if (!stored) return ensureRetainerLink(await recurringCasLost(key, current, made), actor);
    current = stored;
  }

  const productId = current.stripe_retainer_product_id || "";
  if (!inspection.priceExact || !current.stripe_retainer_price_id || current.stripe_retainer_product_id !== inv.stripe_retainer_product_id) {
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
      { idempotencyKey: `fin-rprice-${inv.id}-${monthly}-${inv.currency}${draft}-${productId}-${inv.stripe_retainer_price_id || "first"}` },
    );
    const priceId = typeof price.id === "string" ? price.id : "";
    if (!priceId.startsWith("price_") || price.livemode !== true || price.active !== true) throw new Error("Stripe did not return a live active recurring price");
    made.priceId = priceId;
    const stored = await persistRetainerObject(
      current,
      `stripe_retainer_price_id = ?, stripe_retainer_price_cents = ?, stripe_retainer_price_currency = ?,
       stripe_retainer_link_id = NULL, stripe_retainer_link_url = NULL, stripe_retainer_link_cents = NULL,
       stripe_retainer_link_currency = NULL`,
      [priceId, monthly, inv.currency],
    );
    if (!stored) return ensureRetainerLink(await recurringCasLost(key, current, made), actor);
    current = stored;
  }

  const priceId = current.stripe_retainer_price_id || "";
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
      "restrictions[completed_sessions][limit]": 1,
      "after_completion[type]": "hosted_confirmation",
      "after_completion[hosted_confirmation][custom_message]": retainerThanks(number),
      inactive_message: retainerInactive(number),
    },
    {
      idempotencyKey: `fin-rplink-${inv.id}-${priceId}-${inv.stripe_retainer_link_id || "first"}${draft}${
        inv.send_claim_token ? `-${inv.send_claim_token}` : ""
      }`,
    },
  );
  const linkId = typeof link.id === "string" ? link.id : "";
  const url = typeof link.url === "string" ? link.url : "";
  if (!linkId.startsWith("plink_") || !url.startsWith("https://") || link.livemode !== true || link.active !== true) {
    throw new Error("Stripe did not return a live active payment link");
  }
  made.linkId = linkId;
  const snapshot = retainerSnapshot(current);
  const out = await writeBatch([
    {
      sql: `UPDATE fin_invoices SET stripe_retainer_link_id = ?, stripe_retainer_link_url = ?, stripe_retainer_link_cents = ?,
                   stripe_retainer_link_currency = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${snapshot.sql}`,
      args: [linkId, url, monthly, inv.currency, ...snapshot.args],
    },
    conditionalAuditStatement(
      {
        entityId: inv.entity_id,
        actor,
        action: inv.stripe_retainer_link_id ? "invoice.retainer_link_replaced" : "invoice.retainer_link_created",
        objectType: "invoice",
        objectId: inv.id,
        detail: { link: linkId, price: priceId, monthly, currency: inv.currency, replaced: inv.stripe_retainer_link_id || null },
      },
      "changes() = 1",
    ),
  ]);
  if (out[0]?.rowsAffected !== 1) return ensureRetainerLink(await recurringCasLost(key, current, made), actor);
  return { kind: "link", url };
}

type LinkState = "active" | "used" | "switched_off" | "unknown";

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
  | { state: LinkState; url: string | null; linkCents: number; linkCurrency: string; stale: boolean; reason: string | null };

class StripeCheckTimedOut extends Error {}

export async function retainerLinkStatus(inv: InvoiceRow, timeoutMs = 5_000): Promise<RetainerLinkStatus> {
  if (inv.status === "draft" || !inv.stripe_retainer_link_id || !inv.stripe_retainer_link_url) return { state: "none" };
  const linkCents = Number(inv.stripe_retainer_link_cents ?? 0);
  const linkCurrency = inv.stripe_retainer_link_currency || inv.currency;
  const base = { url: null as string | null, linkCents, linkCurrency, stale: linkCents !== retainerMonthlyCents(inv) || linkCurrency !== inv.currency };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { key } = await getStripeClient();
    const inspection = await Promise.race([
      inspectRetainerObjects(key, inv),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StripeCheckTimedOut()), timeoutMs);
      }),
    ]);
    if (!inspection.exact) return { ...base, state: "unknown", reason: inspection.reason || recurringMismatchReason() };
    return {
      ...base,
      state: inspection.state,
      url: inspection.state === "active" ? inv.stripe_retainer_link_url : null,
      reason: inspection.reason,
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

/** Exact invoice state a send claim protects; optional post-184/185 fields are included only when present. */
function sendSnapshot(inv: InvoiceRow, alias = "fin_invoices"): { sql: string; args: Array<string | number | null> } {
  const fields: Array<[string, string | number | null]> = [
    ["id", inv.id],
    ["entity_id", inv.entity_id],
    ["contact_id", inv.contact_id],
    ["number", inv.number],
    ["status", inv.status],
    ["issue_date", inv.issue_date],
    ["due_date", inv.due_date],
    ["currency", inv.currency],
    ["subtotal_cents", inv.subtotal_cents],
    ["gst_cents", inv.gst_cents],
    ["qst_cents", inv.qst_cents],
    ["total_cents", inv.total_cents],
    ["amount_paid_cents", inv.amount_paid_cents],
    ["tax_registered_snapshot", inv.tax_registered_snapshot],
    ["recognition_entry_id", inv.recognition_entry_id],
    ["stripe_price_id", inv.stripe_price_id],
    ["stripe_payment_link_id", inv.stripe_payment_link_id],
    ["stripe_payment_link_url", inv.stripe_payment_link_url],
    ["sent_at", inv.sent_at],
    ["sent_to", inv.sent_to],
    ["updated_at", inv.updated_at],
    ["send_claim_token", inv.send_claim_token ?? null],
  ];
  if ("payment_method" in inv) fields.push(["payment_method", inv.payment_method ?? null]);
  if ("retainer_monthly_cents" in inv) {
    fields.push(
      ["retainer_monthly_cents", inv.retainer_monthly_cents ?? null],
      ["stripe_retainer_product_id", inv.stripe_retainer_product_id ?? null],
      ["stripe_retainer_price_id", inv.stripe_retainer_price_id ?? null],
      ["stripe_retainer_price_cents", inv.stripe_retainer_price_cents ?? null],
      ["stripe_retainer_price_currency", inv.stripe_retainer_price_currency ?? null],
      ["stripe_retainer_link_id", inv.stripe_retainer_link_id ?? null],
      ["stripe_retainer_link_url", inv.stripe_retainer_link_url ?? null],
      ["stripe_retainer_link_cents", inv.stripe_retainer_link_cents ?? null],
      ["stripe_retainer_link_currency", inv.stripe_retainer_link_currency ?? null],
    );
  }
  return { sql: fields.map(([name]) => `${alias}.${name} IS ?`).join(" AND "), args: fields.map(([, value]) => value) };
}

function sameSendSnapshot(current: InvoiceRow, expected: InvoiceRow): boolean {
  const a = sendSnapshot(current);
  const b = sendSnapshot(expected);
  return a.sql === b.sql && a.args.length === b.args.length && a.args.every((value, i) => value === b.args[i]);
}

async function acquireInvoiceSendClaim(expected: InvoiceRow): Promise<{ token: string; invoice: InvoiceRow }> {
  assertNoUnresolvedInvoiceEmail(expected, "sent again");
  const token = newId("send");
  const snapshot = sendSnapshot(expected);
  const out = await finDb().execute({
    sql: `UPDATE fin_invoices
             SET send_claim_token = ?, send_claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE ${snapshot.sql} AND send_claim_token IS NULL`,
    args: [token, ...snapshot.args],
  });
  if (out.rowsAffected !== 1) {
    const current = await loadInvoice(expected.id);
    if (!current) throw new FinanceNotFound();
    if (current.send_claim_token) throw new FinanceInputError(unresolvedInvoiceEmailMessage(current, "sent again"));
    throw new FinanceInputError("This invoice changed before its email attempt could be claimed. Reload it and send again. Nothing was emailed.");
  }
  const invoice = await loadInvoice(expected.id);
  if (!invoice || invoice.send_claim_token !== token) {
    throw new Error(`invoice ${expected.id} send claim was written but could not be read back`);
  }
  return { token, invoice };
}

async function releaseInvoiceSendClaim(invoiceId: string, token: string): Promise<void> {
  const out = await finDb().execute({
    sql: `UPDATE fin_invoices SET send_claim_token = NULL, send_claimed_at = NULL WHERE id = ? AND send_claim_token = ?`,
    args: [invoiceId, token],
  });
  if (out.rowsAffected !== 1) {
    const current = await loadInvoice(invoiceId);
    throw new Error(unresolvedInvoiceEmailMessage(current || {}, "released for another email attempt"));
  }
}

/** A draft failure retires both checkout URLs and clears them with this claim in one CAS. */
async function cleanupDraftSendFailure(invoiceId: string, token: string): Promise<void> {
  const current = await loadInvoice(invoiceId);
  if (!current || current.send_claim_token !== token) {
    throw new Error(unresolvedInvoiceEmailMessage(current || {}, "cleaned up after the failed email attempt"));
  }
  if (current.status !== "draft") {
    await releaseInvoiceSendClaim(invoiceId, token);
    return;
  }
  await deactivateInvoiceLinksStrict(current, "send");
  const hasRetainerColumns = await retainerColumnsReady();
  const out = await finDb().execute({
    sql: `UPDATE fin_invoices
             SET stripe_price_id = NULL, stripe_payment_link_id = NULL, stripe_payment_link_url = NULL,
                 ${
                   hasRetainerColumns
                     ? `stripe_retainer_link_id = NULL, stripe_retainer_link_url = NULL,
                        stripe_retainer_link_cents = NULL, stripe_retainer_link_currency = NULL,`
                     : ""
                 }
                 send_claim_token = NULL, send_claimed_at = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ? AND status = 'draft' AND send_claim_token = ?
             AND stripe_price_id IS ? AND stripe_payment_link_id IS ? AND stripe_payment_link_url IS ?
             ${
               hasRetainerColumns
                 ? `AND stripe_retainer_link_id IS ? AND stripe_retainer_link_url IS ?
                    AND stripe_retainer_link_cents IS ? AND stripe_retainer_link_currency IS ?`
                 : ""
             }`,
    args: [
      invoiceId,
      token,
      current.stripe_price_id,
      current.stripe_payment_link_id,
      current.stripe_payment_link_url,
      ...(
        hasRetainerColumns
          ? [
              current.stripe_retainer_link_id ?? null,
              current.stripe_retainer_link_url ?? null,
              current.stripe_retainer_link_cents ?? null,
              current.stripe_retainer_link_currency ?? null,
            ]
          : []
      ),
    ],
  });
  if (out.rowsAffected !== 1) {
    throw new Error(unresolvedInvoiceEmailMessage((await loadInvoice(invoiceId)) || current, "cleaned up after the failed email attempt"));
  }
}

/** Last app/provider check immediately before SMTP. */
async function invoiceReadyForSmtp(
  expected: InvoiceRow,
  token: string,
  cardUrl: string | null,
  retainer: RetainerLink | null,
): Promise<InvoiceRow> {
  const current = await loadInvoice(expected.id);
  if (!current || current.send_claim_token !== token || !sameSendSnapshot(current, expected)) {
    throw new FinanceInputError("This invoice changed after it was prepared, so the email was stopped. Verify the invoice and send it again. Nothing was emailed.");
  }
  if (current.status !== "sent" && current.status !== "overdue") {
    throw new FinanceInputError(`a ${current.status} invoice cannot be emailed`);
  }
  const method = storedPaymentMethod(current.payment_method);
  const dueNow = hasAmountDueNow(current);
  if (dueNow && method === "stripe" && !cardUrl) {
    throw new FinanceInputError("A card payment link is required for the amount due on a Stripe invoice. Nothing was emailed.");
  }
  if (cardUrl) {
    if (current.stripe_payment_link_url !== cardUrl) throw new FinanceInputError("The invoice's card link changed before email. Nothing was emailed.");
    const { key } = await getStripeClient();
    const due = balanceDueCents({ totalCents: current.total_cents, amountPaidCents: current.amount_paid_cents });
    if (!(await storedCardLinkReusable(key, current, due))) throw new FinanceInputError("The invoice's card link could not be verified immediately before email. Nothing was emailed.");
  }
  if (retainerMonthlyCents(current) > 0) {
    if (!retainer) throw new FinanceInputError("The invoice's monthly-retainer link is missing. Nothing was emailed.");
    const { key } = await getStripeClient();
    const inspection = await inspectRetainerObjects(key, current);
    const exactKind =
      inspection.exact &&
      ((retainer.kind === "link" && inspection.state === "active" && current.stripe_retainer_link_url === retainer.url) ||
        (retainer.kind === "set_up" && inspection.state === "used"));
    if (!exactKind) throw new FinanceInputError("The invoice's monthly-retainer Link, Price, and Product could not be verified immediately before email. Nothing was emailed.");
  }
  return current;
}

/** Reminder-specific last check: exact overdue row and exact remaining balance/card link. */
async function reminderReadyForSmtp(expected: InvoiceRow, token: string, cardUrl: string | null): Promise<InvoiceRow> {
  const current = await loadInvoice(expected.id);
  if (!current || current.send_claim_token !== token || !sameSendSnapshot(current, expected) || current.status !== "overdue") {
    throw new FinanceInputError("This invoice changed before the overdue reminder could be emailed. Nothing was emailed.");
  }
  const due = balanceDueCents({ totalCents: current.total_cents, amountPaidCents: current.amount_paid_cents });
  if (due <= 0) throw new FinanceInputError("This invoice no longer has an overdue balance. Nothing was emailed.");
  if (cardUrl) {
    if (current.stripe_payment_link_url !== cardUrl) throw new FinanceInputError("The reminder's card link changed before email. Nothing was emailed.");
    const { key } = await getStripeClient();
    if (!(await storedCardLinkReusable(key, current, due))) {
      throw new FinanceInputError("The reminder's card link could not be verified immediately before email. Nothing was emailed.");
    }
  }
  return current;
}

/**
 * Attach the payment options the invoice's method asks for, finalise it (if
 * draft), render the PDF and email it from the OASIS mailbox. Every failure
 * throws: the caller sees it and nothing pretends the customer was emailed.
 *
 * ORDER. Everything that can refuse happens BEFORE the draft is numbered and
 * its receivable booked: the issue checks (issueTotals), every Stripe link the
 * email needs (the retainer's, and the one-off link only in Stripe mode),
 * whether Wise can supply its details, "is there any way to
 * pay", and the mailbox. So a key without Prices / Payment Links write, a Wise
 * outage with no fallback, or a missing mailbox leaves a DRAFT with one plain
 * sentence — never an issued, booked invoice nobody was sent. finalizeInvoice
 * then refuses to issue anything other than what the links were made for.
 * (Once issued, only the SMTP send itself can still fail; the invoice then
 * shows "issued, not emailed" and is re-sent without renumbering.)
 *
 * A one-time card link is attached only in Stripe mode (unless the sender turns
 * it off — the flow every invoice before migration 184 used). Wise and Hybrid
 * never fall back to one; without Wise details or written payment instructions,
 * the invoice is refused because it would ask for money with no way to pay.
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
  if (before.status === "draft" && !isActiveInvoiceCustomer(before, contact)) throw new FinanceInputError(ACTIVE_CUSTOMER_REQUIRED);
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
  assertPaymentMode(method, { totalCents: planned.total_cents, monthly: { totalCents: retainerMonthlyCents(planned) } });
  const dueNow = hasAmountDueNow(planned);
  if (dueNow && method === "stripe" && opts.paymentLink === false) {
    throw new FinanceInputError("A card payment link is required for the amount due on a Stripe invoice. Nothing was emailed.");
  }
  const claim = await acquireInvoiceSendClaim(before);
  planned = {
    ...planned,
    ...claim.invoice,
    subtotal_cents: planned.subtotal_cents,
    gst_cents: planned.gst_cents,
    qst_cents: planned.qst_cents,
    total_cents: planned.total_cents,
  };
  let smtpStarted = false;
  try {

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
  const wise = await wiseDetailsFor(planned);
  const settings = await loadSettings(entity.id);
  // Only Stripe mode offers a one-time card rail. Wise and Hybrid never fall
  // back to a card link for the implementation amount.
  const cardWanted = dueNow && offersCard(method);
  let url: string | null = null;
  if (cardWanted) {
    try {
      url = await ensurePaymentLink(planned, before);
    } catch (e) {
      throw refusedByStripe(e, "card");
    }
  }
  if (dueNow && offersBankTransfer(method) && !wise.details && !url && !settings.payment_instructions.trim()) {
    throw new FinanceInputError(`${wise.notice} There are no written payment instructions either, so the client would have no way to pay. The invoice was NOT emailed.`);
  }
  // 3. The mailbox it leaves from (InvoiceMailerNotConfigured, still a draft).
  await resolveInvoiceMailbox(financeTenantId());

  // 4. Only now: number it and book the receivable — exactly what the links were made for.
  const inv = wasDraft
    ? await finalizeInvoice(viewer, invoiceId, {
        totalCents: planned.total_cents,
        monthlyCents: retainerCents,
        currency: planned.currency,
        contactId: planned.contact_id,
        cardLinkVerified: url !== null,
        sendClaimToken: claim.token,
      })
    : await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  if (inv.send_claim_token !== claim.token || (inv.status !== "sent" && inv.status !== "overdue")) {
    throw new FinanceInputError(ISSUE_CHANGED_DURING_SEND);
  }
  if (wasDraft) {
    await numberPaymentLinks(inv, { card: url ? inv.stripe_payment_link_id : null, retainer: retainer?.kind === "link" ? inv.stripe_retainer_link_id ?? null : null });
  }
  const prepared = await loadInvoice(invoiceId);
  if (!prepared) throw new FinanceNotFound();
  const ready = await invoiceReadyForSmtp(prepared, claim.token, url, retainer);
  const retainerUrl = retainer?.kind === "link" ? retainer.url : null;
  const retainerSetUp = retainer?.kind === "set_up";
  const bankLines = wiseLines(wise.details, ready);
  // The PDF carries the card link this send verified, never another one stored on the row.
  const pdf = await pdfFor({ ...ready, stripe_payment_link_url: url, stripe_retainer_link_url: retainerUrl }, lines, contact, settings, { bankTransfer: bankLines, retainerSetUp });
  const mail = composeInvoiceEmail({
    kind: "invoice",
    sellerName: settings.legal_name,
    customerName: contact?.name || "",
    number: ready.number as string,
    totalCents: ready.total_cents,
    balanceCents: balanceDueCents({ totalCents: ready.total_cents, amountPaidCents: ready.amount_paid_cents }),
    currency: ready.currency,
    dueDate: ready.due_date,
    paymentLinkUrl: url,
    paymentInstructions: dueNow ? settings.payment_instructions : "",
    bankTransfer: bankLines,
    ...(retainer
      ? { retainer: retainer.kind === "link" ? { monthlyCents: retainerCents, linkUrl: retainer.url } : { monthlyCents: retainerCents, setUp: true as const } }
      : {}),
  });
  smtpStarted = true;
  const sent = await sendInvoiceEmail({ tenantId: financeTenantId(), to, ...mail, pdf, filename: `${ready.number}.pdf` });
  const sentSnapshot = sendSnapshot(ready);
  const sentOut = await writeBatch([
    {
      sql: `UPDATE fin_invoices
               SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), sent_to = ?, send_claim_token = NULL, send_claimed_at = NULL
             WHERE ${sentSnapshot.sql} AND send_claim_token = ?`,
      args: [to, ...sentSnapshot.args, claim.token],
    },
    conditionalAuditStatement(
      {
        entityId: entity.id,
        actor: viewerLabel(viewer),
        action: "invoice.emailed",
        objectType: "invoice",
        objectId: invoiceId,
        detail: { to, from: sent.from, link: Boolean(url), method, wise: Boolean(bankLines), notice: wise.notice, ...(retainerCents > 0 ? { retainer: retainerCents, retainer_link: Boolean(retainerUrl), retainer_set_up: retainerSetUp } : {}) },
      },
      "changes() = 1",
    ),
  ]);
  if (sentOut[0]?.rowsAffected !== 1) {
    throw new Error(unresolvedInvoiceEmailMessage((await loadInvoice(invoiceId)) || ready, "marked as emailed"));
  }
  return {
    invoiceId,
    number: ready.number as string,
    emailedTo: to,
    paymentLinkUrl: url,
    retainerLinkUrl: retainerUrl,
    retainerAlreadySetUp: retainerSetUp,
    messageId: sent.messageId,
    bankTransfer: Boolean(bankLines),
    notice: wise.notice,
  };
  } catch (error) {
    if (!smtpStarted) {
      try {
        await cleanupDraftSendFailure(invoiceId, claim.token);
      } catch (cleanupError) {
        console.error("[finances:invoices] failed to clean up a pre-SMTP invoice attempt", invoiceId, cleanupError);
        throw cleanupError;
      }
    }
    throw error;
  }
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
  assertNoUnresolvedInvoiceEmail(inv, "paid manually");
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
  const paymentGate = { sql: `EXISTS (SELECT 1 FROM fin_payments WHERE id = ?)`, args: [paymentId] };
  const invoiceSnapshot = oneTimeLinkSnapshot(inv, "payment_i");
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
    gate: paymentGate,
  });
  // A full-value card link must be impossible to use before an out-of-band
  // payment reduces the balance. Stripe failure stops here with no book entry.
  await retireOneTimePaymentLinkForExternalPayment(inv);
  const out = await writeBatch([
    {
      sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents,
              fee_status, settlement_estimated, invoice_id, contact_id, customer_name, customer_email, deposit_account_id, description, livemode, created_by)
            SELECT ?, ?, 'payment', 'manual', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?, 1, ?
             WHERE EXISTS (
              SELECT 1 FROM fin_invoices payment_i
                WHERE ${invoiceSnapshot.sql} AND payment_i.send_claim_token IS NULL
             )`,
      args: [
        paymentId, entity.id, `${date}T12:00:00.000Z`, date, amount, inv.currency, receivedCad, estimated, inv.id, inv.contact_id,
        contact?.name || "", contact?.email || "", depositId, text(raw.reference, 200) || "Manual payment", viewerLabel(viewer),
        ...invoiceSnapshot.args,
      ],
    },
    clearOneTimePaymentLinkStatement(inv, paymentGate),
    ...posting.statements,
    { sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`, args: [posting.entryId, paymentId, posting.entryId] },
    recomputeInvoicePaidStatement(inv.id, new Date().toISOString(), paymentGate),
    conditionalAuditStatement(
      { entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.paid_manually", objectType: "invoice", objectId: inv.id, detail: { amount, receivedCad, estimated: estimated === 1 } },
      "EXISTS (SELECT 1 FROM fin_payments WHERE id = ?)",
      [paymentId],
    ),
  ]);
  if (out[0]?.rowsAffected !== 1) {
    const current = await loadInvoice(invoiceId);
    if (current?.send_claim_token) throw new FinanceInputError(unresolvedInvoiceEmailMessage(current, "paid manually"));
    throw new FinanceInputError("This invoice changed while the payment was being recorded. Reload it and try again; no payment was recorded.");
  }
  return paymentId;
}

// ── void, overdue, reminders ─────────────────────────────────────────────

export async function voidInvoice(viewer: FinanceViewer, invoiceId: string): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_invoices", invoiceId);
  const inv = await loadInvoice(invoiceId);
  if (!inv) throw new FinanceNotFound();
  if (!canTransition(inv.status, "void")) throw new FinanceInputError(`a ${inv.status} invoice cannot be voided`);
  if (inv.amount_paid_cents > 0) throw new FinanceInputError("this invoice has payments; refund them before voiding");
  assertNoUnresolvedInvoiceEmail(inv, "voided");
  await deactivateInvoiceLinksStrict(inv, "void");
  const hasRetainerColumns = await retainerColumnsReady();
  const operationId = newId("aud");
  const operationGate = { sql: `EXISTS (SELECT 1 FROM fin_audit_log WHERE id = ?)`, args: [operationId] };
  const snapshot = oneTimeLinkSnapshot(inv);
  const statements: InStatement[] = [
    {
      sql: `UPDATE fin_invoices
               SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE ${snapshot.sql} AND amount_paid_cents = 0 AND recognition_entry_id IS ? AND send_claim_token IS NULL
               ${
                 hasRetainerColumns
                   ? `AND stripe_retainer_product_id IS ? AND stripe_retainer_price_id IS ?
                      AND stripe_retainer_price_cents IS ? AND stripe_retainer_price_currency IS ?
                      AND stripe_retainer_link_id IS ? AND stripe_retainer_link_url IS ?
                      AND stripe_retainer_link_cents IS ? AND stripe_retainer_link_currency IS ?`
                   : ""
               }`,
      args: [
        ...snapshot.args,
        inv.recognition_entry_id,
        ...(
          hasRetainerColumns
            ? [
                inv.stripe_retainer_product_id ?? null,
                inv.stripe_retainer_price_id ?? null,
                inv.stripe_retainer_price_cents ?? null,
                inv.stripe_retainer_price_currency ?? null,
                inv.stripe_retainer_link_id ?? null,
                inv.stripe_retainer_link_url ?? null,
                inv.stripe_retainer_link_cents ?? null,
                inv.stripe_retainer_link_currency ?? null,
              ]
            : []
        ),
      ],
    },
    {
      sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
            SELECT ?, ?, ?, 'invoice.voided', 'invoice', ?, '{}' WHERE changes() = 1`,
      args: [operationId, entity.id, viewerLabel(viewer).slice(0, 200), invoiceId],
    },
  ];
  if (inv.recognition_entry_id) {
    const rev = await buildReversal({
      entityId: entity.id,
      entryId: inv.recognition_entry_id,
      date: torontoToday(),
      memo: `Void invoice ${inv.number}`,
      createdBy: viewerLabel(viewer),
      gate: operationGate,
    });
    statements.push(...rev.statements);
  }
  const out = await writeBatch(statements);
  if (out[0]?.rowsAffected !== 1) {
    const current = await loadInvoice(invoiceId);
    if (current?.send_claim_token) throw new FinanceInputError(unresolvedInvoiceEmailMessage(current, "voided"));
    throw new FinanceInputError("This invoice changed while it was being voided. Reload it and try again; no bookkeeping changes were made.");
  }
}

/**
 * A voided invoice's retainer link stops taking new subscriptions. A
 * subscription the client already started keeps running: cancelling one is a
 * decision for Stripe's dashboard, not a side effect of voiding a document.
 */
async function deactivateRetainerLink(inv: InvoiceRow): Promise<void> {
  if (!inv.stripe_retainer_link_id) return;
  const { key } = await getStripeClient();
  await deactivateAndConfirmPaymentLink(key, inv.stripe_retainer_link_id);
}

/** Every persisted checkout URL is proved off before void/delete changes local state. */
async function deactivateInvoiceLinksStrict(inv: InvoiceRow, action: "void" | "delete" | "send"): Promise<void> {
  try {
    const hasOneTime = Boolean(inv.stripe_price_id || inv.stripe_payment_link_id || inv.stripe_payment_link_url);
    if (hasOneTime) {
      if (!inv.stripe_payment_link_id) throw new Error(`invoice ${inv.id} has one-time link fields without a Payment Link id`);
      const { key } = await getStripeClient();
      await deactivateAndConfirmPaymentLink(key, inv.stripe_payment_link_id);
    }
    const hasRetainerLink = Boolean(inv.stripe_retainer_link_id || inv.stripe_retainer_link_url);
    if (hasRetainerLink && !inv.stripe_retainer_link_id) throw new Error(`invoice ${inv.id} has retainer link fields without a Payment Link id`);
    if (hasRetainerLink) await deactivateRetainerLink(inv);
  } catch (e) {
    console.error(`[finances:invoices] could not shut down Stripe links before invoice ${action}`, inv.id, e instanceof Error ? e.message : e);
    const outcome = action === "void" ? "voided" : action === "delete" ? "deleted" : "cleaned up after the failed send";
    throw new FinanceInputError(`Stripe couldn't confirm every payment link was off, so the invoice was not ${outcome}. Check Stripe and try again.`);
  }
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
      let claimToken: string | null = null;
      let smtpStarted = false;
      try {
        const claim = await acquireInvoiceSendClaim(r);
        claimToken = claim.token;
        const claimed = claim.invoice;
        const lines = await loadInvoiceLines(claimed.id);
        const contact = await loadContact(claimed.contact_id);
        const wise = await bankTransferFor(claimed);
        const method = storedPaymentMethod(claimed.payment_method);
        let oneTimeUrl: string | null = null;
        if (offersCard(method)) {
          oneTimeUrl = await ensurePaymentLink(claimed, claimed);
        } else {
          // Old rows may predate payment_method. A bank/Hybrid reminder never
          // leaks that legacy full-balance card rail back into an email/PDF.
          await retireLegacyOneTimePaymentLink(claimed);
        }
        const prepared = await loadInvoice(claimed.id);
        if (!prepared) throw new FinanceNotFound();
        const ready = await reminderReadyForSmtp(prepared, claim.token, oneTimeUrl);
        const printable = { ...ready, stripe_payment_link_url: oneTimeUrl, stripe_retainer_link_url: null };
        if (wise.notice) console.error("[finances:invoices] reminder without Wise details", ready.number, wise.notice);
        // Same rule as sendInvoice: never ask for money with no way to pay.
        if (offersBankTransfer(method) && !wise.lines && !oneTimeUrl && !settings.payment_instructions.trim()) {
          throw new FinanceInputError(
            `${wise.notice || "Wise bank details are unavailable."} There are no written payment instructions either, so the reminder was NOT sent.`,
          );
        }
        // A reminder chases the ONE-TIME balance only: its PDF leaves off the retainer (lines, totals, section and link),
        // and composeInvoiceEmail never puts the retainer in a reminder.
        const pdf = await pdfFor(printable, lines, contact, settings, { bankTransfer: wise.lines, oneTimeOnly: true });
        const mail = composeInvoiceEmail({
          kind: "reminder",
          sellerName: settings.legal_name,
          customerName: r.contact_name,
          number: ready.number || "",
          totalCents: ready.total_cents,
          balanceCents: balanceDueCents({ totalCents: ready.total_cents, amountPaidCents: ready.amount_paid_cents }),
          currency: ready.currency,
          dueDate: ready.due_date,
          paymentLinkUrl: oneTimeUrl,
          paymentInstructions: settings.payment_instructions,
          bankTransfer: wise.lines,
        });
        smtpStarted = true;
        await sendInvoiceEmail({ tenantId: financeTenantId(), to, ...mail, pdf, filename: `${ready.number}.pdf` });
        const snapshot = sendSnapshot(ready);
        const out = await writeBatch([
          {
            sql: `UPDATE fin_invoices
                     SET last_reminded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reminder_count = reminder_count + 1,
                         send_claim_token = NULL, send_claimed_at = NULL
                   WHERE ${snapshot.sql} AND send_claim_token = ?`,
            args: [...snapshot.args, claim.token],
          },
          conditionalAuditStatement(
            { entityId: entity.id, actor: viewerLabel(viewer), action: "invoice.reminder_sent", objectType: "invoice", objectId: r.id, detail: { to } },
            "changes() = 1",
          ),
        ]);
        if (out[0]?.rowsAffected !== 1) {
          throw new Error(unresolvedInvoiceEmailMessage((await loadInvoice(r.id)) || ready, "marked as reminded"));
        }
        plan.action = "sent";
      } catch (e) {
        if (claimToken && !smtpStarted) {
          try {
            await releaseInvoiceSendClaim(r.id, claimToken);
          } catch (releaseError) {
            console.error("[finances:invoices] failed to release a pre-SMTP reminder claim", r.id, releaseError);
            e = releaseError;
          }
        }
        plan.action = "failed";
        plan.reason = e instanceof Error ? e.message.slice(0, 300) : "send failed";
      }
    }
    plans.push(plan);
  }
  return plans;
}
