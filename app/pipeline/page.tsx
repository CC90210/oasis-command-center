/**
 * /pipeline — OASIS lead pipeline.
 *
 * 2026-05-21 rewrite (third pass): this page renders the *literal*
 * SunBizPipelineView component now — the same one Sun Biz's catch-all
 * uses at /t/sun/leads. Only difference vs the SunBiz render is the
 * `variant="oasis"` prop, which swaps:
 *   - the column set (6 OASIS columns vs 13 SunBiz columns)
 *   - the row-model (reads d.name / d.company / d.ai_score etc.)
 *   - the SLA config (lib/oasis-sla.ts)
 *
 * Layout: stage-card grid up top, "touch first" overdue callout,
 * collapsible per-stage sections with detail rows underneath. The
 * dashboard chrome that lived around the old /pipeline rewrite
 * (funnel chart + recent inbound/outbound) is gone — CC's brief was
 * explicit that /pipeline must render exactly what Sun Biz renders.
 * The funnel + recent surfaces still exist on /today (the dashboard
 * home), so they aren't lost — just stop competing for screen real
 * estate on the lead-list view.
 */

import { PageHeader, Card, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { listRecords, type TenantRecord } from "@/lib/manifest/data";
import { safe } from "@/lib/api-helpers";
import { SunBizPipelineView } from "@/components/manifest/SunBizPipelineView";
import { OASIS_LEAD_STAGES } from "@/lib/oasis-stage-meta";

export const dynamic = "force-dynamic";

export default async function PipelinePage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string; q?: string }>;
}) {
  const sp = (await searchParams) || {};
  const stageFilter = typeof sp.stage === "string" && sp.stage.trim() ? sp.stage.trim() : null;
  const query = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim() : null;

  const profile = await safe("pipeline.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";

  if (!tenantId) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pipeline" subtitle="Sign in to see your pipeline." />
        <Card>
          <EmptyState message="No tenant on this session. Finish onboarding to connect this workspace." />
        </Card>
      </div>
    );
  }

  // Fetch every OASIS lead row in the canonical shape SunBizPipelineView
  // expects ({ id, data, updated_at, created_at }). listRecords returns
  // exactly that. Query-filter is applied client-side in the component
  // via PageSearchBar; stage filter is applied server-side here so the
  // initial render doesn't ship rows we're going to discard.
  const allRows: TenantRecord[] = await safe(
    "pipeline.rows",
    listRecords({ tenant_id: tenantId, entity: "lead", limit: 500 }).then((r) => r.rows),
    [] as TenantRecord[],
  );

  // Optional ?q= filter — match across the operator-relevant fields.
  // Kept server-side so /pipeline?q=acme returns ~5 rows instead of
  // shipping 500 and filtering in the browser.
  const rows = query
    ? allRows.filter((r) => {
        const d = r.data;
        const hay = [
          d.name,
          d.company,
          d.email,
          d.phone,
          d.notes,
        ]
          .filter((v): v is string => typeof v === "string")
          .join(" ")
          .toLowerCase();
        return hay.includes(query.toLowerCase());
      })
    : allRows;

  return (
    <div className="animate-fade-in">
      <SunBizPipelineView
        slug="oasis"
        entityName="lead"
        entityLabel="Lead"
        stages={OASIS_LEAD_STAGES}
        stageField="stage"
        rows={rows}
        stageFilter={stageFilter}
        query={query}
        basePath="/pipeline"
        variant="oasis"
      />
    </div>
  );
}
