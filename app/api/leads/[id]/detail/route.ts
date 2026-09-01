/**
 * GET /api/leads/[id]/detail
 *
 * Aggregated read for the SunBiz LeadDetailDrawer. Returns lead row +
 * documents + linked application (for the Lenders / Bank tabs) in one
 * round trip so the drawer can render all five tabs without firing
 * five separate fetches as the operator clicks between them.
 *
 * Auth: session → tenant via resolveTenantId. tenant_id constrains
 * every query so a session for tenant A cannot read tenant B's lead.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { listRecords } from "@/lib/manifest/data";
import { resolveSessionContext } from "@/lib/api-auth";
import { buildMemberNameMap, withAssignedName } from "@/lib/assigned-names";
import {
  getReadableLeadRecordForSession,
  getReadableLeadTargetForSession,
  resolveLeadReadPolicy,
} from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;

  // `entity` query param lets the same endpoint serve the application
  // drawer (?entity=application) without a parallel route. Default is
  // "lead" so existing callers don't break.
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") === "application" ? "application" : "lead";

  // Exact tenant-aware read boundary. OASIS never inherits the environment's
  // broad filter-mode semantics: reps get own/collaborating records and a
  // manager additionally gets canonical-roster coaching reads.
  const readPolicy = await resolveLeadReadPolicy(sess);
  const primary = await getReadableLeadRecordForSession(sess, {
    tenantId,
    id,
    entityParam: entity,
  }, readPolicy);
  if (!primary) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const record = primary.record;

  // Documents — `lead_documents` row store is keyed by lead_id even when
  // the drawer is opened against an application; the application's
  // data.lead_id resolves the link.
  const docLeadId =
    entity === "lead"
      ? id
      : typeof (record.data as Record<string, unknown>).lead_id === "string" &&
          UUID_RE.test((record.data as Record<string, unknown>).lead_id as string)
        ? ((record.data as Record<string, unknown>).lead_id as string)
        : id;

  // Documents and the linked application have no data dependency on each
  // other — fire them in parallel so the drawer-open trip is one DB
  // round-trip wide, not two. When the drawer is opened on an application
  // the record itself IS the application, so we skip the listRecords call.
  const db = getServiceSupabase();
  const docsPromise = docLeadId
    ? db
        .from("lead_documents")
        .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at, metadata")
        .eq("tenant_id", tenantId)
        .eq("lead_id", docLeadId)
        .is("metadata->>deleted_at", null) // Batch 5: exclude soft-deleted
        .order("uploaded_at", { ascending: false })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const appPromise =
    entity === "lead"
      ? listRecords({
          tenant_id: tenantId,
          entity: "application",
          where: { lead_id: id },
          limit: 1,
        }).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [{ id: record.id, data: record.data }] });

  // Resolve assigned_to (auth_user_id) → assigned_to_name so the drawer's
  // "Assigned to" field shows the operator's name instead of the raw UUID.
  // One member-map fetch covers both the record and its linked application.
  // buildMemberNameMap only needs tenantId (no dependency on docs/app), so it
  // rides the SAME Promise.all — the drawer-open path is one DB wave, not two
  // (perf, 2026-06-25).
  const [docsRes, apps, nameMap] = await Promise.all([
    docsPromise,
    appPromise,
    buildMemberNameMap(tenantId),
  ]);
  const recordData = withAssignedName(
    record.data as Record<string, unknown>,
    nameMap,
  );

  // Per-agent lock on the LINKED application (lead branch): the lead's owner can
  // differ from the application's owner if assignments diverged — don't leak the
  // other rep's application data. Admins pass; the application-entity branch
  // already authorized the record itself above. (Codex audit 2026-06-22.)
  let linkedApplication: { id: string; data: Record<string, unknown> } | null = null;
  const linkedAppRow = apps.rows[0];
  const linkedAppTarget = linkedAppRow
      ? await getReadableLeadTargetForSession(sess, {
        tenantId,
        id: linkedAppRow.id,
        entityParam: "application",
      }, readPolicy)
    : null;
  if (linkedAppRow && linkedAppTarget) {
    linkedApplication = {
      id: linkedAppRow.id,
      data: withAssignedName(linkedAppRow.data as Record<string, unknown>, nameMap),
    };
  }

  return NextResponse.json({
    ok: true,
    record: {
      id: record.id,
      entity,
      data: recordData,
      created_at: record.created_at,
      updated_at: record.updated_at,
    },
    documents: mapDocVariants(docsRes.data),
    application: linkedApplication,
  });
}

/**
 * Attach the duplicate-file variant state to each doc (2026-06-29) without
 * leaking raw metadata: `active_variant` (which copy the operator sees) +
 * `legacy_baked` (watermarked in place before the clean-storage fix → no clean
 * original). Bank statements are the only watermarked type.
 */
function mapDocVariants(rows: unknown): Array<Record<string, unknown>> {
  const arr = (Array.isArray(rows) ? rows : []) as Array<{
    id: string; filename: string; mime_type: string | null; size_bytes: number | null;
    doc_type: string; uploaded_at: string; metadata?: Record<string, unknown> | null;
  }>;
  return arr.map((d) => {
    const meta = d.metadata || {};
    const legacy = !!meta.watermarked_at;
    return {
      id: d.id,
      filename: d.filename,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      doc_type: d.doc_type,
      uploaded_at: d.uploaded_at,
      active_variant: legacy ? "watermarked" : meta.active_variant === "watermarked" ? "watermarked" : "clean",
      legacy_baked: legacy,
    };
  });
}
