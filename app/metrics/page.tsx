import { PageHeader, Card, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import { getEmailMetrics } from "@/lib/metrics";
import { MetricsDashboard } from "@/components/metrics/MetricsDashboard";
import { LeadSourceBreakdown } from "@/components/charts/LeadSourceBreakdown";
import { safe } from "@/lib/api-helpers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

export default async function MetricsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await safe("metrics.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  const payload = await safe("metrics.email", getEmailMetrics(tenantId, WINDOW_DAYS), null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Metrics"
        subtitle="Outbound performance across every source (Constant Contact's metric definitions), plus where leads originate."
      />
      {payload ? (
        <MetricsDashboard payload={payload} />
      ) : (
        <>
          {/* getEmailMetrics failing must NOT take Lead Origination down with
              it. That tab counts LEADS and reads its own endpoint
              (/api/metrics/lead-sources) — it shares nothing with the email
              payload. Before this, one bad email-metrics read replaced the
              entire dashboard with "warming up" and the origination chart
              became unreachable for a reason that had nothing to do with it.
              Rendered standalone here, so it owns its own range selector. */}
          <Card title="Lead Origination" subtitle="Text vs Dial — which channel the lead came in through, by day">
            <LeadSourceBreakdown />
          </Card>
          <Card title="Outbound metrics">
            <EmptyState message="Email metrics are warming up. Check back once a cycle has run." />
          </Card>
        </>
      )}
    </div>
  );
}
