/**
 * Tenant-scoped form-builder configuration — WHICH tenant's vocabulary the
 * form surfaces speak.
 *
 * Before 2026-08-22 the whole builder stack was SunBiz-hardcoded: every
 * tenant's "New form" shipped SunBiz branding ("SunBiz Funding" headline),
 * the SunBiz doc-collection step, SunBiz stage keys in step_outcomes, and
 * the SunBiz Lead/Opportunity pipeline vocabulary in the per-step stage
 * dropdown. That is the "a shared filter is a tenant decision" defect class:
 * a default written for one tenant silently became platform policy.
 *
 * This module is the single decision point. Every function keys on the
 * resolved PROFILE slug (lib/client-profiles resolveClientProfileSlug —
 * "sun" for SunBiz, tenant.slug otherwise) and FAILS CLOSED: an unknown
 * tenant gets neutral content and NO stage vocabulary rather than another
 * tenant's. Offering SunBiz stage keys to a foreign tenant is not cosmetic —
 * step_outcomes writes those keys into that tenant's lead rows on submit.
 *
 * PURE + CLIENT-SAFE by design (no next/*, no db) so the client builder
 * components can import it directly, same posture as lib/role-surfaces.
 */

import type { FormBranding, FormStep } from "./types";
import { formThemesForTenant, getFormTheme } from "./themes";
import {
  LEAD_PIPELINE_STAGES,
  OPPORTUNITY_PIPELINE_STAGES,
} from "@/lib/sunbiz-stage-meta";
import { OASIS_LEAD_STAGES } from "@/lib/oasis-stage-meta";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";

/** The SunBiz profile slug — the ONE tenant the SunBiz form presets belong to. */
export const SUNBIZ_PROFILE_SLUG = "sun";

export function isSunbizFormsTenant(profileSlug: string | null | undefined): boolean {
  return (profileSlug || "").trim().toLowerCase() === SUNBIZ_PROFILE_SLUG;
}

// ---------------------------------------------------------------- stages

export type FormStageGroup = {
  label: string;
  options: { value: string; label: string }[];
};

/**
 * The pipeline-stage vocabulary the builder's "what happens after each step?"
 * dropdown may offer, per tenant.
 *
 *   sun            → SunBiz Lead + Opportunity pipelines (unchanged).
 *   OASIS surfaces → the OASIS Website-Sales-Engine lead lifecycle.
 *   anything else  → [] — fail closed. No registered vocabulary means the
 *                    dropdown offers only "don't change the stage"; it never
 *                    offers another tenant's stage keys, because a picked key
 *                    is written into that tenant's lead rows on submit.
 */
export function formStageGroupsForTenant(
  profileSlug: string | null | undefined,
): FormStageGroup[] {
  if (isSunbizFormsTenant(profileSlug)) {
    return [
      {
        label: "Lead Pipeline",
        options: LEAD_PIPELINE_STAGES.map((s) => ({ value: s.key, label: s.label })),
      },
      {
        label: "Opportunity Pipeline",
        options: OPPORTUNITY_PIPELINE_STAGES.map((s) => ({ value: s.key, label: s.label })),
      },
    ];
  }
  if (isOasisSurfaceTenant(profileSlug)) {
    return [
      {
        label: "Lead Pipeline",
        options: OASIS_LEAD_STAGES.map((s) => ({ value: s.key, label: s.label })),
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------- starter

export type StarterForm = {
  branding: FormBranding;
  steps: FormStep[];
  step_outcomes: Record<string, string>;
  on_complete_stage: string | null;
  enabled: boolean;
};

/**
 * SunBiz starter — the historical default, unchanged. Document field name
 * `bank_statements` matches the submit-route doc classifier (migration 049)
 * and the Telegram bank hook; stage keys are SunBiz pipeline keys.
 */
function sunbizStarterForm(): Omit<StarterForm, "branding"> {
  return {
    steps: [
      {
        key: "basic",
        title: "Tell us about your business",
        description: "A few quick questions to get started.",
        fields: [
          { name: "business_name", label: "Business name", type: "text", required: true },
          { name: "contact_name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "phone", label: "Phone", type: "phone", required: true },
          { name: "monthly_revenue", label: "Monthly revenue", type: "currency" },
        ],
      },
      {
        key: "documents",
        title: "Upload your documents",
        description:
          "Drag and drop everything here — bank statements, driver's license, voided check. As many files as you need.",
        fields: [
          {
            name: "bank_statements",
            label: "Your documents",
            help: "Last 3+ months of business bank statements (all accounts), plus your driver's license and a voided check if you have them. PDF or clear photos. Add as many as you need.",
            type: "file_upload_multi",
            required: true,
            accept: ["application/pdf", "image/*"],
            max_files: 50,
            max_file_mb: 25,
          },
        ],
      },
    ],
    step_outcomes: { "0": "sent_application" },
    on_complete_stage: "submitted",
    enabled: true,
  };
}

/**
 * Neutral starter for every other tenant: one contact step, no document
 * collection, and — deliberately — NO stage transitions. Stage keys are
 * tenant vocabulary; the operator picks them in the builder from the list
 * `formStageGroupsForTenant` returns for THEIR tenant.
 */
function genericStarterForm(): Omit<StarterForm, "branding"> {
  return {
    steps: [
      {
        key: "basic",
        title: "Tell us about you",
        description: "A few quick questions to get started.",
        fields: [
          { name: "contact_name", label: "Your name", type: "text", required: true },
          { name: "business_name", label: "Company", type: "text" },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "phone", label: "Phone", type: "phone" },
          {
            name: "project_details",
            label: "What do you need?",
            type: "textarea",
            help: "A sentence or two is plenty — we'll follow up with the details.",
          },
        ],
      },
    ],
    step_outcomes: {},
    on_complete_stage: null,
    enabled: true,
  };
}

/**
 * The complete "New form" payload for a tenant. SunBiz gets its branded
 * starter; everyone else gets neutral colors with THEIR OWN name as the
 * headline and THEIR OWN logo — never another tenant's brand.
 */
export function starterFormForTenant(
  profileSlug: string | null | undefined,
  tenantName: string | null | undefined,
  tenantLogoUrl: string | null | undefined,
): StarterForm {
  if (isSunbizFormsTenant(profileSlug)) {
    const base = getFormTheme("sunbiz_standard")!.branding;
    return {
      branding: tenantLogoUrl ? { ...base, logo_url: tenantLogoUrl } : base,
      ...sunbizStarterForm(),
    };
  }
  // First neutral theme = the default look; headline is the tenant's own name.
  const theme = formThemesForTenant(profileSlug)[0];
  const branding: FormBranding = {
    ...theme.branding,
    ...(tenantName && tenantName.trim() ? { headline: tenantName.trim() } : {}),
    ...(tenantLogoUrl ? { logo_url: tenantLogoUrl } : {}),
  };
  return { branding, ...genericStarterForm() };
}
