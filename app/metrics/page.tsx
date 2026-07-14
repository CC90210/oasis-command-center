import { PageHeader, Card, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import { getEmailMetrics } from "@/lib/metrics";
import { MetricsDashboard } from "@/components/metrics/MetricsDashboard";
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
      <PageHeader title="Metrics" subtitle="Email performance across every source, using Constant Contact's metric definitions." />
      {payload ? (
        <MetricsDashboard payload={payload} />
      ) : (
        <Card title="Metrics">
          <EmptyState message="Metrics are warming up. Check back once a cycle has run." />
        </Card>
      )}
    </div>
  );
}
