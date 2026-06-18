/**
 * oasis-funnel-seed.ts — canonical definition of CC's personal-brand funnel.
 *
 * This replaced the standalone `cc-funnel` Vercel app (retired 2026-06-18):
 * a 3-interest funnel (AI Automation / DJing & Music / Personal Brand) where
 * picking an interest reveals only that branch's questions, via the `show_if`
 * conditional-field engine (lib/forms/visibility.ts).
 *
 * Lives in CC's own tenant (slug `oasis-ai-cc`). Public URL:
 *   https://oasisai.work/f/oasis-ai-cc/start
 *
 * Submissions ingest into the OASIS pipeline as `inbound` leads at
 * `new_contact` (see app/api/forms/submit/route.ts → initAnonymousLead), then
 * fire a Telegram ping + a Claude-personalized welcome email (the OASIS
 * notification path keyed off OASIS_FUNNEL_SLUG).
 *
 * Source of truth for the form shape. The app imports OASIS_FUNNEL_SLUG (the
 * notification gate); scripts/seed-oasis-funnel.ts imports the definition to
 * upsert the `forms` row. Re-running the seed is idempotent (upsert by
 * tenant_id + slug).
 */
import type { FormBranding, FormStep } from "./types";

/** Public slug → /f/oasis-ai-cc/start. Also the notification gate key. */
export const OASIS_FUNNEL_SLUG = "start";

/** CC's own tenant (tenants.slug). Confirmed 2026-06-18. */
export const OASIS_FUNNEL_TENANT_SLUG = "oasis-ai-cc";

/** CC's tenant_id — the seed target. Confirmed via his user_profile. */
export const OASIS_FUNNEL_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

export const OASIS_FUNNEL_NAME = "Work with CC";
export const OASIS_FUNNEL_DESCRIPTION =
  "CC's personal-brand lead funnel — AI automation, DJ bookings, brand coaching.";

/** Leads land here on completion + at create time (single-stage funnel). */
export const OASIS_FUNNEL_ON_COMPLETE_STAGE = "new_contact";

export const OASIS_FUNNEL_BRANDING: FormBranding = {
  // CC-funnel brand: gold on near-black. primary drives the CTA + accents.
  primary_color: "#e8c547",
  accent_color: "#faf9f5",
  headline: "Hey, I'm CC",
  subheadline:
    "AI automation, DJ sets, and personal brand. Tell me what you need and I'll send something free — no fluff.",
  thanks_message:
    "You're in. I'll personally follow up — keep an eye on your inbox (and your DMs).",
};

