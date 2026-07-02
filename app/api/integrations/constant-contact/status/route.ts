/**
 * GET /api/integrations/constant-contact/status — is Constant Contact connected
 * for this tenant, and are the app credentials configured? Drives the Connect vs
 * Connected state on the Email Blast page.
 */
import { NextResponse } from "next/server";
import { resolveTenantId, resolveSessionContext } from "@/lib/api-auth";
import { ccIsConnected, ccCredentials } from "@/lib/integrations/constant-contact/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const session = await resolveSessionContext();
  const [connected, creds] = await Promise.all([ccIsConnected(tenantId), ccCredentials(tenantId)]);
  return NextResponse.json({
    ok: true,
    connected,
    configured: !!creds,
    can_connect: session.ok ? session.isAdmin : false,
  });
}
