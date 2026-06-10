/**
 * GET /api/applications/[id]/shop-out/health
 *
 * Smoke-test endpoint for the SunBiz submissions SMTP path. Opens an
 * SMTP connection to smtp.gmail.com:587, verifies auth with the per-
 * tenant gws.app_password, returns the resolved from-address.
 *
 * Why this exists: Adon spec section 8 verification item #1 says
 * "Env vars set → testConnection() returns {ok:true, email}". Without
 * a probe endpoint the operator can only learn the SMTP path is broken
 * by firing a shop-out and watching it 503 — a UX cliff. This route
 * gives the operator a no-side-effects health check they can hit any
 * time (no migrations, no rows, no Gmail messages sent).
 *
 * Auth: session cookie → SunBiz tenant OR operator (same gate as /run).
 * Idempotent: opens an SMTP connection, verifies auth, closes. Zero rows
 * written. Zero emails sent.
 *
 * The applicationId path param is required by the route shape (mirrors
 * /run + /reply) but is not actually consulted — the SMTP creds are
 * tenant-scoped, not application-scoped. The route checks the param
 * shape only so a deeplink stays consistent across endpoints.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { testConnection } from "@/lib/integrations/submissions-gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: applicationId } = await ctx.params;
  if (!UUID_RE.test(applicationId)) {
    return NextResponse.json(
      { ok: false, error: "invalid_application_id" },
      { status: 400 },
    );
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json(
      { ok: false, error: sess.reason },
      { status: 401 },
    );
  }

  // SunBiz tenant OR operator gate — mirrors /run.
  const db = getServiceSupabase();
  const tenantRow = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRow.data as { slug: string } | null)?.slug || "";
  if (tenantSlug !== "submissions" && !isOperatorEmail(sess.email)) {
    return NextResponse.json(
      { ok: false, error: "shop_out_not_enabled_for_tenant" },
      { status: 403 },
    );
  }

  const result = await testConnection(sess.tenantId);
  // Always 200 — the result body carries ok/error so the operator UI
  // can render the diagnostic without trapping a non-2xx status.
  return NextResponse.json(result);
}
