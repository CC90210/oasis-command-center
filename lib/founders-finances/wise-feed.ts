/**
 * Wise bank feed — PURE. Turns a Wise balance statement into rows the
 * statement import already understands, tags Stripe payouts, and reads the
 * balance at the end of a day. wise-feed-io.ts fetches and imports.
 *
 * WHY OFX. The feed goes through the SAME import the CSV/OFX upload uses
 * (transactions-io.ts previewImport / commitImport), so the dedupe hash, the
 * categorisation rules and the import history apply unchanged. An OFX row
 * carries a FITID and the import's dedupe hash for such a row is the FITID
 * alone, so the FITID is built from Wise's own transaction reference: a
 * re-sync inserts nothing.
 *
 * FITID = WISE-<currency>-<CREDIT|DEBIT>-<referenceNumber>. Live statements
 * (2026-09-24) reuse one reference across rows: a conversion is a DEBIT in
 * one balance and a CREDIT in the other, and a card transaction can split
 * across the CAD and USD balances. Every row lands on the same ledger account
 * (1000 Business chequing), so currency and direction are part of the id.
 *
 * STRIPE PAYOUTS do not say "Stripe" on Wise. They arrive as "Received money
 * from OASIS AI" (Stripe sends under the account's business name; all 12 live
 * USD payouts matched this way). A deposit is tagged "Stripe payout po_…"
 * only when it matches a real Stripe payout — same currency, same amount to
 * the cent, arriving within 3 days. The feed then books it itself (never
 * through a rule, never as revenue): out of 1050 Stripe clearing in the
 * currency and amount Stripe says the payout took from the Stripe balance
 * (its balance transaction), into chequing in the currency it arrived in,
 * through 1060 Currency exchange clearing with the difference to FX gain/loss
 * when the two currencies differ (stripePayoutLines). Only when Stripe
 * clearing holds that much in that currency: the live Stripe balance is USD
 * (2026-09-25) while the live charges sit in Stripe clearing in CAD, and until
 * those agree a payout is held for review rather than driving USD clearing
 * negative (stripePayoutBlocker).
 *
 * WHAT THE FEED RESOLVES ITSELF (planFeed), before any rule sees a line:
 *   - a deposit "Check for Wise payments" already recorded -> set aside;
 *   - a debit that IS an expense/bill already on the books (same account,
 *     amount and currency, within BILL_MATCH_WINDOW_DAYS, closest date, each
 *     bill once) -> LINKED to that entry, nothing new posted; ambiguous ->
 *     left unreviewed for a founder with the candidates named;
 *   - 2 to 4 debits that add up exactly to one such expense (an expense
 *     recorded as one amount, paid as several charges) -> held for a founder;
 *   - a Stripe payout -> booked as above;
 *   - a Wise conversion (a DEBIT in one balance and a CREDIT in the other under
 *     one reference) -> both legs through 1060, Wise's fee to Bank fees and
 *     the rest of the gap to FX gain/loss (conversionLegLines);
 *   - a line dated on or before the opening balance that arrived AFTER it was
 *     posted -> held: the opening balance already contains it.
 * Everything else goes through the rules exactly like an uploaded statement.
 */

import type { JournalLineInput } from "./ledger";
import { addDays, torontoDateOf } from "./fx";
import { wiseValueToCents } from "./wise";

/**
 * WRITES ARE OFF BY DEFAULT. The bank matching an independent review asked
 * for (2026-09-24: expenses already on the books, deposits already recorded
 * against an invoice, conversions, Stripe payouts, a replaceable opening
 * balance) is in place and tested (tests/finances-wise-matching.test.ts), but
 * the switch stays off until the lead engineer flips it after verifying on
 * the live data. Off, both functions refuse to write and still answer a dry
 * run, so the preview shows what a sync would do.
 */
