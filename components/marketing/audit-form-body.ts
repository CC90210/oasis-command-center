import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { normalizePhoneE164 } from "@/lib/conversation-threading";

/**
 * What the homepage audit form sends: step 0 of the live `ai-audit` funnel
 * (lib/forms/oasis-ai-audit-seed.ts), every field it declares, in its order.
 *
 * Kept out of AuditForm.tsx so the exact request body is testable without a
 * DOM: tests/audit-form-fields.test.ts pins these lists to the seed and checks
 * that the form sends what auditFormBody() builds. From 2026-08-20 to
 * 2026-10-08 the seed required phone and the form never sent it, so every
 * inline submit was refused.
 */
export const AUDIT_FORM_FIELDS = ["name", "email", "phone", "company", "website"] as const;
export const AUDIT_FORM_REQUIRED = ["name", "email", "phone", "company"] as const;

export type AuditFormField = (typeof AUDIT_FORM_FIELDS)[number];

const MISSING_LABEL: Record<(typeof AUDIT_FORM_REQUIRED)[number], string> = {
  name: "your name",
  email: "your work email",
  phone: "your mobile number",
  company: "your company",
};

export function auditFormBody(form: FormData) {
  const payload = Object.fromEntries(
    AUDIT_FORM_FIELDS.map((key) => [key, String(form.get(key) ?? "").trim()]),
  ) as Record<AuditFormField, string>;
  return {
    step_index: 0,
    anonymous_init: {
      tenant_slug: AUDIT_FUNNEL.tenantSlug,
      form_slug: AUDIT_FUNNEL.formSlug,
    },
    payload,
  };
}

/**
 * Why the form cannot be sent yet, in words the visitor can act on, or null.
 *
 * Checked BEFORE the POST. The browser's `required` accepts a value of only
 * spaces, which trims to nothing, and the submit route writes the lead before
 * it validates, so a refused submit would still leave a half-made lead behind.
 */
export function auditFormProblem(payload: Record<AuditFormField, string>): string | null {
  const missing = AUDIT_FORM_REQUIRED.filter((key) => !payload[key]);
  if (missing.length > 0) {
    const labels = missing.map((key) => MISSING_LABEL[key]);
    const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
    return `Please add ${list}.`;
  }
  if (!normalizePhoneE164(payload.phone)) {
    return "That mobile number doesn't look right. Include the country code, like +1 514 555 0123.";
  }
  return null;
}
