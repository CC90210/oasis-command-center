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
 * NEVER TWICE WITH THE BANK FEED. The Wise feed (wise-feed-io.ts) recognises
 * the same payout on its bank line. If the feed booked it first, the payout
 * here is ADOPTED (its row points at the bank line's entry) and nothing is
 * posted; the booking batch is also gated on no such bank line existing. The
 * feed, in turn, links its line to an entry booked here instead of posting
 * its own.
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
import { torontoToday, usdToCadCents } from "./fx";
import type { PayoutFacts } from "./stripe-map";
import { PAYOUT_FX_SOURCE, PAYOUT_SOURCE, payoutBankLineName, planStripePayout, UNMAPPED_REASON, type PayoutAccounts } from "./stripe-payouts";

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

/** What 1050 Stripe clearing holds, per currency. Every line counts: a reversal cancels its original. */
async function clearingByCurrency(): Promise<Record<string, number>> {
  const rows = await query<{ currency: string; n: number | null }>(
    `SELECT currency, COALESCE(SUM(debit_cents - credit_cents), 0) AS n FROM fin_journal_lines WHERE entity_id = ? AND account_id = ? GROUP BY currency`,
    [E, accountId(E, SYS.stripeClearing)],
  );
  return Object.fromEntries(rows.map((r) => [r.currency, n(r.n)]));
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

async function setUnbooked(id: string, booking: "held" | "unmapped", reason: string): Promise<void> {
  await finDb().execute({
    sql: `UPDATE fin_stripe_payouts SET booking = ?, reason = ?, updated_at = ${NOW_SQL} WHERE id = ? AND booking IN ('held', 'unmapped')`,
    args: [booking, reason.slice(0, 500), id],
  });
}

async function bookPayout(row: PayoutRow): Promise<PayoutOutcome> {
  if (row.booking !== "held" && row.booking !== "unmapped") return outcomeOf(row);
  const id = row.id;

  // The bank feed booked it from its Wise line first: adopt that entry.
  const fed = await bankFeedBooking(id);
  if (fed) {
    await finDb().execute({
      sql: `UPDATE fin_stripe_payouts SET booking = 'booked', entry_id = ?, bank_account_id = ?, reason = ?, updated_at = ${NOW_SQL}
             WHERE id = ? AND booking IN ('held', 'unmapped')`,
      args: [fed.entry_id, fed.account_id, "booked from its Wise bank line", id],
    });
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
  const plan = planStripePayout({
    payout: facts,
    bankAccountId: bank.id,
    accounts: accounts(),
    clearing: await clearingByCurrency(),
    cadOf: (cents, currency, day) =>
      currency === "CAD" ? cents : currency === "USD" && rate && day === facts.arrivalDate ? usdToCadCents(cents, rate.micro) : null,
  });
  if (plan.kind !== "book") {
    await setUnbooked(id, plan.kind, plan.reason);
    return outcomeOf((await loadPayout(id)) ?? row);
  }

  // Both entries at the rate planStripePayout valued them at, so the
  // conversion nets to zero in Currency exchange clearing.
  const fixedRates = rate ? { USD: rate.rate } : undefined;
  const gate = {
    sql: `(SELECT booking FROM fin_stripe_payouts WHERE id = ?) IN ('held', 'unmapped')
          AND NOT EXISTS (SELECT 1 FROM fin_bank_transactions t WHERE ${BANK_LINE_WHERE})`,
    args: [id, ...bankLineArgs(id)],
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
          ? { currency: plan.conversion.currency, cents: plan.conversion.cents, cad_cents: plan.conversion.cadCents, cad_taken_cents: plan.conversion.cadTakenCents }
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
  return outcomeOf((await loadPayout(id)) ?? row);
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

/** Book every paid payout still held or unmapped, oldest first (clearing is used in arrival order). */
export async function retryUnbookedPayouts(): Promise<number> {
  const rows = await query<PayoutRow>(
    `SELECT * FROM fin_stripe_payouts WHERE entity_id = ? AND booking IN ('held', 'unmapped') AND stripe_status = 'paid' ORDER BY arrival_date, id`,
    [E],
  );
  let booked = 0;
  for (const r of rows) if ((await bookPayout(r)).booking === "booked") booked += 1;
  return booked;
}

export type UnbookedPayout = { id: string; amountCents: number; currency: string; arrivalDate: string; booking: "held" | "unmapped"; reason: string };

/** Paid payouts the books have not booked, oldest first: what the cash tile lists as a gap. */
export async function unbookedPayouts(entityId: string = E): Promise<UnbookedPayout[]> {
  const rows = await query<{ id: string; amount_cents: number; currency: string; arrival_date: string; booking: "held" | "unmapped"; reason: string | null }>(
    `SELECT id, amount_cents, currency, arrival_date, booking, reason FROM fin_stripe_payouts
      WHERE entity_id = ? AND booking IN ('held', 'unmapped') AND stripe_status = 'paid' AND livemode = 1
      ORDER BY arrival_date, id`,
    [entityId],
  );
  return rows.map((r) => ({ id: r.id, amountCents: n(r.amount_cents), currency: r.currency, arrivalDate: r.arrival_date, booking: r.booking, reason: r.reason || "" }));
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