// Off unless the server sets FINANCE_WISE_FEED_WRITES=on (production does not;
// the feed's own tests do, to keep exercising the logic being finished). In a
// browser bundle the variable is absent, so the buttons read "off" too.
export const WISE_FEED_WRITES_ENABLED = process.env.FINANCE_WISE_FEED_WRITES === "on";
export const WISE_FEED_OFF_MESSAGE =
  "Syncing Wise into the books is switched off until the bank matching has been checked against the live books, so nothing is counted twice. Previews still work, and invoice payments from Wise are still recorded by \"Check for Wise payments\".";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export type WiseFeedRow = {
  fitid: string;
  /** Toronto calendar day, like every other date in the books. */
  postedDate: string;
  occurredAt: string;
  /** Signed balance movement. Wise's fee is already inside it (live: a CAD 370.00 conversion with a 1.69 fee moved the balance by exactly -370.00). */
  amountCents: number;
  /** Wise's fee on this row, in the row's currency (0 when none). Informational: it is already inside amountCents. */
  feeCents: number;
  currency: string;
  /** Wise's detail type: CARD, DEPOSIT, TRANSFER, CONVERSION, ACQUIRING_PAYMENT, MONEY_ADDED, DIRECT_DEBIT… */
  kind: string;
  ref: string;
  name: string;
  memo: string;
};

export function wiseFitid(currency: string, direction: "CREDIT" | "DEBIT", ref: string): string {
  return `WISE-${currency.toUpperCase()}-${direction}-${ref}`;
}

/** wiseFitid's parts back, or null for a FITID the feed did not write. */
export function parseWiseFitid(fitid: string | null | undefined): { currency: string; direction: "CREDIT" | "DEBIT"; ref: string } | null {
  const m = /^WISE-([A-Z]{3})-(CREDIT|DEBIT)-(.+)$/.exec(fitid || "");
  return m ? { currency: m[1], direction: m[2] as "CREDIT" | "DEBIT", ref: m[3] } : null;
}

/**
 * Every note the feed writes on a line it HOLDS for a founder starts with
 * this (wise-feed-io.ts). transactions-io.ts keeps every rule off a held line
 * — at import, "Apply rules", "create rule from transaction" — because a held
 * line may be money already on the books.
 */
export const FEED_HOLD_MARK = "Wise feed";
/** The source of an opening-balance entry (wise-feed-io.ts). */
export const OPENING_BALANCE_SOURCE = "opening_balance";
/** The source of an invoice payment "Check for Wise payments" recorded; its source_ref is Wise's reference (wise-reconcile.ts). */
export const WISE_PAYMENT_SOURCE = "wise_payment";

function counterparty(details: Obj, kind: string): string {
  const named = [details.senderName, details.payerName, obj(details.merchant)?.name, obj(details.recipient)?.name, obj(details.originator)?.name]
    .map(str)
    .find(Boolean);
  if (named) return named;
  if (kind === "CONVERSION") return "Wise conversion";
  if (kind === "MONEY_ADDED") return "Wise top-up";
  return "";
}

