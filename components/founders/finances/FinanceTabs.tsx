"use client";

/**
 * Finances' own secondary navigation. Business book only, so the links carry
 * no ?entity= (the pages ignore it). Plain <Link>s: with a loading.tsx under
 * every tab, Next prefetches each tab's shell and a click paints the skeleton
 * immediately instead of waiting on the server render.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

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
            href={t.href}
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
