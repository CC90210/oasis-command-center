/**
 * Wise (the business bank) for invoicing — PURE: parsing Wise's response
 * shapes, the bank-transfer lines an invoice prints, and matching incoming
 * deposits to open invoices. No I/O; wise-io.ts fetches, wise-reconcile.ts
 * writes.
 *
 * WHY WISE AND STRIPE BOTH. Wise is where money lands: a one-off or lump-sum
 * invoice is paid by bank transfer into the Wise account for its currency,
 * with the invoice number as the payment reference. Stripe is the card
 * processor and stays the path for recurring (MRR) billing, where automatic
 * payment matters. An invoice can offer either or both.
 *
 * RESPONSE SHAPES were probed live against OASIS's business profile
 * (Bravo's scripts/integrations/wise_tool.py, 2026-09-24), not taken from
 * docs. The receiving details come from the balance STATEMENT's
 * `bankDetails` block because it labels every code the way Wise does
 * ("Institution number", "Transit number", "Routing number", "Swift/BIC");
 * /v1/profiles/{id}/account-details answers 403 for this token, and the
 * legacy /v1/borderless-accounts omits the CAD transit number entirely.
 */

export const INVOICE_PAYMENT_METHODS = ["wise", "stripe", "wise_stripe"] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Readonly<Record<InvoicePaymentMethod, string>> = {
  wise: "Bank transfer (Wise)",
  stripe: "Card (Stripe)",
  wise_stripe: "Bank transfer (Wise) or card (Stripe)",
};

/** A new one-off invoice asks for a bank transfer; recurring billing stays on Stripe subscriptions. */
export const DEFAULT_NEW_INVOICE_METHOD: InvoicePaymentMethod = "wise";

export function parsePaymentMethod(value: unknown): InvoicePaymentMethod | null {
  return typeof value === "string" && (INVOICE_PAYMENT_METHODS as readonly string[]).includes(value) ? (value as InvoicePaymentMethod) : null;
}

/**
 * The method an invoice row carries. Rows from before migration 184 (or a
 * database it has not reached yet) have no column: they were all issued with
 * a card link, so they read as "stripe" and behave exactly as they did.
 */
export function storedPaymentMethod(value: unknown): InvoicePaymentMethod {
  return parsePaymentMethod(value) ?? "stripe";
}

export const offersBankTransfer = (m: InvoicePaymentMethod): boolean => m === "wise" || m === "wise_stripe";
export const offersCard = (m: InvoicePaymentMethod): boolean => m === "stripe" || m === "wise_stripe";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

// ── receiving details ────────────────────────────────────────────────────

export type WiseDetailField = { label: string; value: string };

export type WiseReceivingDetails = {
  currency: string;
  accountHolder: string;
  bankName: string;
  bankAddress: string;
  /** Codes first (institution/transit/routing), then the account number, Swift/BIC last. */
  fields: WiseDetailField[];
};

/** From a statement.json body: the live (non-deprecated) receiving details, or null. */
export function receivingDetailsFromStatement(statement: unknown, currency: string): WiseReceivingDetails | null {
  const s = obj(statement);
  if (!s) return null;
  const blocks = Array.isArray(s.bankDetails) ? s.bankDetails.map(obj).filter((b): b is Obj => b !== null) : [];
  const live = blocks.find((b) => b.deprecated !== true);
  if (!live) return null;
  const holder = obj(s.accountHolder);
  const accountHolder =
    str(holder?.businessName) || [str(holder?.firstName), str(holder?.lastName)].filter(Boolean).join(" ");
  const addr = obj(live.address);
  const codes = (Array.isArray(live.bankCodes) ? live.bankCodes : [])
    .map(obj)
    .filter((c): c is Obj => c !== null)
    .map((c) => ({ label: str(c.scheme), value: str(c.value) }))
    .filter((f) => f.label && f.value);
  const accounts = (Array.isArray(live.accountNumbers) ? live.accountNumbers : [])
    .map(obj)
    .filter((a): a is Obj => a !== null)
    .map((a) => ({ label: str(a.accountType) || "Account number", value: str(a.accountNumber) }))
    .filter((f) => f.value);
  if (!accountHolder || accounts.length === 0) return null;
  const isSwift = (f: WiseDetailField) => /swift|bic/i.test(f.label);
  const place = [str(addr?.city), str(addr?.stateCode), str(addr?.postCode)].filter(Boolean).join(" ");
  return {
    currency,
    accountHolder,
    bankName: str(addr?.firstLine),
    bankAddress: [str(addr?.secondLine), place, str(addr?.country)].filter(Boolean).join(", "),
    fields: [...codes.filter((f) => !isSwift(f)), ...accounts, ...codes.filter(isSwift)],
  };
}

