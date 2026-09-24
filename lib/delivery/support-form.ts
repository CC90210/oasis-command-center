/**
 * lib/delivery/support-form.ts — the "Client Support Ticket" public form.
 *
 * Public URL: /f/oasis-ai-cc/support
 *
 * WHAT MAKES THIS FORM DIFFERENT FROM EVERY OTHER FORM IN THE TABLE.
 * Every other public form creates (or smart-matches) a LEAD and may move it
 * through a pipeline stage, which is what enrols it in drips. A support request
 * is from someone who is already a client. Turning it into a lead would put a
 * paying client back into a sales cadence — the exact opposite of support. So a
 * submission to this form becomes a `support_tickets` row and nothing else.
 *
 * HOW THE FORMS MODULE KNOWS. The `forms` table has no kind/type/template
 * column. The existing special forms (`start`, `ai-audit`) are recognised by an
 * EXACT (tenant, slug) pair declared in a seed module, and the submit route
 * gates on that pair. This form uses the same mechanism rather than adding a
 * column to a table SunBiz shares: a new column would need a migration applied
 * BEFORE the code that reads it deploys, or every public form on the platform
 * would 500 — a cross-portal deploy-ordering hazard bought for one form.
 *
 * The (tenant, slug) gate is pure string comparison on the request body, so it
 * adds no query and no failure mode to any other form's submission.
 *
 * SOURCE OF TRUTH. Migration database/turso/183_delivery_and_support.turso.sql
 * seeds this exact definition (idempotently). tests/delivery-support-form.test.ts
 * parses the JSON out of that migration and asserts it equals the constants
 * below, so the two cannot drift silently.
 *
 * THE FORM MUST STAY ONE STEP. The support branch in /api/forms/submit handles
 * step 0 only and never mints a lead token (a token is bound to a lead), so a
 * second step would be unreachable. The intake refuses loudly if an operator
 * edits the form into several steps — see handleSupportFormSubmission.
 */
import type { FormBranding, FormStep } from "@/lib/forms/types";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";

/** The OASIS workspace (slug `oasis-ai-cc`). Same constant the funnels use. */
export const SUPPORT_FORM_TENANT_ID = WEBDEV_TENANT_ID;
export const SUPPORT_FORM_TENANT_SLUG = "oasis-ai-cc";
export const SUPPORT_FORM_SLUG = "support";
export const SUPPORT_FORM_NAME = "Client Support Ticket";
export const SUPPORT_FORM_DESCRIPTION =
  "Clients report an issue or request a change. Every submission becomes a support " +
  "ticket (never a lead) with a ticket number, a first-response SLA and a confirmation email.";

/** Relative public path. The page is served by app/f/[tenant_slug]/[form_slug]. */
export const SUPPORT_FORM_PATH = `/f/${SUPPORT_FORM_TENANT_SLUG}/${SUPPORT_FORM_SLUG}`;

/** Server-side cap for the optional screenshot (the browser allows 15 MB). */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

/**
 * Do the file's first bytes carry this type's signature? A type in the
 * allowlist above with no signature here is refused, never waved through.
 */
export function attachmentBytesMatchType(bytes: Uint8Array, mimeType: string): boolean {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  switch (mimeType) {
    case "application/pdf":
      return startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8); // "RIFF" .... "WEBP"
    default:
      return false;
  }
}

/**
 * Which allowed type the file's first bytes say it is, or null for none. The
 * declared type is only what the sender's request body says (a browser takes it
 * from the file's extension, so a JPEG screenshot saved as .png arrives as
 * image/png). The intake stores, and so later serves, a file under the type
 * its bytes prove, never the declared one.
 */
export function sniffAttachmentType(bytes: Uint8Array): string | null {
  return SUPPORT_ATTACHMENT_MIME.find((type) => attachmentBytesMatchType(bytes, type)) ?? null;
}

export const SUPPORT_FORM_BRANDING: FormBranding = {
  // The established OASIS mark, same as `start`, `ai-audit` and client onboarding.
  primary_color: "#e8c547",
  accent_color: "#faf9f5",
  headline: "OASIS Support",
  subheadline:
    "Report a problem or ask for a change. Every request gets a ticket number and a reply from the team.",
  thanks_message:
    "Thanks, your ticket is in. A confirmation with your ticket number is on its way to your inbox.",
};

export const SUPPORT_FORM_STEPS: FormStep[] = [
  {
    key: "request",
    title: "How can we help?",
    description: "Tell us what is going on. We reply by email and quote your ticket number.",
    cta_label: "Submit ticket",
    fields: [
      {
        name: "name",
        label: "Your name",
        type: "text",
        required: true,
        placeholder: "Full name",
        maxLength: 120,
      },
      {
        name: "email",
        label: "Your email",
        type: "email",
        required: true,
        placeholder: "you@yourbusiness.com",
        help: "We reply here, and it is how we match the request to your project.",
      },
      {
        name: "company",
        label: "Company",
        type: "text",
        placeholder: "Your business name",
        maxLength: 160,
      },
      {
        name: "project",
        label: "Which project is this about?",
        type: "text",
        placeholder: "Your website or automation, if you know it",
        help: "Optional. We look your project up from your email either way.",
        maxLength: 160,
      },
      {
        name: "category",
        label: "What kind of request is it?",
        type: "select",
        required: true,
        options: [
          { value: "bug", label: "Something is broken" },
          { value: "change_request", label: "I want something changed" },
          { value: "question", label: "I have a question" },
          { value: "billing", label: "Billing" },
          { value: "other", label: "Something else" },
        ],
      },
      {
        name: "priority",
        label: "How urgent is it?",
        type: "select",
        required: true,
        options: [
          { value: "low", label: "Low: whenever you can" },
          { value: "medium", label: "Medium: this week" },
          { value: "high", label: "High: it is hurting the business" },
          { value: "critical", label: "Critical: something is down right now" },
        ],
      },
      {
        name: "description",
        label: "What is happening?",
        type: "textarea",
        required: true,
        placeholder: "What you expected, what happened instead, and where (a page link helps).",
        maxLength: 5000,
      },
      {
        name: "attachment",
        label: "Screenshot or file",
        type: "file_upload",
        accept: [...SUPPORT_ATTACHMENT_MIME],
        help: "Optional. PDF, PNG, JPEG or WebP, up to 10 MB.",
      },
    ],
  },
];

/** The `forms` row this seed writes (minus the DB-generated id/timestamps). */
export function buildSupportFormRow() {
  return {
    tenant_id: SUPPORT_FORM_TENANT_ID,
    slug: SUPPORT_FORM_SLUG,
    name: SUPPORT_FORM_NAME,
    description: SUPPORT_FORM_DESCRIPTION,
    branding: SUPPORT_FORM_BRANDING,
    steps: SUPPORT_FORM_STEPS,
    // No lead, so no stage. Null is also what keeps the generic submit path
    // from ever transitioning anything if this form were reached some other way.
    on_complete_stage: null as string | null,
    step_outcomes: {} as Record<string, string>,
    enabled: true,
    redirect_url: null as string | null,
  };
}
