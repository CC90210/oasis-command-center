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
 * Auth: owner-or-admin via getAccessibleLead (entity-aware, honors
 * LEAD_SCOPING_ENABLED). Read-only roles denied. Fail closed.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLead } from "@/lib/lead-access";
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

  // Owner-or-admin gate + fetch the record (404 for a non-owner agent / missing).
  const record = await getAccessibleLead(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, entity, id },
  );
  if (!record) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

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
