/**
 * Stripe payouts -> the books. The webhook (payout.paid / payout.failed /
 * payout.canceled, stripe-ingest.ts) and the reconcile (every payout Stripe
 * lists) both land here; stripe-payouts.ts decides the lines.
 *
 * ONE PAYOUT, ONE BOOKING. fin_stripe_payouts is keyed by the payout id, and
 * both entries are keyed by it too (source stripe_payout / stripe_payout_fx,
 * source_ref = the payout id, unique per entity), so a redelivered event or a
 * re-run reconcile posts nothing new. Both entries are gated on the payout
 * still being unbooked, and the row flips to "booked" in the same batch.
 *
 * NEVER TWICE WITH A BANK LINE. The same payout reaches the books as a bank
 * line too, three ways: the Wise feed recognises it and tags the line with
 * its id; an uploaded statement's line, or an untagged Wise line (the feed
 * could not read Stripe's payouts), is categorised to Stripe clearing by the
 * seeded "Stripe payouts are transfers" rule or by hand; or someone posts it
 * by hand. Whichever came first owns it:
 *   - a bank line already on the books is ADOPTED (the payout's row points at
 *     its entry) and nothing is posted: the feed's tagged line by its tag,
 *     any other by its SHAPE (existingPayoutEntry: a posted entry crediting
 *     1050 and debiting a bank or cash account exactly what the payout
 *     brought, within PAYOUT_MATCH_WINDOW_DAYS, that no other payout owns).
 *     The booking batch is gated on neither existing, so one landing between
 *     the check and the write stops it, and it is adopted instead;
 *   - a bank line arriving after the payout was booked here is LINKED to this
 *     entry: by the feed (bookedPayoutEntry), or by categorisation
 *     (transactions-io.ts, bookedPayoutForBankLine), which never posts it.
 * An adopted entry is the bank line's own, so excluding or re-categorising
 * that line reverses it: the payout is then UNDONE (UNDONE_REASON), a gap
 * again, and adopted again only from a bank line, never posted from Stripe.
 *
 * WHAT CONVERTS. A USD payout from charges booked in CAD converts exactly the
 * charges it pays out, as Stripe lists them (payoutContents; the reasoning is
 * stripe-payouts.ts's). Without a Stripe key it is held until the reconcile,
 * which has one, books it.
 *
 * FAILED / CANCELED. A payout that never landed is recorded "not_booked". One
 * booked here that Stripe later reports failed is reversed (ledger-io.ts
 * buildReversal, dated the day Stripe reported it); the conversion entry, if
 * any, stands, because the money went back to the Stripe balance in the
 * currency it had been converted into.
 */
import "server-only";

