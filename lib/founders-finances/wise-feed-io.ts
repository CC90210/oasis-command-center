/**
 * The Wise bank feed: Wise balance activity -> the business book's register
 * on 1000 Business chequing (Wise IS the business bank account), plus the
 * founder-triggered opening balance that makes chequing equal Wise on a day.
 *
 * SYNC reuses the statement import (transactions-io.ts previewImport /
 * commitImport) with an OFX rendering of the statement (wise-feed.ts), so the
 * dedupe hash, the rules and the import history are the upload's own. A
 * re-sync is a no-op: every FITID is already there, so nothing is committed
 * (not even an empty import record) and nothing is re-resolved.
 *
 * MONEY ALREADY ON THE BOOKS IS NEVER BOOKED AGAIN. Before any rule sees a
 * line, wise-feed.ts planFeed decides what the feed does with it, and those
 * lines are imported HELD (no rule touches them):
 *   - a deposit "Check for Wise payments" already recorded against an invoice
 *     (settlement source wise_payment) -> set aside (excluded, with a note);
 *     the reverse order is wise-reconcile.ts's: it sets an unreviewed fed line
 *     aside when it records, and refuses when the line is already posted;
 *   - a debit that IS an expense/bill already recorded from Bills (same
 *     register account, amount, currency, within 7 days, closest first, each
 *     bill once) -> LINKED to that entry, nothing posted; ambiguous -> left
 *     unreviewed with the candidates named; debits adding up exactly to one
 *     such expense -> held with it named;
 *   - a Stripe payout -> out of 1050 Stripe clearing in Stripe's settlement
 *     currency/amount, into chequing in the currency it arrived in, the
 *     conversion difference through 1060 to FX gain/loss (never revenue) —
 *     held instead when Stripe clearing does not hold that much in that
 *     currency;
 *   - a Wise conversion -> both legs through 1060 in one atomic batch;
 *   - a line dated on or before the opening balance that arrived after it
 *     was posted -> held (the balance already contains it).
 * A held line carries a note starting FEED_HOLD_MARK, and no rule ever books
 * it later either ("Apply rules", "create rule from transaction": see
 * transactions-io.ts). Every other new line goes through the rules like an
 * uploaded statement. After a sync the result also says when an opening
 * balance no longer matches the books (re-post it) and when a categorised
 * Wise payment looks like an expense recorded on Bills afterwards.
 *
 * OPENING BALANCE: the business book has no opening-balance mechanism of its
 * own (the business chart's equity is owner equity, draws and retained
 * earnings), so it posts through buildPosting — the ledger's one writer —
 * against 3900 Retained earnings, source "opening_balance", ref
 * wise:<currency>:<generation> (unique). EXACTLY ONE is in force per
 * currency: posting again REPLACES it (the old entry is reversed at its own
 * date and the new one posted, in one batch, with an audit row). Its book
 * side counts every fed line on or before the day, posted or not, so
 * categorising a line later keeps chequing equal to Wise. Never automatic:
 * only an explicit founder action (or a non-dry-run call) posts it.
 */
import "server-only";

import { accountId, BUSINESS_ENTITY_ID, categoryId, SYS } from "./chart";
import { addDays, isIsoDate, torontoToday, usdToCadCents } from "./fx";
import { viewerLabel, type FinanceViewer } from "./access";
import { auditStatement, isUniqueViolation, n, query, queryOne, writeBatch, type InStatement } from "./db";
import { FinanceInputError, requireEntity } from "./access-io";
import { buildPosting, buildReversal } from "./ledger-io";
import { usdCadRate } from "./fx-io";
import { buildLinePosting, commitImport, linkLineToEntryStatements, previewImport, REGISTER_ENTRY_SOURCE } from "./transactions-io";
import { getStripeClient, listAll, StripeNotReady } from "./stripe-io";
import {
  balanceAtEndOf,
  BILL_MATCH_WINDOW_DAYS,
  centsToDecimal,
  conversionLegLines,
  FEED_HOLD_MARK,
  feedRowsFromStatement,
  feedRowsToOfx,
  intervalAround,
  matchDebitsToBills,
  OPENING_BALANCE_SOURCE,
  planFeed,
  stripePayoutBlocker,
  stripePayoutFromApi,
  stripePayoutLines,
  tagStripePayouts,
  WISE_FEED_OFF_MESSAGE,
  WISE_FEED_WRITES_ENABLED,
  type BillCandidate,
  type CadOf,
  type FeedAccounts,
  type FeedResolution,
  type OpeningMark,
  type StripePayoutLite,
  type WiseFeedRow,
} from "./wise-feed";
import { wiseStatement, WiseNotReady } from "./wise-io";
import { recordedRefs } from "./wise-reconcile";

const FEED_CURRENCIES = ["CAD", "USD"] as const;
/** Wise statements span at most 469 days. */
const MAX_DAYS = 460;
/** Every fed line's FITID starts with this (wise-feed.ts wiseFitid). */
const FED = "WISE-%";
/**
 * Notes the feed writes on a line it holds start with one of these, so a
 * later sync can clear them, the opening balance can tell them apart, and no
 * rule ever books the line (transactions-io.ts skips FEED_HOLD_MARK):
 * DECIDE = a founder must decide what it is (it may already be on the books),
 * so no opening balance can be computed through it; OPENING = it is inside an
 * opening balance posted before it arrived, and counts as pending.
 */
const DECIDE_NOTE = `${FEED_HOLD_MARK}: `;
const OPENING_NOTE = `${FEED_HOLD_MARK} (opening balance): `;
const isFeedNote = (memo: string) => memo.startsWith(FEED_HOLD_MARK);
/** "Bank fees" in BUSINESS_CHART; SYS has no role key for it. */
const BANK_FEES_CODE = "5010";

function sinceDate(raw: Record<string, unknown>, today: string): { since: string; days: number } {
  if (raw.since !== undefined && raw.since !== null && raw.since !== "") {
    const since = String(raw.since).trim();
    if (!isIsoDate(since)) throw new FinanceInputError("since must be a date (YYYY-MM-DD)");
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000);
    if (days < 0) throw new FinanceInputError("since cannot be in the future");
    if (days > MAX_DAYS) throw new FinanceInputError(`Wise statements reach back at most ${MAX_DAYS} days per sync`);
    return { since, days };
  }
  const v = typeof raw.days === "number" ? raw.days : typeof raw.days === "string" && raw.days.trim() ? Number(raw.days) : 30;
  const days = Number.isFinite(v) ? Math.max(1, Math.min(MAX_DAYS, Math.trunc(v))) : 30;
  return { since: addDays(today, -days), days };
}

