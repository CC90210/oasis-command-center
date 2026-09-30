/**
 * /money — Money › Overview: the OASIS AI Solutions book at a glance, inside
 * the OS frame. The ONE Money overview (2026-09-30): /founders/finances
 * redirects here, and the Finances tabs (Transactions, Invoices, Bills,
 * Accounts, Reports, Taxes, Settings) sit on top of it, so Money is one
 * section with one front page. The six-month chart, the recurring costs and
 * the GST/QST threshold moved here from the old Finances overview.
 *
 * GATE: the Finances gate, unchanged and first. resolveFinanceViewer() is the
 * founders-portal gate (FOUNDERS_TENANT_IDS + capability) AND the session's
 * auth user id behind one of the two owner emails. Everyone else, including the
 * marketing hire the founders portal admits, gets a 404 before any fin_* read.
 * The rail draws this row only for the same two people (lib/os/nav.ts
 * `finance_owner`); this is the wall, that is the sign.
 *
 * OASIS ONLY until fin_* carries tenant_id (plan, Risks: "Money-capability
 * flip"): the book is fin_ent_oasis and nothing else.
 *
 * NUMBERS follow "unknown is not zero" (components/os/landings/money-model.ts):
 * a source that has not reported says "Not connected", a failed read says it
 * failed, and neither can print CA$0.00. What the book does not cover is said
 * once, at the top (BooksCoverageBanner), and the month tiles say "Partial"
 * until it covers everything.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import type { ReactNode } from "react";
import { Card } from "@/components/Card";
import { KpiTile } from "@/components/os/KpiTile";
import { PageFrame } from "@/components/os/PageFrame";
import { moneyTiles } from "@/components/os/landings/money-model";
import { ActivityTable } from "@/components/founders/finances/ActivityTable";
import { BooksCoverageBanner } from "@/components/founders/finances/BooksCoverageBanner";
import { FinanceTabs } from "@/components/founders/finances/FinanceTabs";
import { InOutChart } from "@/components/founders/finances/InOutChart";
import { FinanceNotFound, resolveFinanceViewer, type EntityRow } from "@/lib/founders-finances/access-io";
import { BANK_NOT_CONNECTED, incompleteBooksNote } from "@/lib/founders-finances/books-coverage";
import { financeBook, loadOverviewPage } from "@/lib/founders-finances/page-context";
import { sweepOverdue } from "@/lib/founders-finances/invoices-io";
import { formatCents } from "@/lib/founders-finances/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money" };

type Loaded = Awaited<ReturnType<typeof loadOverviewPage>>;

const linkClass = "text-accent hover:underline";
const CADENCE_LABEL: Record<string, string> = { weekly: "weekly", monthly: "monthly", quarterly: "quarterly", yearly: "yearly" };
const LEVEL_TONE: Record<string, string> = {
  ok: "text-status-engaged",
  watch: "text-status-info",
  warning: "text-status-warm",
  exceeded: "text-status-hot",
  unconfirmed: "text-status-warm",
};
const LEVEL_BAR: Record<string, string> = {
  ok: "bg-status-engaged",
  watch: "bg-status-info",
  warning: "bg-status-warm",
  exceeded: "bg-status-hot",
  unconfirmed: "bg-status-warm",
};

export default async function MoneyPage() {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  let entity: EntityRow;
  try {
    entity = await financeBook(viewer);
  } catch (e) {
    if (e instanceof FinanceNotFound) notFound();
    throw e;
  }

  // A failed read renders every tile as "Couldn't load" — never a row of zeros.
  const loaded: Loaded | null = await loadOverviewPage(viewer, entity).catch((err: unknown) => {
    console.error("[money.overview] load failed", err instanceof Error ? err.stack ?? err.message : err);
    return null;
  });
  if (loaded) {
    // loadOverviewPage reads with sweep "deferred", which obliges the caller to
    // persist overdue status itself: after the response, because nothing shown
    // depends on it.
    after(() =>
      sweepOverdue(entity.id).then(
        () => undefined,
        (e: unknown) => console.error("[money.overview] overdue sweep failed", e instanceof Error ? e.message : e),
      ),
    );
  }
  const tiles = moneyTiles(loaded, formatCents);

  return (
    <PageFrame
      title="Overview"
      subtitle="OASIS AI Solutions: cash, this month, what you are owed and what you pay every month. CAD unless marked US$."
      actions={
        <Link href="/founders/finances/invoices#new-invoice" prefetch={false} className="btn-primary">
          New invoice
        </Link>
      }
    >
      <div className="space-y-6">
        <FinanceTabs />
        <BooksCoverageBanner coverage={loaded ? loaded.ov.books : null} figures="The figures below" />
        <section aria-label="Headline numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.headline.map(({ id, ...tile }) => (
            <KpiTile key={id} {...tile} />
          ))}
        </section>
        <section aria-label="This month" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {tiles.month.map(({ id, ...tile }) => (
            <KpiTile key={id} {...tile} />
          ))}
        </section>

        {loaded ? <Details loaded={loaded} /> : <p className="text-sm text-fg-muted">Couldn&rsquo;t load the rest of the overview. The error has been logged.</p>}

        <p className="text-xs text-fg-dim">Decision support, not accounting or tax advice.</p>
      </div>
    </PageFrame>
  );
}

function Details({ loaded }: { loaded: Loaded }) {
  const { ov, recurring, recent } = loaded;
  const booksNote = incompleteBooksNote(ov.coverage);
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="Money in and out"
          subtitle={ov.books.complete ? "Last six months, CAD" : "Last six months, CAD: what the books record so far (see above)"}
          className="lg:col-span-2"
        >
          <InOutChart data={ov.series} />
        </Card>
        <Card title="Accounts" subtitle={booksNote ? "Ledger totals, CAD: the books are incomplete, so these are not balances yet" : "Balances today, CAD"}>
          {ov.cashAccounts.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No balances yet.{" "}
              <Link href="/founders/finances/transactions#import" prefetch={false} className={linkClass}>
                Import a bank statement
              </Link>{" "}
              to start.
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {ov.cashAccounts.map((a) => (
                <li key={a.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-fg-muted">{a.name}</span>
                    <span className={`tabular-nums ${a.subtype === "credit_card" && a.balanceCents > 0 ? "text-status-warm" : "text-fg"}`}>
                      {formatCents(a.balanceCents, "CAD")}
                    </span>
                  </div>
                  {a.excludesDeposits && <div className="mt-0.5 text-xs text-status-warm">{BANK_NOT_CONNECTED}</div>}
                </li>
              ))}
            </ul>
          )}
          {ov.unreviewed > 0 && (
            <Link href="/founders/finances/transactions?status=unreviewed" prefetch={false} className={`mt-3 block text-xs ${linkClass}`}>
              {ov.unreviewed} transaction{ov.unreviewed === 1 ? "" : "s"} need a category
            </Link>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Recurring expenses (monthly)"
          subtitle={
            recurring.rate
              ? `Estimate in CAD. US$ converted at the ${recurring.rate.date} Bank of Canada rate (${recurring.rate.rate}).`
              : "Estimate in CAD. Yearly costs divided by 12."
          }
          action={
            <Link href="/founders/finances/bills#recurring" prefetch={false} className="text-xs text-fg-muted hover:text-fg">
              Manage
            </Link>
          }
          noPadding
        >
          {recurring.items.length === 0 ? (
            <p className="p-5 text-sm text-fg-muted">
              Nothing recurring yet.{" "}
              <Link href="/founders/finances/bills#recurring" prefetch={false} className={linkClass}>
                Add your subscriptions and rent
              </Link>{" "}
              on Bills &amp; Expenses.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-hairline">
                {recurring.items.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5 align-top text-fg">
                      {r.name}
                      <div className="text-xs text-fg-dim">
                        {formatCents(r.amountCents, r.currency)} {CADENCE_LABEL[r.cadence] || r.cadence}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right align-top tabular-nums">
                      {r.monthlyCadCents === null ? <span className="text-status-warm">{formatCents(r.monthlyCents, r.currency)}</span> : formatCents(r.monthlyCadCents, "CAD")}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="px-4 py-2.5 font-semibold">Total per month</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{formatCents(recurring.totalCadCents, "CAD")}</td>
                </tr>
              </tbody>
            </table>
          )}
          {recurring.unconverted > 0 && (
            <p className="border-t border-hairline px-4 py-2 text-xs text-status-warm">
              {recurring.unconverted} item{recurring.unconverted === 1 ? " is" : "s are"} not in the total: no exchange rate stored.{" "}
              <Link href="/founders/finances/settings#exchange-rates" prefetch={false} className={linkClass}>
                Fetch rates in Settings
              </Link>
            </p>
          )}
        </Card>

        {ov.threshold && (
          <Card
            title="GST/QST registration threshold"
            subtitle="Taxable revenue over the last four calendar quarters, current quarter to date"
            action={
              <Link href="/founders/finances/taxes" prefetch={false} className="text-xs text-fg-muted hover:text-fg">
                Details
              </Link>
            }
          >
            <p className={`text-sm ${LEVEL_TONE[ov.threshold.level]}`}>{ov.threshold.message}</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-elev">
              <div className={`h-full ${LEVEL_BAR[ov.threshold.level]}`} style={{ width: `${Math.min(100, Math.round(ov.threshold.pct * 100))}%` }} />
            </div>
            <p className="mt-2 text-xs text-fg-dim">
              {formatCents(ov.threshold.totalCents, "CAD")} {ov.threshold.revenueComplete ? "of" : "recorded so far, of"} {formatCents(ov.threshold.thresholdCents, "CAD")}
            </p>
          </Card>
        )}
      </div>

      <Card
        title="Recent activity"
        subtitle="Bank lines, payments, bills and expenses, newest first"
        action={
          <Link href="/founders/finances/transactions" prefetch={false} className="text-[13px] text-accent hover:underline">
            All transactions
          </Link>
        }
        noPadding
      >
        {recent.length === 0 ? (
          <EmptyActivity />
        ) : (
          <ActivityTable rows={recent} />
        )}
      </Card>
    </>
  );
}

function EmptyActivity(): ReactNode {
  return (
    <p className="px-4 py-6 text-sm text-fg-muted">
      Nothing recorded yet: no bank line, payment, bill or expense.{" "}
      <Link href="/founders/finances/transactions#import" prefetch={false} className="text-accent hover:underline">
        Import a bank statement
      </Link>{" "}
      or{" "}
      <Link href="/founders/finances/bills#record" prefetch={false} className="text-accent hover:underline">
        record an expense
      </Link>
      .
    </p>
  );
}
