/**
 * The double-entry invariant, in ONE function. PURE.
 *
 * prepareJournalLines() is the only door into fin_journal_lines: the I/O layer
 * (ledger-io.ts postJournalEntry) refuses to write anything that has not come
 * back from it. It enforces, in order:
 *
 *   1. at least two lines, every line one-sided (a debit OR a credit), every
 *      amount a positive safe integer of cents;
 *   2. per currency, sum(debits) === sum(credits) — the rule CC asked for;
 *   3. a CAD (functional-currency) equivalent on every line, allocated so the
 *      CAD equivalents ALSO balance exactly. Converting each USD line on its
 *      own and rounding would leave an entry balanced in USD but a cent off in
 *      CAD, and the trial balance would never tie out again.
 *
 * Cross-currency events (a USD invoice settled in CAD by Stripe) are modelled
 * as two balanced single-currency legs through the currency-exchange clearing
 * account, with the difference booked to FX gain/loss — see
 * crossCurrencySettlementLines(). That keeps rule 2 true for every entry.
 */

import { divRoundHalfAwayFromZero, normalizeCurrencyCode } from "./money";
import { RATE_SCALE } from "./fx";

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export type JournalLineInput = {
  accountId: string;
  currency: string;
  debitCents?: number;
  creditCents?: number;
  memo?: string;
  contactId?: string | null;
};

export type PreparedLine = {
  lineNo: number;
  accountId: string;
  currency: string;
  debitCents: number;
  creditCents: number;
  cadDebitCents: number;
  cadCreditCents: number;
  fxRate: string | null;
  memo: string;
  contactId: string | null;
};

export class LedgerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

function positiveOrZero(v: unknown, field: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new LedgerError("invalid_amount", `${field} must be a non-negative integer of cents`);
  }
  return v;
}

/** Rule 1 + rule 2. Throws LedgerError; returns the per-currency totals. */
export function assertBalanced(lines: readonly JournalLineInput[]): Map<string, number> {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new LedgerError("too_few_lines", "a journal entry needs at least two lines");
  }
  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  lines.forEach((l, i) => {
    if (!l || typeof l.accountId !== "string" || !l.accountId) {
      throw new LedgerError("missing_account", `line ${i + 1} has no account`);
    }
    const currency = normalizeCurrencyCode(l.currency);
    if (!currency) throw new LedgerError("invalid_currency", `line ${i + 1} has no valid currency`);
    const d = positiveOrZero(l.debitCents, `line ${i + 1} debit`);
    const c = positiveOrZero(l.creditCents, `line ${i + 1} credit`);
    if ((d > 0) === (c > 0)) {
      throw new LedgerError("one_sided", `line ${i + 1} must be exactly one of debit or credit, and non-zero`);
    }
    debit.set(currency, (debit.get(currency) || 0) + d);
    credit.set(currency, (credit.get(currency) || 0) + c);
  });
  const currencies = new Set([...debit.keys(), ...credit.keys()]);
  for (const cur of currencies) {
    const d = debit.get(cur) || 0;
    const c = credit.get(cur) || 0;
    if (d !== c) {
      throw new LedgerError(
        "unbalanced",
        `entry does not balance in ${cur}: debits ${d} vs credits ${c} (difference ${d - c})`,
      );
    }
    if (!Number.isSafeInteger(d)) throw new LedgerError("overflow", `${cur} total overflows`);
  }
  return debit;
}

/**
 * Largest-remainder allocation: split `total` across `weights` so the parts
 * sum to exactly `total`. Deterministic tie-break on index.
 */
export function allocateProportionally(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (BigInt(total) * BigInt(w)));
  const floors = exact.map((e) => Number(e / BigInt(sum)));
  const remainders = exact.map((e, i) => ({ i, r: Number(e % BigInt(sum)) }));
  let leftover = total - floors.reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    floors[i] += 1;
    leftover -= 1;
  }
  return floors;
}

/**
 * THE ledger function. Validates, balances, and attaches CAD equivalents.
 * `rateFor(currency)` returns the CAD-per-unit rate as a decimal string for
 * the entry's own date (Bank of Canada), or null — a non-CAD line with no rate
 * is refused rather than booked at a guessed rate.
 */