function feedAccounts(entityId: string): FeedAccounts {
  return {
    chequing: accountId(entityId, SYS.chequing),
    stripeClearing: accountId(entityId, SYS.stripeClearing),
    fxClearing: accountId(entityId, SYS.fxClearing),
    fxGainLoss: accountId(entityId, SYS.fxGainLoss),
    stripeFees: accountId(entityId, SYS.stripeFees),
    bankFees: accountId(entityId, BANK_FEES_CODE),
  };
}

/** Stripe payouts arriving on or after `since` (minus a few days' slack), with what each took from the Stripe balance. */
async function stripePayoutsSince(since: string): Promise<{ payouts: StripePayoutLite[]; note: string | null }> {
  let client: { key: string };
  try {
    client = await getStripeClient();
  } catch (e) {
    if (e instanceof StripeNotReady) return { payouts: [], note: `Stripe is not connected (${e.message}), so Stripe payouts could not be recognised; they are imported unreviewed.` };
    throw e;
  }
  try {
    const from = Math.floor(Date.parse(`${addDays(since, -5)}T00:00:00Z`) / 1000);
    const { items, truncated } = await listAll(client.key, "/v1/payouts", { "arrival_date[gte]": from }, { maxPages: 10, expand: ["data.balance_transaction"] });
    const payouts = items.map(stripePayoutFromApi).filter((p): p is StripePayoutLite => p !== null);
    return { payouts, note: truncated ? "More Stripe payouts than one sync reads; the oldest may not be recognised." : null };
  } catch (e) {
    console.error("[finances:wise-feed] stripe payouts", e instanceof Error ? e.message : e);
    return { payouts: [], note: `Stripe payouts could not be read (${e instanceof Error ? e.message.slice(0, 160) : "error"}); payout deposits are imported unreviewed.` };
  }
}

// ── what the books already hold ──────────────────────────────────────────

type FeedLine = { id: string; fitid: string; status: string; entry_id: string | null; created_at: string; memo: string; description: string; posted_date: string };

async function feedLines(entityId: string, chequing: string, fitids: string[]): Promise<Map<string, FeedLine>> {
  const out = new Map<string, FeedLine>();
  const unique = [...new Set(fitids)];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const rows = await query<FeedLine>(
      `SELECT id, fitid, status, entry_id, created_at, memo, description, posted_date FROM fin_bank_transactions
        WHERE entity_id = ? AND account_id = ? AND fitid IN (${chunk.map(() => "?").join(",")})`,
      [entityId, chequing, ...chunk],
    );
    for (const r of rows) out.set(r.fitid, r);
  }
  return out;
}

type ActiveOpening = { id: string; currency: string; date: string; createdAt: string; cents: number };

/** Opening balances in force (not reversed), per currency, newest first. */
async function activeOpenings(entityId: string, chequing: string): Promise<Map<string, ActiveOpening[]>> {
  const rows = await query<{ id: string; entry_date: string; created_at: string; currency: string; cents: number }>(
    `SELECT e.id, e.entry_date, e.created_at, l.currency, COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS cents
       FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id AND l.account_id = ?
      WHERE e.entity_id = ? AND e.source = ? AND e.status = 'posted' AND e.source_ref LIKE 'wise:%'
      GROUP BY e.id, e.entry_date, e.created_at, l.currency
      ORDER BY e.created_at DESC`,
    [chequing, entityId, OPENING_BALANCE_SOURCE],
  );
  const out = new Map<string, ActiveOpening[]>();
  for (const r of rows) {
    const list = out.get(r.currency) || [];
    list.push({ id: r.id, currency: r.currency, date: r.entry_date, createdAt: r.created_at, cents: n(r.cents) });
    out.set(r.currency, list);
  }
  return out;
}

function openingMarks(openings: Map<string, ActiveOpening[]>): Map<string, OpeningMark> {
  const out = new Map<string, OpeningMark>();
  for (const [cur, list] of openings) {
    // Legacy rows could hold two; the latest date covers the most, the newest post is the one lines arrived after.
    const date = list.reduce((a, o) => (o.date > a ? o.date : a), list[0].date);
    out.set(cur, { date, createdAt: list[0].createdAt });
  }
  return out;
}

/** Paid bills/expenses that left `chequing` between `from` and `to` and that no bank line is linked to yet. */
async function billCandidates(entityId: string, chequing: string, from: string, to: string): Promise<BillCandidate[]> {
  const rows = await query<{ id: string; kind: string; vendor_name: string; currency: string; total_cents: number; paid_on: string; link_entry_id: string | null; category_id: string | null }>(
    `SELECT b.id, b.kind, b.vendor_name, b.currency, b.total_cents, substr(COALESCE(b.paid_at, b.bill_date), 1, 10) AS paid_on,
            CASE WHEN b.kind = 'expense' THEN b.entry_id ELSE b.payment_entry_id END AS link_entry_id,
            (SELECT c.id FROM fin_bill_lines bl JOIN fin_categories c ON c.account_id = bl.account_id AND c.entity_id = b.entity_id
              WHERE bl.bill_id = b.id ORDER BY bl.line_no, c.id LIMIT 1) AS category_id
       FROM fin_bills b
      WHERE b.entity_id = ? AND b.status = 'paid' AND b.paid_from_account_id = ?
        AND substr(COALESCE(b.paid_at, b.bill_date), 1, 10) BETWEEN ? AND ?`,
    [entityId, chequing, from, to],
  );
  const withEntry = rows.filter((r) => r.link_entry_id);
  if (withEntry.length === 0) return [];
  const ids = withEntry.map((r) => r.link_entry_id as string);
  const taken = new Set<string>();
  const live = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    for (const r of await query<{ entry_id: string }>(`SELECT entry_id FROM fin_bank_transactions WHERE entity_id = ? AND entry_id IN (${ph})`, [entityId, ...chunk])) taken.add(r.entry_id);
    for (const r of await query<{ id: string }>(`SELECT id FROM fin_journal_entries WHERE entity_id = ? AND status = 'posted' AND id IN (${ph})`, [entityId, ...chunk])) live.add(r.id);
  }
  return withEntry
    .filter((r) => live.has(r.link_entry_id as string) && !taken.has(r.link_entry_id as string))
    .map((r) => ({
      id: r.id,
      entryId: r.link_entry_id as string,
      label: `${r.kind === "bill" ? "bill" : "expense"} "${r.vendor_name}" (${r.paid_on})`,
      currency: r.currency,
      totalCents: n(r.total_cents),
      paidOn: r.paid_on,
      categoryId: r.category_id,
    }));
}