import { accountId, BUSINESS_ENTITY_ID, SYS } from "./chart";
import { finDb, isUniqueViolation, n, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import { buildPosting, buildReversal } from "./ledger-io";
import { LedgerError } from "./ledger";
import { usdCadRate } from "./fx-io";
import { addDays, torontoToday, usdToCadCents } from "./fx";
import { normalizeCurrencyCode } from "./money";
import type { PayoutFacts } from "./stripe-map";
import { getStripeClient, listAll, StripeApiError, StripeNotReady } from "./stripe-io";
import { centsToDecimal } from "./wise-feed";
import {
  PAYOUT_FX_SOURCE,
  PAYOUT_MATCH_WINDOW_DAYS,
  PAYOUT_SOURCE,
  payoutBankLineName,
  payoutNeedsContents,
  planStripePayout,
  UNMAPPED_REASON,
  type PayoutAccounts,
  type PayoutContents,
} from "./stripe-payouts";

const E = BUSINESS_ENTITY_ID;
const ACTOR = "stripe";
/** "Bank fees" in BUSINESS_CHART; SYS has no role key for it (wise-feed-io.ts uses the same code). */
const BANK_FEES_CODE = "5010";

export type PayoutBooking = "booked" | "held" | "unmapped" | "not_booked" | "reversed";

export type PayoutRow = {
  id: string;
  entity_id: string;
  stripe_status: string;
  booking: PayoutBooking;
  amount_cents: number;
  currency: string;
  arrival_date: string;
  settlement_cents: number | null;
  settlement_currency: string | null;
  fee_cents: number;
  destination_id: string | null;
  bank_account_id: string | null;
  entry_id: string | null;
  reversal_entry_id: string | null;
  reason: string | null;
  livemode: number;
};

export type PayoutOutcome = { payoutId: string; booking: PayoutBooking; entryId: string | null; reason: string | null };

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function accounts(): PayoutAccounts {
  return {
    stripeClearing: accountId(E, SYS.stripeClearing),
    fxClearing: accountId(E, SYS.fxClearing),
    fxGainLoss: accountId(E, SYS.fxGainLoss),
    stripeFees: accountId(E, SYS.stripeFees),
    bankFees: accountId(E, BANK_FEES_CODE),
  };
}

export async function loadPayout(id: string): Promise<PayoutRow | null> {
  return queryOne<PayoutRow>(`SELECT * FROM fin_stripe_payouts WHERE id = ?`, [id]);
}

function outcomeOf(row: PayoutRow): PayoutOutcome {
  return { payoutId: row.id, booking: row.booking, entryId: row.entry_id, reason: row.reason };
}

/**
 * The bank account payouts land in (fin_settings.stripe_payout_account_id),
 * or why there is none. A choice that is not one of this book's bank accounts
 * counts as none: the payout is recorded unmapped, never booked elsewhere.
 */
export async function payoutBankAccount(): Promise<{ id: string; reason: null } | { id: null; reason: string }> {
  const row = await queryOne<{ account_id: string | null; subtype: string | null }>(
    `SELECT s.stripe_payout_account_id AS account_id, a.subtype
       FROM fin_settings s
       LEFT JOIN fin_accounts a ON a.id = s.stripe_payout_account_id AND a.entity_id = s.entity_id
      WHERE s.entity_id = ?`,
    [E],
  );
  if (!row?.account_id) return { id: null, reason: UNMAPPED_REASON };
  if (row.subtype !== "bank") {
    return { id: null, reason: "the account chosen for Stripe payouts is not one of this book's bank accounts (Finances › Settings › Stripe)" };
  }
  return { id: row.account_id, reason: null };
}

/**
 * What 1050 Stripe clearing holds on `asOf`, per currency: every line of an
 * entry dated that day or before (a reversal cancels its original). A payout
 * never draws on a charge booked after it arrived.
 */
async function clearingByCurrency(asOf: string): Promise<Record<string, number>> {
  const rows = await query<{ currency: string; n: number | null }>(
    `SELECT l.currency, COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
       FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
      WHERE l.entity_id = ? AND l.account_id = ? AND e.entry_date <= ?
      GROUP BY l.currency`,
    [E, accountId(E, SYS.stripeClearing), asOf],
  );
  return Object.fromEntries(rows.map((r) => [r.currency, n(r.n)]));
}

type BalanceTxn = { id: string; type: string; source: string | null; amount: number; net: number; currency: string };

function balanceTxnOf(raw: Record<string, unknown>): BalanceTxn | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  const type = typeof raw.type === "string" ? raw.type : null;
  const src = raw.source;
  const source = typeof src === "string" ? src : typeof (src as { id?: unknown } | null)?.id === "string" ? String((src as { id: string }).id) : null;
  const currency = normalizeCurrencyCode(raw.currency);
  if (!id || !type || !currency || !Number.isSafeInteger(raw.amount) || !Number.isSafeInteger(raw.net)) return null;
  return { id, type, source, amount: raw.amount as number, net: raw.net as number, currency };
}

/**
 * What a payout pays out, from Stripe (GET /v1/balance_transactions?payout=,
 * automatic payouts only; read-only), matched to the rows that booked it:
 * each charge to its payment and each refund to its refund, by balance
 * transaction id, else by charge or refund id. Not ok, with the reason, when
 * Stripe cannot say (no key, a manual payout, an error), when a charge or
 * refund in it is not booked, when it holds anything else the books do not
 * record, or when the list does not add up to the payout.
 */
