/**
 * application-document.ts — generate + file the signed application PDF.
 *
 * Fires (post-response, soft-fail) when a merchant completes the FINAL step of
 * the full-application form. It merges every step's payload, generates the
 * SunBiz application PDF (lib/forms/application-pdf.ts) with the drawn
 * signature embedded, files it to the lead's documents via the shared
 * uploadLeadDocument pipeline (so it appears in the drawer's DOCS tab labeled
 * "Final Application Form"), and records a timeline entry on the lead.
 *
 * Mirrors the maybeSendNextStepsEmail pattern: wrapped in try/catch, never
 * throws into the caller, never blocks the merchant's submit response.
 *
 * PII discipline: the merged payload (SSN/DOB/EIN) + the signature data-URI are
 * NEVER logged. The timeline row's content is a fixed system string; its
 * metadata carries only ids + flags.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { uploadLeadDocument } from "@/lib/lead-documents";
import { mapApplicationFields, generateApplicationPdf } from "@/lib/forms/application-pdf";

/** doc_type for the generated application — matches lib/lead-doc-display.ts. */
const APPLICATION_DOC_TYPE = "final_application_form";
/** agent_source for the doc-generation audit trail (resolves to Helios in the
 *  activity feed, consistent with the form-intake family). */
const DOC_SOURCE = "form_intake_signed_application";

export type MaybeGenerateApplicationInput = {
  db: SupabaseClient;
  /** Already-fetched form row — caller guarantees this is the full application. */
  form: { id: string; tenant_id: string; slug: string };
  /** Verified form-link payload (tenant slug, lead_id). */
  link: { tenant: string; lead_id: string };
};

