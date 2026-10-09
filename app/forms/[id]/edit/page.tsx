/**
 * /forms/[id]/edit — operator form-builder page.
 *
 * Server component loads the form row (tenant-scoped via service-role),
 * then hands it to FormBuilderClient
 * which owns the visual editor + live preview. If the stored definition
 * is malformed (manual DB edit, schema drift), we render a clean
 * "definition corrupt" page instead of routing into the editor —
 * the visual surface can't repair an unparseable row.
 *
 * 404 when the form doesn't belong to this user's tenant — defends
 * against a guessed-UUID URL.
 *
 * GATE (MKT-15, MKT-02, 2026-10-02). requireOsRoute("/forms") is the first
 * statement, as on /forms, and the form is read by the SESSION's workspace
 * (viewer.surface.tenantId). It used to find the workspace with its own
 * user_profiles lookup, which errored for anyone with a seat in two
 * workspaces (a 404 on every form) and could disagree with the list. Someone
 * formsEditRefusal refuses (a member who may not edit, or anyone in a retired
 * workspace) gets its plain sentence and a link to the answers, never a
 * builder whose Save the API would refuse.
 *
 * OFFERS (2026-10-08). A form with an offer page (form_offer_pages, bravo__203)
 * opens the offer builder (components/offer-pages/builder/OfferBuilder.tsx):
 * Page / Video / Form & booking / Settings / Preview, with this same
 * FormBuilderClient in the Form & booking tab. An intake form keeps
 * FormBuilderClient exactly as before, with "Turn into an offer" above it,
 * except a support desk's form, which never becomes a sales page. Before the
 * migration is applied every form is an intake form and nothing is offered.
 */

import { PageHeader } from "@/components/Card";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { safe } from "@/lib/api-helpers";
import { FormBuilderClient } from "@/components/forms/FormBuilderClient";
import { OfferBuilder } from "@/components/offer-pages/builder/OfferBuilder";
import { TurnIntoOffer } from "@/components/offer-pages/builder/TurnIntoOffer";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { formsEditRefusal } from "@/lib/forms/access";
import { isSupportDeskForm, offerPagesDb, readOfferRow } from "@/lib/offer-pages/store";
import { offerView } from "@/lib/offer-pages/operator";
import { offerAlertStatus } from "@/lib/offer-pages/alert-status";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { resolveBookingUrl } from "@/lib/booking-link";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  parseFormSteps,
  parseFormBranding,
  parseStepOutcomes,
  type FormStep,
  type FormBranding,
} from "@/lib/forms/types";

export const dynamic = "force-dynamic";

type FormDbRow = {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  branding: unknown;
  steps: unknown;
  on_complete_stage: string | null;
  step_outcomes: unknown;
  enabled: boolean;
  redirect_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

async function loadForm(id: string, tenantId: string): Promise<FormDbRow | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("forms")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return data as FormDbRow;
}

