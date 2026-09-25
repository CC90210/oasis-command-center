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
 * the cent, arriving within 3 days. That tag is what the seeded "stripe" rule
 * matches, which books the deposit as a transfer out of Stripe clearing
 * instead of as revenue a second time.
 */

import { addDays, torontoDateOf } from "./fx";
import { wiseValueToCents } from "./wise";

/**
 * WRITES ARE OFF (2026-09-24). An independent review found that, as built, a
 * real sync or opening balance can double-count money already on the books:
 * recurring expenses recorded from the Bills page, and Wise deposits already
 * recorded against an invoice, have no link to their bank line yet; Wise
 * currency conversions and USD Stripe payouts are not booked correctly. Until
 * that matching lands, both functions refuse to write and still answer a dry
 * run, so the preview shows what a sync would do.
 */
// Off unless the server sets FINANCE_WISE_FEED_WRITES=on (production does not;
// the feed's own tests do, to keep exercising the logic being finished). In a
// browser bundle the variable is absent, so the buttons read "off" too.
export const WISE_FEED_WRITES_ENABLED = process.env.FINANCE_WISE_FEED_WRITES === "on";
export const WISE_FEED_OFF_MESSAGE =
  "Syncing Wise into the books is switched off while bank matching is finished, so nothing is counted twice. Previews still work, and invoice payments from Wise are still recorded by \"Check for Wise payments\".";

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
    out.push({
      fitid: wiseFitid(cur, direction, ref),
      postedDate: torontoDateOf(occurredAt),
      occurredAt,
      amountCents: cents,
      currency: cur,
      kind,
      ref,
      name: counterparty(details, kind),
      memo: str(details.description),
    });
  }
  return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

export type StripePayoutLite = { id: string; amountCents: number; currency: string; arrivalDate: string };

/**
 * Put "Stripe payout <id>" in front of each row that IS a Stripe payout: a
 * deposit in (or, for a negative payout, a debit out) with the same currency
 * and amount, arriving within `windowDays` of the payout's arrival date. Each
 * payout tags at most one row, the closest in date.
 */
export function tagStripePayouts(rows: readonly WiseFeedRow[], payouts: readonly StripePayoutLite[], windowDays = 3): { rows: WiseFeedRow[]; tagged: number } {
  const out = rows.map((r) => ({ ...r }));
  const used = new Set<number>();
  let tagged = 0;
  for (const p of payouts) {
    let best = -1;
    let bestGap = Infinity;
    out.forEach((r, i) => {
      if (used.has(i) || r.currency !== p.currency.toUpperCase() || r.amountCents !== p.amountCents) return;
      if (r.amountCents > 0 ? r.kind !== "DEPOSIT" : r.kind !== "DIRECT_DEBIT") return;
      const gap = Math.abs(Date.parse(`${r.postedDate}T00:00:00Z`) - Date.parse(`${p.arrivalDate}T00:00:00Z`)) / 86_400_000;
      if (gap <= windowDays && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best === -1) continue;
    used.add(best);
    out[best].name = `Stripe payout ${p.id}`;
    tagged += 1;
  }
  return { rows: out, tagged };
}

const ofxSafe = (s: string) => s.replace(/[<>\r\n]+/g, " ").trim().slice(0, 250);
const ofxDate = (iso: string) => iso.replace(/-/g, "");
const ofxAmount = (cents: number) => `${cents < 0 ? "-" : ""}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

/** The rows as an OFX statement for transactions-io's import. */
export function feedRowsToOfx(rows: readonly WiseFeedRow[], currency: string): string {
  const body = rows
    .map((r) =>
      [
        "<STMTTRN>",
        `<TRNTYPE>${r.amountCents > 0 ? "CREDIT" : "DEBIT"}`,
        `<DTPOSTED>${ofxDate(r.postedDate)}`,
        `<TRNAMT>${ofxAmount(r.amountCents)}`,
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