/** The lines an invoice prints under "Pay by bank transfer". The reference line is what lets reconcile match it. */
export function bankTransferLines(d: WiseReceivingDetails, reference: string): WiseDetailField[] {
  const bank = [d.bankName, d.bankAddress].filter(Boolean).join(", ");
  return [
    { label: "Account holder", value: d.accountHolder },
    ...(bank ? [{ label: "Bank", value: bank }] : []),
    ...d.fields,
    { label: "Payment reference", value: reference },
  ];
}

/** "200123453111" -> "****3111" for screens; invoices print the full number. */
export function maskAccountNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length < 5 ? value : `****${digits.slice(-4)}`;
}

// ── deposits ─────────────────────────────────────────────────────────────

/**
 * Money that ARRIVED in a Wise balance and could be a client paying an
 * invoice: a bank transfer in (DEPOSIT) or a card payment Wise acquired
 * (ACQUIRING_PAYMENT, which arrives net of Wise's fee). Conversions,
 * top-ups (MONEY_ADDED) and card refunds are not client payments.
 */
export const CLIENT_DEPOSIT_KINDS = ["DEPOSIT", "ACQUIRING_PAYMENT"] as const;

export type WiseDeposit = {
  /** Wise's transaction reference ("TRANSFER-123…") — the idempotency key. */
  ref: string;
  occurredAt: string;
  currency: string;
  netCents: number;
  feeCents: number;
  grossCents: number;
  kind: string;
  sender: string;
  /** What the payer typed as the payment reference. */
  reference: string;
  description: string;
};

