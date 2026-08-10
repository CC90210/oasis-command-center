import { ExternalLink } from "lucide-react";

export function LeadDocumentDownloadButton({
  documentId,
  filename,
}: {
  documentId: string;
  filename: string;
}) {
  // Use a real link so the browser opens the tab during the user's click.
  // The old implementation awaited a metadata fetch and called window.open()
  // afterwards, which popup blockers silently reject. The content route repeats
  // tenant/lead authorization before streaming, so linking to it directly keeps
  // the same security boundary without the fragile asynchronous popup.
  const href = `/api/lead-documents/${encodeURIComponent(documentId)}/content`;

  return (
    <div className="flex items-center gap-2">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${filename}`}
        className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2 py-1 text-[11px] font-bold text-fg hover:border-accent/40"
      >
        <ExternalLink className="w-3 h-3" />
        View
      </a>
    </div>
  );
}

