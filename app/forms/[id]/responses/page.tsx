/**
 * /forms/[id]/responses - every answer people sent in on one form (MKT-05,
 * 2026-10-02). Forms kept them all and showed none.
 *
 * GATE. The first statement resolves the viewer the way requireOsRoute does
 * and asks mayReadFormResponses (lib/forms/access.ts), the gate the CSV
 * download asks too: answers are lead data, so the viewer needs the rail's
 * Forms row AND the capability that governs every lead in the workspace.
 * Anyone else gets a 404. The form is read by id AND the session's
 * workspace, so another workspace's form id is a 404 as well.
 *
 * WHAT IT SHOWS. Newest first, 25 to a page: when, which step, the lead it is
 * linked to, and the answers, with a CSV download of the lot. What is never
 * printed (a drawn signature, a full SSN) is decided in lib/forms/responses.ts,
 * which the download reads too. A failed read says so in one sentence and logs
 * the detail; it never prints the driver's message.
 */

import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Download } from "lucide-react";
import { Card } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { resolveOsPageViewer } from "@/components/os/landings/page-gate";
import { getServiceSupabase } from "@/lib/supabase-server";
import { mayReadFormResponses } from "@/lib/forms/access";
import {
  loadLeadNames,
  loadResponsesForm,
  loadResponsesPage,
  RESPONSES_EXPORT_LIMIT,
  type FormResponse,
  type ResponsesForm,
} from "@/lib/forms/responses";
import { mayOpenOsHref } from "@/lib/os/nav";
import { formatOperatorDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

function pageParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function when(stored: string): string {
  const ms = Date.parse(stored);
  if (!Number.isFinite(ms)) return stored;
  return formatOperatorDate(
    { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
    new Date(ms),
  );
}

function BackToForms() {
  return (
    <Link href="/forms" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
      <ChevronLeft className="h-3.5 w-3.5" />
      Back to forms
    </Link>
  );
}

function Unavailable({ title }: { title: string }) {
  return (
    <PageFrame title={title} actions={<BackToForms />}>
      <p role="alert" className="rounded-xl border border-status-warm/40 bg-status-warm/5 p-4 text-sm text-status-warm">
        Responses couldn&apos;t load. The error has been logged. Try again in a minute.
      </p>
    </PageFrame>
  );
}

function LeadName({ leadId, names, leadPages }: { leadId: FormResponse["leadId"]; names: Map<string, string> | null; leadPages: boolean }) {
  if (names === null) return <span className="text-fg-muted">Lead: couldn&apos;t check</span>;
  const name = names.get(leadId);
  if (!name) return <span className="text-fg-muted">Lead no longer on file</span>;
  if (!leadPages) return <span>{name}</span>;
  return (
    <Link href={`/pipeline/${encodeURIComponent(leadId)}`} className="text-accent hover:text-accent-bright">
      {name}
    </Link>
  );
}

function Pager({ formId, page, pageCount }: { formId: string; page: number; pageCount: number }) {
  const href = (n: number) => `/forms/${encodeURIComponent(formId)}/responses?page=${n}`;
  return (
    <nav aria-label="Response pages" className="flex items-center justify-between gap-3 text-[13px] text-fg-muted">
      {page > 1 ? <Link href={href(page - 1)} className="text-accent hover:text-accent-bright">Newer</Link> : <span />}
      <span>{`Page ${page} of ${pageCount}`}</span>
      {page < pageCount ? <Link href={href(page + 1)} className="text-accent hover:text-accent-bright">Older</Link> : <span />}
    </nav>
  );
}

export default async function FormResponsesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const viewer = await resolveOsPageViewer();
  if (!viewer || !mayReadFormResponses(viewer)) notFound();
  const tenantId = viewer.surface.tenantId;
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const db = getServiceSupabase();

  let form: ResponsesForm | null;
  try {
    form = await loadResponsesForm(db, tenantId, id);
  } catch (err) {
    console.error("[forms.responses.form]", { tenantId, formId: id }, err);
    return <Unavailable title="Responses" />;
  }
  if (!form) notFound();

  let result: Awaited<ReturnType<typeof loadResponsesPage>>;
  try {
    result = await loadResponsesPage(db, { tenantId, form, page: pageParam(query.page) });
  } catch (err) {
    console.error("[forms.responses.page]", { tenantId, formId: id }, err);
    return <Unavailable title={form.name} />;
  }
  const { rows, total, page, pageCount } = result;

  let leadNames: Map<string, string> | null = null;
  try {
    leadNames = await loadLeadNames(db, tenantId, rows.map((r) => r.leadId));
  } catch (err) {
    console.error("[forms.responses.leads]", { tenantId, formId: id }, err);
  }
  // A lead opens on the Pipeline's lead page, which only OASIS's own
  // workspaces have today; elsewhere the lead is named, not linked.
  const leadPages = viewer.oasis && mayOpenOsHref(viewer.navInput, "/pipeline");

  const counted = total === null ? "" : `${total.toLocaleString("en-US")} response${total === 1 ? "" : "s"}, newest first. `;
  return (
    <PageFrame
      title={form.name}
      subtitle={`${counted}Each row is one step someone submitted.`}
      className="space-y-4"
      actions={
        <>
          {total !== 0 && (
            <a
              href={`/api/forms/${encodeURIComponent(form.id)}/responses`}
              download
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              Download CSV
            </a>
          )}
          <BackToForms />
        </>
      }
    >
      {total !== null && total > RESPONSES_EXPORT_LIMIT && (
        <p className="text-xs text-fg-dim">The download holds the newest {RESPONSES_EXPORT_LIMIT.toLocaleString("en-US")} responses.</p>
      )}
      {rows.length === 0 ? (
        <Card>
          <p className="text-[13px] text-fg-muted">
            {page > 1 ? "No responses on this page." : "No one has submitted this form yet."}
          </p>
        </Card>
      ) : (
        <Card noPadding>
          <ul className="divide-y divide-hairline">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="text-sm font-medium text-fg">
                    <LeadName leadId={r.leadId} names={leadNames} leadPages={leadPages} />
                  </div>
                  <div className="text-xs text-fg-dim">
                    {when(r.submittedAt)} &middot; {r.stepLabel}
                  </div>
                </div>
                {r.answers.length === 0 ? (
                  <p className="mt-1 text-[13px] text-fg-muted">No answers on this step.</p>
                ) : (
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                    {r.answers.map((a) => (
                      <Fragment key={a.key}>
                        <dt className="text-fg-dim">{a.label}</dt>
                        <dd className="break-words text-fg">{a.value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {pageCount > 1 && <Pager formId={form.id} page={page} pageCount={pageCount} />}
    </PageFrame>
  );
}