export async function maybeGenerateApplicationDocument(
  input: MaybeGenerateApplicationInput,
): Promise<void> {
  try {
    const { db, form, link } = input;

    // Idempotency: one final application PDF per (lead, form). Match on
    // doc_type + the form_id we stamp into metadata so a re-submitted final
    // step (or a double after()-fire) doesn't stack duplicates.
    const existing = await db
      .from("lead_documents")
      .select("id, metadata")
      .eq("tenant_id", form.tenant_id)
      .eq("lead_id", link.lead_id)
      .eq("doc_type", APPLICATION_DOC_TYPE)
      .limit(50);
    if (existing.error) {
      // Bias toward the document EXISTING: a missing signed application is a
      // worse, invisible gap than a rare duplicate an operator can delete. So
      // on a transient idempotency-read error we log + PROCEED rather than
      // skip. (after() fires once; there is no retry.)
      console.error("[forms.submit.app_doc] idempotency read errored — generating anyway", {
        lead_id: link.lead_id,
        error: existing.error.message,
      });
    } else if (
      (existing.data || []).some(
        (r) => (r as { metadata?: Record<string, unknown> | null }).metadata?.form_id === form.id,
      )
    ) {
      return; // already generated for this form
    }

    // Merge every step's payload for this (form, lead). Latest row wins per
    // field (a re-submitted step overwrites the earlier value).
    const subs = await db
      .from("form_submissions")
      .select("step_index, payload, created_at")
      .eq("tenant_id", form.tenant_id) // service-role client bypasses RLS — scope by tenant explicitly so this PII-heavy merge can't cross tenant boundaries (Codex audit 2026-06-17 [P2])
      .eq("form_id", form.id)
      .eq("lead_id", link.lead_id)
      .order("created_at", { ascending: true });
    if (subs.error) {
      console.error("[forms.submit.app_doc] submissions read errored — skipping", {
        lead_id: link.lead_id,
        error: subs.error.message,
      });
      return;
    }
    const merged: Record<string, unknown> = {};
    for (const row of (subs.data || []) as Array<{ payload: Record<string, unknown> | null }>) {
      if (row.payload && typeof row.payload === "object") Object.assign(merged, row.payload);
    }

    const signatureDataUri =
      typeof merged.applicant_signature === "string" ? merged.applicant_signature : "";

    // Lead record — email/phone/business_name come from the interest form, not
    // the full application.
    const leadRow = await db
      .from("tenant_records")
      .select("data")
      .eq("id", link.lead_id)
      .eq("tenant_id", form.tenant_id)
      .maybeSingle();
    const leadData =
      (leadRow.data as { data?: Record<string, unknown> | null } | null)?.data || {};

    const { sections, signatureName } = mapApplicationFields(merged, leadData);
    const signedAt = new Date().toISOString();
    const bytes = await generateApplicationPdf({ sections, signatureName, signatureDataUri, signedAt });
    const buf = Buffer.from(bytes);

    const business =
      (typeof merged.business_legal_name === "string" && merged.business_legal_name) ||
      (typeof leadData.business_name === "string" && leadData.business_name) ||
      "application";
    const safeBusiness =
      business.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";
    const filename = `SunBiz-Application-${safeBusiness}-${signedAt.slice(0, 10)}.pdf`;

    // Retry the file step. This runs in Next `after()` (fire-once, no retry), so
    // a transient Storage/DB blip would otherwise silently lose the signed
    // application PDF — the worst, invisible failure mode. Up to 3 attempts with
    // a short backoff; the bytes are already generated so a retry is cheap.
    let up: Awaited<ReturnType<typeof uploadLeadDocument>> | null = null;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await uploadLeadDocument({
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        filename,
        mimeType: "application/pdf",
        bytes: buf,
        sizeBytes: buf.length,
        docType: APPLICATION_DOC_TYPE,
        uploadedBy: "form_intake",
        source: DOC_SOURCE,
        extraMetadata: {
          form_id: form.id,
          generated_at: signedAt,
          signed_name: signatureName || null,
        },
      });
      if (result.ok) {
        up = result;
        break;
      }
      console.error(`[forms.submit.app_doc] upload failed (attempt ${attempt}/${MAX_ATTEMPTS})`, {
        lead_id: link.lead_id,
        error: result.error,
      });
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (!up) {
      // All attempts failed. Leave a visible timeline marker so the operator
      // knows to regenerate from the drawer rather than assuming it's filed.
      try {
        const failNote = "Application PDF generation failed after retries — regenerate from the lead.";
        await db.from("lead_interactions").insert({
          tenant_id: form.tenant_id,
          lead_id: link.lead_id,
          type: "application_generated",
          channel: "system",
          direction: "outbound",
          agent_source: DOC_SOURCE,
          subject: "Application PDF generation failed",
          content: failNote,
          content_preview: failNote,
          metadata: { status: "failed", doc_type: APPLICATION_DOC_TYPE, form_id: form.id },
        });
      } catch {
        /* best-effort marker */
      }
      return;
    }

    // Timeline entry so the merchant's profile reflects the generation in the
    // drawer Activity tab + the actor-filtered audit feed. Best-effort: a
    // failure here doesn't undo the (successful) document upload. No PII —
    // fixed content string + ids/flags only.
    try {
      const note = "Final application PDF generated and filed to documents.";
      await db.from("lead_interactions").insert({
        tenant_id: form.tenant_id,
        lead_id: link.lead_id,
        type: "application_generated",
        channel: "system",
        direction: "outbound",
        agent_source: DOC_SOURCE,
        subject: "Final application generated",
        content: note,
        content_preview: note,
        metadata: {
          status: "generated",
          document_id: up.document.id,
          doc_type: APPLICATION_DOC_TYPE,
          filename: up.document.filename,
          form_id: form.id,
        },
      });
    } catch (err) {
      console.error("[forms.submit.app_doc] interaction insert threw", {
        lead_id: link.lead_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    console.log("[forms.submit.app_doc] generated", {
      lead_id: link.lead_id,
      document_id: up.document.id,
    });
  } catch (err) {
    console.error("[forms.submit.app_doc] threw", {
      lead_id: input.link.lead_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