/** Every money movement in one currency's statement, oldest first. Rows Wise cannot date or value are skipped. */
export function feedRowsFromStatement(statement: unknown, currency: string): WiseFeedRow[] {
  const cur = currency.toUpperCase();
  const s = obj(statement);
  const txns = Array.isArray(s?.transactions) ? (s!.transactions as unknown[]) : [];
  const out: WiseFeedRow[] = [];
  for (const raw of txns) {
    const t = obj(raw);
    const details = obj(t?.details) ?? {};
    const amount = obj(t?.amount);
    const direction = str(t?.type);
    if (!t || !amount || (direction !== "CREDIT" && direction !== "DEBIT")) continue;
    const cents = wiseValueToCents(amount.value);
    const ref = str(t.referenceNumber);
    const occurredAt = str(t.date);
    if (cents === null || cents === 0 || !ref || !occurredAt || Number.isNaN(Date.parse(occurredAt))) continue;
    if (str(amount.currency).toUpperCase() !== cur) continue;
    const kind = str(details.type) || "UNKNOWN";
    const fees = obj(t.totalFees);
    const feeCurrency = str(fees?.currency).toUpperCase();
    const fee = !feeCurrency || feeCurrency === cur ? wiseValueToCents(fees?.value) : null;
    out.push({
      fitid: wiseFitid(cur, direction, ref),
      postedDate: torontoDateOf(occurredAt),
      occurredAt,
      amountCents: cents,
      feeCents: fee !== null && fee > 0 ? fee : 0,
      currency: cur,
      kind,
      ref,
      name: counterparty(details, kind),
      memo: str(details.description),
    });
  }
  return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/** Whole days between two ISO dates. */
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export type StripePayoutLite = {
  id: string;
  /** What reaches the bank (payout.amount), in `currency`. Signed: a negative payout is money Stripe pulls back. */
  amountCents: number;
  currency: string;
  arrivalDate: string;
  /**
   * What the payout took out of the Stripe balance, from its balance
   * transaction: Stripe's settlement currency (USD for the live OASIS account) and amount, same
   * sign as amountCents. Null when Stripe did not say — such a payout is
   * recognised but not booked, because the side of Stripe clearing it relieves
   * would be a guess.
   */
  settlementCents?: number | null;
  settlementCurrency?: string | null;
  /** A payout fee Stripe charged (instant payouts), in the settlement currency; 0 for a standard payout. */
  feeCents?: number;
};

/** One Stripe /v1/payouts item (with data.balance_transaction expanded) -> StripePayoutLite, or null when unusable. */
export function stripePayoutFromApi(p: Record<string, unknown>): StripePayoutLite | null {
  if (p.status !== "paid" && p.status !== "in_transit") return null;
  if (typeof p.id !== "string" || typeof p.amount !== "number" || !Number.isSafeInteger(p.amount) || typeof p.arrival_date !== "number") return null;
  const bt = obj(p.balance_transaction);
  const btAmount = bt && typeof bt.amount === "number" && Number.isSafeInteger(bt.amount) ? bt.amount : null;
  const btCurrency = bt ? str(bt.currency).toUpperCase() : "";
  const btFee = bt && typeof bt.fee === "number" && Number.isSafeInteger(bt.fee) && bt.fee > 0 ? bt.fee : 0;
  return {
    id: p.id,
    amountCents: p.amount,
    currency: str(p.currency).toUpperCase(),
    arrivalDate: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
    // A payout's balance transaction moves money OUT of the Stripe balance (amount < 0 for a normal payout).
    settlementCents: btAmount !== null && btCurrency ? -btAmount : null,
    settlementCurrency: btAmount !== null && btCurrency ? btCurrency : null,
    feeCents: btFee,
  };
}

/**
 * Put "Stripe payout <id>" in front of each row that IS a Stripe payout: a
 * deposit in (or, for a negative payout, a debit out) with the same currency
 * and amount, arriving within `windowDays` of the payout's arrival date. Each
 * payout tags at most one row, the closest in date. `byFitid` says which
 * payout each tagged row is.
 */
export function tagStripePayouts(
  rows: readonly WiseFeedRow[],
  payouts: readonly StripePayoutLite[],
  windowDays = 3,
): { rows: WiseFeedRow[]; tagged: number; byFitid: Map<string, StripePayoutLite> } {
  const out = rows.map((r) => ({ ...r }));
  const used = new Set<number>();
  const byFitid = new Map<string, StripePayoutLite>();
  let tagged = 0;
  for (const p of payouts) {
    let best = -1;
    let bestGap = Infinity;
    out.forEach((r, i) => {
      if (used.has(i) || r.currency !== p.currency.toUpperCase() || r.amountCents !== p.amountCents) return;
      if (r.amountCents > 0 ? r.kind !== "DEPOSIT" : r.kind !== "DIRECT_DEBIT") return;
      const gap = dayGap(r.postedDate, p.arrivalDate);
      if (gap <= windowDays && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best === -1) continue;
    used.add(best);
    out[best].name = `Stripe payout ${p.id}`;
    byFitid.set(out[best].fitid, p);
    tagged += 1;
  }
  return { rows: out, tagged, byFitid };
}

// ── resolving lines before any rule sees them ────────────────────────────

/** An expense or paid bill on the books that a Wise debit may be. */
export type BillCandidate = {
  id: string;
  /** The entry that moved the money out of the register account: an expense's own entry, a bill's payment entry. */
  entryId: string;
  label: string;
  currency: string;
  totalCents: number;
  /** The day the money left (expense date, or the day the bill was paid). */
  paidOn: string;
  /** The category of the bill's first line, shown on the linked bank line. */
  categoryId: string | null;
};

export const BILL_MATCH_WINDOW_DAYS = 7;

/** The single item with the smallest distance, or null when there is none or a tie. */
function uniqueClosest<T>(items: readonly T[], distance: (x: T) => number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  let tie = false;
  for (const x of items) {
    const d = distance(x);
    if (d < bestD) {
      best = x;
      bestD = d;
      tie = false;
    } else if (d === bestD) tie = true;
  }
  return tie ? null : best;
}

/**
 * Pair Wise debits with bills/expenses already on the books: same currency,
 * the debit's amount equal to the bill's total, dated within `windowDays`.
 * A pair is made only when each is the OTHER's unique closest candidate
 * (repeated until nothing changes), so the closest date wins and a bill is
 * never matched twice. A debit that still has candidates but no pair is
 * ambiguous (a tie) and is returned with them, for a founder to decide.
 */
type DebitLike = Pick<WiseFeedRow, "fitid" | "postedDate" | "amountCents" | "currency">;

export function matchDebitsToBills(
  lines: readonly DebitLike[],
  bills: readonly BillCandidate[],
  windowDays = BILL_MATCH_WINDOW_DAYS,
): { linked: Map<string, BillCandidate>; ambiguous: Map<string, BillCandidate[]> } {
  const fits = (l: DebitLike, b: BillCandidate) =>
    l.amountCents < 0 && l.currency === b.currency.toUpperCase() && -l.amountCents === b.totalCents && dayGap(l.postedDate, b.paidOn) <= windowDays;
  const linked = new Map<string, BillCandidate>();
  const used = new Set<string>();
  for (let progress = true; progress; ) {
    progress = false;
    for (const l of lines) {
      if (linked.has(l.fitid)) continue;
      const bill = uniqueClosest(
        bills.filter((b) => !used.has(b.id) && fits(l, b)),
        (b) => dayGap(l.postedDate, b.paidOn),
      );
      if (!bill) continue;
      const line = uniqueClosest(
        lines.filter((x) => !linked.has(x.fitid) && fits(x, bill)),
        (x) => dayGap(x.postedDate, bill.paidOn),
      );
      if (line !== l) continue;
      linked.set(l.fitid, bill);
      used.add(bill.id);
      progress = true;
    }
  }
  const ambiguous = new Map<string, BillCandidate[]>();
  for (const l of lines) {
    if (linked.has(l.fitid)) continue;
    const left = bills.filter((b) => !used.has(b.id) && fits(l, b));
    if (left.length > 0) ambiguous.set(l.fitid, left);
  }
  return { linked, ambiguous };
}

/** More debits than this near one expense and the search for its parts is skipped (it would guess). */
const MAX_PART_CANDIDATES = 16;

/**
 * An expense recorded as ONE amount can leave the bank as several charges
 * (the live "AI subscriptions US$420" is likely a few card charges). No single
 * debit equals it, so each would otherwise be booked as new money. For each
 * expense no debit matched, find 2 to 4 debits — same currency, inside the
 * window — that add up to it EXACTLY. Those lines are held for a founder
 * (never linked, never booked on a guess). fitid -> the expense(s).
 */
export function debitsAddingUpToBills(lines: readonly DebitLike[], bills: readonly BillCandidate[], windowDays = BILL_MATCH_WINDOW_DAYS): Map<string, BillCandidate[]> {
  const out = new Map<string, BillCandidate[]>();
  for (const b of bills) {
    const parts = lines.filter(
      (l) => l.amountCents < 0 && l.currency === b.currency.toUpperCase() && -l.amountCents < b.totalCents && dayGap(l.postedDate, b.paidOn) <= windowDays,
    );
    if (parts.length < 2 || parts.length > MAX_PART_CANDIDATES) continue;
    const hit = new Set<string>();
    const walk = (start: number, left: number, picked: string[]) => {
      if (left === 0) {
        if (picked.length >= 2) for (const f of picked) hit.add(f);
        return;
      }
      if (left < 0 || picked.length === 4) return;
      for (let i = start; i < parts.length; i++) walk(i + 1, left + parts[i].amountCents, [...picked, parts[i].fitid]);
    };
    walk(0, b.totalCents, []);
    for (const f of hit) out.set(f, [...(out.get(f) || []), b]);
  }
  return out;
}

/** What the books already hold for a fed line (fin_bank_transactions, by FITID). */
export type FeedLineState = { status: string; entryId: string | null; createdAt: string };

/** The opening balance in force for a currency: its day, and when it was posted. */
export type OpeningMark = { date: string; createdAt: string };

export type FeedResolution =
  /** "Check for Wise payments" already recorded this deposit against an invoice: set it aside. */
  | { kind: "invoice_payment" }
  /** This debit IS an expense/bill already on the books: link it, post nothing. */
  | { kind: "bill"; bill: BillCandidate }
  /** Several expenses could be this debit: a founder decides. */
  | { kind: "bill_ambiguous"; bills: BillCandidate[] }
  /** This debit and others add up exactly to an expense already on the books as one amount: a founder decides. */
  | { kind: "bill_parts"; bills: BillCandidate[] }
  /** Dated on or before the opening balance, which was posted before this line arrived: already inside it. */
  | { kind: "before_opening"; openingDate: string }
  /** A Stripe payout: out of Stripe clearing, into chequing. */
  | { kind: "stripe_payout"; payout: StripePayoutLite }
  /** Both legs of a Wise conversion, booked together through Currency exchange clearing. */
  | { kind: "conversion"; debit: WiseFeedRow; credit: WiseFeedRow }
  /** One leg of a conversion whose other leg the feed cannot book with it. */
  | { kind: "conversion_unpaired"; reason: string };

export type FeedPlanInput = {
  rows: readonly WiseFeedRow[];
  /** Tagged Stripe payouts, by FITID (tagStripePayouts().byFitid). */
  payouts: ReadonlyMap<string, StripePayoutLite>;
  /** Wise references "Check for Wise payments" has already recorded. */
  recordedDepositRefs: ReadonlySet<string>;
  /** Existing bank lines by FITID. A row with none is new. */
  lines: ReadonlyMap<string, FeedLineState>;
  /** The opening balance in force, per currency. */
  openings: ReadonlyMap<string, OpeningMark>;
  /** Unlinked paid bills/expenses on the register account around the window. */
  bills: readonly BillCandidate[];
  windowDays?: number;
};

/**
 * Decide, for every row that is new or still unreviewed (never one a founder
 * or a rule already booked), what the feed does with it before any rule can.
 * Rows with no entry in the result go through the rules as usual.
 */
export function planFeed(input: FeedPlanInput): Map<string, FeedResolution> {
  const out = new Map<string, FeedResolution>();
  const open = input.rows.filter((r) => {
    const s = input.lines.get(r.fitid);
    return !s || (s.status === "unreviewed" && !s.entryId);
  });
  const openIds = new Set(open.map((r) => r.fitid));

  for (const r of open) if (r.amountCents > 0 && input.recordedDepositRefs.has(r.ref)) out.set(r.fitid, { kind: "invoice_payment" });

  const debits = open.filter((r) => !out.has(r.fitid) && r.amountCents < 0 && r.kind !== "CONVERSION" && !input.payouts.has(r.fitid));
  const windowDays = input.windowDays ?? BILL_MATCH_WINDOW_DAYS;
  const bills = matchDebitsToBills(debits, input.bills, windowDays);
  // Linking posts nothing. A link whose bank day and expense day fall on either
  // side of an opening balance's day does move that day's figure: the sync then
  // says to re-post the balance (wise-feed-io.ts staleOpeningNotes).
  for (const [fitid, bill] of bills.linked) out.set(fitid, { kind: "bill", bill });

  for (const r of open) {
    if (out.has(r.fitid)) continue;
    const ob = input.openings.get(r.currency);
    if (!ob || r.postedDate > ob.date) continue;
    const s = input.lines.get(r.fitid);
    // A line the opening balance already counted as pending (it existed when the balance was posted) books normally.
    if (!s || s.createdAt > ob.createdAt) out.set(r.fitid, { kind: "before_opening", openingDate: ob.date });
  }

  for (const [fitid, list] of bills.ambiguous) if (!out.has(fitid)) out.set(fitid, { kind: "bill_ambiguous", bills: list });

  const claimed = new Set([...bills.linked.values(), ...[...bills.ambiguous.values()].flat()].map((b) => b.id));
  const parts = debitsAddingUpToBills(
    debits.filter((r) => !out.has(r.fitid)),
    input.bills.filter((b) => !claimed.has(b.id)),
    windowDays,
  );
  for (const [fitid, list] of parts) out.set(fitid, { kind: "bill_parts", bills: list });

  for (const r of open) {
    if (out.has(r.fitid)) continue;
    const p = input.payouts.get(r.fitid);
    if (p) out.set(r.fitid, { kind: "stripe_payout", payout: p });
  }

  const legsByRef = new Map<string, WiseFeedRow[]>();
  for (const r of input.rows) if (r.kind === "CONVERSION") legsByRef.set(r.ref, [...(legsByRef.get(r.ref) || []), r]);
  for (const legs of legsByRef.values()) {
    const waiting = legs.filter((l) => openIds.has(l.fitid) && !out.has(l.fitid));
    if (waiting.length === 0) continue;
    const debit = legs.filter((l) => l.amountCents < 0);
    const credit = legs.filter((l) => l.amountCents > 0);
    const pair = legs.length === 2 && debit.length === 1 && credit.length === 1 && debit[0].currency !== credit[0].currency;
    if (pair && waiting.length === 2) {
      for (const l of waiting) out.set(l.fitid, { kind: "conversion", debit: debit[0], credit: credit[0] });
      continue;
    }
    const reason = !pair
      ? legs.length === 1
        ? "Wise conversion to or from a currency the books do not hold (only CAD and USD are fed); categorise it by hand"
        : "Wise reported this conversion in an unexpected shape; categorise it by hand"
      : "the other side of this Wise conversion is already categorised or held; book this side to Currency exchange clearing by hand";
    for (const l of waiting) out.set(l.fitid, { kind: "conversion_unpaired", reason });
  }
  return out;
}

// ── journal lines the feed posts itself ──────────────────────────────────

export type FeedAccounts = { chequing: string; stripeClearing: string; fxClearing: string; fxGainLoss: string; stripeFees: string; bankFees: string };

/** CAD equivalent of `cents` of `currency` on `date` — the SAME figure the ledger will give that line (own-day Bank of Canada rate). */
export type CadOf = (cents: number, currency: string, date: string) => number;

type SignedLine = { accountId: string; currency: string; cents: number; memo: string };

/** Signed (+ debit / - credit) parts -> journal lines, merged per account and currency, zeros dropped. */
function toJournalLines(parts: readonly SignedLine[]): JournalLineInput[] {
  const merged = new Map<string, SignedLine>();
  for (const p of parts) {
    const key = `${p.accountId}|${p.currency}`;
    const m = merged.get(key);
    if (m) m.cents += p.cents;
    else merged.set(key, { ...p });
  }
  return [...merged.values()]
    .filter((p) => p.cents !== 0)
    .map((p) =>
      p.cents > 0
        ? { accountId: p.accountId, currency: p.currency, debitCents: p.cents, memo: p.memo }
        : { accountId: p.accountId, currency: p.currency, creditCents: -p.cents, memo: p.memo },
    );
}

const FEED_CURRENCIES_BOOKABLE = new Set(["CAD", "USD"]);

/** Why the feed cannot book this payout itself, or null (stripePayoutLines). */
export function stripePayoutBlocker(row: WiseFeedRow, payout: StripePayoutLite, clearingCents?: number): string | null {
  const sign = row.amountCents > 0 ? 1 : -1;
  const settleCur = (payout.settlementCurrency || "").toUpperCase();
  if (payout.settlementCents == null || !settleCur) return `Stripe did not say what payout ${payout.id} took from the Stripe balance`;
  const settled = Math.abs(payout.settlementCents);
  if (Math.sign(payout.settlementCents) !== sign || Math.sign(payout.amountCents) !== sign) return `Stripe's figures for payout ${payout.id} point in different directions`;
  if (!FEED_CURRENCIES_BOOKABLE.has(settleCur)) return `payout ${payout.id} settled in ${settleCur}, which the books do not hold`;
  if (settleCur === row.currency && settled !== Math.abs(row.amountCents)) return `payout ${payout.id}: Stripe took ${settled} ${settleCur} cents but ${Math.abs(row.amountCents)} arrived`;
  const needed = settled + Math.max(0, payout.feeCents || 0);
  if (sign > 0 && clearingCents !== undefined && clearingCents < needed) {
    return (
      `payout ${payout.id} took ${centsToDecimal(needed)} ${settleCur} from the Stripe balance, but Stripe clearing holds ${centsToDecimal(clearingCents)} ${settleCur} on the books, ` +
      `so the charges it pays out are not recorded in ${settleCur}; booking it would leave Stripe clearing negative`
    );
  }
  return null;
}

/**
 * The entry for a Wise line that IS a Stripe payout. Never revenue: the
 * revenue was booked when each charge settled into Stripe clearing.
 *
 *   same currency:  Dr chequing / Cr Stripe clearing
 *   settled in one currency, arrived in the other (here CAD settled, USD arrived):
 *     Dr chequing USD A        / Cr FX clearing USD A        (own-day rate)
 *     Dr FX clearing CAD       / Cr Stripe clearing CAD S    (what Stripe took)
 *     the CAD-equivalent gap in FX clearing -> FX gain/loss, so it nets to 0
 *   a payout fee: Dr Stripe fees / Cr Stripe clearing, settlement currency.
 * A negative payout (Stripe pulling money back) is the mirror image.
 *
 * `clearingCents` is what 1050 Stripe clearing holds on the books in the
 * settlement currency. A payout needing more is NOT booked: the charges it
 * pays out are not in Stripe clearing in that currency (not imported yet, or
 * imported in another currency than Stripe settles in — the live account's
 * balance is USD while its charges are booked in CAD, 2026-09-25), and
 * booking it anyway would drive that side of Stripe clearing negative.
 */
export function stripePayoutLines(
  row: WiseFeedRow,
  payout: StripePayoutLite,
  acct: FeedAccounts,
  cadOf: CadOf,
  clearingCents?: number,
): { ok: true; lines: JournalLineInput[]; fxCents: number } | { ok: false; reason: string } {
  const blocked = stripePayoutBlocker(row, payout, clearingCents);
  if (blocked) return { ok: false, reason: blocked };
  const sign = row.amountCents > 0 ? 1 : -1;
  const arrived = Math.abs(row.amountCents);
  const settled = Math.abs(payout.settlementCents as number);
  const settleCur = (payout.settlementCurrency as string).toUpperCase();
  const fee = Math.max(0, payout.feeCents || 0);
  const memo = `Stripe payout ${payout.id}`;
  const parts: SignedLine[] = [];
  let fxCents = 0;
  if (settleCur === row.currency) {
    parts.push({ accountId: acct.chequing, currency: row.currency, cents: arrived, memo }, { accountId: acct.stripeClearing, currency: settleCur, cents: -settled, memo });
  } else {
    const arrivedCad = cadOf(arrived, row.currency, row.postedDate);
    const settledCad = cadOf(settled, settleCur, row.postedDate);
    fxCents = settledCad - arrivedCad; // > 0: Stripe took more than arrived is worth (a loss)
    parts.push(
      { accountId: acct.chequing, currency: row.currency, cents: arrived, memo },
      { accountId: acct.fxClearing, currency: row.currency, cents: -arrived, memo },
      { accountId: acct.fxClearing, currency: settleCur, cents: settled, memo },
      { accountId: acct.stripeClearing, currency: settleCur, cents: -settled, memo },
      { accountId: acct.fxClearing, currency: "CAD", cents: -fxCents, memo: `${memo}: conversion` },
      { accountId: acct.fxGainLoss, currency: "CAD", cents: fxCents, memo: fxCents >= 0 ? "Realised FX loss" : "Realised FX gain" },
    );
  }
  if (fee > 0) parts.push({ accountId: acct.stripeFees, currency: settleCur, cents: fee, memo: `${memo} fee` }, { accountId: acct.stripeClearing, currency: settleCur, cents: -fee, memo: `${memo} fee` });
  const lines = toJournalLines(parts.map((p) => ({ ...p, cents: p.cents * sign })));
  return { ok: true, lines, fxCents: fxCents * sign };
}

/**
 * The two entries of a Wise conversion (money moved between the CAD and USD
 * balances), each owned by its own bank line:
 *
 *   debit leg  (money out):  Dr FX clearing / Cr chequing, in its currency
 *   credit leg (money in):   Dr chequing / Cr FX clearing, in its currency,
 *     plus, in CAD, what closes FX clearing: Wise's fee (inside the debit, in
 *     the debit's currency) to Bank fees and the rest of the CAD-equivalent
 *     gap to FX gain/loss.
 * Per currency chequing moves exactly as each Wise balance did; FX clearing
 * nets to zero in CAD equivalents, as it does for every other FX flow.
 */
export function conversionLegLines(
  debit: WiseFeedRow,
  credit: WiseFeedRow,
  acct: FeedAccounts,
  cadOf: CadOf,
): { debitLeg: JournalLineInput[]; creditLeg: JournalLineInput[]; fxCents: number; feeCadCents: number } {
  const out = Math.abs(debit.amountCents);
  const inn = Math.abs(credit.amountCents);
  const memo = `Wise conversion ${debit.ref}: ${debit.currency} -> ${credit.currency}`;
  const gap = cadOf(out, debit.currency, debit.postedDate) - cadOf(inn, credit.currency, credit.postedDate); // CAD-equivalent left in FX clearing
  const feeCad = debit.feeCents > 0 ? cadOf(debit.feeCents, debit.currency, debit.postedDate) : 0;
  const fx = gap - feeCad;
  const debitLeg = toJournalLines([
    { accountId: acct.fxClearing, currency: debit.currency, cents: out, memo },
    { accountId: acct.chequing, currency: debit.currency, cents: -out, memo },
  ]);
  const creditLeg = toJournalLines([
    { accountId: acct.chequing, currency: credit.currency, cents: inn, memo },
    { accountId: acct.fxClearing, currency: credit.currency, cents: -inn, memo },
    { accountId: acct.fxClearing, currency: "CAD", cents: -gap, memo: `${memo}: fee and rate difference` },
    { accountId: acct.bankFees, currency: "CAD", cents: feeCad, memo: "Wise conversion fee" },
    { accountId: acct.fxGainLoss, currency: "CAD", cents: fx, memo: fx >= 0 ? "Realised FX loss" : "Realised FX gain" },
  ]);
  return { debitLeg, creditLeg, fxCents: fx, feeCadCents: feeCad };
}

const ofxSafe = (s: string) => s.replace(/[<>\r\n]+/g, " ").trim().slice(0, 250);
const ofxDate = (iso: string) => iso.replace(/-/g, "");
/** 12345 -> "123.45", -5 -> "-0.05": an exact decimal for OFX amounts and memos (not a display format). */
export const centsToDecimal = (cents: number) => `${cents < 0 ? "-" : ""}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

/** The rows as an OFX statement for transactions-io's import. */
export function feedRowsToOfx(rows: readonly WiseFeedRow[], currency: string): string {
  const body = rows
    .map((r) =>
      [
        "<STMTTRN>",
        `<TRNTYPE>${r.amountCents > 0 ? "CREDIT" : "DEBIT"}`,
        `<DTPOSTED>${ofxDate(r.postedDate)}`,
        `<TRNAMT>${centsToDecimal(r.amountCents)}`,
        `<FITID>${ofxSafe(r.fitid)}`,
        `<NAME>${ofxSafe(r.name || r.memo || `Wise ${r.kind.toLowerCase()}`)}`,
        `<MEMO>${ofxSafe(r.memo)}`,
        "</STMTTRN>",
      ].join("\n"),
    )
    .join("\n");
  return `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><STMTRS>\n<CURDEF>${currency.toUpperCase()}\n<BANKTRANLIST>\n${body}\n</BANKTRANLIST>\n</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n`;
}

/**
 * The balance at the END of Toronto day `date`, from a statement whose
 * interval starts before that day: the running balance after the day's last
 * transaction, or the statement's opening balance when nothing happened
 * between its start and the end of the day. null when Wise gave neither.
 */
export function balanceAtEndOf(statement: unknown, date: string): number | null {
  const s = obj(statement);
  if (!s) return null;
  const txns = (Array.isArray(s.transactions) ? s.transactions : [])
    .map(obj)
    .filter((t): t is Obj => t !== null && typeof t.date === "string" && !Number.isNaN(Date.parse(t.date as string)))
    .filter((t) => torontoDateOf(t.date as string) <= date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = txns[txns.length - 1];
  if (last) return wiseValueToCents(obj(last.runningBalance)?.value);
  return wiseValueToCents(obj(s.startOfStatementBalance)?.value);
}

/** The UTC interval to request so `balanceAtEndOf(date)` is answerable: from two days before the day to two days after. */
export function intervalAround(date: string): { fromIso: string; toIso: string } {
  return { fromIso: `${addDays(date, -2)}T00:00:00.000Z`, toIso: `${addDays(date, 2)}T00:00:00.000Z` };
}
