/**
 * oasis-ai-audit-seed.ts — the OASIS AI Solutions B2B qualification funnel.
 *
 * Public URL: https://oasisai.work/f/oasis-ai-cc/ai-audit
 *
 * WHY THIS IS A SECOND FORM, NOT AN EDIT TO `start`.
 * `oasis-funnel-seed.ts` (slug `start`) is CC's live PERSONAL-BRAND funnel: a
 * 3-branch flow covering AI automation, DJ bookings and brand coaching. This
 * funnel is pure B2B agency qualification — company, bottleneck, budget,
 * timeline — and has no DJ or brand path. Rewriting `start` in place would have
 * silently deleted two working inbound lead paths from a production URL. Two
 * forms, one renderer, zero destruction. Point the primary CTA at whichever one
 * you want; it is a one-line change in the marketing site.
 *
 * FOUR STEPS, ORDERED BY FRICTION — the cheapest question first. Identity is
 * step 1 because a half-finished form still yields a contactable lead: the
 * submit endpoint upserts on every step, not only on completion, so an abandon
 * at step 3 is still a lead with a name, an email and a stated bottleneck.
 * Asking budget first would invert that and lose the abandoners entirely.
 *
 * Ingests through app/api/forms/submit/route.ts (lead upsert, stage transition,
 * rate limiting, HMAC) — the same hardened path every other tenant form uses.
 *
 * Source of truth for the shape. Editing this file changes NOTHING until the
 * seed is re-run — the definition lives in the `forms` table:
 *   node --env-file=.env.local --import tsx scripts/seed-ai-audit-funnel.ts --apply
 */
import type { FormBranding, FormStep } from "./types";

/** Public slug → /f/oasis-ai-cc/ai-audit */
export const AI_AUDIT_SLUG = "ai-audit";

/** CC's own tenant — same tenant as the personal-brand funnel. */
export const AI_AUDIT_TENANT_SLUG = "oasis-ai-cc";
export const AI_AUDIT_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

export const AI_AUDIT_NAME = "AI Automation Audit";
export const AI_AUDIT_DESCRIPTION =
  "OASIS AI Solutions B2B qualification funnel — bottleneck, scale, budget, timeline.";

/** Leads land at new_contact, same as the personal-brand funnel. */
export const AI_AUDIT_ON_COMPLETE_STAGE = "new_contact";

export const AI_AUDIT_BRANDING: FormBranding = {
  // Deliberately NOT the default blue/purple gradient. Gold on near-black is
  // the established OASIS mark, already used by `start` — consistency with the
  // brand beats novelty, and it is the opposite of generic SaaS chrome.
  primary_color: "#e8c547",
  accent_color: "#faf9f5",
  headline: "Find the 20 hours a month you're losing",
  subheadline:
    "Four questions. I'll map where AI actually pays off in your business — and where it doesn't. No pitch deck, no retainer talk until it's obvious it's worth it.",
  thanks_message:
    "Got it. I'm reading this myself, not a bot — expect a specific answer about YOUR bottleneck, not a brochure.",
};