/**
 * A line linked to an expense that has since been voided (its entry
 * reversed) no longer has its money on the books: put it back for review.
 */
async function reopenVoidedLinks(entityId: string, chequing: string, actor: string): Promise<number> {
  const results = await writeBatch([
    {
      sql: `UPDATE fin_bank_transactions SET status = 'unreviewed', entry_id = NULL, category_id = NULL,
                   memo = 'The expense this line was matched to was voided, so it is back for review.'
             WHERE entity_id = ? AND account_id = ? AND fitid LIKE ? AND status = 'posted'
               AND entry_id IN (SELECT id FROM fin_journal_entries WHERE entity_id = ? AND source <> ? AND status = 'reversed')`,
      args: [entityId, chequing, FED, entityId, REGISTER_ENTRY_SOURCE],
    },
  ]);
  const reopened = results[0]?.rowsAffected ?? 0;
  if (reopened > 0) {
    await writeBatch([auditStatement({ entityId, actor, action: "wise.feed_links_reopened", objectType: "transaction", objectId: null, detail: { reopened } })]);
  }
  return reopened;
}

/** Own-day Bank of Canada rates for the given days; a missing day is an error a founder can act on, never a guess. */
async function ratesFor(dates: readonly string[]): Promise<Map<string, { rate: string; micro: bigint }>> {
  const out = new Map<string, { rate: string; micro: bigint }>();
  for (const d of new Set(dates)) {
    const r = await usdCadRate(d);
    if (!r) throw new FinanceInputError(`no Bank of Canada USD rate for ${d} yet; refresh exchange rates in Settings, then sync again`);
    out.set(d, r);
  }
  return out;
}

const cadOfWith =
  (rates: ReadonlyMap<string, { micro: bigint }>): CadOf =>
  (cents, currency, date) => {
    if (currency === "CAD") return cents;
    const r = rates.get(date);
    if (!r) throw new FinanceInputError(`no Bank of Canada USD rate for ${date}`);
    return usdToCadCents(cents, r.micro);
  };

/** What 1050 Stripe clearing holds on the books in one currency (every entry, any date). */
async function stripeClearingCents(entityId: string, clearing: string, currency: string): Promise<number> {
  const r = await queryOne<{ n: number | null }>(
    `SELECT COALESCE(SUM(debit_cents - credit_cents), 0) AS n FROM fin_journal_lines WHERE entity_id = ? AND account_id = ? AND currency = ?`,
    [entityId, clearing, currency],
  );
  return n(r?.n);
}

/**
 * Opening balances the books have moved away from since they were posted:
 * something dated on or before the day changed afterwards (a line that
 * arrived late, a link whose bank day and expense day straddle it, a
 * backdated or voided entry). Each needs re-posting to keep chequing = Wise.
 * Compares the book side now with the one recorded when it was posted.
 */
async function staleOpeningNotes(entityId: string, chequing: string): Promise<string[]> {
  const notes: string[] = [];
  for (const [cur, list] of await activeOpenings(entityId, chequing)) {
    const newest = list[0];
    const audit = await queryOne<{ detail_json: string }>(
      `SELECT detail_json FROM fin_audit_log WHERE entity_id = ? AND object_id = ? AND action IN ('wise.opening_balance', 'wise.opening_balance_replaced')
        ORDER BY created_at DESC LIMIT 1`,
      [entityId, newest.id],
    );
    let wise: number | null = null;
    try {
      const w = (JSON.parse(audit?.detail_json || "{}") as { wise?: unknown }).wise;
      wise = typeof w === "number" && Number.isSafeInteger(w) ? w : null;
    } catch {
      wise = null;
    }
    if (wise === null) {
      notes.push(`The ${cur} opening balance for ${newest.date} has no record of the Wise balance it was posted for; preview and re-post it on the Wise card.`);
      continue;
    }
    const side = await bookSide(entityId, chequing, cur, newest.date, list.map((o) => o.id));
    const inForce = list.reduce((a, o) => a + o.cents, 0);
    const needed = wise - side.books;
    if (needed !== inForce || list.length > 1) {
      notes.push(
        `The ${cur} opening balance for ${newest.date} no longer makes Business chequing equal Wise: the books on or before that day moved by ${centsToDecimal(inForce - needed)} ${cur} after it was posted. Preview and re-post it on the Wise card.`,
      );
    }
  }
  return notes;
}

/**
 * The reverse order of a matched expense: a Wise debit a rule or a founder
 * categorised as new money BEFORE the same expense was recorded on Bills.
 * Both are then on the books; the feed cannot undo a booking, so it says so.
 * A line categorised while the feed held it (its note named the candidates)
 * was a founder's informed decision and is not repeated here.
 */
