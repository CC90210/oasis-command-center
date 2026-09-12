/**
 * /pipeline/new — add an OASIS lead at any stage this person may start one in.
 *
 * The form, the server and the board read ONE rule (lib/oasis-lead-create.ts):
 * an admin may start a lead in any stage the board draws, a sales rep in
 * Assigned. The stage picker is built from that rule, so it offers exactly
 * what the records route will accept — before 2026-09-10 it offered all 14
 * stages while the server accepted only `researched`, which the board no
 * longer drew (CC: "It only allows me to add a lead to the research section,
 * which isn't even a section").
 *
 * `?stage=<key>` preselects a stage — each board column's "+" links here with
 * its own key. On save the form lands on /pipeline?stage=<saved stage>, the
 * column the lead is now in.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { PageHeader, Card } from "@/components/Card";
import { ManifestRecordForm } from "@/components/manifest/ManifestRecordForm";
import { OASIS_SEED } from "@/lib/manifest/seeds";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import {
  creatableOasisStages,
  oasisLeadCreateForm,
  preselectOasisCreateStage,
} from "@/lib/oasis-lead-create";

export const dynamic = "force-dynamic";

function Unavailable({ subtitle, detail }: { subtitle: string; detail?: string }) {
  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader title="New lead" subtitle={subtitle} />
      {detail && (
        <Card>
          <div className="text-sm text-fg-muted">{detail}</div>
        </Card>
      )}
    </div>
  );
}

export default async function PipelineNewLeadPage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string }>;
}) {
  const profile = await safe("pipeline.new.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || null;
  const session = await resolveSessionContext();
  if (!session.ok || !tenantId) {
    return <Unavailable subtitle="Sign in to add a lead." />;
  }

  // NON-OASIS WORKSPACES LEAVE, mirroring app/pipeline/page.tsx. This form
  // writes OASIS leads; a SunBiz operator who lands here belongs on their own
  // tenant's leads board. A failed lookup renders no form rather than guessing.
  const tenant = await getTenant(tenantId).catch(() => null);
  const tenantSlug = tenant?.slug || null;
  if (!tenantSlug) {
    return (
      <Unavailable
        subtitle="We couldn't verify this workspace."
        detail="Refresh to try again. No form was shown, so nothing can be saved to the wrong workspace."
      />
    );
  }
  if (!isWebsiteSalesTenantSlug(tenantSlug)) redirect(`/t/${tenantSlug}/leads`);

  // A REP MAY ADD A LEAD THEY FOUND THEMSELVES (CC, 2026-09-08), and an admin
  // may add one at any stage the board draws (CC, 2026-09-10). The same list
  // gates the page, fills the picker, and is enforced by the records route.
  // An empty list means this role does no sales work.
  const viewer = { isAdmin: session.isAdmin, teamRole: session.teamRole };
  const creatable = creatableOasisStages(viewer);
  if (creatable.length === 0) redirect("/pipeline");

  const leadEntity = OASIS_SEED.data_model?.find((e) => e.name === "lead");
  if (!leadEntity) {
    return (
      <Unavailable
        subtitle="Lead entity not defined"
        detail="OASIS_SEED has no `lead` entity. Edit lib/manifest/seeds.ts."
      />
    );
  }

  // The slug this operator owns — not the literal "oasis", which no OASIS
  // workspace is slugged and which 403'd every create with slug_not_owned. It
  // must also be an OASIS slug: the records route only plans and stamps a lead
  // on one, and a lead written anywhere else would carry no stamp.
  const ownedSlug = await resolveOwnedSlug(tenantId);
  if (!ownedSlug || !isWebsiteSalesTenantSlug(ownedSlug)) {
    return (
      <Unavailable
        subtitle="No workspace namespace for this account."
        detail="This account has no resolvable OASIS workspace, so a lead can't be created here. Ask an admin to finish tenant setup."
      />
    );
  }

  const form = oasisLeadCreateForm(leadEntity, viewer);
  const sp = (await searchParams) || {};
  const initialStage = preselectOasisCreateStage(sp.stage, form.stages);

  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader
        title="New lead"
        subtitle={
          form.stages.length > 1
            ? "Add a lead at any stage on the board. It's assigned to you."
            : "Add a lead you sourced. It starts in Assigned, in your book."
        }
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
        entity={form.entity}
        optionLabels={form.optionLabels}
        fieldLabels={form.fieldLabels}
        backPath="pipeline"
        backHref="/pipeline"
        landOnStagePath="/pipeline"
        initial={initialStage ? { stage: initialStage } : {}}
      />
    </div>
  );
}
