/**
 * Shared display helpers + constants for lead_documents rows.
 *
 * Single source of truth across:
 *   - LeadDocumentsPanel (server-rendered, /pipeline/[id])
 *   - LeadDetailDrawer's Documents tab (client, drawer upload)
 *   - VisualFieldsEditor SUNBIZ_DOC_PRESETS (form builder)
 *   - SunBiz auto-stage engine REQUIRED_DOC_TYPES gate
 *
 * Touch one list, every consumer updates.
 */

/**
 * Doc-type registry. `key` matches the value stored in
 * lead_documents.doc_type; `required` lists the canonical SunBiz
 * application docs the auto-stage engine treats as completion.
 */
export const LEAD_DOC_TYPES: { key: string; label: string; required: boolean }[] = [
  // Required (auto-stage engine watches these three — all three present
  // bumps the lead to hot_lead).
  { key: "bank_statements_3mo", label: "Bank statements (3 months)", required: true },
  { key: "drivers_license", label: "Driver's license", required: true },
  { key: "void_cheque", label: "Void cheque", required: true },
  // Optional underwriting / Shopping Out support docs (Phase 3 of
  // Jordan/Oasis 2026-05-23 restructure — Shopping Out attaches these
  // alongside bank statements when shopping to multiple lenders).
  { key: "signed_application", label: "Signed application", required: false },
  // Auto-generated on full-application completion (signature + all fields →
  // PDF). See lib/forms/application-document.ts.
  { key: "final_application_form", label: "Final Application Form", required: false },
  // FundMate is a SEPARATE paper-lender brand; this is the FundMate-branded
  // application generated via "Transfer to FundMate". Coexists with the SunBiz
  // final_application_form above. (Adon 2026-06-23.)
  { key: "fundmate_application_form", label: "FundMate Application", required: false },
  // Standalone e-signature image saved on full-application submit (Batch 7.2 —
  // the DocuSign replacement; also embedded in the application PDF).
  { key: "applicant_signature", label: "Applicant signature", required: false },
  // In-house e-signature system (2026-07) — the completed signed PDF for a
  // lead-linked envelope, filed via uploadLeadDocument (lib/esign/storage.ts).
  { key: "esigned_document", label: "E-signed document", required: false },
  { key: "second_application_form", label: "Second application form", required: false },
  { key: "underwriting_docs", label: "Underwriting docs", required: false },
  { key: "portal_docs", label: "Portal docs", required: false },
  { key: "proof_of_ownership", label: "Proof of ownership", required: false },
  { key: "business_license", label: "Business license", required: false },
  { key: "tax_returns", label: "Tax returns", required: false },
  { key: "unclassified", label: "Other / unclassified", required: false },
];

export const REQUIRED_LEAD_DOC_TYPES = LEAD_DOC_TYPES.filter((t) => t.required).map(
  (t) => t.key,
);

export function humanLeadDocSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function leadDocTypeLabel(docType: string): string {
  const entry = LEAD_DOC_TYPES.find((t) => t.key === docType);
  if (entry) return entry.label;
  return docType.replace(/_/g, " ");
}
