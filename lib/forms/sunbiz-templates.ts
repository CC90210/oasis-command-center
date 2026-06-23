/**
 * lib/forms/sunbiz-templates.ts — canonical SunBiz intake-form definitions.
 *
 * SINGLE SOURCE OF TRUTH for the three SunBiz funnel forms' field schema.
 * Consumed by:
 *   - app/api/forms/templates/sunbiz/[step]/route.ts  (create-from-template button)
 *   - scripts/reseed-sunbiz-forms.ts                  (push template → live forms.steps)
 *
 * Keeping this here (not inline in the route) means a re-seed and a fresh
 * template create produce IDENTICAL forms — no drift between "the button" and
 * "the live form." Edit the shape here, then re-run the re-seed script.
 *
 * Field shapes conform exactly to lib/forms/types.ts FormField / FormStep (the
 * same validator /api/forms POST runs).
 */

import type { FormField, FormStep } from "./types";

// ---------------------------------------------------------------------------
// Canonical slug set — the single source of truth for detection logic.
// SunBizFormsClient.tsx matches against these same values.
// ---------------------------------------------------------------------------
export const SUNBIZ_SLUGS = new Set([
  "initial-lead-capture",
  "full-application",
  "bank-statement-upload",
]);

export type SunBizStep =
  | "initial-lead-capture"
  | "full-application"
  | "bank-statement-upload";

// ---------------------------------------------------------------------------
// SOP §4 compliance inputs. business_state (2-letter) + industry (slug) feed
// the lender restricted-states / restricted-industries hard-gates in
// lib/lenders/match-fitness.ts. These MUST match scripts/seed_sunbiz_application_form_fields.py
// (US_STATES / SUNBIZ_INDUSTRIES) verbatim so a template regenerate and a live
// re-seed produce identical option sets. application-upsert.ts normalize()
// upper-cases the state + lower-cases the industry, so the stored value matches
// the lender catalog regardless of display label.
// ---------------------------------------------------------------------------
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
];