export const AI_AUDIT_STEPS: FormStep[] = [
  // ── Step 1 — Identity & Business ──────────────────────────────────────────
  // Cheapest possible step. Four fields, two required. Getting email early is
  // what makes an abandoned form still worth something.
  {
    key: "identity",
    title: "First — who am I talking to?",
    description: "Takes about 20 seconds. I read every one of these personally.",
    cta_label: "Next",
    fields: [
      {
        name: "name",
        label: "Your name",
        type: "text",
        required: true,
        placeholder: "First + last",
      },
      {
        name: "email",
        label: "Work email",
        type: "email",
        required: true,
        placeholder: "you@company.com",
        help: "Where the audit lands. I don't add anyone to a newsletter.",
      },
      {
        name: "company",
        label: "Company name",
        type: "text",
        required: true,
        placeholder: "Acme HVAC",
      },
      {
        name: "website",
        label: "Website or social handle",
        type: "text",
        placeholder: "acme.com  ·  @acmehvac",
        help: "Optional — but it lets me look at your actual setup before we speak.",
      },
    ],
  },

  // ── Step 2 — Operational Bottleneck ───────────────────────────────────────
  // The qualifying question. A problem-led question rather than a product-led
  // one (NEPQ): what is broken, not which package do you want.
  {
    key: "bottleneck",
    title: "Where's the bottleneck right now?",
    description:
      "Be honest about the messy one — that's usually where the money is.",
    cta_label: "Next",
    fields: [
      {
        name: "automation_goal",
        label: "What would you most want AI to take off your plate?",
        type: "select",
        required: true,
        options: [
          {
            value: "sales_leadgen",
            label: "Sales & lead gen — finding and following up with prospects",
          },
          {
            value: "customer_support",
            label: "Customer support — answering the same questions all day",
          },
          {
            value: "workflow_automation",
            label: "Workflow automation — the manual admin between systems",
          },
          {
            value: "agent_fleet",
            label: "A custom AI agent fleet — I want the whole operation running itself",
          },
        ],
      },
      {
        name: "bottleneck_detail",
        label: "What does that actually look like on a bad week?",
        type: "textarea",
        placeholder:
          "e.g. leads sit in the inbox for two days because nobody owns follow-up",
        help: "One or two sentences. This is the part I actually use.",
      },
      {
        name: "tried_before",
        label: "Tried to fix it before?",
        type: "select",
        options: [
          { value: "never", label: "No — first time looking at this" },
          { value: "diy", label: "Yes — built something myself, it half-works" },
          { value: "hired", label: "Yes — hired someone, it didn't stick" },
          { value: "tools", label: "Yes — bought tools nobody uses" },
        ],
        help: "No wrong answer. It tells me what NOT to repeat.",
      },
    ],
  },

  // ── Step 3 — Scale & Budget ───────────────────────────────────────────────
  // Banded, never free-text. A range is answered honestly; an exact figure gets
  // abandoned or inflated. Both fields optional on purpose — a strong lead who
  // will not state budget is still a strong lead.
  {
    key: "scale",
    title: "How big is the operation?",
    description:
      "Rough is fine. This decides whether AI pays back in weeks or never — I'll tell you straight if it's the latter.",
    cta_label: "Next",
    fields: [
      {
        name: "monthly_revenue",
        label: "Monthly revenue",
        type: "select",
        options: [
          { value: "pre_revenue", label: "Pre-revenue / just starting" },
          { value: "under_10k", label: "Under $10K/mo" },
          { value: "10k_50k", label: "$10K – $50K/mo" },
          { value: "50k_250k", label: "$50K – $250K/mo" },
          { value: "250k_plus", label: "$250K+/mo" },
        ],
      },
      {
        name: "team_size",
        label: "Team size",
        type: "select",
        options: [
          { value: "solo", label: "Just me" },
          { value: "2_5", label: "2 – 5" },
          { value: "6_20", label: "6 – 20" },
          { value: "21_100", label: "21 – 100" },
          { value: "100_plus", label: "100+" },
        ],
      },
      {
        name: "budget",
        label: "Budget set aside for this?",
        type: "select",
        options: [
          { value: "none_yet", label: "Nothing yet — exploring what it costs" },
          { value: "under_2k", label: "Under $2K/mo" },
          { value: "2k_5k", label: "$2K – $5K/mo" },
          { value: "5k_15k", label: "$5K – $15K/mo" },
          { value: "15k_plus", label: "$15K+/mo" },
        ],
        help: "Optional. Skipping it doesn't disqualify you — it just changes what I propose.",
      },
    ],
  },

  // ── Step 4 — Timeline & Urgency ───────────────────────────────────────────
  // Last, because it is the question most likely to make someone hesitate. By
  // here the lead is already captured, so hesitation costs nothing.
  {
    key: "timeline",
    title: "Last one — when do you want this working?",
    description: "Sets whether I send you the audit or we just get on a call.",
    cta_label: "Send me the audit",
    fields: [
      {
        name: "timeframe",
        label: "Ideal timeline",
        type: "select",
        required: true,
        options: [
          { value: "immediate", label: "Immediately — it's costing me money right now" },
          { value: "30_days", label: "Next 30 days" },
          { value: "quarter", label: "This quarter" },
          { value: "exploring", label: "Just exploring — no timeline yet" },
        ],
      },
      {
        name: "wants_call",
        label: "Want to skip the back-and-forth and just book a call?",
        type: "select",
        options: [
          { value: "yes", label: "Yes — send me times" },
          { value: "audit_first", label: "Send the audit first, then we'll talk" },
        ],
        help: "Either is fine. The audit is free regardless.",
      },
      {
        name: "phone",
        label: "Phone (optional)",
        // "phone", not "tel" — FormFieldType (lib/forms/types.ts:29) has no
        // "tel" member. Caught by tsc, not by me: I had inferred the name from
        // a grep of the renderer instead of reading the union.
        type: "phone",
        placeholder: "+1 …",
        help: "Only used if you asked for a call.",
      },
    ],
  },
];

/**
 * Assemble the `forms` table row (minus DB-generated id/timestamps).
 * Mirrors buildOasisFunnelRow so both funnels seed through the same shape.
 */
export function buildAiAuditFunnelRow(tenantId: string = AI_AUDIT_TENANT_ID) {
  return {
    tenant_id: tenantId,
    slug: AI_AUDIT_SLUG,
    name: AI_AUDIT_NAME,
    description: AI_AUDIT_DESCRIPTION,
    branding: AI_AUDIT_BRANDING,
    steps: AI_AUDIT_STEPS,
    on_complete_stage: AI_AUDIT_ON_COMPLETE_STAGE,
    step_outcomes: {} as Record<string, string>,
    enabled: true,
    redirect_url: null as string | null,
    created_by: null as string | null,
  };
}
