/**
 * /forms — operator-facing list of tenant-defined forms.
 *
 * Phase 3.3 of the SunBiz CRM build. Lists every form the tenant has
 * created, with quick actions: enable/disable, copy slug, open editor,
 * delete. "New form" button creates a stub form with one empty step,
 * then redirects to the editor for the operator to flesh out.
 *
 * Phase 3.4 (2026-05-25): When the resolved tenant slug is "sun", renders
 * SunBizFormsClient instead of FormsListClient — the SunBiz surface shows
 * the three-step funnel cards (Initial Lead Capture, Full Application,
 * Bank Statement Upload) with status pills + create-from-template buttons.
 *
 * GATE (2026-09-30). The page asks the rail: requireOsRoute("/forms") is its
 * first statement, so it opens for exactly the viewers whose rail draws the
 * Forms row, and 404s for an unprovisioned workspace or a session that does
 * not resolve to one. The workspace is the session's, never a profile guess.
 *
 * A failed read says "Forms couldn't load" and logs the detail. It used to
 * print the database driver's message, or tell a client to run a Supabase
 * migration command "on the operator machine".
 *
 * WHO MAY CHANGE (MKT-02, 2026-10-02). canEdit is canEditForms for the
 * session's persona (lib/forms/access.ts), the rule every forms write route
 * enforces: everyone else gets the list and each form's responses without
 * New form, the on/off switch, Edit or Delete. Each row carries its response
 * count (MKT-05); a count that could not be read is null, never a zero.
 */

import { PageHeader } from "@/components/Card";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getServiceSupabase } from "@/lib/supabase-server";
import { safe, isMissingTableError } from "@/lib/api-helpers";
import { FormsListClient } from "@/components/forms/FormsListClient";
import { SunBizFormsClient } from "@/components/forms/SunBizFormsClient";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { canEditForms } from "@/lib/forms/access";
import { countResponsesByForm } from "@/lib/forms/responses";
import { AlertCircle } from "lucide-react";

export const dynamic = "force-dynamic";

type FormRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

async function loadForms(tenantId: string): Promise<{ ok: true; rows: FormRow[] } | { ok: false }> {
  try {
    const db = getServiceSupabase();
    const { data, error } = await db
      .from("forms")
      .select("id, slug, name, description, enabled, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) {
      // The detail is for the log, never the screen.
      console.error(
        "[forms.load]",
        isMissingTableError(error, "public.forms") ? "forms table missing" : "read failed",
        { tenantId, message: error.message },
      );
      return { ok: false };
    }
    return { ok: true, rows: (data as FormRow[]) || [] };
  } catch (err) {
    console.error("[forms.load] read threw", { tenantId }, err);
    return { ok: false };
  }
}

export default async function FormsPage() {
  const viewer = await requireOsRoute("/forms");
  const tenantId = viewer.surface.tenantId;

  const result = await loadForms(tenantId);
  // Pass the tenant logo down so the "New form" creator can pre-fill the
  // starter's branding.logo_url. One source of truth — operators set the
  // logo once in Settings → Branding, every new form picks it up.
  const tenant = await safe("forms.tenant", getTenant(tenantId), null);
  const tenantLogoUrl = tenant?.logo_url ?? null;
  // Tenant slug threads through so the per-row Copy button can produce
  // a real public form URL (/f/<tenant_slug>/<form_slug>) instead of an
  // operator-only edit URL. This is the TENANT-ROW slug ("submissions" for
  // SunBiz) — the value the public /f/ route + mint-link resolve.
  const tenantSlug = tenant?.slug ?? null;
  // The SunBiz funnel UI is gated on the PROFILE slug ("sun"), NOT the tenant
  // row slug ("submissions"). They differ: tenant.slug="submissions" but
  // custom_fields.command_center_profile_slug="sun" (resolveClientProfileSlug
  // reads the latter). Gating on tenant.slug silently fell through to the
  // generic FormsListClient — so the SunBiz step cards + per-agent links
  // never rendered. (Fixed 2026-06-16.)
  const profileSlug = resolveClientProfileSlug(tenant);
  const responseCounts = result.ok
    ? await countResponsesByForm(getServiceSupabase(), tenantId, result.rows.map((r) => r.id))
    : {};

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Forms"
        subtitle="Forms people fill in to reach you, with every answer they sent."
      />

      {!result.ok && (
        <div className="rounded-xl border border-status-warm/40 bg-status-warm/5 p-4 text-sm text-status-warm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Forms couldn&apos;t load. The error has been logged. Try again in a minute.</span>
        </div>
      )}

      {result.ok && profileSlug === "sun" ? (
        <SunBizFormsClient
          initialRows={result.rows}
          tenantSlug={tenantSlug}
        />
      ) : result.ok ? (
        <FormsListClient
          initialRows={result.rows}
          tenantLogoUrl={tenantLogoUrl}
          tenantSlug={tenantSlug}
          tenantName={tenant?.name ?? null}
          profileSlug={profileSlug}
          canEdit={canEditForms(viewer.surface.persona)}
          responseCounts={responseCounts}
        />
      ) : null}
    </div>
  );
}