async function possibleDoubleNotes(entityId: string, chequing: string, from: string, to: string): Promise<string[]> {
  const bills = await billCandidates(entityId, chequing, from, to);
  if (bills.length === 0) return [];
  const booked = await query<{ fitid: string; posted_date: string; amount_cents: number; currency: string; description: string }>(
    `SELECT t.fitid, t.posted_date, t.amount_cents, t.currency, t.description
       FROM fin_bank_transactions t JOIN fin_journal_entries e ON e.id = t.entry_id
      WHERE t.entity_id = ? AND t.account_id = ? AND t.fitid LIKE ? AND t.status = 'posted' AND t.amount_cents < 0
        AND t.posted_date BETWEEN ? AND ? AND e.source = ? AND e.status = 'posted' AND substr(t.memo, 1, ?) <> ?
        AND COALESCE(t.category_id, '') NOT IN (?, ?)`,
    [entityId, chequing, FED, addDays(from, -BILL_MATCH_WINDOW_DAYS), addDays(to, BILL_MATCH_WINDOW_DAYS), REGISTER_ENTRY_SOURCE, FEED_HOLD_MARK.length, FEED_HOLD_MARK, categoryId(entityId, SYS.stripeClearing), categoryId(entityId, SYS.fxClearing)],
  );
  const lines = booked.map((b) => ({ fitid: b.fitid, postedDate: b.posted_date, amountCents: n(b.amount_cents), currency: b.currency, description: b.description }));
  const m = matchDebitsToBills(lines, bills);
  const byFitid = new Map(lines.map((l) => [l.fitid, l]));
  const pairs: Array<[string, BillCandidate[]]> = [...[...m.linked].map(([f, b]): [string, BillCandidate[]] => [f, [b]]), ...m.ambiguous];
  return pairs.map(([fitid, list]) => {
    const l = byFitid.get(fitid)!;
    return `Possible double count: the Wise payment of ${centsToDecimal(-l.amountCents)} ${l.currency} on ${l.postedDate} ("${l.description.slice(0, 60)}") is categorised, and ${list.map((b) => b.label).join(" or ")} is also on the books. If they are the same payment, exclude the line in Transactions.`;
  });
}

// ── sync ─────────────────────────────────────────────────────────────────

export type WiseSyncCurrency = {
  currency: string;
  /** Wise rows in the window. */
  rows: number;
  /** Rows the books do not have yet. */
  new_rows: number;
  duplicates: number;
  /** Stripe payouts booked (or, on a dry run, to book) as transfers out of Stripe clearing. */
  stripe_payouts: number;
  /** Rows set aside because wise-reconcile already recorded them as invoice payments. */
  invoice_payments: number;
  /** Debits linked to an expense or bill already on the books (nothing new posted). */
  matched_expenses: number;
  /** Conversion legs booked through Currency exchange clearing. */
  conversions: number;
  /** Rows held because the opening balance already contains them. */
  before_opening: number;
  /** Rows held for a founder: several possible expenses, or a payout/conversion the feed could not book. */
  needs_review: number;
  inserted: number;
  /** Rows now on the books: categorised by a rule, booked by the feed, or linked to an existing expense. */
  posted: number;
  import_id: string | null;
  errors: string[];
};

export type WiseSyncResult = { dry_run: boolean; since: string; until: string; days: number; currencies: WiseSyncCurrency[]; notes: string[] };

type Outcome = "invoice_payment" | "matched_expense" | "stripe_payout" | "conversion" | "before_opening" | "needs_review";

function outcomeOf(r: FeedResolution): Outcome {
  switch (r.kind) {
    case "invoice_payment":
      return "invoice_payment";
    case "bill":
      return "matched_expense";
    case "stripe_payout":
      return "stripe_payout";
    case "conversion":
      return "conversion";
    case "before_opening":
      return "before_opening";
    default:
      return "needs_review";
  }
}

function holdNote(r: FeedResolution): string | null {
  switch (r.kind) {
    case "bill_ambiguous":
      return `${DECIDE_NOTE}this could be ${r.bills.map((b) => b.label).join(" or ")}, already on the books. Exclude this line if it is one of them; categorise it only if it is not.`;
    case "bill_parts":
      return `${DECIDE_NOTE}this and other Wise payments add up exactly to ${r.bills.map((b) => `${b.label}, ${centsToDecimal(b.totalCents)} ${b.currency}`).join(" or ")}, already on the books as one amount. Exclude this line if it is part of it; categorise it only if it is not.`;
    case "before_opening":
      return `${OPENING_NOTE}dated on or before the opening balance of ${r.openingDate}, which was posted before this line arrived, so that balance already contains it. Re-post the opening balance on the Wise card, then sync again to book it on its own.`;
    case "conversion_unpaired":
      return `${DECIDE_NOTE}${r.reason}.`;
    default:
      return null;
  }
}

