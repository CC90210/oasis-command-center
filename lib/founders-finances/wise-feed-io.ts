/**
 * The Wise bank feed: Wise balance activity -> the business book's register
 * on 1000 Business chequing (Wise IS the business bank account), plus the
 * founder-triggered opening balance that makes chequing equal Wise on a day.
 *
 * SYNC reuses the statement import (transactions-io.ts previewImport /
 * commitImport) with an OFX rendering of the statement (wise-feed.ts), so the
 * dedupe hash, the rules and the import history are the upload's own. Rows
 * land UNREVIEWED unless a rule matches — exactly like an uploaded statement.
 * A re-sync is a no-op: every FITID is already there, so nothing is committed
 * (not even an empty import record). USD rows post at the stored own-day
 * Bank of Canada rate, through the same buildPosting every entry uses.
 *
 * TWO WRITERS, ONE DEPOSIT. A client's Wise payment can be recorded against
 * its invoice by wise-reconcile.ts (settlement entry, source wise_payment)
 * and also arrive here as a bank line. Whichever lands second is set aside:
 * a feed line for a deposit reconcile already recorded is imported as
 * EXCLUDED with a note, and reconcile excludes an unreviewed feed line when it
 * records. The ledger holds the money once.
 *
 * OPENING BALANCE: the business book has no opening-balance mechanism of its
 * own (the personal books have "Net worth (opening balance)"; the business
 * chart's equity is owner equity, draws and retained earnings), so it posts
 * through buildPosting — the ledger's one writer — against 3900 Retained
 * earnings, one entry per currency, source "opening_balance" with source_ref
 * wise:<currency>:<date> (unique, so the same date cannot be posted twice).
 * It is never automatic: only an explicit founder action (or a non-dry-run
 * call) posts it, and the preview shows every number first.
 */
import "server-only";

import { accountId, BUSINESS_ENTITY_ID, SYS } from "./chart";
import { addDays, isIsoDate, torontoToday } from "./fx";
import { viewerLabel, type FinanceViewer } from "./access";
import { auditStatement, isUniqueViolation, queryOne, writeBatch, type InStatement } from "./db";
import { FinanceInputError, requireEntity } from "./access-io";
import { buildPosting } from "./ledger-io";
import { commitImport, previewImport } from "./transactions-io";
import { getStripeClient, listAll, StripeNotReady } from "./stripe-io";
import { balanceAtEndOf, feedRowsFromStatement, feedRowsToOfx, intervalAround, tagStripePayouts, wiseFitid, WISE_FEED_OFF_MESSAGE, WISE_FEED_WRITES_ENABLED, type StripePayoutLite, type WiseFeedRow } from "./wise-feed";
import { wiseStatement, WiseNotReady } from "./wise-io";
import { recordedRefs } from "./wise-reconcile";

const FEED_CURRENCIES = ["CAD", "USD"] as const;
/** Wise statements span at most 469 days. */
const MAX_DAYS = 460;
export const OPENING_BALANCE_SOURCE = "opening_balance";

function sinceDate(raw: Record<string, unknown>, today: string): { since: string; days: number } {
  if (raw.since !== undefined && raw.since !== null && raw.since !== "") {
    const since = String(raw.since).trim();
    if (!isIsoDate(since)) throw new FinanceInputError("since must be a date (YYYY-MM-DD)");
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000);
    if (days < 0) throw new FinanceInputError("since cannot be in the future");
    if (days > MAX_DAYS) throw new FinanceInputError(`Wise statements reach back at most ${MAX_DAYS} days per sync`);
    return { since, days };
  }
  const n = typeof raw.days === "number" ? raw.days : typeof raw.days === "string" && raw.days.trim() ? Number(raw.days) : 30;
  const days = Number.isFinite(n) ? Math.max(1, Math.min(MAX_DAYS, Math.trunc(n))) : 30;
  return { since: addDays(today, -days), days };
}

