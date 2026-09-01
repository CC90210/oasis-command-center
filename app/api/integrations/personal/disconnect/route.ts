/**
 * POST /api/integrations/personal/disconnect — clear a personal
 * integration for the signed-in user (Settings → Personal → Disconnect).
 *
 * Body: { service: string } — e.g. "gmail_oauth"
 *
 * Deletes every field row for (tenant, user, service). The send
 * pipeline then falls back to the tenant-shared default (operator's
 * submissions@) on subsequent sends, so the user's seat keeps
 * working — just without the personal-identity benefit.
 *
 * Phase 4 of the SunBiz multi-employee personalization plan (2026-05-29).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";
import { clearUserIntegration } from "@/lib/user-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { service?: string };
  try {
    body = (await req.json()) as { service?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const service = (body.service || "").trim();
  if (!service) {
    return NextResponse.json({ ok: false, error: "missing_service" }, { status: 400 });
  }

  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }

  const result = await clearUserIntegration(tenantId, user.id, service);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "clear_failed", message: result.error },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
