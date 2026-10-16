import type { FormBranding, FormStep } from "./types";
import { AI_AUDIT_TENANT_ID } from "./oasis-ai-audit-seed";
import { BOOK_FORM_SLUG } from "./public-booking-config";

/**
 * The "Book a call" form behind oasisai.work/book (CC, 2026-10-16).
 *
 * CC: for warm inbound, the goal is a meeting on our Schedule. This is the
 * shortest path to one: a visitor picks a time first (app/book/page.tsx), then
 * gives the four details a booked call cannot go ahead without, then is booked.
 *
 * ONE STEP, so the visitor is never asked to "continue": step 0 is also the last
 * step, which makes the submit route stamp the lead `audit_requested` and unlock
 * booking for its token (lib/forms/public-booking.ts) in the same request.
 *
 * Field NAMES are the AI audit's own (name, email, phone, company,
 * automation_goal, bottleneck_detail), so the lead record, the sales-desk alert's
 * "Bottleneck" line and the founders' handoff note read this form exactly as
 * they read the audit (buildPublicFunnelLeadPatch, bookedLeadFacts).
 *
 * The phone is required because the founder-meeting service refuses a booking
 * without one (client_phone_required); asking for it here means that refusal
 * can never happen after the visitor has picked a time.
 *
 * Words are functional labels only. Maven owns the brand copy and can replace
 * any of them in the form builder without a code change. ASCII only.
 */

export const BOOK_FORM_NAME = "Book a call";
export const BOOK_FORM_DESCRIPTION =
  "The OASIS booking link: pick a time, leave your details, get a Google Meet invite.";
export const BOOK_FORM_ON_COMPLETE_STAGE = "researched";

export const BOOK_FORM_BRANDING: FormBranding = {
  primary_color: "#00D4FF",
  accent_color: "#faf9f5",
  headline: "Book a call with OASIS AI",
  subheadline: "30 minutes on Google Meet with OASIS AI. Pick a time that suits you.",
  thanks_message: "You're booked. The Google Calendar invite with the Meet link is on its way to your inbox.",
};

export const BOOK_FORM_STEPS: FormStep[] = [
  {
    key: "contact",
    title: "Your details",
    description: "So we can send the invite and know who we're meeting.",
    cta_label: "Book this time",
    fields: [
      { name: "name", label: "Your name", type: "text", required: true, placeholder: "First and last name", maxLength: 120 },
      { name: "email", label: "Email", type: "email", required: true, placeholder: "you@company.com" },
      {
        name: "phone",
        label: "Mobile number",
        type: "phone",
        required: true,
        placeholder: "+1 514 555 0101",
        help: "In case the call link gives you trouble.",
      },
      { name: "company", label: "Company", type: "text", required: true, placeholder: "Company name", maxLength: 160 },
      {
        name: "automation_goal",
        label: "What do you want help with?",
        type: "select",
        required: true,
        options: [
          { value: "sales_leadgen", label: "Sales and follow-up" },
          { value: "customer_support", label: "Customer support" },
          { value: "workflow_automation", label: "Workflows and operations" },
          { value: "agent_fleet", label: "AI agents for my team" },
          { value: "not_sure", label: "Not sure yet" },
        ],
      },
      {
        name: "bottleneck_detail",
        label: "Anything we should know before the call?",
        type: "textarea",
        placeholder: "Optional",
        maxLength: 1000,
      },
    ],
  },
];

/** The `forms` row (minus DB-generated id/timestamps), same shape as buildAiAuditFunnelRow. */
export function buildBookFormRow(tenantId: string = AI_AUDIT_TENANT_ID) {
  return {
    tenant_id: tenantId,
    slug: BOOK_FORM_SLUG,
    name: BOOK_FORM_NAME,
    description: BOOK_FORM_DESCRIPTION,
    branding: BOOK_FORM_BRANDING,
    steps: BOOK_FORM_STEPS,
    on_complete_stage: BOOK_FORM_ON_COMPLETE_STAGE,
    step_outcomes: {} as Record<string, string>,
    enabled: true,
    redirect_url: null as string | null,
    created_by: null as string | null,
  };
}
