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
import type { FormStep } from "@/lib/forms/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Canonical slug set — the single source of truth for detection logic.
// SunBizFormsClient.tsx matches against these same values.
// ---------------------------------------------------------------------------
const SUNBIZ_SLUGS = new Set([
  "initial-lead-capture",
  "full-application",
  "bank-statement-upload",
]);

// ---------------------------------------------------------------------------
// SOP §4 compliance inputs. business_state (2-letter) + industry (slug) feed
// the lender restricted-states / restricted-industries hard-gates in
// lib/lenders/match-fitness.ts. These MUST match scripts/seed_sunbiz_application_form_fields.py
// (US_STATES / SUNBIZ_INDUSTRIES) verbatim so a template regenerate and a live
// re-seed produce identical option sets. application-upsert.ts normalize()
// upper-cases the state + lower-cases the industry, so the stored value matches
// the lender catalog regardless of display label.
// ---------------------------------------------------------------------------
const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
];

const SUNBIZ_INDUSTRIES = [
  "restaurant", "retail", "ecommerce", "trucking", "transportation",
  "construction", "auto", "auto_repair", "auto_sales", "beauty_salon",
  "barbershop", "spa", "medical_practice", "dental_practice", "veterinary",
  "fitness_gym", "professional_services", "law_firm", "accounting",
  "real_estate", "wholesale", "manufacturing", "agriculture", "landscaping",
  "cleaning", "moving_storage", "hospitality_hotel", "bar_nightclub",
  "convenience_store", "gas_station", "liquor_store", "pharmacy",
  "cannabis", "staffing", "childcare", "other",
];

const titleCase = (slug: string) =>
  slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

type SunBizStep =
  | "initial-lead-capture"
  | "full-application"
  | "bank-statement-upload";

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const TEMPLATES: Record<
  SunBizStep,
  {
    name: string;
    description: string;
    steps: FormStep[];
    step_outcomes: Record<string, string>;
    on_complete_stage: string;
  }
