import { Card, PageHeader, Stat, EmptyState } from "@/components/Card";
import { MRRProgressChart } from "@/components/charts/MRRProgressChart";
import { GoalPaceChart } from "@/components/charts/GoalPaceChart";
import { PipelineFunnel } from "@/components/charts/PipelineFunnel";
import {
  mrrSnapshot,
  mrrHistory,
  pipelineBreakdown,
  getActiveProfile,
} from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { formatMoney } from "@/lib/fmt";
import { requireSystemSurface, resolveViewerSurface } from "@/lib/role-surfaces-session";
import { loadOasisMoney } from "@/lib/goals/oasis-money";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  // FIRST STATEMENT, before any read. This page opens with Net MRR, and an
  // outside sales contractor must not reach it. 404 rather than 403 — a 403
  // would confirm the page exists. Hiding it from the sidebar is not enough:
  // a sidebar is a suggestion and a URL is not.
  await requireSystemSurface();
  const profile = await safe("analytics.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  // An OASIS workspace reads the same money block as Today (live Stripe MRR +
  // collected vs the revenue goal). Any other workspace keeps its own profile
  // numbers — the Finances ledger is OASIS's books and must never render there.
  const surface = await resolveViewerSurface();
  const oasisMoney = surface.ok && surface.capabilities.canSeeCompanyFinancials;
  const [money, mrr, history, pipeline] = await Promise.all([
    oasisMoney ? loadOasisMoney(tenantId, "analytics") : Promise.resolve(null),
    oasisMoney
      ? Promise.resolve(null)
      : safe("analytics.mrr_snapshot", mrrSnapshot(), null),
    oasisMoney
      ? Promise.resolve([] as Array<{ date: string; mrr: number; synthetic: boolean }>)
      : safe("analytics.mrr_history", mrrHistory(60), [] as Array<{ date: string; mrr: number; synthetic: boolean }>),
    safe("analytics.pipeline_breakdown", pipelineBreakdown(tenantId), { stages: {} as Record<string, number>, total: 0, sources: {} as Record<string, number> }),
  ]);
  const dollars = (cents: number) => formatMoney(cents / 100);

  const totalLeads = pipeline.total;
  const won = pipeline.stages["won"] || 0;
  const lost = pipeline.stages["lost"] || 0;
  const conversion = totalLeads ? ((won / totalLeads) * 100).toFixed(1) : "—";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title="Analytics" subtitle="The numbers that matter, charted." />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {money ? (
          <Stat
            label="Net MRR"
            value={
              money.mrr
                ? `${money.mrr.currency.toUpperCase() === "CAD" ? "CA" : ""}${dollars(money.mrr.mrr_cents)}`
                : "—"
            }
            hint={
              money.mrr
                ? `live Stripe${money.mrrUsdCents !== null && money.mrr.currency.toUpperCase() !== "USD" ? ` · ≈ ${dollars(money.mrrUsdCents)} USD` : ""}`
                : money.stripeConnected === false
                  ? "Stripe not connected yet — Finances → Settings"
                  : "Stripe unavailable"
            }
            accent
          />
        ) : (
          <Stat label="Net MRR" value={mrr ? `$${Math.round(mrr.current).toLocaleString()}` : "—"} accent />
        )}
        <Stat label="Conversion" value={`${conversion}%`} hint={`${won} won / ${totalLeads} total`} />
        <Stat label="Won" value={won} />
        <Stat label="Lost" value={lost} />
      </section>

      {money ? (
        money.goal ? (
          <Card
            title="Sprint · collected vs pace"
            subtitle={`Cumulative USD collected against the straight line to ${dollars(money.goal.target_cents)} by ${money.goal.period_end}`}
          >
            <GoalPaceChart data={money.paceSeries} target={money.goal.target_cents / 100} />
          </Card>
        ) : (
          <Card title="Revenue goal">
            <EmptyState message="No active revenue goal. A founder sets one in Settings → Revenue goal." />
          </Card>
        )
      ) : mrr ? (
      <Card
        title="MRR · 60 days"
        subtitle={(() => {
          const realDays = history.filter((h) => !h.synthetic).length;
          const target = `Target $${mrr.target.toLocaleString()}`;
          if (realDays === 0) return `${target} · projected (no snapshot history)`;
          if (realDays < 14) return `${target} · ${realDays} day${realDays === 1 ? "" : "s"} of real data, rest back-filled — cron snapshots build up daily`;
          return target;
        })()}
      >
        <MRRProgressChart data={history} target={mrr.target} />
      </Card>
      ) : (
        <Card title="MRR">
          <EmptyState message="MRR could not be read just now. Reload in a minute." />
        </Card>
      )}

      <Card title="Pipeline" subtitle="Funnel by stage">
        <PipelineFunnel stages={pipeline.stages} />
      </Card>

      <Card title="Lead sources" subtitle="Where leads come from">
        {Object.keys(pipeline.sources || {}).length === 0 ? (
          <EmptyState message="No source data yet." />
        ) : (
          <ul className="space-y-2">
            {Object.entries(pipeline.sources)
              .sort((a, b) => b[1] - a[1])
              .map(([src, count]) => (
                <li key={src} className="flex items-center gap-3">
                  <div className="w-32 text-xs uppercase tracking-wider text-fg-muted font-bold">
                    {src}
                  </div>
                  <div className="flex-1 h-6 bg-bg-elev rounded-md overflow-hidden border border-bg-border">
                    <div
                      className="h-full bg-accent flex items-center px-2 text-xs font-bold text-bg"
                      style={{ width: `${(count / totalLeads) * 100}%` }}
                    >
                      {count > 0 && count}
                    </div>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