/** Stripe payouts arriving on or after `since` (minus a few days' slack). Null + a reason when Stripe cannot be asked. */
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
    const { items, truncated } = await listAll(client.key, "/v1/payouts", { "arrival_date[gte]": from }, { maxPages: 10 });
    const payouts = items
      .filter((p) => (p.status === "paid" || p.status === "in_transit") && typeof p.id === "string" && typeof p.amount === "number" && typeof p.arrival_date === "number")
      .map((p) => ({
        id: p.id as string,
        amountCents: p.amount as number,
        currency: String(p.currency || "").toUpperCase(),
        arrivalDate: new Date((p.arrival_date as number) * 1000).toISOString().slice(0, 10),
      }));
    return { payouts, note: truncated ? "More Stripe payouts than one sync reads; the oldest may not be recognised." : null };
  } catch (e) {
    console.error("[finances:wise-feed] stripe payouts", e instanceof Error ? e.message : e);
    return { payouts: [], note: `Stripe payouts could not be read (${e instanceof Error ? e.message.slice(0, 160) : "error"}); payout deposits are imported unreviewed.` };
  }
}

export type WiseSyncCurrency = {
  currency: string;
  /** Wise rows in the window. */
  rows: number;
  /** Rows the books do not have yet. */
  new_rows: number;
  duplicates: number;
  /** Rows recognised as Stripe payouts (booked as transfers from Stripe clearing by the seeded rule). */
  stripe_payouts: number;
  /** Rows set aside because wise-reconcile already recorded them as invoice payments. */
  invoice_payments: number;
  inserted: number;
  /** Inserted rows a rule categorised and posted. */
  posted: number;
  import_id: string | null;
  errors: string[];
};

export type WiseSyncResult = { dry_run: boolean; since: string; until: string; days: number; currencies: WiseSyncCurrency[]; notes: string[] };

/** Import Wise activity since a date (or over the last `days`). Writes only when `dryRun` is exactly false. */
export async function syncWiseFeed(viewer: FinanceViewer, raw: Record<string, unknown>, opts: { dryRun: boolean }): Promise<WiseSyncResult> {
  if (opts.dryRun === false && !WISE_FEED_WRITES_ENABLED) throw new FinanceInputError(WISE_FEED_OFF_MESSAGE);
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const today = torontoToday();
  const { since, days } = sinceDate(raw, today);
  const dryRun = opts.dryRun !== false;
  const chequing = accountId(entity.id, SYS.chequing);
  const { payouts, note } = await stripePayoutsSince(since);
  const result: WiseSyncResult = { dry_run: dryRun, since, until: today, days, currencies: [], notes: note ? [note] : [] };
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
    // A Toronto day starts after 00:00 UTC, so the first UTC hours can carry the day before; keep the window's own days only.
    const rows = feedRowsFromStatement(statement, cur).filter((r) => r.postedDate >= since);
    const tagged = tagStripePayouts(rows, payouts);
    const invoicePaid = await recordedRefs(entity.id, tagged.rows.filter((r) => r.amountCents > 0).map((r) => r.ref));
    const entry: WiseSyncCurrency = {
      currency: cur,
      rows: rows.length,
      new_rows: 0,
      duplicates: 0,
      stripe_payouts: tagged.tagged,
      invoice_payments: 0,
      inserted: 0,
      posted: 0,
      import_id: null,
      errors: [],
    };
    result.currencies.push(entry);
    if (rows.length === 0) continue;
    const args = { accountId: chequing, filename: `wise-${cur}-${since}-to-${today}.ofx`, text: feedRowsToOfx(tagged.rows, cur) };
    const preview = await previewImport(viewer, entity.id, args);
    entry.duplicates = preview.duplicates;
    entry.new_rows = preview.total - preview.duplicates;
    entry.errors = preview.errors;
    if (dryRun || entry.new_rows === 0) {
      entry.invoice_payments = tagged.rows.filter((r: WiseFeedRow) => r.amountCents > 0 && invoicePaid.has(r.ref)).length;
      continue;
    }
    const committed = await commitImport(viewer, entity.id, args);
    entry.inserted = committed.inserted;
    entry.posted = committed.posted;
    entry.import_id = committed.importId;
    entry.errors = committed.errors;
    const setAside = tagged.rows.filter((r) => r.amountCents > 0 && invoicePaid.has(r.ref));
    if (setAside.length > 0) {
      const results = await writeBatch(
        setAside.map((r) => ({
          sql: `UPDATE fin_bank_transactions SET status = 'excluded', memo = ?
                 WHERE entity_id = ? AND account_id = ? AND fitid = ? AND status IN ('unreviewed', 'draft') AND entry_id IS NULL`,
          args: ["Already recorded as an invoice payment (Wise reconcile)", entity.id, chequing, wiseFitid(cur, "CREDIT", r.ref)],
        })),
      );
      entry.invoice_payments = results.filter((x) => x.rowsAffected === 1).length;
    }
  }
  if (!dryRun) {
    await writeBatch([
      auditStatement({
        entityId: entity.id,
        actor: viewerLabel(viewer),
        action: "wise.feed_synced",
        objectType: "import",
        objectId: null,
        detail: { since, currencies: result.currencies.map((c) => ({ currency: c.currency, inserted: c.inserted, posted: c.posted })) },
      }),
    ]);
  }
  return result;
}

