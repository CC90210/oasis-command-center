/**
 * /leads — operator-facing lead list.
 *
 * Originally built for the SunBiz tenant (LeadsTableClient with the
 * 12-stage Lead Pipeline). 2026-05-20: extended for OASIS too — the
 * client component now accepts a `stages` prop so both tenants share
 * the same table machinery but render their own stage tabs.
 *
 * Tenant detection: getActiveProfile() returns the tenant for the
 * signed-in operator. The demo cookie keeps the SunBiz demo path
 * working for unauthenticated visits.
 */

import { PageHeader } from "@/components/Card";
import { getActiveProfile, getLeadsForTenant, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { cookies } from "next/headers";
import { DEMO_CLIENT_PROFILE_COOKIE } from "@/lib/client-profiles";
import { SUNBIZ_DEMO_LEADS } from "@/lib/sunbiz-demo-data";
import { LeadsTableClient } from "@/components/leads/LeadsTableClient";
import { OASIS_LEAD_STAGE_TABS } from "@/lib/oasis-stage-meta";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const profile = await safe("leads.profile", getActiveProfile(), null);
  const demoProfile = profile?.tenant_id
    ? null
    : (await cookies()).get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
  const demoMode = demoProfile === "sun";
  const tenantId = demoMode ? "" : profile?.tenant_id || "";

  // Tenant detection: UserProfile has no tenant_slug; look it up from
  // the tenants table. OASIS tenant slugs all begin with "oasis-" (the
  // primary one is "oasis-ai-cc"; per-operator preview tenants follow
  // the same prefix convention).
  const tenant = tenantId
    ? await safe("leads.tenant", getTenant(tenantId), null)
    : null;
  const tenantSlug = (tenant?.slug || "").toLowerCase();
  const isOasis = tenantSlug.startsWith("oasis");
  const stages = isOasis ? OASIS_LEAD_STAGE_TABS : undefined; // undefined → SunBiz default

  const leads = demoMode
    ? SUNBIZ_DEMO_LEADS
    : tenantId
      ? await safe("leads.list", getLeadsForTenant(tenantId, 500), [])
      : [];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Leads"
        subtitle={
          demoMode
            ? "Sun demo mode — sample leads loaded so you can see Solara's workflow."
            : tenantId
              ? leads.length === 0
                ? isOasis
                  ? "Send the first outreach to your first prospect to get started."
                  : "Send the application form to your first prospect to get started."
                : `${leads.length} lead${leads.length === 1 ? "" : "s"} in the pipeline.`
              : "Finish onboarding to connect this workspace."
        }
      />

      {tenantId || demoMode ? (
        <LeadsTableClient
          initialLeads={leads}
          stages={stages}
          // OASIS lead detail lives at /pipeline/[id], not /leads/[id]
          // (no /leads/[id] route exists). SunBiz keeps the default.
          detailBase={isOasis ? "/pipeline" : "/leads"}
        />
      ) : (
        <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-8 text-center text-fg-muted">
          Sign in to see your leads.
        </div>
      )}
    </div>
  );
}
