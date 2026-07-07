/**
 * POST /api/leads/[id]/generate-application-pdf — on-demand application PDF.
 *
 * Backfill for apps created/imported BEFORE auto-PDF generation existed: builds
 * the application-form PDF from the data already stored in Supabase (the SAME
 * renderer used at form completion) and files it as `final_application_form`.
 *
 * Body: { entity?: "lead" | "application", replace?: boolean }
 *   - entity "application" (default): the path id IS the application.
 *   - entity "lead": resolves the lead's linked application (data.lead_id == id).
 *   - replace defaults to TRUE — always produce a fresh PDF from current data;
 *     the generator soft-deletes any prior generated copy first (idempotent).
 *
 * Auth: role-based CRM-write via getWritableLead (2026-07-07 — converted from
 * getAccessibleLead/canViewLead so any non-read_only member can act on any
 * tenant lead, not just their own book when LEAD_SCOPING_ENABLED is on).
 * Read-only roles denied. Fail closed.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { isReadOnlyRole } from "@/lib/role-gates";
import { listRecords } from "@/lib/manifest/data";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (isReadOnlyRole(sess.teamRole)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { entity?: unknown; replace?: unknown } = {};
  try {
    body = (await req.json()) as { entity?: unknown; replace?: unknown };
  } catch {
    /* empty body OK — defaults apply */
  }
  const entity = body.entity === "lead" ? "lead" : "application";
  const replace = body.replace === false ? false : true;

  // Role-based CRM-write gate: any non-read_only member may act on any tenant lead.
  // 2026-07-07: converted from getAccessibleLead (canViewLead/VISIBILITY) to
  // getWritableLead (canWriteCrm/ROLE) so LEAD_SCOPING_ENABLED no longer blocks members.
  const acc = await getWritableLead(
    { teamRole: sess.teamRole },
    { tenantId: sess.tenantId, entity, id },
  );
  if (!acc.ok) {
    return acc.reason === "role_denied"
      ? NextResponse.json({ ok: false, error: "forbidden_role", message: "Read-only members can't do this." }, { status: 403 })
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  // acc.record is available (lead.id / lead.data) if downstream logic needs it.
  // Resolve the application to generate from.
  let applicationId: string;
  if (entity === "application") {
    applicationId = id;
  } else {
    const apps = await listRecords({
      tenant_id: sess.tenantId,
      entity: "application",
      where: { lead_id: id },
      limit: 1,
    }).catch(() => ({ rows: [] as Array<{ id: string }> }));
    const appId = apps.rows[0]?.id;
    if (!appId) {
      return NextResponse.json({ ok: false, error: "no_application" }, { status: 400 });
    }
    applicationId = appId;
  }

  const result = await generateApplicationDocumentFromRecord({
    tenantId: sess.tenantId,
    applicationId,
    replace,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error || "generate_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, documentId: result.documentId, applicationId });
}
