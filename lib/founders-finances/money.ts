/**
 * Money primitives for FOUNDERS > Finances. PURE — no I/O.
 *
 * Every amount in this module is an integer number of cents paired with an ISO
 * currency. Floats never hold money: a parsed "19.99" becomes 1999 by string
 * arithmetic, not by multiplying a float by 100 (0.1 + 0.2 is not 0.3, and a
 * ledger that is off by one cent does not balance).
 */

export const CURRENCIES = ["CAD", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** Uppercases and validates an ISO-4217-looking code. Null when unusable. */
export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertCents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${field} must be an integer number of cents`);
  }
  return value;
}

/**
 * Parse a human or bank-export amount into integer cents.
 *
 * Accepts: "1234.5", "1,234.56", "$1,234.56", "-12.30", "(12.30)" (accounting
 * negative), "12.30-" (trailing minus, some Canadian bank exports), "CA$ 5".
 * Refuses: more than two decimals, empty strings, anything non-numeric.
 * Returns null rather than guessing — a guessed amount in a ledger is worse
 * than a rejected row.
 */
export function parseMoneyToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    // Numbers are only accepted when they are already exact to the cent.
    const cents = Math.round(input * 100);
    if (Math.abs(cents / 100 - input) > 1e-9) return null;
    return Number.isSafeInteger(cents) ? cents : null;
  }
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/^(?:CA|US|C|U)?\$\s*/i, "").replace(/\s*(?:CAD|USD)$/i, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  s = s.replace(/^(?:CA|US|C|U)?\$\s*/i, "");
  // Thousands separators: commas or thin/regular spaces between digit groups.
  s = s.replace(/[,\s  ]/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = m[1];
  const frac = (m[2] || "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** "CA$1,234.56" / "-US$12.00". */
export function formatCents(cents: number, currency: string = "CAD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  const symbol = currency === "CAD" ? "CA$" : currency === "USD" ? "US$" : `${currency} `;
  return `${sign}${symbol}${whole}.${frac}`;
}

/** Plain "1234.56" for CSV exports and form defaults. */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Integer division rounding half AWAY from zero — the rounding Revenu Québec
 * and the CRA expect for tax on a cent boundary, and the one used for every
 * currency conversion here so both sides of the stack round the same way.
 */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) throw new MoneyError("division by zero");
  const negative = numerator < BigInt(0) !== denominator < BigInt(0);
  const n = numerator < BigInt(0) ? -numerator : numerator;
  const d = denominator < BigInt(0) ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * BigInt(2) >= d ? q + BigInt(1) : q;
  return negative ? -rounded : rounded;
}