/** Import Wise activity since a date (or over the last `days`). Writes only when `dryRun` is exactly false. */
export async function syncWiseFeed(viewer: FinanceViewer, raw: Record<string, unknown>, opts: { dryRun: boolean }): Promise<WiseSyncResult> {
  if (opts.dryRun === false && !WISE_FEED_WRITES_ENABLED) throw new FinanceInputError(WISE_FEED_OFF_MESSAGE);
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const today = torontoToday();
  const { since, days } = sinceDate(raw, today);
  const dryRun = opts.dryRun !== false;
  const actor = viewerLabel(viewer);
  const acct = feedAccounts(entity.id);
  const chequing = acct.chequing;
  const { payouts, note } = await stripePayoutsSince(since);
  const result: WiseSyncResult = { dry_run: dryRun, since, until: today, days, currencies: [], notes: note ? [note] : [] };

  // 1. What Wise holds. A Toronto day starts after 00:00 UTC, so the first UTC hours can carry the day before; keep the window's own days only.
  const fetched: string[] = [];
  const allRows: WiseFeedRow[] = [];
  for (const cur of FEED_CURRENCIES) {
    let statement: unknown;
    try {
      statement = await wiseStatement(cur, `${since}T00:00:00.000Z`, new Date().toISOString());
    } catch (e) {
      if (e instanceof WiseNotReady && e.code === "wise_no_balance") {
        result.notes.push(e.message);
        continue;
      }
      throw e;
    }
    fetched.push(cur);
    allRows.push(...feedRowsFromStatement(statement, cur).filter((r) => r.postedDate >= since));
  }
  const tagged = tagStripePayouts(allRows, payouts);
  const rows = tagged.rows;
  const rowByFitid = new Map(rows.map((r) => [r.fitid, r]));

  // 2. What the books already hold, and what the feed will do with each line before any rule can.
  if (!dryRun) await reopenVoidedLinks(entity.id, chequing, actor);
  let lines = await feedLines(entity.id, chequing, rows.map((r) => r.fitid));
  const [recorded, openings, bills] = await Promise.all([
    recordedRefs(entity.id, rows.filter((r) => r.amountCents > 0).map((r) => r.ref)),
    activeOpenings(entity.id, chequing),
    billCandidates(entity.id, chequing, addDays(since, -BILL_MATCH_WINDOW_DAYS), addDays(today, BILL_MATCH_WINDOW_DAYS)),
  ]);
  const plan = planFeed({
    rows,
    payouts: tagged.byFitid,
    recordedDepositRefs: recorded,
    lines: new Map([...lines].map(([k, v]) => [k, { status: v.status, entryId: v.entry_id, createdAt: v.created_at }])),
    openings: openingMarks(openings),
    bills,
  });

  // 3. Import, holding back from the rules every NEW line the feed resolves itself.
  const byCurrency = new Map<string, WiseSyncCurrency>();
  for (const cur of fetched) {
    const entry: WiseSyncCurrency = {
      currency: cur,
      rows: 0,
      new_rows: 0,
      duplicates: 0,
      stripe_payouts: 0,
      invoice_payments: 0,
      matched_expenses: 0,
      conversions: 0,
      before_opening: 0,
      needs_review: 0,
      inserted: 0,
      posted: 0,
      import_id: null,
      errors: [],
    };
    result.currencies.push(entry);
    byCurrency.set(cur, entry);
    const curRows = rows.filter((r) => r.currency === cur);
    entry.rows = curRows.length;
    if (curRows.length === 0) continue;
    const args = { accountId: chequing, filename: `wise-${cur}-${since}-to-${today}.ofx`, text: feedRowsToOfx(curRows, cur) };
    const preview = await previewImport(viewer, entity.id, args);
    entry.duplicates = preview.duplicates;
    entry.new_rows = preview.total - preview.duplicates;
    entry.errors = preview.errors;
    if (dryRun || entry.new_rows === 0) continue;
    const hold = new Set(curRows.filter((r) => !lines.has(r.fitid) && plan.has(r.fitid)).map((r) => r.fitid));
    const committed = await commitImport(viewer, entity.id, args, { hold });
    entry.inserted = committed.inserted;
    entry.posted = committed.posted;
    entry.import_id = committed.importId;
    entry.errors = committed.errors;
  }

  const count = (fitid: string, what: Outcome) => {
    const e = byCurrency.get(rowByFitid.get(fitid)?.currency || "");
    if (!e) return;
    if (what === "invoice_payment") e.invoice_payments += 1;
    else if (what === "matched_expense") e.matched_expenses += 1;
    else if (what === "stripe_payout") e.stripe_payouts += 1;
    else if (what === "conversion") e.conversions += 1;
    else if (what === "before_opening") e.before_opening += 1;
    else e.needs_review += 1;
    if (what === "matched_expense" || what === "stripe_payout" || what === "conversion") e.posted += 1;
  };

  const billWindow = { from: addDays(since, -BILL_MATCH_WINDOW_DAYS), to: addDays(today, BILL_MATCH_WINDOW_DAYS) };
  if (dryRun) {
    // A payout the sync would hold (Stripe clearing does not cover it) is previewed as held, not as booked.
    const taken = new Map<string, number>();
    for (const [fitid, r] of plan) {
      if (r.kind === "stripe_payout") {
        const row = rowByFitid.get(fitid) as WiseFeedRow;
        const cur = (r.payout.settlementCurrency || "").toUpperCase();
        const clearing = cur ? (await stripeClearingCents(entity.id, acct.stripeClearing, cur)) - (taken.get(cur) || 0) : undefined;
        if (stripePayoutBlocker(row, r.payout, clearing)) {
          count(fitid, "needs_review");
          continue;
        }
        if (row.amountCents > 0) taken.set(cur, (taken.get(cur) || 0) + Math.abs(r.payout.settlementCents as number) + Math.max(0, r.payout.feeCents || 0));
      }
      count(fitid, outcomeOf(r));
    }
    const doubles = await possibleDoubleNotes(entity.id, chequing, billWindow.from, billWindow.to);
    withNotes(result).notes.push(...doubles);
    return result;
  }

  // 4. Resolve. Lines re-read after the import; a line someone booked in the meantime is left alone.
  lines = await feedLines(entity.id, chequing, [...rowByFitid.keys()]);
  const isOpen = (l: FeedLine | undefined): l is FeedLine => !!l && l.status === "unreviewed" && !l.entry_id;
  const categories = new Set(
    (
      await query<{ id: string }>(`SELECT id FROM fin_categories WHERE entity_id = ? AND id IN (?, ?)`, [
        entity.id,
        categoryId(entity.id, SYS.stripeClearing),
        categoryId(entity.id, SYS.fxClearing),
      ])
    ).map((c) => c.id),
  );
  const cat = (code: string) => (categories.has(categoryId(entity.id, code)) ? categoryId(entity.id, code) : null);
  const notes: InStatement[] = [];
  /** Lines this pass booked, linked, set aside or noted; a planned line in none of these did not happen. */
  const handled = new Set<string>();
  const setNote = (l: FeedLine, text: string) => {
    handled.add(l.id);
    if (l.memo === text) return;
    notes.push({ sql: `UPDATE fin_bank_transactions SET memo = ? WHERE id = ? AND status = 'unreviewed' AND entry_id IS NULL`, args: [text.slice(0, 500), l.id] });
  };
  let changed = false;
  const fail = (fitid: string, l: FeedLine, e: unknown) => {
    const message = e instanceof Error ? e.message.slice(0, 300) : "failed";
    console.error("[finances:wise-feed] could not book", fitid, message);
    byCurrency.get(rowByFitid.get(fitid)?.currency || "")?.errors.push(`${fitid}: ${message}`);
    setNote(l, `${DECIDE_NOTE}could not be booked automatically (${message}).`);
    count(fitid, "needs_review");
  };

  for (const [fitid, res] of plan) {
    const line = lines.get(fitid);
    if (!isOpen(line)) continue;
    const row = rowByFitid.get(fitid) as WiseFeedRow;
    try {
      if (res.kind === "invoice_payment") {
        const r = await writeBatch([
          {
            sql: `UPDATE fin_bank_transactions SET status = 'excluded', memo = ?
                   WHERE id = ? AND status IN ('unreviewed', 'draft') AND entry_id IS NULL`,
            args: ["Already recorded as an invoice payment (Wise reconcile)", line.id],
          },
        ]);
        if (r[0]?.rowsAffected === 1) {
          count(fitid, "invoice_payment");
          handled.add(line.id);
          changed = true;
        }
      } else if (res.kind === "bill") {
        const r = await writeBatch(
          linkLineToEntryStatements({
            entityId: entity.id,
            txnId: line.id,
            entryId: res.bill.entryId,
            categoryId: res.bill.categoryId,
            memo: `Matched to ${res.bill.label}, already on the books; nothing new was posted.`,
            actor,
            detail: { bill: res.bill.id, fitid },
          }),
        );
        if (r[0]?.rowsAffected === 1) {
          count(fitid, "matched_expense");
          handled.add(line.id);
          changed = true;
        }
      } else if (res.kind === "stripe_payout") {
        const p = res.payout;
        const settleCur = (p.settlementCurrency || "").toUpperCase();
        const clearing = settleCur ? await stripeClearingCents(entity.id, acct.stripeClearing, settleCur) : undefined;
        const holdPayout = (reason: string) => {
          setNote(line, `${DECIDE_NOTE}Stripe payout ${p.id} recognised but not booked: ${reason}. It is a transfer, never revenue: do not categorise it by hand; a later sync books it once that is resolved.`);
          count(fitid, "needs_review");
        };
        const blocked = stripePayoutBlocker(row, p, clearing);
        if (blocked) {
          holdPayout(blocked);
          continue;
        }
        const usdDays = row.currency === "USD" || settleCur === "USD" ? [row.postedDate] : [];
        const rates = await ratesFor(usdDays);
        const built = stripePayoutLines(row, p, acct, cadOfWith(rates), clearing);
        if (!built.ok) {
          holdPayout(built.reason);
          continue;
        }
        const settled = p.settlementCurrency && p.settlementCurrency !== row.currency ? ` (Stripe settled ${centsToDecimal(Math.abs(p.settlementCents as number))} ${p.settlementCurrency})` : "";
        const posting = await buildLinePosting({
          txn: { id: line.id, entity_id: entity.id, posted_date: row.postedDate, description: line.description },
          lines: built.lines,
          categoryId: cat(SYS.stripeClearing),
          memo: `Stripe payout ${p.id}: a transfer out of Stripe clearing, not revenue${settled}.`,
          actor,
          fixedRates: rates.get(row.postedDate) ? { USD: (rates.get(row.postedDate) as { rate: string }).rate } : undefined,
          detail: { payout: p.id, fx_cents: built.fxCents, fitid },
        });
        const r = await writeBatch([...posting.posting, ...posting.link]);
        if (r[posting.posting.length]?.rowsAffected === 1) {
          count(fitid, "stripe_payout");
          handled.add(line.id);
          changed = true;
        }
      } else if (res.kind === "conversion") {
        if (fitid !== res.debit.fitid) continue; // booked together with its debit leg
        const debitLine = lines.get(res.debit.fitid);
        const creditLine = lines.get(res.credit.fitid);
        if (!isOpen(debitLine) || !isOpen(creditLine)) continue;
        const usdDays = [res.debit, res.credit].filter((l) => l.currency === "USD").map((l) => l.postedDate);
        const rates = await ratesFor(usdDays);
        const legs = conversionLegLines(res.debit, res.credit, acct, cadOfWith(rates));
        const memo = `Wise conversion ${res.debit.ref}: ${res.debit.currency} to ${res.credit.currency}, through Currency exchange clearing.`;
        const fixed = (d: string) => (rates.get(d) ? { USD: (rates.get(d) as { rate: string }).rate } : undefined);
        const both = [debitLine.id, creditLine.id];
        const d = await buildLinePosting({
          txn: { id: debitLine.id, entity_id: entity.id, posted_date: res.debit.postedDate, description: debitLine.description },
          lines: legs.debitLeg,
          categoryId: cat(SYS.fxClearing),
          memo,
          actor,
          fixedRates: fixed(res.debit.postedDate),
          together: both,
          detail: { conversion: res.debit.ref, leg: "debit" },
        });
        const c = await buildLinePosting({
          txn: { id: creditLine.id, entity_id: entity.id, posted_date: res.credit.postedDate, description: creditLine.description },
          lines: legs.creditLeg,
          categoryId: cat(SYS.fxClearing),
          memo: `${memo} Wise fee ${centsToDecimal(legs.feeCadCents)} CAD to Bank fees, rate difference ${centsToDecimal(legs.fxCents)} CAD to FX gain/loss.`,
          actor,
          fixedRates: fixed(res.credit.postedDate),
          together: both,
          detail: { conversion: res.debit.ref, leg: "credit", fee_cad_cents: legs.feeCadCents, fx_cents: legs.fxCents },
        });
        // Both entries are written before either line is marked, so each gate sees both lines still unreviewed.
        const r = await writeBatch([...d.posting, ...c.posting, ...d.link, ...c.link]);
        if (r[d.posting.length + c.posting.length]?.rowsAffected === 1) {
          count(res.debit.fitid, "conversion");
          count(res.credit.fitid, "conversion");
          handled.add(debitLine.id).add(creditLine.id);
          changed = true;
        }
      } else {
        const text = holdNote(res);
        if (text) setNote(line, text);
        count(fitid, outcomeOf(res));
      }
    } catch (e) {
      if (res.kind !== "conversion") fail(fitid, line, e);
      else for (const leg of [res.debit, res.credit]) {
        const l = lines.get(leg.fitid);
        if (isOpen(l)) fail(leg.fitid, l, e);
      }
    }
  }
  // A planned line whose booking did not happen (the books changed under this
  // sync: another line took the expense, a gate refused) must not fall to the
  // rules as ordinary money: hold it until the next sync re-plans it.
  for (const fitid of plan.keys()) {
    const l = lines.get(fitid);
    if (!isOpen(l) || handled.has(l.id)) continue;
    setNote(l, `${DECIDE_NOTE}the feed was about to book or match this line but the books changed during the sync; sync again.`);
    count(fitid, "needs_review");
  }
  // A line the feed held earlier but that nothing holds any more (e.g. the opening balance was re-posted) loses the stale note.
  for (const [fitid, l] of lines) if (isOpen(l) && !plan.has(fitid) && isFeedNote(l.memo)) setNote(l, "");
  if (notes.length > 0) {
    const r = await writeBatch(notes);
    if (r.some((x) => x.rowsAffected > 0)) changed = true;
  }

  const inserted = result.currencies.reduce((a, c) => a + c.inserted, 0);
  if (inserted > 0 || changed) {
    await writeBatch([
      auditStatement({
        entityId: entity.id,
        actor,
        action: "wise.feed_synced",
        objectType: "import",
        objectId: null,
        detail: {
          since,
          currencies: result.currencies.map((c) => ({
            currency: c.currency,
            inserted: c.inserted,
            posted: c.posted,
            matched_expenses: c.matched_expenses,
            stripe_payouts: c.stripe_payouts,
            conversions: c.conversions,
            invoice_payments: c.invoice_payments,
            needs_review: c.needs_review,
            before_opening: c.before_opening,
          })),
        },
      }),
    ]);
  }
  const after = [...(await staleOpeningNotes(entity.id, chequing)), ...(await possibleDoubleNotes(entity.id, chequing, billWindow.from, billWindow.to))];
  withNotes(result).notes.push(...after);
  return result;
}

