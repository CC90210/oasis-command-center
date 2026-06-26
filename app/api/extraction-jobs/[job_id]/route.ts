/**
 * GET /api/extraction-jobs/[job_id] — poll an async document-extraction job.
 *
 * The AutofillDropzone polls this after queueing a drop. Returns the job status
 * (queued|processing|extracted|applied|failed) and, when applied, the result the
 * UI needs: applied_keys, application_id, and the signature_preview to confirm.
 *
 * Auth: session-gated. The job must belong to the caller's tenant AND either the
 * caller queued it (uploaded_by = their email), they're an admin, or it's on a
 * lead they can access — so one rep can't poll another rep's extraction.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getAccessibleLead } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) {
  const { job_id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ ok: false, error: "invalid_job_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const db = getServiceSupabase();
  const res = await db
    .from("document_extraction_jobs")
    .select("id, tenant_id, lead_id, status, uploaded_by, used_fallback, result_json, error, created_at")
    .eq("id", jobId)
    .maybeSingle();
  const job = res.data as
    | {
        id: string;
        tenant_id: string;
        lead_id: string | null;
        status: string;
        uploaded_by: string | null;
        used_fallback: boolean;
        result_json: Record<string, unknown> | null;
        error: string | null;
        created_at: string;
      }
    | null;
  if (!job || job.tenant_id !== sess.tenantId) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Scope: the queuer, an admin, or someone who can access the (existing) lead.
  const isQueuer = !!sess.email && job.uploaded_by === sess.email;
  let allowed = sess.isAdmin || isQueuer;
  if (!allowed && job.lead_id) {
    const lead = await getAccessibleLead(
      { isAdmin: sess.isAdmin, userId: sess.userId },
      { tenantId: sess.tenantId, entity: "lead", id: job.lead_id },
    );
    allowed = !!lead;
  }
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const result = job.result_json || {};
  return NextResponse.json({
    ok: true,
    job_id: job.id,
    status: job.status,
    lead_id: job.lead_id,
    used_fallback: job.used_fallback,
    error: job.error,
    // Surfaced only when applied — the dropzone reads these to show the result +
    // the signature-confirm prompt.
    applied_keys: Array.isArray(result.applied_keys) ? result.applied_keys : [],
    application_id: typeof result.application_id === "string" ? result.application_id : null,
    signature_preview: typeof result.signature_preview === "string" ? result.signature_preview : null,
  });
}
