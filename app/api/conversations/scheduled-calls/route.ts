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
  const [upcoming, recent] = await Promise.all([
    db.from("scheduled_calls").select(COLS).eq("tenant_id", session.tenantId).eq("status", "pending").order("scheduled_for", { ascending: true }).limit(100),
    db.from("scheduled_calls").select(COLS).eq("tenant_id", session.tenantId).in("status", ["done", "missed", "cancelled"]).order("scheduled_for", { ascending: false }).limit(50),
  ]);
  return NextResponse.json({
    ok: true,
    upcoming: upcoming.data ?? [],
    recent: recent.data ?? [],
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
