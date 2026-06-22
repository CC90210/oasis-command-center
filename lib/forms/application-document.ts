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
import { getServiceSupabase } from "@/lib/supabase-server";
import { getRecord } from "@/lib/manifest/data";

/** doc_type for the generated application — matches lib/lead-doc-display.ts. */
const APPLICATION_DOC_TYPE = "final_application_form";
/** doc_type for the standalone e-signature image (Batch 7.2 — DocuSign replacement). */
const SIGNATURE_DOC_TYPE = "applicant_signature";
/** agent_source for the doc-generation audit trail (resolves to Helios in the
 *  activity feed, consistent with the form-intake family). */
const DOC_SOURCE = "form_intake_signed_application";

export type MaybeGenerateApplicationInput = {
  db: SupabaseClient;
  /** Already-fetched form row — caller guarantees this is the full application. */
  form: { id: string; tenant_id: string; slug: string };
  /** Verified form-link payload (tenant slug, lead_id). */
  link: { tenant: string; lead_id: string };
  /** Client IP at submit (for the signature audit trail). Optional. */
  ip?: string | null;
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
      .is("metadata->>deleted_at", null) // Batch 5: a deleted app PDF shouldn't block regeneration
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
    }
    // Capture (don't early-return) the existing PDF for this form — we still need
    // to ensure the standalone signature file exists below, even when the PDF is
    // already filed (Codex 2026-06-19 MEDIUM: a partial prior run can leave the
    // PDF present but the signature missing).
    const existingPdf = existing.error
      ? null
      : (((existing.data || []).find(
          (r) => (r as { metadata?: Record<string, unknown> | null }).metadata?.form_id === form.id,
        ) as { id: string; metadata?: Record<string, unknown> | null } | undefined) ?? null);
    const pdfAlreadyExists = !!existingPdf;

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

    const business =
      (typeof merged.business_legal_name === "string" && merged.business_legal_name) ||
      (typeof leadData.business_name === "string" && leadData.business_name) ||
      "application";
    const safeBusiness =
      business.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";

    // PDF already filed (idempotent). The standalone signature file (Batch 7.2)
    // is uploaded AFTER the PDF and is best-effort, so a prior run may have filed
    // the PDF yet failed — or been interrupted before — the signature. Ensure the
    // signature exists now, independently of the PDF, then stop (don't regenerate
    // the PDF). Codex 2026-06-19 MEDIUM.
    if (pdfAlreadyExists) {
      const priorSignedAt =
        (existingPdf?.metadata?.generated_at as string | undefined) || new Date().toISOString();
      await ensureApplicantSignatureFile({
        db,
        form,
        leadId: link.lead_id,
        signatureDataUri,
        signatureName,
        signedAt: priorSignedAt,
        ip: input.ip ?? null,
        safeBusiness,
        applicationDocId: existingPdf?.id ?? null,
      });
      return;
    }

    const signedAt = new Date().toISOString();
    const bytes = await generateApplicationPdf({ sections, signatureName, signatureDataUri, signedAt });
    const buf = Buffer.from(bytes);

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

    // Batch 7.2: persist the e-signature as its OWN retrievable file in Storage
    // (CC's DocuSign replacement — the signature must be accessible later, not
    // only embedded in the PDF). Idempotent + independent of the PDF (Codex
    // 2026-06-19 MEDIUM), so a retry after a partial prior run still files it.
    await ensureApplicantSignatureFile({
      db,
      form,
      leadId: link.lead_id,
      signatureDataUri,
      signatureName,
      signedAt,
      ip: input.ip ?? null,
      safeBusiness,
      applicationDocId: up.document.id,
    });

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

/**
 * File the applicant's e-signature as its own retrievable Storage object (Batch
 * 7.2 — the DocuSign replacement). Idempotent + INDEPENDENT of the application
 * PDF (Codex 2026-06-19 MEDIUM): it runs its own existence check on the
 * SIGNATURE_DOC_TYPE, so a partial prior run that filed the PDF but missed the
 * signature still gets the signature on the next submit/retry — the PDF guard no
 * longer permanently masks a missing legal artifact. Never throws into the
 * caller; logs failures for operator follow-up.
 */