> = {
  "initial-lead-capture": {
    name: "Initial Lead Capture",
    description:
      "First touch. Captures business name, contact, phone, email, and a one-line note. Sent via personalized link.",
    steps: [
      {
        key: "lead",
        title: "Tell us about your business",
        description: "A few quick fields — takes under a minute.",
        cta_label: "Submit",
        fields: [
          { name: "business_name", label: "Business name", type: "text", required: true },
          { name: "contact_name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "phone", label: "Phone", type: "phone", required: true },
          {
            name: "monthly_revenue",
            label: "Monthly revenue",
            type: "currency",
            required: false,
            help: "Rough average is fine — helps us route your file faster.",
          },
          {
            name: "note",
            label: "Anything we should know?",
            type: "textarea",
            required: false,
            maxLength: 200,
            placeholder: "Optional — e.g. best time to call, specific need...",
          },
        ],
      },
    ],
    // Lands at intent_inquiry_submitted — the merchant has expressed intent
    // (name/business/email/phone/revenue) but hasn't applied yet. The handoff
    // email (full-application + bank-statement links) fires on submit; the lead
    // advances when they complete the full application.
    step_outcomes: { "0": "intent_inquiry_submitted" },
    on_complete_stage: "intent_inquiry_submitted",
  },

  "full-application": {
    name: "Full Application",
    description:
      "Comprehensive application. All the fields a lender needs — business identity, owner info, financials, and document uploads.",
    steps: [
      // Step 0 — Business identity
      {
        key: "business",
        title: "Business information",
        description: "Your company's legal details.",
        cta_label: "Continue",
        fields: [
          { name: "business_legal_name", label: "Legal business name", type: "text", required: true },
          {
            name: "dba",
            label: "DBA (doing business as)",
            type: "text",
            required: false,
            placeholder: "If different from legal name",
          },
          {
            name: "business_address",
            label: "Business address",
            type: "text",
            required: true,
            placeholder: "Street, city, state, ZIP",
          },
          {
            name: "tax_id_ein",
            label: "Tax ID / EIN",
            type: "text",
            required: true,
            placeholder: "XX-XXXXXXX",
          },
          { name: "business_start_date", label: "Business start date", type: "date", required: true },
          {
            name: "entity_type",
            label: "Type of entity",
            type: "select",
            required: true,
            options: [
              { value: "llc", label: "LLC" },
              { value: "s_corp", label: "S-Corp" },
              { value: "c_corp", label: "C-Corp" },
              { value: "sole_proprietor", label: "Sole Proprietor" },
              { value: "partnership", label: "Partnership" },
              { value: "other", label: "Other" },
            ],
          },
          {
            name: "product_service_description",
            label: "What does your business sell or do?",
            type: "textarea",
            required: true,
            placeholder: "Brief description of your product or service",
          },
          // SOP §4 compliance inputs — discrete, machine-matchable fields on
          // top of the free-text business_address. Without these the lender
          // restricted-states / restricted-industries hard-gates stay dormant.
          {
            name: "business_state",
            label: "Business state",
            type: "select",
            required: true,
            help: "The state your business operates in — used to match you with lenders that fund your state.",
            options: US_STATES.map((s) => ({ value: s, label: s })),
          },
          {
            name: "industry",
            label: "Industry",
            type: "select",
            required: true,
            help: "Pick the closest match — routes your file to lenders that fund your industry.",
            options: SUNBIZ_INDUSTRIES.map((v) => ({ value: v, label: titleCase(v) })),
          },
        ],
      },
      // Step 1 — Primary owner
      {
        key: "owner",
        title: "Owner information",
        description: "Primary owner's personal details.",
        cta_label: "Continue",
        fields: [
          { name: "owner_full_name", label: "Full legal name", type: "text", required: true },
          {
            name: "owner_ssn",
            label: "Social Security Number (SSN)",
            type: "text",
            required: true,
            placeholder: "XXX-XX-XXXX",
          },
          { name: "owner_dob", label: "Date of birth", type: "date", required: true },
          { name: "owner_cell", label: "Cell phone", type: "phone", required: true },
          {
            name: "owner_ownership_pct",
            label: "Ownership percentage",
            type: "number",
            required: true,
            min: 1,
            max: 100,
            placeholder: "e.g. 100",
          },
          {
            name: "owner_home_address",
            label: "Home address",
            type: "text",
            required: true,
            placeholder: "Street, city, state, ZIP",
          },
        ],
      },
      // Step 2 — Partner (optional, same shape as owner — collapsible in UI)
      {
        key: "partner",
        title: "Partner / co-owner (optional)",
        description:
          "Add a second owner if applicable. If there is no partner, leave blank and continue.",
        cta_label: "Continue",
        fields: [
          { name: "partner_full_name", label: "Full legal name", type: "text", required: false },
          {
            name: "partner_ssn",
            label: "Social Security Number (SSN)",
            type: "text",
            required: false,
            placeholder: "XXX-XX-XXXX",
          },
          { name: "partner_dob", label: "Date of birth", type: "date", required: false },
          { name: "partner_cell", label: "Cell phone", type: "phone", required: false },
          {
            name: "partner_ownership_pct",
            label: "Ownership percentage",
            type: "number",
            required: false,
            min: 1,
            max: 100,
            placeholder: "e.g. 49",
          },
          {
            name: "partner_home_address",
            label: "Home address",
            type: "text",
            required: false,
            placeholder: "Street, city, state, ZIP",
          },
        ],
      },
      // Step 3 — Financial
      {
        key: "financial",
        title: "Financial details",
        description: "Revenue and advance request.",
        cta_label: "Continue",
        fields: [
          {
            name: "monthly_revenue",
            label: "Average monthly revenue",
            type: "currency",
            required: true,
          },
          {
            name: "requested_advance",
            label: "Requested advance amount",
            type: "currency",
            required: true,
          },
        ],
      },
      // Step 4 — Documents
      {
        key: "documents",
        title: "Upload your documents",
        description:
          "Three required files. PDF preferred. Each can be uploaded individually.",
        cta_label: "Continue",
        fields: [
          {
            name: "bank_statement_1",
            label: "Bank statement — month 1 (most recent)",
            type: "file_upload",
            required: true,
            accept: ["application/pdf", "image/*"],
            help: "Most recent month of your business bank account.",
          },
          {
            name: "bank_statement_2",
            label: "Bank statement — month 2",
            type: "file_upload",
            required: true,
            accept: ["application/pdf", "image/*"],
          },
          {
            name: "bank_statement_3",
            label: "Bank statement — month 3",
            type: "file_upload",
            required: true,
            accept: ["application/pdf", "image/*"],
          },
          {
            name: "drivers_license",
            label: "Driver's license (front) — optional",
            type: "file_upload",
            required: false,
            accept: ["image/*", "application/pdf"],
            help: "Optional — speeds up underwriting. Clear photo of the primary owner's license front.",
          },
          {
            name: "voided_check",
            label: "Voided check — optional",
            type: "file_upload",
            required: false,
            accept: ["application/pdf", "image/*"],
            help: "Optional — speeds up funding. From the business bank account that will receive funds.",
          },
        ],
      },
      // Step 5 — Signature
      {
        key: "signature",
        title: "Sign and submit",
        description:
          "By typing your name and checking the box below you confirm that all information provided is accurate to the best of your knowledge.",
        cta_label: "Submit application",
        fields: [
          {
            name: "signature_name",
            label: "Type your full legal name",
            type: "text",
            required: true,
            placeholder: "Full name as it appears on your ID",
          },
          {
            name: "attestation",
            label:
              "I confirm that the information submitted in this application is true, correct, and complete.",
            type: "select",
            required: true,
            options: [{ value: "agreed", label: "I agree" }],
          },
        ],
      },
    ],
    step_outcomes: {
      "0": "sent_application",
      "5": "signed_application",
    },
    on_complete_stage: "submitted",
  },

  "bank-statement-upload": {
    name: "Bank Statement Upload",
    description:
      "Lightweight follow-up form for any lead missing statements. Just 3 file slots + a confirmation checkbox.",
    steps: [
      {
        key: "upload",
        title: "Upload your bank statements",
        description:
          "Please upload the most recent 3 months of your business bank statements. PDF preferred.",
        cta_label: "Submit",
        fields: [
          {
            name: "statement_1",
            label: "Bank statement — month 1 (most recent)",
            type: "file_upload",
            required: true,
            accept: ["application/pdf"],
            help: "PDF of your most recent month.",
          },
          {
            name: "statement_2",
            label: "Bank statement — month 2",
            type: "file_upload",
            required: true,
            accept: ["application/pdf"],
          },
          {
            name: "statement_3",
            label: "Bank statement — month 3",
            type: "file_upload",
            required: true,
            accept: ["application/pdf"],
          },
          {
            name: "confirmation",
            label:
              "I confirm these are the most recent 3 months of business bank statements.",
            type: "select",
            required: true,
            options: [{ value: "confirmed", label: "Confirmed" }],
          },
        ],
      },
    ],
    step_outcomes: { "0": "submitted" },
    on_complete_stage: "submitted",
  },
};

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
    if (error.code === "23505") {
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
