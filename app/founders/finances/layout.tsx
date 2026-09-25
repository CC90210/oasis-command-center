/**
 * FOUNDERS > Finances. Its own tab bar (Overview · Transactions · Invoices ·
 * Bills & Expenses · Accounts · Reports · Taxes · Settings) is the first thing
 * on every Finances page: the founders portal banner does not render here
 * (components/founders/FoundersPortalBanner.tsx).
 *
 * Gate: stricter than the founders portal. Only CC and Adon, resolved by auth
 * user id (lib/founders-finances/access-io.ts). Everyone else — including the
 * marketing hire the portal admits — gets a 404 here, and every page and API
 * route re-checks on its own. resolveFinanceViewer is memoised per request,
 * so this check and the page's own cost one resolution, not two.
 */

import { notFound } from "next/navigation";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { FinanceTabs } from "@/components/founders/finances/FinanceTabs";

export const metadata = { title: "Finances · OASIS" };

export default async function FinancesLayout({ children }: { children: React.ReactNode }) {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  return (
    <div className="space-y-5">
      <FinanceTabs />
      {children}
    </div>
  );
}
