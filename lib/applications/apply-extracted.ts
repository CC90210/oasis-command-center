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
import { findExistingLead } from "@/lib/forms/agent-routing";
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
  // extractAppFields has always pulled the website off a dropped application,
  // but it stopped at the application record — the lead the rep actually opens
  // never received it.
  "website",
] as const;

export type ApplyExtractedResult =
  | {
      ok: true;
      leadId: string;
      applicationId: string;
      createdLead: boolean;
      appliedKeys: string[];
      /** True when the drop was routed into a merchant we ALREADY had rather
       *  than creating a new lead. Surfaced to the operator, because "your
       *  document went onto an existing file" is a different outcome from "a
       *  new deal was created" and they must not have to discover it. */
      matchedExisting: boolean;
    }
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

    /**
     * Is this a merchant we already have? (2026-08-26)
     *
     * The new-deal path used to create a lead unconditionally, and a rep drops
     * an application for a merchant who is ALREADY in the CRM most of the time
     * — that is where the paperwork comes from. Measured live: four recovered
     * applications produced four second copies of merchants who already existed
     * at `signed_application` WITH contact details, sitting beside the
     * originals on the same board. The duplicate is also the worse record,
     * because a completed application form often carries no contact fields
     * (the merchant gave those on form 1), so the copy arrives with no email
     * and no phone.
     *
     * Same matcher the public form uses — email, then phone, then exact
     * business name — so the two intake paths cannot disagree about what
     * counts as a returning merchant. A miss just creates a fresh lead, which
     * is the old behaviour; it never guesses.
     */
    let autoMatchedLead = false;
    if (!leadId) {
      const match = await findExistingLead(input.tenantId, {
        email: typeof fields.email === "string" ? fields.email : null,
        phone: typeof fields.phone === "string" ? fields.phone : null,
        business: typeof fields.business_name === "string" ? fields.business_name : null,
      }).catch(() => null);
      if (match?.id) {
        leadId = match.id;
        autoMatchedLead = true;
      }
    }

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
      // Mark the deal as arriving COMPLETE (application + statements on file).
      // The drip enroller skips this flag (never re-ask a merchant for docs we
      // already hold) and the Live Subs board treats it as "ready", not "going
      // cold" — both keyed off data.docs_on_file, which is set ONLY here.
      // Scrubber-fed uw_sheet leads (which still need the first-touch cadence)
      // never carry it, so their drip + SLA behaviour is unchanged.
      leadData.docs_on_file = true;
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

    let patch: Record<string, unknown> = {
      ...fields,
      lead_id: leadId,
      status: "application_in",
      autofilled_at: new Date().toISOString(),
      autofill_source: "dropped_document",
    };

    /**
     * A lead WE matched, onto an application that already existed, is the one
     * case where this write must not be authoritative.
     *
     * Everywhere else the operator chose the target: they opened a lead and
     * pressed autofill, or the lead was created from this very document a
     * moment ago. Here nobody chose — the matcher did — and the application on
     * the other side may be a deal a rep has been working for days.
     *
     * Two ways a blind `{...fields}` would damage that:
     *   - `status: "application_in"` drags a `shopping` or `offer_received`
     *     deal backwards on the Applications board. Measured against the real
     *     records: one of the four matched merchants was already at `shopping`.
     *   - a model reading of `monthly_revenue` overwrites the number a rep
     *     typed off the bank statements. Both readings are plausible; the
     *     human's is the one that was checked.
     *
     * So on that path we fill GAPS only and never touch status. A reused
     * application keeps every value it already had; a freshly created one is
     * empty, so gap-filling writes everything anyway and nothing is lost.
     */
    if (autoMatchedLead && !appRes.created) {
      const existingApp = await getRecord({
        tenant_id: input.tenantId,
        entity: "application",
        id: applicationId,
      }).catch(() => null);
      const cur = (existingApp?.data || {}) as Record<string, unknown>;
      const gaps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        const have = cur[k];
        if (have === undefined || have === null || have === "") gaps[k] = v;
      }
      patch = {
        ...gaps,
        lead_id: leadId,
        autofilled_at: new Date().toISOString(),
        autofill_source: "dropped_document_matched",
      };
    }

    await updateRecord({
      tenant_id: input.tenantId,
      entity: "application",
      id: applicationId,
      patch,
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

    return {
      ok: true,
      leadId,
      applicationId,
      createdLead,
      appliedKeys: Object.keys(fields),
      matchedExisting: autoMatchedLead,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "apply_failed" };
  }
}
