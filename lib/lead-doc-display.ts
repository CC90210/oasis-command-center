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
  { key: "bank_statements_3mo", label: "Bank statements (3 months)", required: true },
  { key: "drivers_license", label: "Driver's license", required: true },
  { key: "void_cheque", label: "Void cheque", required: true },
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
