/**
 * POST /api/inbox/mark-read - mark one note read from the dashboard (read_via "dashboard").
 * Operator-only. An undelivered directive marked read here is also taken out of the relay
 * (app/api/bridge/inbox lists only unread notes), so it never reaches a computer.
 *
 * DATABASE ONLY (2026-10-28): the old filesystem branch (lib/agent-inbox-fs) needed a disk the
 * Cloudflare Worker does not have.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { markReadDb } from "@/lib/agent-inbox-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  // Verified operator (alias AND owner/admin OASIS membership by auth id) —
  // the same rule the Agent ops page gates on. Fails closed.
  if (!(await isPlatformOperatorForAuthUser(user.id, user.email))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let payload: { id?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const id = String(payload.id || "");
  if (!ID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });

  const profileRes = await getServiceSupabase()
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profileRes.data as { tenant_id: string | null } | null)?.tenant_id;
  if (profileRes.error || !tenantId) return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 409 });

  const result = await markReadDb(tenantId, id, "dashboard");
  if (!result.ok) {
    console.error("[inbox.mark-read]", { tenantId, error: result.error });
    return NextResponse.json({ ok: false, error: "mark_failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
