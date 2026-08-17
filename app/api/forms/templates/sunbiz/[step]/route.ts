/**
 * POST /api/forms/templates/sunbiz/[step]
 *
 * Creates a SunBiz template form pre-seeded with the canonical field
 * schema for the requested funnel step. Returns { form_id } on success;
 * the caller (SunBizFormsClient) navigates to /forms/<form_id>/edit.
 *
 * Param:
 *   step ∈ { "initial-lead-capture", "full-application", "bank-statement-upload" }
 *
 * Behaviour on slug conflict (form already exists for this tenant+slug):
 *   Returns 409 { ok: false, error: "already_exists", form_id } so the
 *   client can navigate straight to the existing form's editor.
 *
 * Field schema conforms exactly to lib/forms/types.ts FormField / FormStep
 * shapes — same validator that /api/forms POST runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getFormTheme } from "@/lib/forms/themes";
import {
  SUNBIZ_SLUGS,
  SUNBIZ_FORM_TEMPLATES,
  type SunBizStep,
} from "@/lib/forms/sunbiz-templates";
import { isUniqueViolationError } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Canonical field schema for all three SunBiz funnel forms lives in
// lib/forms/sunbiz-templates.ts (single source of truth shared with
// scripts/reseed-sunbiz-forms.ts). Alias kept so the handler body reads the same.
const TEMPLATES = SUNBIZ_FORM_TEMPLATES;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ step: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getServiceSupabase();

  // Resolve tenant
  const profileRow = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId =
    (profileRow.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 401 });
  }

  const { step } = await ctx.params;

  if (!SUNBIZ_SLUGS.has(step)) {
    return NextResponse.json(
      {
        ok: false,
        error: "unknown_step",
        hint: `step must be one of: ${[...SUNBIZ_SLUGS].join(", ")}`,
      },
      { status: 400 },
    );
  }

  const template = TEMPLATES[step as SunBizStep];
  const branding = getFormTheme("sunbiz_standard")?.branding ?? {};

  // Try to insert; handle slug conflict gracefully so the client can
  // navigate to the existing form editor instead of showing a generic error.
  const { data, error } = await db
    .from("forms")
    .insert({
      tenant_id: tenantId,
      slug: step,
      name: template.name,
      description: template.description,
      branding,
      steps: template.steps,
      on_complete_stage: template.on_complete_stage,
      step_outcomes: template.step_outcomes,
      enabled: true,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation — slug already exists for this tenant
    if (isUniqueViolationError(error)) {
      const existing = await db
        .from("forms")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("slug", step)
        .maybeSingle();
      const existingId = (existing.data as { id: string } | null)?.id;
      return NextResponse.json(
        { ok: false, error: "already_exists", form_id: existingId ?? null },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, form_id: (data as { id: string }).id });
}