export default async function EditFormPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireOsRoute("/forms");
  const { id } = await params;
  const row = await loadForm(id, viewer.surface.tenantId);
  if (!row) notFound();

  const refusal = formsEditRefusal({ persona: viewer.surface.persona, tenantId: viewer.surface.tenantId });
  if (refusal) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title={row.name || "Untitled form"}
          subtitle={refusal.message}
          action={
            <Link
              href="/forms"
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back to forms
            </Link>
          }
        />
        <Link
          href={`/forms/${encodeURIComponent(row.id)}/responses`}
          className="text-sm text-accent hover:text-accent-bright"
        >
          See this form&apos;s responses
        </Link>
      </div>
    );
  }

  // Resolve the tenant's PROFILE slug ("sun" for SunBiz) so the builder
  // renders THIS tenant's themes, stage vocabulary, and step presets —
  // same gate /forms uses to pick SunBizFormsClient vs the generic list.
  const tenant = await safe("forms.edit.tenant", getTenant(row.tenant_id), null);
  const profileSlug = resolveClientProfileSlug(tenant);

  // Parse the jsonb columns once on the server — if they're somehow
  // malformed (manual DB edit, schema migration drift), the parsers
  // throw which Next.js renders as a 500 page. Builder UI handles
  // the validation case via the live preview's error pane instead.
  let steps: FormStep[];
  let branding: FormBranding;
  let stepOutcomes: Record<string, string>;
  try {
    steps = parseFormSteps(row.steps);
    branding = parseFormBranding(row.branding);
    stepOutcomes = parseStepOutcomes(row.step_outcomes);
  } catch (err) {
    // Surface a clean error page rather than the default 500. Operators
    // who somehow end up here can use the JSON editor to fix the bad row.
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title="Form definition corrupt"
          subtitle={`forms.id=${row.id} has malformed data. Ask the operator who owns this tenant to delete + re-create the form, or restore from the audit log.`}
        />
        <pre className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs font-mono text-rose-400 overflow-x-auto">
          {err instanceof Error ? err.message : String(err)}
        </pre>
        <Link href="/forms" className="text-sm text-accent hover:text-accent-bright">
          ← Back to forms
        </Link>
      </div>
    );
  }

  const initialForm = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    branding,
    steps,
    on_complete_stage: row.on_complete_stage,
    step_outcomes: stepOutcomes,
    enabled: row.enabled,
    redirect_url: row.redirect_url,
  };
  const offer = await loadOfferForEditor(row.tenant_id, initialForm);

  if (offer.kind === "offer") {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title={row.name || "Untitled offer"}
          subtitle={`Offer page /${row.slug} - its form is ${row.enabled ? "on" : "off"}`}
          action={
            <Link
              href="/forms"
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back to offers
            </Link>
          }
        />
        <OfferBuilder
          form={initialForm}
          profileSlug={profileSlug}
          initial={offer.view}
          tenantSlug={tenant?.slug ?? null}
          alert={offer.alert}
          libraryAvailable={isOasisInternalTenant(row.tenant_id)}
          bookingLinkSet={isOasisInternalTenant(row.tenant_id) && !!resolveBookingUrl()}
          canRequestCopy={isOasisInternalTenant(row.tenant_id)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={row.name || "Untitled form"}
        subtitle={`Slug: ${row.slug} · ${row.enabled ? "Live" : "Disabled"}`}
        action={
          <Link
            href="/forms"
            className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to forms
          </Link>
        }
      />
      {offer.kind === "offerable" ? <TurnIntoOffer formId={row.id} /> : null}
      <FormBuilderClient
        initialForm={initialForm}
        profileSlug={profileSlug}
      />
    </div>
  );
}

type EditorOffer =
  | { kind: "offer"; view: ReturnType<typeof offerView>; alert: Awaited<ReturnType<typeof offerAlertStatus>> }
  | { kind: "offerable" }
  | { kind: "intake" };

/**
 * Does this form have an offer page (the builder), could it get one (Turn into
 * an offer), or neither (offer pages unavailable here, or a support desk's
 * form)? Any failure reads as "intake": the form's own editor always opens.
 */
async function loadOfferForEditor(
  tenantId: string,
  form: { id: string; slug: string; name: string; branding: FormBranding; enabled: boolean },
): Promise<EditorOffer> {
  const db = offerPagesDb();
  if (!db) return { kind: "intake" };
  try {
    const read = await readOfferRow(db, tenantId, form.id);
    if (read.state === "unavailable") return { kind: "intake" };
    if (read.state === "row") {
      return {
        kind: "offer",
        view: offerView(read.row, { ...form, tenantId }),
        alert: await offerAlertStatus(tenantId),
      };
    }
    return (await isSupportDeskForm(db, tenantId, form)) ? { kind: "intake" } : { kind: "offerable" };
  } catch (err) {
    console.error("[forms.edit] offer page unreadable; opening the form editor", { form_id: form.id }, err);
    return { kind: "intake" };
  }
}
