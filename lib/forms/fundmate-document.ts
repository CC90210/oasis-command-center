/**
 * fundmate-document.ts — generate + file the FundMate application PDF.
 *
 * FundMate is a SEPARATE paper-lender brand. This builds a FundMate-branded
 * application (lib/forms/fundmate-pdf.ts) from a SunBiz application record's
 * data and files it to the deal's documents as `fundmate_application_form`
 * (separate from the SunBiz `final_application_form` — both coexist).
 *
 * No SunBiz identity ever appears on the output document.
 *
 * FICO (Adon 2026-06-23): SunBiz records don't store a credit score; FundMate's
 * form is a range dropdown, so Estimated Fico renders the "600 - 650" bucket
 * (Adon: keep within 600-650). Amount Requested + Monthly Revenue are mapped to
 * FundMate's range buckets from the deal's exact values (see mapAppDataToFundmate).
 *
 * Never throws into callers; mirrors generateApplicationDocumentFromRecord.
 */

import "server-only";
import { uploadLeadDocument } from "@/lib/lead-documents";
import { renderFundmatePdf, mapAppDataToFundmate } from "@/lib/forms/fundmate-pdf";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getRecord } from "@/lib/manifest/data";

const FUNDMATE_DOC_TYPE = "fundmate_application_form";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateFundmateDocumentFromRecord(input: {
  tenantId: string;
  applicationId: string;
  replace?: boolean;
}): Promise<{ ok: boolean; documentId?: string; error?: string }> {
  try {
    const db = getServiceSupabase();
    const app = await getRecord({ tenant_id: input.tenantId, entity: "application", id: input.applicationId }).catch(() => null);
    if (!app) return { ok: false, error: "application_not_found" };
    const appData = (app.data || {}) as Record<string, unknown>;

    // Doc key: real lead_id when valid, else the application's own id — mirrors
    // detail/route.ts docLeadId so the FundMate PDF shows in the deal's Docs tab
    // even for the 463 leadless / imported applications.
    const linkedLeadId =
      typeof appData.lead_id === "string" && UUID_RE.test(appData.lead_id) ? appData.lead_id : null;
    const leadId = linkedLeadId || input.applicationId;

    // Existing FundMate doc for this deal?
    const existing = await db
      .from("lead_documents")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("lead_id", leadId)
      .eq("doc_type", FUNDMATE_DOC_TYPE)
      .is("metadata->>deleted_at", null)
      .limit(10);
    const rows = (existing.data || []) as Array<{ id: string }>;
    if (rows.length && !input.replace) return { ok: true, documentId: rows[0].id };
    if (rows.length && input.replace) {
      for (const r of rows) {
        await db
          .from("lead_documents")
          .update({ metadata: { deleted_at: new Date().toISOString(), deleted_by: "fundmate_regenerate" } })
          .eq("id", r.id)
          .eq("tenant_id", input.tenantId);
      }
    }

    // Amount Requested + Monthly Revenue are bucketed into FundMate's range
    // options inside mapAppDataToFundmate; Estimated Fico is the "600 - 650"
    // bucket (Adon: keep within 600-650).
    const fields = mapAppDataToFundmate(appData);
    const signedAt = new Date().toISOString();
    const bytes = await renderFundmatePdf({ fields, signedAt });
    const buf = Buffer.from(bytes);

    const business = fields.businessLegalName || "application";
    const safeBusiness =
      business.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";
    const filename = `FundMate-Application-${safeBusiness}-${signedAt.slice(0, 10)}.pdf`;

    const up = await uploadLeadDocument({
      tenantId: input.tenantId,
      leadId,
      filename,
      mimeType: "application/pdf",
      bytes: buf,
      sizeBytes: buf.length,
      docType: FUNDMATE_DOC_TYPE,
      uploadedBy: "system",
      source: "fundmate_transfer",
      extraMetadata: { application_id: input.applicationId, generated_at: signedAt, estimated_fico: "600 - 650" },
    });
    if (!up.ok) return { ok: false, error: up.error };

    // Timeline marker — fixed string + ids only (no PII).
    try {
      const note = "FundMate application generated and filed to documents.";
      await db.from("lead_interactions").insert({
        tenant_id: input.tenantId,
        lead_id: leadId,
        type: "fundmate_generated",
        channel: "system",
        direction: "outbound",
        agent_source: "fundmate_transfer",
        subject: "FundMate application generated",
        content: note,
        content_preview: note,
        metadata: { status: "generated", document_id: up.document.id, doc_type: FUNDMATE_DOC_TYPE, application_id: input.applicationId },
      });
    } catch {
      /* best-effort marker */
    }

    return { ok: true, documentId: up.document.id };
  } catch (err) {
    console.error("[fundmate_doc.from_record] threw", {
      application_id: input.applicationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err instanceof Error ? err.message : "fundmate_generate_failed" };
  }
}