export async function payoutContents(p: Pick<PayoutFacts, "payoutId" | "settlementCents" | "settlementCurrency" | "feeCents">): Promise<PayoutContents> {
  const id = p.payoutId;
  const no = (reason: string): PayoutContents => ({ ok: false, reason });
  let key: string;
  try {
    key = (await getStripeClient()).key;
  } catch (e) {
    if (e instanceof StripeNotReady) return no(`Stripe is not connected (${e.code}), so which charges payout ${id} pays out cannot be read; the next reconcile books it`);
    throw e;
  }
  let listed: { items: Array<Record<string, unknown>>; truncated: boolean };
  try {
    listed = await listAll(key, "/v1/balance_transactions", { payout: id }, { maxPages: 20 });
  } catch (e) {
    // Held with the reason, never booked on a guess; the next reconcile asks again.
    console.error("[finances:payouts] could not list what payout", id, "pays out:", e instanceof Error ? e.message : e);
    if (e instanceof StripeApiError) {
      return no(`Stripe did not list what payout ${id} pays out (HTTP ${e.status}; a manual payout is not listed), so it is not booked automatically`);
    }
    return no(`Stripe could not be reached to list what payout ${id} pays out; the next reconcile asks again`);
  }
  if (listed.truncated) return no(`payout ${id} pays out more than one read of Stripe lists, so it is not booked automatically`);
  const txns: BalanceTxn[] = [];
  for (const raw of listed.items) {
    const t = balanceTxnOf(raw);
    if (!t) return no(`Stripe listed something in payout ${id} the books cannot read`);
    if (t.type === "payout" && t.source === id) continue; // the payout itself
    txns.push(t);
  }
  const settleCur = p.settlementCurrency;
  const other = txns.find((t) => t.currency !== settleCur);
  if (other) return no(`payout ${id} pays out ${other.id} in ${other.currency}, not the ${settleCur} it settled in`);

  // The rows that booked its charges and refunds, in one read per 150 ids.
  const ids = [...new Set(txns.flatMap((t) => [t.id, t.source]).filter((v): v is string => !!v))];
  const rows: Array<{ kind: string; stripe_balance_txn_id: string | null; stripe_charge_id: string | null; stripe_refund_id: string | null; settlement_cad_cents: number | null; entry_id: string | null }> = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const marks = chunk.map(() => "?").join(",");
    rows.push(
      ...(await query<(typeof rows)[number]>(
        `SELECT kind, stripe_balance_txn_id, stripe_charge_id, stripe_refund_id, settlement_cad_cents, entry_id FROM fin_payments
          WHERE entity_id = ? AND source = 'stripe' AND (stripe_balance_txn_id IN (${marks}) OR stripe_charge_id IN (${marks}) OR stripe_refund_id IN (${marks}))`,
        [E, ...chunk, ...chunk, ...chunk],
      )),
    );
  }
  const booked = (t: BalanceTxn, kind: "payment" | "refund") =>
    rows.find((r) => r.kind === kind && r.stripe_balance_txn_id === t.id) ??
    rows.find((r) => r.kind === kind && !!t.source && (kind === "payment" ? r.stripe_charge_id : r.stripe_refund_id) === t.source);

  let settledCents = 0;
  let cadBookedCents = 0;
  let stripeFeeCents = 0;
  let net = 0;
  for (const t of txns) {
    net += t.net;
    if (t.type === "charge" || t.type === "payment" || t.type === "refund" || t.type === "payment_refund") {
      const refund = t.type === "refund" || t.type === "payment_refund";
      const row = booked(t, refund ? "refund" : "payment");
      if (!row || row.entry_id === null || row.settlement_cad_cents === null) {
        return no(`the Stripe ${refund ? "refund" : "charge"} ${t.source ?? t.id} that payout ${id} pays out is not booked yet`);
      }
      settledCents += t.amount;
      cadBookedCents += (refund ? -1 : 1) * n(row.settlement_cad_cents);
    } else if (t.type === "stripe_fee") {
      stripeFeeCents -= t.amount;
    } else {
      return no(`payout ${id} also pays out a Stripe ${t.type.replace(/_/g, " ")} (${t.id}, ${centsToDecimal(t.net)} ${t.currency}) that the books do not record, so it is not booked automatically`);
    }
  }
  const took = (p.settlementCents ?? 0) + p.feeCents;
  if (net !== took) {
    return no(`what Stripe lists in payout ${id} comes to ${centsToDecimal(net)} ${settleCur}, not the ${centsToDecimal(took)} ${settleCur} it took, so it is not booked automatically`);
  }
  return { ok: true, settledCents, cadBookedCents, stripeFeeCents };
}

/**
 * The bank line the Wise feed booked as this payout, if any: its description
 * is the tag the feed gives a recognised payout, alone or followed by " — "
 * and the bank's memo. Payout ids hold no spaces, so the trailing space keeps
 * po_1 from matching po_12.
 */
const BANK_LINE_WHERE = `t.entity_id = ? AND t.status = 'posted' AND t.entry_id IS NOT NULL
  AND (t.description = ? OR substr(t.description, 1, ?) = ?)`;
function bankLineArgs(payoutId: string): Array<string | number> {
  const name = payoutBankLineName(payoutId);
  return [E, name, name.length + 1, `${name} `];
}

async function bankFeedBooking(payoutId: string): Promise<{ entry_id: string; account_id: string } | null> {
  return queryOne<{ entry_id: string; account_id: string }>(
    `SELECT t.entry_id, t.account_id FROM fin_bank_transactions t JOIN fin_journal_entries e ON e.id = t.entry_id
      WHERE ${BANK_LINE_WHERE} AND e.status = 'posted' LIMIT 1`,
    bankLineArgs(payoutId),
  );
}

/**
 * A posted entry that already moved this payout into a bank or cash account
 * without naming it (an uploaded statement's line categorised to Stripe
 * clearing by the seeded rule or by hand, an untagged Wise line, a hand-made
 * entry): the SHAPE cash-coverage.ts reads as a payout, one entry crediting
 * 1050 Stripe clearing and debiting a bank or cash account, here for exactly
 * the payout's amount in the currency it arrived in, dated within
 * PAYOUT_MATCH_WINDOW_DAYS of its arrival, and not already another payout's.
 * A reversal (ledger-io.ts buildReversal, source 'reversal') undoes money,
 * it never lands any: one that happens to have the shape never counts. Nor
 * does a bank line the Wise feed tagged as ANOTHER payout: two payouts of the
 * same amount days apart (a fixed-price subscription) would otherwise swap
 * lines, and the one whose line was taken would stay held for good.
 * `e` is the entry.
 */
