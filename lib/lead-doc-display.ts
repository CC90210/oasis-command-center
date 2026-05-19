/**
 * Shared display helpers for lead_documents rows.
 *
 * Both the server-rendered LeadDocumentsPanel and the client-side
 * LeadDetailDrawer's Documents tab need the same humanization. Single
 * source so the labels can't drift between the two surfaces.
 */

export function humanLeadDocSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function leadDocTypeLabel(docType: string): string {
  // Mirrors the classifier enum in database/049 §lead_documents.
  switch (docType) {
    case "bank_statements_3mo":
      return "Bank statements (3 months)";
    case "drivers_license":
      return "Driver's license";
    case "proof_of_ownership":
      return "Proof of ownership";
    case "void_cheque":
      return "Void cheque";
    case "business_license":
      return "Business license";
    case "tax_returns":
      return "Tax returns";
    case "unclassified":
      return "Other / unclassified";
    default:
      return docType.replace(/_/g, " ");
  }
}
