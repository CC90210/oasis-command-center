/**
 * POST /api/agent-alerts/[id]/resolve
 *
 * Mark one agent_alert as resolved so it stops appearing in the
 * dashboard's "System health" section. Called by the Dismiss button in
 * components/manifest/ManifestDashboard.tsx (form submit, so it works
 * without JS). Idempotent — already-resolved rows return ok:true.
 *
 * Auth: session-cookie + tenant_id match on the alert row (defense in
 * depth — caller can't dismiss another tenant's alerts via a guessed id).
 *
 * Response shape:
 *   On a form-submit (Content-Type: application/x-www-form-urlencoded),
 *   we 303 back to the same page so the dashboard re-renders with the
 *   row gone. On a fetch() call, we return JSON.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getServiceSupabase();
  // Tenant-scoped update — operator can only resolve alerts on their
  // own tenant. The .eq("tenant_id") filter is the security boundary;
  // the .eq("id") filter is the row selector.
  const res = await db
    .from("agent_alerts")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .is("resolved_at", null)
    .select("id");

  if (res.error) {
    return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  }

  // Form-submit path: 303 redirect back so the dashboard re-renders
  // without the dismissed row. Same-origin gate on Referer prevents
  // an attacker-set Referer header from being used as an open redirect
  // — a referer pointing off-origin falls back to "/".
  const accept = req.headers.get("accept") || "";
  const isFormSubmit = !accept.includes("application/json");
  if (isFormSubmit) {
    const rawReferer = req.headers.get("referer") || "";
    let safeRedirect = "/";
    if (rawReferer) {
      try {
        const refUrl = new URL(rawReferer);
        const reqUrl = new URL(req.url);
        if (refUrl.origin === reqUrl.origin) {
          safeRedirect = refUrl.pathname + refUrl.search;
        }
      } catch {
        // malformed referer — fall through to "/"
      }
    }
    return NextResponse.redirect(new URL(safeRedirect, req.url), { status: 303 });
  }

  return NextResponse.json({
    ok: true,
    resolved: (res.data || []).length,
    already_resolved: (res.data || []).length === 0,
  });
}
