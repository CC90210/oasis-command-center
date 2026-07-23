/**
 * apply-extracted.ts — turn the fields extracted from a dropped application
 * document into a real application (and lead). Shared by both drop-in entry
 * points: autofill onto an existing lead, and "new deal from a dropped PDF".
 *
 * Security boundary: the RAW extractor output is run through extractAppFields()
 * (whitelist + per-key normalize) BEFORE any write — unknown keys are dropped,
 * types are coerced. Nothing from the document is executed or re-prompted.
 *
 * Pipeline: whitelist fields -> ensure lead (create for the new-deal flow,
 * backfill identity gaps for the existing flow) -> ensure application
 * (createApplicationFromLead, idempotent) -> write fields onto the application
 * -> file the original dropped file as the `application` doc -> (re)generate the
 * formatted final_application_form PDF from the now-populated record.
 */

import "server-only";
import { createRecord, updateRecord, getRecord } from "@/lib/manifest/data";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { extractAppFields } from "@/lib/forms/application-upsert";
import { uploadLeadDocument } from "@/lib/lead-documents";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";

// Identity fields mirrored onto the LEAD so the board / drawer show the merchant
// before the operator opens the application.
const LEAD_IDENTITY_KEYS = [
  "business_name",
  "contact_name",
  "email",
  "phone",
  "monthly_revenue",
  "business_state",
  "industry",
  "requested_amount",
] as const;

export type ApplyExtractedResult =
  | { ok: true; leadId: string; applicationId: string; createdLead: boolean; appliedKeys: string[] }
  | { ok: false; error: string };

export async function applyExtractedApplication(input: {
  tenantId: string;
  leadId?: string | null; // existing lead id, or null/undefined to create a new one
  rawFields: Record<string, unknown>;
  assignedTo?: string | null;
  originalFile?: { bytes: Buffer; filename: string; mimeType: string } | null;
  uploadedBy?: string;
}): Promise<ApplyExtractedResult> {
  try {
    // 1) Whitelist + normalize (the boundary). Drops unknown keys, coerces types.
    const fields = extractAppFields(input.rawFields);
    if (Object.keys(fields).length === 0) {
      return { ok: false, error: "no_usable_fields" };
    }

    // 2) Ensure a lead.
    let leadId = input.leadId || null;
    let createdLead = false;
    if (!leadId) {
      const leadData: Record<string, unknown> = { source: "dropped_application" };
      for (const k of LEAD_IDENTITY_KEYS) {
        if (fields[k] !== undefined) leadData[k] = fields[k];
      }
      if (!leadData.business_name) leadData.business_name = "Untitled application";
      // A dropped application is a completed deal received externally (via the
      // job-form link) with bank statements already in hand — it's a Live Sub,
      // not a fresh signee. Land it at `uw_sheet` ("Live Subs") so it surfaces
      // on the Live Subs board (matching the Breeze UW-sheet daemon's pattern)
      // and does NOT fire the signed_application bank-statement nag drip
      // (BRAVO_RECORD_STATUS_CHANGED -> to:signed_application), which would chase
      // a merchant whose statements we already hold. The application entity
      // still gets the valid `application_in` opportunity status below, so the
      // Bank/underwriting pipeline is unaffected and nothing is orphaned.
      leadData.stage = "uw_sheet";
      if (input.assignedTo) leadData.assigned_to = input.assignedTo;
      const created = await createRecord({ tenant_id: input.tenantId, entity: "lead", data: leadData });
      leadId = created.id;
      createdLead = true;
    } else {
      // Existing lead — backfill identity gaps only (never clobber operator data).
      const lead = await getRecord({ tenant_id: input.tenantId, entity: "lead", id: leadId }).catch(() => null);
      const ld = (lead?.data || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of LEAD_IDENTITY_KEYS) {
        const cur = ld[k];
        if ((cur === undefined || cur === null || cur === "") && fields[k] !== undefined) {
          patch[k] = fields[k];
        }
      }
      if (Object.keys(patch).length) {
        await updateRecord({ tenant_id: input.tenantId, entity: "lead", id: leadId, patch });
      }
    }

    // 3) Ensure the application (idempotent reuse) + write the extracted fields.
    const appRes = await createApplicationFromLead({ tenantId: input.tenantId, leadId });
    if (!appRes.ok) return { ok: false, error: appRes.error };
    const applicationId = appRes.applicationId;
    await updateRecord({
      tenant_id: input.tenantId,
      entity: "application",
      id: applicationId,
      patch: {
        ...fields,
        lead_id: leadId,
        status: "application_in",
        autofilled_at: new Date().toISOString(),
        autofill_source: "dropped_document",
      },
    });

    // 4) Keep the original dropped file as the `application` document (it's the
    //    real, possibly-signed application). Best-effort.
    if (input.originalFile && input.originalFile.bytes?.length) {
      await uploadLeadDocument({
        tenantId: input.tenantId,
        leadId,
        filename: input.originalFile.filename || "dropped-application.pdf",
        mimeType: input.originalFile.mimeType || "application/pdf",
        bytes: input.originalFile.bytes,
        sizeBytes: input.originalFile.bytes.length,
        docType: "application",
        uploadedBy: input.uploadedBy || "operator",
        source: "dropped_application_autofill",
        extraMetadata: { application_id: applicationId, autofill: true },
      }).catch(() => {});
    }

    // 5) (Re)generate our formatted application PDF from the now-populated record.
    await generateApplicationDocumentFromRecord({
      tenantId: input.tenantId,
      applicationId,
      replace: true,
    }).catch(() => {});

    return { ok: true, leadId, applicationId, createdLead, appliedKeys: Object.keys(fields) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "apply_failed" };
  }
}
