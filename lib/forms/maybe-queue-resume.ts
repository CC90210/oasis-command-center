/**
 * maybe-queue-resume.ts — extraction from /api/forms/submit/route.ts.
 *
 * The form-submit route had ~55 lines of inline tenant-data-fetch +
 * resume-link queue logic immediately before the response. Pulling
 * that out here keeps the route handler focused on submission flow
 * and lets future tests exercise the resume-email decision in
 * isolation (no need to construct a full submit request).
 *
 * Soft-fail contract is unchanged — every error is caught + logged;
 * the caller's submission is never aborted by a failure here.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { queueResumeEmail } from "@/lib/forms/resume-link";

export type MaybeQueueResumeInput = {
  db: SupabaseClient;
  step_index: number;
  /** form row already fetched in the route. */
  form: {
    id: string;
    tenant_id: string;
    slug: string;
  };
  /** verified form-link payload (tenant slug, lead_id, form_id). */
  link: { tenant: string; lead_id: string; form_id: string };
  /** the just-submitted step's payload (field-name → value map). */
  payload: Record<string, unknown>;
};

/**
 * Run the resume-email queue side-effect IF this is step 0 AND we
 * have a real email. Returns void — failures are swallowed (logged
 * to console). The route handler never observes anything from here.
 */
export async function maybeQueueResumeEmail(
  input: MaybeQueueResumeInput,
): Promise<void> {
  if (input.step_index !== 0) return;
  const rawEmail =
    typeof input.payload.email === "string" ? input.payload.email.trim() : null;
  if (!rawEmail) return;

  try {
    // The form-submit handler already verified the lead exists. We
    // just need its data for the email greeting + the tenant's brand
    // label for the subject line. Both reads are tenant-scoped via
    // the service-role client (RLS isn't a concern — we're already on
    // the server-side path).
    const [leadRow, tenantRow] = await Promise.all([
      input.db
        .from("tenant_records")
        .select("data")
        .eq("id", input.link.lead_id)
        .maybeSingle(),
      input.db
        .from("tenants")
        .select("name, custom_fields")
        .eq("id", input.form.tenant_id)
        .maybeSingle(),
    ]);

    const leadData =
      (leadRow.data as { data: Record<string, unknown> | null } | null)?.data ?? {};
    // Greeting priority: lead's stored contact_name → lead's name →
    // payload contact_name → payload name. Falls through to null
    // (resume-link.ts renders "Hi there," when null).
    const leadName =
      (typeof leadData.contact_name === "string" && leadData.contact_name) ||
      (typeof leadData.name === "string" && leadData.name) ||
      (typeof input.payload.contact_name === "string" && input.payload.contact_name) ||
      (typeof input.payload.name === "string" && input.payload.name) ||
      null;

    const tenantData =
      tenantRow.data as
        | { name: string | null; custom_fields: Record<string, unknown> | null }
        | null;
    const brandFromCustom =
      typeof tenantData?.custom_fields?.brand === "string"
        ? (tenantData.custom_fields.brand as string)
        : null;
    const brand = brandFromCustom || tenantData?.name || input.link.tenant;

    await queueResumeEmail({
      db: input.db,
      tenant: {
        tenant_id: input.form.tenant_id,
        tenant_slug: input.link.tenant,
        brand,
      },
      lead_id: input.link.lead_id,
      form_id: input.form.id,
      form_slug: input.form.slug,
      form_label: null,
      to_email: rawEmail,
      to_name: typeof leadName === "string" ? leadName : null,
    });
  } catch (err) {
    // Soft fail — every other side of the submission still runs.
    console.error("[forms.submit.resume_email]", {
      lead_id: input.link.lead_id,
      form_id: input.form.id,
      reason: err instanceof Error ? err.message : "unknown",
    });
  }
}