const SHAPE_WHERE = `e.entity_id = ? AND e.status = 'posted' AND e.source <> 'reversal' AND e.entry_date BETWEEN ? AND ?
  AND EXISTS (SELECT 1 FROM fin_journal_lines c WHERE c.entry_id = e.id AND c.account_id = ? AND c.credit_cents > 0)
  AND EXISTS (SELECT 1 FROM fin_journal_lines b JOIN fin_accounts a ON a.id = b.account_id
               WHERE b.entry_id = e.id AND a.subtype IN ('bank', 'cash') AND b.currency = ? AND b.debit_cents = ?)
  AND NOT EXISTS (SELECT 1 FROM fin_stripe_payouts o WHERE o.entry_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM fin_bank_transactions ot WHERE ot.entry_id = e.id
                   AND substr(ot.description, 1, ?) = ? AND NOT (ot.description = ? OR substr(ot.description, 1, ?) = ?))`;
function shapeArgs(row: Pick<PayoutRow, "id" | "arrival_date" | "currency" | "amount_cents">): Array<string | number> {
  const tag = payoutBankLineName("po_");
  const name = payoutBankLineName(row.id);
  return [
    E,
    addDays(row.arrival_date, -PAYOUT_MATCH_WINDOW_DAYS),
    addDays(row.arrival_date, PAYOUT_MATCH_WINDOW_DAYS),
    accountId(E, SYS.stripeClearing),
    row.currency,
    row.amount_cents,
    tag.length,
    tag,
    name,
    name.length + 1,
    `${name} `,
  ];
}

/**
 * The Wise feed's hold (2026-09-30, the #491 review): an entry of this
 * payout's exact shape that no payout has adopted yet, as a SQL condition on
 * `e` (a fin_journal_entries row) with its args. The same shape a payout
 * adopts (SHAPE_WHERE): posted, not a reversal, Stripe clearing credited, a
 * bank or cash account debited the payout's amount in its currency, dated
 * within PAYOUT_MATCH_WINDOW_DAYS of its arrival, owned by no payout, not
 * another payout's tagged Wise line.
 *
 * WHY. A deposit entered by hand, then the Wise feed posting its own line for
 * the same payout, then the payout event adopting the Wise line by its tag,
 * left the hand entry behind: the deposit was in chequing twice (reproduced
 * on #491: +1750 cents twice). Double-counted cash is worse than a held line,
 * so while such an entry exists the feed holds its line for a founder, and
 * posts nothing.
 */
export function unadoptedPayoutShape(p: { id: string; arrivalDate: string; currency: string; amountCents: number }): { sql: string; args: Array<string | number> } {
  return { sql: SHAPE_WHERE, args: shapeArgs({ id: p.id, arrival_date: p.arrivalDate, currency: p.currency.toUpperCase(), amount_cents: p.amountCents }) };
}

/** The entry of this payout's exact shape already on the books and adopted by no payout (unadoptedPayoutShape), closest first; null when none. */
export async function unadoptedPayoutShapedEntry(p: { id: string; arrivalDate: string; currency: string; amountCents: number }): Promise<{ entryId: string; entryDate: string } | null> {
  if (p.amountCents <= 0) return null;
  const shape = unadoptedPayoutShape(p);
  const row = await queryOne<{ id: string; entry_date: string }>(
    `SELECT e.id, e.entry_date FROM fin_journal_entries e WHERE ${shape.sql}
      ORDER BY abs(julianday(e.entry_date) - julianday(?)), e.created_at, e.id LIMIT 1`,
    [...shape.args, p.arrivalDate],
  );
  return row ? { entryId: row.id, entryDate: row.entry_date } : null;
}

/** The entry already on the books for this payout by its shape, closest to the arrival day first, and the account it debited. */
async function existingPayoutEntry(row: PayoutRow): Promise<{ entry_id: string; account_id: string; entry_date: string } | null> {
  if (row.amount_cents <= 0) return null;
  return queryOne<{ entry_id: string; account_id: string; entry_date: string }>(
    `SELECT e.id AS entry_id, e.entry_date,
            (SELECT b.account_id FROM fin_journal_lines b JOIN fin_accounts a ON a.id = b.account_id
              WHERE b.entry_id = e.id AND a.subtype IN ('bank', 'cash') AND b.currency = ? AND b.debit_cents = ? LIMIT 1) AS account_id
       FROM fin_journal_entries e
      WHERE ${SHAPE_WHERE}
      ORDER BY abs(julianday(e.entry_date) - julianday(?)), e.created_at, e.id
      LIMIT 1`,
    [row.currency, row.amount_cents, ...shapeArgs(row), row.arrival_date],
  );
}

/**
 * Adopt a booking already on the books for this payout, if there is one: its
 * Wise bank line's entry, else an entry of its shape. The row then points at
 * it and nothing is posted. Null when there is none (or another payout took
 * that entry first).
 */