export function prepareJournalLines(
  lines: readonly JournalLineInput[],
  rateFor: (currency: string) => { rate: string; micro: bigint } | null = () => null,
): PreparedLine[] {
  assertBalanced(lines);
  const prepared: PreparedLine[] = lines.map((l, i) => ({
    lineNo: i + 1,
    accountId: l.accountId,
    currency: normalizeCurrencyCode(l.currency) as string,
    debitCents: l.debitCents || 0,
    creditCents: l.creditCents || 0,
    cadDebitCents: 0,
    cadCreditCents: 0,
    fxRate: null,
    memo: (l.memo || "").slice(0, 500),
    contactId: l.contactId || null,
  }));

  const byCurrency = new Map<string, PreparedLine[]>();
  for (const p of prepared) {
    const list = byCurrency.get(p.currency) || [];
    list.push(p);
    byCurrency.set(p.currency, list);
  }
  for (const [currency, group] of byCurrency) {
    if (currency === "CAD") {
      for (const p of group) {
        p.cadDebitCents = p.debitCents;
        p.cadCreditCents = p.creditCents;
      }
      continue;
    }
    const hit = rateFor(currency);
    if (!hit) {
      throw new LedgerError("fx_rate_missing", `no ${currency}->CAD rate for this entry's date`);
    }
    const sideTotal = group.reduce((a, p) => a + p.debitCents, 0);
    const cadTotal = Number(divRoundHalfAwayFromZero(BigInt(sideTotal) * hit.micro, RATE_SCALE));
    const debits = group.filter((p) => p.debitCents > 0);
    const credits = group.filter((p) => p.creditCents > 0);
    const dAlloc = allocateProportionally(cadTotal, debits.map((p) => p.debitCents));
    const cAlloc = allocateProportionally(cadTotal, credits.map((p) => p.creditCents));
    debits.forEach((p, i) => {
      p.cadDebitCents = dAlloc[i];
      p.fxRate = hit.rate;
    });
    credits.forEach((p, i) => {
      p.cadCreditCents = cAlloc[i];
      p.fxRate = hit.rate;
    });
  }
  assertCadBalanced(prepared);
  return prepared;
}

export function assertCadBalanced(lines: readonly PreparedLine[]): void {
  const d = lines.reduce((a, l) => a + l.cadDebitCents, 0);
  const c = lines.reduce((a, l) => a + l.cadCreditCents, 0);
  if (d !== c) {
    throw new LedgerError("cad_unbalanced", `CAD equivalents do not balance: ${d} vs ${c}`);
  }
}

/** The mirror image of an entry, for reversals. */
export function reversalLines(lines: readonly JournalLineInput[]): JournalLineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    currency: l.currency,
    debitCents: l.creditCents || 0,
    creditCents: l.debitCents || 0,
    memo: l.memo ? `Reversal: ${l.memo}` : "Reversal",
    contactId: l.contactId ?? null,
  }));
}

/** +1 when the account's natural balance is a debit (assets, expenses). */
export function normalSide(type: AccountType): 1 | -1 {
  return type === "asset" || type === "expense" ? 1 : -1;
}

/** Balance in the account's natural sign from summed debits and credits. */
export function naturalBalance(type: AccountType, debits: number, credits: number): number {
  return normalSide(type) === 1 ? debits - credits : credits - debits;
}

/**
 * A foreign-currency receivable settled in CAD (e.g. a USD invoice paid via
 * Stripe, which settles OASIS in CAD). Two balanced legs through the exchange
 * clearing account plus the realised FX difference:
 *
 *   USD leg: Dr FX clearing (USD)  / Cr AR (USD)          — balances in USD
 *   CAD leg: Dr Stripe clearing    / Cr FX clearing (CAD)  — balances in CAD
 *            at the AR's CAD carrying value, the gap to FX gain/loss.
 *
 * `arCadCarrying` is the CAD value the AR was booked at; the clearing account
 * nets to zero in CAD once both legs are posted.
 */
export function crossCurrencySettlementLines(args: {
  foreignCurrency: string;
  foreignCents: number;
  arAccountId: string;
  fxClearingAccountId: string;
  depositAccountId: string;
  fxGainLossAccountId: string;
  receivedCadCents: number;
  arCadCarryingCents: number;
  memo: string;
}): { foreignLeg: JournalLineInput[]; cadLeg: JournalLineInput[] } {
  const foreignLeg: JournalLineInput[] = [
    { accountId: args.fxClearingAccountId, currency: args.foreignCurrency, debitCents: args.foreignCents, memo: args.memo },
    { accountId: args.arAccountId, currency: args.foreignCurrency, creditCents: args.foreignCents, memo: args.memo },
  ];
  const diff = args.receivedCadCents - args.arCadCarryingCents;
  const cadLeg: JournalLineInput[] = [
    { accountId: args.depositAccountId, currency: "CAD", debitCents: args.receivedCadCents, memo: args.memo },
    { accountId: args.fxClearingAccountId, currency: "CAD", creditCents: args.arCadCarryingCents, memo: args.memo },
  ];
  if (diff > 0) {
    cadLeg.push({ accountId: args.fxGainLossAccountId, currency: "CAD", creditCents: diff, memo: "Realised FX gain" });
  } else if (diff < 0) {
    cadLeg.push({ accountId: args.fxGainLossAccountId, currency: "CAD", debitCents: -diff, memo: "Realised FX loss" });
  }
  return { foreignLeg, cadLeg };
}
