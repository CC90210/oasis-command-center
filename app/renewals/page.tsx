/**
 * /renewals (top-level) — operator's renewal queue when accessed
 * outside the tenant catch-all. Backed by funded_deals; tenant scoping
 * comes from getActiveProfile(). The /t/<slug>/renewals route uses the
 * same render path via RenewalsV2 (also imports from renewals-shared).
 *
 * Phase 8 of the SunBiz Jordan/Oasis 2026-05-23 restructure. Row /
 * group / progress-bar logic lives in components/renewals/renewals-
 * shared.tsx so both surfaces stay in lock-step.
 */

import { Card, PageHeader, Stat, EmptyState } from "@/components/Card";
import { Flame, Clock, CalendarDays, TrendingUp } from "lucide-react";
import {
  getActiveProfile,
  getRenewalsSummary,
  getRenewalsRows,
  type FundedDealRow,
} from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { cookies } from "next/headers";
import { DEMO_CLIENT_PROFILE_COOKIE } from "@/lib/client-profiles";
import {
  SUNBIZ_DEMO_RENEWALS_SUMMARY,
  SUNBIZ_DEMO_RENEWAL_ROWS,
} from "@/lib/sunbiz-demo-data";
import {
  fmtCurrency,
  groupRows,
  RenewalRow,
} from "@/components/renewals/renewals-shared";
import RecordFundedDeal from "@/components/renewals/RecordFundedDeal";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { RenewalDetailDrawer } from "@/components/renewals/RenewalDetailDrawer";

export const dynamic = "force-dynamic";

const EMPTY_SUMMARY = {
  past_due_count: 0,
  this_week_count: 0,
  this_month_count: 0,
  est_commission_total_usd: 0,
  total_with_dates: 0,
  total_no_date: 0,
};

export default async function RenewalsPage() {
  const profile = await safe("renewals.profile", getActiveProfile(), null);
  const demoProfile = profile?.tenant_id
    ? null
    : (await cookies()).get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
  const demoMode = demoProfile === "sun";
  const tenantId = demoMode ? "" : profile?.tenant_id || "";

  const [summary, rows] = demoMode
    ? [SUNBIZ_DEMO_RENEWALS_SUMMARY, SUNBIZ_DEMO_RENEWAL_ROWS]
    : await Promise.all([
        tenantId
          ? safe("renewals.summary", getRenewalsSummary(tenantId), EMPTY_SUMMARY)
          : Promise.resolve(EMPTY_SUMMARY),
        tenantId
          ? safe("renewals.rows", getRenewalsRows(tenantId, 50), [] as FundedDealRow[])
          : Promise.resolve([] as FundedDealRow[]),
      ]);

  const groups = groupRows(rows);

  // Same gate as the endpoint (see the render site below). Fail closed.
  const sess = await resolveSessionContext().catch(() => null);
  const canRecord = !!tenantId && !!sess?.ok && sess.tenantId === tenantId && canWriteCrm(sess.teamRole);

  return (
    <div className="space-y-6 animate-fade-in">
      <RenewalDetailDrawer />
      <PageHeader
        title="Renewals"
        subtitle={
          demoMode
            ? "Sun demo mode · sample renewal data is loaded so you can see the workflow"
            : summary.total_with_dates + summary.total_no_date === 0
              ? "Funded deals will appear here as renewals come due"
              : `${summary.total_with_dates} ${summary.total_with_dates === 1 ? "deal" : "deals"} with renewal dates · ${summary.total_no_date} missing date`
        }
      />

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
            <Flame size={12} className="text-status-hot" />
            <span>Past Due</span>
          </div>
          <Stat
            label=""
            value={String(summary.past_due_count)}
            hint={summary.past_due_count === 0 ? "all clear" : "overdue - escalate"}
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

      {/* Manual intake. Hidden in demo mode (the rows are fixtures, so a write
          would neither persist nor make sense), and hidden from anyone without
          CRM write access — resolved with the same helper /api/renewals
          authorizes with, so a read_only member is never handed a full form
          that can only answer 403. */}
      {!demoMode && canRecord && <RecordFundedDeal />}

      <div className="flex flex-wrap items-center gap-2">
        <button className="px-3 py-1.5 rounded-full bg-accent-soft text-accent text-xs font-semibold border border-accent/30">
          All ({rows.length})
        </button>
        <button className="px-3 py-1.5 rounded-full bg-bg-elev text-fg-muted text-xs font-medium border border-bg-border hover:bg-bg-hover">
          Next 60 Days ({summary.this_week_count + summary.this_month_count})
        </button>
        <button className="px-3 py-1.5 rounded-full bg-bg-elev text-fg-muted text-xs font-medium border border-bg-border hover:bg-bg-hover">
          No Date Set ({summary.total_no_date})
        </button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState message="No funded deals yet. Renewal cards will appear as deals close and Solara checks the follow-up window." />
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
