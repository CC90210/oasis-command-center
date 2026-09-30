/**
 * /import — multi-entity bulk import page.
 *
 * Replaces the prior leads-only page with a wizard that handles leads,
 * applications, lenders, and funded deals from one entry point. Each
 * entity has its own column-mapping rules + dedup keys (defined in
 * lib/import/entities.ts) and lands in tenant_records via the generic
 * /api/import/[entity] endpoint.
 *
 * Server-side dedup against existing tenant rows of the same
 * entity_type keeps re-uploads idempotent — an operator can rerun the
 * same file after a partial failure without doubling their pipeline.
 *
 * GATE (2026-09-30). No link in the app reaches this page (a static scan found
 * only the retired SunBiz placeholders and the unused SUN_NAV array), but it is
 * OASIS's bulk lead import, with the pipeline assignment roster added on
 * 2026-09-23, so it stays. Its rows land in the pipeline, so it asks the rail
 * the Pipeline row's question, requireOsRoute("/pipeline"), as its first
 * statement, and imports into the session's workspace, never a profile guess.
 */

import { PageHeader } from "@/components/Card";
import { ImportWizard } from "@/components/import/ImportWizard";
import { safe } from "@/lib/api-helpers";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { getOasisPipelineAssignmentRoster } from "@/lib/team";
import { requireOsRoute } from "@/components/os/landings/page-gate";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const viewer = await requireOsRoute("/pipeline");
  const tenantId = viewer.surface.tenantId;
  let leadAssignmentOptions: Array<{ id: string; name: string }> | null = null;
  const tenantSlug = await safe("import.tenant_slug", resolveOwnedSlug(tenantId), null);
  if (isWebsiteSalesTenantSlug(tenantSlug)) {
    const roster = await safe(
      "import.pipeline_assignment_roster",
      getOasisPipelineAssignmentRoster(tenantId),
      [],
    );
    leadAssignmentOptions = roster.map((member) => ({
      id: member.auth_user_id!,
      name: member.display_name || member.full_name || member.email,
    }));
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Import data"
        subtitle="Bulk-import leads, applications, lenders, or funded deals. Column mapping is auto-detected and duplicates are skipped before anything lands in your pipeline."
      />

      <ImportWizard leadAssignmentOptions={leadAssignmentOptions} />
    </div>
  );
}
