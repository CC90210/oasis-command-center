"use client";

import { useState } from "react";
import { Download, Eye } from "lucide-react";
import { DocumentsViewer } from "./DocumentsViewer";

export function LeadDocumentDownloadButton({
  documentId,
  filename,
  mimeType,
  docType,
  canMutate = true,
}: {
  documentId: string;
  filename: string;
  mimeType: string | null;
  docType: string;
  canMutate?: boolean;
}) {
  const [viewing, setViewing] = useState(false);
  const contentUrl = `/api/lead-documents/${encodeURIComponent(documentId)}/content`;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setViewing(true)}
        title={`View ${filename}`}
        className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2 py-1 text-[11px] font-bold text-fg hover:border-accent/40"
      >
        <Eye className="w-3 h-3" />
        View
      </button>
      <a
        href={`${contentUrl}?download=1`}
        download={filename}
        title={`Download ${filename}`}
        className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2 py-1 text-[11px] font-bold text-fg hover:border-accent/40"
      >
        <Download className="w-3 h-3" /> Download
      </a>
      {viewing && (
        <DocumentsViewer
          docs={[{ id: documentId, filename, mime_type: mimeType, doc_type: docType }]}
          onClose={() => setViewing(false)}
          canMutate={canMutate}
        />
      )}
    </div>
  );
}

