/**
 * Shared renewal-display primitives — single source of truth used by
 * BOTH /renewals (top-level) and /t/<slug>/renewals (manifest catch-all
 * via RenewalsV2). Phase 8 of the SunBiz Jordan/Oasis 2026-05-23
 * restructure introduced renewals_v2 as a separate page kind; without
 * this extraction the row + group + progress logic was duplicated
 * verbatim across two files.
 *
 * What lives here:
 *   - fmtCurrency / fmtDate / daysUntil / initialsOf — format helpers
 *   - renewalProgress(row) — % of the way through the funded_at →
 *     next_renewal_date window (>=100 = past due)
 *   - sortByUrgency(a, b) — past-due first, then ascending by date
 *   - groupRows(rows) — 4-bucket grouping (PAST DUE / NEXT 60 DAYS /
 *     LATER / NO DATE SET) with each bucket pre-sorted
 *   - <RenewalRow row /> — the rendered row with progress bar, Needs
 *     Data badge, and wired tel:/mailto: action buttons
 */

import {
  Phone,
  Mail,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { Tag } from "@/components/Card";
import { formatMoney, initialsOf as initialsOfRaw } from "@/lib/format-helpers";
import type { FundedDealRow } from "@/lib/queries";
import { useRouter, useSearchParams } from "next/navigation";

// Re-export the shared money formatter under its old local name so
// every existing call site in this module keeps working. The two
// signatures are compatible (formatMoney accepts unknown). One source
// of truth in lib/format-helpers.ts. Self-review 2026-05-24.
export const fmtCurrency = formatMoney;

// renewals-specific date format: month + day + year ("May 24, 2026").
// Offers uses a shorter month+day format — different surfaces, different
// densities. Both legitimate; don't force-consolidate.
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// Wrap the shared initialsOf so null/empty input renders "??" instead
// of "" (matches the prior renewals row behaviour).
export function initialsOf(name: string | null | undefined): string {
  if (!name) return "??";
  return initialsOfRaw(name) || "??";
}

/**
 * Days_since_funded / days_to_renewal × 100. >=100 = renewal window
 * open; render red. 75-99 = approaching; render amber. Below = accent
 * blue. Null when either date is missing — UI renders a Needs Data
 * badge instead.
 */
export function renewalProgress(row: FundedDealRow): number | null {
  if (!row.funded_at || !row.next_renewal_date) return null;
  const funded = new Date(row.funded_at).getTime();
  const renewal = new Date(row.next_renewal_date).getTime();
  if (!Number.isFinite(funded) || !Number.isFinite(renewal) || renewal <= funded) return null;
  return Math.max(0, Math.round(((Date.now() - funded) / (renewal - funded)) * 100));
}

export function sortByUrgency(a: FundedDealRow, b: FundedDealRow): number {
  if (!a.next_renewal_date && !b.next_renewal_date) return 0;
  if (!a.next_renewal_date) return 1;
  if (!b.next_renewal_date) return -1;
  return new Date(a.next_renewal_date).getTime() - new Date(b.next_renewal_date).getTime();
}

export function groupRows(
  rows: FundedDealRow[],
): { label: string; rows: FundedDealRow[]; subtotal: number }[] {
  const now = new Date();
  const in60 = new Date(now);
  in60.setDate(in60.getDate() + 60);

  const past: FundedDealRow[] = [];
  const next60: FundedDealRow[] = [];
  const later: FundedDealRow[] = [];
  const noDate: FundedDealRow[] = [];

  for (const row of rows) {
    if (!row.next_renewal_date) {
      noDate.push(row);
      continue;
    }
    const date = new Date(row.next_renewal_date);
    if (date < now) past.push(row);
    else if (date <= in60) next60.push(row);
    else later.push(row);
  }

  past.sort(sortByUrgency);
  next60.sort(sortByUrgency);
  later.sort(sortByUrgency);

  const subtotal = (group: FundedDealRow[]) =>
    group.reduce((sum, row) => sum + Number(row.funded_amount_usd || 0), 0);

  const grouped: { label: string; rows: FundedDealRow[]; subtotal: number }[] = [];
  if (past.length) grouped.push({ label: "PAST DUE", rows: past, subtotal: subtotal(past) });
  if (next60.length) grouped.push({ label: "NEXT 60 DAYS", rows: next60, subtotal: subtotal(next60) });
  if (later.length) grouped.push({ label: "LATER", rows: later, subtotal: subtotal(later) });
  if (noDate.length) grouped.push({ label: "NO DATE SET", rows: noDate, subtotal: subtotal(noDate) });
  return grouped;
}

export function RenewalRow({ row }: { row: FundedDealRow }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const open = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("renewal", row.id);
    router.replace(`?${next}`, { scroll: false });
  };
  const days = daysUntil(row.next_renewal_date);
  const hasLender = !!row.lender_name;
  const progress = renewalProgress(row);
  const needsData = !row.funded_at || !row.next_renewal_date;
  // contact_phone + contact_email come from FundedDealRow when present.
  // Buttons render disabled when missing rather than vanishing.
  const phone = (row as FundedDealRow & { contact_phone?: string }).contact_phone || null;
  const email = (row as FundedDealRow & { contact_email?: string }).contact_email || null;

  return (
    <div role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }} className="flex cursor-pointer items-center gap-4 px-5 py-3 hover:bg-bg-hover/30 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/40">
      <div className="w-8 h-8 rounded-full bg-bg-elev border border-bg-border flex items-center justify-center text-fg-muted text-[10px] font-bold flex-shrink-0">
        {initialsOf(row.merchant_name)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-fg text-sm font-medium truncate">
            {row.merchant_name || "—"}
          </span>
          {days !== null && days >= 0 && days <= 60 && (
            <Tag tone={days <= 7 ? "warm" : "info"}>in {days}d</Tag>
          )}
          {needsData && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-mono uppercase tracking-wider bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <AlertCircle size={9} /> Needs Data
            </span>
          )}
        </div>
        <div className="text-fg-dim text-xs">
          {row.contact_name || "—"} · {hasLender ? row.lender_name : "No lender assigned"}
        </div>
        {progress !== null && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1 h-1 bg-bg-elev rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  progress >= 100
                    ? "bg-red-500"
                    : progress >= 75
                      ? "bg-amber-500"
                      : "bg-accent"
                }`}
                style={{ width: `${Math.min(100, progress)}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-fg-dim w-10 text-right">
              {progress}%
            </span>
          </div>
        )}
      </div>

      <div className="text-right flex-shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-fg-faint">Renewal</div>
        <div className="text-fg text-sm font-mono">{fmtDate(row.next_renewal_date)}</div>
      </div>

      <div className="text-right flex-shrink-0 min-w-[100px]">
        <div className="text-[10px] uppercase tracking-wider text-fg-faint">Funded</div>
        <div className="text-fg text-sm font-mono">{fmtCurrency(row.funded_amount_usd)}</div>
        {row.factor_rate != null && (
          <div className="text-fg-faint text-[10px] font-mono">
            ×{Number(row.factor_rate).toFixed(3).replace(/\.?0+$/, "")}
          </div>
        )}
      </div>

      <div className="text-right flex-shrink-0 min-w-[90px]">
        <div className="text-[10px] uppercase tracking-wider text-fg-faint">Commission</div>
        <div
          className={`text-sm font-mono ${
            hasLender && row.est_commission_usd ? "text-status-engaged" : "text-fg-faint"
          }`}
        >
          {hasLender && row.est_commission_usd ? fmtCurrency(row.est_commission_usd) : "—"}
        </div>
      </div>

      <div className="flex items-center gap-2 text-fg-dim flex-shrink-0">
        {phone ? (
          <a
            onClick={(event) => event.stopPropagation()}
            href={`tel:${phone}`}
            className="hover:text-fg p-1 transition-colors"
            title={`Call ${row.contact_name || "merchant"} — ${phone}`}
          >
            <Phone size={14} />
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="opacity-30 p-1 cursor-not-allowed"
            title="No phone on file"
          >
            <Phone size={14} />
          </button>
        )}
        {email ? (
          <a
            onClick={(event) => event.stopPropagation()}
            href={`mailto:${email}?subject=Renewal%20opportunity%20—%20${encodeURIComponent(row.merchant_name || "")}`}
            className="hover:text-fg p-1 transition-colors"
            title={`Email ${row.contact_name || "merchant"} — ${email}`}
          >
            <Mail size={14} />
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="opacity-30 p-1 cursor-not-allowed"
            title="No email on file"
          >
            <Mail size={14} />
          </button>
        )}
        <ChevronRight size={14} className="text-fg-faint" />
      </div>
    </div>
  );
}
