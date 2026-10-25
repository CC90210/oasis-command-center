/**
 * /api/ai-audit — the Free AI Audit board.
 *
 *   GET  ?closed=1        every engagement of this workspace (open ones unless closed=1)
 *   POST { action: "open", lead_id }   open the lead's engagement (or return the open one)
 *
 * Founders of OASIS's own workspaces only (lib/ai-audit/access.ts). The tenant
 * comes from the session.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import { openEngagement } from "@/lib/ai-audit/store";
import { boardRows } from "@/lib/ai-audit/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const rows = await boardRows(access.session.db, access.session.tenantId, req.nextUrl.searchParams.get("closed") === "1");
  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.action !== "open") return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400, headers: NO_STORE });
  const leadId = typeof body.lead_id === "string" ? body.lead_id.trim() : "";
  if (!leadId || leadId.length > 64) return NextResponse.json({ ok: false, error: "lead_id_required" }, { status: 400, headers: NO_STORE });
  const s = access.session;
  const r = await openEngagement(s.db, { tenantId: s.tenantId, leadId, actor: { type: "user", id: s.userId }, now: new Date() });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "lead_not_found" ? 404 : 409, headers: NO_STORE });
  return NextResponse.json({ ok: true, engagement_id: r.engagement.id, created: r.created }, { headers: NO_STORE });
}