async function adoptExistingBooking(row: PayoutRow): Promise<PayoutOutcome | null> {
  const fed = await bankFeedBooking(row.id);
  const found = fed
    ? { entryId: fed.entry_id, accountId: fed.account_id, reason: "booked from its Wise bank line" }
    : await existingPayoutEntry(row).then((s) =>
        s ? { entryId: s.entry_id, accountId: s.account_id, reason: `booked from the bank line of ${s.entry_date} already on the books (Stripe clearing to the bank, the same amount)` } : null,
      );
  if (!found) return null;
  const upd = await finDb().execute({
    sql: `UPDATE fin_stripe_payouts SET booking = 'booked', entry_id = ?, bank_account_id = ?, reason = ?, updated_at = ${NOW_SQL}
           WHERE id = ? AND booking IN ('held', 'unmapped') AND NOT EXISTS (SELECT 1 FROM fin_stripe_payouts o WHERE o.entry_id = ? AND o.id <> ?)`,
    args: [found.entryId, found.accountId, found.reason, row.id, found.entryId, row.id],
  });
  if (upd.rowsAffected !== 1) return null;
  return outcomeOf((await loadPayout(row.id)) ?? row);
}

/**
 * The payout booked here that a bank line about to be categorised to Stripe
 * clearing IS: booked (from Stripe, or adopted from an entry no bank line
 * points at), for the line's amount and currency, arriving within
 * PAYOUT_MATCH_WINDOW_DAYS of it, its entry not yet any line's. Closest
 * first. transactions-io.ts links the line to it instead of posting it again.
 */
export async function bookedPayoutForBankLine(line: { entity_id: string; amount_cents: number; currency: string; posted_date: string }): Promise<{
  payoutId: string;
  entryId: string;
  bankAccountId: string | null;
  amountCents: number;
  currency: string;
  arrivalDate: string;
} | null> {
  if (line.amount_cents <= 0) return null;
  const row = await queryOne<{ id: string; entry_id: string; bank_account_id: string | null; amount_cents: number; currency: string; arrival_date: string }>(
    `SELECT p.id, p.entry_id, p.bank_account_id, p.amount_cents, p.currency, p.arrival_date FROM fin_stripe_payouts p
      WHERE ${BOOKED_PAYOUT_WHERE}
      ORDER BY abs(julianday(p.arrival_date) - julianday(?)), p.id LIMIT 1`,
    [...bookedPayoutArgs(line), line.posted_date],
  );
  return row
    ? { payoutId: row.id, entryId: row.entry_id, bankAccountId: row.bank_account_id, amountCents: n(row.amount_cents), currency: row.currency, arrivalDate: row.arrival_date }
    : null;
}

/**
 * bookedPayoutForBankLine's match as a SQL condition (`p` is the payout), for
 * the categorisation's posting gate: a payout booked between the check and
 * the write stops the line's own entry.
 */
export const BOOKED_PAYOUT_WHERE = `p.entity_id = ? AND p.booking = 'booked' AND p.currency = ? AND p.amount_cents = ?
  AND p.arrival_date BETWEEN ? AND ?
  AND EXISTS (SELECT 1 FROM fin_journal_entries pe WHERE pe.id = p.entry_id AND pe.status = 'posted')
  AND NOT EXISTS (SELECT 1 FROM fin_bank_transactions pt WHERE pt.entry_id = p.entry_id)`;
export function bookedPayoutArgs(line: { entity_id: string; amount_cents: number; currency: string; posted_date: string }): Array<string | number> {
  return [
    line.entity_id,
    line.currency,
    line.amount_cents,
    addDays(line.posted_date, -PAYOUT_MATCH_WINDOW_DAYS),
    addDays(line.posted_date, PAYOUT_MATCH_WINDOW_DAYS),
  ];
}

/** An audit row that lands only when `entryId` was written by the same batch. */
function auditIfPosted(entryId: string, action: string, payoutId: string, detail: Record<string, unknown>): InStatement {
  return {
    sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
          SELECT ?, ?, ?, ?, 'payout', ?, ? WHERE EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
    args: [newId("aud"), E, ACTOR, action, payoutId, JSON.stringify(detail).slice(0, 8000), entryId],
  };
}

/**
 * Record what Stripe says about a payout and do what it calls for: book a
 * paid one, reverse a booked one that failed, mark one that never landed.
 * Idempotent. Returns null for a payout that is not live or not settled yet
 * (pending / in transit: nothing has reached the bank).
 */
