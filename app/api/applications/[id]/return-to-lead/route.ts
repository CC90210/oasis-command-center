/**
 * POST /api/applications/[id]/return-to-lead — move a deal BACK from the
 * Applications board to the Leads board (the reverse of /api/leads/[id]/promote).
 *
 * Clears the lead's data.transferred_at (it returns to the Leads board) and the
 * application's data.promoted_at (it leaves the Applications board — the board
 * filters on promoted_at). Both records are kept (the application stays as the
 * underwriting/document backing); only the board placement flips. One deal, one
 * board, fully reversible — no duplicate.
 *
 * Auth: session-gated, member+ (read-only denied); the application must belong
 * to the caller's tenant. Mirrors /api/leads/[id]/create-application.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { isReadOnlyRole } from "@/lib/role-gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: appId } = await ctx.params;
  if (!UUID_RE.test(appId)) {
    return NextResponse.json({ ok: false, error: "invalid_application_id" }, { status: 400 });
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id,team_role")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  const teamRole = (profile.data as { team_role?: string | null } | null)?.team_role;
  if (isReadOnlyRole(teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't move deals." },
      { status: 403 },
    );
  }

  // Ownership + load the application (getRecord is tenant-scoped).
  const app = await getRecord({ tenant_id: tenantId, entity: "application", id: appId });
  if (!app) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }
  const leadIdRaw = (app.data as Record<string, unknown>).lead_id;
  const leadId = typeof leadIdRaw === "string" && UUID_RE.test(leadIdRaw) ? leadIdRaw : null;
  if (!leadId) {
    return NextResponse.json(
      { ok: false, error: "no_origin_lead", message: "This application has no originating lead to return to." },
      { status: 400 },
    );
  }

  // 1. Restore the lead to the Leads board (clear transferred_at). Load-bearing,
  //    and done FIRST so a failure leaves the deal on Applications rather than
  //    vanishing from both boards. Worst case is a transient both-boards state.
  try {
    await updateRecord({ tenant_id: tenantId, entity: "lead", id: leadId, patch: { transferred_at: null } });
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    return NextResponse.json(
      { ok: false, error: "return_incomplete", code, message: "Couldn't restore the lead. Retry." },
      { status: 500 },
    );
  }
  // 2. Remove the application from the Applications board (clear promoted_at).
  try {
    await updateRecord({ tenant_id: tenantId, entity: "application", id: appId, patch: { promoted_at: null } });
  } catch {
    /* best-effort — the lead is already back; a lingering promoted app self-heals on the next transfer */
  }

  return NextResponse.json({ ok: true, lead_id: leadId });
}
