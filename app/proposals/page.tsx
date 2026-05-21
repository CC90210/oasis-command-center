/**
 * /proposals — OASIS proposal list.
 *
 * Sister page to /pipeline (leads) and /leads. Surfaces every proposal
 * the operator has drafted or sent — same ManifestTable machinery the
 * leads view uses, scoped to the OASIS_SEED proposal entity.
 *
 * Proposal lifecycle is six stages (draft → sent → viewed → signed →
 * declined → expired) which already live on OASIS_SEED.data_model.proposal.
 * Stage colours come from a small inline metadata block so the page
 * matches /pipeline's visual language without dragging the lead-stage
 * imports into the proposal surface.
 */

import { Card, EmptyState, PageHeader } from "@/components/Card";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { ManifestTable } from "@/components/manifest/ManifestTable";
import { OASIS_SEED } from "@/lib/manifest/seeds";

export const dynamic = "force-dynamic";

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string }>;
}) {
  const sp = (await searchParams) || {};
  const stageFilter = typeof sp.stage === "string" && sp.stage.trim() ? sp.stage.trim() : null;

  const profile = await safe("proposals.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  const tenant = tenantId
    ? await safe("proposals.tenant", getTenant(tenantId), null)
    : null;
  const tenantSlug = (tenant?.slug || "").toLowerCase();
  const isOasis = tenantSlug.startsWith("oasis");

  // OASIS-only surface today. Sun Biz has its own /applications route
  // for the funding-application flow which is a different entity shape
  // (lender shop-out / underwriting / docs) and doesn't belong here.
  if (!isOasis) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title="Proposals"
          subtitle="OASIS proposal tracker — this surface is for the OASIS workspace."
        />
        <Card>
          <EmptyState message="Switch to the OASIS workspace to see your proposals." />
        </Card>
      </div>
    );
  }

  const proposalEntity = OASIS_SEED.data_model?.find((e) => e.name === "proposal");
  const where = stageFilter ? { stage: stageFilter } : undefined;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Proposals"
        subtitle={
          stageFilter
            ? `Filtered to ${stageFilter.replace(/_/g, " ")}`
            : "Every SOW, retainer pitch, and signed agreement OASIS has touched."
        }
      />

      {proposalEntity ? (
        <ManifestTable
          tenantSlug="oasis"
          tenantId={tenantId || null}
          entity={proposalEntity}
          page={{
            path: "proposals",
            label: "Proposals",
            kind: "table",
            entity: "proposal",
          }}
          linkBase="/proposals"
          where={where}
          canCreate
        />
      ) : (
        <Card>
          <EmptyState message="OASIS proposal entity not defined in the manifest. Open the AI editor at /t/oasis/editor to add it." />
        </Card>
      )}
    </div>
  );
}
