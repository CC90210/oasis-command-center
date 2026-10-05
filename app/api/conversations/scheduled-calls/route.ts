/**
 * GET /api/conversations/scheduled-calls — the tenant's scheduled calls for the
 * Calls tab. Returns `upcoming` (pending, soonest first) + `recent` (done/missed/
 * cancelled, newest first). Tenant-scoped via the session context. Read-only.
 *
 * POST ?id=<uuid>&status=done|missed — the rep marks a call resolved from the tab.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isReadOnlyRole } from "@/lib/role-gates";
import { canMutateGenericLeadForTenant, getWritableLead } from "@/lib/lead-access";
import { roleMayOperateOasisSalesLead } from "@/lib/oasis-sales-pipeline-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = "id, lead_id, thread_key, to_phone, contact_label, actor_user_id, scheduled_for, notes, status, reminded_at, created_at";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  }
  const db = getServiceSupabase();
  const exactOasisActor = !session.isAdmin && roleMayOperateOasisSalesLead(session.teamRole);
  let upcomingQuery = db.from("scheduled_calls").select(COLS).eq("tenant_id", session.tenantId).eq("status", "pending");
  let recentQuery = db.from("scheduled_calls").select(COLS).eq("tenant_id", session.tenantId).in("status", ["done", "missed", "cancelled"]);
  if (exactOasisActor) {
    upcomingQuery = upcomingQuery.eq("actor_user_id", session.userId).not("lead_id", "is", null);
    recentQuery = recentQuery.eq("actor_user_id", session.userId).not("lead_id", "is", null);
  }
  const [upcoming, recent] = await Promise.all([
    upcomingQuery.order("scheduled_for", { ascending: true }).limit(100),
    recentQuery.order("scheduled_for", { ascending: false }).limit(50),
  ]);
  let upcomingRows = (upcoming.data ?? []) as Array<Record<string, unknown>>;
  let recentRows = (recent.data ?? []) as Array<Record<string, unknown>>;
  if (exactOasisActor) {
    const leadIds = [
      ...new Set(
        [...upcomingRows, ...recentRows]
          .map((row) => (typeof row.lead_id === "string" ? row.lead_id : null))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const records = leadIds.length
      ? await db
          .from("tenant_records")
          .select("id, data")
          .eq("tenant_id", session.tenantId)
          .eq("entity_type", "lead")
          .in("id", leadIds)
      : { data: [] };
    const allowedIds = new Set(
      ((records.data || []) as Array<{ id: string; data: Record<string, unknown> | null }>)
        .filter((record) =>
          canMutateGenericLeadForTenant(
            {
              teamRole: session.teamRole,
              userId: session.userId,
              isOwner: session.isTrueAdmin,
              adminAccess: session.adminAccess,
            },
            { id: record.id, data: record.data || {} },
          ),
        )
        .map((record) => record.id),
    );
    upcomingRows = upcomingRows.filter((row) => allowedIds.has(String(row.lead_id || "")));
    recentRows = recentRows.filter((row) => allowedIds.has(String(row.lead_id || "")));
  }
  return NextResponse.json({
    ok: true,
    upcoming: upcomingRows,
    recent: recentRows,
  });
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  }
  // Resolving a call (done|missed) is a write; read-only members can't. Gate on
  // the fail-closed session.teamRole (null -> "read_only").
  if (isReadOnlyRole(session.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't update calls." },
      { status: 403 },
    );
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const status = url.searchParams.get("status") || "";
  if (!UUID_RE.test(id) || !["done", "missed"].includes(status)) {
    return NextResponse.json({ ok: false, error: "invalid_params" }, { status: 400 });
  }
  const db = getServiceSupabase();
  if (!session.isAdmin && roleMayOperateOasisSalesLead(session.teamRole)) {
    const existing = await db
      .from("scheduled_calls")
      .select("id, lead_id, actor_user_id")
      .eq("id", id)
      .eq("tenant_id", session.tenantId)
      .maybeSingle();
    const row = existing.data as
      | { id: string; lead_id: string | null; actor_user_id: string | null }
      | null;
    if (!row || row.actor_user_id !== session.userId || !row.lead_id) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const writable = await getWritableLead(
      {
        teamRole: session.teamRole,
        userId: session.userId,
        isOwner: session.isTrueAdmin,
        adminAccess: session.adminAccess,
      },
      { tenantId: session.tenantId, id: row.lead_id },
    );
    if (!writable.ok) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
  }
  const upd = await db
    .from("scheduled_calls")
    .update({ status })
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .select("id");
  if (upd.error) return NextResponse.json({ ok: false, error: "update_failed" }, { status: 500 });
  if (!upd.data || upd.data.length === 0) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
