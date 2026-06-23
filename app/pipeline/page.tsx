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
 *
 * 2026-06-11 tenant-aware redirect: SunBiz / non-OASIS operators
 * landing on this page saw the OASIS variant (CC's personal stages,
 * usually 0 leads to them) — a real footgun (CC bug 2026-06-11). If
 * the session belongs to a non-OASIS tenant, we redirect to that
 * tenant's catch-all leads page (e.g. /t/sun/leads for Matt/Jordan/
 * Alex). CC's own OASIS sessions still see /pipeline as-is.
 */

import { redirect } from "next/navigation";
import { PageHeader, Card, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { listRecords, type TenantRecord } from "@/lib/manifest/data";
import { safe } from "@/lib/api-helpers";
import { LeadPipelineView } from "@/components/manifest/LeadPipelineView";
import { OASIS_LEAD_STAGES } from "@/lib/oasis-stage-meta";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * Slugs that render the OASIS-variant pipeline directly at /pipeline.
 * Anyone else gets redirected to their tenant-scoped catch-all leads
 * page. Add a slug here ONLY if that tenant wants /pipeline to be
 * their canonical leads URL (rare — almost everyone wants the catch-all).
 *
 * 2026-06-16 fix: CC's own OASIS empire tenant has slug "oasis-ai-cc"
 * (not "oasis"), so the original single-slug set redirected CC off his
 * own /pipeline to /t/oasis-ai-cc/leads, which 404s — breaking the OASIS
 * empire dashboard's Pipeline tab. CC's empire nav (CC_NAV) uses /pipeline
 * as the canonical leads URL, so his slug belongs here.
 */
const OASIS_PIPELINE_SLUGS = new Set(["oasis", "oasis-ai-cc"]);

export default async function PipelinePage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string; q?: string }>;
}) {
  // Tenant-aware redirect. Non-OASIS operators land in their own
  // tenant's leads view rather than seeing CC's OASIS personal stages.
  // Try/catch so an unexpected DB hiccup falls through to the OASIS
  // render — strictly no worse than the pre-redirect behavior.
  try {
    const sessionResult = await resolveSessionContext();
    if (sessionResult.ok) {
      const db = getServiceSupabase();
      const tenantRow = await db
        .from("tenants")
        .select("slug")
        .eq("id", sessionResult.tenantId)
        .maybeSingle();
      const slug = (tenantRow.data as { slug: string | null } | null)?.slug;
      if (slug && !OASIS_PIPELINE_SLUGS.has(slug)) {
        redirect(`/t/${slug}/leads`);
      }
    }
  } catch (err) {
    // next/navigation's redirect() throws with digest "NEXT_REDIRECT;..."
    // to signal — re-throw so Next can complete the navigation. Any
    // other failure (DB hiccup, no session, etc.) falls through to the
    // OASIS render, strictly no worse than the pre-redirect behavior.
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      throw err;
    }
  }

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
      <LeadPipelineView
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
