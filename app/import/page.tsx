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
 */

import { PageHeader } from "@/components/Card";
import { ImportWizard } from "@/components/import/ImportWizard";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const profile = await safe("import.profile", getActiveProfile(), null);
  const hasTenant = !!profile?.tenant_id;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Import data"
        subtitle="Bulk-import leads, applications, lenders, or funded deals. Column mapping is auto-detected and duplicates are skipped before anything lands in your pipeline."
      />

      {hasTenant ? (
        <ImportWizard />
      ) : (
        <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-8 text-center text-fg-muted text-sm">
          <p>Finish onboarding to connect this workspace before importing.</p>
          <Link
            href="/onboarding"
            className="mt-3 inline-block btn-secondary !px-3 !py-1.5 text-xs"
          >
            Go to onboarding →
          </Link>
        </div>
      )}
    </div>
  );
}
