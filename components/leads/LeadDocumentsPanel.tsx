/**
 * LeadDocumentsPanel — operator-facing list of files prospects uploaded
 * against this lead. Server component: reads lead_documents directly with
 * the service-role client after verifying tenant scope, then renders a
 * client island for the "View" button which opens the authenticated stream.
 *
 * Lives on /pipeline/[id] (and any future lead detail surface) so the
 * operator can see + download bank statements / ID / proof-of-ownership
 * without leaving the dashboard.
 */
import { FileText, ImageIcon } from "lucide-react";
import { Card } from "@/components/Card";
import { getServiceSupabase } from "@/lib/supabase-server";
import { humanLeadDocSize, leadDocTypeLabel } from "@/lib/lead-doc-display";
import { LeadDocumentDownloadButton } from "./LeadDocumentDownloadButton";

type LeadDocumentRow = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: string;
  uploaded_by: string | null;
  uploaded_at: string;
};

export async function LeadDocumentsPanel({
  tenantId,
  leadId,
}: {
  tenantId: string;
  leadId: string;
}) {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("lead_documents")
    .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .is("metadata->>deleted_at", null) // Batch 5: exclude soft-deleted
    .order("uploaded_at", { ascending: false });

  if (error) {
    return (
      <Card>
        <div className="text-sm text-rose-400">
          Couldn&apos;t load documents: {error.message}
        </div>
      </Card>
    );
  }

  const docs = (data || []) as LeadDocumentRow[];

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
          Documents ({docs.length})
        </h3>
      </div>
      {docs.length === 0 ? (
        <div className="text-xs text-fg-dim italic py-3 text-center">
          No documents yet. Uploaded files will show up here.
        </div>
      ) : (
        <ul className="divide-y divide-bg-border">
          {docs.map((doc) => {
            const isImage = (doc.mime_type || "").startsWith("image/");
            return (
              <li
                key={doc.id}
                className="flex items-center gap-3 py-2.5 text-sm"
              >
                <div className="shrink-0 text-fg-dim">
                  {isImage ? (
                    <ImageIcon className="w-4 h-4" />
                  ) : (
                    <FileText className="w-4 h-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-fg truncate">{doc.filename}</div>
                  <div className="text-[11px] text-fg-dim">
                    {leadDocTypeLabel(doc.doc_type)} · {humanLeadDocSize(doc.size_bytes)} ·{" "}
                    {new Date(doc.uploaded_at).toLocaleString()}
                    {doc.uploaded_by ? ` · ${doc.uploaded_by}` : ""}
                  </div>
                </div>
                <LeadDocumentDownloadButton
                  documentId={doc.id}
                  filename={doc.filename}
                  mimeType={doc.mime_type}
                  docType={doc.doc_type}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

