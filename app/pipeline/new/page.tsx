/**
 * /pipeline/new — create a new OASIS lead.
 *
 * Reuses ManifestRecordForm against OASIS_SEED.lead. The "+ New lead"
 * CTA on the /pipeline kanban deep-links here. On submit the form
 * redirects back to /pipeline.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Card } from "@/components/Card";
import { ManifestRecordForm } from "@/components/manifest/ManifestRecordForm";
import { OASIS_SEED } from "@/lib/manifest/seeds";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PipelineNewLeadPage() {
  const leadEntity = OASIS_SEED.data_model?.find((e) => e.name === "lead");
  const profile = await safe("pipeline.new.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || null;
  const session = await resolveSessionContext();
  if (!session.ok || !session.isAdmin) redirect("/pipeline");

  if (!leadEntity) {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader title="New lead" subtitle="Lead entity not defined" />
        <Card>
          <div className="text-sm text-fg-muted">
            OASIS_SEED has no `lead` entity. Edit lib/manifest/seeds.ts.
          </div>
        </Card>
      </div>
    );
  }
  if (!tenantId) {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader title="New lead" subtitle="Sign in to add a lead." />
      </div>
    );
  }

  // The slug this operator owns — not the literal "oasis", which no OASIS
  // workspace is slugged and which 403'd every create with slug_not_owned.
  const ownedSlug = await resolveOwnedSlug(tenantId);
  if (!ownedSlug) {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader title="New lead" subtitle="No workspace namespace for this account." />
        <Card>
          <div className="text-sm text-fg-muted">
            This account has no resolvable tenant slug, so a lead can&apos;t be
            created here. Ask an admin to finish tenant setup.
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader
        title="New lead"
        subtitle="Add a researched website-sales lead. Imported scraper leads use the same queue."
        action={
          <Link
            href="/pipeline"
            className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to pipeline
          </Link>
        }
      />
      <ManifestRecordForm
        tenantSlug={ownedSlug}
        entity={leadEntity}
        backPath="pipeline"
        backHref="/pipeline"
        initial={{ sales_program: "website_sales_v1", stage: "researched" }}
      />
    </div>
  );
}