export const SUNBIZ_INDUSTRIES = [
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

const SUNBIZ_DOCUMENTS_FIELD: FormField = {
  // One bucket for all required funding docs. The server classifies each file
  // by filename so statements, license photos, and voided checks get their real
  // doc_type while the public form stays simple.
  name: "bank_statements",
  label: "Your documents",
  type: "file_upload_multi",
  required: true,
  accept: ["application/pdf", "image/*"],
  max_files: 50,
  max_file_mb: 25,
  help: "Drag and drop all your documents - last 3+ months of business bank statements (all accounts), plus your driver's license and a voided check if you have them. PDF or clear photos. Add as many as you need.",
};

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export type SunBizFormTemplate = {
  name: string;
  description: string;
  steps: FormStep[];
  step_outcomes: Record<string, string>;
  on_complete_stage: string;
};

export const SUNBIZ_FORM_TEMPLATES: Record<SunBizStep, SunBizFormTemplate> = {
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
          // 2026-06-20 (Ethan/Alex): monthly_revenue REMOVED from the first
          // intake form — it's redundant with the full application's financial
          // step, and the full application pre-fills any value the merchant gave
          // earlier. Keep this form to the essential contact + business fields.
          { name: "business_name", label: "Business name", type: "text", required: true },
          { name: "contact_name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "phone", label: "Phone", type: "phone", required: true },
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
          {
            name: "business_legal_name",
            label: "Legal business name",
            type: "text",
            required: true,
            // Pre-fill from the business name the merchant gave on intake (editable).
            prefill_from: "business_name",
          },
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
            type: "address",
            required: true,
            placeholder: "Start typing your business address…",
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
            type: "combobox",
            required: true,
            help: "Pick the closest match — or type your own if it isn't listed.",
            options: SUNBIZ_INDUSTRIES.map((v) => ({ value: v, label: titleCase(v) })),
          },
        ],
      },
      // Step 1 - Documents. Anonymous full-application links mint the upload
      // token on step 0, so placing file_upload_multi here lets merchants upload
      // immediately in the same application flow.
      {
        key: "documents",
        title: "Upload your documents",
        description:
          "Add the documents needed to start your funding review.",
        cta_label: "Continue",
        fields: [{ ...SUNBIZ_DOCUMENTS_FIELD }],
      },
      // Step 2 — Primary owner
      {
        key: "owner",
        title: "Owner information",
        description: "Primary owner's personal details.",
        cta_label: "Continue",
        fields: [
          {
            name: "owner_full_name",
            label: "Full legal name",
            type: "text",
            required: true,
            // Pre-fill from the contact name captured on intake (editable).
            prefill_from: "contact_name",
          },
          {
            name: "owner_ssn",
            label: "Social Security Number (SSN)",
            type: "text",
            required: true,
            placeholder: "XXX-XX-XXXX",
          },
          { name: "owner_dob", label: "Date of birth", type: "date", required: true },
          {
            name: "owner_cell",
            label: "Cell phone",
            type: "phone",
            required: true,
            // Pre-fill from the phone captured on intake (editable).
            prefill_from: "phone",
          },
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
            type: "address",
            required: true,
            placeholder: "Start typing your home address…",
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
            type: "address",
            required: false,
            placeholder: "Start typing your home address…",
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
            // Pre-fill if the merchant gave revenue on a prior step (editable).
            prefill_from: "monthly_revenue",
          },
          {
            name: "applicant_fico",
            label: "Credit Score (FICO)",
            type: "number",
            required: true,
            min: 300,
            max: 850,
            placeholder: "e.g. 680",
            help: "An estimate is okay - this helps us match you with lenders that fit your profile.",
          },
          {
            name: "requested_advance",
            label: "Requested advance amount",
            type: "currency",
            required: true,
          },
        ],
      },
      // Step 5 — Signature, the FINAL step.
      {
        key: "signature",
        title: "Sign and submit",
        description:
          "Sign below, type your name, and check the box to confirm that all information provided is accurate to the best of your knowledge.",
        cta_label: "Submit application",
        fields: [
          {
            name: "applicant_signature",
            label: "Sign here",
            type: "signature",
            required: true,
            help: "Draw your signature — works with your finger on a phone or your mouse on a computer.",
          },
          {
            name: "signature_name",
            label: "Type your full legal name",
            type: "text",
            required: true,
            placeholder: "Full name as it appears on your ID",
            // Defaults to the legal name captured on the Owner step so the
            // applicant doesn't retype it (Fix 1.1). Still editable.
            prefill_from: "owner_full_name",
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
      // Signature is step index 5 because documents are collected in-flow after
      // the first business step.
      "5": "signed_application",
    },
    // 2026-06-18 (CC): `submitted` stage removed — completion lands on
    // signed_application (the last lead milestone). Underwriting auto-runs when
    // the merchant completes the full application with documents attached.
    on_complete_stage: "signed_application",
  },

  "bank-statement-upload": {
    name: "Bank Statement Upload",
    description:
      "Lightweight follow-up form for any lead missing documents. One drag-and-drop bucket for all of them.",
    steps: [
      {
        key: "upload",
        title: "Upload your documents",
        description:
          "Drag and drop everything here — bank statements, driver's license, voided check. As many files as you need.",
        cta_label: "Submit",
        fields: [
          {
            ...SUNBIZ_DOCUMENTS_FIELD,
          },
        ],
      },
    ],
    // 2026-06-18 (CC): the bank-statement-upload form is doc-collection ONLY —
    // it does NOT advance the lead stage. (It used to land on `submitted`,
    // removed by CC. Landing it on `signed_application` would re-fire the
    // "upload your bank statements" nag at a merchant who just uploaded them —
    // see lib/sunbiz-default-sequences.ts seq 7.) The operator runs underwriting
    // from the Bank tab; "statements received" is signalled by the uploaded docs
    // + the form's lead_interaction, not a stage. Empty step_outcomes + empty
    // on_complete_stage ⇒ submit/route.ts targetStage resolves to null ⇒ no
    // transition.
    step_outcomes: {},
    on_complete_stage: "",
  },
};
