/**
 * BooksCoverageBanner — "Books incomplete", with every gap in plain words, on
 * each Money surface whose figures are built on the ledger: the Money
 * overview, Accounts, Reports (and the CSV header), Taxes and Transactions.
 *
 * WHY ONE BANNER. On 2026-09-30 the P&L, the Balance Sheet, the Accounts page
 * and the month tiles each presented a book with Stripe revenue from January,
 * costs from September, no bank line, no opening balance and no payout as a
 * set of final statements. The gaps come from one place
 * (lib/founders-finances/books-coverage.ts), so every page says the same
 * thing in the same words. Complete books render nothing.
 *
 * Server component (no hooks, no client code).
 */

export type BooksCoverageBannerProps = {
  coverage: { complete: boolean; gaps: readonly string[] } | null;
  /** What the figures on this page are, for the lead sentence. */
  figures?: string;
};

function sentence(gap: string): string {
  const trimmed = gap.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function BooksCoverageBanner({ coverage, figures = "The figures on this page" }: BooksCoverageBannerProps) {
  if (!coverage || coverage.complete || coverage.gaps.length === 0) return null;
  return (
    <section
      role="note"
      aria-label="Books incomplete"
      data-books-coverage="incomplete"
      className="rounded-xl border border-status-warm/40 bg-status-warm/5 px-4 py-3"
    >
      <p className="text-sm font-semibold text-status-warm">Books incomplete</p>
      <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
        {figures} are what the books record so far, not the whole picture:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-5 text-fg">
        {coverage.gaps.map((g) => (
          <li key={g}>{sentence(g)}</li>
        ))}
      </ul>
    </section>
  );
}