function withNotes(result: WiseSyncResult): WiseSyncResult {
  const sum = (k: keyof WiseSyncCurrency) => result.currencies.reduce((a, c) => a + (typeof c[k] === "number" ? (c[k] as number) : 0), 0);
  const will = result.dry_run ? "would be " : "";
  const parts: string[] = [];
  if (sum("matched_expenses")) parts.push(`${sum("matched_expenses")} line(s) ${will}matched to expenses already on the books (nothing new posted)`);
  if (sum("invoice_payments")) parts.push(`${sum("invoice_payments")} deposit(s) already recorded against invoices ${will}set aside`);
  if (sum("stripe_payouts")) parts.push(`${sum("stripe_payouts")} Stripe payout(s) ${will}booked as transfers out of Stripe clearing`);
  if (sum("conversions")) parts.push(`${sum("conversions") / 2} currency conversion(s) ${will}booked through Currency exchange clearing`);
  if (sum("needs_review")) parts.push(`${sum("needs_review")} line(s) need your review (their note in Transactions says why)`);
  if (sum("before_opening")) {
    parts.push(`${sum("before_opening")} line(s) dated on or before the opening balance arrived after it: re-post the opening balance, then sync again`);
  }
  if (parts.length > 0) result.notes.push(`${parts.join("; ")}.`);
  return result;
}

