/**
 * Cash, right column of the owner's brief. Finance owners only: the loader
 * returns nothing for anyone the Finances gate refuses, and this block is then
 * not drawn at all.
 *
 * Reads the Finances Overview reader (the same figure /founders/finances
 * shows as "Cash on hand"). A book with no bank activity recorded says "Not
 * connected" — its zero balance means nothing was ever imported, not that the
 * account is empty — and a failed read says it failed. Neither prints CA$0.
 *
 * A book whose cash accounts are missing part of their story (no opening
 * balance on a bank account, Stripe payouts never booked:
 * lib/founders-finances/cash-coverage.ts) says "Books incomplete" with the
 * reasons. The ledger sum is shown only as a labelled detail under that, never
 * as "Cash on hand": on 2026-09-29 it read −CA$1,788.23 while Stripe held $0
 * and the bank's real balance was nowhere in the books.
 *
 * Every live or incomplete view lists what each account covers, and "Bank
 * lines to review" says "Bank not connected" until a bank line was ever
 * imported: "None" there claimed a review queue that does not exist.
 *
 * Server component, no hooks.
 */
import Link from "next/link";
import { formatCents } from "@/lib/founders-finances/money";
import type { CashAccountLine, CashView } from "@/components/os/today/model";

export const FINANCES_HREF = "/founders/finances";
/** Bank activity enters the book by import on the Transactions page. */
export const BANK_CONNECT_HREF = "/founders/finances/transactions";

function Covers({ accounts }: { accounts: CashAccountLine[] }) {
  if (accounts.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-fg-dim" aria-label="What each account covers">
      {accounts.map((a) => (
        <li key={a.name}>
          <span className="text-fg-muted">{a.name}:</span> {a.covers}
        </li>
      ))}
    </ul>
  );
}

function Queues({ view }: { view: Extract<CashView, { kind: "live" | "incomplete" }> }) {
  return (
    <dl className="mt-3 space-y-1.5 border-t border-hairline pt-3 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-fg-muted">Overdue invoices</dt>
        <dd className="text-right text-fg tabular-nums">
          {view.overdueCount > 0 ? `${view.overdueCount}${view.overdueLabel ? ` · ${view.overdueLabel}` : ""}` : "None"}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-fg-muted">Bank lines to review</dt>
        <dd className="text-right text-fg tabular-nums">
          {!view.bankConnected ? (
            <span className="text-fg-muted">
              Bank not connected ·{" "}
              <Link href={BANK_CONNECT_HREF} prefetch={false} className="font-medium text-accent hover:underline">
                Connect
              </Link>
            </span>
          ) : view.unreviewed > 0 ? (
            view.unreviewed
          ) : (
            "None"
          )}
        </dd>
      </div>
    </dl>
  );
}

export function CashGlance({ view }: { view: CashView }) {
  return (
    <section aria-labelledby="cash-heading" className="rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <h2 id="cash-heading" className="text-sm font-semibold text-fg">
          Cash
        </h2>
        <Link href={FINANCES_HREF} prefetch={false} className="text-xs font-medium text-accent hover:underline">
          Open Finances
        </Link>
      </header>
      <div className="px-4 py-3">
        {view.kind === "live" ? (
          <>
            <div className="text-[13px] text-fg-muted">Cash on hand</div>
            <div className="mt-1 text-2xl font-semibold leading-8 tracking-tight text-fg tabular-nums">
              {formatCents(view.cashCadCents, "CAD")}
            </div>
            <Covers accounts={view.accounts} />
            <Queues view={view} />
          </>
        ) : view.kind === "incomplete" ? (
          <>
            <div className="text-sm font-medium text-status-warm">Books incomplete</div>
            <p className="mt-1 text-xs text-fg-muted">
              Not a cash balance yet: {view.gaps.join("; ")}.
            </p>
            <div className="mt-2 flex items-baseline justify-between gap-3 text-xs">
              <span className="text-fg-muted">Ledger total, incomplete</span>
              <span className="text-fg-muted tabular-nums">{formatCents(view.ledgerCadCents, "CAD")}</span>
            </div>
            <Covers accounts={view.accounts} />
            <Queues view={view} />
          </>
        ) : view.kind === "not_connected" ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-fg-muted">Not connected</span>
            <Link href={BANK_CONNECT_HREF} prefetch={false} className="text-sm font-medium text-accent hover:underline">
              Connect
            </Link>
            <p className="w-full text-xs text-fg-dim">No bank or Stripe activity has been recorded in the books yet.</p>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span aria-hidden className="text-2xl font-semibold leading-8 text-fg-dim">
              —
            </span>
            <span className="text-sm font-medium text-status-warm">Couldn&rsquo;t load</span>
          </div>
        )}
      </div>
    </section>
  );
}