// ── opening balance ──────────────────────────────────────────────────────

export type OpeningBalanceLine = {
  currency: string;
  /** Wise's balance at the end of the day. */
  wise_cents: number;
  /** 1000 Business chequing in that currency, every entry dated on or before the day. */
  books_cents: number;
  difference_cents: number;
  entry_id: string | null;
};

async function chequingNativeBalance(entityId: string, currency: string, date: string): Promise<number> {
  const row = await queryOne<{ n: number | null }>(
    `SELECT SUM(l.debit_cents - l.credit_cents) AS n
       FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
      WHERE l.entity_id = ? AND l.account_id = ? AND l.currency = ? AND e.entry_date <= ?`,
    [entityId, accountId(entityId, SYS.chequing), currency, date],
  );
  return Number(row?.n ?? 0);
}

/**
 * Make 1000 Business chequing equal the real Wise balance at the end of
 * `date`, per currency. A dry run (the default) returns the numbers and posts
 * nothing; `dry_run: false` posts one entry per currency that differs.
 */
export async function postWiseOpeningBalance(viewer: FinanceViewer, raw: Record<string, unknown>, opts: { dryRun: boolean }): Promise<{ date: string; dry_run: boolean; lines: OpeningBalanceLine[] }> {
  if (opts.dryRun === false && !WISE_FEED_WRITES_ENABLED) throw new FinanceInputError(WISE_FEED_OFF_MESSAGE);
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const date = String(raw.date ?? "").trim();
  if (!isIsoDate(date)) throw new FinanceInputError("choose the date the opening balance is for (YYYY-MM-DD)");
  if (date > torontoToday()) throw new FinanceInputError("an opening balance cannot be dated in the future");
  const dryRun = opts.dryRun !== false;
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
    const books = await chequingNativeBalance(entity.id, cur, date);
    lines.push({ currency: cur, wise_cents: wise, books_cents: books, difference_cents: wise - books, entry_id: null });
  }
  if (dryRun) return { date, dry_run: true, lines };
  const createdBy = viewerLabel(viewer);
  const chequing = accountId(entity.id, SYS.chequing);
  const retained = accountId(entity.id, SYS.retained);
  // Every currency in one batch: the books never hold a CAD opening without its USD one.
  const statements: InStatement[] = [];
  for (const line of lines) {
    const diff = line.difference_cents;
    if (diff === 0) continue;
    const amount = Math.abs(diff);
    const posting = await buildPosting({
      entityId: entity.id,
      entryDate: date,
      memo: `Opening balance: Business chequing to the Wise ${line.currency} balance at the end of ${date}`,
      source: OPENING_BALANCE_SOURCE,
      sourceRef: `wise:${line.currency}:${date}`,
      createdBy,
      lines:
        diff > 0
          ? [
              { accountId: chequing, currency: line.currency, debitCents: amount, memo: "Opening balance (Wise)" },
              { accountId: retained, currency: line.currency, creditCents: amount, memo: "Opening balance (Wise)" },
            ]
          : [
              { accountId: retained, currency: line.currency, debitCents: amount, memo: "Opening balance (Wise)" },
              { accountId: chequing, currency: line.currency, creditCents: amount, memo: "Opening balance (Wise)" },
            ],
    });
    statements.push(
      ...posting.statements,
      auditStatement({
        entityId: entity.id,
        actor: createdBy,
        action: "wise.opening_balance",
        objectType: "journal_entry",
        objectId: posting.entryId,
        detail: { currency: line.currency, date, wise: line.wise_cents, books: line.books_cents },
      }),
    );
    line.entry_id = posting.entryId;
  }
  if (statements.length === 0) return { date, dry_run: false, lines };
  try {
    await writeBatch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new FinanceInputError(
        `an opening balance for ${date} was already posted and the books have changed since; reverse that entry before posting another for the same day`,
      );
    }
    throw e;
  }
  return { date, dry_run: false, lines };
}