// ── opening balance ──────────────────────────────────────────────────────

export type OpeningBalanceAction = "none" | "keep" | "post" | "replace" | "remove";

export type OpeningBalanceLine = {
  currency: string;
  /** Wise's balance at the end of the day. */
  wise_cents: number;
  /**
   * 1000 Business chequing in that currency as it stands once every fed line
   * dated on or before the day is booked, WITHOUT any opening balance: the
   * ledger (a reversed entry and its reversal left out: a void counts as never
   * booked), plus fed lines not yet posted, with a line matched to an expense
   * dated on the other side of the day counted on the bank's date.
   */
  books_cents: number;
  /** The fed lines on or before the day that are not in the ledger yet (inside books_cents). */
  pending_cents: number;
  pending_lines: number;
  /** Fed lines on or before the day the feed held for a founder's decision (they may already be on the books). Any -> no posting. */
  undecided_lines: number;
  /** The opening balance chequing needs: wise - books. */
  difference_cents: number;
  /** The opening balance in force for this currency (the newest, if older data holds several). */
  existing: { entry_id: string; date: string; cents: number } | null;
  /** keep: already right. post: none yet. replace: reverse the one in force, post this. remove: reverse it; none is needed. */
  action: OpeningBalanceAction;
  /** The entry this call posted (post / replace). */
  entry_id: string | null;
};

async function bookSide(
  entityId: string,
  chequing: string,
  currency: string,
  date: string,
  withoutEntries: string[],
): Promise<{ books: number; pending: number; pendingLines: number; undecided: number }> {
  const skip = withoutEntries.length > 0 ? withoutEntries : [""];
  // A reversed entry and its reversal count as never having happened, whatever
  // their dates: a void (bills-io dates its reversal the day of the void)
  // otherwise leaves the voided amount inside the balance for good once the
  // reversal lands after the day.
  const ledger = await queryOne<{ n: number | null }>(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
       FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
      WHERE l.entity_id = ? AND l.account_id = ? AND l.currency = ? AND e.entry_date <= ?
        AND e.status = 'posted' AND e.source <> 'reversal' AND e.id NOT IN (${skip.map(() => "?").join(",")})`,
    [entityId, chequing, currency, date, ...skip],
  );
  // Fed lines the ledger does not hold yet: unreviewed, or linked to an expense that has since been voided.
  const pending = await queryOne<{ n: number | null; c: number | null }>(
    `SELECT COALESCE(SUM(t.amount_cents), 0) AS n, COUNT(*) AS c FROM fin_bank_transactions t
      WHERE t.entity_id = ? AND t.account_id = ? AND t.currency = ? AND t.fitid LIKE ? AND t.posted_date <= ?
        AND ((t.status IN ('unreviewed', 'draft') AND t.entry_id IS NULL)
          OR (t.status = 'posted' AND EXISTS (SELECT 1 FROM fin_journal_entries x WHERE x.id = t.entry_id AND x.source <> ? AND x.status = 'reversed')))`,
    [entityId, chequing, currency, FED, date, REGISTER_ENTRY_SOURCE],
  );
  // A line linked to an expense moves chequing on the EXPENSE's date; Wise moved on the line's. Count it on the bank's side of the day.
  const timing = await queryOne<{ n: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN t.posted_date <= ? THEN t.amount_cents ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN x.entry_date <= ? THEN t.amount_cents ELSE 0 END), 0) AS n
       FROM fin_bank_transactions t JOIN fin_journal_entries x ON x.id = t.entry_id
      WHERE t.entity_id = ? AND t.account_id = ? AND t.currency = ? AND t.fitid LIKE ? AND t.status = 'posted'
        AND x.source <> ? AND x.status = 'posted'`,
    [date, date, entityId, chequing, currency, FED, REGISTER_ENTRY_SOURCE],
  );
  // A line held for a decision could be money already on the books or new money: counting it either way could be wrong.
  const undecided = await queryOne<{ c: number | null }>(
    `SELECT COUNT(*) AS c FROM fin_bank_transactions
      WHERE entity_id = ? AND account_id = ? AND currency = ? AND fitid LIKE ? AND posted_date <= ?
        AND status = 'unreviewed' AND entry_id IS NULL AND memo LIKE ?`,
    [entityId, chequing, currency, FED, date, `${DECIDE_NOTE}%`],
  );
  const p = n(pending?.n);
  return { books: n(ledger?.n) + p + n(timing?.n), pending: p, pendingLines: n(pending?.c), undecided: n(undecided?.c) };
}

