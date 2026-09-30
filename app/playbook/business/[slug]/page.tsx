import { requirePlaybookReader } from "@/lib/playbook-access";
import { notFound } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { askDepartment, departmentForDocOwner, departmentLabel, fitsAskLink } from "@/lib/os/chat-href";
import { askPromptFor, categoryLabel } from "@/lib/playbook/catalog";
import { docsDb, resolveDoc } from "@/lib/playbook/documents";
import { STORAGE_NOT_READY } from "@/lib/playbook/http";
import { LEGAL_DRAFT_BANNER, STATUS_TONE, formatSourceDate, sourceLine } from "@/lib/playbook/present";
import { STATUS_LABEL, placeholdersIn } from "@/lib/playbook/status";
import { listIncidents, type Incident } from "@/lib/playbook/store";
import { resolveDocsViewer } from "@/lib/playbook/viewer";
import { VISIBILITY_LABEL } from "@/lib/playbook/visibility";
import { DocActions } from "./DocActions";
import { IncidentRegister } from "./IncidentRegister";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /playbook/business/<slug> - one business document: rendered, with Copy,
 * Download (.md), the source and its date, and its history. A founder can
 * Draft a missing document from verified facts, edit it, and mark it current
 * once no "CC to confirm" placeholder remains.
 *
 * A document the reader may not see (a founders-only one for a teammate) is
 * the same 404 as a slug that does not exist.
 */
export default async function BusinessDocPage({ params }: { params: Promise<{ slug: string }> }) {
  // OASIS members only (lib/playbook-access.ts); everyone else gets the 404.
  await requirePlaybookReader();
  const viewer = await resolveDocsViewer();
  if (!viewer.ok) notFound();
  const { slug } = await params;
  const db = docsDb();
  const r = await resolveDoc(viewer, slug, db, new Date());
  if (!r) notFound();
  const { doc } = r;

  // "Ask <department>" only when the reader may open that department (the
  // rail's own rule): a teammate is never sent to a department that 404s.
  const deptSlug = departmentForDocOwner(doc.owner);
  const os = await resolveOsViewer();
  const prompt = askPromptFor(doc);
  const ask =
    os.ok && departmentGate(deptSlug, os.navInput) && fitsAskLink(prompt)
      ? { href: askDepartment(deptSlug, prompt), label: departmentLabel(deptSlug) }
      : null;

  const placeholders = placeholdersIn(r.body);
  const stored = r.stored;
  const legalDraft = doc.legal && (r.status === "draft" || r.status === "missing");

  let incidents: Incident[] | null = null;
  let incidentState: "ok" | "table_missing" | "read_failed" = "ok";
  if (doc.slug === "law25-incident-register" && viewer.founder) {
    if (!db) incidentState = "read_failed";
    else {
      const read = await listIncidents(db, viewer.tenantId);
      if (read.ok) incidents = read.value;
      else incidentState = read.reason;
    }
  }

  return (
    <div className="space-y-5 max-w-4xl animate-fade-in">
      <Link href="/playbook/business" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Business documentation</span>
      </Link>

      <PageHeader
        title={doc.title}
        subtitle={doc.summary}
        action={
          <div className="flex flex-wrap gap-1.5">
            <Tag tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Tag>
            <Tag>{VISIBILITY_LABEL[doc.visibility]}</Tag>
          </div>
        }
      />

      <dl className="grid gap-x-6 gap-y-1 text-xs text-fg-muted sm:grid-cols-2">
        <div>{sourceLine(r.sourceLabel, r.sourceDate)}</div>
        <div>Category: {categoryLabel(doc.category)}</div>
        {doc.requiredBy && <div>Required by: {doc.requiredBy}</div>}
        {stored?.approved_at && (
          <div>
            Marked current {formatSourceDate(stored.approved_at)} by {stored.approved_by ?? "an unrecorded founder"}
          </div>
        )}
      </dl>

      {legalDraft && (
        <div role="note" className="flex items-start gap-2 rounded-lg border border-status-warm/40 bg-status-warm/10 px-4 py-3 text-sm font-medium text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warm" aria-hidden />
          {LEGAL_DRAFT_BANNER}
        </div>
      )}

      {r.storage === "table_missing" && doc.source.kind === "stored" && (
        <div role="status" className="rounded-lg border border-status-warm/40 bg-status-warm/10 px-4 py-3 text-sm text-fg">{STORAGE_NOT_READY}</div>
      )}

      <DocActions
        slug={doc.slug}
        body={r.body}
        founder={viewer.founder}
        openHref={r.openHref}
        ask={ask}
        canDraft={r.canDraft}
        editable={!!stored && stored.status !== "superseded" && r.storage === "ok"}
        markable={!!stored && (stored.status === "draft" || stored.status === "drafting") && r.storage === "ok"}
        version={stored?.version ?? null}
        placeholderCount={placeholders.length}
      />

      {doc.needsFromCc && r.status !== "current" && (
        <p className="text-sm text-fg-muted">
          <span className="font-semibold text-fg">Still needed from CC:</span> {doc.needsFromCc}
        </p>
      )}

      {placeholders.length > 0 && (
        <Card title={`Questions for CC (${placeholders.length})`} subtitle="Answer each one in the text before marking this document current.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {placeholders.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        {r.body !== null ? (
          <article className="prose prose-invert prose-sm max-w-none prose-headings:text-fg prose-p:text-fg-muted prose-li:text-fg-muted prose-strong:text-fg prose-a:text-accent prose-code:text-accent prose-td:text-fg-muted prose-th:text-fg">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.body}</ReactMarkdown>
          </article>
        ) : r.bodyError ? (
          <p className="text-sm text-fg-muted">{r.bodyError}</p>
        ) : r.status === "not_set_up" ? (
          <div className="space-y-2 text-sm text-fg-muted">
            <p className="font-semibold text-fg">Not set up yet</p>
            <p>This document is kept in document storage, which is not set up yet, so whether it has been written is not known here.</p>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-fg-muted">
            <p className="font-semibold text-fg">Missing - needs CC</p>
            <p>{doc.needsFromCc ?? "This document has not been written yet."}</p>
            <p>
              {viewer.founder
                ? r.canDraft
                  ? "Draft it builds a first version from verified facts only; every unknown is marked for you to answer."
                  : "It cannot be drafted until document storage is set up."
                : "A founder can draft it."}
            </p>
          </div>
        )}
      </Card>

      {incidentState !== "ok" || incidents !== null ? (
        <Card title="Register entries" subtitle="Append-only. A correction is a new entry that names the one it corrects.">
          <IncidentRegister incidents={incidents} state={incidentState} />
        </Card>
      ) : null}

      {r.versions && r.versions.length > 0 && (
        <Card title="History" subtitle="Every saved version, newest first.">
          <ul className="space-y-1 text-xs text-fg-muted">
            {r.versions.map((v) => (
              <li key={v.version}>
                Version {v.version}: {v.note.replace(/_/g, " ")} ({v.status}), {formatSourceDate(v.changed_at)} by {v.changed_by}
                {v.content_sha256 ? <span className="text-fg-dim"> · sha256 {v.content_sha256.slice(0, 12)}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