export async function recordStripePayout(facts: PayoutFacts, opts: { reportedOn?: string } = {}): Promise<PayoutOutcome | null> {
  if (!facts.livemode) return null;
  if (facts.status !== "paid" && facts.status !== "failed" && facts.status !== "canceled") return null;
  const landed = facts.status === "paid";
  await finDb().execute({
    sql: `INSERT INTO fin_stripe_payouts
            (id, entity_id, stripe_status, booking, amount_cents, currency, arrival_date, settlement_cents, settlement_currency,
             fee_cents, destination_id, reason, livemode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            -- A failed or canceled payout never goes back to paid, whatever order the events arrive in.
            stripe_status = CASE WHEN fin_stripe_payouts.stripe_status IN ('failed', 'canceled') THEN fin_stripe_payouts.stripe_status ELSE excluded.stripe_status END,
            settlement_cents = COALESCE(excluded.settlement_cents, fin_stripe_payouts.settlement_cents),
            settlement_currency = COALESCE(excluded.settlement_currency, fin_stripe_payouts.settlement_currency),
            fee_cents = CASE WHEN excluded.settlement_cents IS NOT NULL THEN excluded.fee_cents ELSE fin_stripe_payouts.fee_cents END,
            destination_id = COALESCE(excluded.destination_id, fin_stripe_payouts.destination_id),
            updated_at = ${NOW_SQL}`,
    args: [
      facts.payoutId,
      E,
      facts.status,
      landed ? "held" : "not_booked",
      facts.amountCents,
      facts.currency,
      facts.arrivalDate,
      facts.settlementCents,
      facts.settlementCurrency,
      facts.feeCents,
      facts.destinationId,
      landed ? "recorded; not booked yet" : `Stripe reports this payout ${facts.status}; nothing was booked`,
    ],
  });
  const row = await loadPayout(facts.payoutId);
  if (!row) throw new Error(`payout ${facts.payoutId} was neither recorded nor found`);
  if (row.stripe_status === "paid") return bookPayout(row);
  return unbookPayout(row, opts.reportedOn ?? torontoToday());
}

/**
 * A booking undone on the books since: the row says booked, but its entry is
 * no longer posted. Only an ADOPTED entry can be undone that way (the payout's
 * own stripe_payout entry is reversed in the same batch that marks the row
 * 'reversed', unbookPayout): it is the bank line's own entry, and excluding or
 * re-categorising the line reverses it. The payout is then not on the books.
 * It is never posted from Stripe on its own: the line may have been
 * re-categorised as other money that reached the bank, and a payout entry on
 * top would count that deposit twice. A deposit categorised to Stripe
 * clearing is adopted again (the next reconcile, or the payout's next event).
 */
export const UNDONE_REASON =
  "its booking was undone on the books (the bank line it was booked from was excluded or re-categorised); categorise that deposit to Stripe clearing to book it again";

/** fin_stripe_payouts rows whose booking was undone (UNDONE_REASON), as a SQL condition on the unaliased table. */
const UNDONE_WHERE = `fin_stripe_payouts.booking = 'booked'
  AND NOT EXISTS (SELECT 1 FROM fin_journal_entries ue WHERE ue.id = fin_stripe_payouts.entry_id AND ue.status = 'posted')`;

async function entryPosted(entryId: string | null): Promise<boolean> {
  if (!entryId) return false;
  return (await queryOne<{ one: number }>(`SELECT 1 AS one FROM fin_journal_entries WHERE id = ? AND status = 'posted'`, [entryId])) !== null;
}

/** Back to held, still naming the entry that was undone (so bookPayout never posts it from Stripe). */
async function reopenUndoneBooking(row: PayoutRow): Promise<PayoutRow> {
  await finDb().execute({
    sql: `UPDATE fin_stripe_payouts SET booking = 'held', reason = ?, updated_at = ${NOW_SQL} WHERE id = ? AND ${UNDONE_WHERE}`,
    args: [UNDONE_REASON, row.id],
  });
  return (await loadPayout(row.id)) ?? row;
}

async function setUnbooked(id: string, booking: "held" | "unmapped", reason: string): Promise<void> {
  await finDb().execute({
    sql: `UPDATE fin_stripe_payouts SET booking = ?, reason = ?, updated_at = ${NOW_SQL} WHERE id = ? AND booking IN ('held', 'unmapped')`,
    args: [booking, reason.slice(0, 500), id],
  });
}