function actionFor(existing: ActiveOpening[], date: string, difference: number): OpeningBalanceAction {
  if (existing.length === 0) return difference === 0 ? "none" : "post";
  if (existing.length === 1 && existing[0].date === date && existing[0].cents === difference) return "keep";
  return difference === 0 ? "remove" : "replace";
}

/**
 * Make 1000 Business chequing equal the real Wise balance at the end of
 * `date`, per currency, with exactly one opening balance in force per
 * currency. A dry run (the default) returns the numbers and what posting
 * would do; `dry_run: false` posts, replaces or removes accordingly.
 */
export type OpeningBalanceResult = {
  date: string;
  dry_run: boolean;
  lines: OpeningBalanceLine[];
  /** Why nothing can be posted for this day yet (lines waiting for a founder's decision), or null. */
  blocked: string | null;
};

export async function postWiseOpeningBalance(viewer: FinanceViewer, raw: Record<string, unknown>, opts: { dryRun: boolean }): Promise<OpeningBalanceResult> {
  if (opts.dryRun === false && !WISE_FEED_WRITES_ENABLED) throw new FinanceInputError(WISE_FEED_OFF_MESSAGE);
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const date = String(raw.date ?? "").trim();
  if (!isIsoDate(date)) throw new FinanceInputError("choose the date the opening balance is for (YYYY-MM-DD)");
  if (date > torontoToday()) throw new FinanceInputError("an opening balance cannot be dated in the future");
  const dryRun = opts.dryRun !== false;
  const chequing = accountId(entity.id, SYS.chequing);
  const openings = await activeOpenings(entity.id, chequing);
  const { fromIso, toIso } = intervalAround(date);
  const lines: OpeningBalanceLine[] = [];
  for (const cur of FEED_CURRENCIES) {
    let statement: unknown;
    try {
      statement = await wiseStatement(cur, fromIso, toIso);
    } catch (e) {
      if (e instanceof WiseNotReady && e.code === "wise_no_balance") continue;
      throw e;
    }
    const wise = balanceAtEndOf(statement, date);
    if (wise === null) throw new FinanceInputError(`Wise did not report a ${cur} balance for ${date}`);
    const existing = openings.get(cur) || [];
    const side = await bookSide(entity.id, chequing, cur, date, existing.map((o) => o.id));
    const difference = wise - side.books;
    lines.push({
      currency: cur,
      wise_cents: wise,
      books_cents: side.books,
      pending_cents: side.pending,
      pending_lines: side.pendingLines,
      undecided_lines: side.undecided,
      difference_cents: difference,
      existing: existing[0] ? { entry_id: existing[0].id, date: existing[0].date, cents: existing[0].cents } : null,
      action: actionFor(existing, date, difference),
      entry_id: null,
    });
  }
  const undecided = lines.reduce((a, l) => a + l.undecided_lines, 0);
  const blocked =
    undecided > 0
      ? `${undecided} Wise line(s) on or before ${date} are waiting for your decision (each may already be on the books; its note in Transactions says why). Resolve them, then post the opening balance.`
      : null;
  if (dryRun) return { date, dry_run: true, lines, blocked };
  if (blocked) throw new FinanceInputError(blocked);
  const createdBy = viewerLabel(viewer);
  const retained = accountId(entity.id, SYS.retained);
  // Every currency in one batch: the books never hold a CAD opening without its USD one.
  const statements: InStatement[] = [];
  for (const line of lines) {
    if (line.action === "none" || line.action === "keep") continue;
    const cur = line.currency;
    const old = openings.get(cur) || [];
    for (const o of old) {
      // Reversed at its OWN date, so on every day the pair nets to zero and the history never shows two.
      const rev = await buildReversal({ entityId: entity.id, entryId: o.id, date: o.date, memo: `Opening balance (${cur}, ${o.date}) replaced by one for ${date}`, createdBy });
      statements.push(...rev.statements);
    }
    if (line.action === "post" || line.action === "replace") {
      const diff = line.difference_cents;
      const amount = Math.abs(diff);
      const generation = await queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM fin_journal_entries WHERE entity_id = ? AND source = ? AND source_ref LIKE ?`,
        [entity.id, OPENING_BALANCE_SOURCE, `wise:${cur}:%`],
      );
      const posting = await buildPosting({
        entityId: entity.id,
        entryDate: date,
        memo: `Opening balance: Business chequing to the Wise ${cur} balance at the end of ${date}`,
        source: OPENING_BALANCE_SOURCE,
        // A generation, not the date: two posts racing on any dates collide here, so only one can be in force.
        sourceRef: `wise:${cur}:${n(generation?.c) + 1}`,
        createdBy,
        lines:
          diff > 0
            ? [
                { accountId: chequing, currency: cur, debitCents: amount, memo: "Opening balance (Wise)" },
                { accountId: retained, currency: cur, creditCents: amount, memo: "Opening balance (Wise)" },
              ]
            : [
                { accountId: retained, currency: cur, debitCents: amount, memo: "Opening balance (Wise)" },
                { accountId: chequing, currency: cur, creditCents: amount, memo: "Opening balance (Wise)" },
              ],
      });
      statements.push(...posting.statements);
      line.entry_id = posting.entryId;
    }
    statements.push(
      auditStatement({
        entityId: entity.id,
        actor: createdBy,
        action: line.action === "post" ? "wise.opening_balance" : line.action === "replace" ? "wise.opening_balance_replaced" : "wise.opening_balance_removed",
        objectType: "journal_entry",
        objectId: line.entry_id ?? old[0]?.id ?? null,
        detail: {
          currency: cur,
          date,
          wise: line.wise_cents,
          books: line.books_cents,
          pending: line.pending_cents,
          cents: line.difference_cents,
          replaced: old.map((o) => ({ entry: o.id, date: o.date, cents: o.cents })),
        },
      }),
    );
  }
  if (statements.length === 0) return { date, dry_run: false, lines, blocked: null };
  try {
    await writeBatch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) throw new FinanceInputError("the opening balance changed while you were posting it; preview again, then post");
    throw e;
  }
  return { date, dry_run: false, lines, blocked: null };
}
