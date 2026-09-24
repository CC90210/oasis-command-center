"use client";

/**
 * Finances' own secondary navigation. Carries the selected book (?entity=)
 * from tab to tab so switching to Reports does not silently drop you back
 * into the business book.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export const FINANCE_TABS = [
  { href: "/founders/finances", label: "Overview" },
  { href: "/founders/finances/transactions", label: "Transactions" },
  { href: "/founders/finances/invoices", label: "Invoices" },
  { href: "/founders/finances/bills", label: "Bills & Expenses" },
  { href: "/founders/finances/accounts", label: "Accounts" },
  { href: "/founders/finances/reports", label: "Reports" },
  { href: "/founders/finances/taxes", label: "Taxes" },
  { href: "/founders/finances/settings", label: "Settings" },
] as const;

export function FinanceTabs() {
  const pathname = usePathname() || "";
  const params = useSearchParams();
  const entity = params?.get("entity");
  const active = [...FINANCE_TABS]
    .filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-bg-border px-1" aria-label="Finances">
      {FINANCE_TABS.map((t) => {
        const isActive = t.href === active;
        return (
          <Link
            key={t.href}
            href={entity ? `${t.href}?entity=${encodeURIComponent(entity)}` : t.href}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${
              isActive ? "border-[#1FE3F0] text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