async function bookPayout(row: PayoutRow): Promise<PayoutOutcome> {
  // Booked from a bank line whose entry was reversed since: a gap again (UNDONE_REASON).
  if (row.booking === "booked" && !(await entryPosted(row.entry_id))) row = await reopenUndoneBooking(row);
  if (row.booking !== "held" && row.booking !== "unmapped") return outcomeOf(row);
  const id = row.id;

  // A bank line put it on the books first (the Wise feed's, or any categorised to Stripe clearing): adopt that entry.
  const adopted = await adoptExistingBooking(row);
  if (adopted) return adopted;

  // Undone once (it still names that entry): adopted again from a bank line, never posted from Stripe.
  if (row.entry_id) {
    await setUnbooked(id, "held", UNDONE_REASON);
    return outcomeOf((await loadPayout(id)) ?? row);
  }

  const bank = await payoutBankAccount();
  if (bank.id === null) {
    await setUnbooked(id, "unmapped", bank.reason);
    return outcomeOf((await loadPayout(id)) ?? row);
  }

  const facts: PayoutFacts = {
    payoutId: id,
    status: row.stripe_status,
    amountCents: row.amount_cents,
    currency: row.currency,
    arrivalDate: row.arrival_date,
    created: 0,
    livemode: row.livemode === 1,
    settlementCents: row.settlement_cents,
    settlementCurrency: row.settlement_currency,
    feeCents: row.fee_cents,
    balanceTxnId: null,
    destinationId: row.destination_id,
    failureCode: null,
  };
  const needsUsd = facts.currency === "USD" || facts.settlementCurrency === "USD";
  const rate = needsUsd ? await usdCadRate(facts.arrivalDate) : null;
  const clearing = await clearingByCurrency(facts.arrivalDate);
  const plan = planStripePayout({
    payout: facts,
    bankAccountId: bank.id,
    accounts: accounts(),
    clearing,
    contents: payoutNeedsContents(facts, clearing) ? await payoutContents(facts) : null,
    cadOf: (cents, currency, day) =>
      currency === "CAD" ? cents : currency === "USD" && rate && day === facts.arrivalDate ? usdToCadCents(cents, rate.micro) : null,
  });
  if (plan.kind !== "book") {
    await setUnbooked(id, plan.kind, plan.reason);
    return outcomeOf((await loadPayout(id)) ?? row);
  }

  // Both entries at the rate planStripePayout valued them at, so the
  // conversion nets to zero in Currency exchange clearing. Gated on the
  // payout still unbooked AND on no bank line having booked it meanwhile (by
  // its Wise tag or its shape): one that did is adopted below instead.
  const fixedRates = rate ? { USD: rate.rate } : undefined;
  const gate = {
    sql: `(SELECT booking FROM fin_stripe_payouts WHERE id = ?) IN ('held', 'unmapped')
          AND NOT EXISTS (SELECT 1 FROM fin_bank_transactions t WHERE ${BANK_LINE_WHERE})
          AND NOT EXISTS (SELECT 1 FROM fin_journal_entries e WHERE ${SHAPE_WHERE})`,
    args: [id, ...bankLineArgs(id), ...shapeArgs(row)],
  };
  const statements: InStatement[] = [];
  try {
    if (plan.conversion) {
      const c = plan.conversion;
      const conversion = await buildPosting({
        entityId: E,
        entryDate: facts.arrivalDate,
        memo: `Stripe payout ${id}: ${c.currency} it paid out from charges booked in CAD, converted at the Bank of Canada rate of ${facts.arrivalDate}`,
        source: PAYOUT_FX_SOURCE,
        sourceRef: id,
        createdBy: ACTOR,
        fixedRates,
        gate,
        lines: c.lines,
      });
      statements.push(...conversion.statements);
    }
    const posting = await buildPosting({
      entityId: E,
      entryDate: facts.arrivalDate,
      memo: `Stripe payout ${id}: a transfer out of Stripe clearing into the bank, not revenue`,
      source: PAYOUT_SOURCE,
      sourceRef: id,
      createdBy: ACTOR,
      fixedRates,
      gate,
      lines: plan.lines,
    });
    statements.push(
      ...posting.statements,
      {
        sql: `UPDATE fin_stripe_payouts SET booking = 'booked', entry_id = ?, bank_account_id = ?, reason = NULL, updated_at = ${NOW_SQL}
               WHERE id = ? AND booking IN ('held', 'unmapped') AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
        args: [posting.entryId, bank.id, id, posting.entryId],
      },
      auditIfPosted(posting.entryId, "stripe.payout_booked", id, {
        entry: posting.entryId,
        bank_account: bank.id,
        conversion: plan.conversion
          ? {
              currency: plan.conversion.currency,
              cents: plan.conversion.cents,
              cad_cents: plan.conversion.cadCents,
              cad_taken_cents: plan.conversion.cadTakenCents,
              fx_cents: plan.conversion.fxCents,
            }
          : null,
        fx_cents: plan.fxCents,
      }),
    );
    await writeBatch(statements);
  } catch (e) {
    if (e instanceof LedgerError && e.code === "fx_rate_missing") {
      await setUnbooked(id, "held", `no Bank of Canada rate is stored for ${facts.arrivalDate} yet`);
    } else if (!isUniqueViolation(e)) {
      throw e;
    }
    // A unique violation: a concurrent delivery booked it. Either way, report what is stored now.
  }
  const after = (await loadPayout(id)) ?? row;
  // The gate refused because a bank line booked it between the check and the write: adopt that line's entry.
  if (after.booking === "held" || after.booking === "unmapped") return (await adoptExistingBooking(after)) ?? outcomeOf(after);
  return outcomeOf(after);
}

async function unbookPayout(row: PayoutRow, reportedOn: string): Promise<PayoutOutcome> {
  const id = row.id;
  const status = row.stripe_status;
  if (row.booking === "held" || row.booking === "unmapped") {
    await finDb().execute({
      sql: `UPDATE fin_stripe_payouts SET booking = 'not_booked', reason = ?, updated_at = ${NOW_SQL} WHERE id = ? AND booking IN ('held', 'unmapped')`,
      args: [`Stripe reports this payout ${status}; nothing was booked`, id],
    });
  } else if (row.booking === "booked" && row.entry_id) {
    const entry = await queryOne<{ source: string; status: string }>(`SELECT source, status FROM fin_journal_entries WHERE id = ? AND entity_id = ?`, [row.entry_id, E]);
    if (entry?.source === PAYOUT_SOURCE && entry.status === "posted") {
      const reversal = await buildReversal({ entityId: E, entryId: row.entry_id, date: reportedOn, memo: `Stripe payout ${id} ${status}: reversed`, createdBy: ACTOR });
      try {
        await writeBatch([
          ...reversal.statements,
          {
            sql: `UPDATE fin_stripe_payouts SET booking = 'reversed', reversal_entry_id = ?, reason = ?, updated_at = ${NOW_SQL}
                   WHERE id = ? AND booking = 'booked' AND entry_id = ?`,
            args: [reversal.entryId, `Stripe reported this payout ${status} on ${reportedOn}; its booking was reversed`, id, row.entry_id],
          },
          auditIfPosted(reversal.entryId, "stripe.payout_reversed", id, { entry: row.entry_id, reversal: reversal.entryId, status }),
        ]);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    } else {
      // Booked from its Wise bank line: the bank shows the money coming back
      // as its own line, so nothing is reversed here.
      await finDb().execute({
        sql: `UPDATE fin_stripe_payouts SET reason = ?, updated_at = ${NOW_SQL} WHERE id = ? AND booking = 'booked'`,
        args: [`Stripe reports this payout ${status} after its bank line was booked; the bank shows it returned`, id],
      });
    }
  }
  return outcomeOf((await loadPayout(id)) ?? row);
}

/** Book every paid payout still held or unmapped, or undone (UNDONE_REASON), oldest first (clearing is used in arrival order). */
export async function retryUnbookedPayouts(): Promise<number> {
  const rows = await query<PayoutRow>(
    `SELECT * FROM fin_stripe_payouts
      WHERE entity_id = ? AND stripe_status = 'paid' AND (booking IN ('held', 'unmapped') OR (${UNDONE_WHERE}))
      ORDER BY arrival_date, id`,
    [E],
  );
  let booked = 0;
  for (const r of rows) if ((await bookPayout(r)).booking === "booked") booked += 1;
  return booked;
}

export type UnbookedPayout = { id: string; amountCents: number; currency: string; arrivalDate: string; booking: "held" | "unmapped"; reason: string };

/**
 * Paid payouts the books have not booked, oldest first: what the cash tile
 * lists as a gap. A booking undone since (UNDONE_REASON) is one of them from
 * the moment its entry is reversed, before any reconcile reopens its row.
 */
export async function unbookedPayouts(entityId: string = E): Promise<UnbookedPayout[]> {
  const rows = await query<{ id: string; amount_cents: number; currency: string; arrival_date: string; booking: string; reason: string | null; undone: number }>(
    `SELECT id, amount_cents, currency, arrival_date, booking, reason, (${UNDONE_WHERE}) AS undone FROM fin_stripe_payouts
      WHERE entity_id = ? AND (booking IN ('held', 'unmapped') OR (${UNDONE_WHERE})) AND stripe_status = 'paid' AND livemode = 1
      ORDER BY arrival_date, id`,
    [entityId],
  );
  return rows.map((r) => {
    const undone = n(r.undone) === 1;
    return {
      id: r.id,
      amountCents: n(r.amount_cents),
      currency: r.currency,
      arrivalDate: r.arrival_date,
      booking: undone || r.booking === "held" ? "held" : "unmapped",
      reason: undone ? UNDONE_REASON : r.reason || "",
    };
  });
}

/**
 * A payout on the books from a bank line the feed cannot link to: adopted by
 * its shape (an uploaded statement's line, an untagged line, a hand-made
 * entry). The Wise feed holds its own line for that payout instead of posting
 * it: it is the same deposit on the books a second time.
 */
export async function payoutBookedFromAnotherLine(payoutId: string, entityId: string = E): Promise<{ entryDate: string } | null> {
  return queryOne<{ entryDate: string }>(
    `SELECT e.entry_date AS entryDate FROM fin_stripe_payouts p JOIN fin_journal_entries e ON e.id = p.entry_id
      WHERE p.id = ? AND p.entity_id = ? AND p.booking = 'booked' AND e.status = 'posted' AND e.source <> ?`,
    [payoutId, entityId, PAYOUT_SOURCE],
  );
}

/**
 * The entry that booked a payout from Stripe, and the bank account it put the
 * money in, when it is on the books (the Wise feed links its bank line to it
 * rather than posting the payout a second time).
 */
export async function bookedPayoutEntry(payoutId: string, entityId: string = E): Promise<{ entryId: string; bankAccountId: string | null } | null> {
  const row = await queryOne<{ entry_id: string; bank_account_id: string | null }>(
    `SELECT p.entry_id, p.bank_account_id FROM fin_stripe_payouts p JOIN fin_journal_entries e ON e.id = p.entry_id
      WHERE p.id = ? AND p.entity_id = ? AND p.booking = 'booked' AND e.status = 'posted' AND e.source = ?`,
    [payoutId, entityId, PAYOUT_SOURCE],
  );
  return row ? { entryId: row.entry_id, bankAccountId: row.bank_account_id } : null;
}