export function wiseValueToCents(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function depositsFromStatement(statement: unknown): WiseDeposit[] {
  const s = obj(statement);
  const txns = Array.isArray(s?.transactions) ? (s!.transactions as unknown[]) : [];
  const out: WiseDeposit[] = [];
  for (const raw of txns) {
    const t = obj(raw);
    const details = obj(t?.details);
    const amount = obj(t?.amount);
    if (!t || !details || !amount || t.type !== "CREDIT") continue;
    const kind = str(details.type);
    if (!(CLIENT_DEPOSIT_KINDS as readonly string[]).includes(kind)) continue;
    const ref = str(t.referenceNumber);
    const net = wiseValueToCents(amount.value);
    const fee = wiseValueToCents(obj(t.totalFees)?.value) ?? 0;
    const occurredAt = str(t.date);
    if (!ref || net === null || net <= 0 || !occurredAt || Number.isNaN(Date.parse(occurredAt))) continue;
    out.push({
      ref,
      occurredAt,
      currency: str(amount.currency).toUpperCase(),
      netCents: net,
      feeCents: Math.max(0, fee),
      grossCents: net + Math.max(0, fee),
      kind,
      sender: str(details.senderName) || str(details.payerName),
      reference: str(details.paymentReference),
      description: str(details.description),
    });
  }
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────

export type OpenInvoiceForMatch = {
  id: string;
  number: string;
  currency: string;
  balanceCents: number;
  contactName: string;
};

export type WiseMatch = {
  deposit: WiseDeposit;
  invoice: OpenInvoiceForMatch;
  reason: string;
};

export type WiseProposal = {
  /** Reference names exactly one invoice AND the amount and currency settle it: safe to record. */
  exact: WiseMatch[];
  /** Anything less certain: listed for a founder to confirm, never recorded automatically. */
  fuzzy: WiseMatch[];
  alreadyRecorded: number;
  ignored: Array<{ deposit: WiseDeposit; reason: string }>;
  unmatched: WiseDeposit[];
};

export function normalizeReference(s: string): string {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Does `text` carry `invoiceNumber`? Compared with punctuation and case
 * stripped ("oasis 2026 0007" names OASIS-2026-0007), and a digit may not
 * follow the match, so OASIS-2026-1000 is not found inside OASIS-2026-10000.
 */
export function referenceNames(invoiceNumber: string, text: string): boolean {
  const needle = normalizeReference(invoiceNumber);
  const hay = normalizeReference(text);
  if (needle.length < 4) return false;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    const next = hay.charAt(at + needle.length);
    if (!/[0-9]/.test(next)) return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

/**
 * How a deposit settles an invoice's balance, in the invoice currency.
 *  - net == due: the payer covered Wise's fee; record the balance, no fee.
 *  - gross == due: Wise kept a fee; record the balance and book the fee.
 *  - gross < due: a partial payment of the gross, fee booked.
 *  - more than due: null — an overpayment is recorded by hand, never guessed.
 */
export function settlementFor(deposit: WiseDeposit, balanceCents: number): { amountCents: number; feeCents: number; full: boolean } | null {
  if (balanceCents <= 0) return null;
  if (deposit.netCents === balanceCents) return { amountCents: balanceCents, feeCents: 0, full: true };
  if (deposit.grossCents === balanceCents) return { amountCents: balanceCents, feeCents: deposit.feeCents, full: true };
  if (deposit.grossCents < balanceCents) return { amountCents: deposit.grossCents, feeCents: deposit.feeCents, full: false };
  return null;
}

const settlesExactly = (d: WiseDeposit, inv: OpenInvoiceForMatch) =>
  d.currency === inv.currency && (d.netCents === inv.balanceCents || d.grossCents === inv.balanceCents);

export function proposeWiseMatches(
  deposits: readonly WiseDeposit[],
  invoices: readonly OpenInvoiceForMatch[],
  opts: { recordedRefs: ReadonlySet<string>; dismissed: ReadonlySet<string> },
): WiseProposal {
  const out: WiseProposal = { exact: [], fuzzy: [], alreadyRecorded: 0, ignored: [], unmatched: [] };
  const claimed = new Set<string>();
  const fuzzy = (deposit: WiseDeposit, invoice: OpenInvoiceForMatch, reason: string) => {
    if (!opts.dismissed.has(dismissKey(deposit.ref, invoice.id))) out.fuzzy.push({ deposit, invoice, reason });
  };
  // Oldest first, so when one invoice is paid twice the earlier deposit is the exact one.
  const ordered = [...deposits].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const d of ordered) {
    if (opts.recordedRefs.has(d.ref)) {
      out.alreadyRecorded += 1;
      continue;
    }
    if (/\bstripe\b/i.test(d.sender) || /\bstripe\b/i.test(d.description)) {
      out.ignored.push({ deposit: d, reason: "Stripe payout — card payments are recorded from Stripe itself" });
      continue;
    }
    const text = `${d.reference} ${d.description}`;
    const named = invoices.filter((inv) => referenceNames(inv.number, text));
    if (named.length === 1) {
      const inv = named[0];
      if (settlesExactly(d, inv) && !claimed.has(inv.id)) {
        claimed.add(inv.id);
        out.exact.push({ deposit: d, invoice: inv, reason: `reference ${inv.number}, amount and currency match` });
      } else if (claimed.has(inv.id)) {
        fuzzy(d, inv, "another deposit already settles this invoice");
      } else if (d.currency !== inv.currency) {
        fuzzy(d, inv, `reference matches, but the deposit is ${d.currency} and the invoice is ${inv.currency}`);
      } else {
        fuzzy(d, inv, `reference matches, amount differs (received ${d.grossCents}, due ${inv.balanceCents} cents)`);
      }
      continue;
    }
    if (named.length > 1) {
      for (const inv of named) fuzzy(d, inv, "the reference names more than one invoice");
      continue;
    }
    const byAmount = invoices.filter((inv) => settlesExactly(d, inv));
    if (byAmount.length > 0) {
      for (const inv of byAmount) fuzzy(d, inv, "amount and currency match, but the reference has no invoice number");
      continue;
    }
    out.unmatched.push(d);
  }
  return out;
}

export function dismissKey(wiseRef: string, invoiceId: string): string {
  return `${wiseRef}|${invoiceId}`;
}
