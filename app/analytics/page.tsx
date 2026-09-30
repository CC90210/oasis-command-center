import { Card, PageHeader, Stat, EmptyState } from "@/components/Card";
import { GoalPaceChart } from "@/components/charts/GoalPaceChart";
import { PipelineFunnel } from "@/components/charts/PipelineFunnel";
import { pipelineBreakdown, getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { formatMoney } from "@/lib/fmt";
import { requireSystemSurface, resolveViewerSurface } from "@/lib/role-surfaces-session";
import { loadOasisMoney } from "@/lib/goals/oasis-money";
import { analyticsMrrState, MRR_COPY, stripeMrrHint, wonCount } from "./mrr-state";

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
  // collected vs the revenue goal). A confirmed non-OASIS workspace has no
  // live MRR source yet, so it says "Not connected": the Finances ledger is
  // OASIS's books and must never render there, and the typed profile MRR it
  // used to show (with an invented $5,000 target and a synthetic decline
  // curve when no history existed) was a number nothing measured. A workspace
  // that could not be confirmed says "Couldn't check" (./mrr-state.ts).
  const surface = await resolveViewerSurface();
  const mrrState = analyticsMrrState(surface);
  // pipeline is null when tenant_records could not be read (pipelineBreakdown
  // throws): the four pipeline numbers say "Couldn't check", never 0 won / 0
  // lost over an empty funnel.
  const [money, pipeline] = await Promise.all([
    mrrState === "oasis" ? loadOasisMoney(tenantId, "analytics") : Promise.resolve(null),
    safe("analytics.pipeline_breakdown", pipelineBreakdown(tenantId), null),
  ]);
  const dollars = (cents: number) => formatMoney(cents / 100);
  // The words for a page with no money block. Read only when `money` is null,
  // which is never the "oasis" state: loadOasisMoney always answers.
  const noMoney = mrrState === "oasis" ? "unconfirmed" : mrrState;

  const totalLeads = pipeline?.total ?? 0;
  // Won = every stage that means the lead became a client (Clients' own list), not the literal "won" stage.
  const won = pipeline ? wonCount(pipeline.stages) : 0;
  const lost = pipeline?.stages["lost"] || 0;
  const conversion = totalLeads ? ((won / totalLeads) * 100).toFixed(1) : "—";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title="Analytics" subtitle="The numbers that matter, charted." />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {money ? (
          <Stat
            label="MRR (Stripe)"
            value={
              money.mrr
                ? `${money.mrr.currency.toUpperCase() === "CAD" ? "CA" : ""}${dollars(money.mrr.mrr_cents)}`
                : "—"
            }
            hint={
              money.mrr
                ? // When the books last heard from Stripe, never a bare "live".
                  stripeMrrHint(
                    money.stripeSync.ok ? { lastSyncAt: money.stripeSync.lastSyncAt } : null,
                    Date.now(),
                    money.mrrUsdCents !== null && money.mrr.currency.toUpperCase() !== "USD" ? dollars(money.mrrUsdCents) : null,
                  )
                : money.stripeConnected === false
                  ? "Stripe not connected yet — Finances → Settings"
                  : "Stripe unavailable"
            }
            accent
          />
        ) : (
          <Stat label="MRR (Stripe)" value={MRR_COPY[noMoney].value} hint={MRR_COPY[noMoney].hint} accent />
        )}
        {pipeline === null ? (
          <>
            <Stat label="Conversion" value="Couldn't check" hint="the pipeline could not be read" />
            <Stat label="Won" value="Couldn't check" />
            <Stat label="Lost" value="Couldn't check" />
          </>
        ) : (
          <>
            <Stat label="Conversion" value={`${conversion}%`} hint={`${won} won / ${totalLeads} total`} />
            <Stat label="Won" value={won} hint="Leads that became clients, at any delivery stage" />
            <Stat label="Lost" value={lost} />
          </>
        )}
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
      ) : (
        <Card title="MRR">
          <EmptyState message={MRR_COPY[noMoney].card} />
        </Card>
      )}

      <Card title="Pipeline" subtitle="Funnel by stage">
        {pipeline === null ? (
          <EmptyState message="Couldn't check the pipeline. The read failed and has been logged; this does not mean it is empty. Reload to try again." />
        ) : (
          <PipelineFunnel stages={pipeline.stages} />
        )}
      </Card>

      <Card title="Lead sources" subtitle="Where leads come from">
        {pipeline === null ? (
          <EmptyState message="Couldn't check where leads come from. Reload to try again." />
        ) : Object.keys(pipeline.sources || {}).length === 0 ? (
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
