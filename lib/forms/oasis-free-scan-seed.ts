/**
 * oasis-free-scan-seed.ts — the form behind the free scan's offer (lib/site-scan/offer.ts).
 *
 * One step: the details "Send it to the OASIS team" asks for under a finished scan
 * (components/scan/ClaimForm.tsx). The same five fields as the AI audit's first step, in the same
 * order, because the claim body is built by the same helper (components/marketing/audit-form-body.ts)
 * and only its form slug changes. A claim opens the visitor's AI audit (lib/site-scan/claim.ts):
 * the scan is the audit's free front door, and its lead lands at the same Pipeline stage.
 *
 * Editing this file changes nothing until the seed is re-run (scripts/seed-free-scan-form.ts).
 */
import type { FormBranding, FormStep } from "./types";
import { AI_AUDIT_ON_COMPLETE_STAGE, AI_AUDIT_STEPS, AI_AUDIT_TENANT_ID } from "./oasis-ai-audit-seed";
import { SCAN_OFFER_NAME, SCAN_OFFER_SLUG } from "@/lib/site-scan/offer";

export const FREE_SCAN_DESCRIPTION = "The free AI website scan at /scan: the details a visitor sends with their report. Opens their AI audit.";

export const FREE_SCAN_BRANDING: FormBranding = {
  primary_color: "#e8c547",
  accent_color: "#faf9f5",
  headline: "Send your scan to the OASIS team",
  subheadline: "A founder reads it, prices the fixes and emails you.",
  thanks_message: "Your report is in the audit queue. A founder reads every one.",
};

/** The audit's own first step: the claim must ask for exactly what an audit lead gives. */
export const FREE_SCAN_STEPS: FormStep[] = [{ ...AI_AUDIT_STEPS[0], key: "identity", title: "Who should the report go to?" }];

export function buildFreeScanFormRow(tenantId: string = AI_AUDIT_TENANT_ID) {
  return {
    tenant_id: tenantId,
    slug: SCAN_OFFER_SLUG,
    name: SCAN_OFFER_NAME,
    description: FREE_SCAN_DESCRIPTION,
    branding: FREE_SCAN_BRANDING,
    steps: FREE_SCAN_STEPS,
    on_complete_stage: AI_AUDIT_ON_COMPLETE_STAGE,
    step_outcomes: {} as Record<string, string>,
    enabled: true,
    redirect_url: null as string | null,
    created_by: null as string | null,
  };
}
