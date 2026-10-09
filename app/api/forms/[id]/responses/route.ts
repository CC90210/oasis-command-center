/**
 * GET /api/forms/[id]/responses - every answer on one form, as a CSV file
 * (the Responses page's "Download CSV", MKT-05 2026-10-02).
 *
 * The same gate as the page (app/forms/[id]/responses): the session must
 * resolve to a member whose rail draws Forms AND who may see every lead in the
 * workspace (mayReadFormResponses, lib/forms/access.ts). The workspace is the
 * session's; the form is read by id AND that workspace, so another workspace's
 * form id answers 404. Rows, lead names and what is never printed come from
 * lib/forms/responses.ts, which the page reads too.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveOsPageViewer } from "@/components/os/landings/page-gate";
import { getServiceSupabase } from "@/lib/supabase-server";
import { mayReadFormResponses } from "@/lib/forms/access";
import { loadLeadNames, loadResponsesForExport, loadResponsesForm, responsesCsv } from "@/lib/forms/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const viewer = await resolveOsPageViewer();
  if (!viewer) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!mayReadFormResponses(viewer)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const tenantId = viewer.surface.tenantId;
  const { id } = await ctx.params;
  const db = getServiceSupabase();
  try {
    const form = await loadResponsesForm(db, tenantId, id);
    if (!form) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const { rows } = await loadResponsesForExport(db, { tenantId, form });
    let leadNames: Map<string, string> | null = null;
    try {
      leadNames = await loadLeadNames(db, tenantId, rows.map((r) => r.leadId));
    } catch (err) {
      // The answers still download; the Lead column is left blank.
      console.error("[forms.responses.export.leads]", { tenantId, formId: id }, err);
    }
    const file = `${form.slug.replace(/[^a-z0-9_-]/gi, "") || "form"}-responses.csv`;
    return new NextResponse(responsesCsv(form, rows, leadNames), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("[forms.responses.export]", { tenantId, formId: id }, err);
    return NextResponse.json({ ok: false, error: "responses_unavailable" }, { status: 500 });
  }
}
