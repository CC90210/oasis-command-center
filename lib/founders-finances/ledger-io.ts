/**
 * Posting journal entries. The ONLY writer of fin_journal_entries /
 * fin_journal_lines.
 *
 *   buildPosting()      validates (ledger.ts prepareJournalLines — the one
 *                       balancing function), checks every account belongs to
 *                       the entity, attaches own-day FX, and returns the
 *                       statements WITHOUT running them, so a caller can put
 *                       the entry in the same atomic batch as the change that
 *                       caused it (an invoice status, a payment row).
 *   postJournalEntry()  buildPosting + run it + idempotency on
 *                       (entity, source, source_ref).
 *
 * Optional `gate`: an SQL boolean expression (with args) that must hold for
 * the entry to be inserted — used for compare-and-set flows so a lost race
 * inserts nothing instead of a duplicate. Lines are gated on their entry
 * existing, so a gated-out entry leaves no orphan lines.
 */
import "server-only";

import { prepareJournalLines, reversalLines, LedgerError, type JournalLineInput } from "./ledger";
import { parseRateMicro } from "./fx";
import { isUniqueViolation, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import { rateForCurrency } from "./fx-io";

export type PostingInput = {
  entityId: string;
  entryDate: string;
  memo: string;
  source: string;
  sourceRef: string | null;
  lines: JournalLineInput[];
  createdBy: string;
  /** Pin a currency's CAD rate (e.g. an invoice's recognition rate). */
  fixedRates?: Record<string, string>;
  gate?: { sql: string; args: Array<string | number | null> };
};

export type Posting = { entryId: string; statements: InStatement[] };

export async function buildPosting(input: PostingInput): Promise<Posting> {
  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  if (accountIds.length === 0) throw new LedgerError("too_few_lines", "no lines");
  const placeholders = accountIds.map(() => "?").join(",");
  const owned = await query<{ id: string }>(
    `SELECT id FROM fin_accounts WHERE entity_id = ? AND id IN (${placeholders})`,
    [input.entityId, ...accountIds],
  );
  if (owned.length !== accountIds.length) {
    throw new LedgerError("foreign_account", "a line points at an account outside this book");
  }
  const currencies = [...new Set(input.lines.map((l) => String(l.currency).toUpperCase()))].filter((c) => c !== "CAD");
  const rates = new Map<string, { rate: string; micro: bigint }>();
  for (const c of currencies) {
    const fixed = input.fixedRates?.[c];
    if (fixed) rates.set(c, { rate: fixed, micro: parseRateMicro(fixed) });
    else {
      const r = await rateForCurrency(c, input.entryDate);
      if (r) rates.set(c, r);
    }
  }
  const prepared = prepareJournalLines(input.lines, (c) => rates.get(c) ?? null);
  const entryId = newId("je");
  const gateSql = input.gate ? ` WHERE ${input.gate.sql}` : "";
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO fin_journal_entries (id, entity_id, entry_date, memo, source, source_ref, created_by)
            SELECT ?, ?, ?, ?, ?, ?, ?${gateSql}`,
      args: [
        entryId,
        input.entityId,
        input.entryDate,
        input.memo.slice(0, 500),
        input.source,
        input.sourceRef,
        input.createdBy.slice(0, 200),
        ...(input.gate?.args || []),
      ],
    },
    ...prepared.map((l) => ({
      sql: `INSERT INTO fin_journal_lines
              (id, entry_id, entity_id, line_no, account_id, currency, debit_cents, credit_cents,
               cad_debit_cents, cad_credit_cents, fx_rate, contact_id, memo)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
      args: [
        newId("jl"),
        entryId,
        input.entityId,
        l.lineNo,
        l.accountId,
        l.currency,
        l.debitCents,
        l.creditCents,
        l.cadDebitCents,
        l.cadCreditCents,
        l.fxRate,
        l.contactId,
        l.memo,
        entryId,
      ],
    })),
  ];
  return { entryId, statements };
}

export async function findEntryBySource(entityId: string, source: string, sourceRef: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM fin_journal_entries WHERE entity_id = ? AND source = ? AND source_ref = ?`,
    [entityId, source, sourceRef],
  );
  return row?.id ?? null;
}

/** Post one entry atomically; idempotent on (entity, source, sourceRef). */
export async function postJournalEntry(
  input: PostingInput,
  extra: InStatement[] = [],
): Promise<{ entryId: string; created: boolean }> {
  if (input.sourceRef) {
    const existing = await findEntryBySource(input.entityId, input.source, input.sourceRef);
    if (existing) return { entryId: existing, created: false };
  }
  const posting = await buildPosting(input);
  try {
    await writeBatch([...posting.statements, ...extra]);
  } catch (e) {
    if (input.sourceRef && isUniqueViolation(e)) {
      const existing = await findEntryBySource(input.entityId, input.source, input.sourceRef);
      if (existing) return { entryId: existing, created: false };
    }
    throw e;
  }
  return { entryId: posting.entryId, created: true };
}

export type StoredLine = {
  account_id: string;
  currency: string;
  debit_cents: number;
  credit_cents: number;
  cad_debit_cents: number;
  cad_credit_cents: number;
  fx_rate: string | null;
  memo: string;
  contact_id: string | null;
};

export async function entryLines(entryId: string): Promise<StoredLine[]> {
  return query<StoredLine>(
    `SELECT account_id, currency, debit_cents, credit_cents, cad_debit_cents, cad_credit_cents, fx_rate, memo, contact_id
       FROM fin_journal_lines WHERE entry_id = ? ORDER BY line_no`,
    [entryId],
  );
}

/**
 * Build the reversal of a posted entry, at the ORIGINAL entry's rates so the
 * pair nets to exactly zero in CAD as well as in each currency.
 */
export async function buildReversal(args: {
  entityId: string;
  entryId: string;
  date: string;
  memo: string;
  createdBy: string;
}): Promise<Posting> {
  const lines = await entryLines(args.entryId);
  if (lines.length === 0) throw new LedgerError("missing_entry", "nothing to reverse");
  const fixedRates: Record<string, string> = {};
  for (const l of lines) if (l.currency !== "CAD" && l.fx_rate) fixedRates[l.currency] = l.fx_rate;
  const posting = await buildPosting({
    entityId: args.entityId,
    entryDate: args.date,
    memo: args.memo,
    source: "reversal",
    sourceRef: args.entryId,
    createdBy: args.createdBy,
    fixedRates,
    lines: reversalLines(
      lines.map((l) => ({
        accountId: l.account_id,
        currency: l.currency,
        debitCents: l.debit_cents,
        creditCents: l.credit_cents,
        memo: l.memo,
        contactId: l.contact_id,
      })),
    ),
  });
  posting.statements.push({
    sql: `UPDATE fin_journal_entries SET status = 'reversed' WHERE id = ? AND entity_id = ?`,
    args: [args.entryId, args.entityId],
  });
  return posting;
}

/** CAD carrying value of an account's lines within one entry (debit - credit). */
export async function cadNetForAccountInEntry(entryId: string, accountId: string): Promise<number> {
  const row = await queryOne<{ net: number | null }>(
    `SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) AS net FROM fin_journal_lines WHERE entry_id = ? AND account_id = ?`,
    [entryId, accountId],
  );
  return Number(row?.net || 0);
}
