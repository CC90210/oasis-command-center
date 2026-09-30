import { requirePlaybookReader } from "@/lib/playbook-access";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, FileText } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { DOC_CATEGORIES } from "@/lib/playbook/catalog";
import { docsDb, listDocs, type DocSummary } from "@/lib/playbook/documents";
import { STORAGE_NOT_READY } from "@/lib/playbook/http";
import { STATUS_TONE, sourceLine } from "@/lib/playbook/present";
import { STATUS_LABEL, type DocStatus } from "@/lib/playbook/status";
import { resolveDocsViewer } from "@/lib/playbook/viewer";
import { VISIBILITY_LABEL } from "@/lib/playbook/visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /playbook/business - every business document OASIS keeps, grouped by
 * category. Each card opens the document itself (/playbook/business/<slug>):
 * rendered, with Copy, Download and its history. (It used to link every card to
 * the AI Team roster, which dropped the request and 404'd for every member who
 * is not a founder: audit business-docs-link-to-ai-team.)
 *
 * Statuses are derived (lib/playbook/status.ts), never typed. Visibility is
 * filtered before anything is read (lib/playbook/visibility.ts): a teammate
 * never sees a founders-only document listed.
 */
export default async function BusinessDocsPage() {
  // OASIS members only (lib/playbook-access.ts); everyone else gets the 404.
  await requirePlaybookReader();
  const viewer = await resolveDocsViewer();
  if (!viewer.ok) notFound();
  const { rows, storage } = await listDocs(viewer, docsDb(), new Date());

  const counts = rows.reduce<Record<DocStatus, number>>(
    (acc, r) => ({ ...acc, [r.status]: acc[r.status] + 1 }),
    { current: 0, review_due: 0, draft: 0, missing: 0, superseded: 0, unknown: 0 },
  );
  const requiredMissing = rows.filter((r) => r.doc.required && r.status === "missing").length;

  return (
    <div className="space-y-6 animate-fade-in">
      <Link href="/playbook" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Playbook</span>
      </Link>

      <PageHeader
        title="Business documentation"
        subtitle="Every document OASIS AI Solutions keeps: legal, corporate, tax, sales, security, people and strategy. Open one to read, copy or download it; a missing one can be drafted from verified facts."
        action={
          <div className="flex flex-wrap gap-1.5">
            <Tag tone="engaged">{counts.current} current</Tag>
            {counts.review_due > 0 && <Tag tone="warm">{counts.review_due} review due</Tag>}
            {counts.draft > 0 && <Tag tone="info">{counts.draft} draft</Tag>}
            <Tag tone="hot">{counts.missing} missing</Tag>
            {counts.unknown > 0 && <Tag>{counts.unknown} couldn&apos;t check</Tag>}
          </div>
        }
      />

      {storage !== "ok" && (
        <div role="status" className="rounded-lg border border-status-warm/40 bg-status-warm/10 px-4 py-3 text-sm text-fg">
          {storage === "table_missing"
            ? STORAGE_NOT_READY
            : "Stored documents could not be read just now, so their status shows as \"Couldn't check\". Live documents still open. Refresh to try again."}
        </div>
      )}

      {requiredMissing > 0 && (
        <p className="text-sm text-fg-muted">
          <span className="font-semibold text-fg">{requiredMissing} required {requiredMissing === 1 ? "document is" : "documents are"} missing.</span>{" "}
          Each one says what is needed from CC.
        </p>
      )}

      {DOC_CATEGORIES.map((cat) => {
        const list = rows.filter((r) => r.doc.category === cat.key);
        if (list.length === 0) return null;
        return (
          <Card key={cat.key} title={cat.label} subtitle={cat.blurb}>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {list.map((r) => (
                <DocCard key={r.doc.slug} row={r} />
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function DocCard({ row }: { row: DocSummary }) {
  const { doc, status } = row;
  return (
    <Link
      href={`/playbook/business/${doc.slug}`}
      className="group rounded-lg border border-hairline bg-bg-elev/40 hover:border-accent/50 transition-colors p-3.5 flex items-start gap-3"
    >
      <div className="w-8 h-8 rounded-md flex items-center justify-center bg-bg-elev border border-hairline flex-shrink-0 text-fg-muted">
        <FileText className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-fg">{doc.title}</span>
          <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>
          <Tag>{VISIBILITY_LABEL[doc.visibility]}</Tag>
          {doc.required && <span className="text-[11px] text-fg-dim">Required</span>}
          <ArrowRight className="hover-reveal-cue w-3.5 h-3.5 text-fg-dim transition-opacity ml-auto" />
        </div>
        <div className="text-xs text-fg-muted mt-1 leading-snug">{doc.summary}</div>
        <div className="text-[11px] text-fg-dim mt-1.5">{sourceLine(row.sourceLabel, row.sourceDate)}</div>
        {status === "missing" && doc.needsFromCc && (
          <div className="text-[11px] text-status-warm mt-1">Missing - needs CC: {doc.needsFromCc}</div>
        )}
      </div>
    </Link>
  );
}
