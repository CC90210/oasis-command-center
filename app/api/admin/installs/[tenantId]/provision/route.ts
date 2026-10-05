/**
 * POST /api/admin/installs/[tenantId]/provision - set up an EXISTING client
 * workspace (or set it up again with new choices).
 *
 * Body: { departments[], modules[], chat_apps[], jev }
 *
 * Operators only; everyone else gets a 404. The workspace comes from the URL
 * and is checked inside provisionTenant (it must exist, and must not be one of
 * OASIS's own or a retired workspace). Every step is recorded in
 * provisioning_runs and returned.
 */

import { NextResponse, type NextRequest } from "next/server";
import { operatorFromSession } from "@/lib/provisioning/operator-session";
import { provisionTenant } from "@/lib/provisioning/provision-tenant";
import { parseProvisionBody } from "@/lib/provisioning/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const operator = await operatorFromSession();
  if (!operator) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const { tenantId } = await params;
  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json({ ok: false, error: "invalid_workspace" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const result = await provisionTenant({ operator, target: { tenantId }, ...parseProvisionBody(body) });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, message: result.message, run_id: result.runId ?? null, steps: result.steps ?? [] },
      { status: result.status },
    );
  }
  return NextResponse.json(result);
}
