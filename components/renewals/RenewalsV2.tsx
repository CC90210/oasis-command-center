/**
 * RenewalsV2 — Phase 8 of the SunBiz Jordan/Oasis 2026-05-23 restructure.
 *
 * Server-component tenant-scoped renewals surface, mounted by the manifest
 * catch-all dispatcher when a page declares kind="renewals_v2". Reads from
 * funded_deals via getRenewalsSummary + getRenewalsRows (same source of
 * truth as the top-level /renewals page), then delegates row/group/badge
 * rendering to renewals-shared so the two surfaces stay in lock-step.
 *
 * Why this isn't the generic ManifestKanban: the actual renewal data
 * lives in funded_deals, not in tenant_records.entity_type='renewal'.
 * The catch-all's generic kanban was rendering an empty `renewal`
 * entity that nobody writes to — a deceptive UI.
 */

import { Card, Stat, EmptyState, Tag } from "@/components/Card";
import { Flame, Clock, CalendarDays, TrendingUp } from "lucide-react";
import {
  getRenewalsSummary,
  getRenewalsRows,
  type FundedDealRow,
} from "@/lib/queries";
import { fmtCurrency, groupRows, RenewalRow } from "./renewals-shared";

export async function RenewalsV2({ tenantId }: { tenantId: string | null }) {
  // No tenant_id → preview mode. The catch-all dispatcher already
  // surfaces a preview banner above; render a minimal stub here.
  if (!tenantId) {
    return (
      <Card>
        <div className="text-sm text-fg-muted leading-relaxed">
          Preview mode — Renewals is operator-only. Sign in as the SunBiz
          tenant to see your funded-deal renewal queue.
        </div>
      </Card>
    );
  }

  const [summary, rows] = await Promise.all([
    getRenewalsSummary(tenantId).catch(() => ({
      past_due_count: 0,
      this_week_count: 0,
      this_month_count: 0,
      est_commission_total_usd: 0,
      total_with_dates: 0,
      total_no_date: 0,
    })),
    getRenewalsRows(tenantId, 100).catch(() => [] as FundedDealRow[]),
  ]);

  const groups = groupRows(rows);

  return (
    <div className="space-y-6">
      {/* Catch-all dispatcher renders the page title + subtitle. Dynamic
          counts surface here as a small caption above the KPIs so
          operators see at a glance how many deals carry renewal dates. */}
      <div className="flex items-baseline justify-between gap-3 -mt-2">
        <div className="text-[11.5px] text-fg-dim">
          {summary.total_with_dates + summary.total_no_date === 0
            ? "Funded deals will appear here as renewals come due."
            : `${summary.total_with_dates} ${summary.total_with_dates === 1 ? "deal" : "deals"} with renewal dates · ${summary.total_no_date} missing date.`}
        </div>
        <Tag tone="info">Phase 8 · funded-deal renewals</Tag>
      </div>

      {/* KPI band — 4 cards */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
            <Flame size={12} className="text-status-hot" />
            <span>Past Due</span>
          </div>
          <Stat
            label=""
            value={String(summary.past_due_count)}
            hint={summary.past_due_count === 0 ? "all clear" : "overdue — escalate"}
          />
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
            <Clock size={12} className="text-accent" />
            <span>This Week</span>
          </div>
          <Stat
            label=""
            value={String(summary.this_week_count)}
            hint={summary.this_week_count === 0 ? "none this week" : "imminent"}
          />
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
            <CalendarDays size={12} className="text-accent" />
            <span>This Month</span>
          </div>
          <Stat
            label=""
            value={String(summary.this_month_count)}
            hint={
              summary.this_month_count === 0
                ? "$0 potential volume"
                : `${fmtCurrency(summary.est_commission_total_usd)} potential volume`
            }
          />
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
            <TrendingUp size={12} className="text-status-engaged" />
            <span>Est. Commission</span>
          </div>
          <Stat
            label=""
            value={fmtCurrency(summary.est_commission_total_usd)}
            hint="from actionable renewals"
            accent
          />
        </Card>
      </section>

      {/* Grouped rows */}
      {rows.length === 0 ? (
        <Card>
          <EmptyState message="No funded deals yet. Renewal rows will appear here as deals close and Solara watches the renewal window." />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.label}>
              <div className="flex items-baseline gap-3 mb-3 px-1">
                <span className="text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold">
                  {group.label} · {group.rows.length}
                </span>
                <span className="text-xs font-mono text-fg-dim">
                  {fmtCurrency(group.subtotal)}
                </span>
              </div>
              <Card noPadding>
                <div className="divide-y divide-bg-border">
                  {group.rows.map((row) => (
                    <RenewalRow key={row.id} row={row} />
                  ))}
                </div>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
