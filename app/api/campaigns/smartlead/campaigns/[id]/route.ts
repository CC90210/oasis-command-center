/**
 * /api/campaigns/smartlead/campaigns/[id]
 *   GET   → campaign analytics.
 *   PATCH → set status. ACTIVE is a live-send trigger (honors the dry-run gate); PAUSED /
 *           STOPPED are always allowed (the safe direction). Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getSmartleadClient } from "@/lib/integrations/smartlead/client";
import { isDryRun } from "@/lib/integrations/send-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function admin() {
  const session = await resolveSessionContext();
  if (!session.ok) return { res: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  if (!session.isAdmin) return { res: NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 }) };
  const client = getSmartleadClient();
  if (!client) return { res: NextResponse.json({ ok: false, error: "not_configured" }, { status: 400 }) };
  return { client };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await admin();
  if (g.res) return g.res;
  try {
    const analytics = await g.client.getCampaignAnalytics(id);
    return NextResponse.json({ ok: true, analytics });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "smartlead_call_failed", message: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await admin();
  if (g.res) return g.res;

  let body: { status?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const status = String(body.status || "").toUpperCase();
  if (!["ACTIVE", "PAUSED", "STOPPED"].includes(status)) return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });

  if (status === "ACTIVE" && isDryRun("smartlead")) {
    return NextResponse.json({ ok: true, dry_run: true, would_set: "ACTIVE" });
  }
  try {
    await g.client.setCampaignStatus(id, status as "ACTIVE" | "PAUSED" | "STOPPED");
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "smartlead_call_failed", message: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
