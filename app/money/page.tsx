/**
 * /money — Money › Overview: the OASIS AI Solutions book at a glance, inside
 * the OS frame.
 *
 * GATE: the Finances gate, unchanged and first. resolveFinanceViewer() is the
 * founders-portal gate (FOUNDERS_TENANT_IDS + capability) AND the session's
 * auth user id behind one of the two owner emails. Everyone else, including the
 * marketing hire the founders portal admits, gets a 404 before any fin_* read.
 * The rail draws this row only for the same two people (lib/os/nav.ts
 * `finance_owner`); this is the wall, that is the sign.
 *
 * OASIS ONLY until fin_* carries tenant_id (plan, Risks: "Money-capability
 * flip"): the book is fin_ent_oasis and nothing else. The full tool stays at
 * /founders/finances; the rows below link into it rather than forking it.
 *
 * NUMBERS follow "unknown is not zero" (components/os/landings/money-model.ts):
 * a source that has not reported says "Not connected", a failed read says it
 * failed, and neither can print CA$0.00.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import {
  ArrowLeftRight,
  ClipboardList,
  FileText,
  Landmark,
  Receipt,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Card } from "@/components/Card";
import { KpiTile } from "@/components/os/KpiTile";
import { PageFrame } from "@/components/os/PageFrame";
import { LinkList, type LinkListItem } from "@/components/os/landings/LinkList";
import { moneyTiles } from "@/components/os/landings/money-model";
import { amountTone } from "@/components/founders/finances/ui";
import { FinanceNotFound, resolveFinanceViewer, type EntityRow } from "@/lib/founders-finances/access-io";
import { financeBook, loadOverviewPage } from "@/lib/founders-finances/page-context";
import { sweepOverdue } from "@/lib/founders-finances/invoices-io";
import { formatCents } from "@/lib/founders-finances/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money" };

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const SECTIONS: LinkListItem[] = [
  { href: "/founders/finances/transactions", label: "Transactions", description: "Bank and Stripe lines, categories, statement imports", icon: <ArrowLeftRight {...ICON} /> },
  { href: "/founders/finances/invoices", label: "Invoices", description: "Draft, send and track what clients owe", icon: <FileText {...ICON} /> },
  { href: "/founders/finances/bills", label: "Bills & expenses", description: "What the business pays, including recurring costs", icon: <Receipt {...ICON} /> },
  { href: "/founders/finances/reports", label: "Reports", description: "Profit and loss, balance sheet, ledger, CSV export", icon: <ClipboardList {...ICON} /> },
  { href: "/founders/finances/taxes", label: "Taxes", description: "GST/QST collected, paid and the registration threshold", icon: <Landmark {...ICON} /> },
  { href: "/founders/finances/accounts", label: "Accounts", description: "Balances by account and owner equity", icon: <Wallet {...ICON} /> },
  { href: "/analytics", label: "Analytics", description: "Revenue and pipeline trends", icon: <TrendingUp {...ICON} /> },
];

type Loaded = Awaited<ReturnType<typeof loadOverviewPage>>;

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
    // persist overdue status itself. Same as /founders/finances: after the
    // response, because nothing shown depends on it.
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
      subtitle="OASIS AI Solutions: cash, this month, and what you are owed. CAD unless marked US$."
      actions={
        <Link href="/founders/finances/invoices#new-invoice" prefetch={false} className="btn-primary">
          New invoice
        </Link>
      }
    >
      <div className="space-y-6">
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

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <Card
              title="Recent transactions"
              action={
                <Link href="/founders/finances/transactions" prefetch={false} className="text-[13px] text-accent hover:underline">
                  All transactions
                </Link>
              }
              noPadding
            >
              {!loaded ? (
                <p className="px-4 py-6 text-sm text-fg-muted">Couldn&rsquo;t load transactions. The error has been logged.</p>
              ) : loaded.recent.length === 0 ? (
                <p className="px-4 py-6 text-sm text-fg-muted">
                  Nothing recorded yet.{" "}
                  <Link href="/founders/finances/transactions#import" prefetch={false} className="text-accent hover:underline">
                    Import a bank statement
                  </Link>{" "}
                  to start.
                </p>
              ) : (
                <RecentTable rows={loaded.recent} />
              )}
              {loaded && loaded.ov.unreviewed > 0 && (
                <p className="border-t border-hairline px-4 py-2.5 text-[13px]">
                  <Link href="/founders/finances/transactions?status=unreviewed" prefetch={false} className="text-accent hover:underline">
                    {loaded.ov.unreviewed} transaction{loaded.ov.unreviewed === 1 ? "" : "s"} need a category
                  </Link>
                </p>
              )}
            </Card>
          </div>
          <div className="lg:col-span-2">
            <h2 className="mb-2 text-sm font-semibold text-fg">Finances</h2>
            <LinkList items={SECTIONS} label="Finances sections" />
          </div>
        </div>

        <p className="text-xs text-fg-dim">Decision support, not accounting or tax advice.</p>
      </div>
    </PageFrame>
  );
}

function RecentTable({ rows }: { rows: Loaded["recent"] }) {
  const th = "px-4 py-2 text-left text-xs font-medium text-fg-dim";
  const td = "px-4 py-2.5 align-top";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hairline">
            <th className={th}>Date</th>
            <th className={th}>Description</th>
            <th className={th}>Category</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((t) => (
            <tr key={t.id}>
              <td className={`${td} whitespace-nowrap tabular-nums text-fg-muted`}>{t.posted_date}</td>
              <td className={`${td} text-fg`}>{t.description}</td>
              <td className={`${td} text-fg-muted`}>{t.category_name || <span className="text-status-warm">Uncategorised</span>}</td>
              <td className={`${td} whitespace-nowrap text-right tabular-nums ${amountTone(t.amount_cents)}`}>
                {formatCents(t.amount_cents, t.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
