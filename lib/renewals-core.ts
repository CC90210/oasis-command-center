/**
 * Pure renewal calculations and formatters.
 *
 * This module must stay free of React, client components, and browser-only
 * imports. RenewalsV2 is a Server Component and calls these functions while
 * rendering; mixing them into the row UI causes Next.js to expose them as
 * client references and crash the entire page at runtime.
 */

import { formatMoney, initialsOf as initialsOfRaw } from "@/lib/format-helpers";
import type { FundedDealRow } from "@/lib/queries";

export const fmtCurrency = formatMoney;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.round((time - Date.now()) / (1000 * 60 * 60 * 24));
}

export function initialsOf(name: string | null | undefined): string {
  if (!name) return "??";
  return initialsOfRaw(name) || "??";
}

export function renewalProgress(row: FundedDealRow): number | null {
  if (!row.funded_at || !row.next_renewal_date) return null;
  const funded = new Date(row.funded_at).getTime();
  const renewal = new Date(row.next_renewal_date).getTime();
  if (!Number.isFinite(funded) || !Number.isFinite(renewal) || renewal <= funded) return null;
  return Math.max(0, Math.round(((Date.now() - funded) / (renewal - funded)) * 100));
}

function renewalTime(row: FundedDealRow): number | null {
  if (!row.next_renewal_date) return null;
  const time = new Date(row.next_renewal_date).getTime();
  return Number.isFinite(time) ? time : null;
}

export function sortByUrgency(a: FundedDealRow, b: FundedDealRow): number {
  const aTime = renewalTime(a);
  const bTime = renewalTime(b);
  if (aTime === null && bTime === null) return 0;
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  return aTime - bTime;
}

export type RenewalGroup = {
  label: string;
  rows: FundedDealRow[];
  subtotal: number;
};

export function groupRows(rows: FundedDealRow[], now = new Date()): RenewalGroup[] {
  const in60 = new Date(now);
  in60.setDate(in60.getDate() + 60);

  const past: FundedDealRow[] = [];
  const next60: FundedDealRow[] = [];
  const later: FundedDealRow[] = [];
  const noDate: FundedDealRow[] = [];

  for (const row of rows) {
    const time = renewalTime(row);
    if (time === null) {
      noDate.push(row);
      continue;
    }
    const date = new Date(time);
    if (date < now) past.push(row);
    else if (date <= in60) next60.push(row);
    else later.push(row);
  }

  past.sort(sortByUrgency);
  next60.sort(sortByUrgency);
  later.sort(sortByUrgency);

  const subtotal = (group: FundedDealRow[]) =>
    group.reduce((sum, row) => {
      const amount = Number(row.funded_amount_usd);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

  const grouped: RenewalGroup[] = [];
  if (past.length) grouped.push({ label: "PAST DUE", rows: past, subtotal: subtotal(past) });
  if (next60.length) grouped.push({ label: "NEXT 60 DAYS", rows: next60, subtotal: subtotal(next60) });
  if (later.length) grouped.push({ label: "LATER", rows: later, subtotal: subtotal(later) });
  if (noDate.length) grouped.push({ label: "NO DATE SET", rows: noDate, subtotal: subtotal(noDate) });
  return grouped;
}