async function ensureApplicantSignatureFile(args: {
  db: SupabaseClient;
  form: { id: string; tenant_id: string };
  leadId: string;
  signatureDataUri: string;
  signatureName: string | null;
  signedAt: string;
  ip: string | null;
  safeBusiness: string;
  applicationDocId: string | null;
}): Promise<void> {
  const { db, form, leadId, signatureDataUri } = args;
  if (!signatureDataUri) return;
  try {
    // Idempotent on (lead, form): skip when a non-deleted signature file already
    // exists. Independent of the PDF guard so PDF-present/signature-missing heals.
    const existing = await db
      .from("lead_documents")
      .select("id, metadata")
      .eq("tenant_id", form.tenant_id)
      .eq("lead_id", leadId)
      .eq("doc_type", SIGNATURE_DOC_TYPE)
      .is("metadata->>deleted_at", null)
      .limit(50);
    if (
      !existing.error &&
      (existing.data || []).some(
        (r) => (r as { metadata?: Record<string, unknown> | null }).metadata?.form_id === form.id,
      )
    ) {
      return; // signature already filed for this form
    }

    const m = signatureDataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (!m) return;
    const sigMime = m[1];
    const sigBuf = Buffer.from(m[2], "base64");
    const ext = sigMime.includes("jpeg") || sigMime.includes("jpg") ? "jpg" : "png";
    if (sigBuf.length === 0 || sigBuf.length > 5 * 1024 * 1024) return;

    const sig = await uploadLeadDocument({
      tenantId: form.tenant_id,
      leadId,
      filename: `SunBiz-Signature-${args.safeBusiness}-${args.signedAt.slice(0, 10)}.${ext}`,
      mimeType: sigMime,
      bytes: sigBuf,
      sizeBytes: sigBuf.length,
      docType: SIGNATURE_DOC_TYPE,
      uploadedBy: "form_intake",
      source: "form_intake_signature",
      extraMetadata: {
        form_id: form.id,
        signed_name: args.signatureName || null,
        signed_at: args.signedAt,
        signed_ip: args.ip,
        application_document_id: args.applicationDocId,
      },
    });
    if (!sig.ok) {
      console.error("[forms.submit.app_doc] signature file upload failed", {
        lead_id: leadId,
        error: sig.error,
      });
    }
  } catch (err) {
    console.error("[forms.submit.app_doc] signature persist threw", {
      lead_id: leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Generate the SunBiz application PDF from an APPLICATION RECORD (not a form
 * submission) and file it as final_application_form. Used when an application is
 * created WITHOUT the full-application form — "Transfer to Application", "Run
 * underwriting", or after drop-in autofill — so every application carries the
 * app PDF on its Docs tab. Builds from the record's own data (+ the linked lead
 * for email/phone), with a ruled signature line when no e-signature exists.
 *
 * Idempotent by default (skips when a final_application_form already exists for
 * the lead). Pass replace=true to regenerate (soft-deletes the prior generated
 * copy first) — used after autofill changes the data. Never throws into callers.
 */
export async function generateApplicationDocumentFromRecord(input: {
  tenantId: string;
  applicationId: string;
  replace?: boolean;
}): Promise<{ ok: boolean; documentId?: string; error?: string }> {
  try {
    const db = getServiceSupabase();
    const app = await getRecord({ tenant_id: input.tenantId, entity: "application", id: input.applicationId }).catch(() => null);
    if (!app) return { ok: false, error: "application_not_found" };
    const appData = (app.data || {}) as Record<string, unknown>;
    const leadId = typeof appData.lead_id === "string" ? appData.lead_id : null;
    if (!leadId) return { ok: false, error: "no_lead_id" };

    // Linked lead supplies email/phone fallback; never fatal if missing.
    const lead = await getRecord({ tenant_id: input.tenantId, entity: "lead", id: leadId }).catch(() => null);
    const leadData = (lead?.data || {}) as Record<string, unknown>;

    // Existing generated PDF for this lead?
    const existing = await db
      .from("lead_documents")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("lead_id", leadId)
      .eq("doc_type", APPLICATION_DOC_TYPE)
      .is("metadata->>deleted_at", null)
      .limit(10);
    const existingRows = (existing.data || []) as Array<{ id: string }>;
    if (existingRows.length && !input.replace) {
      return { ok: true, documentId: existingRows[0].id }; // already filed; idempotent
    }
    if (existingRows.length && input.replace) {
      // Soft-delete the prior generated copy so the new one is the live document.
      for (const r of existingRows) {
        await db
          .from("lead_documents")
          .update({ metadata: { deleted_at: new Date().toISOString(), deleted_by: "record_regenerate" } })
          .eq("id", r.id)
          .eq("tenant_id", input.tenantId);
      }
    }

    const { sections, signatureName } = mapApplicationFields(appData, leadData);
    const signatureDataUri = typeof appData.applicant_signature === "string" ? appData.applicant_signature : "";
    const signedAt = new Date().toISOString();
    const bytes = await generateApplicationPdf({ sections, signatureName, signatureDataUri, signedAt });
    const buf = Buffer.from(bytes);

    const business =
      (typeof appData.business_legal_name === "string" && appData.business_legal_name) ||
      (typeof appData.business_name === "string" && appData.business_name) ||
      (typeof leadData.business_name === "string" && leadData.business_name) ||
      "application";
    const safeBusiness =
      business.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";
    const filename = `SunBiz-Application-${safeBusiness}-${signedAt.slice(0, 10)}.pdf`;

    const up = await uploadLeadDocument({
      tenantId: input.tenantId,
      leadId,
      filename,
      mimeType: "application/pdf",
      bytes: buf,
      sizeBytes: buf.length,
      docType: APPLICATION_DOC_TYPE,
      uploadedBy: "system",
      source: "record_generated",
      extraMetadata: { application_id: input.applicationId, generated_at: signedAt, generated_from: "record" },
    });
    if (!up.ok) return { ok: false, error: up.error };

    // Timeline marker — best-effort, fixed string + ids only (no PII).
    try {
      const note = "Application PDF generated from the record and filed to documents.";
      await db.from("lead_interactions").insert({
        tenant_id: input.tenantId,
        lead_id: leadId,
        type: "application_generated",
        channel: "system",
        direction: "outbound",
        agent_source: "record_application_pdf",
        subject: "Application PDF generated",
        content: note,
        content_preview: note,
        metadata: { status: "generated", document_id: up.document.id, doc_type: APPLICATION_DOC_TYPE, application_id: input.applicationId },
      });
    } catch {
      /* best-effort marker */
    }

    return { ok: true, documentId: up.document.id };
  } catch (err) {
    console.error("[app_doc.from_record] threw", {
      application_id: input.applicationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err instanceof Error ? err.message : "failed" };
  }
}