export const OASIS_FUNNEL_STEPS: FormStep[] = [
  {
    key: "interest",
    title: "What can I help you with?",
    description: "Pick what you're into — I'll hook you up with something free.",
    cta_label: "Continue",
    fields: [
      {
        name: "interests",
        label: "I'm interested in…",
        type: "multiselect",
        required: true,
        help: "Pick one or more.",
        options: [
          { value: "ai", label: "⚡ AI & Automation — free AI audit for your business" },
          { value: "music", label: "🎧 DJing & Music — book CC for your event" },
          { value: "brand", label: "🔥 Personal Brand — free 15-min strategy session" },
        ],
      },
    ],
  },
  {
    key: "details",
    title: "Tell me more",
    description: "So I can give you something actually useful — not generic fluff.",
    cta_label: "Continue",
    fields: [
      // ---- AI branch (show_if interests includes "ai") ----
      {
        name: "business_name",
        label: "Your business name",
        type: "text",
        placeholder: "Acme Co.",
        show_if: { field: "interests", includes: "ai" },
      },
      {
        name: "business_type",
        label: "What kind of business?",
        type: "select",
        required: true,
        show_if: { field: "interests", includes: "ai" },
        options: [
          { value: "service", label: "Service business (HVAC, plumbing, etc.)" },
          { value: "wellness", label: "Wellness / Health / Fitness" },
          { value: "realestate", label: "Real estate" },
          { value: "restaurant", label: "Restaurant / Hospitality" },
          { value: "ecommerce", label: "E-commerce" },
          { value: "agency", label: "Agency / Consulting" },
          { value: "other", label: "Other" },
        ],
      },
      {
        name: "biggest_pain",
        label: "What's your biggest time-waster right now?",
        type: "multiselect",
        show_if: { field: "interests", includes: "ai" },
        options: [
          { value: "lead-followup", label: "Lead follow-up" },
          { value: "scheduling", label: "Scheduling" },
          { value: "data-entry", label: "Data entry" },
          { value: "social-media", label: "Social media" },
          { value: "invoicing", label: "Invoicing" },
          { value: "customer-support", label: "Customer support" },
          { value: "email-management", label: "Email management" },
          { value: "other", label: "Other" },
        ],
      },
      // ---- Music branch (show_if interests includes "music") ----
      {
        name: "event_type",
        label: "What kind of event?",
        type: "select",
        required: true,
        show_if: { field: "interests", includes: "music" },
        options: [
          { value: "wedding", label: "Wedding" },
          { value: "corporate", label: "Corporate event" },
          { value: "party", label: "Private party" },
          { value: "bar", label: "Bar / Club night" },
          { value: "festival", label: "Festival / Outdoor" },
          { value: "other", label: "Other / Just a fan" },
        ],
      },
      {
        name: "event_date",
        label: "Rough date?",
        type: "text",
        placeholder: "e.g. June 14, or 'just browsing'",
        show_if: { field: "interests", includes: "music" },
      },
      {
        name: "music_vibe",
        label: "What vibe are you going for?",
        type: "text",
        placeholder: "e.g. house, hip-hop, open format",
        show_if: { field: "interests", includes: "music" },
      },
      // ---- Brand branch (show_if interests includes "brand") ----
      {
        name: "brand_goal",
        label: "What's your main goal?",
        type: "select",
        required: true,
        show_if: { field: "interests", includes: "brand" },
        options: [
          { value: "grow", label: "Grow my audience" },
          { value: "monetize", label: "Monetize my brand" },
          { value: "launch", label: "Launch a product / service" },
          { value: "pivot", label: "Pivot / rebrand" },
          { value: "learn", label: "Learn from someone doing it" },
        ],
      },
      {
        name: "audience",
        label: "Who's your audience?",
        type: "multiselect",
        show_if: { field: "interests", includes: "brand" },
        options: [
          { value: "entrepreneurs", label: "Entrepreneurs" },
          { value: "fitness-wellness", label: "Fitness / Wellness" },
          { value: "real-estate", label: "Real Estate" },
          { value: "local-businesses", label: "Local Businesses" },
          { value: "creators", label: "Creators" },
          { value: "other", label: "Other" },
        ],
      },
      {
        name: "current_following",
        label: "Current following size?",
        type: "select",
        show_if: { field: "interests", includes: "brand" },
        options: [
          { value: "0-500", label: "0 – 500" },
          { value: "500-2k", label: "500 – 2K" },
          { value: "2k-10k", label: "2K – 10K" },
          { value: "10k+", label: "10K+" },
        ],
      },
    ],
  },
  {
    key: "contact",
    title: "Last step — where do I reach you?",
    description:
      "I'll personally follow up. No spam, no newsletter — just the free thing you asked for.",
    cta_label: "Send me my free stuff",
    fields: [
      { name: "name", label: "Your name", type: "text", required: true, placeholder: "First + last" },
      { name: "email", label: "Email", type: "email", required: true, placeholder: "you@email.com" },
      { name: "phone", label: "Phone (optional)", type: "phone", placeholder: "+1 …" },
      {
        name: "instagram",
        label: "Instagram (optional)",
        type: "text",
        placeholder: "@yourhandle",
        help: "So I can DM you the free thing.",
      },
    ],
  },
];

/**
 * Assemble the `forms` table row (minus the DB-generated id/timestamps).
 * Used by scripts/seed-oasis-funnel.ts and any test that needs the shape.
 */
export function buildOasisFunnelRow(tenantId: string = OASIS_FUNNEL_TENANT_ID) {
  return {
    tenant_id: tenantId,
    slug: OASIS_FUNNEL_SLUG,
    name: OASIS_FUNNEL_NAME,
    description: OASIS_FUNNEL_DESCRIPTION,
    branding: OASIS_FUNNEL_BRANDING,
    steps: OASIS_FUNNEL_STEPS,
    on_complete_stage: OASIS_FUNNEL_ON_COMPLETE_STAGE,
    step_outcomes: {} as Record<string, string>,
    enabled: true,
    redirect_url: null as string | null,
    created_by: null as string | null,
  };
}
