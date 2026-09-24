/**
 * FOUNDERS > Finances. Its own tab bar (Overview · Transactions · Invoices ·
 * Bills & Expenses · Accounts · Reports · Taxes · Settings), under the portal
 * banner but instead of Marketing's sub-chips (those render only inside
 * /founders/marketing — components/founders/FoundersSectionNav.tsx).
 *
 * Gate: stricter than the founders portal. Only CC and Adon, resolved by auth
 * user id (lib/founders-finances/access-io.ts). Everyone else — including the
 * marketing hire the portal admits — gets a 404 here, and every page and API
 * route re-checks on its own.
 */

import { Suspense } from "react";
import { notFound } from "next/navigation";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { FinanceTabs } from "@/components/founders/finances/FinanceTabs";

export const metadata = { title: "Finances · OASIS" };

export default async function FinancesLayout({ children }: { children: React.ReactNode }) {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  return (
    <div className="space-y-5">
      <Suspense fallback={<div className="h-9 border-b border-bg-border" />}>
        <FinanceTabs />
      </Suspense>
      {children}
    </div>
  );
}
