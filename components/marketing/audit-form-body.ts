import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { normalizePhoneE164 } from "@/lib/conversation-threading";
import { appendPreservedParams, isSafeInternalPath } from "@/lib/offers/preserve-query";

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
export const AUDIT_CONSENT_FIELDS = {
  email: "consent_email",
  sms: "consent_sms",
} as const;
export const AUDIT_ATTRIBUTION_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "kw",
  "cat",
] as const;

/**
 * Non-PII signal that the homepage already submitted step 0 before following
 * the freshly minted personalized link. The token page accepts this handoff
 * only for OASIS's ai-audit form; every other personalized link still opens
 * on its first step.
 */
export const AUDIT_FORM_HANDOFF = {
  markerParam: "handoff",
  markerValue: "homepage-audit-step-0",
  stepParam: "step",
  nextStep: 1,
} as const;

export type AuditFormField = (typeof AUDIT_FORM_FIELDS)[number];
export type AuditAttributionField = (typeof AUDIT_ATTRIBUTION_FIELDS)[number];
export type AuditAttribution = Partial<Record<AuditAttributionField, string>>;

export type AuditFormContext = {
  /** The public page that held the inline form, never a signed lead URL. */
  submissionPath: string;
  /** Per-tab, browser-generated funnel visit id. Null means tracking is unavailable. */
  visitId: string | null;
  attribution: AuditAttribution;
};

const MISSING_LABEL: Record<(typeof AUDIT_FORM_REQUIRED)[number], string> = {
  name: "your name",
  email: "your work email",
  phone: "your mobile number",
  company: "your company",
};

export function auditAttributionFromSearch(search: string): AuditAttribution {
  const params = new URLSearchParams(search);
  const attribution: AuditAttribution = {};
  for (const key of AUDIT_ATTRIBUTION_FIELDS) {
    const value = params.get(key)?.trim();
    if (value) attribution[key] = value;
  }
  return attribution;
}

export function auditFormBody(form: FormData, context: AuditFormContext) {
  const payload = Object.fromEntries(
    AUDIT_FORM_FIELDS.map((key) => [key, String(form.get(key) ?? "").trim()]),
  ) as Record<AuditFormField, string>;
  const submissionPath = isSafeInternalPath(context.submissionPath)
    ? context.submissionPath
    : AUDIT_FUNNEL.path;
  return {
    step_index: 0,
    anonymous_init: {
      tenant_slug: AUDIT_FUNNEL.tenantSlug,
      form_slug: AUDIT_FUNNEL.formSlug,
    },
    payload,
    consent_ledger: {
      email: form.get(AUDIT_CONSENT_FIELDS.email) === "true",
      sms: form.get(AUDIT_CONSENT_FIELDS.sms) === "true",
    },
    submission_path: submissionPath,
    ...(context.visitId ? { visit_id: context.visitId } : {}),
    ...context.attribution,
  };
}

/**
 * Carry first-touch attribution into the canonical funnel after step 0.
 * `v` is the established URL alias for the per-tab visit id used by
 * FormPublicClient's cross-form navigation. The id also remains in
 * sessionStorage; the query copy keeps links produced by that page joined to
 * the same visit without exposing any contact field.
 */
export function auditFormContinuationPath(path: string, context: AuditFormContext): string {
  return appendPreservedParams(path, {
    ...context.attribution,
    v: context.visitId ?? undefined,
    [AUDIT_FORM_HANDOFF.markerParam]: AUDIT_FORM_HANDOFF.markerValue,
    [AUDIT_FORM_HANDOFF.stepParam]: String(AUDIT_FORM_HANDOFF.nextStep),
  });
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
